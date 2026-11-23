/**
 * Checks on one commit, read from Forgejo's commit statuses (which Woodpecker
 * reports). `checks.state` reads them at a pull request's head, `checks.commit`
 * at a given revision or at the default branch's head.
 *
 * A status that links to a Woodpecker pipeline can be re-run. Its rerun identity is
 * its context, and its attempt the pipeline's number: Woodpecker re-runs a pipeline
 * as a new one with a higher number, which reports under the same contexts.
 */

import type { RepoRef } from '@archon/forge';
import {
  type CheckObservation,
  type ForgeRequest,
  type ForgeResponse,
  summarizeChecks,
} from '@archon/forge/operations';
import { z } from 'zod';
import { branchHead, defaultBranch, type ForgejoApi, pages, repoUrl } from './api';
import { readPull } from './pulls';

// Forgejo names the state `status`; `id` is the status's index on its commit.
const statusSchema = z.object({
  id: z.number().int(),
  context: z.string().min(1),
  status: z.string().min(1),
  target_url: z.string().nullish(),
});
export type Status = z.infer<typeof statusSchema>;

/** The Woodpecker pipeline a status links to: `{origin}/repos/{repo}/pipeline/{number}[/{workflow}]`. */
export function linkedPipeline(
  status: Status
): { origin: string; repo: number; number: number } | null {
  if (!status.target_url || !URL.canParse(status.target_url)) return null;
  const url = new URL(status.target_url);
  const match = /^\/repos\/([1-9]\d*)\/pipeline\/([1-9]\d*)(?:\/\d+)?\/?$/.exec(url.pathname);
  if (!match) return null;
  return { origin: url.origin, repo: Number(match[1]), number: Number(match[2]) };
}

/**
 * Forgejo's states: `pending` is pending, `success` green, `error` and `failure`
 * red. `warning` and anything else are unknown, with the native value kept.
 */
export function observation(status: Status): CheckObservation {
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
export async function latestStatuses(
  api: ForgejoApi,
  repo: RepoRef,
  revision: string
): Promise<Map<string, Status>> {
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
  return latest;
}

async function readCommitChecks(api: ForgejoApi, repo: RepoRef, revision: string) {
  const latest = await latestStatuses(api, repo, revision);
  const units = [...latest.values()].map(status => {
    const pipeline = linkedPipeline(status);
    return {
      ...observation(status),
      rerun: pipeline ? { id: status.context, attempt: pipeline.number } : null,
    };
  });
  // Forgejo says nothing about which checks are required or awaiting approval.
  return { units, summary: summarizeChecks(units), approvalPending: null };
}

export async function checksState(
  req: Extract<ForgeRequest, { op: 'checks.state' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const { ref } = req;
  const revision = (await readPull(api, ref)).head.sha;
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

export async function checksCommit(
  req: Extract<ForgeRequest, { op: 'checks.commit' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  let at: { branch: string | null; revision: string };
  if (req.at.kind === 'revision') {
    at = { branch: null, revision: req.at.revision };
  } else {
    const branch = await defaultBranch(api, req.repo);
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
