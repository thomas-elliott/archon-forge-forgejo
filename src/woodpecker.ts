/**
 * The Woodpecker REST boundary, used only to re-run CI.
 *
 * Archon hands a plugin its forge token and nothing else, so Woodpecker's origin and
 * token come from a file in the home directory. The token is sent only to that origin.
 * Failures are `ForgejoError`s, so a write's outcome is judged the same way as Forgejo's.
 */

import { z } from 'zod';
import { type Fetch, ForgejoError, parseOrigin, responseError } from './api';

export interface WoodpeckerApi {
  readonly origin: string;
  readonly token: string;
  readonly fetch: Fetch;
}

const configSchema = z.object({ url: z.string(), token: z.string().min(1) });

/** Read `{"url": ..., "token": ...}` from `path`. */
export async function readWoodpeckerConfig(
  path: string | undefined,
  fetch: Fetch
): Promise<WoodpeckerApi> {
  const file = path === undefined ? undefined : Bun.file(path);
  if (!file || !(await file.exists()))
    throw new ForgejoError(
      {
        kind: 'no_credential',
        message: `Re-running checks needs Woodpecker's url and token in ${path ?? '~/.config/archon-forge-forgejo/woodpecker.json'}`,
      },
      true
    );
  let config: z.infer<typeof configSchema>;
  try {
    config = configSchema.parse(await file.json());
  } catch {
    throw new ForgejoError(
      { kind: 'invalid_request', message: `${path} must hold {"url": "...", "token": "..."}` },
      true
    );
  }
  return {
    origin: parseOrigin(config.url, 'The Woodpecker url').origin,
    token: config.token,
    fetch,
  };
}

/** One call to `/api{path}` whose answer is JSON, parsed by `schema`. */
export async function woodpeckerRequest<T>(
  woodpecker: WoodpeckerApi,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  acknowledge?: () => void
): Promise<T> {
  let response: Response;
  try {
    response = await woodpecker.fetch(`${woodpecker.origin}/api${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${woodpecker.token}`,
        'user-agent': 'archon-forge-forgejo',
      },
    });
  } catch (cause) {
    throw new ForgejoError(
      { kind: 'forge_error', message: 'Woodpecker API request failed' },
      false,
      {
        cause,
      }
    );
  }
  if (!response.ok) throw await responseError(response, 'Woodpecker');
  acknowledge?.();
  const body = schema.safeParse(await response.json().catch(() => undefined));
  if (!body.success)
    throw new ForgejoError({
      kind: 'forge_error',
      message: 'Woodpecker API response did not match its documented shape',
    });
  return body.data;
}
