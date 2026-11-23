import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SelectedCheck } from '@archon/forge/operations';
import { FakeForgejo, NAME, OWNER } from './fake-forgejo';
import { FakeWoodpecker } from './fake-woodpecker';
import { call, losingAnswer } from './helpers';

const HEAD = 'c'.repeat(40);
const REPO_ID = 13;

let fake: FakeForgejo;
let woodpecker: FakeWoodpecker;
let config: string;
beforeEach(() => {
  fake = new FakeForgejo().start();
  woodpecker = new FakeWoodpecker().start();
  config = woodpecker.configFile();
  fake.addPull({ head: 'feature', headSha: HEAD });
  woodpecker.addRepo(REPO_ID, `${OWNER}/${NAME}`);
  woodpecker.addPipeline(REPO_ID, { number: 7, commit: HEAD, status: 'failure' });
  // As Woodpecker does, a restarted pipeline reports its workflows under the same contexts.
  woodpecker.onRestart = (repo, pipeline) => {
    for (const context of ['ci/woodpecker/pr/build', 'ci/woodpecker/pr/test'])
      fake.addStatus(HEAD, context, 'pending', woodpecker.statusUrl(repo, pipeline.number));
  };
});
afterEach(() => {
  fake.stop();
  woodpecker.stop();
});

/** A workflow's status on the head, as `checks.state` reports it for selection. */
function failedCheck(context: string, pipeline = 7, workflow = 1): SelectedCheck {
  const status = fake.addStatus(
    HEAD,
    context,
    'failure',
    woodpecker.statusUrl(REPO_ID, pipeline, workflow)
  );
  return {
    unit: { kind: 'commit_status', id: String(status.id), name: context },
    rerun: { id: context, attempt: pipeline },
  };
}

const rerun = (units: SelectedCheck[], revision = HEAD) => ({
  op: 'checks.rerun' as const,
  ref: { repo: fake.repo, number: 1 },
  revision,
  units,
});

describe('checks.state', () => {
  test('marks a status that links to a Woodpecker pipeline as re-runnable', async () => {
    failedCheck('ci/woodpecker/pr/test');
    fake.addStatus(HEAD, 'other/ci', 'success', 'https://ci.example.com/builds/1');
    const response = await call(fake, { op: 'checks.state', ref: { repo: fake.repo, number: 1 } });
    if (!response.ok || response.result.op !== 'checks.state') throw new Error('expected checks');
    expect(response.result.value.units.map(unit => [unit.unit.name, unit.rerun])).toEqual([
      ['ci/woodpecker/pr/test', { id: 'ci/woodpecker/pr/test', attempt: 7 }],
      ['other/ci', null],
    ]);
  });
});

