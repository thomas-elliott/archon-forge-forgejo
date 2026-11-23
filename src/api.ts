/** The Forgejo REST boundary: where a repository's API lives, how one call is made, and how a failure reads. */

import type { RepoRef } from '@archon/forge';
import type { ForgeError } from '@archon/forge/operations';
import { z } from 'zod';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What every call needs: the token, how to reach the network, and the optional origin override. */
export interface ForgejoApi {
  readonly token: string;
  readonly fetch: Fetch;
  /** A validated `FORGEJO_URL` origin, used only for the host it names. */
  readonly origin: URL | undefined;
}

export class ForgejoError extends Error {
  constructor(
    readonly detail: ForgeError,
    /**
     * Whether Forgejo decided against the request rather than losing it. A 4xx is
     * Forgejo's own answer, so nothing was written; anything else leaves a
     * submitted write's fate unknown.
     */
    readonly definitiveRefusal = false,
    options?: ErrorOptions
  ) {
    super(detail.message, options);
  }
}

export function invalidRequest(message: string): ForgejoError {
  return new ForgejoError({ kind: 'invalid_request', message }, true);
}

/** Parse `FORGEJO_URL`, which may be unset. */
export function parseOriginOverride(value: string | undefined): URL | undefined {
  if (value === undefined || value === '') return undefined;
  return parseOrigin(value, 'FORGEJO_URL');
}

/**
 * Parse a server's origin. Only a bare `http(s)://host[:port]` is accepted, because a
 * path, query or credential in it would silently change every API URL built from it.
 */
export function parseOrigin(value: string, name: string): URL {
  const message = `${name} must be a bare http(s)://host[:port] origin`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidRequest(message);
  }
  const bare =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    !value.includes('?') &&
    !value.includes('#');
  if (!bare) throw invalidRequest(message);
  return url;
}

/** The `owner` and `repo` segments of a repository path; anything else is refused. */
export function repositoryPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  if ([owner, repo].some(part => part === '' || part === '.' || part === '..')) return null;
  return { owner, repo };
}

/** The host a request addresses: a `hostClaim` marks an HTTPS `:443` authority claimed as the bare host. */
function requestedHost(repo: RepoRef): string {
  const host = repo.host.toLowerCase();
  return repo.hostClaim ? host.slice(0, -':443'.length) : host;
}

function apiOrigin(api: ForgejoApi, repo: RepoRef): string {
  const host = requestedHost(repo);
  // URL.host drops a default port, so `https://example:443` and `example` compare equal here.
  if (api.origin && api.origin.host === new URL(`${api.origin.protocol}//${host}`).host)
    return api.origin.origin;
  return `https://${host}`;
}

function ownerAndName(repo: RepoRef): { owner: string; repo: string } {
  const parsed = repositoryPath(repo.path);
  if (!parsed) throw invalidRequest(`Invalid Forgejo repository path: ${repo.path}`);
  return parsed;
}

/** Whether Forgejo's `full_name` names `repo`; Forgejo echoes its registered case, whatever case the request carried. */
export function namesRepo(fullName: string, repo: RepoRef): boolean {
  return fullName.toLowerCase() === repo.path.toLowerCase();
}

/** `https://host/api/v1/repos/{owner}/{repo}` followed by `suffix`. */
export function repoUrl(api: ForgejoApi, repo: RepoRef, suffix = ''): string {
  const parsed = ownerAndName(repo);
  return `${apiOrigin(api, repo)}/api/v1/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}${suffix}`;
}

/** The organization labels endpoint for the repository's owner. */
export function ownerLabelsUrl(api: ForgejoApi, repo: RepoRef): string {
  return `${apiOrigin(api, repo)}/api/v1/orgs/${encodeURIComponent(ownerAndName(repo).owner)}/labels`;
}

/** A branch name as path segments; Forgejo routes a branch with slashes by its raw segments. */
function branchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

const errorBodySchema = z.object({ message: z.string().min(1) });

