import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { contentDigest } from '@archon/forge/operations';
import { FakeForgejo } from './fake-forgejo';
import { call, losingAnswer } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const issue = (number: number) => ({ kind: 'issue' as const, ref: { repo: fake.repo, number } });

describe('workitem.list', () => {
  test('lists open issues and pull requests carrying exactly the label, across pages', async () => {
    const ready = fake.addLabel('status/ready');
    const lookalike = fake.addLabel('Status/Ready');
    for (let i = 0; i < 60; i++) fake.addIssue({ labels: [ready.id] });
    fake.addPull({ head: 'feature' }, { labels: [ready.id] });
    fake.addIssue({ labels: [ready.id], state: 'closed' });
    fake.addIssue({ labels: [lookalike.id] });
    fake.addIssue();

    const response = await call(fake, {
      op: 'workitem.list',
      repo: fake.repo,
      label: 'status/ready',
    });
    if (!response.ok || response.result.op !== 'workitem.list') throw new Error('expected a list');
    const items = response.result.value.items;
    expect(items).toHaveLength(61);
    expect(items.filter(item => item.kind === 'pr').map(item => item.ref.number)).toEqual([61]);
    expect(items.every(item => item.state === 'open')).toBe(true);
  });

  test('a label the repository does not have lists nothing, though Forgejo ignores the filter', async () => {
    fake.addIssue();
    const response = await call(fake, { op: 'workitem.list', repo: fake.repo, label: 'missing' });
    expect(response).toMatchObject({ ok: true, result: { value: { items: [] } } });
  });

  test('a label containing a comma is refused', async () => {
    const response = await call(fake, { op: 'workitem.list', repo: fake.repo, label: 'a,b' });
    expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });
});

describe('workitem.view', () => {
  test('returns the labels and the author', async () => {
    const bug = fake.addLabel('bug');
    fake.addIssue({ title: 'Title', body: 'Body', labels: [bug.id] });
    const response = await call(fake, { op: 'workitem.view', ref: { repo: fake.repo, number: 1 } });
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          kind: 'issue',
          title: 'Title',
          body: 'Body',
          labels: ['bug'],
          author: { host: fake.host, id: '7', login: 'archon-bot' },
        },
      },
    });
  });

  test('reports a pull request as kind pr', async () => {
    fake.addPull({ head: 'feature' });
    const response = await call(fake, { op: 'workitem.view', ref: { repo: fake.repo, number: 1 } });
    expect(response).toMatchObject({ ok: true, result: { value: { kind: 'pr' } } });
  });

  test('a missing item is not_found', async () => {
    const response = await call(fake, { op: 'workitem.view', ref: { repo: fake.repo, number: 9 } });
    expect(response).toMatchObject({ ok: false, error: { kind: 'not_found', status: 404 } });
  });
});

describe('repo.labels.list', () => {
  test('includes organization labels', async () => {
    fake.addLabel('bug');
    fake.orgLabels = [
      { id: 1, name: 'org-wide', color: 'ffffff', description: '', exclusive: false },
    ];
    const response = await call(fake, { op: 'repo.labels.list', repo: fake.repo });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { labels: [{ name: 'bug' }, { name: 'org-wide' }] } },
    });
  });
});

describe('repo.label.ensure', () => {
  test('creates a scope/value label as exclusive and reads it back', async () => {
    const response = await call(fake, {
      op: 'repo.label.ensure',
      repo: fake.repo,
      name: 'status/ready',
      color: 'A1B2C3',
      description: 'Ready to pick up',
    });
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          changed: true,
          label: {
            name: 'status/ready',
            color: 'a1b2c3',
            descriptionDigest: contentDigest('Ready to pick up'),
          },
        },
      },
    });
    expect(fake.labels[0]).toMatchObject({ name: 'status/ready', exclusive: true });
  });

  test('creates an unscoped label as not exclusive', async () => {
    await call(fake, {
      op: 'repo.label.ensure',
      repo: fake.repo,
      name: 'bug',
      color: 'ffffff',
      description: '',
    });
    expect(fake.labels[0]).toMatchObject({ name: 'bug', exclusive: false });
  });

  test('an existing label is left alone and nothing is written', async () => {
    fake.addLabel('bug', { color: '000000', description: 'operator text' });
    const response = await call(fake, {
      op: 'repo.label.ensure',
      repo: fake.repo,
      name: 'bug',
      color: 'ffffff',
      description: 'new text',
    });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(fake.writes).toEqual([]);
    expect(fake.labels[0]).toMatchObject({ color: '000000', description: 'operator text' });
  });
});

