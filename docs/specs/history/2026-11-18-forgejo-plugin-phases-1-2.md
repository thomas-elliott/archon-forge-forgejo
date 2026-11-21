# Forgejo forge plugin, phases 1 and 2

Covers no board issue (none is filed).

## Why are we doing this

An Archon user on a self-hosted Forgejo can have Archon pick up an issue labelled `status/ready`, claim it, open a PR, report back on the issue and hand it to review. Archon reaches a forge only through a plugin, and the only released one is for GitHub.

## Steering

None recorded.

## Design

The operator's working spec, `local/2026-11-18-initial-build.md` (gitignored), sections "Identity and credentials" to "Phase 2: richer reporting" and "Packaging and install". It names a real host and setup: copy none of that into committed files.

## Decisions

### Which phases does this work cover?
Answer: Phases 1 and 2 of the working spec, 20 operations in all. Phase 3 (SDLC pack parity) is out of scope.
By: operator — "Phases 1 and 2 (recommended)" (2026-11-18)

### Where do the Archon protocol schemas and the conformance kit come from?
Answer: Import `@archon/forge` from the gitignored `local/archon` checkout of Archon `v0.14.0`; do not copy its files into this repository. The compiled binary bundles what it uses, so nothing needs the checkout at run time. Building or testing from a fresh clone needs the clone step in `CLAUDE.md` first.
By: recommended, operator said "go" (2026-11-18)

### How do the live checks against a real Forgejo run?
Answer: Commit them as tests that skip unless environment variables name the Forgejo instance, a test repository and a token. Unit tests run against a fake Forgejo server and need none of these.
By: recommended, operator said "go" (2026-11-18)

### Which platforms are built?
Answer: `linux-x64` and `darwin-arm64`.
By: recommended, operator said "go" (2026-11-18)

### How is the plugin installed?
Answer: By hand: copy the binary into the Archon plugins directory and mark it executable, as the working spec says.
By: recommended, operator said "go" (2026-11-18)

### How is a draft PR detected?
Answer: Use the API's `draft` field if the target Forgejo returns one; otherwise detect the title prefix. Check this against the live test repository before relying on it.
By: settled by `local/2026-11-18-initial-build.md` (2026-11-18)

### Should phase 3 (SDLC pack parity) be built?
Answer: Not yet: phase 3 is built only after the plugin has been dogfooded.
By: operator — "This is only to be built after dogfooding" (2026-11-18)

### Should the `FORGEJO_URL` override stay, given Archon v0.14.0 does not pass it to plugins?
Answer: Keep it for direct runs only, as built; the README says it has no effect under Archon.
By: operator — "Keep for direct runs" (2026-11-18)

### Should `workitem.close` accept `not_planned` and `duplicate`?
Answer: Yes. Forgejo stores no close reason, so record the reason as a label on the closed issue (for example `closed/duplicate`). Built in stage 8.
By: operator — "Record as a label" (2026-11-18)

## Acceptance

Live checks run against a test repository on a Forgejo instance, shown here as `forgejo.example.com/owner/repo`, with a bot token that reaches only that repository.

1. `archon forge metadata --data '{"host":"forgejo.example.com"}' --json` lists exactly the 20 phase 1 and phase 2 operations and an empty `hosts`, and Archon finds the plugin only through the `forge.hosts` entry in its config.
2. `archon forge resolve` resolves `https://forgejo.example.com/owner/repo.git`, its SSH and scp forms, and refuses a remote that carries credentials.
3. The thin workflow works end to end on a test issue: it moves from `status/ready` to `status/in-progress` to `status/review`, ends with exactly one marked comment and one PR, and rerunning each step returns `changed: false` without writing again.
4. `repo.label.ensure` creates the `status/*` labels as an exclusive scope, so adding `status/in-progress` removes `status/ready` in one step.
5. A PR can be switched to draft and back to ready, and its body edited; each change reads back as requested.
6. An issue can be created (a retry after a lost response finds the first issue by its marker instead of creating a second), its body edited, its comments listed and the issue closed.
7. `checks.state` and `checks.commit` report a commit's Woodpecker statuses: latest status per context, `pending`, `green`, `red` or `unknown` with the native value kept, and `none` when the commit has no statuses.
8. Mutation outcomes are honest: a label that does not exist, a wrong subject kind, a moved `headRevision` and a duplicate head PR are each `refused`, and losing the network mid-write gives `outcome_unknown`.
9. `runForgeReadConformance` and `runForgeMutationConformance` pass against fixtures in the test repository.
10. No token appears in stdout, stderr or the run's audit events.
11. No real host, user or repository name appears anywhere in the committed source, tests, fixtures or docs.
12. The README shows the `forge.hosts` config entry with a placeholder host, and notes that `scope/value` labels are created exclusive.

