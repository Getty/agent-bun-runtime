# Codex adapter

Codex is served by the codec `@getty/agent-bun-runtime/codex` and the starters (`command`
plus `commandWindows`). Facts from the Codex documentation are marked **documented, not
executed**; facts read in the Codex source are **source-checked** at openai/codex
`3f65e9f`. No real Codex has run a codec or a starter from agent-bun-runtime yet: that is
the phase 3a gate (briefing, Codex 0.153.4). Read [contract.md](contract.md) for the
`package.json` requirement and the starter interface, [sdk.md](sdk.md) for the entry.

## Contents

- [Run hooks through the starter](#run-hooks-through-the-starter)
- [Hook facts that shape the adapter](#hook-facts-that-shape-the-adapter)
- [What the codec delivers](#what-the-codec-delivers)
- [Exit codes in Codex](#exit-codes-in-codex)
- [Review trust and activation](#review-trust-and-activation)
- [Setup skill and onboarding](#setup-skill-and-onboarding)
- [Distribution surfaces](#distribution-surfaces)
- [Validate the integration](#validate-the-integration)

## Run hooks through the starter

Each Bun-dependent hook carries a POSIX `command` and a Windows `commandWindows`. Shape,
source-checked, **not executed under Codex**:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh \"${PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run dist/hook.js codex",
            "commandWindows": "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"${PLUGIN_ROOT}\\bootstrap\\getty-bun.ps1\" run dist/hook.js codex",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

- **A hook file of its own when the plugin also serves Claude Code.** Both hosts read
  `hooks/hooks.json` by default, and Claude Code, which has no `commandWindows`, always
  reads it. So `hooks/hooks.json` holds the Claude Code hooks, and the Codex hooks live in
  another file (for example `hooks/codex-hooks.json`) that the `hooks` entry of the Codex
  manifest names; that entry replaces the default file (source-checked,
  `codex-rs/core-plugins/src/loader.rs:1178-1235`; which manifest file Codex reads it from
  is not traced).
- The trailing `codex` is the entry's own argument naming the host, for an entry that
  serves both hosts ([sdk.md](sdk.md), "The entry"). An entry built for Codex alone needs
  none.
- The starters sit in `bootstrap/`; the consumer root is the parent of that directory, and
  the entry, the committed bundle, is relative to it.
- Codex replaces `${PLUGIN_ROOT}` (likewise `${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_DATA}`,
  `${CLAUDE_PLUGIN_DATA}`) **textually** in the command string before a shell sees it
  (source-checked, `codex-rs/hooks/src/engine/discovery.rs:747-749`); the variables are
  also set in the hook environment. On Windows it takes `commandWindows`, else `command`.
- The shell: Codex runs either line in the session shell of the turn environment, without
  login: `-c` for zsh, bash and sh, `-NoProfile -Command <line>` for PowerShell
  (source-checked, `codex-rs/core/src/session/mod.rs:6477-6483`,
  `codex-rs/core/src/shell.rs:24-31`). On Windows that shell is by default PowerShell
  (`pwsh`, else `powershell.exe`). Only without a single local turn environment
  (`codex-rs/core/src/environment_selection.rs:1537-1548`) does it fall back to `$SHELL`
  (else `/bin/sh`) with `-lc`, a login shell, or on Windows to `%COMSPEC%` (else `cmd.exe`)
  with `/C` (`codex-rs/hooks/src/engine/command_runner.rs:456-466`). There is no exec form.
  Open for phase 3a: which shell a real session uses, whether it reads startup files (zsh
  reads `.zshenv` without login too), and what lands on stdout ahead of the hook JSON.
- Write `"${PLUGIN_ROOT}"` inside double quotes in both lines: the substituted Windows
  path carries backslashes and may carry spaces. Keep `commandWindows` valid in
  PowerShell and in `cmd` alike: a bare `powershell.exe`, double-quoted path arguments, no
  `&`, `$env:` or `%VAR%`. Derived: a plugin root containing `"`, `$` or `` ` `` (and `%`
  under `cmd`) breaks the quoting before the starter runs; it belongs in the path tests.
- Under the default session shell a Windows hook starts PowerShell twice: the session
  shell, then the starter's `powershell.exe`. Executed in agent-bun-runtime CI as a
  stand-in, not under Codex (`docs/hook-cost.md`, row "Codex nesting"; runs 45572032454,
  45579886904, 45589361806): 501–661 ms per hook with 5.1 inside, 550–785 ms with 7
  inside (medians of 10 calls per run), before the entry's own work. Defender real-time
  protection was off: a lower bound for desktops, where windows-developer measured about
  720 ms per PowerShell start.
- The `timeout` value is illustrative; keep it above `GETTY_BUN_LOCK_WAIT` (default 300 s)
  plus one download. No hook needs a Bun on PATH, and no separate install hook exists: the
  first hook after a plugin install or update installs.

## Hook facts that shape the adapter

All documented, not executed ([Hooks](https://learn.chatgpt.com/docs/hooks.md)):

| Fact | Consequence |
| --- | --- |
| `command` and `mcp_tool` handlers are supported; `prompt` and `agent` are parsed but skipped. | The starter is a `command` handler; an `mcp_tool` hook needs no codec. |
| `commandWindows` is an optional Windows-only command override. | Windows gets the PowerShell starter line. |
| Plugin hook commands receive `PLUGIN_ROOT` and `PLUGIN_DATA`; Codex also sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` for compatibility. | Locate the starter from the plugin root; never infer the host from these variables. |
| Commands run with the session `cwd` as working directory. | The starter derives the consumer root from its own path; the entry sees the project as `location.processCwd`. |
| Multiple matching command hooks for the same event launch concurrently. | Concurrent first hooks wait on the starter's lock; order is no barrier. |
| `timeout` is in seconds; 600 by default for most hooks; `SessionEnd` and `Interrupt` default to 1 s, at most 3 s. | Never put a possibly installing starter call on `SessionEnd` or `Interrupt`. |

## What the codec delivers

Source-checked against `3f65e9f`, with file and line in agent-bun-runtime `src/codex.ts`;
the release's README, "The Codex codec", has the table with the exact stdout.

- Events with rules: `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`. Any other event decodes generically and encodes only `no-decision`.
- `add-context` at `session-start-input`, `subagent-input` (the subagent's thread only),
  `prompt-input`, `tool-result`; none on `PreToolUse`. Codex spills context above about
  2,500 approximate tokens to a file with only a preview in the model context
  (`codex-rs/hooks/src/output_spill.rs:13,65-92`).
- `PreToolUse`: Codex can **deny**, not allow or ask: `tool-permission` `allow` or `ask`,
  and a `deny` reason that is only white space, are `HOOK_EFFECT_UNSUPPORTED`.
  `tool-input` is written as `permissionDecision: "allow"` plus `updatedInput`, which in
  Codex rewrites the call and grants nothing; the tool's own approval still runs. For
  `Bash` and `apply_patch` the new input must be exactly `{ "command": <string> }`.
  `tool-permission` and `tool-input` together are unsupported.
- `notify-user` is a top-level `systemMessage`, shown as a warning under the hook's line
  in the TUI, also beside another effect.
- Unknown keys in hook output make Codex reject the whole JSON
  (`codex-rs/hooks/src/schema.rs:385-425`); the codec writes only known keys. Stdout that
  begins with `{` or `[` but does not parse fails the hook; other text becomes plain
  context (`session_start.rs:240-313`): keep handlers off stdout.

## Exit codes in Codex

Source-checked, not executed:

- **Start hooks** (`SessionStart`, `SubagentStart`): every non-zero exit, 2 included,
  fails the hook ("hook exited with code N"), and stdout and stderr are discarded, so the
  SDK's stderr line is not shown (`codex-rs/hooks/src/events/session_start.rs:316-330`).
  The turn stops only when the hook is configured with `onFailure: "block"` and runs
  synchronously (`codex-rs/hooks/src/events/common.rs:74-90`,
  `codex-rs/hooks/src/engine/mod.rs:216-226`, `session_start.rs:345-348`). How the TUI
  and `codex exec` report the failure is measured in phase 3a.
- **`UserPromptSubmit`, `PreToolUse`, `PostToolUse`:** exit 2 with non-empty stderr blocks
  the prompt or the tool call, stderr trimmed as the reason
  (`codex-rs/hooks/src/events/user_prompt_submit.rs:229-245`, `pre_tool_use.rs:268-284`);
  on `PostToolUse` it rejects the result as feedback to the model, the tool has already run
  (`post_tool_use.rs:264-280`). The SDK's one line is never empty, so an entry with
  `onFailure: "closed"` blocks there when it fails.
- Exit 1 fails the hook and Codex goes on, unless the hook is configured with
  `onFailure: "block"` and runs synchronously (`pre_tool_use.rs:285-305`, `common.rs:74-90`).
  An async hook (`"async": true`) can apply neither exit 2 nor a decision
  (`codex-rs/hooks/src/engine/mod.rs:199-214`).

## Review trust and activation

Installing or enabling a plugin does not trust its hooks. Codex associates non-managed hook
trust with the current definition's hash; new or changed definitions are skipped pending
review in `/hooks`. [Review and trust hooks](https://learn.chatgpt.com/docs/hooks.md#review-and-trust-hooks)
(documented, not executed)

**A plugin update that changes a bundled script needs a new review even if the hook
definition stays the same** (documented, not executed). What counts as a bundled script
(the starter, the bundled entry, or both) is measured in phase 3a. Expect a re-review
after every Bun pin bump (re-rendered starters) and every rebuilt entry, and say so in the
consumer's `Changes`.

Prepare concrete files before a required review; never bypass it or mistake
natural-language authorization for a persisted trust entry. After edits, use the client's
supported reload flow and inspect the active definitions.

## Setup skill and onboarding

Bundle `skills/setup/SKILL.md` for repair and diagnosis
([setup-and-installation.md](setup-and-installation.md)). The portable root `plugin.json`
can name it as onboarding skill:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example-getty-consumer",
  "version": "0.1.0",
  "description": "Example consumer of the Getty Bun contract.",
  "extensions": {
    "com.openai": {
      "onboardingSkill": "./skills/setup/SKILL.md"
    }
  }
}
```

The path is relative to the plugin root. Onboarding runs when the user invokes the setup
action after installation; it is neither an install hook nor the install path. The
compatibility manifest places `onboardingSkill` in `.codex-plugin/plugin.json`; an inline
`extensions.com.openai` object replaces that overlay rather than merging with it.
[Plugin packaging and onboarding](https://developers.openai.com/plugins/build/plugins.md#add-an-onboarding-skill)
(source-checked manifest example, not a tested plugin). Do not invent a `codex plugin
setup` command.

## Distribution surfaces

Current packaging guidance supports lifecycle hooks for manually installed Codex desktop
plugins and excludes plugins containing lifecycle hooks from the public plugin directory;
the local runtime separately documents hooks supplied by enabled plugins. Treat
distribution eligibility and runtime capability as separate checks.
[Packaging rules](https://developers.openai.com/plugins/build/plugins.md#bundled-mcp-servers-and-lifecycle-hooks),
[local hook discovery](https://learn.chatgpt.com/docs/hooks.md#where-codex-looks-for-hooks).
The committed starters and bundle must exist in the execution environment; a plugin
installed elsewhere supplies nothing locally.

## Validate the integration

Phase 3a gate in agent-bun-runtime: real Codex (0.153.4 on the development machine) with
isolated `HOME`, `CODEX_HOME` and `GETTY_HOME`: plugin install, hook trust, the first
session installs Bun, the hook's effect arrives. A consumer checks the same for its own
hooks, plus: concurrent sessions (one download), a lock wait that runs out, a wrong `bun`
on PATH, a changed starter or bundle triggering re-review, stdout byte for byte, and the
exit-code behavior above.

stdin, source-checked: Codex writes the hook object with `write_all` and drops the stdin
handle right after, which closes the pipe for a local hook
(`codex-rs/hooks/src/engine/command_runner.rs:318-327`; the closing itself is tokio
behavior, not read). For a hook in a remote environment the exec server keeps stdin open,
and Codex wraps the command so the hook still reaches end of input: under `sh` it pipes
the object through `printf '%s'`, under PowerShell through
`[Console]::In.ReadLine() | <command>` (`codex-rs/core/src/hook_environment_executor.rs:182-200`).
The SDK reads one object and does not wait for end of input either way, and the starters
end when the entry ends (`getty-bun.ps1`: executed, scenario 8b; `getty-bun.sh` `exec`s
Bun). Not yet measured: that a real hook gets end of input on the local path, and what the
PowerShell pipeline of the remote path does to non-ASCII bytes (derived: it re-encodes
with `$OutputEncoding`).

Windows goes as a card to the windows-developer board. Record the Codex version, surface,
package format, and distribution route; source and schema checks alone establish neither
runtime support nor directory eligibility.