describe('workitem.label.add', () => {
  test('adding a label of an exclusive scope drops the other label of that scope', async () => {
    const ready = fake.addLabel('status/ready', { exclusive: true });
    fake.addLabel('status/in-progress', { exclusive: true });
    const bug = fake.addLabel('bug');
    fake.addIssue({ labels: [ready.id, bug.id] });

    const response = await call(fake, {
      op: 'workitem.label.add',
      subject: issue(1),
      name: 'status/in-progress',
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, labels: ['bug', 'status/in-progress'] } },
    });
  });

  test('a label already on the item is changed: false and writes nothing', async () => {
    const bug = fake.addLabel('bug');
    fake.addIssue({ labels: [bug.id] });
    const response = await call(fake, { op: 'workitem.label.add', subject: issue(1), name: 'bug' });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(fake.writes).toEqual([]);
  });

  test('an organization label can be added', async () => {
    fake.orgLabels = [
      { id: 1, name: 'org-wide', color: 'ffffff', description: '', exclusive: false },
    ];
    fake.addIssue();
    const response = await call(fake, {
      op: 'workitem.label.add',
      subject: issue(1),
      name: 'org-wide',
    });
    expect(response).toMatchObject({ ok: true, result: { value: { labels: ['org-wide'] } } });
  });

  test('a label that does not exist is refused, and none is created', async () => {
    fake.addLabel('Bug');
    fake.addIssue();
    const response = await call(fake, { op: 'workitem.label.add', subject: issue(1), name: 'bug' });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('a subject whose kind is wrong is refused', async () => {
    fake.addLabel('bug');
    fake.addPull({ head: 'feature' });
    const response = await call(fake, { op: 'workitem.label.add', subject: issue(1), name: 'bug' });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.writes).toEqual([]);
  });

  test('losing the answer to the write is outcome_unknown', async () => {
    fake.addLabel('bug');
    fake.addIssue();
    const response = await call(
      fake,
      { op: 'workitem.label.add', subject: issue(1), name: 'bug' },
      losingAnswer((_url, method) => method === 'POST')
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
  });

  test('a FORGEJO_URL that is not a bare origin is refused before any call', async () => {
    fake.addLabel('bug');
    fake.addIssue();
    const { handleOperation } = await import('../src/operations');
    const response = await handleOperation(
      { operationId: 'op-url', op: 'workitem.label.add', subject: issue(1), name: 'bug' },
      { token: 'unused', forgejoUrl: `${fake.origin}/api` }
    );
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
      mutation: { outcome: 'refused' },
    });
    expect(fake.requests).toEqual([]);
  });
});

describe('workitem.label.remove', () => {
  test('removes only the named label', async () => {
    const bug = fake.addLabel('bug');
    const docs = fake.addLabel('docs');
    fake.addIssue({ labels: [bug.id, docs.id] });
    const response = await call(fake, {
      op: 'workitem.label.remove',
      subject: issue(1),
      name: 'bug',
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, labels: ['docs'] } },
    });
  });

  test('a repository label is removed by its id', async () => {
    const bug = fake.addLabel('bug');
    fake.addIssue({ labels: [bug.id] });
    await call(fake, { op: 'workitem.label.remove', subject: issue(1), name: 'bug' });
    expect(fake.writes).toEqual([
      { method: 'DELETE', path: `/api/v1/repos/owner/repo/issues/1/labels/${String(bug.id)}` },
    ]);
  });

  test('an organization label is removed by name after its id answers 422', async () => {
    const docs = fake.addLabel('docs');
    fake.orgLabels = [
      { id: 11, name: 'status/in-progress', color: 'ffffff', description: '', exclusive: true },
      { id: 12, name: 'org-wide', color: 'ffffff', description: '', exclusive: false },
    ];
    fake.addIssue({ labels: [docs.id, 11, 12] });
    const response = await call(fake, {
      op: 'workitem.label.remove',
      subject: issue(1),
      name: 'status/in-progress',
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { changed: true, labels: ['docs', 'org-wide'] } },
    });
    expect(fake.writes).toEqual([
      { method: 'DELETE', path: '/api/v1/repos/owner/repo/issues/1/labels/11' },
      { method: 'DELETE', path: '/api/v1/repos/owner/repo/issues/1/labels/status%2Fin-progress' },
    ]);
  });

  test('a label not on the item is changed: false and writes nothing', async () => {
    fake.addLabel('bug');
    fake.addIssue();
    const response = await call(fake, {
      op: 'workitem.label.remove',
      subject: issue(1),
      name: 'bug',
    });
    expect(response).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(fake.writes).toEqual([]);
  });
});

describe('authorization', () => {
  test('a rejected token is an authorization error', async () => {
    fake.addIssue();
    const { handleOperation } = await import('../src/operations');
    const response = await handleOperation(
      { operationId: 'op-auth', op: 'workitem.view', ref: { repo: fake.repo, number: 1 } },
      { token: 'wrong', forgejoUrl: fake.origin }
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'authorization', status: 401 } });
  });
});