## Out of scope

- Phase 3: `pr.threads`, `pr.thread.reply`, `pr.thread.resolve`, `checks.rerun`, `pr.merge`, `pr.merge-state`, `pr.reviews`, `pr.files`, `repo.file` and `pr.view:any-state`.
- PRs from forks; only same-repository branches.
- GitHub releases and `archon plugin add` support.
- Deployment: the bot user, its token scopes, the poller and the host's Archon config.
- A Forgejo mirror of this repository.

## Start here

- `local/2026-11-18-initial-build.md`
- `local/archon/packages/docs-web/src/content/docs/reference/forge.md`
- `local/archon/packages/forge/src/lifecycle.ts`
- `local/archon/packages/forge/src/outbound-conformance.ts`
- `local/archon/packages/adapters/src/forge/github/plugin.ts`

## Deferred follow-ups

None.

## Implementation report

Mode: no-commit. Everything is left in the working tree on the current branch.

### Stages

1. Scaffold and protocol boundary: Bun project importing `@archon/forge` from `local/archon`, the executable entry (`metadata`, `op <operation>`), metadata with the 20 operations, `resolve`, the Forgejo API client (origin, `FORGEJO_URL` override, token header, paging, error mapping) and the mutation-outcome helpers.
2. Work-item reads and labels: `workitem.list`, `workitem.view`, `repo.labels.list`, `repo.label.ensure` (exclusive `scope/value`), `workitem.label.add`, `workitem.label.remove`, with a fake Forgejo server for tests.
3. Comments: `workitem.comment.upsert`, `comment.upsert`, `workitem.comments`.
4. Pull requests: `pr.view`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft`.
5. Issue writes: `workitem.create` (marker recovery), `workitem.edit-body`, `workitem.close`.
6. Checks: `checks.state`, `checks.commit` from commit statuses.
7. Packaging and live checks: `archon-plugin.json`, compiled builds for `linux-x64` and `darwin-arm64`, live tests (thin workflow, refusals, conformance kit) that skip without environment variables, and the README.
8. Review follow-ups: `workitem.close` accepts `not_planned` and `duplicate` and records the reason as a label on the closed issue, per the Decision "Should `workitem.close` accept `not_planned` and `duplicate`?"; a closed issue reads back with the reason its label names. Replaces the refusal in the `src/workitems.ts` choice and the README's Forgejo differences.

### Choices made
- `src/api.ts`: listings follow pages until `X-Total-Count` is reached, or a short page without that header; a page longer than asked for ends the listing, because the live statuses endpoint ignored `limit`.
- `src/api.ts`: Forgejo's own error `message` is appended to the HTTP status in an error, never the request URL or headers.
- `src/operations.ts`: `capabilities` is derived from the read and write handler tables, so the advertised list cannot drift from what is served; `version` comes from `package.json`.
- `src/remote.ts`: an scp-form remote with `user:password@` is refused as carrying credentials rather than parsed as host `user`.
- `src/labels.ts`: an organization labels lookup that answers 404 is read as a user-owned repository with no organization labels; any other failure fails the operation.
- `src/labels.ts`: a name held by both the repository and its organization is refused as `conflict` by `workitem.label.add` rather than picking one; `workitem.label.remove` takes the id from the item's own label.
- `src/labels.ts`: `repo.label.ensure` treats a name existing as a repository or organization label as existing, and verifies `exclusive` on read-back as well as name, color and description.
- `src/workitems.ts`: an item read back is checked against the request by number and `repository.full_name`, compared case-insensitively.
- `src/comments.ts`: the issue comments listing is read in one call, as Forgejo does not page it; an `X-Total-Count` larger than the rows returned fails the operation rather than trusting a partial list.
- `src/comments.ts`: a written comment is verified by id, body, and its `html_url` naming the requested item; `comment.upsert` does not check the item's kind, as the GitHub plugin does not.
- `src/pulls.ts`: a pull request's `head` is Forgejo's `head.label`, because the live instance reports `head.ref` as `refs/pull/N/head` once the branch is deleted; `is_draft` is the API's `draft` field, which the live instance returns, falling back to the default `WIP:`/`[WIP]` prefixes.
- `src/pulls.ts`: `pr.create` refuses a non-draft title that already begins with a work-in-progress prefix, and adds `WIP: ` only when a draft title lacks one; a duplicate head is refused with the open pull request as `observed`.
- `src/pulls.ts`: `pr.ready` refuses a draft whose title prefix is not one of the default prefixes, since an instance-configured prefix cannot be removed safely.
- `src/workitems.ts`: `workitem.create` looks for the marker among issues of every state with `type=issues`, also skipping any item that is a pull request.
- `src/close.ts`: `not_planned` and `duplicate` are the labels `closed/not_planned` and `closed/duplicate`; `completed` has no label, so an issue closed by hand reads as `completed`, and one carrying both labels has no single reason and is refused.
- `src/close.ts`: a missing reason label is refused as `not_found` rather than created, as `workitem.label.add` does; the README says to create it with `repo.label.ensure`, which makes it exclusive.
- `src/close.ts`: the label goes on before the close, so a retry after a failed close only closes; a close Forgejo refuses after the label was written is `verification_failed` naming the label, since something was written; a close whose answer is lost is `outcome_unknown`, per the protocol docs. This is two writes where the protocol docs say at most one, which the operator's "Record as a label" requires: Forgejo's issue edit takes no labels.
- `src/close.ts`: an open issue carrying another reason's label is refused before writing, because closing it would read back as that reason.
- `src/labels.ts`: `existingLabel` holds the exact-name lookup and its refusals, shared by `workitem.label.add` and `workitem.close`.
- `src/checks.ts`: the latest status per context is the one with the highest `id` (Forgejo's per-commit index), contexts compared exactly; a unit's id is that index, its name the context, and `rerun` is null.
- `src/checks.ts`: `warning` and any unrecognised state map to `unknown` with the native value in `nativeState` and `nativeResult`; `warning` has phase `completed`, an unrecognised state phase `unknown`.
- `archon-plugin.json`: the working spec's shape with no `compatibility` range; it is checked against Archon's manifest rules by reading them, because importing that schema pulls in other Archon workspace packages.
- `test/live.test.ts`: the live checks read `FORGEJO_LIVE_URL`, `FORGEJO_LIVE_REPO` and `FORGEJO_LIVE_TOKEN`, branch from the repository's default branch, and create their head branch through the contents API.
- `package.json`: `build` compiles `dist/linux-x64/` and `dist/darwin-arm64/`, each holding `archon-forge-forgejo`, the file name discovery scans for.
- `bunfig.toml`: `bun test` discovers tests only under `test/`, because the `local/archon` checkout holds Archon's own suites, which otherwise ran and hung the gate.

### Results

| Item | Status | Notes |
| --- | --- | --- |
| 1. metadata: 20 operations, empty `hosts`, found only through `forge.hosts` | passed | Real `archon` v0.14.0 CLI with a scratch `ARCHON_HOME` holding the built binary: with the `forge.hosts` entry, `archon forge metadata` returned 20 capabilities and `hosts: []`; without it, `no_plugin_for_host`. `test/protocol.test.ts` "metadata advertises exactly…" fails if a handler is added or dropped. |
| 2. resolve: HTTPS, SSH and scp forms; credentials refused | passed | Same CLI: the HTTPS, `ssh://git@host/…` and `git@host:…` forms resolved to `owner/repo`; `https://user:secret@…` gave `invalid_request`. An SSH remote on an unclaimed port (`:2222`) returned `none` from Archon itself, since the claim is the bare host. `test/protocol.test.ts` resolve cases fail if credential or query checks are removed. |
| 3. thin workflow end to end, reruns `changed: false` | passed | `bun test --env-file=.env.live test/live.test.ts` against the test repository on a real Forgejo, 2026-11-18: 9 pass, 0 fail. "the thin workflow claims…" moves the issue `status/ready` → `status/in-progress` → `status/review`, reruns each step as `changed: false`, and finds one marked comment and one pull request. |
| 4. `status/*` labels exclusive; one add drops `status/ready` | passed | Same run: "repo.label.ensure creates…" reads the labels back as `exclusive`, and the thin workflow's add of `status/in-progress` returns only `status/in-progress`, so Forgejo's bulk label add applies the exclusive scope as the fake models it. |
| 5. PR draft and back, body edited, each read back | passed | Same run: "a pull request switches to draft and back…". |
| 6. issue create with lost-answer recovery, edit, comments, close | passed | Same run: "workitem.create recovers the first issue after a lost answer" (one issue with the marker) and "an issue body is edited, its comments listed and the issue closed". |
| 7. `checks.state`/`checks.commit` from statuses | passed | Same run: "checks report commit statuses…" covers `none`, latest per context, and `warning` as `unknown`. The `red` mapping is proved only by `test/checks.test.ts` against the fake. |
| 8. honest outcomes: refusals and `outcome_unknown` | passed | Same run: "refusals…" (missing label, wrong subject kind, moved head), the thin workflow's duplicate-head `pr.create` refused as `conflict`, and `outcome_unknown` from the lost-answer create. |
| 9. read and mutation conformance kits pass | passed | Same run: `runForgeReadConformance` in "checks report commit statuses…" and `runForgeMutationConformance` in "the mutation conformance kit passes", both against fixtures in the test repository. |
| 10. no token on stdout, stderr or audit | passed | `test/secrets.test.ts` spawns the executable for an applied write, a refusal, a rejected token and no server; it fails when an error message includes the token (checked). Audit events are Archon's projection of these responses, so they carry nothing the responses do not. |
| 11. no real host, user or repository committed | passed | `grep -iE` for the working spec's host, user and repository names over every untracked and modified file: no match (exit 1). |
| 12. README shows `forge.hosts` with a placeholder, notes exclusive labels | passed | `README.md` "Install" and "Operations". |
| build | passed | `bun run build`, exit 0: Mach-O arm64 and ELF x86-64 executables. |
| gate: format, lint, typecheck, tests | passed | `bun run check`, exit 0: Biome clean, `tsc` clean, 84 pass, 10 skip, 0 fail. |
| review: stages 1…7 | passed | `### Review - stages 1…7`: 1 MED fixed (README), 1 LOW left for cleanup, 2 smells fixed, 1 refuted. |
| stage 8: close as `not_planned`/`duplicate` via a `closed/*` label, read back with that reason | passed | Same run: "an issue closed as a duplicate…" closes as `duplicate`, reruns as `changed: false`, and reads `closed/duplicate` back. Unit tests in `test/issues.test.ts` cover the refusals and the lost close. |
| build (stage 8) | passed | `bun run build`, exit 0. |
| gate (stage 8) | passed | `bun run check`, exit 0: Biome clean, `tsc` clean, 94 pass, 11 skip, 0 fail. |
| 11. no real host, user or repository committed (stage 8) | passed | Matched the working spec's host name against `src`, `test`, `docs`, `README.md` and the manifests: no match (exit 1). |
| review: stages 8…8 | passed | `### Review - stages 8…8`: 1 LOW fixed. |

