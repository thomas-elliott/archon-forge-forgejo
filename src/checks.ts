/**
 * Checks on one commit, read from Forgejo's commit statuses (which Woodpecker
 * reports). `checks.state` reads them at a pull request's head, `checks.commit`
 * at a given revision or at the default branch's head.
 */

import type { RepoRef } from '@archon/forge';
import {
  type CheckObservation,
  type ForgeRequest,
  type ForgeResponse,
  summarizeChecks,
} from '@archon/forge/operations';
import { z } from 'zod';
import { branchHead, type ForgejoApi, pages, repoUrl, request } from './api';

// Forgejo names the state `status`; `id` is the status's index on its commit.
const statusSchema = z.object({
  id: z.number().int(),
  context: z.string().min(1),
  status: z.string().min(1),
});
type Status = z.infer<typeof statusSchema>;

/**
 * Forgejo's states: `pending` is pending, `success` green, `error` and `failure`
 * red. `warning` and anything else are unknown, with the native value kept.
 */
function observation(status: Status): CheckObservation {
  const unit = { kind: 'commit_status' as const, id: String(status.id), name: status.context };
  const native = { unit, nativeState: status.status, nativeResult: status.status };
  switch (status.status) {
    case 'pending':
      return { ...native, phase: 'pending', result: null, state: 'pending' };
    case 'success':
      return { ...native, phase: 'completed', result: 'success', state: 'green' };
    case 'error':
    case 'failure':
      return { ...native, phase: 'completed', result: 'failure', state: 'red' };
    case 'warning':
      return { ...native, phase: 'completed', result: 'unknown', state: 'unknown' };
    default:
      return { ...native, phase: 'unknown', result: 'unknown', state: 'unknown' };
  }
}

/** The latest status of each context on `revision`; a later status has a higher id. */
async function readCommitChecks(api: ForgejoApi, repo: RepoRef, revision: string) {
  const statuses = await pages(
    api,
    repoUrl(api, repo, `/commits/${encodeURIComponent(revision)}/statuses`),
    statusSchema
  );
  const latest = new Map<string, Status>();
  for (const status of statuses) {
    const seen = latest.get(status.context);
    if (!seen || status.id > seen.id) latest.set(status.context, status);
  }
  const units = [...latest.values()].map(status => ({ ...observation(status), rerun: null }));
  // Forgejo says nothing about which checks are required or awaiting approval.
  return { units, summary: summarizeChecks(units), approvalPending: null };
}

const pullHeadSchema = z.object({ head: z.object({ sha: z.string().min(1) }) });

export async function checksState(
  req: Extract<ForgeRequest, { op: 'checks.state' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const { ref } = req;
  const pull = await request(
    api,
    repoUrl(api, ref.repo, `/pulls/${String(ref.number)}`),
    pullHeadSchema
  );
  const revision = pull.head.sha;
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: {
        ref,
        revision,
        ...(await readCommitChecks(api, ref.repo, revision)),
        required: null,
      },
    },
  };
}

const repositorySchema = z.object({ default_branch: z.string().min(1) });

export async function checksCommit(
  req: Extract<ForgeRequest, { op: 'checks.commit' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  let at: { branch: string | null; revision: string };
  if (req.at.kind === 'revision') {
    at = { branch: null, revision: req.at.revision };
  } else {
    const { default_branch: branch } = await request(api, repoUrl(api, req.repo), repositorySchema);
    at = { branch, revision: await branchHead(api, req.repo, branch) };
  }
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: { repo: req.repo, ...at, ...(await readCommitChecks(api, req.repo, at.revision)) },
    },
  };
}