describe('checks.rerun', () => {
  test('restarts the pipeline once for all its failed workflows, at a newer attempt', async () => {
    const units = [
      failedCheck('ci/woodpecker/pr/build'),
      failedCheck('ci/woodpecker/pr/test', 7, 2),
    ];
    const response = await call(fake, rerun(units), undefined, config);
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          outcome: 'applied',
          changed: true,
          revision: HEAD,
          units: units.map(({ unit }) => ({ unit, rerun: { id: unit.name, attempt: 8 } })),
        },
      },
    });
    expect(woodpecker.restarts).toEqual([
      { method: 'POST', path: `/api/repos/${String(REPO_ID)}/pipelines/7` },
    ]);
  });

  test('restarts each pipeline behind the selection, such as a push and a pull request pipeline', async () => {
    woodpecker.addPipeline(REPO_ID, { number: 8, commit: HEAD, status: 'error' });
    const units = [
      failedCheck('ci/woodpecker/push/test', 7),
      failedCheck('ci/woodpecker/pr/test', 8),
    ];
    const response = await call(fake, rerun(units), undefined, config);
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          units: [
            { rerun: { id: 'ci/woodpecker/push/test', attempt: 9 } },
            { rerun: { id: 'ci/woodpecker/pr/test', attempt: 10 } },
          ],
        },
      },
    });
    expect(woodpecker.restarts).toHaveLength(2);
  });

  test('refuses, restarting nothing, when the selection is no longer current', async () => {
    const stale = failedCheck('ci/woodpecker/pr/test');
    const cases: [string, () => ReturnType<typeof rerun>][] = [
      [
        'it was selected at an older pipeline',
        () => rerun([{ ...stale, rerun: { id: stale.unit.name, attempt: 6 } }]),
      ],
      // The last two change the fake for good.
      [
        'a newer status replaced it',
        () => {
          fake.addStatus(
            HEAD,
            'ci/woodpecker/pr/test',
            'failure',
            woodpecker.statusUrl(REPO_ID, 7)
          );
          return rerun([stale]);
        },
      ],
      [
        'a push moved the head away from the failed revision',
        () => {
          const pull = fake.issues[0].pull;
          if (pull) pull.headSha = 'd'.repeat(40);
          const current = failedCheck('ci/woodpecker/pr/test');
          return rerun([current]);
        },
      ],
    ];
    for (const [name, request] of cases) {
      const response = await call(fake, request(), undefined, config);
      expect({ name, response }).toMatchObject({
        name,
        response: { ok: false, error: { kind: 'conflict' }, mutation: { outcome: 'refused' } },
      });
    }
    expect(woodpecker.restarts).toEqual([]);
  });

  test('refuses a check that has passed or whose pipeline is still running', async () => {
    const passed = fake.addStatus(
      HEAD,
      'ci/woodpecker/pr/lint',
      'success',
      woodpecker.statusUrl(REPO_ID, 7)
    );
    const passedUnit: SelectedCheck = {
      unit: { kind: 'commit_status', id: String(passed.id), name: passed.context },
      rerun: { id: passed.context, attempt: 7 },
    };
    expect(await call(fake, rerun([passedUnit]), undefined, config)).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
    });

    woodpecker.addPipeline(REPO_ID, { number: 9, commit: HEAD, status: 'running' });
    expect(
      await call(fake, rerun([failedCheck('ci/woodpecker/pr/test', 9)]), undefined, config)
    ).toMatchObject({ ok: false, error: { kind: 'conflict' }, mutation: { outcome: 'refused' } });
    expect(woodpecker.restarts).toEqual([]);
  });

  test('refuses a pipeline that Woodpecker files under another repository', async () => {
    woodpecker.addRepo(REPO_ID, 'someone/else');
    const response = await call(
      fake,
      rerun([failedCheck('ci/woodpecker/pr/test')]),
      undefined,
      config
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(woodpecker.restarts).toEqual([]);
  });

  test('never sends the Woodpecker token to a server other than the configured one', async () => {
    const status = fake.addStatus(
      HEAD,
      'ci/woodpecker/pr/test',
      'failure',
      'https://ci.example.com/repos/13/pipeline/7/1'
    );
    const response = await call(
      fake,
      rerun([
        {
          unit: { kind: 'commit_status', id: String(status.id), name: status.context },
          rerun: { id: status.context, attempt: 7 },
        },
      ]),
      undefined,
      config
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'unsupported_op' } });
    expect(woodpecker.requests).toEqual([]);
  });

  test('refuses a check that does not link to a Woodpecker pipeline', async () => {
    const status = fake.addStatus(HEAD, 'other/ci', 'failure');
    const response = await call(
      fake,
      rerun([
        { unit: { kind: 'commit_status', id: String(status.id), name: 'other/ci' }, rerun: null },
      ]),
      undefined,
      config
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'unsupported_op' } });
  });

  test('without a Woodpecker config, refuses for want of a credential', async () => {
    const response = await call(
      fake,
      rerun([failedCheck('ci/woodpecker/pr/test')]),
      undefined,
      `${config}.missing`
    );
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'no_credential' },
      mutation: { outcome: 'refused', rerun: { revision: HEAD, observed: [] } },
    });
  });

  test('a restart whose answer is lost has an unknown outcome', async () => {
    const response = await call(
      fake,
      rerun([failedCheck('ci/woodpecker/pr/test')]),
      losingAnswer((_url, method) => method === 'POST'),
      config
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
    expect(woodpecker.restarts).toHaveLength(1);
  });

  test('a refusal after one pipeline restarted reports the restarted checks', async () => {
    woodpecker.addPipeline(REPO_ID, { number: 8, commit: HEAD, status: 'failure' });
    const units = [
      failedCheck('ci/woodpecker/push/test', 7),
      failedCheck('ci/woodpecker/pr/test', 8),
    ];
    const refuseSecond = woodpecker.onRestart;
    woodpecker.onRestart = (repo, pipeline) => {
      refuseSecond(repo, pipeline);
      woodpecker.restartRefusal = { status: 400, message: 'cannot restart' };
    };
    const response = await call(fake, rerun(units), undefined, config);
    expect(response).toMatchObject({
      ok: false,
      mutation: {
        outcome: 'verification_failed',
        rerun: {
          observed: [{ unit: units[0].unit, rerun: { id: 'ci/woodpecker/push/test', attempt: 9 } }],
        },
      },
    });
  });
});
