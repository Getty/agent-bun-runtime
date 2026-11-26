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
- **Absolute executable.** Run the slot's Bun by absolute path as
  `bun --no-install --config=<empty file> --no-env-file <entry>` (the staging probe:
  `--config=<empty file> --no-env-file --version`), with `BUN_OPTIONS`,
  `BUN_INSPECT_PRELOAD`, `BUN_INSPECT`, `BUN_INSPECT_CONNECT_TO`, `NODE_PATH`,
  `NODE_COMPILE_CACHE`, `BUN_RUNTIME_TRANSPILER_CACHE_PATH` and
  `BUN_INTERNAL_WEBVIEW_HOST` removed from Bun's environment before Bun starts and no
  `cd`. The empty file is `/dev/null` in `getty-bun.sh` and
  `<GETTY_HOME>\runtimes\bun\.config\bunfig.toml` in `getty-bun.ps1`. Why: the hook's
  cwd is the user's project, whose `bunfig.toml`, `.env*` and `BUN_OPTIONS` would
  otherwise reach the entry; the other variables load code or move it outside the
  plugin, and `--config` does not touch them: a preload, the debugger, bare specifiers
  resolved outside the plugin, cache directories whose entries Bun restores as code, a
  macOS webview host that never runs the entry
  ([bootstrap/README.md](../../../bootstrap/README.md), "Starting Bun: no project
  configuration"). Never PATH, a `current` link, `bun upgrade`, `bunx` or a shebang.
- **Lock.** One process holds the OS lock across download, verify and publish (`flock`
  on Linux; `FileShare.None` on Windows). Waiters block, bounded by
  `GETTY_BUN_LOCK_WAIT` (default 300 s), then re-check the slot. `.installing` is
  diagnostics, not ownership. Never delete a lock because a PID looks dead. Close the
  lock descriptor (Windows: dispose the stream) before Bun starts for the entry, so an
  entry never holds the lock (scenario 2b). `getty-bun.sh` has fd 9 open only in the
  install's command group, which ends before the exec of Bun; inside it the download,
  `unzip` and the staging `bun --version` probe run with `9>&-`. `getty-bun.ps1` disposes
  the stream right after publish, before Bun starts again. In both, only the staging
  probe runs Bun while the lock is held.
- **Integrity.** SHA256 from the pin block, never from a file next to the archive.
  Verify before unpacking; the archive must hold exactly the expected member plus the
  directory entries of its parents (Bun's archives carry `bun-<target>/`), extracted by
  name; `bun --version` must equal the pin before publishing.
- **Fast path.** No network, no hashing, no Bun start: receipt present, version and
  target match, executable a non-empty file. Full verification, `bun --version`
  included, happens at install. On Windows x64 the fast path does not detect the CPU
  (below).
- **Exit codes.** 0 when ready; 1 for every starter failure, with one `getty-bun: `
  stderr line saying what failed and where. Never 2 for the starter's own failures;
  `run` passes the entry's code through unchanged, 2 included. On Windows that code is
  0-255: Bun 1.4.5 itself exits with the low byte.
- **Same behavior.** Both starters pass the same scenario suite with the same exit
  codes and the same `status` JSON keys. A difference is a bug in one of them; open:
  the second `bun --version` probe after publish, only in `getty-bun.ps1` (`k19`).

## Target detection

Linux, on every call: `uname -m` (`x86_64` -> `x64`, `aarch64`/`arm64` -> `aarch64`);
`x64` without the `avx2` flag in `/proc/cpuinfo` -> `x64-baseline`; unreadable ->
baseline. musl is not an MVP target: detect it and fail with a message.

Windows (skill `getty-bun-windows`): only `AMD64` is supported. The fast path takes the
first slot that exists of `windows-x64`, then `windows-x64-baseline`; a mismatching one
fails closed, never skipped. Only with neither present does the starter detect AVX2
(`Add-Type`; no answer -> baseline), for an install or `status`. An x64 probe that dies
with an illegal instruction publishes nothing; the baseline then installs under its own
lock. Details: [bootstrap/README.md](../../../bootstrap/README.md), "Windows starter".

Under Git Bash, MSYS or Cygwin
(`uname -s` `MINGW*`, `MSYS*`, `CYGWIN*` or any `*_NT-*`, which covers MSYS2's UCRT64
and CLANG64) the `sh` starter forwards to the PowerShell one and does nothing itself.

## Tests

The scenario suite is `bun:test` code that spawns the starter under test: `sh
bootstrap/getty-bun.sh` on POSIX, `powershell` and `pwsh` with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File bootstrap/getty-bun.ps1` on
Windows. The harness Bun is never the Bun under test. Downloads go to a local fixture
server through `GETTY_BUN_MIRROR` (real archive cached, corrupt and extra-member
archives built by the test); one CI job downloads from GitHub.
