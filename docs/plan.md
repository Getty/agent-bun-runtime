# agent-bun-runtime: plan

Status: adapted from the handoff on 2026-11-25. Phase 1 (the bootstrap starters in
`bootstrap/`) is complete: merged into `main` at `262bc95` (PR 1), gate green in CI run
45603412444. Phase 2 (the SDK core and the Codex codec) is complete: merged into `main`
at `0bc8218` (PR 2), gate green in CI run 45885263188. Phase 2b (the Claude Code codec,
the consumer skills and release 0.1.0, [ADR 0009](adr/0009-first-release-claude-code-and-consumer-skills.md))
is complete: merged into `main` at `4f9c556` (PR 3) and `b577af7` (PR 4), gate green in
CI runs 45907098883 (pull request) and 45908923306 (`main`), and released as 0.1.0 (tag
`v0.1.0`, npm). Release 0.2.0 (what skilletor, loadguard and agent-irc need, section
"Release 0.2.0" below, [ADR 0010](adr/0010-claude-code-on-windows-cmd-polyglot.md) and
[ADR 0011](adr/0011-release-0.2.0-interface.md)) is being built on branch `next-0.2.0`.
Phase 3 onward is not implemented yet; 0.2.0 takes the macOS part of phase 4.
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

**Small first, then grow.** The first release, 0.1.0, carries only what the consumers
asking for it use today (loadguard, skilletor and briefing; Codex and Claude Code), on
Linux and Windows ([ADR 0009](adr/0009-first-release-claude-code-and-consumer-skills.md)).
Everything else waits until a consumer asks for it.

## Parts

| Part | Where it lives | What it is |
|---|---|---|
| Bootstrap | `bootstrap/` here; delivered as the skilletor template `getty-bun-install` in `skills/` here | The two starters, the version table and the pin render |
| `@getty/agent-bun-runtime` | repo root (this package), on npm from 0.1.0 | The handoff's SDK, cut to the MVP: context, the Codex and Claude Code codecs, effects, `main()` |
| Consumer skills | `skills/` here, installed with skilletor pinned to the release tag | `getty-bun` (use), `getty-bun-integration` (engineering, the contract), `getty-bun-install` (the template) |
| Consumer: skilletor | `~/dev/skilletor` | Claude Code and Codex hooks; ~10k lines of TypeScript under Node; moves first after 0.1.0 |
| Consumer: loadguard | `~/dev/loadguard` | Claude Code and Codex guard: context on `SessionStart` and `UserPromptSubmit`, `deny` on `PreToolUse` |
| Consumer: agent-irc | `~/dev/agent-irc` | Observes 13 events through `mcp_tool` hooks into its own MCP server; no command hook, so no codec on its path |
| Consumer: briefing | `~/dev/briefing` | Codex only: preloads declared skills into a subagent at `SubagentStart` |

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
   POSIX `sh` for Linux (macOS from 0.2.0), PowerShell for Windows. Under Git Bash, MSYS or
   Cygwin the `sh` starter forwards to the PowerShell one, so a slot has exactly one lock
   implementation. Windows rules: skill `getty-bun-windows`.
5. **Bootstrap is developed and tested here**, in `bootstrap/`, and delivered through the
   template `getty-bun-install` in `skills/` here, with CI
   ([ADR 0009](adr/0009-first-release-claude-code-and-consumer-skills.md)).
6. **Host order:** the first release carries the Codex and the Claude Code codec (phase
   2b, [ADR 0009](adr/0009-first-release-claude-code-and-consumer-skills.md)); Hermes
   later. Handoff phase 3 splits into 3a (briefing on Codex) and 3b (skilletor on
   getty-bun).
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
| Targets `linux-x64`, `linux-x64-baseline`, `linux-aarch64`, `windows-x64`, `windows-x64-baseline`; from 0.2.0 `darwin-x64`, `darwin-aarch64` | musl, `windows-aarch64`, `darwin-x64-baseline` |
| Lock, staging, atomic publish, receipt, bounded wait | Retention, last-working binding |
| Bundled consumer entry | `bun install --frozen-lockfile` on the user machine, consumer lock |
| SDK: `main()`, context, typed errors, effects `no-decision`, `add-context`, `tool-permission`, `tool-input`, `notify-user`, combined effects, failure policy, the Codex and Claude Code codecs for the consumers' events | Dispatcher config, ready commands, Hermes codec, state, MCP |

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
- Entry arguments pass through unchanged, those beginning with `-` included, from 0.2.0
  (`getty-bun.ps1` reads its process's argument vector after `-File` instead of `$args`;
  ADR 0011). 0.1.0 forbade them because `-File` hands every argument to PowerShell's
  parameter binding. A lone `--` as the first entry argument is consumed by Bun itself.
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
  fast path (source-checked, `bootstrap/getty-bun.ps1:675-681`). `getty-bun.sh` and
  `bootstrap/README.md` have no such second probe.
