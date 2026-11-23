/**
 * A pull request's changed files, and one file's text at a commit.
 *
 * Forgejo's files listing has no patches, so each file's hunks are taken from the
 * pull request's diff. Both describe the head as it is when read, so the head is read
 * before and after them and must not have moved.
 */

import type { ForgeRequest, ForgeResponse, prFileSchema } from '@archon/forge/operations';
import { z } from 'zod';
import { type ForgejoApi, ForgejoError, pages, repoUrl, send } from './api';
import { readPull } from './pulls';

const STATUSES: Record<string, z.infer<typeof prFileSchema>['status']> = {
  added: 'added',
  deleted: 'removed',
  changed: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  unchanged: 'unchanged',
};

const changedFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().optional(),
  status: z.string().refine(status => status in STATUSES),
});

/**
 * Each file's hunks in a unified diff, keyed by its path after the change, or before
 * it for a removed file. Git quotes a path with unusual characters; such a file is
 * left out and reported with no patch rather than guessed at.
 */
export function patchesByPath(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const lines = section.split('\n');
    const hunk = lines.findIndex(line => line.startsWith('@@'));
    if (hunk === -1) continue;
    // The header comes before any hunk line that looks like it. Git ends a path holding a space with a tab.
    const after = lines.find(line => line.startsWith('+++ '))?.replace(/\t$/, '');
    const before = lines.find(line => line.startsWith('--- '))?.replace(/\t$/, '');
    const path =
      after === '+++ /dev/null'
        ? before?.startsWith('--- a/') && before.slice('--- a/'.length)
        : after?.startsWith('+++ b/') && after.slice('+++ b/'.length);
    if (!path) continue;
    patches.set(path, lines.slice(hunk).join('\n').replace(/\n$/, ''));
  }
  return patches;
}

export async function pullFiles(
  req: Extract<ForgeRequest, { op: 'pr.files' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const { ref } = req;
  const before = await readPull(api, ref);
  const listed = await pages(
    api,
    repoUrl(api, ref.repo, `/pulls/${String(ref.number)}/files`),
    changedFileSchema
  );
  const diff = await send(api, repoUrl(api, ref.repo, `/pulls/${String(ref.number)}.diff`));
  const patches = patchesByPath(await diff.text());
  const after = await readPull(api, ref);
  if (after.head.sha !== before.head.sha)
    throw new ForgejoError({
      kind: 'forge_error',
      message: `Pull request ${String(ref.number)}'s head moved from ${before.head.sha} to ${after.head.sha} while its files were read`,
    });
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: {
        ref,
        head_revision: before.head.sha,
        files: listed.map(file => ({
          path: file.filename,
          previous_path: file.previous_filename || null,
          status: STATUSES[file.status],
          patch: patches.get(file.filename) ?? null,
        })),
      },
    },
  };
}

export async function repoFile(
  req: Extract<ForgeRequest, { op: 'repo.file' }>,
  api: ForgejoApi
): Promise<ForgeResponse> {
  const path = req.path.split('/').map(encodeURIComponent).join('/');
  // Forgejo answers 404 for a directory, as for a missing file.
  const raw = await send(
    api,
    repoUrl(api, req.repo, `/raw/${path}?ref=${encodeURIComponent(req.revision)}`)
  );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await raw.arrayBuffer());
  } catch {
    throw new ForgejoError({
      kind: 'forge_error',
      message: `${req.path} at ${req.revision} is not UTF-8 text`,
    });
  }
  return {
    operationId: req.operationId,
    ok: true,
    result: {
      op: req.op,
      value: { repo: req.repo, path: req.path, revision: req.revision, text },
    },
  };
}
