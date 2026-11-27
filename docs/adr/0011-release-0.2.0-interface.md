# 0011: The interface additions of 0.2.0

Status: accepted, 2026-11-27 (owner scope for 0.2.0 relayed by hub `agent-developer`,
hub card `agent-developer k14`; the consumers' part A reports of skilletor, loadguard and
agent-irc and their answers F1–F7, L1–L6, G1–G6). The shapes below are the main
session's design within that scope; where a delivering task finds a shape unworkable, it
reports back instead of changing it silently.

## Context

0.1.0 serves short command hooks on Linux and Windows. Three consumers moving to
getty-bun need more (`docs/release-0.2.0.md`, "For consumers"): a cheap fast path, a hook that never
installs, a silent fail-open, platform declarations, macOS, Claude Code on Windows
([ADR 0010](0010-claude-code-on-windows-cmd-polyglot.md)), `-` arguments on Windows and a
long-lived stdio server under the starter.

## Decision

Starters (both, identical behavior unless a line says otherwise):

1. **Target on the fast path.** `getty-bun.sh` on x64 takes the first slot that exists of
   `<os>-x64`, then `<os>-x64-baseline`, as `getty-bun.ps1` already does; only when
   neither exists does it detect the CPU, with no byte-wise read of `/proc/cpuinfo` in the
   shell. A mismatching `-x64` slot is never skipped for a ready baseline one.
2. **Transpiler cache.** Both starters set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` for Bun
   instead of removing it (`k46`).
3. **`run-ready <entry> [args...]`**, a fourth command: like `run` when the slot is
   `ready`; when it is `missing` it exits 0 with nothing on stdout and one `getty-bun: `
   line on stderr, and installs nothing (no lock, no staging, no network). A `mismatch`
   fails as `run` does.
4. **Download.** An interrupted download is resumed by the next install instead of
   started over; the partial archive lives in the store, under the lock, and a checksum
   mismatch after resuming discards it. A starter killed with SIGKILL leaves no download
   process running.
5. **Entry arguments beginning with `-`** reach the entry unchanged through
   `getty-bun.ps1`, in every supported way of starting it; the rule "entry arguments never
   begin with `-`" is withdrawn.
6. **macOS:** targets `darwin-x64` and `darwin-aarch64` in the version table and both pin
   blocks; `getty-bun.sh` installs them with tools macOS ships.
7. **Platforms.** `gettyBun.platforms` (optional; `linux`, `darwin`, `windows`) declares
   where a consumer runs. It is rendered from `vars.bun_platforms` into one
   `# platforms ...` line of the pin block; without it the block is as before. On a
   platform the block does not list, `run`, `run-ready` and `ensure` exit 0 with nothing
   on stdout and install nothing, and `status` reports the state `undeclared`. The
   consumer's CI checks the line against `package.json` as it checks the version.

SDK:

8. **`onFailure: "silent"`**: every SDK failure ends with exit 0, nothing on stdout and the
   usual single `agent-bun-runtime: <CODE>: <message>` line on stderr.

Contract (skill `getty-bun-integration`):

9. **Entry kind "long-lived stdio server"** beside the command hook: it runs until end of
   input or a signal, stdout carries only its protocol, the starter's isolation flags
   apply, exit codes 0–255, no starter call on `SessionEnd`; a consumer whose MCP server
   runs through the starter adds a `SessionStart` command hook `ensure` with timeout 600.
   It needs no SDK dependency until the SDK has MCP (phase 5).
10. Starting an MCP server under Codex, detached long-lived child processes, and the
    process-tree reach of the variable cleanup are documented (`codex.md`,
    `dependencies-and-execution.md`, `contract.md`).

## Consequences

- `contractVersion` stays 1: every addition is optional, and a 0.1.0 consumer that changes
  nothing keeps its behavior, except that its starters, re-rendered, set the transpiler
  cache variable and take the slot-first fast path.
- The pin block grows by two target lines and, when declared, a platforms line; consumers
  re-render and copy the starters when they move to `v0.2.0`.
- Not in 0.2.0: the Hermes codec, MCP helpers in the SDK, a Windows MCP launcher and the
  job object (`k13`), `k28`.
