/**
 * Pull requests: the view by number or head branch, and the create, body edit and
 * draft-state writes. Only branches in the pull request's own repository are
 * supported; forks are not.
 *
 * Forgejo marks a draft with a title prefix rather than a flag of its own. It
 * reports the result as `draft`, which this plugin reads; to change the draft
 * state it adds or removes the prefix.
 */

import type { PrRef, RepoRef } from '@archon/forge';
import {
  contentDigest,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeRequest,
  type ForgeResponse,
  forgePrRecordSchema,
} from '@archon/forge/operations';
import { z } from 'zod';
import { authorField, userSchema } from './actor';
import {
  branchHead,
  type ForgejoApi,
  ForgejoError,
  invalidRequest,
  namesRepo,
  pages,
  repoUrl,
  request,
} from './api';
import { applied, refused, type Submit, unverified } from './outcome';

/** Forgejo's default work-in-progress prefixes, which it matches case-insensitively. */
const WIP_PREFIXES = ['WIP:', '[WIP]'];
const timestamp = z.iso.datetime({ offset: true });

const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged: z.boolean(),
  merge_commit_sha: z.string().min(1).nullable().optional(),
  mergeable: z.boolean().optional(),
  allow_maintainer_edit: z.boolean().optional(),
  user: userSchema.optional(),
  created_at: timestamp,
  merged_at: timestamp.nullable(),
  closed_at: timestamp.nullable(),
  // `label` is the branch name. `ref` becomes `refs/pull/N/head` once the branch is deleted.
  head: z.object({
    label: z.string().min(1),
    sha: z.string().min(1),
    repo: z.object({ full_name: z.string().min(1) }).nullable(),
  }),
  base: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
});
export type Pull = z.infer<typeof pullSchema>;

function wipPrefix(title: string): string | undefined {
  return WIP_PREFIXES.find(prefix => title.toUpperCase().startsWith(prefix));
}

/** Forgejo's own `draft` where it reports one; otherwise the title prefix it derives it from. */
function isDraft(pull: Pull): boolean {
  return pull.draft ?? wipPrefix(pull.title) !== undefined;
}

function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase() && namesRepo(left.path, right);
}

export function prRecord(repo: RepoRef, pull: Pull): ForgePrRecord {
  return forgePrRecordSchema.parse({
    schemaVersion: 1,
    repo,
    number: pull.number,
    url: pull.html_url,
    head: pull.head.label,
    base: pull.base.ref,
    is_draft: isDraft(pull),
    state: pull.merged ? 'merged' : pull.state,
    // The head repository lives on the same Forgejo, so it shares the host.
    head_repo: pull.head.repo ? { ...repo, path: pull.head.repo.full_name } : null,
    head_revision: pull.head.sha,
    base_revision: pull.base.sha,
    maintainer_can_modify: pull.allow_maintainer_edit ?? null,
  });
}

export async function readPull(api: ForgejoApi, ref: PrRef): Promise<Pull> {
  const pull = await request(
    api,
    repoUrl(api, ref.repo, `/pulls/${String(ref.number)}`),
    pullSchema
  );
  if (pull.number !== ref.number)
    throw new ForgejoError(
      { kind: 'invalid_response', message: 'Forgejo pull request read-back had another number' },
      true
    );
  return pull;
}

/** The one open pull request from `head` in `repo` into `base` (any base when omitted), if any. */
async function openPullForHead(
  api: ForgejoApi,
  repo: RepoRef,
  head: string,
  base: string | undefined
): Promise<Pull | undefined> {
  const matches = (await pages(api, repoUrl(api, repo, '/pulls?state=open'), pullSchema)).filter(
    pull =>
      pull.head.label === head &&
      pull.head.repo !== null &&
      namesRepo(pull.head.repo.full_name, repo) &&
      (base === undefined || pull.base.ref === base)
  );
  if (matches.length > 1)
    throw new ForgejoError(
      {
        kind: 'conflict',
        message: 'Pull request head selector matched more than one pull request',
      },
      true
    );
  return matches[0];
}

export async function viewPull(
  req: Extract<ForgeRequest, { op: 'pr.view' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const { selector } = req;
  const repo = selector.kind === 'number' ? selector.ref.repo : selector.repo;
  let pull: Pull | undefined;
  if (selector.kind === 'number') {
    pull = await readPull(api, selector.ref);
  } else {
    if (!sameRepo(selector.headRepo, selector.repo))
      throw invalidRequest(
        'The Forgejo plugin supports only pull requests from the same repository'
      );
    pull = await openPullForHead(api, selector.repo, selector.head, selector.base);
  }
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: pull
        ? {
            pr: prRecord(repo, pull),
            title: pull.title,
            body: pull.body,
            ...authorField(repo.host, pull.user),
            timestamps: {
              created_at: pull.created_at,
              merged_at: pull.merged_at,
              closed_at: pull.closed_at,
            },
          }
        : null,
    },
  };
}

