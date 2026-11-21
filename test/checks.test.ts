import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runForgeReadConformance } from '@archon/forge/conformance';
import type { ForgeRequest } from '@archon/forge/operations';
import { handleOperation } from '../src/operations';
import { FakeForgejo, TOKEN } from './fake-forgejo';
import { call } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const SHA = 'e'.repeat(40);

describe('checks.commit', () => {
  test('keeps the latest status per context and maps each state', async () => {
    fake.addStatus(SHA, 'ci/woodpecker/push/build', 'pending');
    fake.addStatus(SHA, 'ci/woodpecker/push/build', 'success');
    fake.addStatus(SHA, 'ci/woodpecker/push/test', 'failure');
    fake.addStatus(SHA, 'ci/woodpecker/push/lint', 'warning');
    fake.addStatus(SHA, 'ci/woodpecker/push/deploy', 'pending');
    const response = await call(fake, {
      op: 'checks.commit',
      repo: fake.repo,
      at: { kind: 'revision', revision: SHA },
    });
    if (!response.ok || response.result.op !== 'checks.commit') throw new Error('expected checks');
    const byName = Object.fromEntries(
      response.result.value.units.map(unit => [unit.unit.name, [unit.state, unit.nativeState]])
    );
    expect(byName).toEqual({
      'ci/woodpecker/push/build': ['green', 'success'],
      'ci/woodpecker/push/test': ['red', 'failure'],
      'ci/woodpecker/push/lint': ['unknown', 'warning'],
      'ci/woodpecker/push/deploy': ['pending', 'pending'],
    });
    expect(response.result.value).toMatchObject({
      branch: null,
      revision: SHA,
      summary: { state: 'red' },
      approvalPending: null,
    });
  });

  test('a commit with no statuses is none', async () => {
    const response = await call(fake, {
      op: 'checks.commit',
      repo: fake.repo,
      at: { kind: 'revision', revision: SHA },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { units: [], summary: { state: 'none' } } },
    });
  });

  test('reads the default branch head when asked for it', async () => {
    fake.defaultBranch = 'trunk';
    fake.branches.set('trunk', SHA);
    fake.addStatus(SHA, 'ci/woodpecker/push/build', 'error');
    const response = await call(fake, {
      op: 'checks.commit',
      repo: fake.repo,
      at: { kind: 'default_branch' },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { branch: 'trunk', revision: SHA, summary: { state: 'red' } } },
    });
  });
});

describe('checks.state', () => {
  test('reads the statuses at the pull request head, and passes the read conformance kit', async () => {
    fake.addPull({ head: 'feature', headSha: SHA });
    fake.addStatus(SHA, 'ci/woodpecker/pr/build', 'pending');
    fake.addStatus(SHA, 'ci/woodpecker/pr/build', 'success');
    const request = {
      operationId: 'checks-1',
      op: 'checks.state' as const,
      ref: { repo: fake.repo, number: 1 },
    };
    const failures = await runForgeReadConformance(
      (sent: ForgeRequest) => handleOperation(sent, { token: TOKEN, forgejoUrl: fake.origin }),
      [
        {
          name: 'latest status green',
          request,
          expected: {
            revision: SHA,
            state: 'green',
            units: [{ kind: 'commit_status', id: '2', rerun: null }],
          },
        },
      ]
    );
    expect(failures).toEqual([]);
  });
});
