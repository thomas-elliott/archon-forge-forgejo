import { expect } from 'bun:test';
import {
  type ForgeRequest,
  forgeRequestSchema,
  forgeResponseSchema,
} from '@archon/forge/operations';
import { matchesForgeOperationResponse } from '@archon/forge/response-match';
import type { Fetch } from '../src/api';
import { handleOperation, metadata } from '../src/operations';
import { type FakeForgejo, TOKEN } from './fake-forgejo';

type Request = ForgeRequest extends infer R
  ? R extends ForgeRequest
    ? Omit<R, 'operationId'>
    : never
  : never;

let counter = 0;

/**
 * Run one operation against the fake Forgejo and check the response as the Archon
 * host does: it must parse, and it must answer the request that was sent.
 */
export async function call(
  fake: FakeForgejo,
  request: Request,
  fetch?: Fetch,
  woodpeckerConfig?: string
) {
  // Parsed as the executable parses stdin, so schema transforms apply.
  const sent = forgeRequestSchema.parse({ operationId: `op-${String(++counter)}`, ...request });
  const response = forgeResponseSchema.parse(
    await handleOperation(sent, { token: TOKEN, forgejoUrl: fake.origin, fetch, woodpeckerConfig })
  );
  expect(response.operationId).toBe(sent.operationId);
  expect(matchesForgeOperationResponse(sent, response, metadata, fake.host)).toBe(true);
  return response;
}

/** A fetch whose request reaches Forgejo but whose answer is lost, for the one call `lose` picks. */
export function losingAnswer(lose: (url: string, method: string) => boolean): Fetch {
  return async (url, init) => {
    const response = await fetch(url, init);
    if (lose(url, init?.method ?? 'GET')) throw new TypeError('socket closed');
    return response;
  };
}
