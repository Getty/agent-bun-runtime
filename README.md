# agent-bun-runtime

Getty's Bun runtime for agent plugins, `getty-bun` for short
([ADR 0008](docs/adr/0008-repository-and-package-name.md)).

- **Bootstrap** (`bootstrap/`): two small starters, `getty-bun.sh` (POSIX `sh`, Linux)
  and `getty-bun.ps1` (Windows PowerShell 5.1 and PowerShell 7), that put one exact,
  checksum-verified Bun into `~/.getty/runtimes/bun/<version>/<target>/` and run a
  plugin's TypeScript with it. No Bun, Node or Python needed beforehand. Delivered to
  plugins as the skilletor template `getty-bun-install` (`skills/`, below).
- **`@getty/agent-bun-runtime`**: the SDK Getty plugins run on under that Bun: a hook
  `main()` with context, typed errors and effects, and the codecs for Codex and Claude
  Code. A codec for Hermes is planned.
- **Consumer skills** (`skills/`): `getty-bun` (working with the runtime),
  `getty-bun-integration` (building a plugin on it: the contract and the SDK) and
  `getty-bun-install` (the template that renders the pinned starters for a plugin).
  A plugin installs them with skilletor, pinned to the release tag:

  ```json
  {
    "sources": {
      "agent-bun-runtime": {
        "git": "https://github.com/Getty/agent-bun-runtime",
        "ref": "v0.1.0",
        "path": "skills"
      }
    },
    "install": {
      "skills": [
        "getty-bun@agent-bun-runtime",
        "getty-bun-integration@agent-bun-runtime",
        "getty-bun-install@agent-bun-runtime"
      ]
    },
    "vars": { "bun_version": "1.4.5" }
  }
  ```

  `"path": "skills"` keeps the source to that directory, so the team's own skills under
  `.claude/` are not offered. The template has no default `bun_version`: a plugin pins it.

Status: phase 1 (the starters) is merged into `main` at `262bc95` (PR 1), phase 2 (the
SDK core and the Codex codec) at `0bc8218` (PR 2). Phase 2b (the Claude Code codec, the
consumer skills, release preparation for 0.1.0,
[ADR 0009](docs/adr/0009-first-release-claude-code-and-consumer-skills.md)) is on branch
`phase-2b-claude-code`. Nothing is released: no tag, nothing on npm; the steps are in
[docs/release-0.1.0.md](docs/release-0.1.0.md). Plan and phases: [docs/plan.md](docs/plan.md).

## The SDK: `@getty/agent-bun-runtime`

ESM plus type declarations in `dist/`, compiled from `src/` by `tsc`. It runs on Bun only
and has no runtime dependencies. Consumers bundle it into their entry (`bun build
--target=bun`, [ADR 0003](docs/adr/0003-bundled-entry.md)): it has no dynamic imports, does
not read its own package files, and importing it does nothing by itself.

### Public API

