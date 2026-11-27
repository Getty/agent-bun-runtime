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
`.dev/harness/bun` (a link to the main checkout's harness; the `linux-x64-baseline` build, checked against
`bootstrap/versions.json`; agent-lab does have AVX2, and in Bun 1.4.5 the x64 and
x64-baseline binaries are byte-identical); if it is missing, fetch the pinned archive into a fresh
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

Run the suite once more with `sh` resolving to `busybox sh` only with a BusyBox whose
applets do not shadow `unzip` and `uname` on PATH; Debian's `busybox-static` does, and
the installs fail there (card `k60`). The polyglot rows take BusyBox from
`GETTY_BUN_TEST_BUSYBOX`. CI (`.github/workflows/ci.yml`)
adds `shellcheck`, the `ubuntu-24.04-arm` leg, the Windows legs with
`GETTY_BUN_TEST_STARTER=powershell` and `pwsh`, the real download
(`GETTY_BUN_TEST_REAL=1`) and the per-hook cost (`bootstrap/test/measure-hook.ts`).

SDK (phase 2), from the repository root; the harness Bun alone is enough, neither `bun` nor
`node` is needed on PATH (`bunfig.toml` runs tsc's `node` shebang on Bun):

```sh
.dev/harness/bun install --frozen-lockfile
.dev/harness/bun run typecheck
.dev/harness/bun test ./test/      # the ./ matters: a bare test/ also runs bootstrap/test
GETTY_BUN_TEST_GATE=1 GETTY_BUN_TEST_STARTER=sh GETTY_BUN_TEST_NUNJUCKS="$PWD/.dev/njk" \
  .dev/harness/bun test ./test/gate/   # gate; .dev/njk holds node_modules/nunjucks 3.2.4
.dev/harness/bun pm pack --dry-run
```

The gate and the pack leave `dist/` (the prepack build) in the checkout; the gate removes
only its own `abr-gate-` temp dir. Remove `dist/` afterwards. CI adds the `sdk` job
(linux-x64 and `windows-latest`; on Windows the JUnit report must show that the
Windows-only k11 control ran) and the `gate` job (linux-x64 and linux-arm64 with `sh`,
Windows with `powershell` and `pwsh`).