- Target on the fast path: from 0.2.0 `getty-bun.sh` on x64 takes the first slot that exists
  of `<os>-x64`, then `<os>-x64-baseline`, and reads `/proc/cpuinfo` only when neither
  exists (before 0.2.0 it detected on every call). `getty-bun.ps1` on x64 does not detect the CPU: it takes the first
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
[README.md](../README.md), "The SDK". Phase 2b changed parts of it (a third export
`./claude-code`, exit 2 with `onFailure: "closed"`, more effects): the section
"SDK interface for 0.1.0" below wins where they differ.

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
  `systemMessage` on Codex; that effect came with phase 2b (card `k26`).
- **Pinning.** Consumers take the package from npm, from 0.1.0 on, never a git commit:
  `dist/` is not in git ([ADR 0009](adr/0009-first-release-claude-code-and-consumer-skills.md);
  card `k28` stays open for a later need).

## SDK interface for 0.1.0 (phase 2b)

Decided in [ADR 0009](adr/0009-first-release-claude-code-and-consumer-skills.md); the API
is in [README.md](../README.md), "The SDK".

- **Codecs** `@getty/agent-bun-runtime/codex` and `@getty/agent-bun-runtime/claude-code`;
  `HookCodec` is opaque, plugins pick a codec and do not implement one. The host is
  passed explicitly (the entry's argument or one entry per host), never guessed from
  the environment.
- **Unknown events** decode generically; only `no-decision` encodes for them.
- **Effects** add `add-context` at `prompt-input` and `tool-result`, `tool-permission`
  and `tool-input` for `PreToolUse`, and `notify-user` (`systemMessage`, `k26`); a
  handler may return several effects, at most one per kind, merged into one output; a
  codec rejects what its host cannot deliver.
- **Failure policy** `onFailure: "open"` (exit 1, default) or `"closed"` (exit 2, a block
  on `PreToolUse` and `UserPromptSubmit` in both hosts). The SDK returns 2 only when the
  entry chose `"closed"`.
- **Open unions:** `HostKind`, `HostSurface`, `ContextPlacement`, the effect kinds and
  `ErrorCode` may grow in a minor release. The envelope carries `envelopeVersion: 1`.

## Phases and gates

| Phase | Build | Gate before moving on |
|---|---|---|
| 0 Boundary | ADRs 0001-0006, contract v0.2 in `getty-bun-integration` | Decisions recorded; no invented provider commands |
| 1 Bootstrap MVP, Linux and Windows | Both starters, version table, pin render, one shared `bun:test` scenario suite run against both, CI matrix | All scenarios green on `ubuntu-latest`, `ubuntu-24.04-arm`, `windows-latest` under `powershell` (5.1) and `pwsh` (7); `shellcheck`; the per-hook cost on Windows measured and recorded |
| 2 SDK MVP and Codex codec | Package, `main(): Promise<number>`, context, typed errors, Codex `SessionStart` and `SubagentStart`, bundling a consumer entry | `bun pm pack` tarball, bundled into a scratch consumer, runs through both starters offline |
| 2b Claude Code codec, consumer skills, 0.1.0 | Starters ignore the project's Bun config (`k29`); Claude Code codec and the Codex events the consumers use; `tool-permission`, `tool-input`, `notify-user` with combined effects, failure policy; skills `getty-bun`, `getty-bun-integration`, `getty-bun-install` in `skills/`; release checklist | The phase 2 gate run from a hostile project directory, plus Claude Code payloads through both starters and a scratch plugin rendered from `getty-bun-install` whose starter runs a hook; all CI legs green; both reviewers |
| 3a briefing on Codex | TypeScript port of briefing 0.6.0's Codex logic (`f7968f1`), hooks through the starter (`command` plus `commandWindows`), `.codex-plugin/plugin.json` back, CI | Real Codex (0.153.4 here) with isolated `HOME`, `CODEX_HOME` and `GETTY_HOME`: plugin install, hook trust, the first session installs Bun, a subagent receives its skills. Windows: a card on the windows-developer board |
| 3b skilletor on getty-bun | Node replaced, render target for a plugin's `skills/`, the Claude Code adapter on Windows (decided: [ADR 0010](adr/0010-claude-code-on-windows-cmd-polyglot.md)) | skilletor's hooks run end to end in Claude Code and Codex, on Linux and Windows |
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

## Release 0.2.0

Scope set by the owner on 2026-11-27 (hub card `agent-developer k14`), from the part A
reports of the three consumers moving to getty-bun. One card per item on this
repository's board; decisions in [ADR 0010](adr/0010-claude-code-on-windows-cmd-polyglot.md)
and [ADR 0011](adr/0011-release-0.2.0-interface.md). The details below are what the
starters, the SDK and the suites code against; a delivering task that finds one
unworkable reports back instead of changing it.

**Starters.**

1. *Fast target.* `getty-bun.sh` on x64: the first slot that exists of `<os>-x64`, then
   `<os>-x64-baseline` (`ready` runs it, `mismatch` fails closed, a mismatching `-x64` slot
   is never skipped for a ready baseline one); CPU detection only when neither exists,
   without a byte-wise `read` loop over `/proc/cpuinfo`. `status` with neither slot
   reports `missing` and the detected target. Goal: the starter's own cost back near the
   5–6 ms of [hook-cost.md](hook-cost.md) on Linux (loadguard measured 26 ms of 39 ms in
   `has_avx2` on agent-lab).
2. *Transpiler cache* (`k46`). Both starters export `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`
   to Bun (the staging probe included) instead of unsetting it. Evidence: skilletor
   part A §2.4 (Bun writes `@t@/*.pile` into the user's cache for a non-bundled entry;
   93 conformance failures), loadguard P6 and agent-irc 3.4 (a `// @bun` bundle writes
   nothing either way).
3. *`run-ready <entry> [args...]`.* Slot `ready`: exactly `run`. `missing`: exit 0, nothing
   on stdout, one stderr line
   `getty-bun: Bun <version> <target> is not installed yet (<slot>); run-ready skipped <entry>`,
   no lock, no staging, no download. `mismatch`, an invalid environment or an unsupported
   target: as `run`. The x64 slot choice of item 1 applies. *No orphan download:* a starter
   killed with SIGKILL during a download leaves no `curl`/`wget` it started running for
   more than about two seconds. *Resume:* the archive downloads to
   `<GETTY_HOME>/runtimes/bun/.downloads/<version>/<target>/<archive>.part`, only under the
   install lock; an interrupted install (signal, kill, timeout, network error) keeps it,
   the next install resumes it (HTTP range; a server that answers without one starts the
   file over), and a checksum mismatch after the download deletes it before the failure.
   Staging of the slot itself is unchanged. `getty-bun.ps1` follows (it downloads in
   process, so it has no child to orphan).
4. *`-` arguments in `getty-bun.ps1`* (skilletor F4). Every entry argument, also `-x`,
   `-x:foo`, `--`, `-`, `--%` and `-File`, reaches the entry byte for byte when the starter
   is started with `powershell.exe`/`pwsh` `-File` (Codex `commandWindows`), through the
   Git Bash forwarding and through the polyglot (item 6). Then
   `getty-bun-integration` `contract.md` ("Entry arguments never begin with `-`") is
   rewritten to the rule that holds. Narrowed on 2026-11-27 after CI runs 46027293350 and
   46031834399 (main session's decision): PowerShell's `-File` itself rejects some
   arguments before the script runs (Windows PowerShell 5.1: a lone `-`; pwsh 7: `-:foo`),
   so on Windows no lone `-` and nothing beginning with `-:`; through the polyglot from a
   PowerShell hook shell the outer PowerShell also drops `--%` and splits an argument
   that begins with `-` and contains a blank. Every other argument (`-x`, `-x:foo`, `--`,
   `-File`, ...) is passed; `contract.md` holds the rule and its evidence.
5. *macOS* (`k4`). Targets `darwin-x64` (`bun-darwin-x64.zip`) and `darwin-aarch64`
   (`bun-darwin-aarch64.zip`) in `bootstrap/versions.json` for 1.4.5, their SHA256 checked
   against the signed `SHASUMS256.txt.asc` (ADR 0005); `getty-bun.sh` detects them
   (`uname -s` Darwin; a Rosetta shell on Apple silicon still selects `darwin-aarch64`),
   locks with a primitive macOS ships (no `flock` there), hashes with `shasum -a 256`. No
   `darwin-x64-baseline`: the macOS versions Bun 1.4.5 supports run only on Macs with
   AVX2 (to be confirmed by the worker, else reported). CI legs on macOS for the
   scenarios, the gate and the per-hook cost.
6. *`.cmd` polyglot* ([ADR 0010](adr/0010-claude-code-on-windows-cmd-polyglot.md)).
   `bootstrap/getty-bun.cmd`, delivered through `getty-bun-install` (no pin in it, so the
   template copies it unchanged); Claude Code hook in shell form, dot-sourcing it. Checked
   in the suite on Linux and macOS (the shells Claude Code uses there) and on the Windows
   legs (PowerShell 5.1, 7, Git Bash).
7. *Platforms.* `vars.bun_platforms` (a list of `linux`, `darwin`, `windows`; anything else
   fails the render) adds one line `# platforms <p> [<p>...]` after `# version` in the pin
   block of both starters; without it the block is unchanged. `render-pin.ts` takes the
   same list. A starter whose platform (`linux`, `darwin`; `windows` for `getty-bun.ps1`
   and the Git Bash forwarding) is not listed: `run`, `run-ready` and `ensure` exit 0,
   nothing on stdout, one `getty-bun: ` line on stderr, no target detection, no download;
   `status` prints `{"pin":"<v>","target":null,"slot":null,"state":"undeclared"}` and exits
   0. The schema gets `platforms` (unique items from that enum, at least one); the
   consumer's CI compares the line with `gettyBun.platforms` (`getty-bun-install`, "Check
   the copy in CI").

**SDK.** 8. `onFailure: "silent"`: every SDK failure (input, handler, effect, encoding)
returns exit 0, writes nothing to stdout and the one `agent-bun-runtime: <CODE>: <message>`
line to stderr. `"open"` (exit 1) stays the default, `"closed"` (exit 2) unchanged.

**Contract and docs** (skills `getty-bun-integration`, `getty-bun`, `getty-bun-install`):
9. the long-lived stdio server entry kind (ADR 0011) with a scenario in
`bootstrap/test` (the starter execs Bun under the same PID; stdout carries only the
entry's bytes, also during a first install; end of input and SIGINT, SIGTERM, SIGHUP
reach the entry; exit code passes through); 10. MCP start under Codex in `codex.md` (no
plugin root, no `CODEX_HOME` at the server, the locator belongs to the consumer); 11.
detached long-lived children (session, nice, file descriptors, RSS) in
`dependencies-and-execution.md`; 12. `k47` and `k48`.

**Repository.** 13. `k43`; 14. the publish workflow for trusted publishing (npm CLI
11.5.1 or later, Node 22.14.0 or later; 0.2.0 is its first publish, in the order of
[release-0.1.0.md](release-0.1.0.md), "After the release"); 15.
[release-0.2.0.md](release-0.2.0.md) with the consumers' move from `v0.1.0`.

**Rework after the hub review** (2026-11-27, hub card `agent-developer k14`, review
`abr-0.2.0.review.md` V1–V4, H1–H11, and the hub's Claude Code probe: every end of an MCP
server before `initialize` completes, timeout or a quick exit 0 alike, blocks the server for
about 15 minutes in Claude Code 2.1.332; the MCP start runs in parallel to `SessionStart`).

*`run-mcp <entry> [args...]`* (`getty-bun.sh`), the starter mode for a long-lived stdio
(MCP) server. The name follows `run-ready`: a `run` variant named after when it runs.

- Slot `ready` and `<root>/<entry>` a readable regular file: exactly `run` (same `exec`,
  PID, flags, environment).
- Slot `missing`: no install of its own (no lock, staging or download). It waits for the
  slot a `SessionStart` `ensure` is installing, polling the slot state about every 0.25 s,
  for at most `GETTY_BUN_MCP_WAIT` seconds (whole number, default 20, below both hosts'
  30 s); ready within the wait: `exec` as above.
- Every other way (still missing after the wait, `mismatch`, an invalid `GETTY_HOME`,
  `GETTY_BUN_LOCK_WAIT` or `GETTY_BUN_MCP_WAIT`, a missing or broken pin, an unsupported or
  undeclared platform, a missing entry argument, a `<root>/<entry>` that is no readable
  regular file once the slot is ready, after the wait too, where Bun would exit 1) never
  ends before `initialize`. The starter writes one `getty-bun: ` line with the reason to
  stderr and becomes a **stub server** (POSIX tools only, for example `awk`; no Bun):
  - stdout carries only JSON-RPC, one message per line, flushed per line;
  - every message with an `id` gets a response with that `id` verbatim (number or string;
    Claude Code first sends `server/discover` with `"server-discover-probe-1"`); only the
    top-level `id` and `method` count, an `"id"` inside `params` never does, whatever the
    key order;
  - `initialize`: `protocolVersion` as the client asked, `capabilities: {"tools": {}}`,
    `serverInfo: {"name": "getty-bun-stub", "version": "<pin>"}`, `instructions` naming the
    reason and that the server is there from the next session; `tools/list` →
    `{"tools": []}`; `tools/call` → `{"content": []}`; `ping` → `{}`; anything else with an
    `id` → error `-32601`; notifications get no response; a line it cannot read is
    ignored;
  - end of input → exit 0; a signal → it ends within 0.5 s, by that signal or with
    128 + n; the first signal counts (two different signals at the same instant may be handled in
    signal-number order). Signals during the wait end it the same way.
- Windows: `getty-bun.ps1 run-mcp` (and the Git Bash forwarding) fails with one
  `getty-bun: ` line, exit 1: MCP servers through the PowerShell starter belong to `k13`.
- Consumers: server line `sh "${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh" run-mcp <entry>
  <host>` plus the `SessionStart` `ensure` hook with timeout 600; session 1 has the real
  server only if that install finishes within the wait. Codex: `env_vars: ["GETTY_HOME",
  "GETTY_BUN_MIRROR"]` in the server declaration. The entry itself answers `initialize`
  before doing anything that can fail.

Staging cleanup (review H1) is card `k64`, for 0.3.0.

Not in 0.2.0: the Hermes codec, MCP helpers in the SDK, a Windows MCP launcher and the job
object (`k13`), `k28`.

## Open decisions (owner)

- **Claude Code on Windows** was decided on 2026-11-27: a dot-sourced `.cmd` polyglot in
  shell form ([ADR 0010](adr/0010-claude-code-on-windows-cmd-polyglot.md)), see
  "Decided". The measurements it rests on: windows-developer `docs/hook-start-windows.md`
  (Claude Code 2.1.287; probes x9, y1, q6) and [hook-cost.md](hook-cost.md).
- **Codex re-trust on updates.** The Codex docs say a plugin update that changes a
  bundled script needs a new hook review, even when the hook definition stays the same.
  Measure in phase 3a what counts as a bundled script (the starter, the entry, both).

## Decided

- Claude Code on Windows: the `.cmd` polyglot, option (b) of skilletor F2, owner,
  2026-11-27 ([ADR 0010](adr/0010-claude-code-on-windows-cmd-polyglot.md)).
- Bun pin: 1.4.5 (latest stable, 2026-11-19), confirmed by the owner on 2026-11-25
  ([ADR 0005](adr/0005-bun-pin-and-version-table.md)).
- Distribution of `@getty/agent-bun-runtime`: npm, public, Artistic-2.0
  ([ADR 0006](adr/0006-npm-distribution.md)). The org `getty` exists with the user
  `getty` as owner, so the scope is the owner's; `@getty/agent-bun-runtime` was free on
  the registry on 2026-11-26 (registry 404, looked up by the hub). First
  release by hand after review and the owner's go, then trusted publishing from GitHub
  Actions with provenance, no long-lived token. Consumers take the package from npm, not
  a git commit ([ADR 0009](adr/0009-first-release-claude-code-and-consumer-skills.md)).
- Names ([ADR 0008](adr/0008-repository-and-package-name.md), 2026-11-25): repository
  `Getty/agent-bun-runtime`, checkout `~/dev/agent-bun-runtime`, package
  `@getty/agent-bun-runtime` (on npm since 0.1.0; release checklist:
  [release-0.1.0.md](release-0.1.0.md)). `getty-bun` stays the short name of
  the runtime: the starters, `GETTY_HOME`, `GETTY_BUN_*`, the store and the
  `getty-bun-*` roles and skills.
