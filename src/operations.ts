/** The plugin's metadata and the dispatch of one request to its handler. */

import {
  type ForgeError,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  isMutationRequest,
  type PluginMetadata,
} from '@archon/forge/operations';
import packageJson from '../package.json';
import { errorDetail, type Fetch, type ForgejoApi, parseOriginOverride } from './api';
import { checksCommit, checksState } from './checks';
import { closeWorkItem } from './close';
import { listWorkItemComments, upsertComment } from './comments';
import { addLabel, ensureLabel, listRepoLabels, removeLabel } from './labels';
import { mergePull } from './merge';
import { refused, runMutation, type Submit } from './outcome';
import { createPull, editPullBody, setDraftState, viewPull } from './pulls';
import { parseRemote } from './remote';
import { createWorkItem, editWorkItemBody, listWorkItems, viewWorkItem } from './workitems';

type ReadOp = Exclude<ForgeRequest['op'], 'resolve' | ForgeMutationRequest['op']>;
type ReadHandler<Op extends ReadOp> = (
  request: Extract<ForgeRequest, { op: Op }>,
  api: ForgejoApi
) => Promise<ForgeResponse>;
type MutationOp = ForgeMutationRequest['op'];
type MutationHandler<Op extends MutationOp> = (
  request: Extract<ForgeMutationRequest, { op: Op }>,
  api: ForgejoApi,
  submit: Submit
) => Promise<ForgeResponse>;

/** The reads this plugin serves. Its keys are advertised as capabilities. */
const reads: { [Op in ReadOp]?: ReadHandler<Op> } = {
  'workitem.list': listWorkItems,
  'workitem.view': viewWorkItem,
  'repo.labels.list': listRepoLabels,
  'workitem.comments': listWorkItemComments,
  'pr.view': viewPull,
  'checks.state': checksState,
  'checks.commit': checksCommit,
};

/** The writes this plugin serves. Its keys are advertised as capabilities. */
const writes: { [Op in MutationOp]?: MutationHandler<Op> } = {
  'repo.label.ensure': ensureLabel,
  'workitem.label.add': addLabel,
  'workitem.label.remove': removeLabel,
  'workitem.comment.upsert': upsertComment,
  'comment.upsert': upsertComment,
  'pr.create': createPull,
  'pr.edit-body': editPullBody,
  'pr.ready': setDraftState,
  'pr.draft': setDraftState,
  'pr.merge': mergePull,
  'workitem.create': createWorkItem,
  'workitem.edit-body': editWorkItemBody,
  'workitem.close': closeWorkItem,
};

export const metadata = {
  protocol: 1,
  name: 'forgejo',
  version: packageJson.version,
  forge: 'forgejo',
  // Every Forgejo is self-hosted, so the plugin claims no host. A user claims theirs
  // for this plugin in their Archon config's `forge.hosts`.
  hosts: [],
  capabilities: ['resolve', ...Object.keys(reads), ...Object.keys(writes)],
  // Archon refuses a merge before calling the plugin unless it declares the head condition.
  mutationConditions: { 'pr.merge': ['head'] },
  token_env: ['FORGEJO_TOKEN'],
} satisfies PluginMetadata;

export interface OperationOptions {
  readonly token: string | undefined;
  /** The raw `FORGEJO_URL` value, validated before any API call. */
  readonly forgejoUrl: string | undefined;
  readonly fetch?: Fetch;
}

function failure(request: ForgeRequest, error: ForgeError): ForgeResponse {
  // A write that never reached Forgejo is a refusal.
  return isMutationRequest(request)
    ? refused(request, error)
    : { operationId: request.operationId, ok: false, error };
}

function resolve(request: Extract<ForgeRequest, { op: 'resolve' }>): ForgeResponse {
  const repo = parseRemote(request.remote);
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'resolve',
      value: repo
        ? {
            kind: 'resolved',
            forge: metadata.forge,
            repo,
            plugin: { name: metadata.name, version: metadata.version },
          }
        : { kind: 'none', forge: 'none' },
    },
  };
}

export async function handleOperation(
  request: ForgeRequest,
  options: OperationOptions
): Promise<ForgeResponse> {
  try {
    // Resolution makes no network call, so it needs neither a token nor an origin.
    if (request.op === 'resolve') return resolve(request);

    const read = isMutationRequest(request) ? undefined : reads[request.op];
    const write = isMutationRequest(request) ? writes[request.op] : undefined;
    if (!read && !write)
      return failure(request, {
        kind: 'unsupported_op',
        message: `The Forgejo plugin does not support ${request.op}`,
      });
    if (!options.token)
      return failure(request, {
        kind: 'no_credential',
        message: 'ARCHON_FORGE_TOKEN is required for Forgejo operations',
      });
    const api: ForgejoApi = {
      token: options.token,
      fetch: options.fetch ?? globalThis.fetch,
      origin: parseOriginOverride(options.forgejoUrl),
    };
    // Each table is keyed by the request's own op, so its handler takes that request;
    // TypeScript cannot correlate a mapped table's members with the request union.
    if (write) {
      const mutation = request as ForgeMutationRequest;
      const handler = write as MutationHandler<MutationOp>;
      return await runMutation(mutation, submit => handler(mutation, api, submit));
    }
    return await (read as ReadHandler<ReadOp>)(
      request as Extract<ForgeRequest, { op: ReadOp }>,
      api
    );
  } catch (cause) {
    return failure(request, errorDetail(cause));
  }
}
