import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fetch } from '../src/api';
import { patchesByPath } from '../src/files';
import { FakeForgejo } from './fake-forgejo';
import { call } from './helpers';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const HEAD = 'c'.repeat(40);

/** What `git diff` prints for a change made by `edit` in a fresh repository, as Forgejo serves it. */
function gitDiff(setup: (dir: string) => void, edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-'));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      { cwd: dir }
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  try {
    git('init', '-q');
    setup(dir);
    git('add', '-A');
    git('commit', '-qm', 'base');
    edit(dir);
    git('add', '-A');
    return git('diff', '--cached', '-M', 'HEAD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('patchesByPath', () => {
  test("splits git's diff into each file's hunks, by the path a caller lists", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
    const diff = gitDiff(
      dir => {
        writeFileSync(join(dir, 'kept.ts'), 'a\n');
        writeFileSync(join(dir, 'gone.ts'), 'b\n');
        writeFileSync(join(dir, 'old name.ts'), `${lines}\n`);
        writeFileSync(join(dir, 'image.bin'), new Uint8Array([0, 1, 2]));
      },
      dir => {
        writeFileSync(join(dir, 'kept.ts'), 'a\n+++ b/not-a-header\n');
        rmSync(join(dir, 'gone.ts'));
        writeFileSync(join(dir, 'new file.ts'), 'c\n');
        rmSync(join(dir, 'old name.ts'));
        writeFileSync(join(dir, 'renamed.ts'), `${lines}\nmore\n`);
        writeFileSync(join(dir, 'image.bin'), new Uint8Array([3, 4, 5]));
        writeFileSync(join(dir, 'café.ts'), 'd\n');
      }
    );
    const patches = patchesByPath(diff);
    expect(patches.get('kept.ts')).toBe('@@ -1 +1,2 @@\n a\n++++ b/not-a-header');
    expect(patches.get('gone.ts')).toBe('@@ -1 +0,0 @@\n-b');
    expect(patches.get('new file.ts')).toBe('@@ -0,0 +1 @@\n+c');
    expect(patches.get('renamed.ts')).toContain('+more');
    // Binary changes have no hunks, and git quotes a non-ASCII path.
    expect([...patches.keys()].sort()).toEqual(['gone.ts', 'kept.ts', 'new file.ts', 'renamed.ts']);
  });
});

describe('pr.files', () => {
  test("lists the files with Forgejo's statuses mapped and each patch from the diff", async () => {
    fake.addPull({
      head: 'feature',
      headSha: HEAD,
      files: [
        { filename: 'src/a.ts', status: 'changed' },
        { filename: 'src/b.ts', status: 'deleted' },
        { filename: 'src/c.ts', status: 'renamed', previous_filename: 'src/old.ts' },
        { filename: 'logo.png', status: 'added' },
      ],
      diff: [
        'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n',
        'diff --git a/src/b.ts b/src/b.ts\ndeleted file mode 100644\nindex 1..0\n--- a/src/b.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n',
        'diff --git a/src/old.ts b/src/c.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/c.ts\n',
        'diff --git a/logo.png b/logo.png\nnew file mode 100644\nBinary files /dev/null and b/logo.png differ\n',
      ].join(''),
    });
    const response = await call(fake, { op: 'pr.files', ref: { repo: fake.repo, number: 1 } });
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          head_revision: HEAD,
          files: [
            {
              path: 'src/a.ts',
              previous_path: null,
              status: 'modified',
              patch: '@@ -1 +1 @@\n-x\n+y',
            },
            {
              path: 'src/b.ts',
              previous_path: null,
              status: 'removed',
              patch: '@@ -1 +0,0 @@\n-z',
            },
            { path: 'src/c.ts', previous_path: 'src/old.ts', status: 'renamed', patch: null },
            { path: 'logo.png', previous_path: null, status: 'added', patch: null },
          ],
        },
      },
    });
  });

  test('an answer that does not match the contract is invalid_response, not a refusal', async () => {
    fake.addPull({ head: 'feature', headSha: HEAD, files: [] });
    const wrongShape: Fetch = async (url, init) => {
      const response = await fetch(url, init);
      // `state` is required on a pull request; an answer without it is not the document asked for.
      if (url.includes('/pulls/1') && !url.includes('/files'))
        return Response.json({ number: 1, title: 'wrong shape' });
      return response;
    };
    const response = await call(
      fake,
      { op: 'pr.view', selector: { kind: 'number', ref: { repo: fake.repo, number: 1 } } },
      wrongShape
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  });

  test('fails rather than mixing two heads when a push lands during the read', async () => {
    const issue = fake.addPull({ head: 'feature', headSha: HEAD, files: [] });
    const pushDuringRead: Fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (url.includes('/files') && issue.pull) issue.pull.headSha = 'd'.repeat(40);
      return response;
    };
    const response = await call(
      fake,
      { op: 'pr.files', ref: { repo: fake.repo, number: 1 } },
      pushDuringRead
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'forge_error' } });
  });
});

describe('repo.file', () => {
  const read = (path: string) =>
    call(fake, { op: 'repo.file', repo: fake.repo, path, revision: HEAD });

  test("reads a file's text at the revision", async () => {
    fake.rawFiles.set(`${HEAD}:src/a b.ts`, 'export const a = 1;\n');
    expect(await read('src/a b.ts')).toMatchObject({
      ok: true,
      result: { value: { path: 'src/a b.ts', revision: HEAD, text: 'export const a = 1;\n' } },
    });
  });

  test('a missing file is not found, and a file that is not UTF-8 is refused', async () => {
    fake.rawFiles.set(`${HEAD}:logo.png`, new Uint8Array([0xff, 0xfe, 0x00]));
    expect(await read('missing.ts')).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(await read('logo.png')).toMatchObject({ ok: false, error: { kind: 'forge_error' } });
  });
});
