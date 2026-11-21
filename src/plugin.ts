#!/usr/bin/env bun
/**
 * The executable Archon runs: `archon-forge-forgejo metadata` prints the metadata,
 * and `archon-forge-forgejo op <operation>` answers one JSON request on stdin with
 * one JSON response on stdout. Exit 0 carries a success, exit 1 a failure.
 */

import { type ForgeResponse, forgeRequestSchema } from '@archon/forge/operations';
import { handleOperation, metadata } from './operations';

function invalidRequest(operationId: string, message: string): ForgeResponse {
  return { operationId, ok: false, error: { kind: 'invalid_request', message } };
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runPlugin(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === 'metadata') {
    write(metadata);
    return 0;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.stdin.text());
  } catch {
    write(invalidRequest('invalid', 'stdin must contain one UTF-8 JSON request'));
    return 1;
  }
  const operationId =
    typeof raw === 'object' &&
    raw !== null &&
    'operationId' in raw &&
    typeof raw.operationId === 'string' &&
    raw.operationId !== ''
      ? raw.operationId
      : 'invalid';
  const request = forgeRequestSchema.safeParse(raw);
  if (!request.success) {
    write(invalidRequest(operationId, 'stdin does not match the forge request schema'));
    return 1;
  }
  if (args.length !== 2 || args[0] !== 'op' || args[1] !== request.data.op) {
    write(invalidRequest(operationId, `expected executable arguments: op ${request.data.op}`));
    return 1;
  }

  // The token comes from this variable only, never from arguments, the request or a remote.
  const response = await handleOperation(request.data, {
    token: process.env.ARCHON_FORGE_TOKEN,
    forgejoUrl: process.env.FORGEJO_URL,
  });
  write(response);
  return response.ok ? 0 : 1;
}

process.exitCode = await runPlugin(process.argv.slice(2));
