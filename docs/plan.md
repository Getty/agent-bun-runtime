# agent-bun-runtime: plan

Status: adapted from the handoff on 2026-11-25. Phase 1 (the bootstrap starters in
`bootstrap/`) is complete: merged into `main` at `262bc95` (PR 1), gate green in CI run
45603412444. Phase 2 (the SDK core and the Codex codec) is being built on branch
`phase-2-sdk`; phase 3 onward is not implemented yet.
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
  -> the plugin's bundled TypeScript entry, built on @getty/agent-bun-runtime
```

No Python, Perl or Node in a plugin. One concept for all hooks and binaries.

**Small first, then grow.** The first release carries only what the first consumer
(briefing on Codex) needs, on Linux and Windows. Everything else waits until a consumer
asks for it.

## Parts

| Part | Where it lives | What it is |
|---|---|---|
| Bootstrap | `bootstrap/` here; delivered as the skilletor template `getty-bun-install` in Getty/skills | The two starters, the version table and the pin render |
| `@getty/agent-bun-runtime` | repo root (this package) | The handoff's SDK, cut to the MVP: context, Codex codec, effects, `main()` |
| Consumer 1: briefing | `~/dev/briefing` | Codex only: preloads declared skills into a subagent at `SubagentStart` |
| Consumer 2: skilletor | `~/dev/skilletor` | Already ~10k lines of TypeScript under Node; moves to getty-bun |

## Deviations from the handoff

1. **The starter installs, on demand** ([ADR 0002](adr/0002-install-on-demand.md); exit
   codes and hook timeout: [ADR 0007](adr/0007-starter-rules-after-phase-1.md)).
   Every starter call ensures the pinned Bun before it runs the entry: missing means
   install under the OS lock, present means a fast local check. After a plugin install
   or update the first hook (normally `SessionStart`) installs; concurrent hooks wait,
   bounded, on the same lock. `@getty/agent-bun-runtime` never installs anything.
   Contract v0.2 in `getty-bun-integration` (v0.1 said hooks only point at setup).
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
                                      --config=<empty file> --no-env-file (k29)
getty-bun.sh  ensure                  install if missing; nothing on stdout
getty-bun.sh  status                  one JSON object on stdout: pin, target, slot, state
getty-bun.ps1 <same commands>         identical behavior and exit codes
```

- The consumer root comes from the starter's own path, never from the working directory.
- `<entry>` is relative to the consumer root.
- stdout belongs to the entry (hook JSON); starter messages go to stderr.
- The starter never exits with 2 for its own failures (some hosts read 2 as a block); the
  entry's exit code passes through unchanged, 2 included.
- On Windows an entry's exit code is 0 to 255: Bun 1.4.5 itself exits with the low byte
  of the entry's code, and the starters pass on what Bun exits with (executed, CI
  45589361806; `bootstrap/README.md`, "Limit: exit codes through Git Bash").
- Entry arguments must not begin with `-`: on Windows `-File` hands every argument after
  the script path to PowerShell's own parameter binding, which may re-parse it
  (`bootstrap/README.md`, "Limit: entry arguments").
- The install lock is released before Bun starts, so an entry never holds it (scenario
  2b in `bootstrap/test/scenarios.test.ts`, executed on all four scenario legs, CI
  45603412444).
- `GETTY_HOME` (absolute) overrides the root `~/.getty` or `%USERPROFILE%\.getty`; tests
  always set it. It is one override for a whole environment, not a per-consumer setting:
  two consumers seeing different `GETTY_HOME` values get separate stores and locks, safe
  but not shared.
- `GETTY_BUN_MIRROR` overrides the download base URL. The pinned checksum still decides.
- The lock wait is bounded (default 300 s, `GETTY_BUN_LOCK_WAIT`). It must stay below the
  host hook timeout (Codex and Claude Code document 600 s for most command hooks), and
  consumers set the hook timeout above the lock wait plus one download: a waiter that gets
  the lock after a crashed holder downloads itself.
