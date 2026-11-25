# getty-bun: plan

Status: adapted from the handoff on 2026-11-25. Nothing here is implemented yet.
Source: [handoff/2026-11-25-bun-runtime-handoff.md](handoff/2026-11-25-bun-runtime-handoff.md).
Where this plan and the handoff disagree, this plan wins; the deviations are listed below.

## Goal

Every Getty agent plugin and tool (Claude Code, Codex, Hermes) runs on one chain:

```
host hook / bin entry
  -> starter (getty-bun.sh, later getty-bun.ps1)   no Bun, no Node, no Python needed
  -> absolute Bun from ~/.getty/runtimes/bun/<version>/<target>/bin/bun
  -> TypeScript entry (the plugin's launcher, built on @getty/bun-runtime)
```

No Python, Perl, Node or compiled per-OS binaries in a plugin. One concept for all hooks
and binaries.

## Parts

| Part | Where it lives | What it is |
|---|---|---|
| Bootstrap (the provider) | `bootstrap/` here; delivered as the skilletor template `getty-bun-install` in Getty/skills | Starter plus installer: exact Bun versions, SHA256 per target, OS lock, staging, receipt, consumer dependency setup, binding |
| `@getty/bun-runtime` | repo root (this package) | The handoff's SDK: context, codecs per host, dispatcher, ready commands |
| Consumer 1: briefing | `~/dev/briefing` | Codex only: preloads declared skills into a subagent at `SubagentStart` |
| Consumer 2: skilletor | `~/dev/skilletor` | Already ~10k lines of TypeScript under Node; moves to getty-bun, drops Perl, esbuild, winlaunch and the exe files |

## Deviations from the handoff

1. **Installation happens on plugin install or update** (decision of 2026-11-25). Codex has
   no install hook, so the first `SessionStart` after an install or update runs
   `getty-bun.sh ensure`: install under the OS lock if missing, otherwise a fast check.
   Every other hook waits, bounded, for a running installation, then proceeds or reports.
   The handoff's rule still holds for the SDK itself: `@getty/bun-runtime` never installs
   anything. This needs contract v0.2 in `getty-bun-integration` (v0.1 says hooks only
   point at setup).
2. **The provider is a skilletor template, not a separate CLI.** Each consumer renders
   `getty-bun-install` with its own `vars.bun_version`; the template holds the reviewed
   table of approved versions and checksums. An unknown version fails the render. The
   rendered copy is committed into the plugin's `skills/`. Until skilletor (on Bun) can
   render into a plugin's `skills/`, copy the rendered result by hand and check it in CI.
3. **Bootstrap is developed and tested here**, in `bootstrap/`, and only delivered through
   Getty/skills. A skill directory has no CI.
4. **Host order:** Codex first (briefing), then Claude Code (skilletor), then Hermes
   (skilletor's Hermes part). Handoff phase 3 splits into 3a (Codex) and 3b (Claude Code).
5. **The first complete path is a real consumer:** briefing's `SubagentStart` context
   (effect `add-context`, placement `subagent-input`). Generic ready handlers such as
   `context.from-file` follow when a consumer needs them.
6. **Platforms:** Linux x64 first (including the baseline build for CPUs without AVX2 and
   musl detection), then native Windows (PowerShell, named mutex, `commandWindows`), then
   macOS (no `flock` by default, needs another lock primitive).
7. **Checksums:** Bun publishes `SHASUMS256.txt` and a GPG signature
   `SHASUMS256.txt.asc` with each release (observed for bun-v1.4.5). Adding a version to
   the table means verifying that signature; the starter never trusts a checksum fetched
   next to the archive.

## Phases and gates

| Phase | Build | Gate before moving on |
|---|---|---|
| 0 Boundary | ADRs: repo layout, distribution channel of `@getty/bun-runtime`, Bun pin, contract v0.2 | Decisions recorded; no invented provider commands |
| 1 Bootstrap, Linux | `getty-bun.sh ensure / run / status`, version table, `flock`, staging, receipt, `bun install --frozen-lockfile` under a consumer lock, binding | Isolated `HOME`: fresh install; two parallel installs, one publisher; corrupt slot rejected; wrong Bun on `PATH` ignored; missing `bun.lock` rejected; CI on Ubuntu runs it |
| 2 SDK core and Codex codec | Package, `main(): Promise<number>`, context, typed errors, process result, Codex `SessionStart` / `SubagentStart` decode and encode | Packed tarball installs in a clean consumer and runs offline with the bound Bun |
| 3a briefing on Codex | TypeScript port of the Codex logic of briefing 0.6.0 (`f7968f1`), hooks through the starter, `.codex-plugin/plugin.json` back, CI | Real Codex (0.153.4 here), isolated `HOME` and `CODEX_HOME`: plugin install, hook trust, first session installs Bun, a subagent receives its skills |
| 3b skilletor on getty-bun | Node replaced by getty-bun, Claude Code codec, Perl and binary delivery removed, render target for a plugin's `skills/` | skilletor's hooks run end to end in Claude Code and Codex |
| 4 Windows and macOS bootstrap | `getty-bun.ps1`, named mutex, `commandWindows`; macOS lock | Same gate as phase 1 on each platform |
| 5 Hermes, state, MCP | Hermes shell-hook codec; state backend and MCP companion when a consumer needs them | Handoff phases 4 and 5 |
| 6 Release and upgrade | Handoff phase 6 | Handoff release acceptance |

## Open decisions (owner)

- Distribution of `@getty/bun-runtime`: **npm**, decided 2026-11-25. The npm org `getty`
  exists with the user `getty` as owner, and `@getty/bun-runtime` is still free (404 on
  2026-11-25). Scoped packages default to private: set `publishConfig.access` to
  `public`. This machine has no npm login (`npm whoami`: ENEEDAUTH, no `~/.npmrc`).
  Proposed: first release by hand after review, then trusted publishing from GitHub
  Actions with provenance, no long-lived token.
- License: `LICENSE` is Artistic-2.0 like briefing and skilletor; confirm.
- Bun pin: 1.4.5 is the latest stable (2026-11-19); pick after phase 1 tests.
