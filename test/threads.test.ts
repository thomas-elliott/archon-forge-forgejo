import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeForgejo } from './fake-forgejo';
import { call, losingAnswer } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
  fake.addPull({ head: 'feature' });
});
afterEach(() => fake.stop());

const ref = () => ({ repo: fake.repo, number: 1 });

async function threads() {
  const response = await call(fake, { op: 'pr.threads', ref: ref() });
  if (!response.ok || response.result.op !== 'pr.threads') throw new Error('expected threads');
  return response.result.value.threads;
}

describe('pr.threads', () => {
  test("groups each review's comments by line into threads, oldest first", async () => {
    const review = fake.addReview(1);
    const opened = fake.addReviewComment(review, { path: 'src/a.ts', position: 4, body: 'Why?' });
    const other = fake.addReviewComment(review, { path: 'src/a.ts', position: 9 });
    const reply = fake.addReviewComment(review, {
      path: 'src/a.ts',
      position: 4,
      body: 'Because.',
    });
    // Another review on the same line is a conversation of its own, as Forgejo shows it.
    const second = fake.addReviewComment(fake.addReview(1), { path: 'src/a.ts', position: 4 });
    const removedLine = fake.addReviewComment(review, { path: 'src/b.ts', original_position: 2 });

    const found = await threads();
    expect(found.map(thread => thread.comments.map(comment => comment.id))).toEqual([
      [String(opened.id), String(reply.id)],
      [String(other.id)],
      [String(second.id)],
      [String(removedLine.id)],
    ]);
    expect(found[0]).toMatchObject({
      id: String(opened.id),
      resolved: false,
      outdated: false,
      path: 'src/a.ts',
      line: 4,
      comments: [{ body: 'Why?', author: { login: 'archon-bot' } }, { body: 'Because.' }],
    });
    expect(found[3]).toMatchObject({ path: 'src/b.ts', line: null });
  });

  test('a thread is resolved when Forgejo names who resolved it', async () => {
    fake.addReviewComment(fake.addReview(1), { path: 'src/a.ts', position: 4, resolved: true });
    expect((await threads())[0].resolved).toBe(true);
  });

  test("leaves out a pending review, which is still its author's draft", async () => {
    fake.addReviewComment(fake.addReview(1, 'PENDING'), { path: 'src/a.ts', position: 4 });
    expect(await threads()).toEqual([]);
  });
});

describe('pr.thread.reply', () => {
  test("adds the reply to the thread's review on the same line", async () => {
    const review = fake.addReview(1);
    const opened = fake.addReviewComment(review, {
      path: 'src/b.ts',
      original_position: 2,
      extra_lines_count: 1,
    });
    const response = await call(fake, {
      op: 'pr.thread.reply',
      ref: ref(),
      thread: String(opened.id),
      body: 'Renamed.',
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { outcome: 'applied', changed: true, thread: String(opened.id) } },
    });
    const [thread] = await threads();
    expect(thread.comments.map(comment => comment.body)).toEqual([
      'Please rename this.',
      'Renamed.',
    ]);
  });

  test('refuses a thread the pull request does not have, writing nothing', async () => {
    const response = await call(fake, {
      op: 'pr.thread.reply',
      ref: ref(),
      thread: '999',
      body: 'Renamed.',
    });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a reply whose answer is lost has an unknown outcome', async () => {
    const opened = fake.addReviewComment(fake.addReview(1), { path: 'src/a.ts', position: 4 });
    const response = await call(
      fake,
      { op: 'pr.thread.reply', ref: ref(), thread: String(opened.id), body: 'Renamed.' },
      losingAnswer((_url, method) => method === 'POST')
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
  });
});