- Fast path: no network, no hashing, and Bun is not started; the slot's receipt must match
  the pin (version and target) and its executable must be a non-empty file. A slot that
  does not match fails closed with a message; it is never overwritten. `bun --version` is
  compared with the pin only during install, before publish, so a binary replaced after
  publish is not detected by the fast path.
- Open difference from "identical behavior" (card `k19`): `getty-bun.ps1` probes the
  published `bun.exe` a second time after it has released the lock, and fails with exit 1
  if that probe does not pass, leaving the slot as published; the next call takes the
  fast path (source-checked, `bootstrap/getty-bun.ps1:566-572`). `getty-bun.sh` and
  `bootstrap/README.md` have no such second probe.
- Target on the fast path: `getty-bun.sh` detects it on every call (`uname`,
  `/proc/cpuinfo`). `getty-bun.ps1` on x64 does not detect the CPU: it takes the first
  slot that exists of `windows-x64`, then `windows-x64-baseline`; `ready` runs it,
  `mismatch` fails closed (a mismatching `windows-x64` slot is never skipped for a ready
  baseline one). Only when neither exists does it detect AVX2 (`IsProcessorFeaturePresent`
  through `Add-Type`) and install; an x64 Bun whose install probe dies with an illegal
  instruction publishes nothing, and the starter installs `windows-x64-baseline` instead.
  With neither slot present, `status` reports `missing` and the detected target:
  `windows-x64` when AVX2 is reported, else `windows-x64-baseline`, also when the check
  cannot load (Constrained Language Mode, no compiler). Details: `bootstrap/README.md`,
  "Windows starter".

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

## SDK interface (MVP, phase 2)

Decided in phase 2; the API, the error codes and the entry pattern are in
[README.md](../README.md), "The SDK".

- **Package.** `@getty/agent-bun-runtime`, exports `.` and `./codex`, ESM plus
  declarations in `dist/`, built by `tsc` (also as `prepack` of `bun pm pack`); no
  runtime dependencies. `bunfig.toml` makes the `node` of `tsc`'s shebang resolve to Bun,
  so building needs only the pinned Bun (executed on Linux with no Node on `PATH`; not
  checked on Windows, where the CI runners have a Node).
- **`main(options): Promise<number>`** owns the response: it reads stdin, decodes with the
  codec it is given, runs the handler, validates the effect, encodes, writes stdout once
  and returns the exit code; it never calls `process.exit`. The entry does
  `process.exit(await main(...))`. "Process result" in the MVP is this result of `main()`;
  the subprocess helper of the handoff (section 7.3) waits for a consumer (card `k27`).
- **Exit codes.** 0 when the effect was encoded and written; 1 for every SDK failure,
  typed or not, with one stderr line `agent-bun-runtime: <CODE>: <message>` and nothing
  on stdout. The SDK never returns 2 for its own failures and stays within 0–255; the
  starters pass the code through unchanged. Codex discards stdout and stderr of a failed
  start hook (host checks below), so the line is for logs and tests, not for the user.
- **stdin.** One complete JSON object, at most 1 MiB by default; `main()` stops reading
  after it and does not wait for the host to close stdin.
- **stdout.** One function writes the hook output and writes nothing when it is empty
  (Bun 1.4.5 on Windows fails an empty write to a pipe with `EINVAL`, card `k11`).
- **Effects.** `no-decision` and `add-context` (audience `model`, placement
  `session-start-input` or `subagent-input`); the codec rejects what it cannot deliver for
  the event, it never converts an effect. briefing also writes a user-visible
  `systemMessage` on Codex; that effect comes with the 3a port (card `k26`).
- **Pinning before the first release.** `dist/` is not in git, so a consumer that pins a
  git commit (ADR 0006) gets no build unless its installer builds one; decided before
  the 3a port (card `k28`).

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

### Host checks in phases 3a and 3b

Phase 3a measures on real Codex, besides its gate (Windows as a card on the
windows-developer board). The facts below are source-checked in openai/codex `3f65e9f`
(hub `agent-developer`, `docs/windows-referenzen.md`, question 2), not executed:

