/**
 * Merging a pull request at the head the caller approved, with the commit it
 * landed as for evidence.
 *
 * The head is checked twice: once by reading the pull request before writing,
 * and again by Forgejo itself through `head_commit_id`, so a push between the
 * read and the merge is refused rather than merged.
 */

import type { ForgeError, ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { z } from 'zod';
import { type ForgejoApi, ForgejoError, repoUrl, request, send } from './api';
import { applied, refused, type Submit, unverified } from './outcome';
import { type Pull, prRecord, readPull } from './pulls';

// Forgejo's commit API puts the commit's own id in `commit.tree.sha`, not its tree's,
// so the tree is never read from it and is always reported as unknown.
const commitSchema = z.object({
  sha: z.string().min(1),
  parents: z.array(z.object({ sha: z.string().min(1) })),
});

export async function mergePull(
  req: Extract<ForgeMutationRequest, { op: 'pr.merge' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const head = req.conditions.head;
  if (!head)
    return refused(req, {
      kind: 'invalid_request',
      message: 'A merge requires the approved head condition',
    });
  // Archon refuses these before calling, since the metadata declares only `head`.
  if (Object.keys(req.conditions).some(key => key !== 'head'))
    return refused(req, {
      kind: 'unsupported_op',
      message: 'The Forgejo plugin enforces only the head merge condition',
    });

  const before = prRecord(req.ref.repo, await readPull(api, req.ref));
  // A merged pull request is refused too, as GitHub's plugin does: Archon's applied
  // merge result always reports a merge this call made.
  const reason =
    before.head_revision !== head
      ? `Pull request head is ${before.head_revision ?? 'unknown'}, not ${head}`
      : before.state !== 'open'
        ? `Pull request is ${before.state}`
        : before.is_draft
          ? 'Pull request is a draft'
          : undefined;
  if (reason) return refused(req, { kind: 'conflict', message: reason }, before);

  submit('submitted');
  let answer: ForgejoError | undefined;
  try {
    await send(
      api,
      repoUrl(api, req.ref.repo, `/pulls/${String(req.ref.number)}/merge`),
      {
        method: 'POST',
        body: JSON.stringify({
          Do: req.method,
          head_commit_id: head,
          delete_branch_after_merge: true,
        }),
      },
      () => submit('acknowledged')
    );
  } catch (cause) {
    if (!(cause instanceof ForgejoError && cause.detail.status !== undefined)) throw cause;
    // An error status does not prove nothing merged: when deleting the branch fails,
    // Forgejo answers 403 or 500 after it has merged. The read below decides.
    answer = cause;
  }

  const after = await readPull(api, req.ref);
  const pr = prRecord(req.ref.repo, after);
  if (answer && !after.merged) {
    if (!answer.definitiveRefusal) throw answer;
    return refused(req, refusal(answer, after), pr);
  }
  const commit = after.merge_commit_sha ?? null;
  if (pr.state !== 'merged' || pr.head_revision !== head || commit === null)
    return unverified(
      req,
      'Merged pull request read-back did not match',
      'the pull request may be merged',
      { pr, landed: { commit, tree: null, parents: null } }
    );

  // The parents are supplementary: the merge is proven without them.
  let parents: string[] | null = null;
  try {
    const landed = await request(
      api,
      repoUrl(
        api,
        req.ref.repo,
        `/git/commits/${encodeURIComponent(commit)}?stat=false&verification=false&files=false`
      ),
      commitSchema
    );
    if (landed.sha !== commit)
      return unverified(req, 'Landed commit identity did not match', 'the pull request is merged', {
        pr,
        landed: { commit, tree: null, parents: null },
      });
    parents = landed.parents.map(parent => parent.sha);
  } catch {
    // Left null, as the protocol allows for unavailable parents.
  }
  return applied(req, {
    changed: true,
    pr,
    method: req.method,
    conditions: req.conditions,
    enforcedConditions: ['head'],
    landed: { commit, tree: null, parents },
  });
}

/**
 * Forgejo's refusal, kept with its message. Forgejo answers 405 when the pull request
 * cannot be merged as it stands, such as when branch protection blocks it. That is a
 * failed precondition, not a forge fault.
 */
function refusal(answer: ForgejoError, pull: Pull): ForgeError {
  if (answer.detail.status !== 405) return answer.detail;
  // For a conflict Forgejo says only "Please try again later", so the reason is added.
  const note =
    pull.mergeable === false
      ? '. Forgejo has not found the pull request mergeable: it conflicts with its base branch, or Forgejo is still checking it'
      : '';
  return { ...answer.detail, kind: 'conflict', message: `${answer.detail.message}${note}` };
}
