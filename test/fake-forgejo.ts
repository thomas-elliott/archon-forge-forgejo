/**
 * An in-memory Forgejo serving the slice of `/api/v1` the plugin calls, in the
 * shapes a live Forgejo 17 (Gitea 1.22 API) returns. It models the behaviours the
 * plugin relies on: paging with `X-Total-Count`, label ids, exclusive label
 * scopes, the work-in-progress title prefix as `draft`, merging at an expected head,
 * and token authentication.
 */

export const TOKEN = 'fake-token-3f9c2a71';
export const OWNER = 'owner';
export const NAME = 'repo';

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  exclusive: boolean;
}
interface Pull {
  head: string;
  headSha: string;
  base: string;
  baseSha: string;
  merged: boolean;
  mergeCommit?: string;
  /** False when Forgejo has found a conflict with the base branch. */
  mergeable?: boolean;
}
interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: number[];
  pull: Pull | null;
  createdAt: string;
  closedAt: string | null;
}
interface Comment {
  id: number;
  issue: number;
  body: string;
}
interface Status {
  id: number;
  context: string;
  status: string;
}
export interface RecordedRequest {
  method: string;
  path: string;
}

const USER = { id: 7, login: 'archon-bot', username: 'archon-bot' };
const MAX_PAGE = 50;

/** A label belongs to an exclusive scope when exclusive and named `scope/value`. */
function scope(label: Label): string | null {
  const slash = label.name.lastIndexOf('/');
  return label.exclusive && slash > 0 && slash < label.name.length - 1
    ? label.name.slice(0, slash)
    : null;
}

