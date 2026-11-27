---
name: getty-bun
description: "Use when a plugin hook fails with a 'getty-bun: ' or 'agent-bun-runtime: ' line, when checking or repairing the shared Bun under ~/.getty/runtimes/bun, or when running getty-bun.sh / getty-bun.ps1 run, run-ready, ensure or status by hand, or setting GETTY_HOME, GETTY_BUN_MIRROR or GETTY_BUN_LOCK_WAIT."
---

# getty-bun

getty-bun is Getty's per-user Bun runtime for agent plugins. A plugin commits two
starters, `bootstrap/getty-bun.sh` (Linux, macOS) and `bootstrap/getty-bun.ps1` (Windows),
each pinned to one exact Bun version, and often the polyglot `bootstrap/getty-bun.cmd`,
which Claude Code hooks dot-source and which hands every call to one of the two. Every
hook calls a starter; it installs that Bun on first use and runs the plugin's bundled
entry with it. There is no `getty-bun` command on PATH and no Bun on PATH involved: the
plugin's starters are the interface. Wiring a plugin: skill `getty-bun-install`; building
an entry: skill `getty-bun-integration`.

## Where the runtime lives

```
<GETTY_HOME>/runtimes/bun/<version>/<target>/bin/bun[.exe]   one immutable slot
<GETTY_HOME>/runtimes/bun/<version>/<target>/receipt.json
<GETTY_HOME>/runtimes/bun/.locks/<version>/<target>/          install lock, .installing
<GETTY_HOME>/runtimes/bun/.staging/<id>/                      installs in progress
```

`GETTY_HOME` defaults to `~/.getty` (Windows: `%USERPROFILE%\.getty`). Targets:
`linux-x64`, `linux-x64-baseline` (no AVX2), `linux-aarch64`, `darwin-x64`,
`darwin-aarch64` (also for a Rosetta shell on Apple silicon), `windows-x64`,
`windows-x64-baseline`. On x64 the starter uses whichever of the `-x64` and the
`-baseline` slot exists, the `-x64` one first, and reads the CPU only when neither does.
Not supported: musl (Alpine), Windows on ARM; the starter fails with a message naming the
target. macOS (from agent-bun-runtime 0.2.0): built and checked on Linux only so far; its
CI legs are pending. Plugins pinned to the same version share one slot;
another version installs beside it. Nothing removes old slots.

## The starter commands

Run from anywhere; the plugin root is the parent of the starter's directory.

```sh
sh <plugin>/bootstrap/getty-bun.sh status          # one JSON line on stdout, never installs
sh <plugin>/bootstrap/getty-bun.sh ensure          # install if missing; nothing on stdout
sh <plugin>/bootstrap/getty-bun.sh run <entry> ... # ensure, then the entry (what hooks call)
sh <plugin>/bootstrap/getty-bun.sh run-ready <entry> ...  # the entry if Bun is ready, else skip
```

`run-ready` is for hooks with a short timeout: with the slot `ready` it is `run`; while
Bun is not installed yet it prints `getty-bun: Bun <version> <target> is not installed yet
(<slot>); run-ready skipped <entry>` on stderr, exits 0 and installs nothing. Such a
plugin installs from another hook (`SessionStart`); `ensure` by hand does the same.

On Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
"<plugin>\bootstrap\getty-bun.ps1" status` (same commands, same output, same exit codes;
keep the quotes, plugin paths often contain spaces).
The pinned version is the `# version` line of the pin block near the top of either file.

`status` prints `{"pin":"1.4.5","target":"linux-x64-baseline","slot":"…","state":"…"}`:

| `state` | Meaning | Next step |
|---|---|---|
| `ready` | Receipt matches pin and target, executable present | Nothing; a failing hook is the entry's problem |
| `missing` | No slot yet | `ensure`, or just wait for the next hook |
| `mismatch` | Something is at the slot path but not this pin's install | Every `run` fails closed; remove the slot directory named in `slot`, then `ensure` |
| `undeclared` | The plugin's pin block has a `# platforms` line without this platform; `target` and `slot` are `null` | Nothing: the plugin does not run here. `run`, `run-ready` and `ensure` exit 0 with one `getty-bun: ` line and install nothing |

A slot is never repaired or overwritten in place: removing it is the repair. The fast path
does not look inside `bin/bun`; a damaged but non-empty binary shows `ready` and fails in
`run`: on Linux with the shell's error (exit 126 or similar), on Windows with
`getty-bun: cannot start <path to bun.exe>: …`, exit 1 (source-checked, not executed).
Remove the slot for that too.

## Environment

| Variable | Effect |
|---|---|
| `GETTY_HOME` | Absolute path replacing `~/.getty`. One value per environment: different values mean separate stores and locks. Tests always set it to a temp dir. |
| `GETTY_BUN_MIRROR` | Base URL instead of GitHub's releases (`<mirror>/bun-v<version>/<archive>`). The pinned SHA256 still decides. |
| `GETTY_BUN_LOCK_WAIT` | Seconds a hook waits for another install's lock (default 300). |