- **Hook shell.** Codex runs `command` in the session shell of the turn environment with
  `-c`, not as a login shell: `derive_exec_args("", use_login_shell = false)`
  (`codex-rs/core/src/session/mod.rs:6477-6483`; zsh, bash and sh get `-c`,
  `codex-rs/core/src/shell.rs:24-31`). Only without a known session shell, when there is
  no single local turn environment
  (`codex-rs/core/src/environment_selection.rs:1537-1548`), does it fall back to `$SHELL`
  or `/bin/sh` with `-lc` (`codex-rs/hooks/src/engine/command_runner.rs:456-466`).
  Measure which shell a real session uses, whether it reads startup files (zsh reads
  `.zshenv` even without a login), what that costs per hook, and what lands on stdout
  ahead of the entry's hook JSON.
- **stdin.** Codex writes the hook object with `write_all` and drops the stdin handle
  right after, which closes the pipe for a local hook
  (`codex-rs/hooks/src/engine/command_runner.rs:318-327`; traced in phase 2, the closing
  itself is tokio behavior, not read). Codex' own hook tests read stdin to its end
  (`codex-rs/core/tests/suite/subagent_notifications.rs:221,236`). For a hook in a remote
  environment the exec server keeps stdin open, and Codex wraps the command so the hook
  still reaches end of input: under `sh` it pipes the object through `printf '%s'`, under
  PowerShell through `[Console]::In.ReadLine() | <command>`
  (`codex-rs/core/src/hook_environment_executor.rs:182-200`). claude-mem (`4dc8e48`,
  source-checked) reads one complete JSON object because "Codex can keep stdin open". The
  SDK reads one complete object and does not wait for end of input either way
  (phase 2, `README.md`); the starter ends once the entry has ended (scenario 8b in
  `bootstrap/test/scenarios.test.ts`, executed on all four scenario legs, CI 45603412444).
  Measure that a real hook gets end of input on the local path, and what a PowerShell
  pipeline into `powershell.exe` does to non-ASCII bytes on the remote path (derived: it
  re-encodes with `$OutputEncoding`).
- **Exit codes of start hooks.** For `SessionStart` and `SubagentStart` every non-zero
  exit, 2 included, fails the hook: "hook exited with code N", stdout and stderr are
  discarded (`codex-rs/hooks/src/events/session_start.rs:316-330`). The session goes on
  unless the hook is configured with `onFailure: "block"`, which stops the turn
  (`codex-rs/hooks/src/events/common.rs:74-90`). So the SDK's stderr line for its own
  failures (exit 1) is not shown by Codex. Measure how the TUI and `codex exec` report it.
- **Output.** Exit 0 with empty stdout adds nothing; stdout that parses as the hook JSON
  is used; stdout that begins with `{` or `[` but does not parse fails the hook; any
  other text becomes plain context (`session_start.rs:240-313`). Unknown keys reject the
  whole JSON output (`codex-rs/hooks/src/schema.rs:385-425`). Context above about 2,500
  approximate tokens is spilled to a file with only a preview in the model context,
  unless the hook sets `additionalContextLimit: 0`
  (`codex-rs/hooks/src/output_spill.rs:13,65-92`). Measure the shape the SDK writes, the
  spill, and what a byte order mark or stray text ahead of the JSON does (derived: it
  silently becomes plain context).
- **`commandWindows` shell.** Codex runs `commandWindows` in the session shell, by
  default PowerShell (`pwsh`, else `powershell.exe`) as `-NoProfile -Command <line>`,
  otherwise `cmd /C`; there is no exec form. Measure which shell a real desktop uses and
  the per-hook cost of the two PowerShell starts (on the CI runner about 0.5–0.79 s,
  [hook-cost.md](hook-cost.md), "Codex nesting").

