import { afterEach, beforeEach, expect, test } from 'bun:test';
import { FakeForgejo } from './fake-forgejo';
import { call } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const ROOT = '1'.repeat(40);
const FORK_POINT = '2'.repeat(40);
const HEAD = '3'.repeat(40);
const MAIN_1 = '4'.repeat(40);
const MAIN_2 = '5'.repeat(40);

beforeEach(() => {
  // main: ROOT - FORK_POINT - MAIN_1 - MAIN_2; the pull request: FORK_POINT - HEAD.
  fake.commits.set(ROOT, { parents: [] });
  fake.commits.set(FORK_POINT, { parents: [ROOT] });
  fake.commits.set(MAIN_1, { parents: [FORK_POINT] });
  fake.commits.set(MAIN_2, { parents: [MAIN_1] });
  fake.commits.set(HEAD, { parents: [FORK_POINT] });
  fake.branches.set('main', MAIN_2);
});

const mergeState = () => call(fake, { op: 'pr.merge-state', ref: { repo: fake.repo, number: 1 } });

test('counts the default branch commits the head lacks, and reads a mergeable pull request as clean', async () => {
  fake.addPull({ head: 'feature', headSha: HEAD });
  expect(await mergeState()).toMatchObject({
    ok: true,
    result: {
      value: {
        head_revision: HEAD,
        default_branch: 'main',
        default_revision: MAIN_2,
        behind: 2,
        mergeable: 'clean',
        merge_commit: null,
      },
    },
  });
});

test('reads a pull request Forgejo does not call mergeable as unknown, never as a conflict', async () => {
  // Forgejo says the same while it is still checking as when the branches conflict.
  fake.addPull({ head: 'feature', headSha: HEAD, mergeable: false });
  expect(await mergeState()).toMatchObject({
    ok: true,
    result: { value: { mergeable: 'unknown' } },
  });
});

test('a head that contains the default branch is not behind', async () => {
  fake.commits.set(HEAD, { parents: [MAIN_2] });
  fake.addPull({ head: 'feature', headSha: HEAD });
  expect(await mergeState()).toMatchObject({ ok: true, result: { value: { behind: 0 } } });
});

test('a merged pull request names the commit it landed as', async () => {
  fake.addPull({ head: 'feature', headSha: HEAD, merged: true, mergeCommit: MAIN_2 });
  expect(await mergeState()).toMatchObject({
    ok: true,
    result: { value: { merge_commit: MAIN_2 } },
  });
});
