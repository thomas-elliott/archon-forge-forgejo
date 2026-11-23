/**
 * Review threads: `pr.threads` and `pr.thread.reply`.
 *
 * Forgejo has no thread object. It shows a conversation for the code comments of one
 * review on one line of one file, and a reply joins that review. So a thread here is
 * that group, named by its first comment's id, and a reply is a comment added to the
 * thread's review at the same line.
 *
 * Forgejo's API cannot resolve a conversation; only its web pages can. So the plugin
 * reads a thread as resolved when Forgejo names who resolved it, and does not serve
 * `pr.thread.resolve`. Nor does the API say whether a comment is outdated, so
 * `outdated` is always false.
 */

import type { PrRef } from '@archon/forge';
import {
  contentDigest,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type ForgeReviewThread,
} from '@archon/forge/operations';
import { z } from 'zod';
import { actor, userSchema } from './actor';
import { type ForgejoApi, pages, repoUrl, request } from './api';
import { applied, refused, type Submit, unverified } from './outcome';

const reviewSchema = z.object({ id: z.number().int(), state: z.string() });
// A comment on the new side of the diff has `position`, one on the old side
// `original_position`; the other is 0.
const reviewCommentSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  user: userSchema,
  resolver: userSchema,
  path: z.string(),
  position: z.number().int(),
  original_position: z.number().int(),
  extra_lines_count: z.number().int().default(0),
  html_url: z.url(),
  pull_request_review_id: z.number().int(),
});
type ReviewComment = z.infer<typeof reviewCommentSchema>;

interface Thread {
  review: number;
  comments: ReviewComment[];
}

function pullUrl(api: ForgejoApi, ref: PrRef, suffix: string): string {
  return repoUrl(api, ref.repo, `/pulls/${String(ref.number)}${suffix}`);
}

/** Every thread on the pull request, each oldest comment first, in the order they began. */
async function readThreads(api: ForgejoApi, ref: PrRef): Promise<Thread[]> {
  // A pending review is its author's draft, which nobody else sees yet.
  const reviews = (await pages(api, pullUrl(api, ref, '/reviews'), reviewSchema)).filter(
    review => review.state !== 'PENDING'
  );
  const threads = new Map<string, Thread>();
  for (const review of reviews) {
    const comments = await request(
      api,
      pullUrl(api, ref, `/reviews/${String(review.id)}/comments`),
      z.array(reviewCommentSchema)
    );
    // Forgejo lists a review's comments in no fixed order.
    for (const comment of comments.sort((left, right) => left.id - right.id)) {
      const line = comment.position || -comment.original_position;
      const key = JSON.stringify([review.id, comment.path, line, comment.extra_lines_count]);
      const thread = threads.get(key) ?? { review: review.id, comments: [] };
      thread.comments.push(comment);
      threads.set(key, thread);
    }
  }
  return [...threads.values()].sort((left, right) => left.comments[0].id - right.comments[0].id);
}

function threadRecord(host: string, thread: Thread): ForgeReviewThread {
  const [first] = thread.comments;
  return {
    id: String(first.id),
    resolved: thread.comments.some(comment => comment.resolver !== null),
    outdated: false,
    path: first.path,
    line: first.position || null,
    comments: thread.comments.map(comment => ({
      id: String(comment.id),
      author: actor(host, comment.user),
      body: comment.body,
      url: comment.html_url,
    })),
  };
}

export async function listThreads(
  req: Extract<ForgeRequest, { op: 'pr.threads' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const threads = await readThreads(api, req.ref);
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: {
        ref: req.ref,
        threads: threads.map(thread => threadRecord(req.ref.repo.host, thread)),
      },
    },
  };
}

export async function replyOnThread(
  req: Extract<ForgeMutationRequest, { op: 'pr.thread.reply' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const thread = (await readThreads(api, req.ref)).find(
    candidate => String(candidate.comments[0].id) === req.thread
  );
  if (!thread)
    return refused(req, {
      kind: 'not_found',
      message: `Pull request ${String(req.ref.number)} has no review thread ${req.thread}`,
    });
  const [first] = thread.comments;
  submit('submitted');
  const reply = await request(
    api,
    pullUrl(api, req.ref, `/reviews/${String(thread.review)}/comments`),
    reviewCommentSchema,
    {
      method: 'POST',
      body: JSON.stringify({
        body: req.body,
        path: first.path,
        new_position: first.position,
        old_position: first.original_position,
        extra_lines_count: first.extra_lines_count,
      }),
    },
    () => submit('acknowledged')
  );
  const comment = {
    ref: req.ref,
    id: String(reply.id),
    url: reply.html_url,
    bodyDigest: contentDigest(reply.body),
  };
  const joined =
    reply.pull_request_review_id === thread.review &&
    reply.path === first.path &&
    reply.position === first.position &&
    reply.original_position === first.original_position &&
    reply.extra_lines_count === first.extra_lines_count;
  if (reply.body !== req.body || !joined)
    return unverified(
      req,
      'Reply read-back did not match the thread',
      'a reply exists on the pull request',
      {
        comment,
      }
    );
  return applied(req, { changed: true, thread: req.thread, comment });
}
