---
name: getty-bun-core
description: Use when changing agent-bun-runtime - the bootstrap starters under bootstrap/, the @getty/agent-bun-runtime SDK, tests, CI or the plan.
---

# getty-bun core

Two products in one repository. Read [docs/plan.md](../../../docs/plan.md) for the phase
you are in and implement only that phase's gate and the MVP column; decisions are in
[docs/adr/](../../../docs/adr/).

| Path | Product | Runs before Bun exists? |
|---|---|---|
| `bootstrap/` | `getty-bun.sh`, `getty-bun.ps1`, `versions.json`, pin render, scenario suite | **Yes**: details in skill `getty-bun-bootstrap` |
| repo root (`src/`, `package.json`, `bun.lock`) | `@getty/agent-bun-runtime` | No: runs on the pinned Bun |

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

No Bun, no `pwsh`, no `shellcheck` installed (2026-11-25). The harness Bun is
`.dev/harness/bun` (this host has no AVX2: the `linux-x64-baseline` build, checked against
`bootstrap/versions.json`); if it is missing, fetch the pinned archive into a fresh
directory under `.dev/`, check its SHA256 against the table and extract `bun` there.
`.dev/` is gitignored. CI on GitHub Actions is the gate for Windows, arm64 and
`shellcheck`; a pwsh 7 for Linux under `.dev/` (run with `HOME` and the XDG dirs in a temp
dir) checks PowerShell syntax only, never 5.1 or Windows behavior.

## Checks

Bootstrap (phase 1), from the repository root:

```sh
.dev/harness/bun bootstrap/test/fetch-fixtures.ts       # real archives into .dev/fixtures, verified
GETTY_BUN_TEST_STARTER=sh .dev/harness/bun test bootstrap/test   # scenarios plus render tests
.dev/harness/bun bootstrap/render-pin.ts --table bootstrap/versions.json --version 1.4.5 \
  --check bootstrap/getty-bun.sh bootstrap/getty-bun.ps1
dash -n bootstrap/getty-bun.sh
```

Run the suite once more with `sh` resolving to `busybox sh`. CI (`.github/workflows/ci.yml`)
adds `shellcheck`, the `ubuntu-24.04-arm` leg, the Windows legs with
`GETTY_BUN_TEST_STARTER=powershell` and `pwsh`, the real download
(`GETTY_BUN_TEST_REAL=1`) and the per-hook cost (`bootstrap/test/measure-hook.ts`). The
SDK checks (`bun test`) arrive with phase 2.
