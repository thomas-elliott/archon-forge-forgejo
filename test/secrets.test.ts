import { afterEach, beforeEach, expect, test } from 'bun:test';
import { FakeForgejo, TOKEN } from './fake-forgejo';

let fake: FakeForgejo;
beforeEach(() => {
  fake = new FakeForgejo().start();
});
afterEach(() => fake.stop());

const entry = new URL('../src/plugin.ts', import.meta.url).pathname;

/** Run the executable as Archon does, with the token in the environment and the fake as origin. */
async function run(request: object, token: string, forgejoUrl: string) {
  const child = Bun.spawn(['bun', entry, 'op', (request as { op: string }).op], {
    stdin: new TextEncoder().encode(JSON.stringify(request)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', ARCHON_FORGE_TOKEN: token, FORGEJO_URL: forgejoUrl },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return stdout + stderr;
}

test('the token never appears on stdout or stderr, whatever the outcome', async () => {
  fake.addLabel('bug');
  fake.addIssue();
  const repo = fake.repo;
  const outputs = await Promise.all([
    // Success, a write and its read-back.
    run(
      {
        operationId: 'a',
        op: 'workitem.label.add',
        subject: { kind: 'issue', ref: { repo, number: 1 } },
        name: 'bug',
      },
      TOKEN,
      fake.origin
    ),
    // A refusal.
    run(
      {
        operationId: 'b',
        op: 'workitem.label.add',
        subject: { kind: 'pr', ref: { repo, number: 1 } },
        name: 'bug',
      },
      TOKEN,
      fake.origin
    ),
    // Forgejo rejecting the token it was sent.
    run(
      { operationId: 'c', op: 'workitem.view', ref: { repo, number: 1 } },
      'rejected-token-5d1e',
      fake.origin
    ),
    // Nothing answering at all: port 1 on the loopback refuses the connection.
    run(
      {
        operationId: 'd',
        op: 'workitem.view',
        ref: { repo: { ...repo, host: '127.0.0.1:1' }, number: 1 },
      },
      TOKEN,
      'http://127.0.0.1:1'
    ),
  ]);
  expect(outputs[0]).toContain('"outcome":"applied"');
  expect(outputs[1]).toContain('"outcome":"refused"');
  expect(outputs[2]).toContain('"kind":"authorization"');
  expect(outputs[3]).toContain('"kind":"forge_error"');
  for (const output of outputs) {
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain('rejected-token-5d1e');
  }
});
