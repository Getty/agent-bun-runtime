# getty-bun: plan

Status: adapted from the handoff on 2026-11-25. Phase 1 (the bootstrap starters in
`bootstrap/`) is in progress; phase 2 onward is not implemented yet.
Source: [handoff/2026-11-25-bun-runtime-handoff.md](handoff/2026-11-25-bun-runtime-handoff.md).
Where this plan and the handoff disagree, this plan wins; the deviations are listed below
and recorded as ADRs in [adr/](adr/).

## Goal

Every Getty agent plugin and tool (Claude Code, Codex, Hermes) runs on one chain:

```
host hook / bin entry
  -> starter: getty-bun.sh (Linux, macOS)       no Bun, no Node, no Python needed
              getty-bun.ps1 (Windows, PowerShell 5.1 or 7)
  -> absolute Bun from <GETTY_HOME>/runtimes/bun/<version>/<target>/bin/bun[.exe]
  -> the plugin's bundled TypeScript entry, built on @getty/bun-runtime
```

No Python, Perl or Node in a plugin. One concept for all hooks and binaries.

**Small first, then grow.** The first release carries only what the first consumer
(briefing on Codex) needs, on Linux and Windows. Everything else waits until a consumer
asks for it.

## Parts

| Part | Where it lives | What it is |
|---|---|---|
| Bootstrap | `bootstrap/` here; delivered as the skilletor template `getty-bun-install` in Getty/skills | The two starters, the version table and the pin render |
| `@getty/bun-runtime` | repo root (this package) | The handoff's SDK, cut to the MVP: context, Codex codec, effects, `main()` |
| Consumer 1: briefing | `~/dev/briefing` | Codex only: preloads declared skills into a subagent at `SubagentStart` |
| Consumer 2: skilletor | `~/dev/skilletor` | Already ~10k lines of TypeScript under Node; moves to getty-bun |

## Deviations from the handoff

1. **The starter installs, on demand** ([ADR 0002](adr/0002-install-on-demand.md)).
   Every starter call ensures the pinned Bun before it runs the entry: missing means
   install under the OS lock, present means a fast local check. After a plugin install or
   update the first hook (normally `SessionStart`) installs; concurrent hooks wait,
   bounded, on the same lock. `@getty/bun-runtime` never installs anything. Contract v0.2
   in `getty-bun-integration` (v0.1 said hooks only point at setup).
2. **The provider is a skilletor template** ([ADR 0001](adr/0001-layout-and-delivery.md)).
   Each consumer renders `getty-bun-install` with its own `vars.bun_version`; the
   template holds the reviewed version table. The render writes one pin block (version
   plus SHA256 per target) into both starters; an unknown version fails the render. The
   rendered copy is committed into the plugin. Until skilletor on Bun can render into a
   plugin, copy it by hand and check it in CI.
3. **Consumers ship a bundled entry** ([ADR 0003](adr/0003-bundled-entry.md)). A plugin
   commits `bun build --target=bun` output; its CI rebuilds and compares. User machines
   download exactly one artifact, the pinned Bun, and never run `bun install`. The
   handoff's consumer dependency setup, consumer lock and binding move to phase 5, for
   the first consumer that cannot bundle.
4. **One starter per OS, Windows from phase 1** ([ADR 0004](adr/0004-one-starter-per-os.md)).
   POSIX `sh` for Linux (macOS later), PowerShell for Windows. Under Git Bash, MSYS or
   Cygwin the `sh` starter forwards to the PowerShell one, so a slot has exactly one lock
   implementation. Windows rules: skill `getty-bun-windows`.
5. **Bootstrap is developed and tested here**, in `bootstrap/`, and only delivered through
   Getty/skills. A skill directory has no CI.
6. **Host order:** Codex first (briefing), then Claude Code (skilletor), then Hermes.
   Handoff phase 3 splits into 3a (Codex) and 3b (Claude Code).
7. **The first complete path is a real consumer:** briefing's `SubagentStart` context
   (effect `add-context`, placement `subagent-input`). Ready commands, the dispatcher
   config, state and MCP follow when a consumer needs them.
