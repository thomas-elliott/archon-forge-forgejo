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

const marker = '<!-- archon-discovery abc -->';
const createRequest = () => ({
  op: 'workitem.create' as const,
  repo: fake.repo,
  title: 'A discovery',
  body: `${marker}\nDetails`,
  marker,
});
const ref = (number = 1) => ({ repo: fake.repo, number });

describe('workitem.create', () => {
  test('creates an issue and reads it back', async () => {
    const response = await call(fake, createRequest());
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          changed: true,
          workitem: { kind: 'issue', state: 'open' },
          markerDigest: contentDigest(marker),
          bodyDigest: contentDigest(`${marker}\nDetails`),
        },
      },
    });
  });

  test('a retry after a lost answer finds the first issue instead of creating a second', async () => {
    const lost = await call(
      fake,
      createRequest(),
      losingAnswer((_url, method) => method === 'POST')
    );
    expect(lost).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });

    const retry = await call(fake, createRequest());
    expect(retry).toMatchObject({
      ok: true,
      result: { value: { changed: false, workitem: { ref: { number: 1 } } } },
    });
    expect(fake.issues).toHaveLength(1);
  });

  test('recovery finds a closed issue and does not reopen it', async () => {
    fake.addIssue({ body: `${marker}\nOld`, state: 'closed' });
    const response = await call(fake, createRequest());
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: false, workitem: { state: 'closed' } } },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a pull request carrying the marker is not mistaken for the issue', async () => {
    fake.addPull({ head: 'feature' }, { body: `${marker}\nPR` });
    const response = await call(fake, createRequest());
    expect(response).toMatchObject({ ok: true, result: { value: { changed: true } } });
  });

  test('two issues carrying the marker are a refused conflict', async () => {
    fake.addIssue({ body: marker });
    fake.addIssue({ body: marker });
    const response = await call(fake, createRequest());
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
  });
});

describe('workitem.edit-body', () => {
  test('replaces the body and reads it back', async () => {
    fake.addIssue({ body: 'old' });
    const response = await call(fake, { op: 'workitem.edit-body', ref: ref(), body: 'new' });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: true } } });
    expect(fake.issues[0].body).toBe('new');
  });

  test('a pull request is refused', async () => {
    fake.addPull({ head: 'feature' });
    const response = await call(fake, { op: 'workitem.edit-body', ref: ref(), body: 'new' });
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
    expect(fake.writes).toEqual([]);
  });
});

describe('workitem.close', () => {
  test('closes an open issue as completed', async () => {
    fake.addIssue();
    const response = await call(fake, { op: 'workitem.close', ref: ref(), reason: 'completed' });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, workitem: { state: 'closed' }, reason: 'completed' } },
    });
  });

  test('an issue already closed is changed: false and writes nothing', async () => {
    fake.addIssue({ state: 'closed', closedAt: '2026-11-18T12:00:00+13:00' });
    const response = await call(fake, { op: 'workitem.close', ref: ref(), reason: 'completed' });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(fake.writes).toEqual([]);
  });

  test('a duplicate is closed with the closed/duplicate label and reads back as duplicate', async () => {
    const label = fake.addLabel('closed/duplicate', { exclusive: true });
    fake.addIssue();
    const close = () => call(fake, { op: 'workitem.close', ref: ref(), reason: 'duplicate' });
    expect(await close()).toMatchObject({
      ok: true,
      result: { value: { changed: true, workitem: { state: 'closed' }, reason: 'duplicate' } },
    });
    expect(fake.issues[0].labels).toEqual([label.id]);

    const writes = fake.writes.length;
    expect(await close()).toMatchObject({
      ok: true,
      result: { value: { changed: false, reason: 'duplicate' } },
    });
    expect(fake.writes).toHaveLength(writes);
  });

  test('an issue closed without a reason label is refused as another reason', async () => {
    fake.addLabel('closed/not_planned');
    fake.addIssue({ state: 'closed', closedAt: '2026-11-18T12:00:00+13:00' });
    const response = await call(fake, { op: 'workitem.close', ref: ref(), reason: 'not_planned' });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('an open issue labelled for another reason is refused before writing', async () => {
    fake.addLabel('closed/duplicate');
    const notPlanned = fake.addLabel('closed/not_planned');
    fake.addIssue({ labels: [notPlanned.id] });
    const response = await call(fake, { op: 'workitem.close', ref: ref(), reason: 'duplicate' });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a reason whose label does not exist is refused before writing', async () => {
    fake.addIssue();
    const response = await call(fake, { op: 'workitem.close', ref: ref(), reason: 'not_planned' });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a close whose answer is lost after the label went on is unknown, and a retry finishes', async () => {
    fake.addLabel('closed/not_planned');
    fake.addIssue();
    const request = { op: 'workitem.close' as const, ref: ref(), reason: 'not_planned' as const };
    const lost = await call(
      fake,
      request,
      losingAnswer((_url, method) => method === 'PATCH')
    );
    expect(lost).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
    expect(await call(fake, request)).toMatchObject({
      ok: true,
      result: { value: { workitem: { state: 'closed' }, reason: 'not_planned' } },
    });
  });

  test('a close Forgejo refuses after the label went on says the label remains, and a retry finishes', async () => {
    fake.addLabel('closed/not_planned');
    fake.addIssue();
    const request = { op: 'workitem.close' as const, ref: ref(), reason: 'not_planned' as const };
    // Forgejo answers the close with 403 and does not apply it.
    const refusingClose: Fetch = async (url, init) =>
      init?.method === 'PATCH'
        ? Response.json({ message: 'forbidden' }, { status: 403 })
        : fetch(url, init);
    expect(await call(fake, request, refusingClose)).toMatchObject({
      ok: false,
      mutation: {
        outcome: 'verification_failed',
        leaveBehind: 'issue 1 carries closed/not_planned and is still open',
      },
    });
    expect(await call(fake, request)).toMatchObject({
      ok: true,
      result: { value: { workitem: { state: 'closed' }, reason: 'not_planned' } },
    });
  });
});
