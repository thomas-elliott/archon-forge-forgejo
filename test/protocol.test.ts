import { describe, expect, test } from 'bun:test';
import { forgeResponseSchema, pluginMetadataSchema } from '@archon/forge/operations';
import { repoUrl } from '../src/api';
import { handleOperation } from '../src/operations';

const entry = new URL('../src/plugin.ts', import.meta.url).pathname;

/** Run the executable as Archon does: arguments, one JSON request on stdin, no inherited token. */
function runPlugin(args: string[], stdin = '', env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bun', entry, ...args], {
    stdin: new TextEncoder().encode(stdin),
    env: { PATH: process.env.PATH ?? '', ARCHON_FORGE_TOKEN: '', FORGEJO_URL: '', ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('executable', () => {
  test('metadata advertises exactly the supported operations, the head merge condition and no host', () => {
    const { exitCode, stdout } = runPlugin(['metadata']);
    expect(exitCode).toBe(0);
    const metadata = pluginMetadataSchema.parse(JSON.parse(stdout));
    expect(metadata).toMatchObject({
      protocol: 1,
      name: 'forgejo',
      forge: 'forgejo',
      hosts: [],
      mutationConditions: { 'pr.merge': ['head'] },
      token_env: ['FORGEJO_TOKEN'],
    });
    expect([...metadata.capabilities].sort()).toEqual(
      [
        'resolve',
        'workitem.list',
        'workitem.view',
        'workitem.label.add',
        'workitem.label.remove',
        'workitem.comment.upsert',
        'pr.view',
        'pr.create',
        'repo.labels.list',
        'repo.label.ensure',
        'comment.upsert',
        'pr.edit-body',
        'pr.ready',
        'pr.draft',
        'pr.merge',
        'workitem.comments',
        'workitem.edit-body',
        'workitem.close',
        'workitem.create',
        'checks.state',
        'checks.commit',
        'checks.rerun',
        'pr.merge-state',
        'pr.files',
        'repo.file',
        'pr.threads',
        'pr.thread.reply',
      ].sort()
    );
  });

  test('an operation answers on stdout with the request operationId and exit 0', () => {
    const { exitCode, stdout } = runPlugin(
      ['op', 'resolve'],
      JSON.stringify({
        operationId: 'op-1',
        op: 'resolve',
        remote: 'https://forgejo.example.com/owner/repo.git',
      })
    );
    expect(exitCode).toBe(0);
    expect(forgeResponseSchema.parse(JSON.parse(stdout))).toMatchObject({
      operationId: 'op-1',
      ok: true,
    });
  });

  test('arguments that disagree with the request are refused with exit 1', () => {
    const { exitCode, stdout } = runPlugin(
      ['op', 'workitem.view'],
      JSON.stringify({ operationId: 'op-2', op: 'resolve', remote: null })
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      operationId: 'op-2',
      ok: false,
      error: { kind: 'invalid_request' },
    });
  });

  test('stdin that is not JSON is refused with exit 1', () => {
    const { exitCode, stdout } = runPlugin(['op', 'resolve'], 'not json');
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });

  test('a read without a token fails before any network call', () => {
    const { exitCode, stdout } = runPlugin(
      ['op', 'workitem.view'],
      JSON.stringify({
        operationId: 'op-3',
        op: 'workitem.view',
        ref: { repo: { host: 'forgejo.example.com', path: 'owner/repo' }, number: 1 },
      })
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
  });
});

describe('resolve', () => {
  async function resolve(remote: string | null) {
    return handleOperation(
      { operationId: 'resolve-1', op: 'resolve', remote },
      { token: undefined, forgejoUrl: undefined }
    );
  }
  const resolved = (host: string) => ({
    ok: true,
    result: {
      op: 'resolve',
      value: {
        kind: 'resolved',
        forge: 'forgejo',
        repo: { host, path: 'owner/repo' },
        plugin: { name: 'forgejo' },
      },
    },
  });

  test.each([
    ['https://forgejo.example.com/owner/repo.git', 'forgejo.example.com'],
    ['https://forgejo.example.com/owner/repo', 'forgejo.example.com'],
    ['http://forgejo.example.com:3000/owner/repo.git', 'forgejo.example.com:3000'],
    ['ssh://git@forgejo.example.com/owner/repo.git', 'forgejo.example.com'],
    ['ssh://git@forgejo.example.com:2222/owner/repo.git', 'forgejo.example.com'],
    ['git@forgejo.example.com:owner/repo.git', 'forgejo.example.com'],
  ])('%s resolves to %s', async (remote, host) => {
    expect(await resolve(remote)).toMatchObject(resolved(host));
  });

  test('an SSH port is transport, so it is not part of the resolved host', async () => {
    // The API is served beside the web UI, at a port the SSH remote says nothing about.
    expect(await resolve('ssh://git@forgejo.example.com:2222/owner/repo.git')).toMatchObject(
      resolved('forgejo.example.com')
    );
  });

  test.each([
    'https://user:secret@forgejo.example.com/owner/repo.git',
    'https://secret@forgejo.example.com/owner/repo.git',
    'ssh://git:secret@forgejo.example.com/owner/repo.git',
    'user:secret@forgejo.example.com:owner/repo.git',
    'https://forgejo.example.com/owner/repo.git?token=secret',
    'https://forgejo.example.com/owner/repo.git#fragment',
  ])('%s is refused', async remote => {
    expect(await resolve(remote)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
    });
  });

  test.each([
    null,
    '',
    '/home/user/repo',
    'file:///home/user/repo',
    'https://forgejo.example.com/owner',
    'https://forgejo.example.com/owner/repo/extra',
  ])('%p resolves to none', async remote => {
    expect(await resolve(remote)).toMatchObject({
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
  });
});

// Archon passes no FORGEJO_URL, so this default origin is the only one a real run uses.
describe('API URL without an origin override', () => {
  const api = { token: 'unused', fetch, origin: undefined };
  const expected = 'https://forgejo.example.com/api/v1/repos/owner/repo/issues';

  test('a plain host is reached over HTTPS', () => {
    expect(repoUrl(api, { host: 'forgejo.example.com', path: 'owner/repo' }, '/issues')).toBe(
      expected
    );
  });

  test('a host claimed as its bare name drops the :443 Archon added', () => {
    const repo = { host: 'forgejo.example.com:443', path: 'owner/repo', hostClaim: true as const };
    expect(repoUrl(api, repo, '/issues')).toBe(expected);
  });
});
