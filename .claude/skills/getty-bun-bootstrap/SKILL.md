---
name: getty-bun-bootstrap
description: Use when writing, testing or reviewing the getty-bun starters (bootstrap/getty-bun.sh, bootstrap/getty-bun.ps1), the version table, the pin render or the bootstrap scenario suite.
---

# getty-bun bootstrap

The starter is the only thing that installs Bun. It runs before Bun, Node or Python
exist: `getty-bun.sh` needs POSIX `sh`, `curl` or `wget`, `unzip`, `sha256sum` (or
`shasum -a 256`) and `flock`; `getty-bun.ps1` needs Windows PowerShell 5.1 or 7 (skill
`getty-bun-windows`). Interface and scenarios: [docs/plan.md](../../../docs/plan.md),
"Starter interface" and "Phase 1 scenarios".

## Invariants

- **One pin.** The starter carries one rendered pin block: the Bun version and the
  SHA256 per target, generated from `bootstrap/versions.json`. Both starters read the
  same block format; nothing else selects a version.
- **Slots.** `<GETTY_HOME>/runtimes/bun/<version>/<target>/bin/bun[.exe]` plus
  `receipt.json`. Locks in `runtimes/bun/.locks/<version>/<target>/.install.lock`,
  staging in `runtimes/bun/.staging/<id>/` on the same filesystem. `GETTY_HOME`
  defaults to `~/.getty` (Windows: the user profile's `.getty`, not `$HOME`).
- **Publish once.** Stage, verify, then one atomic rename of the whole slot directory,
  receipt included. A published slot is never overwritten or repaired in place; a slot
  that does not match fails closed with a message naming the path.
- **Absolute executable.** Run the slot's Bun by absolute path with `--no-install`.
  Never PATH, a `current` link, `bun upgrade`, `bunx` or a shebang.
- **Lock.** One process holds the OS lock across download, verify and publish (`flock`
  on Linux; `FileShare.None` on Windows). Waiters block, bounded by
  `GETTY_BUN_LOCK_WAIT` (default 300 s), then re-check the slot. `.installing` is
  diagnostics, not ownership. Never delete a lock because a PID looks dead.
- **Integrity.** SHA256 from the pin block, never from a file next to the archive.
  Verify before unpacking; the archive must hold exactly the expected member, extracted
  by name; `bun --version` must equal the pin before publishing.
- **Fast path.** No network, no hashing: receipt present, version and target match,
  executable present. Full verification happens at install.
- **Exit codes.** 0 ready or entry's own code; 1 for every starter failure, with one
  stderr line saying what failed and where. Never 2.
- **Same behavior.** Both starters pass the same scenario suite with the same exit
  codes and the same `status` JSON keys. A difference is a bug in one of them.

## Target detection

Linux: `uname -m` (`x86_64` -> `x64`, `aarch64`/`arm64` -> `aarch64`); `x64` without the
`avx2` flag in `/proc/cpuinfo` -> `x64-baseline`; unreadable -> baseline. musl is not an
MVP target: detect it and fail with a message. Under Git Bash, MSYS or Cygwin
(`uname -s` `MINGW*`, `MSYS*`, `CYGWIN*`) the `sh` starter forwards to the PowerShell
one and does nothing itself.

## Tests

The scenario suite is `bun:test` code that spawns the starter under test: `sh
bootstrap/getty-bun.sh` on POSIX, `powershell` and `pwsh` with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File bootstrap/getty-bun.ps1` on
Windows. The harness Bun is never the Bun under test. Downloads go to a local fixture
server through `GETTY_BUN_MIRROR` (real archive cached, corrupt and extra-member
archives built by the test); one CI job downloads from GitHub.