export async function createPull(
  req: Extract<ForgeMutationRequest, { op: 'pr.create' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  if (!sameRepo(req.headRepo, req.repo))
    return refused(req, {
      kind: 'invalid_request',
      message: 'The Forgejo plugin supports only pull requests from the same repository',
    });
  // A title that already carries the prefix would open a draft that was not asked for.
  if (!req.draft && wipPrefix(req.title) !== undefined)
    return refused(req, {
      kind: 'invalid_request',
      message: 'A title beginning with a work-in-progress prefix would open a draft',
    });
  // The branch must still be at the commit the caller pushed, or the pull request
  // would open on work the caller has not seen.
  const head = await branchHead(api, req.repo, req.head);
  if (head !== req.headRevision)
    return refused(req, {
      kind: 'conflict',
      message: `Branch ${req.head} is at ${head}, not ${req.headRevision}`,
    });
  const existing = await openPullForHead(api, req.repo, req.head, undefined);
  if (existing)
    return refused(
      req,
      {
        kind: 'conflict',
        message: `Pull request ${String(existing.number)} is already open for ${req.head}`,
      },
      prRecord(req.repo, existing)
    );
  const title = req.draft && wipPrefix(req.title) === undefined ? `WIP: ${req.title}` : req.title;
  submit('submitted');
  const created = await request(
    api,
    repoUrl(api, req.repo, '/pulls'),
    pullSchema,
    {
      method: 'POST',
      body: JSON.stringify({ head: req.head, base: req.base, title, body: req.body }),
    },
    () => submit('acknowledged')
  );
  const leaveBehind = `pull request ${String(created.number)} may exist`;
  const observed = await readPull(api, { repo: req.repo, number: created.number });
  const pr = prRecord(req.repo, observed);
  if (
    observed.title !== title ||
    observed.body !== req.body ||
    pr.head !== req.head ||
    pr.head_revision !== req.headRevision ||
    pr.head_repo === null ||
    !sameRepo(pr.head_repo, req.headRepo) ||
    pr.base !== req.base ||
    pr.is_draft !== req.draft ||
    pr.state !== 'open'
  )
    return unverified(req, 'Created pull request did not match requested fields', leaveBehind, {
      pr,
    });
  return applied(req, { changed: true, pr });
}

export async function editPullBody(
  req: Extract<ForgeMutationRequest, { op: 'pr.edit-body' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const before = await readPull(api, req.ref);
  const bodyDigest = contentDigest(req.body);
  if (before.body === req.body)
    return applied(req, { changed: false, pr: prRecord(req.ref.repo, before), bodyDigest });
  submit('submitted');
  await request(
    api,
    repoUrl(api, req.ref.repo, `/pulls/${String(req.ref.number)}`),
    pullSchema,
    { method: 'PATCH', body: JSON.stringify({ body: req.body }) },
    () => submit('acknowledged')
  );
  const after = await readPull(api, req.ref);
  const pr = prRecord(req.ref.repo, after);
  return after.body === req.body
    ? applied(req, { changed: true, pr, bodyDigest })
    : unverified(
        req,
        'Pull request body read-back did not match',
        'the pull request body may have changed',
        { pr }
      );
}

/** `pr.draft` adds Forgejo's work-in-progress prefix to the title; `pr.ready` removes it. */
export async function setDraftState(
  req: Extract<ForgeMutationRequest, { op: 'pr.ready' | 'pr.draft' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const draft = req.op === 'pr.draft';
  const before = await readPull(api, req.ref);
  const record = prRecord(req.ref.repo, before);
  if (record.state !== 'open')
    return refused(
      req,
      { kind: 'conflict', message: `A ${record.state} pull request cannot change draft state` },
      record
    );
  if (record.is_draft === draft) return applied(req, { changed: false, pr: record });
  let title: string;
  if (draft) {
    title = `WIP: ${before.title}`;
  } else {
    const prefix = wipPrefix(before.title);
    // Forgejo's prefixes are configurable; one this plugin does not know cannot be removed safely.
    if (prefix === undefined)
      return refused(
        req,
        { kind: 'conflict', message: 'The draft title prefix is not one this plugin recognizes' },
        record
      );
    title = before.title.slice(prefix.length).trimStart();
  }
  submit('submitted');
  await request(
    api,
    repoUrl(api, req.ref.repo, `/pulls/${String(req.ref.number)}`),
    pullSchema,
    { method: 'PATCH', body: JSON.stringify({ title }) },
    () => submit('acknowledged')
  );
  const after = await readPull(api, req.ref);
  const pr = prRecord(req.ref.repo, after);
  return pr.state === 'open' && pr.is_draft === draft
    ? applied(req, { changed: true, pr })
    : unverified(
        req,
        `${req.op} read-back did not match`,
        'the pull request title may have changed',
        { pr }
      );
}
