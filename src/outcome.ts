/**
 * The outcome every write reports.
 *
 * A write submits at most one request and reads the result back before claiming
 * success. The outcome follows from how far that request got: nothing submitted
 * is a refusal, a submitted request whose answer was lost is unknown, and an
 * acknowledged write whose read-back disagrees is a verification failure that
 * says what may remain on the forge.
 *
 * `workitem.close` is the one exception: a reason label goes on before the close,
 * so it submits two requests and records the progress of each in turn.
 */

import {
  type ForgeCommentRecord,
  type ForgeError,
  type ForgeLabelRecord,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeResponse,
  type ForgeSubjectRecord,
  forgeResponseSchema,
  type landedSchema,
  mutationAttempt,
  mutationTarget,
} from '@archon/forge/operations';
import type { z } from 'zod';
import { errorDetail, ForgejoError } from './api';

/** Records how far a write got: submitted, then acknowledged by Forgejo. */
export type Submit = (phase: 'submitted' | 'acknowledged') => void;

function failure(request: ForgeMutationRequest, error: ForgeError, mutation: ForgeMutationFailure) {
  return { operationId: request.operationId, ok: false as const, error, mutation };
}

/**
 * What every failure names: the operation, its target and, for a merge, the method
 * and conditions it attempted. Archon reads a merge failure without them as an
 * unknown outcome.
 */
function evidenceBase(request: ForgeMutationRequest) {
  return { op: request.op, target: mutationTarget(request), ...mutationAttempt(request) };
}

export function refused(
  request: ForgeMutationRequest,
  error: ForgeError,
  observed?: ForgePrRecord
): ForgeResponse {
  return failure(request, error, {
    ...evidenceBase(request),
    outcome: 'refused',
    ...(observed ? { observed } : {}),
  });
}

function unknown(request: ForgeMutationRequest, error: ForgeError): ForgeResponse {
  return failure(request, error, {
    ...evidenceBase(request),
    outcome: 'outcome_unknown',
  });
}

export function unverified(
  request: ForgeMutationRequest,
  message: string,
  leaveBehind: string,
  observed: {
    pr?: ForgePrRecord;
    comment?: ForgeCommentRecord;
    workitem?: ForgeSubjectRecord;
    label?: ForgeLabelRecord;
    /** The commit a merge landed as, so far as the read-back showed it. */
    landed?: z.infer<typeof landedSchema>;
  } = {}
): ForgeResponse {
  const attempt = mutationAttempt(request);
  return failure(
    request,
    { kind: 'invalid_response', message },
    {
      op: request.op,
      target: mutationTarget(request),
      ...(attempt.merge && observed.landed
        ? { merge: { ...attempt.merge, landed: observed.landed } }
        : attempt),
      outcome: 'verification_failed',
      leaveBehind,
      ...(observed.pr ? { observed: observed.pr } : {}),
      ...(observed.comment ? { comment: observed.comment } : {}),
      ...(observed.workitem ? { workitem: observed.workitem } : {}),
      ...(observed.label ? { label: observed.label } : {}),
    }
  );
}

/** A confirmed write, validated against the protocol schema before it leaves the plugin. */
export function applied(request: ForgeMutationRequest, value: object): ForgeResponse {
  return forgeResponseSchema.parse({
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { target: mutationTarget(request), outcome: 'applied', ...value },
    },
  });
}

/**
 * Run one write and turn an escaped failure into the outcome its progress allows.
 * A handler returns its own outcome when it can say more, such as a read-back
 * that disagreed.
 */
export async function runMutation(
  request: ForgeMutationRequest,
  write: (submit: Submit) => Promise<ForgeResponse>
): Promise<ForgeResponse> {
  // An object, so the phase the callback records is not narrowed away at the catch.
  const progress: { phase: 'not_submitted' | 'submitted' | 'acknowledged' } = {
    phase: 'not_submitted',
  };
  try {
    return await write(next => {
      progress.phase = next;
    });
  } catch (cause) {
    const error = errorDetail(cause);
    const { phase } = progress;
    if (phase === 'acknowledged')
      return unverified(request, error.message, 'the acknowledged write may remain');
    if (phase === 'submitted' && !(cause instanceof ForgejoError && cause.definitiveRefusal))
      return unknown(request, error);
    return refused(request, error);
  }
}