### Review - stages 1…7

#### Verdict
MED · introduced - `FORGEJO_URL` never reaches the plugin under Archon: `pluginProcessEnv` (local/archon `packages/forge/src/plugin-process.ts:43-55`) passes only a fixed safe list, `ARCHON_FORGE_TOKEN` and, for `forge: github` only, `GITHUB_URL`, so an operator who sets it as the README says gets calls to `https://<host>` with no error naming the cause; the override works only in tests that call `handleOperation` directly. Fix: drop the override and the README paragraph, or state that it applies only outside Archon (src/plugin.ts:53, src/api.ts:40, README.md:54) → fixed: README now says the override applies only when the plugin runs outside Archon; removing the override is raised as a `decision:`, since the working spec asks for it
LOW · introduced - `workitem.create` lists every issue in the repository, in every state, before each create, so one create costs one call per 50 issues (40 calls on a repository with 2,000 issues). Fix: narrow the scan with Forgejo's `created_by=<token user>` filter (src/workitems.ts:145) → left for cleanup: the filter would stop recovery finding a marked issue created by any other user, which changes behaviour the protocol docs describe, so it needs the operator's call → accepted

#### Checked
repo rules (CLAUDE.md public-repository rule: no real host, user or repository in committed files, checked by matching the working spec's host names against the tree; none found), documented hazards (none beyond the public-repository rule), mechanical: shape conformance, completeness honesty, coverage, cross-boundary contract (metadata `name` `forgejo` against the discovery name taken from the `archon-forge-forgejo` executable and the README's `plugin: forgejo`; host-claim stripping against `dispatch.ts:108`; request schemas in `lifecycle.ts` for marker, colour and close reason; result matchers in `response-match.ts`), shared-library precedence, logic, error handling, silent failure, input validation, idempotency and resilience, credentials and secrets, security, concurrency, external contracts, resource management, logging and observability, performance · issues in: external contracts (env passing), silent failure (override silently unused), performance · n/a: none · validation: in-context, 2 candidates, 2 confirmed, 0 refuted · unconfirmed: whether Forgejo answers 404 to deleting a label the item no longer carries (its model may return success, so the 404 branch in `removeLabel` at src/labels.ts:192-196 may never run and a concurrent removal would read as `changed: true`); settle it with a live call against the test repository

