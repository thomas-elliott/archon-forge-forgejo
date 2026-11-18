# archon-forge-forgejo

An Archon forge plugin for Forgejo: an executable that speaks Archon's forge protocol 1.

## Public repository

This repository is public. Do not commit personal or site-specific details: real hostnames,
usernames, repository names, tokens, or a description of any particular deployment. Use
placeholders such as `forgejo.example.com` and `owner/repo` in code, tests, docs and commit
messages. Private material lives in `local/` and `CLAUDE.local.md`, which git ignores.

## Tooling

- Bun is pinned in `mise.toml` to the version Archon v0.14.0 builds with.
- `local/archon` is a checkout of Archon `v0.14.0` (commit `8def159`), the source of the protocol
  schemas and the reference GitHub plugin. Recreate it with:
  `git clone --depth 1 --branch v0.14.0 https://github.com/coleam00/Archon.git local/archon`
