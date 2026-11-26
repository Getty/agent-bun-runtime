# Claude Code adapter

Claude Code is served by the codec `@getty/agent-bun-runtime/claude-code` and the POSIX
starter. The codec is **doc-checked** against the hooks reference
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
- [Exit codes in Claude Code](#exit-codes-in-claude-code)
- [Windows: open decision](#windows-open-decision)
- [Optional repair hint](#optional-repair-hint)
- [Review activation and validate](#review-activation-and-validate)

## Run hooks through the starter

`hooks/hooks.json`, Linux (macOS later); shape not executed under Claude Code:

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
"dist/hook.js", "claude-code"]`.

- The trailing `claude-code` names the host for an entry that serves Codex too
  ([sdk.md](sdk.md), "The entry"). Claude Code always reads `hooks/hooks.json`; Codex
  hooks go into a file of their own ([codex.md](codex.md)).
- Set `timeout` explicitly on every starter hook, above `GETTY_BUN_LOCK_WAIT` (default
  300 s) plus one download; 600 is illustrative. Documented ("Common fields"): command
  hooks default to 600 s, lowered to 30 s on `UserPromptSubmit`, `PreModelSwitch` and
  `PostModelSwitch` and to 10 s on `MessageDisplay`: too short for a first install.
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
- No hook requires a Bun on PATH, and there is no separate install hook.
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

## Windows: open decision

Documented ("Exec form and shell form"):

- With `args` a command hook runs in **exec form**: `command` is resolved on `PATH` and
  spawned without a shell; `${CLAUDE_PLUGIN_ROOT}` is substituted into `command` and every
  `args` element. On Windows `command` must resolve to a real `.exe`. Exec form exists
  since 2.1.139 (source-checked, `anthropics/claude-code` `4cc5e8b`, `CHANGELOG.md`).
- Without `args` it runs in **shell form**: `sh -c` on Linux and macOS, Git Bash on
  Windows, PowerShell when Git Bash is not installed; `"shell": "powershell"` selects
  PowerShell explicitly.
- `hooks.json` has no per-OS field: one entry must start on Linux and on Windows alike.

Measured by windows-developer (Claude Code 2.1.287, `docs/hook-start-windows.md`; Git Bash
could not be hidden, so the PowerShell fallback was measured with `"shell": "powershell"`
as a stand-in; **Windows without Git for Windows is not measured**):

- Shell form with Git Bash present runs `sh`; `getty-bun.sh` then forwards to
  `getty-bun.ps1` (forwarding executed in agent-bun-runtime CI, scenario 11; under Claude
  Code not checked). The target, though, is Windows **without** Git Bash.
- Exec form with `command: "sh"` depends on the Claude process's PATH; started from
  PowerShell, `sh` is not found. Exec form on an extensionless script fails with ENOENT,
  on a `.cmd` with EINVAL.
- Windows-only entries start (`powershell -NoProfile -ExecutionPolicy Bypass -File ...`,
  `cmd /c ...`, `node` plus a script), but none serves Linux from the same entry.
- Two entries start on both without Git Bash: exec form on an extensionless path with a
  `.exe` next to it (probe y1), or a dot-sourced `.cmd` polyglot in shell form (probes q6,
  r6), which pays a PowerShell start per hook (about 720 ms on that desktop). Their Linux
  side was not part of these probes.

Per-hook cost of the starters over Bun alone, executed in agent-bun-runtime CI
(`docs/hook-cost.md`, medians): Linux `sh` 5–6 ms; Windows `powershell` 5.1 348–449 ms,
`pwsh` 7 372–522 ms; Git Bash forwarding about 94 ms more than 5.1 direct. Defender
real-time protection was off on the runner: a lower bound for desktops.

The owner decides between a native shim and the polyglot in phase 3b (agent-bun-runtime
`docs/plan.md`, "Open decisions"). Until then: ship no Claude Code Windows adapter and
claim no Claude Code support on Windows. The codec itself is platform-independent and runs
on the Windows CI legs.

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
