# archon-forge-forgejo

A forge plugin that lets [Archon](https://github.com/coleam00/Archon) read and write issues, labels,
comments and pull requests on a [Forgejo](https://forgejo.org) instance, merge pull requests, read
its commit statuses, and re-run failed [Woodpecker](https://woodpecker-ci.org) pipelines.

Status: in development. Built for Archon v0.14.0 (forge protocol 1) and Forgejo's `/api/v1`. It has
been tested against a single instance, Forgejo 17.0.2 (Gitea 1.22 API). Other Forgejo versions and
Gitea are untested; older ones may lack API fields it relies on, such as a pull request's `draft`.

## Operations

`resolve`, `workitem.list`, `workitem.view`, `workitem.label.add`, `workitem.label.remove`,
`workitem.comment.upsert`, `workitem.comments`, `workitem.create`, `workitem.edit-body`,
`workitem.close`, `repo.labels.list`, `repo.label.ensure`, `comment.upsert`, `pr.view`, `pr.create`,
`pr.edit-body`, `pr.ready`, `pr.draft`, `pr.merge`, `pr.merge-state`, `pr.files`, `pr.threads`,
`pr.thread.reply`, `repo.file`, `checks.state`, `checks.commit` and `checks.rerun`.

It does not serve `pr.thread.resolve`, because Forgejo's API cannot resolve a review conversation.
Archon's SDLC pack needs all three thread operations, so its deliver workflow refuses this plugin.

Forgejo differs from GitHub in ways a caller can see:

- `repo.label.ensure` creates a label named `scope/value`, such as `status/ready`, as an exclusive
  Forgejo label. Adding one label of a scope then removes the item's other label of that scope, so
  moving an issue from `status/ready` to `status/in-progress` is a single add. Labels that already
  exist are left as they are.
- `workitem.label.remove` removes a repository label by its id. Forgejo's remove endpoint looks up
  an id only among the repository's own labels, and answers 422 for an organization label's id. It
  looks up a name among the repository's labels and then the organization's, so the plugin then
  removes the label by name. It never replaces the item's whole label set.
- Forgejo marks a draft pull request with a title prefix. `pr.draft` adds `WIP: ` to the title and
  `pr.ready` removes it. These are Forgejo's default prefixes, `WIP:` and `[WIP]`. An instance that
  sets other prefixes in `WORK_IN_PROGRESS_PREFIXES` must keep `WIP:` among them, or `pr.draft`
  fails its read-back and `pr.create` cannot open a draft.
- Forgejo records no reason when an issue is closed, so `workitem.close` records `not_planned` and
  `duplicate` as the labels `closed/not_planned` and `closed/duplicate`. Create them first with
  `repo.label.ensure`; a close whose label is missing is refused. An issue with neither label reads
  as closed `completed`.
- Only pull requests from a branch in the same repository are supported, not from forks.
- `pr.merge` merges only at the head the caller names in `conditions.head`, the only merge
  condition it supports. It checks the head before merging, and passes it to Forgejo so that a push
  in between is refused too. The `method` is always the caller's, `merge` or `squash`; the
  repository's default merge style is not used.
- `pr.merge` refuses a pull request that is closed, a draft or already merged, without writing.
  Forgejo's refusals keep its message. A refusal because of branch protection, such as missing
  approvals, is a `conflict` with HTTP status 405. So is a conflict with the base branch, for which
  Forgejo says only "Please try again later", so the plugin adds the reason.
- `pr.merge` asks Forgejo to delete the head branch after merging. If the deletion fails, for
  example because the branch is protected, the merge still counts as done and the branch is left.
- A merge result's `landed.tree` is always `null`. Forgejo's commit API returns the commit's own
  id in place of its tree's, so the plugin does not report it. `landed.parents` is `null` when the
  merge commit cannot be read.
- `pr.merge-state` reports `mergeable` as `clean` or `unknown`, never `conflict`. Forgejo reports a
  pull request as not mergeable both when it conflicts and while Forgejo is still checking it.
- `pr.files` takes each file's patch from the pull request's diff, because Forgejo's file list has
  none. A file whose path git quotes, such as one with non-ASCII characters, has no patch.
- A review thread is what Forgejo shows as a conversation: the comments of one review on one line.
  Its id is the id of its first comment. A thread is resolved when Forgejo names who resolved it,
  and `outdated` is always `false`, because Forgejo's API does not say.
- `checks.state` and `checks.commit` mark a status that links to a Woodpecker pipeline as one that
  can be re-run. `checks.rerun` restarts that pipeline as a new one, so its passing workflows run
  again too. The new pipeline's number is the check's next attempt.

## Install

Download the executable for your platform from the
[latest release](https://github.com/thomas-elliott/archon-forge-forgejo/releases/latest):
`archon-forge-forgejo-linux-x64`, `-linux-arm64`, `-darwin-arm64` or `-darwin-x64`. `SHA256SUMS`
lists their checksums. To build it yourself instead, see [Develop](#develop).

Copy it into Archon's plugins directory under a temporary name, make it executable, then move it
into place, so that Archon never runs a half-copied file:

```sh
cp archon-forge-forgejo-linux-x64 ~/.archon/plugins/archon-forge-forgejo.new
chmod +x ~/.archon/plugins/archon-forge-forgejo.new
mv ~/.archon/plugins/archon-forge-forgejo.new ~/.archon/plugins/archon-forge-forgejo
```

Restart Archon afterwards so that it reads the plugin's new metadata. Upgrading the plugin is the
same steps with the new release.

The plugin claims no host, because every Forgejo is self-hosted. Claim yours in Archon's config,
`~/.archon/config.yaml`. Without this entry the plugin serves no host:

```yaml
forge:
  hosts:
    forgejo.example.com:
      plugin: forgejo
      token_env: FORGEJO_TOKEN
```

Archon reads the token from `FORGEJO_TOKEN` and hands it to the plugin as `ARCHON_FORGE_TOKEN`, the
only place the plugin reads it from. The token needs read and write access to the repository and
its issues. For a repository owned by an organization it also needs to read that organization's
labels. For `pr.merge`, the token's user must be allowed to merge into the base branch: check the
branch protection rule's merge allowlist and required approvals.

The plugin calls `https://<host>/api/v1`. When it is run directly rather than by Archon,
`FORGEJO_URL` may name a different origin for that host, such as `http://forgejo.example.com:3000`.
It must be a bare `http(s)://host[:port]`, and it is used only when its host and port match the
repository's. Archon v0.14.0 does not pass `FORGEJO_URL` to plugins, so under Archon every call
uses HTTPS.

`checks.rerun` also needs Woodpecker's address and a Woodpecker token. Archon passes a plugin no
variables besides its token, so the plugin reads them from
`~/.config/archon-forge-forgejo/woodpecker.json` in the home directory of the user Archon runs as:

```json
{ "url": "https://ci.example.com", "token": "<Woodpecker personal access token>" }
```

Make the file readable only by that user, for example with `chmod 600`. The plugin sends the token
only to that address, and re-runs only checks whose status links there. The token's user needs
permission to restart pipelines in the repository.

## When Archon is upgraded

Each release is built against one version of Archon's forge protocol, from Archon v0.14.0. Archon
runs `archon-forge-forgejo metadata` to learn which protocol and operations a plugin supports, and
does not use a plugin whose protocol it does not speak. After upgrading Archon, check that it still
lists the plugin's operations:

```sh
archon forge metadata --data '{"host":"forgejo.example.com"}' --json
```

If it does not, or a release of Archon changes the forge protocol, the plugin needs rebuilding
against the new Archon source: change the Archon version in the clone step below, in `CLAUDE.md`
and in `.github/workflows/release.yml`, then fix whatever the type check and tests report.

## Develop

The protocol schemas and Archon's conformance kit are imported from a checkout of Archon
`v0.14.0` in `local/archon`, which git ignores. Create it before building or testing:

```sh
git clone --depth 1 --branch v0.14.0 https://github.com/coleam00/Archon.git local/archon
bun install
bun run check      # format and lint, typecheck, tests
bun run build      # dist/<platform>/archon-forge-forgejo for each of the four platforms
```

Pushing a version tag such as `v0.1.0` runs `.github/workflows/release.yml`, which runs the checks,
builds every platform and publishes a GitHub release with the executables attached. Set the same
version in `package.json` first: the plugin reports it in its metadata.

The tests run against an in-memory Forgejo. `test/live.test.ts` runs against a real instance
instead, and skips unless all of these are set:

| Variable | Value |
| --- | --- |
| `FORGEJO_LIVE_URL` | The instance origin, such as `https://forgejo.example.com` |
| `FORGEJO_LIVE_REPO` | A scratch repository the tests may write to, as `owner/repo` |
| `FORGEJO_LIVE_TOKEN` | A token that can write that repository's code, issues and labels |

Each run creates the `status/*` and `closed/duplicate` labels if they are missing, two issues, one
branch and one pull request, with one review comment and a reply on it. Its last check merges the pull request, which adds one file under
`archon-live/` to the default branch, so the token's user must be able to merge there without
approvals. It closes the issues when it finishes, and the pull request and branch too if the merge
did not happen.