export class FakeForgejo {
  readonly requests: RecordedRequest[] = [];
  labels: Label[] = [];
  /** Organization labels; null makes the owner a user, whose org labels endpoint is 404. */
  orgLabels: Label[] | null = null;
  issues: Issue[] = [];
  comments: Comment[] = [];
  branches = new Map<string, string>([['main', 'a'.repeat(40)]]);
  statuses = new Map<string, Status[]>();
  defaultBranch = 'main';
  /** Forgejo's `WORK_IN_PROGRESS_PREFIXES`, which an instance can configure. */
  wipPrefixes = ['WIP:', '[WIP]'];
  /** False models a Forgejo whose pull requests carry no `draft` field. */
  reportsDraft = true;
  /** Forgejo's answer to the next merge, such as a conflict or a branch protection refusal. */
  mergeRefusal: { status: number; message: string } | null = null;
  /** Commits a merge created, by id. */
  commits = new Map<string, { parents: string[] }>();
  /** Forgejo's answer when deleting the head branch after a merge fails, such as a protected branch. */
  branchDeletionRefusal: { status: number; message: string } | null = null;
  private nextId = 100;
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): this {
    this.server = Bun.serve({ port: 0, fetch: request => this.handle(request) });
    return this;
  }
  stop(): void {
    this.server?.stop(true);
  }
  get origin(): string {
    if (!this.server) throw new Error('fake Forgejo is not started');
    return `http://127.0.0.1:${String(this.server.port)}`;
  }
  /** The repository's `host[:port]`, which a `FORGEJO_URL` of `origin` serves. */
  get host(): string {
    return new URL(this.origin).host;
  }
  get repo() {
    return { host: this.host, path: `${OWNER}/${NAME}` };
  }
  /** Writes, in order, so a test can prove an idempotent call wrote nothing. */
  get writes(): RecordedRequest[] {
    return this.requests.filter(request => request.method !== 'GET');
  }

  addLabel(name: string, options: Partial<Omit<Label, 'id' | 'name'>> = {}): Label {
    const label = {
      id: this.nextId++,
      name,
      color: 'ededed',
      description: '',
      exclusive: false,
      ...options,
    };
    this.labels.push(label);
    return label;
  }
  addIssue(options: Partial<Omit<Issue, 'number'>> = {}): Issue {
    const issue: Issue = {
      number: this.issues.length + 1,
      title: 'An issue',
      body: '',
      state: 'open',
      labels: [],
      pull: null,
      createdAt: '2026-11-18T10:00:00+13:00',
      closedAt: null,
      ...options,
    };
    this.issues.push(issue);
    return issue;
  }
  addPull(pull: Partial<Pull> & { head: string }, options: Partial<Omit<Issue, 'number'>> = {}) {
    const headSha = pull.headSha ?? this.branches.get(pull.head) ?? 'b'.repeat(40);
    this.branches.set(pull.head, headSha);
    return this.addIssue({
      title: 'A pull request',
      ...options,
      pull: { base: 'main', baseSha: 'a'.repeat(40), merged: false, ...pull, headSha },
    });
  }
  addComment(issue: number, body: string): Comment {
    const comment = { id: this.nextId++, issue, body };
    this.comments.push(comment);
    return comment;
  }
  addStatus(sha: string, context: string, status: string): void {
    const list = this.statuses.get(sha) ?? [];
    list.push({ id: list.length + 1, context, status });
    this.statuses.set(sha, list);
  }

  private isDraft(title: string): boolean {
    return this.wipPrefixes.some(prefix => title.toUpperCase().startsWith(prefix));
  }
  private url(path: string): string {
    return `${this.origin}/${OWNER}/${NAME}${path}`;
  }
  private labelJson(label: Label) {
    return { ...label, is_archived: false, url: `${this.origin}/api/v1/labels/${label.id}` };
  }
  private allLabels(): Label[] {
    return [...this.labels, ...(this.orgLabels ?? [])];
  }
  private issueJson(issue: Issue) {
    const kind = issue.pull ? 'pulls' : 'issues';
    return {
      id: 1000 + issue.number,
      number: issue.number,
      html_url: this.url(`/${kind}/${issue.number}`),
      user: USER,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map(id => {
        const label = this.allLabels().find(candidate => candidate.id === id);
        if (!label) throw new Error(`label ${id} vanished`);
        return this.labelJson(label);
      }),
      state: issue.state,
      created_at: issue.createdAt,
      closed_at: issue.closedAt,
      pull_request: issue.pull
        ? {
            merged: issue.pull.merged,
            draft: this.isDraft(issue.title),
            html_url: this.url(`/pulls/${issue.number}`),
          }
        : null,
      repository: { id: 1, name: NAME, owner: OWNER, full_name: `${OWNER}/${NAME}` },
    };
  }
  private pullJson(issue: Issue) {
    const pull = issue.pull;
    if (!pull) throw new Error('not a pull request');
    const repo = { id: 1, name: NAME, full_name: `${OWNER}/${NAME}` };
    // Like Forgejo, a deleted head branch leaves `ref` naming the pull ref; `label` keeps the branch.
    const headRef = this.branches.has(pull.head) ? pull.head : `refs/pull/${issue.number}/head`;
    return {
      id: 2000 + issue.number,
      number: issue.number,
      user: USER,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      draft: this.reportsDraft ? this.isDraft(issue.title) : undefined,
      html_url: this.url(`/pulls/${issue.number}`),
      merged: pull.merged,
      merged_at: pull.merged ? issue.closedAt : null,
      merge_commit_sha: pull.mergeCommit ?? null,
      mergeable: pull.mergeable ?? true,
      allow_maintainer_edit: false,
      base: { label: pull.base, ref: pull.base, sha: pull.baseSha, repo_id: 1, repo },
      head: { label: pull.head, ref: headRef, sha: pull.headSha, repo_id: 1, repo },
      created_at: issue.createdAt,
      closed_at: issue.closedAt,
    };
  }
  private commentJson(comment: Comment) {
    const issue = this.issues.find(candidate => candidate.number === comment.issue);
    const url = this.url(`/${issue?.pull ? 'pulls' : 'issues'}/${comment.issue}`);
    return {
      id: comment.id,
      html_url: `${url}#issuecomment-${comment.id}`,
      issue_url: issue?.pull ? '' : url,
      pull_request_url: issue?.pull ? url : '',
      user: USER,
      body: comment.body,
      created_at: '2026-11-18T10:00:00+13:00',
    };
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push({ method: request.method, path: url.pathname });
    if (request.headers.get('authorization') !== `token ${TOKEN}`)
      return Response.json({ message: 'token is required' }, { status: 401 });
    const body =
      request.method === 'GET' || request.method === 'DELETE' ? {} : await request.json();
    const route = `${request.method} ${url.pathname.replace(`/api/v1/repos/${OWNER}/${NAME}`, '')}`;
    return this.route(route, url, body as Record<string, unknown>);
  }

  private page<T>(url: URL, rows: T[]): Response {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 30), MAX_PAGE);
    const page = Number(url.searchParams.get('page') ?? 1);
    return Response.json(rows.slice((page - 1) * limit, page * limit), {
      headers: { 'x-total-count': String(rows.length) },
    });
  }

  private route(route: string, url: URL, body: Record<string, unknown>): Response {
    const notFound = Response.json({ message: 'not found' }, { status: 404 });
    let match: RegExpExecArray | null;

    if (route === `GET /api/v1/orgs/${OWNER}/labels`)
      return this.orgLabels
        ? this.page(
            url,
            this.orgLabels.map(l => this.labelJson(l))
          )
        : notFound;
    if (route === 'GET ')
      return Response.json({ full_name: `${OWNER}/${NAME}`, default_branch: this.defaultBranch });
    match = /^GET \/branches\/(.+)$/.exec(route);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const sha = this.branches.get(name);
      return sha ? Response.json({ name, commit: { id: sha } }) : notFound;
    }

    if (route === 'GET /labels')
      return this.page(
        url,
        this.labels.map(l => this.labelJson(l))
      );
    if (route === 'POST /labels') {
      const label = this.addLabel(String(body.name), {
        color: String(body.color).replace(/^#/, ''),
        description: String(body.description ?? ''),
        exclusive: body.exclusive === true,
      });
      return Response.json(this.labelJson(label), { status: 201 });
    }
    match = /^GET \/labels\/(\d+)$/.exec(route);
    if (match) {
      const label = this.labels.find(candidate => candidate.id === Number(match?.[1]));
      return label ? Response.json(this.labelJson(label)) : notFound;
    }

    if (route === 'GET /issues') {
      const state = url.searchParams.get('state') ?? 'open';
      const type = url.searchParams.get('type');
      const names = url.searchParams.get('labels')?.split(',') ?? [];
      const ids = this.allLabels()
        .filter(label => names.includes(label.name))
        .map(label => label.id);
      const rows = this.issues
        .filter(issue => state === 'all' || issue.state === state)
        .filter(issue => type !== 'issues' || !issue.pull)
        .filter(issue => ids.length === 0 || ids.every(id => issue.labels.includes(id)))
        .reverse();
      return this.page(
        url,
        rows.map(issue => this.issueJson(issue))
      );
    }
    if (route === 'POST /issues') {
      const issue = this.addIssue({ title: String(body.title), body: String(body.body ?? '') });
      return Response.json(this.issueJson(issue), { status: 201 });
    }
    match = /^(GET|PATCH) \/issues\/(\d+)$/.exec(route);
    if (match) {
      const issue = this.issues.find(candidate => candidate.number === Number(match?.[2]));
      if (!issue) return notFound;
      if (match[1] === 'PATCH') this.patchIssue(issue, body);
      return Response.json(this.issueJson(issue), { status: match[1] === 'PATCH' ? 201 : 200 });
    }
    match = /^POST \/issues\/(\d+)\/labels$/.exec(route);
    if (match) {
      const issue = this.issues.find(candidate => candidate.number === Number(match?.[1]));
      if (!issue) return notFound;
      for (const id of body.labels as number[]) this.attachLabel(issue, id);
      return Response.json(this.issueJson(issue).labels);
    }
    match = /^DELETE \/issues\/(\d+)\/labels\/([^/]+)$/.exec(route);
    if (match) {
      const issue = this.issues.find(candidate => candidate.number === Number(match?.[1]));
      // As Forgejo 17 does: a name among the repository's labels, then the organization's,
      // then an id among the repository's labels only.
      const identifier = decodeURIComponent(match[2]);
      const label =
        this.labels.find(candidate => candidate.name === identifier) ??
        this.orgLabels?.find(candidate => candidate.name === identifier) ??
        this.labels.find(candidate => String(candidate.id) === identifier);
      if (!label) return Response.json({ message: 'label does not exist' }, { status: 422 });
      if (!issue?.labels.includes(label.id)) return notFound;
      issue.labels = issue.labels.filter(id => id !== label.id);
      return new Response(null, { status: 204 });
    }
    match = /^(GET|POST) \/issues\/(\d+)\/comments$/.exec(route);
    if (match) {
      const number = Number(match[2]);
      if (!this.issues.some(issue => issue.number === number)) return notFound;
      if (match[1] === 'POST') {
        const comment = this.addComment(number, String(body.body));
        return Response.json(this.commentJson(comment), { status: 201 });
      }
      // Like Forgejo, the issue comments listing is not paged.
      const rows = this.comments.filter(comment => comment.issue === number);
      return Response.json(
        rows.map(comment => this.commentJson(comment)),
        { headers: { 'x-total-count': String(rows.length) } }
      );
    }
    match = /^(GET|PATCH) \/issues\/comments\/(\d+)$/.exec(route);
    if (match) {
      const comment = this.comments.find(candidate => candidate.id === Number(match?.[2]));
      if (!comment) return notFound;
      if (match[1] === 'PATCH') comment.body = String(body.body);
      return Response.json(this.commentJson(comment));
    }

    if (route === 'GET /pulls') {
      const state = url.searchParams.get('state') ?? 'open';
      const rows = this.issues.filter(
        issue => issue.pull && (state === 'all' || issue.state === state)
      );
      return this.page(
        url,
        rows.map(issue => this.pullJson(issue))
      );
    }
    if (route === 'POST /pulls') {
      const head = String(body.head);
      const headSha = this.branches.get(head);
      if (!headSha) return notFound;
      if (this.issues.some(issue => issue.state === 'open' && issue.pull?.head === head))
        return Response.json({ message: 'pull request already exists' }, { status: 409 });
      const issue = this.addPull(
        { head, headSha, base: String(body.base) },
        { title: String(body.title), body: String(body.body ?? '') }
      );
      return Response.json(this.pullJson(issue), { status: 201 });
    }
    match = /^(GET|PATCH) \/pulls\/(\d+)$/.exec(route);
    if (match) {
      const issue = this.issues.find(
        candidate => candidate.number === Number(match?.[2]) && candidate.pull
      );
      if (!issue) return notFound;
      if (match[1] === 'PATCH') this.patchIssue(issue, body);
      return Response.json(this.pullJson(issue), { status: match[1] === 'PATCH' ? 201 : 200 });
    }

    match = /^POST \/pulls\/(\d+)\/merge$/.exec(route);
    if (match) return this.merge(Number(match[1]), body);
    match = /^GET \/git\/commits\/([^/]+)$/.exec(route);
    if (match) {
      const sha = match[1];
      const commit = this.commits.get(sha);
      if (!commit) return notFound;
      // Like Forgejo, `commit.tree.sha` repeats the commit's own id, not its tree's.
      return Response.json({
        sha,
        commit: { tree: { sha } },
        parents: commit.parents.map(parent => ({ sha: parent })),
      });
    }

    match = /^GET \/commits\/([^/]+)\/statuses$/.exec(route);
    if (match) {
      // Oldest first: a live Forgejo does not list statuses newest first, so neither does this.
      const rows = (this.statuses.get(match[1]) ?? []).map(status => ({
        ...status,
        target_url: 'https://ci.example.com/pipeline/1',
        description: '',
        created_at: '2026-11-18T10:00:00+13:00',
      }));
      return this.page(url, rows);
    }
    return notFound;
  }

  /** Forgejo's checks, in its order, then the merge and branch deletion; it answers 200 with no body. */
  private merge(number: number, body: Record<string, unknown>): Response {
    const issue = this.issues.find(candidate => candidate.number === number && candidate.pull);
    const pull = issue?.pull;
    if (!issue || !pull) return Response.json({ message: 'not found' }, { status: 404 });
    if (pull.merged) return Response.json({ message: 'PR already merged' }, { status: 405 });
    if (issue.state === 'closed') return Response.json({ message: 'not found' }, { status: 404 });
    if (this.isDraft(issue.title))
      return Response.json({ message: 'Work in progress PRs cannot be merged' }, { status: 405 });
    if (pull.mergeable === false)
      return Response.json({ message: 'Please try again later' }, { status: 405 });
    if (this.mergeRefusal)
      return Response.json(
        { message: this.mergeRefusal.message },
        { status: this.mergeRefusal.status }
      );
    if (body.head_commit_id && body.head_commit_id !== pull.headSha)
      return Response.json({ message: 'head out of date' }, { status: 409 });
    const commit = 'e'.repeat(40);
    this.commits.set(commit, {
      parents: body.Do === 'squash' ? [pull.baseSha] : [pull.baseSha, pull.headSha],
    });
    pull.merged = true;
    pull.mergeCommit = commit;
    issue.state = 'closed';
    issue.closedAt = '2026-11-18T11:00:00+13:00';
    // Forgejo deletes the branch only after merging, so a failure here leaves the merge in place.
    if (body.delete_branch_after_merge) {
      if (this.branchDeletionRefusal)
        return Response.json(
          { message: this.branchDeletionRefusal.message },
          { status: this.branchDeletionRefusal.status }
        );
      this.branches.delete(pull.head);
    }
    return new Response(null, { status: 200 });
  }

  private patchIssue(issue: Issue, body: Record<string, unknown>): void {
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'closed' && issue.state === 'open') {
      issue.state = 'closed';
      issue.closedAt = '2026-11-18T11:00:00+13:00';
    }
  }

  /** Attach a label, dropping any other label of its exclusive scope, as Forgejo does. */
  private attachLabel(issue: Issue, id: number): void {
    const label = this.allLabels().find(candidate => candidate.id === id);
    if (!label) throw new Error(`no label ${id}`);
    const labelScope = scope(label);
    if (labelScope !== null)
      issue.labels = issue.labels.filter(other => {
        const existing = this.allLabels().find(candidate => candidate.id === other);
        return !existing || scope(existing) !== labelScope;
      });
    if (!issue.labels.includes(id)) issue.labels.push(id);
  }
}