/** A failed answer from Forgejo, or from Woodpecker when the plugin re-runs CI. */
export async function responseError(
  response: Response,
  server: 'Forgejo' | 'Woodpecker' = 'Forgejo'
): Promise<ForgejoError> {
  const status = response.status;
  let reason = '';
  try {
    const body = errorBodySchema.safeParse(await response.json());
    if (body.success) reason = `: ${body.data.message}`;
  } catch {
    // No JSON body; the status alone describes the failure.
  }
  const kind =
    status === 404
      ? 'not_found'
      : status === 401 || status === 403
        ? 'authorization'
        : status === 409 || status === 422
          ? 'conflict'
          : 'forge_error';
  return new ForgejoError(
    { kind, message: `${server} API request failed with HTTP ${String(status)}${reason}`, status },
    status >= 400 && status < 500
  );
}

/**
 * One Forgejo API call, returning the successful response.
 *
 * `acknowledge` runs once Forgejo has answered with a success status, which is
 * the moment a write stops being merely submitted and becomes one whose effect
 * must be verified rather than guessed at.
 */
export async function send(
  api: ForgejoApi,
  url: string,
  init: RequestInit = {},
  acknowledge?: () => void
): Promise<Response> {
  let response: Response;
  try {
    response = await api.fetch(url, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `token ${api.token}`,
        'content-type': 'application/json',
        'user-agent': 'archon-forge-forgejo',
      },
    });
  } catch (cause) {
    throw new ForgejoError({ kind: 'forge_error', message: 'Forgejo API request failed' }, false, {
      cause,
    });
  }
  if (!response.ok) throw await responseError(response);
  acknowledge?.();
  return response;
}

/** One call whose answer is JSON, parsed by `schema`. */
export async function request<T>(
  api: ForgejoApi,
  url: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  acknowledge?: () => void
): Promise<T> {
  const response = await send(api, url, init, acknowledge);
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ForgejoError(
      { kind: 'forge_error', message: 'Forgejo API returned invalid JSON' },
      false,
      { cause }
    );
  }
  return schema.parse(body);
}

const PAGE_LIMIT = 50;

/**
 * Every row of a listing, following pages.
 *
 * Forgejo reports the full count in `X-Total-Count`, which also covers a server
 * whose page size is capped below the one asked for. Without the header a short
 * page ends the listing. A page longer than asked for means the endpoint ignores
 * paging and has already returned everything; asking for the next page would
 * only repeat it.
 */
export async function pages<T>(api: ForgejoApi, url: string, row: z.ZodType<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await send(
      api,
      `${url}${separator}limit=${String(PAGE_LIMIT)}&page=${String(page)}`
    );
    const values = z.array(row).parse(await response.json());
    rows.push(...values);
    const total = Number(response.headers.get('x-total-count') ?? Number.NaN);
    if (values.length === 0 || values.length > PAGE_LIMIT) return rows;
    if (Number.isInteger(total) ? rows.length >= total : values.length < PAGE_LIMIT) return rows;
  }
}

/** Translate a thrown cause into the wire error a caller can act on. */
export function errorDetail(cause: unknown): ForgeError {
  if (cause instanceof ForgejoError) return cause.detail;
  if (cause instanceof z.ZodError) {
    return {
      kind: 'forge_error',
      message: `Forgejo API response did not match its documented shape: ${cause.issues[0]?.message ?? 'invalid response'}`,
    };
  }
  return { kind: 'forge_error', message: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * Whether a web URL names `owner/repo` item `number` as an issue or pull request
 * page. Only the path's end is compared: Forgejo builds the URL from its own root,
 * which may carry a prefix or differ from a `FORGEJO_URL` override.
 */
export function urlNamesItem(url: string, repo: RepoRef, number: number): boolean {
  const path = new URL(url).pathname.toLowerCase();
  const item = `/${repo.path.toLowerCase()}`;
  return [`${item}/issues/${String(number)}`, `${item}/pulls/${String(number)}`].some(suffix =>
    path.endsWith(suffix)
  );
}

const repositorySchema = z.object({ default_branch: z.string().min(1) });

export async function defaultBranch(api: ForgejoApi, repo: RepoRef): Promise<string> {
  return (await request(api, repoUrl(api, repo), repositorySchema)).default_branch;
}

const branchSchema = z.object({ commit: z.object({ id: z.string().min(1) }) });

/** The commit a branch points at. */
export async function branchHead(api: ForgejoApi, repo: RepoRef, branch: string): Promise<string> {
  const found = await request(
    api,
    repoUrl(api, repo, `/branches/${branchPath(branch)}`),
    branchSchema
  );
  return found.commit.id;
}