8. **Checksums** ([ADR 0005](adr/0005-bun-pin-and-version-table.md)): Bun publishes
   `SHASUMS256.txt` and a GPG signature `SHASUMS256.txt.asc` per release (observed for
   bun-v1.4.5). Adding a version to the table means verifying that signature; the starter
   never trusts a checksum fetched next to the archive.

## MVP

| In | Out (later, when a consumer needs it) |
|---|---|
| Starter commands `run`, `ensure`, `status` | `repair`, `gc`, upgrade and rollback commands |
| Targets `linux-x64`, `linux-x64-baseline`, `linux-aarch64`, `windows-x64`, `windows-x64-baseline` | musl, `windows-aarch64`, macOS |
| Lock, staging, atomic publish, receipt, bounded wait | Retention, last-working binding |
| Bundled consumer entry | `bun install --frozen-lockfile` on the user machine, consumer lock |
| SDK: `main()`, context, typed errors, effects `no-decision` and `add-context`, Codex `SessionStart` and `SubagentStart` | Dispatcher config, ready commands, Claude Code and Hermes codecs, state, MCP |

## Starter interface (MVP)

```
getty-bun.sh  run <entry> [args...]   ensure, then exec the absolute Bun with --no-install
getty-bun.sh  ensure                  install if missing; nothing on stdout
getty-bun.sh  status                  one JSON object on stdout: pin, target, slot, state
getty-bun.ps1 <same commands>         identical behavior and exit codes
```

- The consumer root comes from the starter's own path, never from the working directory.
- `<entry>` is relative to the consumer root.
- stdout belongs to the entry (hook JSON); starter messages go to stderr.
- The starter never exits with 2, which some hosts read as a block.
- `GETTY_HOME` (absolute) overrides the root `~/.getty` or `%USERPROFILE%\.getty`; tests
  always set it.
- `GETTY_BUN_MIRROR` overrides the download base URL. The pinned checksum still decides.
- The lock wait is bounded (default 300 s, `GETTY_BUN_LOCK_WAIT`). It must stay below the
  host hook timeout; Codex defaults to 600 s per hook.
- Fast path: no network, no hashing, and Bun is not started; the slot's receipt must match
  the pin (version and target) and its executable must be a non-empty file. A slot that
  does not match fails closed with a message; it is never overwritten. `bun --version` is
  compared with the pin only during install, before publish, so a binary replaced after
  publish is not detected by the fast path.

Interface details fixed at the start of phase 1, so both starters and the scenario suite
code against one definition (the pin block format itself is defined with the render, in
`bootstrap/README.md`):

- **Location.** A consumer carries the starters as `<root>/bootstrap/getty-bun.sh` and
  `<root>/bootstrap/getty-bun.ps1`; the consumer root is the parent of the starter's
  directory.
- **Download URL.** `<base>/bun-v<version>/bun-<target>.zip`, where `<base>` is
  `GETTY_BUN_MIRROR` or `https://github.com/oven-sh/bun/releases/download`.
- **Store.** Slot `<GETTY_HOME>/runtimes/bun/<version>/<target>/` with `bin/bun` (or
  `bin\bun.exe`) and `receipt.json`; lock
  `<GETTY_HOME>/runtimes/bun/.locks/<version>/<target>/.install.lock`; staging
  `<GETTY_HOME>/runtimes/bun/.staging/<id>/`.
- **`status`.** Keys `pin` (the pinned version), `target`, `slot` (absolute path) and
  `state`, one of `ready`, `missing`, `mismatch`. Exit 0 whenever the object was printed;
  1 when the state cannot be determined (for example an unsupported target).
- **Errors.** Every starter failure is one stderr line beginning with `getty-bun: `,
  naming what failed and where, and exit 1. `run` passes the entry's own exit code
  through unchanged.
- **Environment.** `GETTY_HOME` that is set but not absolute is an error.
  `GETTY_BUN_LOCK_WAIT` is a whole number of seconds.

## Phases and gates

