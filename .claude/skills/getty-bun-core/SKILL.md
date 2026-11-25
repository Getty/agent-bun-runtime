---
name: getty-bun-core
description: Use when changing getty-bun - the bootstrap starters under bootstrap/, the @getty/bun-runtime SDK, tests, CI or the plan.
---

# getty-bun core

Two products in one repository. Read [docs/plan.md](../../../docs/plan.md) for the phase
you are in and implement only that phase's gate and the MVP column; decisions are in
[docs/adr/](../../../docs/adr/).

| Path | Product | Runs before Bun exists? |
|---|---|---|
| `bootstrap/` | `getty-bun.sh`, `getty-bun.ps1`, `versions.json`, pin render, scenario suite | **Yes**: details in skill `getty-bun-bootstrap` |
| repo root (`src/`, `package.json`, `bun.lock`) | `@getty/bun-runtime` | No: runs on the pinned Bun |

## Rules for both

- **Small first.** Build what the plan's MVP lists. Anything else goes to a card, not
  into the code.
- **Streams.** stdout belongs to the host protocol (hook JSON). Diagnostics go to stderr.
- **Bundle-friendly SDK.** ESM, no dynamic requires, no reads of its own package files
  at runtime: consumers bundle it (ADR 0003).
- **Isolation.** Tests set `GETTY_HOME` (and `HOME`, `CODEX_HOME` where a host is
  involved) to a fresh temporary directory. Never touch the real `~/.getty`, `~/.codex`
  or `~/.claude`.
- **No side effects** on the developer machine: no system packages, no PATH or profile
  edits, no official Bun install script.

## Evidence

Label every compatibility claim: source-checked, schema-checked, executed (with command,
host version and platform), or not checked. A mocked stdin/stdout test proves the codec,
not the host. A claim about Windows needs a run on Windows (CI `windows-latest` or the
windows-developer hub); this machine has no PowerShell.

## Tooling on this machine

No Bun, no `pwsh`, no `shellcheck` (2026-11-25). For a local harness Bun, run the
starter itself with `GETTY_HOME=<repo>/.dev/getty` once it exists; before that, fetch the
pinned archive into `.dev/` and check its SHA256 against `bootstrap/versions.json`.
`.dev/` is gitignored. CI on GitHub Actions is the gate for Windows, arm64 and
`shellcheck`.

## Checks

Until code exists there is nothing to run. Record the exact commands here when they
exist (expected: `bun test` for the SDK, `bun test bootstrap/test` for the scenario
suite, `shellcheck bootstrap/getty-bun.sh`).
