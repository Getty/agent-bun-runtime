# The SDK for plugin authors

`@getty/agent-bun-runtime` 0.1.0: what a plugin's hook entry uses. The full API listing,
the per-event codec tables and their source references are in the release's `README.md`,
"The SDK"; the decisions in ADR 0009. This page is the author's path through them.

## Contents

- [Package and imports](#package-and-imports)
- [The entry](#the-entry)
- [main() options](#main-options)
- [The invocation](#the-invocation)
- [Effects](#effects)
- [Exit codes and failure policy](#exit-codes-and-failure-policy)
- [stdin and stdout](#stdin-and-stdout)
- [Versions: package, pin, contract, envelope](#versions-package-pin-contract-envelope)
- [Testing](#testing)

## Package and imports

ESM plus type declarations, Bun only, no runtime dependencies, nothing happens on import.
Three exports:

| Import | What |
|---|---|
| `@getty/agent-bun-runtime` | `main`, `AgentRuntimeError`, `DEFAULT_MAX_INPUT_BYTES`, the types |
| `@getty/agent-bun-runtime/codex` | `codex: HookCodec` |
| `@getty/agent-bun-runtime/claude-code` | `claudeCode: HookCodec` |

`HookCodec` is opaque: pass one of these two to `main()`; a plugin cannot implement one
(anything else is `INTERNAL_ERROR`). The SDK is bundled into the entry
([dependencies-and-execution.md](dependencies-and-execution.md)); take it from npm.

## The entry

One host per entry:

```ts
import { main } from "@getty/agent-bun-runtime";
import { codex } from "@getty/agent-bun-runtime/codex";

process.exit(await main({ codec: codex, handler }));
```

One entry for both hosts takes the host from its own argument in the hook command
(`getty-bun.sh run dist/hook.js claude-code`, `... codex`):

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

Never pick the host from environment variables: Codex sets `CLAUDE_PLUGIN_ROOT` too. A
handler that must answer differently per host reads `invocation.host.kind`.

`process.exit(await main(...))` ends the hook as soon as `main()` returns, after it wrote
everything, also when the host keeps stdin open or the handler left a timer or socket
open. `main()` itself never calls `process.exit`. (Executed with stdin held open by a test,
not a host: Linux, and Windows directly and through both Windows starters, agent-bun-runtime
CI 45883791115.)

## main() options

| Option | Default | Use |
|---|---|---|
| `codec` | required | `codex` or `claudeCode` |
| `handler` | required | `(context) => effect \| effect[]`, sync or async |
| `onFailure` | `"open"` | `"open"`: failures exit 1, the host goes on. `"closed"`: failures exit 2, a block on `PreToolUse` and `UserPromptSubmit`, and an action on other events (on `Stop` and `SubagentStop` the agent keeps working). Only an entry that serves nothing but `PreToolUse` or `UserPromptSubmit` picks `"closed"`, as a guard that must not let a tool or prompt through when it fails; any other entry keeps `"open"`, and a guard gets its own entry or hook command. `main()` sees only the current event and does not check this. `"silent"`: failures exit 0 with nothing on stdout, for a guard that must stay invisible on broken input (see [below](#exit-codes-and-failure-policy)). Anything else: `INTERNAL_ERROR`, exit 1, before stdin is read |
| `maxInputBytes` | `DEFAULT_MAX_INPUT_BYTES` (1 MiB) | Bound for the hook object. It applies before the event is known: an event that needs a larger bound (big `Write` or `PostToolUse` payloads) gets its own hook command with an argument the entry maps to a larger value |
| `stdin`, `stdout`, `stderr`, `env`, `cwd` | the real process | Injection for tests ([Testing](#testing)) |

The handler gets `{ invocation, env }`. It must not write to stdout. Throwing an
`AgentRuntimeError` keeps its code; anything else thrown is `HANDLER_FAILED`.

## The invocation

Frozen; a field the host did not send is absent, never defaulted.

- `envelopeVersion: 1`; `host: { kind, surface }` (`"codex"` or `"claude-code"`,
  `"command-hook"`); `event.nativeName` (the host's `hook_event_name`).
- `location.processCwd` (the hook's working directory, which the starter keeps) and
  `location.hostWorkingDirectory` (the host's `cwd`).
- `identity.hostSessionId`, `identity.hostTurnId` (Codex only; Claude Code has no turn
  id). In Codex every event but `SessionStart` carries the root thread's session id.
- `tool: { name, input }` on `PreToolUse` and `PostToolUse` when the host sent both
  `tool_name` and `tool_input`: in Codex `Bash` and `apply_patch` with
  `{ "command": ... }`; in Claude Code the tool's input as the model sent it.
- `native.input`: the whole host object, every key; event-specific fields
  (`prompt`, `tool_response`, `old_cwd`, `source`, ...) are read from here.

**Unknown events.** Any object with a string `hook_event_name` decodes: session and
working directory when present as strings, everything in `native.input`. For an event the
codec has no rules for, only `no-decision` encodes. `HostKind`, `HostSurface`,
`ContextPlacement`, the effect kinds and `ErrorCode` may gain members in a minor release:
keep a default branch in every `switch`.

## Effects

A handler returns one effect or a non-empty list with **at most one effect per kind**;
`no-decision` stands alone. The codec merges a list into one output. Each codec delivers
what its host can for the event and rejects the rest with `HOOK_EFFECT_UNSUPPORTED`; it
never converts an effect into another.

| Effect | Shape | Codex | Claude Code |
|---|---|---|---|
| `no-decision` | `{ kind }` | every event | every event |
| `add-context` | `{ kind, text, audience: "model", placement }` | `session-start-input` (`SessionStart`), `subagent-input` (`SubagentStart`), `prompt-input` (`UserPromptSubmit`), `tool-result` (`PostToolUse`) | the same, without `SubagentStart` |
| `tool-permission` | `{ kind, decision: "allow" \| "deny" \| "ask", reason? }`, reason required for `deny` | `PreToolUse`, `deny` only (reason not blank) | `PreToolUse`, all three |
| `tool-input` | `{ kind, input }`, a plain JSON object replacing the tool's input; grants nothing | `PreToolUse`; for `Bash` and `apply_patch` exactly `{ "command": <string> }` | `PreToolUse` |
| `notify-user` | `{ kind, text }`, shown to the user, not the model | `systemMessage`, the five events with rules | `systemMessage`, the five events with rules |

`tool-permission` with `tool-input`: Claude Code takes `allow` or `ask` with the new input
in one output (not `deny`); Codex takes neither combination. Never declare a Claude Code
hook `async` that returns `notify-user`: its message would go to the model.

Per-event details, the JSON each codec writes, and the host's semantics (what `allow`
leaves in force, Codex's `allow` plus `updatedInput`, Claude Code's 10,000-character
context cap) are in [codex.md](codex.md), [claude-code.md](claude-code.md) and the
release's README codec tables, which also list the events on which `notify-user` and
effect lists encode; trust those tables over this one. Malformed effects are
`HOOK_EFFECT_INVALID`.

## Exit codes and failure policy

| Exit | When | stdout | stderr |
|---|---|---|---|
| 0 | The effect was encoded and written | The hook JSON and LF; nothing for `no-decision` | Nothing from the SDK |
| 0 | Any failure with `onFailure: "silent"` | Nothing | `agent-bun-runtime: <CODE>: <message>` |
| 1 | Any failure with `onFailure: "open"` | Nothing | `agent-bun-runtime: <CODE>: <message>` |
| 2 | Any failure with `onFailure: "closed"` | Nothing | The same line |

Codes: `HOOK_INPUT_INVALID`, `HOOK_EFFECT_INVALID`, `HOOK_EFFECT_UNSUPPORTED`,
`HANDLER_FAILED`, `OUTPUT_FAILED` (stdout may hold bytes), `INTERNAL_ERROR`. Every
decision travels as JSON with exit 0; exit 2 is never a way to deny. Exit 2 is not only
a block: on `Stop` and `SubagentStop` both hosts keep the agent working, and Claude Code
also blocks `PreCompact`, `ConfigChange` and more on it, so `"closed"` stays on entries
that serve only `PreToolUse` or `UserPromptSubmit`. How each host shows
exit 1 and 2 per event: [codex.md](codex.md), [claude-code.md](claude-code.md). Codex
discards stdout and stderr of a failed start hook, so the line shows only in a manual run.

`"silent"` is for a guard that must stay invisible on broken input (an empty, truncated or
changed host payload), where exit 1 would make the host show a hook error on every call.
A failure exits 0 with nothing on stdout, the bytes a `no-decision` ends with, so the host
goes on as if the entry had decided nothing. The trade-off: the failure is visible only
where the host logs a hook's stderr, and a guard on `PreToolUse` or `UserPromptSubmit`
lets the tool call or prompt through without a word. A guard that must block when it
fails picks `"closed"` instead. One exception to "nothing on stdout": an `OUTPUT_FAILED`
under `"silent"` also exits 0, even when part of the hook JSON already reached stdout, so
the host can read a truncated object after a successful exit (source-checked,
`src/main.ts`).

## stdin and stdout

- `main()` reads **one JSON object**, not to end of input: it does not depend on the host
  closing stdin, stops after the object and drops what follows.
- One leading UTF-8 byte order mark is skipped, then white space; anything else before
  `{` is `HOOK_INPUT_INVALID`.
- At most `maxInputBytes` (default 1 MiB) up to the end of the object; more is
  `HOOK_INPUT_INVALID`.
- stdout is written once and not at all when empty (Bun 1.4.5 on Windows fails an empty
  write to a stdout pipe with `EINVAL`). Diagnostics go to stderr.

## Versions: package, pin, contract, envelope

| Name | Where | Means |
|---|---|---|
| `@getty/agent-bun-runtime` version | the consumer's dependencies | The SDK; matches the `ref` of the skill source (`0.1.0` and `v0.1.0`) |
| `gettyBun.bunVersion` | the consumer's `package.json` | The exact Bun; equals the starters' pin block and `vars.bun_version` |
| `gettyBun.contractVersion` | the consumer's `package.json` | Version of this integration contract: `1` |
| `envelopeVersion` | `HookInvocation` at run time | Version of the invocation's shape: `1` |

The last two are different things under different names (ADR 0009).

## Testing

Use `bun:test` with the pinned Bun. Two levels:

**The handler through `main()`**, in process, with a recorded host payload. Proves the
handler and the codec, not the host:

```ts
import { expect, test } from "bun:test";
import { main } from "@getty/agent-bun-runtime";
import { claudeCode } from "@getty/agent-bun-runtime/claude-code";
import { handler } from "../src/handler.ts";

test("PreToolUse: rm -rf is denied with a reason", async () => {
  const payload = await Bun.file("test/fixtures/claude-code/pre-tool-use.bash.json").text();
  let stdout = "";
  const stderr: string[] = [];
  const code = await main({
    codec: claudeCode,
    handler,
    stdin: new Response(payload).body!,
    stdout: (bytes) => { stdout = new TextDecoder().decode(bytes); },
    stderr: (line) => { stderr.push(line); },
    env: {},
    cwd: "/project",
  });
  expect(code).toBe(0);
  expect(stderr).toEqual([]);
  expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
});
```

- Record fixtures from the real host and name the host version they came from; an
  invented payload tests your assumption, not the host. Cover each event you wire, one
  malformed payload (exit 1, 2 or, with `"silent"`, 0 with one stderr line), and each effect's rejection on
  an event the codec does not support.
- Pass `env` and `cwd`: without them the test runner's `process.env` and
  `process.cwd()` reach the handler.

**The bundled entry through the starter**, as a process: `sh bootstrap/getty-bun.sh run
dist/hook.js <host>` with the payload on stdin, checking stdout byte for byte and the exit
code. Set `GETTY_HOME`, `HOME` (and `CODEX_HOME` for Codex runs) to a fresh temporary
directory; never the real `~/.getty`, `~/.codex` or `~/.claude`. Use a local Bun archive
through `GETTY_BUN_MIRROR` or an already installed slot in that temporary `GETTY_HOME`,
not a download per test. Run it from a working directory that is not the plugin root.