## What a failed hook shows

Two sources of one-line stderr messages, never on stdout (stdout is the hook's JSON):

- `getty-bun: <what failed and where>`, exit 1: the starter itself (install, lock, slot,
  pin). The starter never exits 2 for its own failures. Two `getty-bun: ` lines come with
  exit 0 and are no failure: `run-ready` skipping an entry while Bun is not installed, and
  a platform the pin's `# platforms` line does not list.
- `agent-bun-runtime: <CODE>: <message>`, exit 1, exit 2 when the entry chose
  `onFailure: "closed"`, or exit 0 with nothing on stdout when it chose
  `onFailure: "silent"`: the SDK inside the entry (`HOOK_INPUT_INVALID`,
  `HOOK_EFFECT_INVALID`, `HOOK_EFFECT_UNSUPPORTED`, `HANDLER_FAILED`, `OUTPUT_FAILED`,
  `INTERNAL_ERROR`). The starter passes the entry's exit code through unchanged.

How hosts show them:

- **Claude Code** reports a non-zero exit with stderr verbatim (measured by
  windows-developer). Exit 2 on `PreToolUse` or `UserPromptSubmit` blocks the tool call
  or prompt; exit 1 lets it go on. Exit 2 on `Stop` or `SubagentStop` keeps Claude
  working, and blocks `PreCompact` and `ConfigChange` (documented in Claude Code's hooks
  reference, not executed by agent-bun-runtime): an entry that chose `"closed"` belongs
  on `PreToolUse` or `UserPromptSubmit` only.
- **Codex**, start hooks (`SessionStart`, `SubagentStart`): any non-zero exit fails the
  hook and discards stdout and stderr, so the line is not shown; the session goes on
  unless the hook is configured `onFailure: "block"`. On `UserPromptSubmit` and
  `PreToolUse` exit 2 with stderr blocks, stderr as the reason (source-checked, openai/codex
  `3f65e9f`). To see a hidden message, run the hook line by hand.

## Troubleshooting

Reproduce first: run the starter's `status`, then the hook's own command line by hand with
the same `GETTY_HOME`, and read the `getty-bun: ` line.

- **`timed out after N s waiting for the install lock …`**: another process installs the
  same slot (the message names its `.installing` record). Usually a slow download: wait
  and retry. Never delete `.install.lock`; a dead holder's lock is released by the OS.
  A large `N` needs the host's hook `timeout` above `N` plus one download.
- **`download of … failed`** (offline, proxy, blocked GitHub): connect, or set
  `GETTY_BUN_MIRROR` to a mirror serving the same archives. The partial archive stays in
  `<GETTY_HOME>/runtimes/bun/.downloads/` and the next install resumes it; a checksum
  mismatch deletes it. A slot that is already
  `ready` needs no network: hooks keep working offline.
- **`checksum mismatch …`** or **`version mismatch …`**: the download is not the pinned
  archive (a proxy rewriting it, a wrong mirror). Nothing was published; fix the source,
  never the pin.
- **`slot … does not match the pin …`**: `status` shows `mismatch`. Remove that slot
  directory and run `ensure`.
- **`… not found on PATH`**: the POSIX starter needs `sh`, `curl` or `wget`, `unzip`,
  `sha256sum` or `shasum`, and on Linux `flock` (util-linux), on macOS the system `perl`,
  to install; not to run a ready slot.
- **The entry behaves as if a project setting reached it**: it cannot. The starters run
  `bun --no-install --config=<empty file> --no-env-file <entry>` with `BUN_OPTIONS` and
  the preload, debugger, module-path and code-cache variables removed
  (`BUN_INSPECT_PRELOAD`, `BUN_INSPECT`, `BUN_INSPECT_CONNECT_TO`, `NODE_PATH`,
  `NODE_COMPILE_CACHE`, `BUN_INTERNAL_WEBVIEW_HOST`) and
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH` set to `0`, so the project's `bunfig.toml`, `.env*`
  files and those variables never reach the entry. The same holds for every process the
  entry starts: a `node` or `npm` it runs has no `NODE_PATH` or `NODE_COMPILE_CACHE`, and
  `BUN_INSPECT` debugging does not work through the starter (run the slot's Bun by hand).
  A Bun child process that the entry starts through `process.execPath` must pass the same
  flags and drop the same variables itself.
- **Hook works by hand but not in the host**: compare `GETTY_HOME` and what the default
  store comes from between your shell and the host process: `HOME` on Linux; on Windows
  the profile directory of the account the host runs as (`%USERPROFILE%`), never `HOME`.
  Then check the hook's `timeout` (Claude Code `UserPromptSubmit` defaults to
  30 s, too short for a first install).