Phase 3b: until "Claude Code on Windows" is decided, a plugin for Codex and Claude Code
needs separate hook files. Both hosts read `hooks/hooks.json` by default (documented;
skills `codex-plugin-engineering`, `claude-code-plugin-engineering`). Claude Code merges a
`hooks` path in its manifest with that default file instead of replacing it (documented;
`claude-code-plugin-engineering`, `references/manifest-layout.md`), so it always reads
`hooks/hooks.json`; and Claude Code, which has no `commandWindows`, would run the `sh`
line on Windows, which fails without Git Bash (not measured for this line). The
separation must therefore come from the Codex side: `hooks/hooks.json` holds the Claude
Code hooks, and the Codex hooks live in another file. The Codex manifest can point to
another hook file: a `hooks` entry in the manifest (a path, paths, or inline objects)
replaces the default `hooks/hooks.json` (source-checked, openai/codex `3f65e9f`,
`codex-rs/core-plugins/src/loader.rs:1178-1235`; which manifest file Codex reads it from
is not traced). briefing 0.6.0 already names `hooks/codex-hooks.json` in
`.codex-plugin/plugin.json`.

## Open decisions (owner)

- **Claude Code on Windows (before phase 3b).** Claude Code's `hooks.json` has no
  per-OS field (documented: none among the command hook fields, none in the CHANGELOG),
  so one entry must start on Linux and on Windows alike. Since Claude Code 2.1.139 a hook
  with `args` runs in exec form, spawned without a shell (source-checked,
  `anthropics/claude-code` `4cc5e8b`, `CHANGELOG.md`); without `args` it runs in shell
  form, on Windows in Git Bash, or in PowerShell when Git Bash is not installed
  (documented). Measured by windows-developer (`docs/hook-start-windows.md`, Claude Code
  2.1.287), where Git Bash could not be hidden, so the PowerShell fallback was measured
  with `"shell": "powershell"` as a stand-in; Windows without Git for Windows is not
  measured:
  - Windows-only entries start, such as the exec form `powershell -NoProfile
    -ExecutionPolicy Bypass -File ...` (probe x9), but none serves Linux from the same
    entry.
  - Of the entries that start on Linux and on Windows from one `hooks.json`, two remain
    without Git Bash: the exec form on an extensionless path with a `.exe` next to it
    (probe y1), or a dot-sourced `.cmd` polyglot in shell form (probe q6 under the
    stand-in), which pays a PowerShell start (~720 ms) per hook. Their Linux side was
    not part of these probes.

  Options: a tiny native shim (like winlaunch, built reproducibly with zig, x64 only)
  that runs the slot's Bun directly and calls `getty-bun.ps1` only to install, or the
  polyglot. A shim that starts Bun itself must read the pin block, detect the target
  (AVX2) and check the fast path: a third reader of the pin block beside the two
  starters, which today are the only things that select a version. That is part of this
  decision. Decide with the per-hook cost measured in phase 1
  ([hook-cost.md](hook-cost.md): on the CI runner the starter adds about 0.35–0.52 s over
  Bun; under Codex' PowerShell nesting a hook takes about 0.5–0.79 s in total; real
  desktops are slower).
- **Codex re-trust on updates.** The Codex docs say a plugin update that changes a
  bundled script needs a new hook review, even when the hook definition stays the same.
  Measure in phase 3a what counts as a bundled script (the starter, the entry, both).

## Decided

- Bun pin: 1.4.5 (latest stable, 2026-11-19), confirmed by the owner on 2026-11-25
  ([ADR 0005](adr/0005-bun-pin-and-version-table.md)).
- Distribution of `@getty/agent-bun-runtime`: npm, public, Artistic-2.0
  ([ADR 0006](adr/0006-npm-distribution.md)). The org `getty` exists with the user
  `getty` as owner, so the scope is the owner's; the package's earlier name was free
  on 2026-11-25, the current one was not looked up on the registry (not checked). First
  release by hand after review and the owner's go, then trusted publishing from GitHub
  Actions with provenance, no long-lived token. Until the first release consumers pin a
  git commit.
- Names ([ADR 0008](adr/0008-repository-and-package-name.md), 2026-11-25): repository
  `Getty/agent-bun-runtime`, checkout `~/dev/agent-bun-runtime`, package
  `@getty/agent-bun-runtime` (not published yet). `getty-bun` stays the short name of
  the runtime: the starters, `GETTY_HOME`, `GETTY_BUN_*`, the store and the
  `getty-bun-*` roles and skills.
