/**
 * Parse a git remote into a qualified repository.
 *
 * Any host is accepted: Archon sends `resolve` to this plugin only for a host its
 * config has claimed for it, so the plugin keeps no host list of its own.
 */

import { parseRemoteUrl, type RepoRef } from '@archon/forge';
import { invalidRequest, repositoryPath } from './api';

/**
 * The host the API lives on. An SSH remote's port is its transport, not the web port, so it is
 * dropped: Forgejo serves its API beside the web UI, which `ssh://git@host:2222/owner/repo.git`
 * says nothing about. An `http`/`https` remote's port is the web port, so it stays.
 */
function apiHost(url: URL, host: string): string {
  return url.protocol === 'ssh:' ? host.replace(/:\d+$/, '') : host;
}

function parseUrlRemote(value: string): RepoRef | null {
  let parsed: ReturnType<typeof parseRemoteUrl>;
  try {
    parsed = parseRemoteUrl(value);
  } catch {
    throw invalidRequest('Forgejo remote is not a valid URL');
  }
  const { url, host, pathname } = parsed;
  if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) return null;
  // An SSH user such as `git@` is transport identity; any other user or password is a credential.
  if (url.password !== '' || (url.protocol !== 'ssh:' && url.username !== ''))
    throw invalidRequest('Forgejo remote must not contain credentials');
  if (value.includes('?') || value.includes('#'))
    throw invalidRequest('Forgejo remote must not contain a query or fragment');
  const repository = repositoryPath(decodeURIComponent(pathname));
  if (!repository) return null;
  return { host: apiHost(url, host), path: `${repository.owner}/${repository.repo}` };
}

export function parseRemote(remote: string | null): RepoRef | null {
  const value = remote?.trim();
  if (!value) return null;
  if (value.includes('://')) return parseUrlRemote(value);

  // Git's scp-like form, `git@host:owner/repo.git`, has no scheme. Its optional user
  // is transport identity, not a credential, and is dropped here. A `user:password@`
  // prefix would otherwise parse as host `user` with the password in the path.
  if (/^[^@/:\s]+:[^@/\s]*@/.test(value))
    throw invalidRequest('Forgejo remote must not contain credentials');
  const match = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  if (!match) return null;
  const repository = repositoryPath(match[2]);
  if (!repository) return null;
  return { host: match[1].toLowerCase(), path: `${repository.owner}/${repository.repo}` };
}