#### Smells
possible Duplicated Code - `firstLine` is defined twice; export one copy (src/comments.ts:28, src/workitems.ts:131) → fixed
possible Duplicated Code - `branchSchema` is declared twice; export one copy from the API module (src/pulls.ts:168, src/checks.ts:93) → fixed: one `branchHead` in src/api.ts
possible Speculative Generality - the `FORGEJO_URL` origin override, which the working spec does not ask for and Archon does not pass through; delete it with the MED fix (src/api.ts:36-81) → refuted: the working spec's "Identity and credentials" section asks for it; see the `decision:` follow-up

### Review - cleanup

#### Verdict
LOW · introduced - no test reaches a `verification_failed` outcome or two of the pre-write refusals: the acknowledged branch of `runMutation` (src/outcome.ts:112), every handler's read-back-disagrees branch, `pr.create` refusing a non-draft title that starts with `WIP:` (src/pulls.ts:181) and `pr.ready` refusing an unrecognised prefix (src/pulls.ts:287). If the acknowledged branch were dropped, a write Forgejo accepted would report `refused`, and a caller would retry it and write twice; the 84 unit tests would still pass. Fix: in the fake, add a hook that changes the item after the write. Use it for one test that asserts `verification_failed` with `leaveBehind`, and add one test for each refusal that asserts `fake.writes` is empty → fixed: test/pulls.test.ts covers both refusals, a read-back that disagrees, and a read-back lost after the write (fails when the acknowledged branch is removed, checked); the fake's work-in-progress prefixes are now configurable, as Forgejo's are
LOW · introduced - under Archon, every call goes to `https://<host>/api/v1`, because `FORGEJO_URL` never arrives. No test covers that URL or the `:443` strip for a `hostClaim` repository. Every unit, secrets and live test passes `forgejoUrl`, so all of them take the override branch. A broken `requestedHost` or `apiOrigin` would therefore reach Archon users with the whole suite passing (src/api.ts:70-80). Fix: add a unit test of `repoUrl` with `origin: undefined`, for `{host: 'forgejo.example.com:443', hostClaim: true}` and for a plain host, that expects `https://forgejo.example.com/api/v1/repos/owner/repo` → fixed: test/protocol.test.ts "API URL without an origin override"

