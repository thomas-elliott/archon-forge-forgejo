import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Fetch } from '../src/api';
import { FakeForgejo } from './fake-forgejo';
import { call, losingAnswer } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const HEAD_SHA = 'c'.repeat(40);
const BASE_SHA = 'a'.repeat(40);
const MERGE_SHA = 'e'.repeat(40);
const mergeRequest = (overrides: Record<string, unknown> = {}) => ({
  op: 'pr.merge' as const,
  ref: { repo: fake.repo, number: 1 },
  method: 'merge' as const,
  conditions: { head: HEAD_SHA },
  ...overrides,
});
const merges = () => fake.writes.filter(write => write.path.endsWith('/merge'));

describe('pr.merge', () => {
  beforeEach(() => fake.addPull({ head: 'feature', headSha: HEAD_SHA }));

  test('merges at the expected head and reports the landed commit', async () => {
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          outcome: 'applied',
          changed: true,
          pr: { number: 1, state: 'merged', head_revision: HEAD_SHA },
          method: 'merge',
          conditions: { head: HEAD_SHA },
          enforcedConditions: ['head'],
          landed: { commit: MERGE_SHA, tree: null, parents: [BASE_SHA, HEAD_SHA] },
        },
      },
    });
    expect(fake.issues[0].pull?.merged).toBe(true);
    expect(fake.branches.has('feature')).toBe(false);
  });

  test('a merge whose branch deletion Forgejo refuses is still applied', async () => {
    // Forgejo merges first, then answers 403 when the head branch is protected.
    fake.branchDeletionRefusal = { status: 403, message: 'the head branch is protected' };
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({
      ok: true,
      result: { value: { outcome: 'applied', landed: { commit: MERGE_SHA } } },
    });
    expect(fake.branches.has('feature')).toBe(true);
  });

  test('a merge whose branch deletion fails with a server error is still applied', async () => {
    fake.branchDeletionRefusal = { status: 500, message: 'DeleteBranchAfterMerge' };
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({ ok: true, result: { value: { outcome: 'applied' } } });
  });

  test('a server error with nothing merged is outcome_unknown', async () => {
    fake.mergeRefusal = { status: 500, message: 'internal error' };
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
    expect(merges()).toHaveLength(1);
  });

  test('passes the requested method to Forgejo', async () => {
    const response = await call(fake, mergeRequest({ method: 'squash' }));
    expect(response).toMatchObject({
      ok: true,
      result: { value: { method: 'squash', landed: { parents: [BASE_SHA] } } },
    });
  });

  test('a head other than the expected one is refused before writing', async () => {
    const response = await call(fake, mergeRequest({ conditions: { head: 'd'.repeat(40) } }));
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: {
        outcome: 'refused',
        observed: { state: 'open', head_revision: HEAD_SHA },
        merge: { method: 'merge', conditions: { head: 'd'.repeat(40) } },
      },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a push between the read and the merge is refused by Forgejo', async () => {
    // The plugin's own read sees the expected head; the branch moves before the merge lands.
    const pushing: Fetch = async (url, init) => {
      if (init?.method === 'POST' && fake.issues[0].pull)
        fake.issues[0].pull.headSha = 'd'.repeat(40);
      return fetch(url, init);
    };
    const response = await call(fake, mergeRequest(), pushing);
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict', message: expect.stringContaining('head out of date') },
      mutation: { outcome: 'refused' },
    });
    expect(fake.issues[0].pull?.merged).toBe(false);
  });

  test('an already merged pull request is refused without writing', async () => {
    await call(fake, mergeRequest());
    const again = await call(fake, mergeRequest());
    expect(again).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused', observed: { state: 'merged' } },
    });
    expect(merges()).toHaveLength(1);
  });

  test('a closed pull request is refused without writing', async () => {
    fake.issues[0].state = 'closed';
    fake.issues[0].closedAt = '2026-11-18T12:00:00+13:00';
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'refused', observed: { state: 'closed' } },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a draft is refused without writing', async () => {
    fake.issues[0].title = 'WIP: A pull request';
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'refused', observed: { is_draft: true } },
    });
    expect(fake.writes).toEqual([]);
  });

  test("a merge conflict is refused with Forgejo's message", async () => {
    fake.mergeRefusal = { status: 409, message: 'Merge conflicts in README.md' };
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict', message: expect.stringContaining('Merge conflicts in README.md') },
      mutation: { outcome: 'refused', observed: { state: 'open' } },
    });
  });

  test('a pull request that conflicts with its base is refused with the reason added', async () => {
    if (fake.issues[0].pull) fake.issues[0].pull.mergeable = false;
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({
      ok: false,
      error: {
        kind: 'conflict',
        status: 405,
        message: expect.stringMatching(/Please try again later.*conflicts with its base branch/),
      },
      mutation: { outcome: 'refused', observed: { state: 'open' } },
    });
  });

  test("a branch protection refusal is refused with Forgejo's message", async () => {
    fake.mergeRefusal = { status: 405, message: 'User not allowed to merge PR' };
    const response = await call(fake, mergeRequest());
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict', status: 405, message: expect.stringContaining('not allowed') },
      mutation: { outcome: 'refused' },
    });
  });

  test('losing the answer to the merge is outcome_unknown and is not retried', async () => {
    const response = await call(
      fake,
      mergeRequest(),
      losingAnswer((url, method) => method === 'POST' && url.endsWith('/merge'))
    );
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'outcome_unknown', merge: { conditions: { head: HEAD_SHA } } },
    });
    expect(merges()).toHaveLength(1);
  });

  test('an acknowledged merge that reads back unmerged is verification_failed', async () => {
    // Forgejo answers 200 but the pull request stays open.
    const ignoring: Fetch = async (url, init) =>
      init?.method === 'POST' ? new Response(null, { status: 200 }) : fetch(url, init);
    const response = await call(fake, mergeRequest(), ignoring);
    expect(response).toMatchObject({
      ok: false,
      mutation: {
        outcome: 'verification_failed',
        observed: { state: 'open' },
        merge: { landed: { commit: null } },
      },
    });
  });

  test('an unreadable landed commit leaves its parents null', async () => {
    const hidingCommit: Fetch = async (url, init) =>
      url.includes('/git/commits/') ? new Response(null, { status: 500 }) : fetch(url, init);
    const response = await call(fake, mergeRequest(), hidingCommit);
    expect(response).toMatchObject({
      ok: true,
      result: { value: { landed: { commit: MERGE_SHA, tree: null, parents: null } } },
    });
  });

  test('a merge without a head condition is refused before reading', async () => {
    const response = await call(fake, mergeRequest({ conditions: {} }));
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.requests).toEqual([]);
  });

  test('a base or tree condition is refused as unsupported', async () => {
    const response = await call(
      fake,
      mergeRequest({ conditions: { head: HEAD_SHA, base: BASE_SHA } })
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'unsupported_op' } });
    expect(fake.requests).toEqual([]);
  });
});