| Phase | Build | Gate before moving on |
|---|---|---|
| 0 Boundary | ADRs 0001-0006, contract v0.2 in `getty-bun-integration` | Decisions recorded; no invented provider commands |
| 1 Bootstrap MVP, Linux and Windows | Both starters, version table, pin render, one shared `bun:test` scenario suite run against both, CI matrix | All scenarios green on `ubuntu-latest`, `ubuntu-24.04-arm`, `windows-latest` under `powershell` (5.1) and `pwsh` (7); `shellcheck`; the per-hook cost on Windows measured and recorded |
| 2 SDK MVP and Codex codec | Package, `main(): Promise<number>`, context, typed errors, Codex `SessionStart` and `SubagentStart`, bundling a consumer entry | `bun pm pack` tarball, bundled into a scratch consumer, runs through both starters offline |
| 3a briefing on Codex | TypeScript port of briefing 0.6.0's Codex logic (`f7968f1`), hooks through the starter (`command` plus `commandWindows`), `.codex-plugin/plugin.json` back, CI | Real Codex (0.153.4 here) with isolated `HOME`, `CODEX_HOME` and `GETTY_HOME`: plugin install, hook trust, the first session installs Bun, a subagent receives its skills. Windows: a card on the windows-developer board |
| 3b skilletor on getty-bun | Claude Code codec, Node replaced, render target for a plugin's `skills/`, the Claude Code adapter on Windows (open decision below) | skilletor's hooks run end to end in Claude Code and Codex, on Linux and Windows |
| 4 macOS | `lockf` or another lock primitive, `darwin` targets, CI `macos-latest` | The phase 1 scenarios on macOS |
| 5 Grow on demand | Hermes codec, state backend, MCP companion, consumer dependency install with frozen lockfile and consumer lock | Handoff phases 4 and 5, only for what a consumer needs |
| 6 Release and upgrade | Handoff phase 6 | Handoff release acceptance |

### Phase 1 scenarios (both starters)

Each runs with `GETTY_HOME` in a fresh temporary directory, a `PATH` without Bun, and
downloads from a local fixture server via `GETTY_BUN_MIRROR` (one CI job downloads from
GitHub for real):

1. Fresh install; the second call takes the fast path without network.
2. Two to four parallel `ensure`: exactly one download and one publish; all succeed.
3. A waiter whose lock wait runs out fails with a clear message and no partial slot.
4. A wrong checksum is rejected; nothing is published; staging is cleaned.
5. An archive with an unexpected or extra member is rejected.
6. A published slot whose receipt does not match the pin fails closed and stays untouched;
   an archive whose `bun --version` differs from the pin is rejected at install.
7. A wrong `bun` on `PATH` is ignored.
8. `run`: stdin reaches the entry byte for byte including end of input, stdout comes back
   byte for byte (UTF-8 umlauts), the exit code propagates.
9. `GETTY_HOME` and the consumer root with spaces and non-ASCII characters.
10. Offline after install: `run` works without network.
11. Windows only: Git Bash forwarding uses the same slot and lock as PowerShell.

## Open decisions (owner)

- **Claude Code on Windows (before phase 3b).** Claude Code's `hooks.json` has no
  per-OS field, and without Git Bash only two entries start on Windows (measured by
  windows-developer, `docs/hook-start-windows.md`, Claude Code 2.1.287): the exec form
  on an extensionless path with a `.exe` next to it, or a dot-sourced `.cmd` polyglot in
  shell form, which pays a PowerShell start (~720 ms) per hook. Options: a tiny native
  shim (like winlaunch, built reproducibly with zig, x64 only) that runs the bound Bun
  directly and calls `getty-bun.ps1` only to install, or the polyglot. Decide with the
  per-hook cost measured in phase 1 ([hook-cost.md](hook-cost.md): on the CI runner the
  starter adds about 0.35–0.52 s over Bun; under Codex' PowerShell nesting a hook takes
  about 0.5–0.79 s in total; real desktops are slower).
- **Codex re-trust on updates.** The Codex docs say a plugin update that changes a
  bundled script needs a new hook review, even when the hook definition stays the same.
  Measure in phase 3a what counts as a bundled script (the starter, the entry, both).
- Bun pin: 1.4.5 is the candidate (latest stable, 2026-11-19); confirmed after phase 1.

## Decided

- Distribution of `@getty/bun-runtime`: npm, public, Artistic-2.0
  ([ADR 0006](adr/0006-npm-distribution.md)). The org `getty` exists with the user
  `getty` as owner; the name was free on 2026-11-25. First release by hand after
  review and the owner's go, then trusted publishing from GitHub Actions with
  provenance, no long-lived token. Until the first release consumers pin a git commit.