#### Checked
repo rules (CLAUDE.md public-repository rule: matched the working spec's real host, user and repository names against every changed and untracked file, no match; `.gitignore` keeps `local/`, `CLAUDE.local.md` and `dist/` out), documented hazards (only the public-repository rule), mechanical: shape conformance (`applied` is schema-parsed; the `refused`/`unverified`/`unknown` shapes were checked against `mutationFailureSchema` in local/archon `lifecycle.ts:458-480`, including `observed`/`comment`/`workitem`/`label` placement), completeness honesty (`pages` follows every page; `listComments` fails rather than returning a partial list; nothing truncates silently), coverage, cross-boundary contract (metadata `name: forgejo` against the README's `plugin: forgejo` and discovery's `expectedName` check in `discovery.ts:190`; manifest `name: forge-forgejo` and `executable` against `plugin-manifest` regexes, matching the reference `forge-github`; `hostClaim` stripping against `dispatch.ts:108`; the request `color` lowercasing transform against `labelRecord`; the `x-total-count` header), shared-library precedence (n/a), logic, error handling, silent failure, input validation, idempotency and resilience, credentials and secrets, security, concurrency, external contracts, resource management, logging and observability, performance, change-type blocks, risk and omissions (co-change sweep, side effects, backward compatibility, deployment, tests, dependencies, structural risk, widened flaws), operator intent, cross-stage boundaries (`branchHead` shared by stages 4 and 6; `readIssue`/`subjectRecord`/`labelNames`/`firstLine` shared by stages 2, 3 and 5; `ForgejoError.definitiveRefusal` set by stage 2-6 helpers against `runMutation`'s phases, where every `true` is raised before submit or after acknowledgement, so none turns a lost write into `refused`; the README's operation list and Forgejo differences against the handler tables and stage 4/5 behaviour) · issues in: tests · n/a: shared-library precedence (no UI or utilities), change-type blocks (no endpoint, migration, tenancy: every call is scoped by `repoUrl` from the request's repository and the token), deployment (manual install only), backward compatibility (new plugin, no callers) · intent: no `docs/intent/`; the feature is explained by the operator decisions quoted in `## Decisions` and the working spec, so no INTENT line · overlap: the stage review's `FORGEJO_URL` MED (README fixed, removal deferred as a `decision:`) and the `workitem.create` full-scan LOW are not raised again; the second finding above is the far side of the first: the default path is the only one Archon can use, and no test covers it · approver: token handling (src/plugin.ts:52, src/api.ts:149) and the new parsing dependency `zod` 4.4.3, which matches Archon's `^4.4.3` · checked against the reference plugin: `workitem.list` (PRs included, comma refused, exact-name filter), `workitem.create` (marker scan, recovery without edit) and `repo.label.ensure` (existing name is `changed:false`) match local/archon `adapters/src/forge/github/workitems.ts` · validation: none needed, 0 HIGH or MED candidates, 0 confirmed, 0 refuted (run in context: this review is itself a subagent) · unconfirmed: whether Forgejo's bulk `POST /issues/{n}/labels` applies exclusive-scope removal as the fake models it (src/labels.ts:153; settle with the live thin-workflow test); `test/secrets.test.ts:65` names `http://127.0.0.1:1` as "nothing answering", but its port does not match the repository's, so the call goes to `https://<fake host>` and fails on TLS instead. The assertion still holds, but the comment describes a different failure → fixed in cleanup: the case now addresses `127.0.0.1:1`, so the override applies and the connection is refused

