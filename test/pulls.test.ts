import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { contentDigest } from '@archon/forge/operations';
import type { Fetch } from '../src/api';
import { FakeForgejo } from './fake-forgejo';
import { call, losingAnswer } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const HEAD_SHA = 'c'.repeat(40);
const ref = (number = 1) => ({ repo: fake.repo, number });
const headSelector = (head = 'feature') => ({
  kind: 'head' as const,
  repo: fake.repo,
  headRepo: fake.repo,
  head,
});
const createRequest = (overrides: Record<string, unknown> = {}) => ({
  op: 'pr.create' as const,
  repo: fake.repo,
  headRepo: fake.repo,
  head: 'feature',
  headRevision: HEAD_SHA,
  base: 'main',
  title: 'Add the feature',
  body: 'Closes #1',
  draft: false,
  ...overrides,
});

describe('pr.view', () => {
  test('by number returns the record, author and timestamps of a merged pull request', async () => {
    fake.addPull(
      { head: 'feature', headSha: HEAD_SHA, merged: true },
      { state: 'closed', closedAt: '2026-11-18T12:00:00+13:00' }
    );
    // A merged pull request's branch is often deleted; the branch name must survive that.
    fake.branches.delete('feature');
    const response = await call(fake, { op: 'pr.view', selector: { kind: 'number', ref: ref() } });
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          pr: {
            head: 'feature',
            base: 'main',
            state: 'merged',
            head_revision: HEAD_SHA,
            head_repo: fake.repo,
            is_draft: false,
            maintainer_can_modify: false,
          },
          author: { login: 'archon-bot' },
          timestamps: { merged_at: '2026-11-18T12:00:00+13:00' },
        },
      },
    });
  });

  test('by number, a missing pull request is not_found', async () => {
    const response = await call(fake, { op: 'pr.view', selector: { kind: 'number', ref: ref(5) } });
    expect(response).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });

  test('by head finds the open pull request and ignores closed ones', async () => {
    fake.addPull({ head: 'feature' }, { state: 'closed', closedAt: '2026-11-18T12:00:00+13:00' });
    fake.addPull({ head: 'feature' });
    fake.addPull({ head: 'other' });
    const response = await call(fake, { op: 'pr.view', selector: headSelector() });
    expect(response).toMatchObject({ ok: true, result: { value: { pr: { number: 2 } } } });
  });

  test('by head with no open pull request is null', async () => {
    const response = await call(fake, { op: 'pr.view', selector: headSelector() });
    expect(response).toMatchObject({ ok: true, result: { value: null } });
  });

  test('by head with two open pull requests is a conflict', async () => {
    fake.addPull({ head: 'feature' });
    fake.addPull({ head: 'feature', base: 'release' });
    const response = await call(fake, { op: 'pr.view', selector: headSelector() });
    expect(response).toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });

  test('without a draft field from Forgejo, a work-in-progress title prefix reads as draft', async () => {
    fake.reportsDraft = false;
    fake.addPull({ head: 'feature' }, { title: '[wip] Add the feature' });
    const response = await call(fake, { op: 'pr.view', selector: headSelector() });
    expect(response).toMatchObject({ ok: true, result: { value: { pr: { is_draft: true } } } });
  });
});

