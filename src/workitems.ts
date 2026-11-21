/**
 * Forgejo issues and pull requests as work items: the reads that list or view them,
 * and the issue writes (create, body edit). Closing is in `close.ts`.
 */

import type { ForgeSubjectRef, RepoRef, WorkItemRef } from '@archon/forge';
import {
  contentDigest,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type ForgeSubjectRecord,
  type ForgeWorkItemRecord,
} from '@archon/forge/operations';
import { z } from 'zod';
import { authorField, userSchema } from './actor';
import {
  type ForgejoApi,
  ForgejoError,
  invalidRequest,
  namesRepo,
  pages,
  repoUrl,
  request,
} from './api';
import { applied, refused, type Submit, unverified } from './outcome';

export const issueSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.object({ id: z.number().int(), name: z.string().min(1) })),
  // Forgejo's issues endpoints serve pull requests too; only this field tells them apart.
  pull_request: z.object({}).nullable().optional(),
  repository: z.object({ full_name: z.string().min(1) }),
  user: userSchema.optional(),
});
export type Issue = z.infer<typeof issueSchema>;

/** The item as a subject record, after proving it is the one that was asked for. */
function itemRecord(repo: RepoRef, item: Issue, number = item.number): ForgeSubjectRecord {
  if (item.number !== number || !namesRepo(item.repository.full_name, repo)) {
    throw new ForgejoError(
      {
        kind: 'invalid_response',
        message: 'Forgejo item read-back did not match the requested identity',
      },
      true
    );
  }
  return {
    ref: { repo, number: item.number },
    kind: item.pull_request ? 'pr' : 'issue',
    url: item.html_url,
    state: item.state,
  };
}

/** The item's record, refused when its kind is not the subject's. */
export function subjectRecord(subject: ForgeSubjectRef, item: Issue): ForgeSubjectRecord {
  const record = itemRecord(subject.ref.repo, item, subject.ref.number);
  if (record.kind !== subject.kind)
    throw invalidRequest(
      `Forgejo item ${String(subject.ref.number)} is ${record.kind === 'pr' ? 'a pull request' : 'an issue'}, not ${subject.kind === 'pr' ? 'a pull request' : 'an issue'}`
    );
  return record;
}

/** The record of an item that must be an issue. */
export function issueRecord(ref: WorkItemRef, item: Issue): ForgeWorkItemRecord {
  return { ...subjectRecord({ kind: 'issue', ref }, item), kind: 'issue' };
}

export function labelNames(item: Issue): string[] {
  return item.labels.map(label => label.name);
}

export async function readIssue(api: ForgejoApi, ref: WorkItemRef): Promise<Issue> {
  return request(api, repoUrl(api, ref.repo, `/issues/${String(ref.number)}`), issueSchema);
}

export async function viewWorkItem(
  req: Extract<ForgeRequest, { op: 'workitem.view' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const item = await readIssue(api, req.ref);
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: {
        ...itemRecord(req.ref.repo, item, req.ref.number),
        title: item.title,
        body: item.body,
        labels: labelNames(item),
        ...authorField(req.ref.repo.host, item.user),
      },
    },
  };
}

export async function listWorkItems(
  req: Extract<ForgeRequest, { op: 'workitem.list' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  // Forgejo's `labels` filter splits on commas, so such a name cannot be asked for.
  if (req.label.includes(','))
    throw invalidRequest('Forgejo cannot list items by a label name that contains a comma');
  const items = await pages(
    api,
    repoUrl(api, req.repo, `/issues?state=open&labels=${encodeURIComponent(req.label)}`),
    issueSchema
  );
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: {
        repo: req.repo,
        label: req.label,
        // Forgejo ignores a label name it does not find and may match loosely, so the
        // filter is only a narrowing: the exact, case-sensitive name decides.
        items: items
          .filter(item => item.state === 'open' && labelNames(item).includes(req.label))
          .map(item => itemRecord(req.repo, item)),
      },
    },
  };
}

/** A body's first line, where a marker lives. */
export function firstLine(body: string): string {
  return body.split(/\r?\n/, 1)[0] ?? '';
}

/**
 * Create an issue whose body begins with `marker`, or find the one an earlier
 * attempt created. A retry after a lost answer therefore finds the first issue
 * instead of opening a second. Recovery never edits or reopens what it finds.
 */
export async function createWorkItem(
  req: Extract<ForgeMutationRequest, { op: 'workitem.create' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const issues = await pages(
    api,
    repoUrl(api, req.repo, '/issues?state=all&type=issues'),
    issueSchema
  );
  const matches = issues.filter(item => !item.pull_request && firstLine(item.body) === req.marker);
  if (matches.length > 1)
    return refused(req, {
      kind: 'conflict',
      message: 'Multiple issues carry the canonical marker',
    });
  const changed = matches.length === 0;
  let number = matches[0]?.number;
  if (number === undefined) {
    submit('submitted');
    const created = await request(
      api,
      repoUrl(api, req.repo, '/issues'),
      issueSchema,
      { method: 'POST', body: JSON.stringify({ title: req.title, body: req.body }) },
      () => submit('acknowledged')
    );
    number = created.number;
  }
  const after = await readIssue(api, { repo: req.repo, number });
  const workitem = issueRecord({ repo: req.repo, number }, after);
  if (
    firstLine(after.body) !== req.marker ||
    (changed && (after.title !== req.title || after.body !== req.body || after.state !== 'open'))
  )
    return changed
      ? unverified(
          req,
          'Created issue read-back did not match',
          `issue ${String(number)} may exist`,
          { workitem }
        )
      : refused(req, { kind: 'conflict', message: 'Recovered issue no longer carries the marker' });
  return applied(req, {
    changed,
    workitem,
    markerDigest: contentDigest(firstLine(after.body)),
    titleDigest: contentDigest(after.title),
    bodyDigest: contentDigest(after.body),
  });
}

export async function editWorkItemBody(
  req: Extract<ForgeMutationRequest, { op: 'workitem.edit-body' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const before = await readIssue(api, req.ref);
  const workitem = issueRecord(req.ref, before);
  const bodyDigest = contentDigest(req.body);
  if (before.body === req.body) return applied(req, { changed: false, workitem, bodyDigest });
  submit('submitted');
  await request(
    api,
    repoUrl(api, req.ref.repo, `/issues/${String(req.ref.number)}`),
    issueSchema,
    { method: 'PATCH', body: JSON.stringify({ body: req.body }) },
    () => submit('acknowledged')
  );
  const after = await readIssue(api, req.ref);
  const observed = issueRecord(req.ref, after);
  return after.body === req.body
    ? applied(req, { changed: true, workitem: observed, bodyDigest })
    : unverified(req, 'Issue body read-back did not match', 'the issue body may have changed', {
        workitem: observed,
      });
}