#### Smells
possible Duplicated Code - three different case-insensitive checks that a Forgejo `full_name` names the request's repository; use one `samePath(fullName, repo)` helper in src/api.ts (src/workitems.ts:39, src/pulls.ts:69-74, src/pulls.ts:118) → fixed: one `namesRepo` in src/api.ts
possible Mysterious Name - `owner(repo)` returns both owner and repository name; rename it to `ownerAndName` (src/api.ts:83) → fixed

### Cleanup pass

Mode: no-commit; all edits are in the working tree.

- Acceptance: 1, 2, 10, 11 and 12 met. 3 to 9 unproven, because `test/live.test.ts` skips without `FORGEJO_LIVE_URL`, `FORGEJO_LIVE_REPO` and `FORGEJO_LIVE_TOKEN`. To prove them, run `bun test test/live.test.ts` with those set against the test repository. The live run also settles two unconfirmed points: whether Forgejo answers 404 when a label the item no longer carries is deleted, and whether its bulk label add applies exclusive scopes. No undeclared departures.
- Review coverage: `### Review - stages 1…7` covers every built stage once. Stage 8 is not built yet.
- Review: `### Review - cleanup` found 2 LOW and 2 smells; all were fixed. The misleading "nothing answering" case in `test/secrets.test.ts` was fixed as well.
- Triage: the `workitem.create` full-scan LOW was accepted. The three open `decision:` entries were answered and moved to `## Decisions`. The close-reason answer is stage 8.
- Simplify: small edits to `src/operations.ts`, `src/remote.ts`, `src/api.ts`, `src/workitems.ts`, `src/outcome.ts` and `src/labels.ts`. They reuse `refused()`, trim once, keep one error message, drop unused exports and collapse two objects. Behaviour is unchanged.
- Test gate: no test cut. `pr.view` "without a draft field from Forgejo, a work-in-progress title prefix reads as draft" now reaches the title-prefix fallback. The fake can leave out `draft`, and the test fails when the fallback is removed (checked).
- Verify: `bun run check` exit 0 (Biome clean, `tsc` clean, 90 pass, 10 skip, 0 fail). `bun run build` exit 0: Mach-O arm64 and ELF x86-64 executables.
- Handed back: the operator's answer to the close-reason decision ("Record as a label") needs more than one edit, so it is stage 8.

### Review - stages 8…8

#### Verdict
LOW · introduced - the live duplicate-close test creates a second issue that `afterAll` never closes: only `state.issue` is cleaned up, so if the close or either assertion fails, the issue stays open on the scratch repository, although the header comment and the README say the run closes its issues. Fix: record the new issue's number in `state` and close it in `afterAll` (test/live.test.ts:344) → fixed: `state.duplicate` is closed in `afterAll`

