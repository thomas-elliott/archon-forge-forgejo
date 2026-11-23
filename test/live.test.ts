/**
 * Live checks against a real Forgejo. They skip unless all three are set:
 *
 * - FORGEJO_LIVE_URL: the instance origin, such as https://forgejo.example.com
 * - FORGEJO_LIVE_REPO: a scratch repository, owner/repo, that these checks may write to
 * - FORGEJO_LIVE_TOKEN: a token that can write that repository's code, issues and labels
 *
 * They create the `status/*` and `closed/duplicate` labels if missing, two issues, one branch
 * and one pull request per run. The last check merges the pull request, so the repository must
 * let the token's user merge without approvals, and each run adds one file to the default
 * branch. The issues are closed afterwards, and the pull request and branch too if the merge
 * did not happen.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runForgeMutationConformance, runForgeReadConformance } from '@archon/forge/conformance';
import {
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  forgeRequestSchema,
  forgeResponseSchema,
} from '@archon/forge/operations';
import { matchesForgeOperationResponse } from '@archon/forge/response-match';
import type { Fetch } from '../src/api';
import { handleOperation, metadata } from '../src/operations';
import { losingAnswer } from './helpers';

const url = process.env.FORGEJO_LIVE_URL ?? '';
const path = process.env.FORGEJO_LIVE_REPO ?? '';
const token = process.env.FORGEJO_LIVE_TOKEN ?? '';
const live = url !== '' && path !== '' && token !== '';

const host = live ? new URL(url).host : 'forgejo.example.com';
const repo = { host, path };
const run = `${Date.now().toString(36)}`;
const marker = `<!-- archon-live ${run} -->`;
const branch = `archon-live-${run}`;
const state: {
  base: string;
  issue?: number;
  duplicate?: number;
  pr?: number;
  head?: string;
  merged?: boolean;
} = { base: 'main' };

let counter = 0;
async function call(request: object, fetch?: Fetch): Promise<ForgeResponse> {
  const sent = forgeRequestSchema.parse({ operationId: `live-${String(++counter)}`, ...request });
  const response = forgeResponseSchema.parse(
    await handleOperation(sent, { token, forgejoUrl: url, fetch })
  );
  // Every answer must satisfy the checks the Archon host applies.
  expect(matchesForgeOperationResponse(sent, response, metadata, host)).toBe(true);
  return response;
}

/** A direct API call, for fixture setup and clean-up the plugin has no operation for. */
async function forgejo(method: string, suffix: string, body?: object): Promise<unknown> {
  const response = await fetch(`${url}/api/v1/repos/${path}${suffix}`, {
    method,
    headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${suffix}: HTTP ${String(response.status)}`);
  return response.status === 204 ? undefined : response.json();
}

function value(response: ForgeResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`${response.error.kind}: ${response.error.message}`);
  return response.result.value as Record<string, unknown>;
}

const issueSubject = () => ({ kind: 'issue', ref: { repo, number: state.issue } });
const prRef = () => ({ repo, number: state.pr });
const merge = (head: string) =>
  call({ op: 'pr.merge', ref: prRef(), method: 'merge', conditions: { head } });

describe.skipIf(!live)('live Forgejo', () => {
  beforeAll(async () => {
    state.base = ((await forgejo('GET', '')) as { default_branch: string }).default_branch;
  });
  afterAll(async () => {
    // A merged pull request is already closed, and Forgejo deleted its branch.
    if (state.pr && !state.merged)
      await forgejo('PATCH', `/pulls/${String(state.pr)}`, { state: 'closed' });
    if (state.head && !state.merged) await forgejo('DELETE', `/branches/${branch}`);
    if (state.issue) await forgejo('PATCH', `/issues/${String(state.issue)}`, { state: 'closed' });
    if (state.duplicate)
      await forgejo('PATCH', `/issues/${String(state.duplicate)}`, { state: 'closed' });
  });

  test('repo.label.ensure creates the status labels as an exclusive scope', async () => {
    for (const name of ['status/ready', 'status/in-progress', 'status/review', 'status/blocked']) {
      await call({ op: 'repo.label.ensure', repo, name, color: '0e8a16', description: '' });
    }
    const labels = (await forgejo('GET', '/labels?limit=50')) as {
      name: string;
      exclusive: boolean;
    }[];
    expect(labels.filter(label => label.name.startsWith('status/')).every(l => l.exclusive)).toBe(
      true
    );
  });

  test('workitem.create recovers the first issue after a lost answer', async () => {
    const request = {
      op: 'workitem.create',
      repo,
      title: `Archon live check ${run}`,
      body: `${marker}\nCreated by the plugin's live tests.`,
      marker,
    };
    const lost = await call(
      request,
      losingAnswer((_url, method) => method === 'POST')
    );
    expect(lost).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
    const retry = value(await call(request));
    expect(retry.changed).toBe(false);
    state.issue = (retry.workitem as { ref: { number: number } }).ref.number;
    const search = (await forgejo('GET', '/issues?state=all&type=issues&limit=50')) as {
      body: string;
    }[];
    expect(search.filter(issue => issue.body.startsWith(marker))).toHaveLength(1);
  });

  test('the thin workflow claims, opens a pull request, reports and hands to review', async () => {
    const add = (name: string) => call({ op: 'workitem.label.add', subject: issueSubject(), name });
    expect(value(await add('status/ready')).changed).toBe(true);

    const listed = value(await call({ op: 'workitem.list', repo, label: 'status/ready' }));
    expect((listed.items as { ref: { number: number } }[]).map(item => item.ref.number)).toContain(
      state.issue ?? 0
    );
    expect(value(await call({ op: 'workitem.view', ref: issueSubject().ref })).labels).toEqual([
      'status/ready',
    ]);

    const claimed = value(await add('status/in-progress'));
    expect(claimed.labels).toEqual(['status/in-progress']);
    expect(value(await add('status/in-progress')).changed).toBe(false);

    // The agent's push, done here through the contents API.
    const pushed = (await forgejo('POST', `/contents/archon-live/${run}.txt`, {
      content: Buffer.from(`live check ${run}\n`).toString('base64'),
      message: `Live check ${run}`,
      branch: state.base,
      new_branch: branch,
    })) as { commit: { sha: string } };
    state.head = pushed.commit.sha;

    const selector = { kind: 'head', repo, headRepo: repo, head: branch };
    expect(value(await call({ op: 'pr.view', selector }))).toBeNull();
    const create = {
      op: 'pr.create',
      repo,
      headRepo: repo,
      head: branch,
      headRevision: state.head,
      base: state.base,
      title: `Archon live check ${run}`,
      body: `Refs #${String(state.issue)}`,
      draft: false,
    };
    const created = value(await call(create));
    state.pr = (created.pr as { number: number }).number;
    expect(await call(create)).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
    expect(value(await call({ op: 'pr.view', selector }))).toMatchObject({
      pr: { number: state.pr },
    });

    const report = {
      op: 'workitem.comment.upsert',
      subject: issueSubject(),
      marker,
      body: `${marker}\nOpened pull request #${String(state.pr)}.`,
    };
    expect(value(await call(report)).changed).toBe(true);
    expect(value(await call(report)).changed).toBe(false);

    expect(value(await add('status/review')).labels).toEqual(['status/review']);
    expect(value(await add('status/review')).changed).toBe(false);

    const comments = value(await call({ op: 'workitem.comments', subject: issueSubject() }));
    expect(
      (comments.comments as { body: string }[]).filter(comment => comment.body.startsWith(marker))
    ).toHaveLength(1);
    const pulls = (await forgejo('GET', '/pulls?state=all&limit=50')) as {
      head: { label: string };
    }[];
    expect(pulls.filter(pull => pull.head.label === branch)).toHaveLength(1);
  });

  test('refusals: missing label, wrong subject kind, moved head', async () => {
    const refused = { ok: false, mutation: { outcome: 'refused' } };
    expect(
      await call({ op: 'workitem.label.add', subject: issueSubject(), name: `missing-${run}` })
    ).toMatchObject(refused);
    expect(
      await call({
        op: 'workitem.label.add',
        subject: { kind: 'pr', ref: issueSubject().ref },
        name: 'status/ready',
      })
    ).toMatchObject(refused);
    expect(
      await call({
        op: 'pr.create',
        repo,
        headRepo: repo,
        head: branch,
        headRevision: '0'.repeat(40),
        base: state.base,
        title: 'Never opened',
        body: '',
        draft: false,
      })
    ).toMatchObject(refused);
  });

  test('a pull request switches to draft and back, and its body is edited', async () => {
    const view = async () =>
      value(await call({ op: 'pr.view', selector: { kind: 'number', ref: prRef() } }));
    expect(value(await call({ op: 'pr.draft', ref: prRef() })).changed).toBe(true);
    expect(await view()).toMatchObject({ pr: { is_draft: true } });
    expect(await merge(state.head ?? '')).toMatchObject({
      ok: false,
      error: { kind: 'conflict', message: 'Pull request is a draft' },
      mutation: { outcome: 'refused' },
    });
    expect(value(await call({ op: 'pr.ready', ref: prRef() })).changed).toBe(true);
    expect(await view()).toMatchObject({
      pr: { is_draft: false },
      title: `Archon live check ${run}`,
    });
    const body = `Refs #${String(state.issue)}\n\nEdited by the live check.`;
    expect(value(await call({ op: 'pr.edit-body', ref: prRef(), body })).changed).toBe(true);
    expect(await view()).toMatchObject({ body });
  });

  test("the pull request's files, merge state, file text and review threads read back", async () => {
    const head = state.head ?? '';
    const file = `archon-live/${run}.txt`;
    expect(value(await call({ op: 'pr.files', ref: prRef() }))).toEqual({
      ref: prRef(),
      head_revision: head,
      files: [
        {
          path: file,
          previous_path: null,
          status: 'added',
          patch: `@@ -0,0 +1 @@\n+live check ${run}`,
        },
      ],
    });
    expect(value(await call({ op: 'repo.file', repo, path: file, revision: head })).text).toBe(
      `live check ${run}\n`
    );
    const mergeState = value(await call({ op: 'pr.merge-state', ref: prRef() }));
    expect(mergeState).toMatchObject({
      head_revision: head,
      default_branch: state.base,
      behind: 0,
    });
    expect(['clean', 'unknown']).toContain(mergeState.mergeable as string);

    await forgejo('POST', `/pulls/${String(state.pr)}/reviews`, {
      event: 'COMMENT',
      body: '',
      comments: [{ path: file, new_position: 1, body: 'Live thread' }],
    });
    const threads = async () =>
      value(await call({ op: 'pr.threads', ref: prRef() })).threads as {
        id: string;
        resolved: boolean;
        path: string;
        line: number | null;
        comments: { body: string }[];
      }[];
    const [opened] = await threads();
    expect(opened).toMatchObject({ resolved: false, path: file, line: 1 });
    const reply = await call({
      op: 'pr.thread.reply',
      ref: prRef(),
      thread: opened.id,
      body: 'Live reply',
    });
    expect(value(reply)).toMatchObject({ outcome: 'applied', thread: opened.id });
    expect((await threads()).map(thread => thread.comments.map(comment => comment.body))).toEqual([
      ['Live thread', 'Live reply'],
    ]);
  });

  test('checks report commit statuses, latest per context', async () => {
    const head = state.head ?? '';
    const none = value(
      await call({ op: 'checks.commit', repo, at: { kind: 'revision', revision: head } })
    );
    expect(none).toMatchObject({ summary: { state: 'none' } });
    const post = (context: string, status: string) =>
      forgejo('POST', `/statuses/${head}`, { state: status, context }) as Promise<{ id: number }>;
    await post('archon-live/build', 'pending');
    const build = await post('archon-live/build', 'success');
    const lint = await post('archon-live/lint', 'warning');
    const failures = await runForgeReadConformance(
      request => handleOperation(request, { token, forgejoUrl: url }),
      [
        {
          name: 'live statuses',
          request: { operationId: 'live-checks', op: 'checks.state', ref: prRef() } as Extract<
            ForgeRequest,
            { op: 'checks.state' }
          >,
          expected: {
            revision: head,
            state: 'unknown',
            units: [
              { kind: 'commit_status', id: String(build.id), rerun: null },
              { kind: 'commit_status', id: String(lint.id), rerun: null },
            ],
          },
        },
      ]
    );
    expect(failures).toEqual([]);
    const commit = value(await call({ op: 'checks.commit', repo, at: { kind: 'default_branch' } }));
    expect(commit.branch).toBe(state.base);
  });

  test('the mutation conformance kit passes', async () => {
    const subject = issueSubject() as Extract<
      ForgeMutationRequest,
      { op: 'workitem.label.add' }
    >['subject'];
    const cases: Parameters<typeof runForgeMutationConformance>[2] = [
      {
        name: 'label already present',
        request: { operationId: 'mc-1', op: 'workitem.label.add', subject, name: 'status/review' },
        expectedOutcome: 'applied',
      },
      {
        name: 'label missing',
        request: { operationId: 'mc-2', op: 'workitem.label.add', subject, name: `missing-${run}` },
        expectedOutcome: 'refused',
      },
      {
        name: 'comment unchanged',
        request: {
          operationId: 'mc-3',
          op: 'workitem.comment.upsert',
          subject,
          marker,
          body: `${marker}\nOpened pull request #${String(state.pr)}.`,
        },
        expectedOutcome: 'applied',
      },
      {
        name: 'duplicate pull request',
        request: {
          operationId: 'mc-4',
          op: 'pr.create',
          repo,
          headRepo: repo,
          head: branch,
          headRevision: state.head ?? '',
          base: state.base,
          title: 'Never opened',
          body: '',
          draft: false,
        },
        expectedOutcome: 'refused',
      },
    ];
    const failures = await runForgeMutationConformance(
      request => handleOperation(request, { token, forgejoUrl: url }),
      metadata,
      cases
    );
    expect(failures).toEqual([]);
  });

  test('an issue body is edited, its comments listed and the issue closed', async () => {
    const ref = issueSubject().ref;
    const body = `${marker}\nEdited by the live check.`;
    expect(value(await call({ op: 'workitem.edit-body', ref, body })).changed).toBe(true);
    expect(value(await call({ op: 'workitem.view', ref })).body).toBe(body);
    expect(
      (
        value(await call({ op: 'workitem.comments', subject: issueSubject() }))
          .comments as unknown[]
      ).length
    ).toBeGreaterThan(0);
    expect(value(await call({ op: 'workitem.close', ref, reason: 'completed' }))).toMatchObject({
      changed: true,
      workitem: { state: 'closed' },
    });
    expect(value(await call({ op: 'workitem.close', ref, reason: 'completed' })).changed).toBe(
      false
    );
  });

  test('an issue closed as a duplicate carries closed/duplicate and reads back as duplicate', async () => {
    await call({
      op: 'repo.label.ensure',
      repo,
      name: 'closed/duplicate',
      color: 'cccccc',
      description: '',
    });
    const duplicateMarker = `<!-- archon-live-duplicate ${run} -->`;
    const created = value(
      await call({
        op: 'workitem.create',
        repo,
        title: `Archon live duplicate ${run}`,
        body: duplicateMarker,
        marker: duplicateMarker,
      })
    );
    const ref = (created.workitem as { ref: { number: number } }).ref;
    state.duplicate = ref.number;
    const close = async () => value(await call({ op: 'workitem.close', ref, reason: 'duplicate' }));
    expect(await close()).toMatchObject({
      changed: true,
      workitem: { state: 'closed' },
      reason: 'duplicate',
    });
    expect(await close()).toMatchObject({ changed: false, reason: 'duplicate' });
    expect(value(await call({ op: 'workitem.view', ref })).labels).toContain('closed/duplicate');
  });

  test('pr.merge refuses a wrong head, merges at the approved head and deletes the branch', async () => {
    const head = state.head ?? '';
    expect(await merge('0'.repeat(40))).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
    const merged = value(await merge(head));
    state.merged = true;
    expect(merged).toMatchObject({
      outcome: 'applied',
      pr: { state: 'merged', head_revision: head },
      method: 'merge',
      enforcedConditions: ['head'],
      landed: { tree: null },
    });
    expect((merged.landed as { parents: string[] }).parents).toContain(head);
    await expect(forgejo('GET', `/branches/${branch}`)).rejects.toThrow('HTTP 404');
    expect(await merge(head)).toMatchObject({
      ok: false,
      error: { kind: 'conflict', message: 'Pull request is merged' },
      mutation: { outcome: 'refused' },
    });
  });
});
