import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { contentDigest } from '@archon/forge/operations';
import { FakeForgejo } from './fake-forgejo';
import { call, losingAnswer } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const marker = '<!-- archon-report -->';
const subject = (kind: 'issue' | 'pr', number = 1) => ({
  kind,
  ref: { repo: fake.repo, number },
});

describe('workitem.comment.upsert', () => {
  test('creates the marked comment when there is none', async () => {
    fake.addIssue();
    const body = `${marker}\nFirst report`;
    const response = await call(fake, {
      op: 'workitem.comment.upsert',
      subject: subject('issue'),
      marker,
      body,
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, comment: { bodyDigest: contentDigest(body) } } },
    });
    expect(fake.comments.map(comment => comment.body)).toEqual([body]);
  });

  test('edits the marked comment in place, leaving other comments alone', async () => {
    fake.addIssue();
    fake.addComment(1, 'A human comment');
    const ours = fake.addComment(1, `${marker}\nOld report`);
    const body = `${marker}\nNew report`;
    const response = await call(fake, {
      op: 'workitem.comment.upsert',
      subject: subject('issue'),
      marker,
      body,
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, comment: { id: String(ours.id) } } },
    });
    expect(fake.comments.map(comment => comment.body)).toEqual(['A human comment', body]);
  });

  test('an identical marked comment is changed: false and writes nothing', async () => {
    fake.addIssue();
    const body = `${marker}\nReport`;
    fake.addComment(1, body);
    const response = await call(fake, {
      op: 'workitem.comment.upsert',
      subject: subject('issue'),
      marker,
      body,
    });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(fake.writes).toEqual([]);
  });

  test('two marked comments are a refused conflict', async () => {
    fake.addIssue();
    fake.addComment(1, `${marker}\nOne`);
    fake.addComment(1, `${marker}\nTwo`);
    const response = await call(fake, {
      op: 'workitem.comment.upsert',
      subject: subject('issue'),
      marker,
      body: `${marker}\nThree`,
    });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a body that does not start with the marker is refused', async () => {
    fake.addIssue();
    const response = await call(fake, {
      op: 'workitem.comment.upsert',
      subject: subject('issue'),
      marker,
      body: `Report\n${marker}`,
    });
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
    expect(fake.writes).toEqual([]);
  });

  test('a subject of the wrong kind is refused', async () => {
    fake.addPull({ head: 'feature' });
    const response = await call(fake, {
      op: 'workitem.comment.upsert',
      subject: subject('issue'),
      marker,
      body: marker,
    });
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
    expect(fake.writes).toEqual([]);
  });

  test('losing the answer to the create is outcome_unknown', async () => {
    fake.addIssue();
    const response = await call(
      fake,
      { op: 'workitem.comment.upsert', subject: subject('issue'), marker, body: marker },
      losingAnswer((_url, method) => method === 'POST')
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
  });
});

describe('comment.upsert', () => {
  test('writes the marked comment on a pull request by ref', async () => {
    fake.addPull({ head: 'feature' });
    const response = await call(fake, {
      op: 'comment.upsert',
      ref: { repo: fake.repo, number: 1 },
      marker,
      body: `${marker}\nReport`,
    });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: true } } });
  });
});

describe('workitem.comments', () => {
  test('lists every comment with its author, oldest first', async () => {
    fake.addIssue();
    fake.addComment(1, 'first');
    fake.addComment(1, 'second');
    const response = await call(fake, { op: 'workitem.comments', subject: subject('issue') });
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          workitem: { kind: 'issue' },
          comments: [
            { body: 'first', author: { login: 'archon-bot' } },
            { body: 'second', author: { login: 'archon-bot' } },
          ],
        },
      },
    });
  });
});