#### Checked
repo rules (CLAUDE.md public-repository rule: matched the working spec's real host names and the operator's user name against src, test, README.md, docs and the manifests, no match; the live-test header and README use only placeholders), documented hazards (only the public-repository rule), mechanical: shape conformance (`applied` carries `workitem` and `reason`, parsed against `lifecycle.ts:583-586`; the `refused` and `unverified` shapes are unchanged), completeness honesty, coverage (every branch of `closeWorkItem` has a unit test except an issue that carries both reason labels), cross-boundary contract (the protocol docs' `workitem.close`: a pull request refused before writing via `issueRecord`, a same-reason close `changed:false` with no write, another reason refused as `conflict`, `reason` as read back; matches the GitHub reference `closeWorkItem`), shared-library precedence, logic (`labelledReason` with neither, one or both labels; the open-issue leftover-label refusal; the retry after a label write finds the label and only closes), error handling (`existingLabel` now throws a definitive `ForgejoError` before `submit`, so `runMutation` gives `refused` as `addLabel`'s old `refused` return did; the second `submit('submitted')` moves the phase back from `acknowledged`, but a failed close is caught in place, so only a lost read-back reaches `runMutation`, and that reports `verification_failed` as it should), silent failure, input validation, idempotency and resilience (label first, close second; a lost label write is `outcome_unknown`; a retry is safe), credentials and secrets, security, concurrency (an exclusive `closed/` scope keeps at most one reason label on an issue), external contracts (two writes where the protocol docs say at most one, declared in `### Choices made` and required by the operator's "Record as a label"), resource management, logging and observability, performance (one extra label lookup, two pages, only for `not_planned` and `duplicate`) · issues in: resource management (live-test cleanup) · n/a: shared-library precedence (no shared library), change-type blocks and risk sweep (quick depth) · validation: in-context, 0 HIGH or MED candidates, 0 confirmed, 0 refuted · overlap: whether Forgejo's bulk label add applies exclusive scopes is already unconfirmed in `### Review - cleanup` and is not raised again; the new live test settles it for `closed/duplicate` only when the issue starts with no other `closed/` label

#### Smells
possible Mysterious Name - `labelled` reads as "the issue already carries the label" but means "this call adds the label"; rename it `addsLabel` (src/close.ts:68) → fixed

### Live run

- `bun test --env-file=.env.live test/live.test.ts` against the test repository, 2026-11-18: 9 pass, 0 fail. Acceptance 3 to 9 and stage 8 are now passed.
- Settled: Forgejo's bulk label add applies exclusive scopes (acceptance 4).
- Still open: whether Forgejo answers 404 when deleting a label the item no longer carries (`src/labels.ts` `removeLabel`). No live test reaches it.

### Review - cleanup, second pass

#### Verdict
LOW · introduced - a close whose answer is lost after the reason label was acknowledged reports `verification_failed`, but the protocol's one rule for a write after an earlier acknowledged write says a lost submission is `outcome_unknown` and only a definitive refusal is `verification_failed` (local/archon `docs-web/.../reference/forge.md:116`; the GitHub reference applies it in `adapters/src/forge/github/checks-rerun.ts:240-247`). The same catch also reports a definitive 403 or 404 on the close as kind `invalid_response` with "may be closed", although Forgejo said no and the issue is still open. The `### Choices made` entry for `src/close.ts` declares `verification_failed` without addressing that rule. Both outcomes tell the caller to reconcile, so the harm is a contract mismatch, not a lost write (src/close.ts:88-95). Fix: in the catch, return `outcome_unknown` when the cause is not a definitive `ForgejoError`, and keep `verification_failed` with `leaveBehind: issue N carries <label> and is still open` for a definitive one; or keep the current behaviour and cite forge.md:116 in the Choices entry as a deliberate departure → fixed: a lost close escapes to `runMutation` as `outcome_unknown`; a definitive refusal is `verification_failed` with "is still open"; test/issues.test.ts covers both
LOW · introduced - the module comment of `src/outcome.ts` says "A write submits at most one request", which `workitem.close` no longer meets: it can submit the label add and then the close, and calls `submit('submitted')` a second time after an acknowledgement. A reader of `runMutation` would take the phase model as single-write and miss that the phase can move back from `acknowledged` (src/outcome.ts:4-8). Fix: add one sentence naming `workitem.close` as the exception, where the label write comes before the close and the phase restarts for the close → fixed

#### Checked
repo rules (CLAUDE.md public-repository rule: matched the working spec's real host name against src, test, docs, README.md and the manifests, no match; `.gitignore` keeps `local/`, `CLAUDE.local.md`, `.env*` and `dist/` out), documented hazards (only the public-repository rule), mechanical: shape conformance (`workitem.close` `applied` carries `workitem` and `reason`, parsed by `applied()` against `lifecycle.ts:583-586`; `verification_failed` carries `leaveBehind` and optional `workitem`, matching `mutationFailureSchema` at `lifecycle.ts:468-480`), completeness honesty (`pages`, `listComments` unchanged since the cleanup review), coverage, cross-boundary contract (`closed/not_planned` and `closed/duplicate` named once in `reasonLabels`; the README and live test use the same names; `repo.label.ensure` makes them exclusive under scope `closed`, which the fake's `scope()` models with `lastIndexOf('/')` as Forgejo does), shared-library precedence, logic (`labelledReason` with none, one or both labels; closed same reason, closed other reason, closed by hand as `completed`; open with a leftover label of the same reason, of another reason, or of both; a pull request number refused through `issueRecord` before any write), error handling (`existingLabel` throws a definitive `not_found`/`conflict` before `submit`, so `runMutation` gives `refused`; a lost label POST is `outcome_unknown`; a lost read-back after the close is `verification_failed` from `runMutation`), silent failure, input validation, idempotency and resilience (label first, close second: a retry after any failure point finds the label and only closes, and an already-closed same reason is `changed:false` with no write), credentials and secrets, security (branch and owner segments are `encodeURIComponent`-encoded; no new input reaches a URL in stage 8), concurrency (a concurrent add of the other reason's label to an open issue is dropped by the exclusive scope on this add; with non-exclusive hand-made labels the read-back sees both and reports `verification_failed`), external contracts (forge.md `workitem.close` and "What a write reports", the multi-write rule at forge.md:116), resource management, logging and observability, performance, change-type blocks, risk and omissions (co-change sweep: README "Forgejo differences", live-test header and README live section, `src/workitems.ts` header pointing to `close.ts`, `outcome.ts` header; side effects of sharing `existingLabel` with `workitem.label.add`, whose refusals are unchanged; backward compatibility; tests; dependencies; structural risk; widened flaws), operator intent, cross-stage boundaries (stage 2 labels and stage 8: `existingLabel`, the bulk label POST, exclusive scopes on `status/*` and `closed/*` not interfering; stage 5 workitems and stage 8: `readIssue`/`issueRecord`/`labelNames` shared, `workitem.create` recovery of a closed issue unaffected, `workitem.view` reporting the `closed/*` label the live test reads; stage 1 `runMutation` phases against close's two writes) · issues in: external contracts (lost close after the label), risk and omissions (stale `outcome.ts` comment) · n/a: shared-library precedence (no UI or utilities), change-type blocks (no endpoint, migration or tenancy change), deployment (manual install only), backward compatibility (new plugin, no callers), dependencies (unchanged since cleanup) · intent: no `docs/intent/`; stage 8 is explained by the operator's "Record as a label" in `## Decisions`, so no INTENT line · ran: `bun test test/issues.test.ts`, 14 pass, 0 fail · overlap: two writes against the protocol's "at most one" (stage 8 review, Choices made), the untested both-labels case (stage 8 review, coverage), the `removeLabel` 404 question (Live run), the `workitem.create` full scan (accepted) and the `FORGEJO_URL` override (decided) are not raised again; the first finding is the far side of the declared two-write choice: which outcome the second write's failure reports · validation: none needed, 0 HIGH or MED candidates, 0 confirmed, 0 refuted (run in context: this review is itself a subagent)

#### Smells
possible Duplicated Code - the single-label POST to `/issues/{n}/labels` with `{labels: [id]}` and its acknowledge callback is written twice; export one `attachLabel(api, ref, id, submit)` from src/labels.ts and call it from both (src/close.ts:71-77, src/labels.ts:159-166) → fixed: one `postLabel` in src/labels.ts
possible Mysterious Name - `describe(reason)` formats a reason for a message and reads like the test runner's `describe`; rename it `reasonText` (src/close.ts:34) → fixed

### Cleanup pass, after stage 8

Mode: no-commit; all edits are in the working tree.

- Acceptance: all 12 met, on the evidence in `### Results` and `### Live run`. Line 11 rechecked: the working spec's host and the operator's names match nothing committed except the author's copyright line in `LICENSE`. No undeclared departures.
- Review coverage: `### Review - stages 1…7` and `### Review - stages 8…8` cover all eight stages, each once.
- Review: the stage 8 smell (`labelled`) and `### Review - cleanup, second pass` (2 LOW, 2 smells) are all fixed. A close whose answer is lost is now `outcome_unknown`, as the protocol docs require; the `src/close.ts` entry in `### Choices made` is corrected to match.
- Triage: nothing left for cleanup and no open `decision:`, so no questions.
- Simplify: one comment in `src/close.ts` reworded. Behaviour is unchanged.
- Test gate: no test cut. The stage 8 close tests each cover a separate branch of the `workitem.close` contract. The two new close tests each fail when the branch they guard is broken (checked).
- Verify: `bun run check` exit 0 (Biome clean, `tsc` clean, 95 pass, 11 skip, 0 fail). `bun run build` exit 0: Mach-O arm64 and ELF x86-64 executables. The live suite was not rerun; the outcome change is in an error path the live tests do not reach.
- Still open, carried here: whether Forgejo answers 404 when deleting a label the item no longer carries (`src/labels.ts` `removeLabel`); no live test reaches it. The `workitem.create` full-scan LOW is accepted.
- Retired to `docs/specs/history/`.
