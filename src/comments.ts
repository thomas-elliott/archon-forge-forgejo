/**
 * Conversation comments on an issue or pull request: the canonical marked comment,
 * written in place, and the read of every comment with its author.
 */

import type { PrRef } from '@archon/forge';
import {
  contentDigest,
  type ForgeCommentRecord,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import { z } from 'zod';
import { actor, userSchema } from './actor';
import { type ForgejoApi, ForgejoError, repoUrl, request, send, urlNamesItem } from './api';
import { applied, refused, type Submit, unverified } from './outcome';
import { firstLine, readIssue, subjectRecord } from './workitems';

const commentSchema = z.object({
  id: z.number().int(),
  html_url: z.url(),
  body: z.string(),
  user: userSchema.optional(),
});
type Comment = z.infer<typeof commentSchema>;

function commentRecord(ref: PrRef, comment: Comment): ForgeCommentRecord {
  return {
    ref,
    id: String(comment.id),
    url: comment.html_url,
    bodyDigest: contentDigest(comment.body),
  };
}

/**
 * Every comment on an item, oldest first. Forgejo does not page this listing, so
 * one call returns them all; a total larger than what came back would mean it
 * started to, and a partial list could hide the marked comment.
 */
async function listComments(api: ForgejoApi, ref: PrRef): Promise<Comment[]> {
  const response = await send(
    api,
    repoUrl(api, ref.repo, `/issues/${String(ref.number)}/comments`)
  );
  const comments = z.array(commentSchema).parse(await response.json());
  const total = Number(response.headers.get('x-total-count') ?? comments.length);
  if (total > comments.length)
    throw new ForgejoError(
      {
        kind: 'forge_error',
        message: `Forgejo returned ${String(comments.length)} of ${String(total)} comments`,
      },
      true
    );
  return comments;
}

export async function upsertComment(
  req: Extract<ForgeMutationRequest, { op: 'comment.upsert' | 'workitem.comment.upsert' }>,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  // The marker is how the canonical comment is found next time, so a body that does
  // not carry it would silently create a second report.
  if (firstLine(req.body) !== req.marker)
    return refused(req, {
      kind: 'invalid_request',
      message: 'Comment body must begin with the exact canonical marker',
    });
  const ref = req.op === 'comment.upsert' ? req.ref : req.subject.ref;
  // One endpoint serves issue and pull-request comments, so a subject's kind is
  // proved against the item before anything is written to it.
  const subject =
    req.op === 'workitem.comment.upsert'
      ? { workitem: subjectRecord(req.subject, await readIssue(api, ref)) }
      : {};
  const marked = (await listComments(api, ref)).filter(
    comment => firstLine(comment.body) === req.marker
  );
  if (marked.length > 1)
    return refused(req, {
      kind: 'conflict',
      message: 'Multiple comments on this item carry the canonical marker',
    });
  const previous = marked[0];
  // The listing is the read-back: the canonical comment already carries this body.
  if (previous && previous.body === req.body)
    return applied(req, { changed: false, ...subject, comment: commentRecord(ref, previous) });

  submit('submitted');
  const written = await request(
    api,
    previous
      ? repoUrl(api, ref.repo, `/issues/comments/${String(previous.id)}`)
      : repoUrl(api, ref.repo, `/issues/${String(ref.number)}/comments`),
    commentSchema,
    { method: previous ? 'PATCH' : 'POST', body: JSON.stringify({ body: req.body }) },
    () => submit('acknowledged')
  );
  const observed = await request(
    api,
    repoUrl(api, ref.repo, `/issues/comments/${String(written.id)}`),
    commentSchema
  );
  const comment = commentRecord(ref, observed);
  if (
    observed.id !== written.id ||
    !urlNamesItem(observed.html_url, ref.repo, ref.number) ||
    observed.body !== req.body
  )
    return unverified(
      req,
      'Comment read-back did not match',
      `comment ${String(written.id)} may have changed`,
      { ...subject, comment }
    );
  return applied(req, { changed: true, ...subject, comment });
}

export async function listWorkItemComments(
  req: Extract<ForgeRequest, { op: 'workitem.comments' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const { ref } = req.subject;
  // One endpoint serves issue and pull-request comments, so the kind is proved first.
  const workitem = subjectRecord(req.subject, await readIssue(api, ref));
  const comments = await listComments(api, ref);
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: {
        workitem,
        comments: comments.map(comment => ({
          id: String(comment.id),
          author: actor(ref.repo.host, comment.user ?? null),
          url: comment.html_url,
          body: comment.body,
        })),
      },
    },
  };
}
