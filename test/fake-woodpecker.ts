/**
 * An in-memory Woodpecker 3 serving the calls the plugin makes to re-run CI: reading a
 * repository and a pipeline, and restarting a pipeline as a new one whose `parent` is
 * the old one's number, as Woodpecker does.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedRequest } from './fake-forgejo';

export const WOODPECKER_TOKEN = 'fake-woodpecker-token-8d41e0';

export interface Pipeline {
  number: number;
  parent: number;
  commit: string;
  status: string;
}

export class FakeWoodpecker {
  readonly requests: RecordedRequest[] = [];
  repos = new Map<number, string>();
  pipelines = new Map<number, Pipeline[]>();
  /** Runs when a restart is accepted, so a test can post the new pipeline's statuses. */
  onRestart: (repo: number, pipeline: Pipeline) => void = () => {};
  /** Woodpecker's answer to the next restart instead of a new pipeline. */
  restartRefusal: { status: number; message: string } | null = null;
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): this {
    this.server = Bun.serve({ port: 0, fetch: request => this.handle(request) });
    return this;
  }
  stop(): void {
    this.server?.stop(true);
  }
  get origin(): string {
    if (!this.server) throw new Error('fake Woodpecker is not started');
    return `http://127.0.0.1:${String(this.server.port)}`;
  }
  get restarts(): RecordedRequest[] {
    return this.requests.filter(request => request.method === 'POST');
  }

  /** A config file naming this Woodpecker, as the plugin reads it from the home directory. */
  configFile(): string {
    const path = join(mkdtempSync(join(tmpdir(), 'woodpecker-')), 'woodpecker.json');
    writeFileSync(path, JSON.stringify({ url: this.origin, token: WOODPECKER_TOKEN }));
    return path;
  }
  addRepo(id: number, fullName: string): void {
    this.repos.set(id, fullName);
  }
  addPipeline(repo: number, pipeline: Omit<Pipeline, 'parent'>): Pipeline {
    const added = { parent: 0, ...pipeline };
    this.pipelines.set(repo, [...(this.pipelines.get(repo) ?? []), added]);
    return added;
  }
  /** The URL Woodpecker puts in a workflow's commit status. */
  statusUrl(repo: number, pipeline: number, workflow = 1): string {
    return `${this.origin}/repos/${String(repo)}/pipeline/${String(pipeline)}/${String(workflow)}`;
  }

  private handle(request: Request): Response {
    const url = new URL(request.url);
    this.requests.push({ method: request.method, path: url.pathname + url.search });
    if (request.headers.get('authorization') !== `Bearer ${WOODPECKER_TOKEN}`)
      return new Response('Unauthorized', { status: 401 });
    const notFound = new Response('Not Found', { status: 404 });

    let match = /^\/api\/repos\/(\d+)$/.exec(url.pathname);
    if (match && request.method === 'GET') {
      const fullName = this.repos.get(Number(match[1]));
      return fullName ? Response.json({ id: Number(match[1]), full_name: fullName }) : notFound;
    }
    match = /^\/api\/repos\/(\d+)\/pipelines\/(\d+)$/.exec(url.pathname);
    if (!match) return notFound;
    const repo = Number(match[1]);
    const pipelines = this.pipelines.get(repo) ?? [];
    const pipeline = pipelines.find(candidate => candidate.number === Number(match?.[2]));
    if (!pipeline) return notFound;
    if (request.method === 'GET') return Response.json(pipeline);
    if (request.method !== 'POST') return notFound;
    if (this.restartRefusal) {
      const { status, message } = this.restartRefusal;
      this.restartRefusal = null;
      return new Response(message, { status });
    }
    const restarted = this.addPipeline(repo, {
      number: Math.max(...pipelines.map(candidate => candidate.number)) + 1,
      commit: pipeline.commit,
      status: 'pending',
    });
    restarted.parent = pipeline.number;
    this.onRestart(repo, restarted);
    return Response.json(restarted);
  }
}
