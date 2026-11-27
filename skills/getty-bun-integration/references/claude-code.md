# Claude Code adapter

Claude Code is served by the codec `@getty/agent-bun-runtime/claude-code`, the POSIX
starter and, for a plugin that runs on Windows too, the polyglot `getty-bun.cmd`. The
codec is **doc-checked** against the hooks reference
(https://code.claude.com/docs/en/hooks, fetched 2026-11-26) and **source-checked** against
the bundled JavaScript of `@anthropic-ai/claude-code` 2.1.332 (never run), with line and
byte offset in agent-bun-runtime `src/claude-code.ts`. **Executed** only through payloads
loadguard recorded on Claude Code 2.1.283, which the codec's fixtures reuse; no real
Claude Code has run the codec or a starter hook from agent-bun-runtime. Read
[contract.md](contract.md) for the declaration and the starter interface, [sdk.md](sdk.md)
for the entry.

## Contents

- [Run hooks through the starter](#run-hooks-through-the-starter)
- [What the codec delivers](#what-the-codec-delivers)
- [Hot hooks: run-ready and silent guards](#hot-hooks-run-ready-and-silent-guards)
- [Exit codes in Claude Code](#exit-codes-in-claude-code)
- [Windows: the dot-sourced polyglot](#windows-the-dot-sourced-polyglot)
- [MCP servers](#mcp-servers)
- [Optional repair hint](#optional-repair-hint)
- [Review activation and validate](#review-activation-and-validate)

## Run hooks through the starter

`hooks/hooks.json` of a plugin that serves Claude Code on Linux and macOS only (on Windows
too: [the polyglot line](#windows-the-dot-sourced-polyglot)); shape not executed under
Claude Code:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run dist/hook.js claude-code",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

Exec form, without a shell (Claude Code 2.1.139 or later; `sh` resolved on PATH, no
quoting): `"command": "sh", "args": ["${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh", "run",
"dist/hook.js", "claude-code"]`. Either `sh` line stays the line for a Linux/macOS-only
plugin: it needs neither the polyglot nor its dash workaround.

- The trailing `claude-code` names the host for an entry that serves Codex too
  ([sdk.md](sdk.md), "The entry"). Claude Code always reads `hooks/hooks.json`; Codex
  hooks go into a file of their own ([codex.md](codex.md)).
- Set `timeout` explicitly on every starter hook that may install (`run`, `ensure`),
  above `GETTY_BUN_LOCK_WAIT` (default 300 s) plus one download; 600 is illustrative.
  Documented ("Common fields"): command hooks default to 600 s, lowered to 30 s on
  `UserPromptSubmit`, `PreModelSwitch` and `PostModelSwitch` and to 10 s on
  `MessageDisplay`: too short for a first install. A hook that must stay short calls
  `run-ready` instead ([below](#hot-hooks-run-ready-and-silent-guards)).
- Never put a starter call on `SessionEnd`: its hooks share a 1.5 s budget, and a timeout
  set on a plugin-provided hook does not raise it (documented, "SessionEnd").
- Quote `"${CLAUDE_PLUGIN_ROOT}"` in shell form. Measured by windows-developer (Git Bash
  shell form): unquoted, a path with spaces breaks with exit 127; quoted, it survives.
- Matching hooks run concurrently (documented); neither array order nor a prompt hook is a
  setup barrier. The starter's lock is: after a plugin install or update the first hooks
  wait on it and exactly one downloads (starter side executed, scenario 2; under Claude
  Code not checked).
- Measured by windows-developer: Claude Code passes stdout through unchanged and reports
  a non-zero exit with stderr verbatim.
- No hook requires a Bun on PATH, and there is no separate install hook, except the
  `SessionStart` `ensure` of a plugin whose MCP server runs through the starter
  ([MCP servers](#mcp-servers)).
- The `systemMessage` of a hook declared `"async": true` goes to Claude on the next turn
  instead of the user (documented, `hooks.md:4301`; the codec cannot see the setting):
  never declare a hook async that returns `notify-user`. Whether Claude Code applies a
  decision from an async hook is not checked here; keep guards synchronous.

## What the codec delivers

The release's README, "The Claude Code codec", has the table with the exact stdout.

- Events with rules: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `CwdChanged` (`old_cwd`, `new_cwd` in `native.input`). Any other event decodes
  generically and encodes only `no-decision`.
- Decode: only `hook_event_name` is required; a known key with the wrong JSON type, or
  `null`, is `HOOK_INPUT_INVALID`; `tool_input` and `tool_response` may be any JSON.
  `hostTurnId` is never set (Claude Code has no turn id); `tool.input` is what the model
  sent, only the keys it passed (recorded, 2.1.283).
- `add-context` at `session-start-input`, `prompt-input`, `tool-result`; not on
  `PreToolUse` or `CwdChanged`. Claude Code caps each `additionalContext` and
  `systemMessage` at 10,000 characters: a longer one is saved to a file and Claude gets
  the path and a 2,000-character preview. The codec does not enforce the cap.
- `PreToolUse`: `tool-permission` `allow`, `deny` or `ask`. `allow` still leaves the
  user's deny and ask rules in force; the reason of an `allow` goes to the debug log, of
  a `deny` to Claude, of an `ask` to the permission prompt. `tool-input` alone writes
  `updatedInput` without a decision: it replaces the whole input and grants nothing, the
  permission rules run against the new input (doc: "With no `permissionDecision`, auto
  mode can deny the changed call"; executed by loadguard on 2.1.283, the rewritten
  command ran). With `tool-permission` `allow` or `ask` both go into one output (what
  `AskUserQuestion` and `ExitPlanMode` need); with `deny` it is unsupported.
- `notify-user`: top-level `systemMessage`, a warning shown to the user, on all five
  events, also beside another effect. On `CwdChanged` it is only a brief terminal
  notification in interactive sessions (skilletor measured on 2.1.322: in `-p` it reached
  neither the model nor `stream-json`).
- Text with an unpaired UTF-16 surrogate is written as a `\u` escape and delivered
  (Claude Code parses hook stdout with `JSON.parse`); what happens to it later is not
  checked.

## Hot hooks: run-ready and silent guards

A hook that runs on every tool call or prompt (a guard on `PreToolUse` or
`UserPromptSubmit`) needs a timeout of a few seconds, too short for a first install: the
host kills a `run` that is still downloading. From 0.2.0 such a hook calls `run-ready`
and leaves the install to `SessionStart`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
        "command": "sh \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run dist/hook.js claude-code",
        "timeout": 600 } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command",
        "command": "sh \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run-ready dist/guard.js claude-code",
        "timeout": 5 } ] }
    ]
  }
}
```

On Windows too, both lines take the polyglot form of
[the Windows section](#windows-the-dot-sourced-polyglot) with `run` and `run-ready`. A
`SessionStart` whose entry has nothing to say may call `ensure` instead of `run`.

- `run-ready` with a `ready` slot is exactly `run`. With a `missing` slot it exits 0,
  writes nothing to stdout and one `getty-bun: ... run-ready skipped <entry>` line to
  stderr, and installs nothing: no lock, no wait, no download (contract.md, "Starter
  interface"; starter side executed, `bootstrap/test/run-ready.test.ts`, Linux `sh`). A
  slot still being installed by `SessionStart` is `missing` to it, so the guard does not
  wait for the install. `mismatch` and every other starter failure exit 1, as `run`.
- So until the first install has finished, the guard does nothing and the tool call goes
  ahead. A guard that must block when Bun is absent cannot use `run-ready`; it keeps `run`
  with a timeout above the lock wait plus one download.
- When `SessionStart` is declared `"async": true` (it then returns nothing the session
  needs), the first tool calls of a fresh session may meet a `missing` slot. Whether
  Claude Code holds the first turn until a synchronous `SessionStart` has ended is not
  checked here.
- 5 s is an example, not a measured bound. On Windows without Git Bash a hook pays two
  PowerShell starts before Bun (below); leave room for them.
- For the guard's own failures, `main({ onFailure: "silent" })` (0.2.0, [sdk.md](sdk.md)):
  every SDK failure (input, handler, effect, encoding) exits 0 with nothing on stdout and
  the one `agent-bun-runtime: <CODE>: <message>` line on stderr. To Claude Code that is a
  hook without a decision: no `hook error` notice, the action goes ahead (documented
  exit 0 behavior, not executed here). Whether the stderr line of an exit 0 hook reaches
  the user or only the debug log is not checked here. Pick `"silent"` for a guard that
  fails open and must stay invisible on broken input; `"closed"` (below) for one that
  fails closed.

## Exit codes in Claude Code

Documented (hooks reference, 2026-11-26), not executed:

- Exit 2 with nothing on stdout is a blocking error with stderr as the reason. On
  `PreToolUse` it blocks the call like `deny`; on `UserPromptSubmit` it rejects the
  prompt and shows stderr to the user; on `PostToolUse` Claude sees stderr, the tool has
  already run; on `SessionStart` and `CwdChanged` the user sees it and nothing is blocked.
- Exception: a `Stop`, `SubagentStop` or `TaskCompleted` hook, or a plugin's
  `UserPromptSubmit` hook, that exits 2 with a "file is missing" stderr (such as
  `No such file or directory`) is a non-blocking error. The SDK's line carries the
  handler's message, so a `"closed"` entry whose handler fails with such a message
  does not block on those events.
- Exit 1 with nothing on stdout is a non-blocking error: the action goes ahead with a
  `<hook name> hook error` notice carrying stderr, unless the hook is configured with
  `"onFailure": "block"` (2.1.295 or later), which makes it act like exit 2.
- Exit 2 acts on more events ("Exit code 2 behavior per event"): on `Stop` Claude keeps
  working instead of stopping, on `SubagentStop` the subagent does; it blocks
  `PreCompact`, `ConfigChange`, `TeammateIdle`, `TaskCompleted`, `PostToolBatch` and
  others. Claude cannot repair a hook that keeps failing on `Stop`, `SubagentStop`,
  `TeammateIdle` or `TaskCompleted`, which is why Claude Code's own `"onFailure":
  "block"` has no effect there; the SDK's exit 2 does. On `WorktreeCreate` and
  `WorktreeRemove` any non-zero exit, 1 included, fails the operation.
- So an entry that serves only `PreToolUse` or `UserPromptSubmit` and guards them picks
  `main({ onFailure: "closed" })`, or the hook `"onFailure": "block"`; an entry that
  serves any other event keeps `"open"` (give the guard its own entry). Decisions
  themselves go as JSON with exit 0.

## Windows: the dot-sourced polyglot

Decided on 2026-11-27 (agent-bun-runtime ADR 0010): a Claude Code hook that must run on
Windows uses **shell form** (no `args`) and dot-sources `bootstrap/getty-bun.cmd`, which
`getty-bun-install` copies unchanged next to the two starters. The polyglot holds no pin
and selects no version; it hands the call to `getty-bun.sh` or `getty-bun.ps1`. The line,
exactly:

```
. "${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.cmd" run dist/hook.js claude-code; exit $LASTEXITCODE
```

in `hooks/hooks.json`:

```json
{
  "type": "command",
  "command": ". \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.cmd\" run dist/hook.js claude-code; exit $LASTEXITCODE",
  "timeout": 600
}
```

`run-ready`, `ensure` and other entries take the same form. Documented ("Exec form and
shell form"): `hooks.json` has no per-OS field, so one entry must start everywhere; with
`args` a hook runs in exec form (since 2.1.139, source-checked, `anthropics/claude-code`
`4cc5e8b`, `CHANGELOG.md`), `command` resolved on `PATH` and spawned without a shell,
`${CLAUDE_PLUGIN_ROOT}` substituted into `command` and every `args` element; without
`args` in shell form: `sh -c` on Linux and macOS, Git Bash on Windows, PowerShell when Git
Bash is not installed (`"shell": "powershell"` selects it explicitly). So the line runs:

| Platform | Hook shell | Path to Bun |
|---|---|---|
| Linux, macOS | `sh -c` | the polyglot's shell part `exec`s `sh getty-bun.sh`; Bun runs under the hook shell's PID |
| Linux with dash as `/bin/sh` (Debian, Ubuntu) | `sh -c`, then `bash` | dash's `.` drops the arguments; the polyglot reads its shell's command line from `/proc/$$/cmdline` and runs the same line once more under `bash`, then as above. Needs `/proc`, `bash`, `xargs` and the polyglot call first in the line; otherwise exit 1 with one `getty-bun: ` line |
| Windows with Git Bash | Git Bash `sh` (bash) | shell part, `getty-bun.sh`, which forwards to `getty-bun.ps1` (forwarding executed in CI, scenario 11; under Claude Code not checked) |
| Windows without Git Bash | PowerShell | PowerShell's `.` runs the `.cmd` through `cmd.exe`; its batch part runs `getty-bun.ps1` under Windows PowerShell 5.1 by absolute path with the Codex `commandWindows` flags and exits with its code |

- **Cost.** Without Git Bash a hook pays one PowerShell start more than Codex's
  `commandWindows` path: the hook's own PowerShell before the starter's. About 720 ms
  per PowerShell start on a desktop, measured by windows-developer (Claude Code 2.1.287,
  `docs/hook-start-windows.md` there) with `"shell": "powershell"` as a stand-in, since Git
  Bash could not be hidden. A measurement on a real desktop without Git Bash is pending
  on a windows-developer card. Per-hook cost of the starters over Bun alone, executed in
  agent-bun-runtime CI (`docs/hook-cost.md`, medians, Defender off: a lower bound): Linux
  `sh` 5–6 ms; Windows `powershell` 5.1 348–449 ms, `pwsh` 7 372–522 ms; Git Bash
  forwarding about 94 ms more than 5.1 direct.
- **The call comes first** in the line: the dash workaround reruns only a line that
  starts with `. `.
- **Quote** `"${CLAUDE_PLUGIN_ROOT}/..."`: one word with spaces in both shell families.
- **`; exit $LASTEXITCODE`** is for PowerShell, whose `-Command` turns every non-zero exit
  of a native last command into 1; without it a `"closed"` guard's exit 2 arrives as 1. A
  POSIX shell never reaches the tail (the polyglot `exec`s or exits). Limit: when
  PowerShell cannot find the polyglot, `$LASTEXITCODE` is unset and the line exits 0
  after PowerShell's error on stderr, so even a `"closed"` guard fails open there.
- **Entry arguments:** words that mean the same to `sh` and PowerShell; single-quote
  anything else. Keep `&`, `|`, `<`, `>`, `^` and `%` out of the line: on Windows
  `cmd.exe` reads the arguments. Keep `--%` and `-` arguments containing a blank out too:
  under a PowerShell hook shell `'--%'` was lost and `'-Command x'` split (executed,
  agent-bun-runtime CI 46031834399); no lone `-`, nothing beginning with `-:`
  ([contract.md](contract.md), "Entry arguments pass through unchanged (from 0.2.0)").
- **Linux/macOS-only plugins** keep the `sh` lines of
  [the first section](#run-hooks-through-the-starter), shell or exec form. Exec form
  stays unusable on Windows: `command` must be a real `.exe`; `sh` is not on the PATH of
  a Claude Code started from PowerShell, and exec form on a `.cmd` fails with EINVAL
  (measured by windows-developer, 2.1.287).
- The codec itself is platform-independent and runs on the Windows CI legs.

Evidence:

- **Source-checked:** `bootstrap/getty-bun.cmd` and agent-bun-runtime
  `bootstrap/README.md`, "Polyglot", for every row of the table.
- **Executed in agent-bun-runtime's suite, Linux shells:**
  `bootstrap/test/polyglot.test.ts` runs the line under `<sh> -c` without the host, the
  root already substituted (it contains a space) and every word single-quoted: stdin and
  stdout byte for byte, the entry's exit code, arguments beginning with `-`, a starter
  failure as exit 1 with one line. On 2026-11-27 with the harness Bun 1.4.5 on
  linux-x64: `sh` (dash), dash and bash passed (13 pass, 7 skip: BusyBox sh and zsh not
  installed on that machine); with BusyBox 1.37.0 and zsh 5.9 installed all 20 passed
  (`bootstrap/README.md`). The PowerShell `exit` tail, run by the windows worker with
  pwsh 7.7.0 on Linux: `sh -c 'exit 2'` as last command gave 1, with the tail 2.
- **Executed in CI 46031834399, Windows:** the same test with PowerShell 5.1, PowerShell 7
  and Git Bash as the hook shell, plus `cmd.exe /d /c` on the `.cmd`: stdin and stdout byte
  for byte and the entry's exit code passed in all; the `-` arguments passed under Git
  Bash, while under both PowerShells `'--%'` was lost and `'-Command x'` arrived split
  (Entry arguments, above).
- **Executed in CI 46035250753, macOS** (the arm64 and x64 scenario legs): `/bin/sh`,
  `/bin/bash` 3.2 and zsh as the hook shell passed stdin and stdout byte for byte with
  exit 7, the dash arguments, exit 2 and 7 unchanged, a run without `CLAUDE_PLUGIN_ROOT`
  and a starter failure as exit 1; dash, which has no `/proc` to re-run the line under
  bash there, failed with one `getty-bun: ` line and exit 1, as documented. A zsh row
  would skip if no zsh were found; macOS ships `/bin/zsh`.
- **Not checked:** exit 2 through the PowerShell `; exit $LASTEXITCODE` tail on Windows,
  and a host that keeps stdin open through the polyglot.
- **Executed by windows-developer** (Claude Code 2.1.287): a dot-sourced `.cmd`
  polyglot of this kind starts in shell form (probes q6, r6); not this file, and not its
  Linux side.
- **Not checked:** that Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` into the line
  before PowerShell parses it (else PowerShell reads its own, empty variable and the line
  exits 0 as above); how Claude Code hands the line to PowerShell; the exit tail under a
  real host; whether Claude Code's `sh -c` on Linux has exactly the shape the dash
  workaround needs (`<sh> -c '<line>'`, no extra arguments, nothing before the dot);
  Windows without Git for Windows at all.

## MCP servers

A plugin's MCP server can run through the starter as a long-lived stdio server
([contract.md](contract.md), "Long-lived stdio server"; 0.2.0): `.mcp.json` at the plugin
root, Linux and macOS:

```json
{
  "mcpServers": {
    "example": {
      "command": "sh",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh", "run", "dist/server.js", "claude-code"]
    }
  }
}
```

or a wrapper of the plugin's own that ends in `exec sh .../getty-bun.sh run dist/server.js
claude-code`. Shape documented (plugins reference: `.mcp.json`, `${CLAUDE_PLUGIN_ROOT}`
substituted), not executed under Claude Code here.

- **stdout is the protocol only.** The starter's messages go to stderr, also during a
  first install, and `getty-bun.sh` `exec`s Bun under the same PID, so the host's signals
  and end of input reach the server and its exit code passes through (starter side
  executed, `bootstrap/test/stdio-server.test.ts`, Linux `sh`).
- **Install before the first start.** Add a `SessionStart` command hook
  `sh "${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh" ensure` with `"timeout": 600`, so the
  first MCP start finds a ready slot: Claude Code's MCP start timeout may be shorter than
  an install (its value and `MCP_TIMEOUT` are not checked here). Whether `SessionStart`
  runs before the MCP servers start is not checked either; a server that starts first
  waits on the same lock, and if the host gives up on it, an interrupted download is kept
  and resumed by the next install (0.2.0). The slot is shared: if another consumer has
  installed the same pin, the server is on the fast path at once.
- **No starter call on `SessionEnd`** (above): its 1.5 s budget is too short.
- **No SDK dependency** is needed for such an entry until the SDK has MCP (phase 5).
- **Windows is not covered.** An MCP server has no shell form, so the polyglot cannot
  start it, and exec form on a `.cmd` fails with EINVAL (measured by windows-developer,
  2.1.287). A plugin keeps its server off on Windows (agent-irc keeps its `mcpoff`
  launcher there); a Windows MCP launcher and a job object that ends Bun with its host are
  later (agent-bun-runtime `k13`).

## Optional repair hint

The setup skill is for repair and diagnosis, not installation. Where the target supports
native mods, a small mod may point the agent to it without requiring Bun. A mod uses
`.claude-plugin/plugin.json`, `hooks/hooks.json` with `"modules": ["./register.js"]`, and a
module exporting `register(on, options)`; the module path is relative to
`hooks/hooks.json`. [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)

```javascript
/** @type {import("claude-code").Register} */
export const register = (on) => {
  on("prompt.context", async ($, event, next) => {
    const base = await next(event);
    const name = `${$.plugin.name}:getty-bun-repair`;
    return {
      ...base,
      blocks: [
        ...base.blocks.filter((block) => block.name !== name),
        {
          name,
          text:
            `This plugin's hooks install and run the shared, pinned Bun. ` +
            `If they report a getty-bun failure or stay silent, read ` +
            `${$.plugin.root}/skills/setup/SKILL.md to diagnose and repair within ` +
            `the current session's authorization. This is guidance, ` +
            `not a report that the runtime is ready.`,
        },
      ],
    };
  });
};
```

Checked against `Register`, `CoreEngineInterface.plugin`, `Events['prompt.context']` and
`PromptContextResult` in the
[published declarations at fa0dece](https://github.com/anthropics/claude-code/blob/fa0dece70669a54b3104c618de9eebaaa78af19f/mods/types/claude-code.d.ts)
(source-checked); **it has not run in a Claude Code client.** `prompt.context` is cached;
a block already sent is no live status channel, so keep the text conditional.

## Review activation and validate

Respect workspace trust and the client's hook controls. After editing manifests or hook
code, follow the client's supported reload flow and inspect which definition is active; a
file write alone does not prove activation.

Validate with isolated `HOME` and `GETTY_HOME` and exercise: Bun absent (the first
`SessionStart` installs); two simultaneous sessions (one download, both run); a lock wait
that runs out (clear stderr, no partial slot); a wrong `bun` on PATH (ignored); a
mismatching slot (fails closed); a plugin path with spaces; hook stdout byte for byte; each
effect arriving in the client; exit 1 and 2 as documented above. Record the client version
and results; do not promote the hook shape to a tested adapter without those observations.
Windows checks go as cards to the windows-developer board.
