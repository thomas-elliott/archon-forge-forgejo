/**
 * Closing an issue with a reason.
 *
 * Forgejo stores no reason for a close, so `not_planned` and `duplicate` are
 * recorded as the labels `closed/not_planned` and `closed/duplicate`. An issue
 * with neither label reads as `completed`, as an issue closed by hand does.
 */

import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { errorDetail, type ForgejoApi, ForgejoError, repoUrl, request } from './api';
import { existingLabel, postLabel } from './labels';
import { applied, refused, type Submit, unverified } from './outcome';
import { type Issue, issueRecord, issueSchema, labelNames, readIssue } from './workitems';

type CloseRequest = Extract<ForgeMutationRequest, { op: 'workitem.close' }>;
type CloseReason = CloseRequest['reason'];

const reasonLabels = {
  not_planned: 'closed/not_planned',
  duplicate: 'closed/duplicate',
} as const;

/** The close reason an issue's labels name, or undefined when it carries more than one. */
function labelledReason(item: Issue): CloseReason | undefined {
  const names = labelNames(item);
  const named = (['not_planned', 'duplicate'] as const).filter(reason =>
    names.includes(reasonLabels[reason])
  );
  if (named.length > 1) return undefined;
  return named[0] ?? 'completed';
}

function reasonText(reason: CloseReason | undefined): string {
  return reason ?? 'more than one reason';
}

/**
 * Close an issue and record why. The reason label goes on first and the close
 * second, so a retry after a failed close finds the label in place and only closes.
 */
export async function closeWorkItem(
  req: CloseRequest,
  api: ForgejoApi,
  submit: Submit
): Promise<ForgeResponse> {
  const { ref, reason } = req;
  const before = await readIssue(api, ref);
  const workitem = issueRecord(ref, before);
  const current = labelledReason(before);
  // A close never rewrites an earlier reason.
  if (before.state === 'closed')
    return current === reason
      ? applied(req, { changed: false, workitem, reason })
      : refused(req, {
          kind: 'conflict',
          message: `The issue is already closed as ${reasonText(current)}`,
        });
  // An open issue may still carry a reason label, from an earlier close it was reopened
  // after or an interrupted one. Closing it as another reason would read back wrongly.
  if (current !== 'completed' && current !== reason)
    return refused(req, {
      kind: 'conflict',
      message: `The open issue is labelled as closed for ${reasonText(current)}`,
    });

  const label = reason === 'completed' ? undefined : reasonLabels[reason];
  const addsLabel = label !== undefined && !labelNames(before).includes(label);
  if (addsLabel) {
    const { id } = await existingLabel(api, ref.repo, label);
    await postLabel(api, ref, id, submit);
  }
  submit('submitted');
  try {
    await request(
      api,
      repoUrl(api, ref.repo, `/issues/${String(ref.number)}`),
      issueSchema,
      { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) },
      () => submit('acknowledged')
    );
  } catch (cause) {
    // Forgejo refused the close, but the label written above stays, so this is not a
    // clean refusal. Any other failure escapes, and a lost answer reads as unknown.
    if (addsLabel && cause instanceof ForgejoError && cause.definitiveRefusal)
      return unverified(
        req,
        errorDetail(cause).message,
        `issue ${String(ref.number)} carries ${label} and is still open`
      );
    throw cause;
  }
  const after = await readIssue(api, ref);
  const observed = issueRecord(ref, after);
  return after.state === 'closed' && labelledReason(after) === reason
    ? applied(req, { changed: true, workitem: observed, reason })
    : unverified(req, 'Issue close read-back did not match', 'the issue may be closed', {
        workitem: observed,
      });
}
