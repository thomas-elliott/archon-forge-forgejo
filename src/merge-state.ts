/**
 * How far a pull request's head is behind its repository's default branch, and
 * whether it merges.
 *
 * Forgejo reports `mergeable: false` both for a conflict and while it is still
 * checking the pull request, and its API says nothing more. So `true` is clean and
 * anything else is unknown: the plugin never reports a conflict it cannot tell apart.
 */

import type { ForgeRequest, ForgeResponse } from '@archon/forge/operations';
import { z } from 'zod';
import { branchHead, defaultBranch, type ForgejoApi, pages, repoUrl } from './api';
import { readPull } from './pulls';

const commitSchema = z.object({ sha: z.string().min(1) });

export async function pullMergeState(
  req: Extract<ForgeRequest, { op: 'pr.merge-state' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const { ref } = req;
  const pull = await readPull(api, ref);
  const branch = await defaultBranch(api, ref.repo);
  const defaultRevision = await branchHead(api, ref.repo, branch);
  // The default branch's commits that the head lacks.
  const missing = await pages(
    api,
    repoUrl(
      api,
      ref.repo,
      `/commits?sha=${defaultRevision}&not=${pull.head.sha}&stat=false&verification=false&files=false`
    ),
    commitSchema
  );
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: {
        ref,
        head_revision: pull.head.sha,
        default_branch: branch,
        default_revision: defaultRevision,
        behind: missing.length,
        mergeable: pull.mergeable === true ? 'clean' : 'unknown',
        merge_commit: pull.merged ? (pull.merge_commit_sha ?? null) : null,
      },
    },
  };
}