Three exports: the package root, `@getty/agent-bun-runtime/codex` with the Codex codec
`codex: HookCodec` ([below](#the-codex-codec)), and `@getty/agent-bun-runtime/claude-code`
with the Claude Code codec `claudeCode: HookCodec` ([below](#the-claude-code-codec)). The
root:

```ts
// values
main(options: MainOptions): Promise<number>
class AgentRuntimeError extends Error { readonly code: ErrorCode; readonly stage: ErrorStage }
DEFAULT_MAX_INPUT_BYTES = 1048576

// types
interface MainOptions {
  codec: HookCodec;
  handler: HookHandler;
  stdin?: ReadableStream<Uint8Array>;   // default Bun.stdin.stream()
  stdout?: OutputWriter;                // default the real stdout
  stderr?: (text: string) => unknown;   // default the real stderr
  env?: Env;                            // default process.env, read when main() runs
  cwd?: string;                         // default process.cwd(), read when main() runs
  maxInputBytes?: number;               // default DEFAULT_MAX_INPUT_BYTES
  onFailure?: FailurePolicy;            // default "open"
}
type FailurePolicy = "open" | "closed";
type HookHandler = (context: HookContext) =>
  HookEffect | readonly HookEffect[] | Promise<HookEffect | readonly HookEffect[]>;
interface HookContext { invocation: HookInvocation; env: Env }
type HookEffect =
  NoDecisionEffect | AddContextEffect | ToolPermissionEffect | ToolInputEffect | NotifyUserEffect;
interface NoDecisionEffect { kind: "no-decision" }
interface AddContextEffect {
  kind: "add-context"; text: string; audience: "model"; placement: ContextPlacement;
}
type ContextPlacement = "session-start-input" | "subagent-input" | "prompt-input" | "tool-result";
interface ToolPermissionEffect {
  kind: "tool-permission"; decision: "allow" | "deny" | "ask"; reason?: string;
}
interface ToolInputEffect { kind: "tool-input"; input: Readonly<Record<string, unknown>> }
interface NotifyUserEffect { kind: "notify-user"; text: string }
class HookCodec { readonly host: HostKind }   // opaque: no constructor, not implementable
interface HookInvocation {
  envelopeVersion: 1;
  host: { kind: HostKind; surface: HostSurface };   // "codex" | "claude-code", "command-hook"
  event: { nativeName: string };
  location: { processCwd: string; hostWorkingDirectory?: string };
  identity: { hostSessionId?: string; hostTurnId?: string };
  tool?: { name: string; input: unknown };          // PreToolUse, PostToolUse; from the codec
  native: { input: Readonly<Record<string, unknown>> };
}
type Env = Readonly<Record<string, string | undefined>>;
type OutputWriter = (bytes: Uint8Array) => unknown;
type ErrorCode = "HOOK_INPUT_INVALID" | "HOOK_EFFECT_INVALID" | "HOOK_EFFECT_UNSUPPORTED"
  | "HANDLER_FAILED" | "OUTPUT_FAILED" | "INTERNAL_ERROR";
type ErrorStage = "input" | "decode" | "handler" | "effect" | "encode" | "output";
```

All fields are `readonly`. The invocation is frozen; a field the host did not send is
absent, never filled with a default; event-specific host fields stay in `native.input`.
`envelopeVersion` versions this shape; `gettyBun.contractVersion` in a consumer's
`package.json` is the integration contract's version
([ADR 0009](docs/adr/0009-first-release-claude-code-and-consumer-skills.md)).

- **Codecs.** A codec translates one host's protocol. `HookCodec` is a class with a
  `#private` field and a private constructor: the type is nominal, so a plugin passes one
  of this package's codecs to `main()` but cannot implement one, and the codec's inside
  can change without a major release. `main()` also checks at run time: anything else is
  `INTERNAL_ERROR`. The host is never guessed from the environment; an entry serving two
  hosts takes the codec from its own argument.
- **Effects.** A handler returns one effect or a list of effects, which the codec
  delivers as one output. A list is non-empty, has at most one effect of each kind, and
  `no-decision` only alone; anything else is `HOOK_EFFECT_INVALID`. `tool-permission`
  (`reason` required for `deny`, a non-empty string when present) and `tool-input` (a
  plain JSON object that replaces the tool's input and grants nothing) are for
  `PreToolUse`; the core accepts them together, and the codec decides whether its host
  can carry both. `notify-user` shows a non-empty `text` to the user, not the model. Each
  codec delivers what its host can and rejects the rest with `HOOK_EFFECT_UNSUPPORTED`,
  never converting it.
- **Unknown events.** A codec decodes any event with a string `hook_event_name`: session
  and working directory when the host sent them as strings, everything in `native.input`.
  For an event the codec has no rules for, only `no-decision` encodes.
- **Open unions.** `HostKind`, `HostSurface`, `ContextPlacement`, the effect kinds and
  `ErrorCode` may gain members in a minor release; keep a default branch. Removing or
  renaming a member is a breaking change.

`main()` reads stdin, decodes it with the codec, runs the handler, validates the effect
or effects, encodes them as one output and writes stdout once. It never calls `process.exit`.

### Entry pattern

```ts
import { main } from "@getty/agent-bun-runtime";

process.exit(await main({ codec, handler }));
```

`main()` stops reading stdin once the object is read, so `process.exitCode = await
main(...)` also ends the process while the host keeps stdin open, but only when nothing
else keeps Bun running: a timer or socket the handler left open would hold the hook until
the host's timeout. `process.exit` ends it as soon as `main()` has returned, and by then
`main()` has written everything. Executed for both forms with stdin held open by a test
through `Bun.spawn`, not by a real host: on Linux (`test/entry.test.ts`, Bun 1.4.5,
linux-x64-baseline), and on Windows in CI run
[45883791115](https://github.com/Getty/agent-bun-runtime/actions/runs/45883791115)
(`windows-latest`, image windows-2025-vs2026, Bun 1.4.5), directly in `sdk checks
(windows)` and through both Windows starters in `gate (windows powershell)` and `gate
(windows pwsh)`.

### The Codex codec

```ts
import { main } from "@getty/agent-bun-runtime";
import { codex } from "@getty/agent-bun-runtime/codex";

process.exit(await main({ codec: codex, handler }));
```

It handles the Codex command hooks `SessionStart`, `SubagentStart`, `UserPromptSubmit`,
`PreToolUse` and `PostToolUse`. Every rule is source-checked against openai/codex
`3f65e9f`, with file and line in `src/codex.ts`; none has run against a real Codex yet
(phase 3a).

| Event | Envelope | Effects | stdout |
|---|---|---|---|
| `SessionStart` | `hostSessionId` from `session_id`, `hostWorkingDirectory` from `cwd` | `no-decision`; `add-context` at `session-start-input` | Nothing; `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}` and LF |
| `SubagentStart` | As `SessionStart`, plus `hostTurnId` from `turn_id` | `no-decision`; `add-context` at `subagent-input` | Nothing; the same object with `SubagentStart` |
| `UserPromptSubmit` | As `SubagentStart` | `no-decision`; `add-context` at `prompt-input` | Nothing; the same object with `UserPromptSubmit` |
| `PreToolUse` | As `SubagentStart`, plus `tool` from `tool_name` and `tool_input` | `no-decision`; `tool-permission` `deny`; `tool-input` | Nothing; `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}` and LF; `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":…}}` and LF |
| `PostToolUse` | As `PreToolUse` | `no-decision`; `add-context` at `tool-result` | Nothing; the `additionalContext` object with `PostToolUse` |

- `notify-user` works on all five events: top-level `"systemMessage"`, which Codex shows
  the user as the hook's message (in the TUI under the hook's line), not the model. A
  list of effects becomes one object: `notify-user` beside another effect writes
  `{"hookSpecificOutput":{…},"systemMessage":…}` and LF, keys always in that order,
  whatever the order of the list; alone it writes `{"systemMessage":…}`. So `add-context`
  plus `notify-user` works on `SessionStart`, `SubagentStart`, `UserPromptSubmit` and
  `PostToolUse`, and `tool-permission` `deny` or `tool-input` plus `notify-user` on
  `PreToolUse`. `tool-permission` with `tool-input` is `HOOK_EFFECT_UNSUPPORTED` (Codex
  fails the hook on `updatedInput` beside `deny`, and cannot allow), and one effect the
  codec cannot deliver fails the whole list.
- Only `hook_event_name` is required. The decoder checks the types only of the keys it
  lifts into the envelope: `session_id`, `cwd`, `turn_id` (where it becomes
  `hostTurnId`) and `tool_name` must be strings when present, else
  `HOOK_INPUT_INVALID`; `tool_input` may be any JSON. Every other key
  (`transcript_path`, `model`, `permission_mode`, `source`, `prompt`, `agent_id`,
  `agent_type`, `tool_use_id`, `tool_response`, unknown keys) stays in `native.input`
  unchecked, so a Codex release that changes one of them does not fail every hook; a
  handler that reads one checks its type itself. Phase 2 checked them all: a
  `SessionStart` or `SubagentStart` with, say, a number for `transcript_path` was
  `HOOK_INPUT_INVALID` and now decodes (k30, ADR 0009). Any other event is decoded
  generically, and only `no-decision` encodes for it (`""`). Every host key stays in
  `native.input`.
- `tool` is there only when both `tool_name` and `tool_input` are. `tool.name` is Codex's
  own name: `Bash` for shell commands and `apply_patch` for edits, with `tool.input`
  `{ "command": … }`; an MCP tool's name and arguments as they are.
- For every event but `SessionStart`, `hostSessionId` is the root thread's: Codex's
  `session_id` is shared by the root thread and all its subagents, and the parent
  thread's id is not in the hook input.
- `PreToolUse`: Codex can deny a call, not allow it or ask about it: `tool-permission`
  `allow` or `ask` is `HOOK_EFFECT_UNSUPPORTED`, and so is a `deny` reason that is only
  white space (Codex trims it and would fail the hook). `tool-input` rewrites the call
  and grants nothing: Codex needs `permissionDecision: "allow"` beside `updatedInput`,
  and the tool's own approval still runs on the rewritten call. For `Bash` and
  `apply_patch` the new input must be exactly `{ "command": <string> }` (Codex reads
  nothing else and would drop other keys without a word), else
  `HOOK_EFFECT_UNSUPPORTED`; without `tool` in the invocation `tool-input` is
  unsupported too. `add-context` has no placement on `PreToolUse`.
- Any other placement, a string to write with an unpaired UTF-16 surrogate (context
  text, `notify-user` text, reason, or any key or string of the new input), or any other
  effect kind is `HOOK_EFFECT_UNSUPPORTED`.
- Exit codes on `UserPromptSubmit`, `PreToolUse` and `PostToolUse` (source-checked):
  exit 2 with non-empty stderr blocks the prompt or the tool call, with stderr trimmed
  as the reason (`codex-rs/hooks/src/events/user_prompt_submit.rs:229-245`,
  `pre_tool_use.rs:268-284`); on `PostToolUse` it rejects the result as feedback to the
  model, the tool has already run (`post_tool_use.rs:264-280`,
  `codex-rs/core/src/tools/registry.rs:1093`). Exit 1 fails the hook and Codex goes
  on, unless the hook is configured with `onFailure: "block"` and runs synchronously
  (`pre_tool_use.rs:285-305`, `codex-rs/hooks/src/events/common.rs:74-90`). An async
  hook (`"async": true`) can apply neither exit 2 nor a decision
  (`codex-rs/hooks/src/engine/mod.rs:199-214`).
- Exit 2 on events the codec decodes generically (source-checked): on `Stop` and
  `SubagentStop` exit 2 with non-empty stderr blocks the stop and the stderr becomes the
  continuation prompt, so Codex keeps working with the SDK's error line as its prompt
  (`codex-rs/hooks/src/events/stop.rs:330-355`,
  `codex-rs/core/src/session/turn.rs:882-899`); on `PermissionRequest` it denies the
  request (`permission_request.rs:263-278`). On `PreCompact` and `PostCompact` exit 2 is
  a plain failure like 1 (`compact.rs:318-325`). Hence `"closed"` only on entries that
  serve nothing but `PreToolUse` or `UserPromptSubmit` ([Exit codes](#exit-codes)).
- In Codex any non-zero exit fails a start hook: stdout and stderr are discarded, so the
  SDK's stderr line is not shown (source-checked,
  `codex-rs/hooks/src/events/session_start.rs:316-330`). The turn stops only when the
  hook is configured with `onFailure: "block"` and runs synchronously (source-checked,
  `codex-rs/hooks/src/events/common.rs:74-90`, `codex-rs/hooks/src/engine/mod.rs:216-226`,
  `session_start.rs:345-348`).

### The Claude Code codec

```ts
import { main } from "@getty/agent-bun-runtime";
import { claudeCode } from "@getty/agent-bun-runtime/claude-code";

process.exit(await main({ codec: claudeCode, handler }));
```

It handles the Claude Code command hooks `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse` and `CwdChanged`. Every rule is doc-checked against the hooks
reference (https://code.claude.com/docs/en/hooks, fetched 2026-11-26) and source-checked
against the bundled JavaScript of `@anthropic-ai/claude-code` 2.1.332, never run, with
line and byte offset in `src/claude-code.ts`. Executed only through loadguard's recorded
payloads (Claude Code 2.1.283, loadguard k7), which the fixtures reuse; no real Claude
Code has run this codec yet.

| Event | Envelope | Effects | stdout |
|---|---|---|---|
| `SessionStart` | `hostSessionId` from `session_id`, `hostWorkingDirectory` from `cwd` | `no-decision`; `add-context` at `session-start-input`; `notify-user` | Nothing; `{"systemMessage":…,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}` and LF |
| `UserPromptSubmit` | As `SessionStart` | `no-decision`; `add-context` at `prompt-input`; `notify-user` | Nothing; the same object with `UserPromptSubmit` |
| `PreToolUse` | As `SessionStart`, plus `tool` from `tool_name` and `tool_input` | `no-decision`; `tool-permission` `allow`, `deny` or `ask`; `tool-input`; `notify-user` | Nothing; `{"systemMessage":…,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":…,"permissionDecisionReason":…,"updatedInput":…}}` and LF |
| `PostToolUse` | As `PreToolUse` | `no-decision`; `add-context` at `tool-result`; `notify-user` | Nothing; the `SessionStart` object with `PostToolUse` |
| `CwdChanged` | As `SessionStart`; `old_cwd` and `new_cwd` in `native.input` | `no-decision`; `notify-user` | Nothing; `{"systemMessage":…}` and LF |

A handler's list of effects becomes one object; a key is there only when an effect fills
it (`permissionDecisionReason` only when the `tool-permission` has a reason). The key
order is fixed, whatever the list's order: `systemMessage`, `hookSpecificOutput`, and
inside it `hookEventName`, `permissionDecision`, `permissionDecisionReason`,
`updatedInput`, `additionalContext`. One effect the event cannot deliver rejects the whole
list.

- Only `hook_event_name` is required. The decoder checks only the keys it lifts into the
  envelope (ADR 0009): `session_id` and `cwd` on the five events and `tool_name` on
  `PreToolUse` and `PostToolUse` must be strings when present, `null` included (the
  2.1.332 schemas have no nullable there); otherwise `HOOK_INPUT_INVALID`. `tool_input`
  may be any JSON. Every other key (`transcript_path`, `prompt`, `model`, `effort`,
  `mcp_server`, `duration_ms`, ...) is not checked, so a Claude Code release that changes
  its type does not fail every hook. Any other event is decoded generically, and only `no-decision` encodes for it (`""`): Claude Code
  discards `systemMessage` on many events or hands it to Claude, so `notify-user` is not
  offered there. Every host key stays in `native.input`.
- Claude Code has no turn id, so `hostTurnId` is never set. `tool` is there only when
  both `tool_name` and `tool_input` are; `tool.input` is what the model sent (recorded:
  only the keys it passed, no defaults).
- `tool-input` alone writes `updatedInput` without a `permissionDecision`: it replaces the
  whole input and grants nothing, the permission rules run against the new input. Doc:
  "With no `permissionDecision`, auto mode can deny the changed call"; executed on 2.1.283
  by loadguard (the rewritten command ran). With `tool-permission` `allow` the rewritten
  call is approved, with `ask` the user sees it; `allow` with `tool-input` is what
  `AskUserQuestion` and `ExitPlanMode` need. `deny` with `tool-input` is
  `HOOK_EFFECT_UNSUPPORTED`: the docs give the pair no meaning.
- `tool-permission` `allow` still leaves the user's deny and ask rules in force; the
  reason of an `allow` goes to the debug log only, of a `deny` to Claude, of an `ask` to
  the permission prompt.
- `add-context` on `PreToolUse` (which Claude Code would place next to the tool result)
  or on `CwdChanged`, any other placement, `tool-permission` or `tool-input` on another
  event, or any other effect kind is `HOOK_EFFECT_UNSUPPORTED`. Text with an unpaired
  UTF-16 surrogate is written as a `\u` escape and delivered: Claude Code reads hook
  stdout with `JSON.parse`, which accepts it (what happens to it after that is not
  checked).
- `notify-user` is the top-level `systemMessage`, a "warning message shown to the user".
  On `CwdChanged` Claude Code shows it in interactive sessions as a brief terminal
  notification only; it does not reach the SDK message stream or a `-p` run. A hook
  declared `async` delivers its `systemMessage` to Claude on the next turn instead of
  showing it, which the codec cannot see: do not declare a `notify-user` hook async.
- Claude Code caps each `additionalContext` and `systemMessage` at 10,000 characters; a
  longer one is saved to a file in the session directory and replaced by the path and a
  2,000-character preview. The codec does not enforce the cap.
- `CwdChanged` has no decision control; `watchPaths` is not in the vocabulary.

**One entry for both hosts.** The SDK never guesses the host from the environment (Codex
sets `CLAUDE_PLUGIN_ROOT` too, ADR 0009). An entry that serves both takes the codec from
its own argument in the hook command, for example
`getty-bun.sh run dist/hook.js claude-code` in `hooks/hooks.json` and
`getty-bun.sh run dist/hook.js codex` in the Codex hook configuration:

```ts
import { main, type HookCodec } from "@getty/agent-bun-runtime";
import { claudeCode } from "@getty/agent-bun-runtime/claude-code";
import { codex } from "@getty/agent-bun-runtime/codex";

const codecs: Record<string, HookCodec> = { "claude-code": claudeCode, codex };
const codec = codecs[process.argv[2] ?? ""];
if (codec === undefined) {
  process.stderr.write(`hook: unknown host ${JSON.stringify(process.argv[2])}\n`);
  process.exit(1);
}
process.exit(await main({ codec, handler }));
```

The handler reads `invocation.host.kind` when the hosts need different answers.

### Exit codes

| Code | When | stdout | stderr |
|---|---|---|---|
| 0 | The effect was encoded and written | The encoded effect; nothing for `no-decision` | Nothing from the SDK |
| 1 | Every failure, typed or not, with `onFailure: "open"` (the default) | Nothing | One line: `agent-bun-runtime: <CODE>: <message>` |
| 2 | Every failure, with `onFailure: "closed"` | Nothing | The same line |

The SDK returns 2 only when the entry chose `onFailure: "closed"`: both hosts read exit 2
on `PreToolUse` and `UserPromptSubmit` as a block, and Codex blocks only with a non-empty
stderr, which the one line always is (Codex source-checked at `3f65e9f`:
`codex-rs/hooks/src/events/pre_tool_use.rs:268-284`, `user_prompt_submit.rs:229-245`,
see [The Codex codec](#the-codex-codec); Claude Code doc-checked below). Exit 2 is not
a block on these two events alone: in both hosts it acts on other events too, on `Stop`
and `SubagentStop` by keeping the agent working (below). So `"closed"` belongs only on an
entry whose hooks serve nothing but `PreToolUse` or `UserPromptSubmit`: a guard there that
must not let a tool call or a prompt through when it fails picks `"closed"`. An entry that
also serves any other event keeps `"open"`; a guard that needs `"closed"` gets its own
entry for those two events, or its own hook command whose argument the entry maps to the
policy. `main()` sees only the event at hand, not the events its command is wired to, so
the SDK does not check this rule. With `"open"` the host goes on, except where any
non-zero exit counts (Claude Code's `WorktreeCreate` and `WorktreeRemove`, below). An
`onFailure` other than `"open"` or `"closed"` is
`INTERNAL_ERROR` and exit 1, before stdin is read: the intended policy is unknown. The
codes stay within 0–255. On `OUTPUT_FAILED` stdout may
already hold bytes. Line breaks in the message become spaces. The codes:

| Code | Meaning |
|---|---|
| `HOOK_INPUT_INVALID` | stdin is empty, incomplete, too large, not UTF-8, not JSON, not an object, or unreadable; or the codec found the host object malformed |
| `HOOK_EFFECT_INVALID` | The handler returned no effect, a malformed one, or one with unknown fields; a `deny` without a reason; a `tool-input` that is not a plain JSON object; an empty list, a list with two effects of one kind, or `no-decision` beside another effect |
| `HOOK_EFFECT_UNSUPPORTED` | A kind, audience, placement or decision outside the vocabulary, or an effect or combination of effects the codec cannot deliver for this event (for an event without rules: anything but `no-decision`) |
| `HANDLER_FAILED` | The handler threw or rejected with something other than an `AgentRuntimeError` |
| `OUTPUT_FAILED` | Writing stdout failed (bytes may already be written) |
| `INTERNAL_ERROR` | Any other untyped error, naming the stage (a bug in the SDK or a codec), a `codec` that is not this package's, or an invalid `onFailure` |

An `AgentRuntimeError` the handler throws keeps its own code. Through a starter, the
entry's exit code reaches the host unchanged.

In Claude Code (doc-checked against https://code.claude.com/docs/en/hooks, fetched
2026-11-26T20:08Z and again at 21:44Z with identical content; line numbers of its
markdown `hooks.md`; not executed):

- Exit 2 with nothing on stdout is a blocking error, and the stderr is the reason
  (`hooks.md:808`, `:817`, `:850`). On `PreToolUse` it blocks the tool call and routes
  like `deny`: Claude sees the stderr as the denial reason (`:1038`, `:2098`). On
  `UserPromptSubmit` it rejects the prompt, and the stderr is treated like a block's
  `reason`, which is shown to the user (`:1040`, `:1588`). On `PostToolUse` Claude sees
  the stderr, the tool has already run (`:1050`); on `SessionStart` and `CwdChanged` the
  user sees it and nothing is blocked (`:1056`, `:1059`).
- Exit 2 acts on further events (table "Exit code 2 behavior per event",
  `:1030-1071`). On `Stop` it keeps Claude from stopping and the conversation goes on
  (`:1043`); on `SubagentStop` the subagent keeps working (`:1044`). It blocks compaction
  on `PreCompact` (`:1062`) and keeps a configuration change from taking effect on
  `ConfigChange` (`:1048`); it blocks or rolls back `UserPromptExpansion`,
  `PreSkillShellCommand`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`,
  `PostToolBatch`, `PreModelSwitch`, `Elicitation` and `ElicitationResult`
  (`:1041-1069`). On `WorktreeCreate` and `WorktreeRemove` every non-zero exit, 1
  included, makes the operation fail (`:1068-1069`). A `"closed"` entry that fails on
  `Stop`, `SubagentStop`, `TeammateIdle` or `TaskCompleted` sends Claude back to work,
  and Claude cannot repair a hook that fails; that is why Claude Code's own
  `"onFailure": "block"` has no effect on those events (`:992-994`), while the SDK's
  exit 2 is a real exit 2 there.
- Exception: when a `Stop`, `SubagentStop` or `TaskCompleted` hook, or a plugin's
  `UserPromptSubmit` hook, exits 2 with nothing on stdout and its stderr says a file is
  missing, such as `No such file or directory`, Claude Code treats it as a non-blocking
  error (`:823`). The SDK's line carries the handler's error message, so a `"closed"`
  entry whose handler fails with such a message does not block on those events.
- Exit 1 with nothing on stdout is a non-blocking error: the action goes ahead and a
  `<hook name> hook error` notice carries the stderr (`:809`, `:817`, `:880-882`),
  unless the hook is configured with `"onFailure": "block"` (Claude Code 2.1.295 or
  later), which makes it act like exit 2 on that event (`:942`, `:984`, `:990`).

### stdin

- `main()` reads **one complete JSON object**, not to the end of input, and does not
  depend on the host closing stdin (plan, "Host checks in phases 3a and 3b").
- One leading UTF-8 byte order mark (`EF BB BF`) is skipped, then whitespace; anything
  else before `{`, a second byte order mark or one after whitespace included, is an
  error. RFC 8259 section 8.1 lets a parser ignore the mark, and Windows PowerShell 5.1
  can write one into a child's redirected stdin under code page 65001 (not checked). The
  Windows starter avoids it by resetting that encoding (source-checked, read but not run:
  `bootstrap/getty-bun.ps1:639-644`).
  A scan that tracks strings and escapes finds the end of the object; `JSON.parse` then
  validates it.
- After the object it stops reading and cancels the stream: bytes that arrived in the
  same chunk after the object are read and dropped (not used), and nothing further is
  read. A stream reader left open keeps Bun 1.4.5 running while stdin is open (executed,
  linux-x64-baseline).
- Bounded: at most `maxInputBytes` (default 1 MiB) up to the end of the object, a leading
  byte order mark and whitespace included; reading stops at the bound.

### stdout

All hook output goes through one function that writes it once and writes nothing when it
is empty: Bun 1.4.5 on Windows fails an empty `Bun.write` to a stdout pipe with `EINVAL`
(CI 45572032454). Handlers must not write to stdout themselves; diagnostics go to
stderr.

### Developing

```sh
bun install --frozen-lockfile
bun run typecheck      # tsc over src/ and test/
bun run test           # bun test ./test/ (a bare test/ also matches bootstrap/test)
bun run build          # dist/; bun pm pack runs it as prepack
bun pm pack --dry-run  # dist/, README.md, LICENSE, package.json
```

Dev dependencies: `typescript` (typecheck, JavaScript and declarations) and `@types/bun`
(types of the Bun APIs, pinned to the Bun pin). `tsc` starts with `#!/usr/bin/env node`;
`bunfig.toml` (`[run] bun = true`) makes `node` resolve to Bun in the scripts and in the
prepack of `bun pm pack`, so all of the above need only the pinned Bun, also where a
Node is installed. Executed on Linux only (Bun 1.4.5, linux-x64-baseline): with no
`node` on PATH, and with a failing `node` first on PATH. CI cannot show it on Windows:
`windows-latest` has a Node on PATH.

## License

Artistic License 2.0, see [LICENSE](LICENSE).