describe('pr.create', () => {
  beforeEach(() => fake.branches.set('feature', HEAD_SHA));

  test('opens a pull request and reads it back', async () => {
    const response = await call(fake, createRequest());
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, pr: { number: 1, head: 'feature', is_draft: false } } },
    });
  });

  test('a draft is opened with the work-in-progress prefix', async () => {
    const response = await call(fake, createRequest({ draft: true }));
    expect(response).toMatchObject({ ok: true, result: { value: { pr: { is_draft: true } } } });
    expect(fake.issues[0].title).toBe('WIP: Add the feature');
  });

  test('a branch that moved is refused before writing', async () => {
    const response = await call(fake, createRequest({ headRevision: 'd'.repeat(40) }));
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a second pull request for the head is refused before writing', async () => {
    fake.addPull({ head: 'feature', headSha: HEAD_SHA });
    const response = await call(fake, createRequest());
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused', observed: { number: 1 } },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a head in another repository is refused', async () => {
    const response = await call(
      fake,
      createRequest({ headRepo: { host: fake.host, path: 'fork/repo' } })
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
    expect(fake.writes).toEqual([]);
  });

  test('a ready title that already carries the work-in-progress prefix is refused before writing', async () => {
    const response = await call(fake, createRequest({ title: 'WIP: Add the feature' }));
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
    expect(fake.writes).toEqual([]);
  });

  test('losing the answer to the create is outcome_unknown', async () => {
    const response = await call(
      fake,
      createRequest(),
      losingAnswer((_url, method) => method === 'POST')
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
  });
});

describe('pr.edit-body', () => {
  test('replaces the body and reads it back', async () => {
    fake.addPull({ head: 'feature' }, { body: 'old' });
    const response = await call(fake, { op: 'pr.edit-body', ref: ref(), body: 'new' });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, bodyDigest: contentDigest('new') } },
    });
    expect(fake.issues[0].body).toBe('new');
  });

  test('an equal body is changed: false and writes nothing', async () => {
    fake.addPull({ head: 'feature' }, { body: 'same' });
    const response = await call(fake, { op: 'pr.edit-body', ref: ref(), body: 'same' });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(fake.writes).toEqual([]);
  });
});

describe('pr.draft and pr.ready', () => {
  test('switch a pull request to draft and back', async () => {
    fake.addPull({ head: 'feature' }, { title: 'Add the feature' });
    const drafted = await call(fake, { op: 'pr.draft', ref: ref() });
    expect(drafted).toMatchObject({
      ok: true,
      result: { value: { changed: true, pr: { is_draft: true } } },
    });
    const ready = await call(fake, { op: 'pr.ready', ref: ref() });
    expect(ready).toMatchObject({
      ok: true,
      result: { value: { changed: true, pr: { is_draft: false } } },
    });
    expect(fake.issues[0].title).toBe('Add the feature');
  });

  test('a pull request already in the requested state writes nothing', async () => {
    fake.addPull({ head: 'feature' });
    const response = await call(fake, { op: 'pr.ready', ref: ref() });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(fake.writes).toEqual([]);
  });

  test('a draft prefix this plugin does not know is refused before writing', async () => {
    fake.wipPrefixes = ['DRAFT:'];
    fake.addPull({ head: 'feature' }, { title: 'DRAFT: Add the feature' });
    const response = await call(fake, { op: 'pr.ready', ref: ref() });
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
    expect(fake.writes).toEqual([]);
  });

  test('an accepted write whose read-back disagrees is verification_failed, not refused', async () => {
    fake.addPull({ head: 'feature' }, { title: 'Add the feature' });
    // Someone else restores the title between the plugin's write and its read-back.
    const racing: Fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === 'PATCH') fake.issues[0].title = 'Add the feature';
      return response;
    };
    const response = await call(fake, { op: 'pr.draft', ref: ref() }, racing);
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'verification_failed', leaveBehind: expect.any(String) },
    });
  });

  test('losing the read-back after an accepted write is verification_failed, not refused', async () => {
    fake.addPull({ head: 'feature' }, { title: 'Add the feature' });
    let written = false;
    const failingReadBack: Fetch = async (url, init) => {
      if (written) throw new TypeError('socket closed');
      if (init?.method === 'PATCH') written = true;
      return fetch(url, init);
    };
    const response = await call(fake, { op: 'pr.draft', ref: ref() }, failingReadBack);
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'verification_failed' } });
  });

  test('a closed pull request is refused', async () => {
    fake.addPull({ head: 'feature' }, { state: 'closed', closedAt: '2026-11-18T12:00:00+13:00' });
    const response = await call(fake, { op: 'pr.draft', ref: ref() });
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'refused', observed: { state: 'closed' } },
    });
  });
});
