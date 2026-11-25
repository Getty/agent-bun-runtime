---
name: getty-bun-core
description: Use when changing getty-bun - the bootstrap starter and installer under bootstrap/, the @getty/bun-runtime SDK, its tests, manifests or plan.
---

# getty-bun core

Two products in one repository. Read [docs/plan.md](../../../docs/plan.md) for the phase
you are in; implement only that phase's gate.

| Path | Product | Runs before Bun exists? |
|---|---|---|
| `bootstrap/` | Starter and installer (`getty-bun.sh`, later `getty-bun.ps1`), version table | **Yes**: POSIX shell plus `curl`/`wget`, `unzip`, `sha256sum`, `flock` only |
| repo root (`src/`, `package.json`, `bun.lock`) | `@getty/bun-runtime` | No: runs on the bound Bun |

## Invariants

- **Exact pin.** A consumer's `package.json` carries `gettyBun.contractVersion` and one
  exact `gettyBun.bunVersion` (`major.minor.patch`, nothing else).
- **Slots.** `~/.getty/runtimes/bun/<version>/<target>/bin/bun`, plus `receipt.json`.
  Locks in `bun/.locks/<version>/<target>/`, staging in `bun/.staging/<id>/` on the same
  filesystem. A published slot is never overwritten.
- **Absolute executable.** Run the validated absolute Bun with `--no-install`. Never PATH,
  a `current` link, `bun upgrade`, `bunx` or a shebang as version selection.
- **Who installs.** Only the starter installs (`ensure`, on `SessionStart` after a plugin
  install or update, and on explicit repair). `@getty/bun-runtime` never installs, fetches
  packages or edits lockfiles, not even in `doctor`.
- **Lock.** One process holds the OS lock (`flock` on Linux) across download, verify and
  publish. `.installing` is diagnostics, not ownership. Never delete a lock because a PID
  looks dead.
- **Integrity.** SHA256 comes from the reviewed version table, never from a file next to
  the archive. Verify before unpacking; the archive must hold exactly the expected member;
  `bun --version` must equal the pin before publishing.
- **Consumer dependencies.** Check that `bun.lock` exists, then
  `bun install --frozen-lockfile` under the consumer's own lock; publish the binding only
  after it passes.
- **Streams.** stdout belongs to the host protocol (hook JSON, MCP). Installer progress
  and diagnostics go to stderr or a log file.
- **No side effects.** No PATH or shell startup edits, no official Bun install script, no
  system packages.

## Evidence

Label every compatibility claim: source-checked, schema-checked, executed (with command,
host version and platform), or not checked. A mocked stdin/stdout test proves the codec,
not the host. Tests never touch the real `~/.getty/runtimes` or `~/.codex`: set `HOME`
and `CODEX_HOME` to a temporary directory.

## Checks

Until code exists there is nothing to run. Once phase 1 and 2 land: `bun test` for the
SDK, the bootstrap test suite under `bootstrap/` against an isolated `HOME`, and
`shellcheck bootstrap/*.sh`. Record the exact commands here when they exist.
