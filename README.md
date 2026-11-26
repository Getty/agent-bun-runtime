# agent-bun-runtime

Getty's Bun runtime for agent plugins, `getty-bun` for short
([ADR 0008](docs/adr/0008-repository-and-package-name.md)).

- **Bootstrap** (`bootstrap/`): two small starters, `getty-bun.sh` (POSIX `sh`, Linux)
  and `getty-bun.ps1` (Windows PowerShell 5.1 and PowerShell 7), that put one exact,
  checksum-verified Bun into `~/.getty/runtimes/bun/<version>/<target>/` and run a
  plugin's TypeScript with it. No Bun, Node or Python needed beforehand. To be delivered
  to plugins as the skilletor template `getty-bun-install` (not built yet).
- **`@getty/agent-bun-runtime`**: the SDK Getty plugins run on under that Bun: a hook
  `main()` with context, typed errors and effects, and the Codex codec. Codecs for Claude
  Code and Hermes are planned.

Status: phase 1 (the starters in `bootstrap/`) is merged into `main` at `262bc95` (PR 1,
CI run 45603412444). Phase 2 is in progress: the host-neutral core of the SDK (`src/`) and
the Codex codec (`./codex`) are built; the phase 2 gate is not passed yet. Nothing is
released: no tag, nothing on npm. Plan and phases: [docs/plan.md](docs/plan.md).

## The SDK: `@getty/agent-bun-runtime`

ESM plus type declarations in `dist/`, compiled from `src/` by `tsc`. It runs on Bun only
and has no runtime dependencies. Consumers bundle it into their entry (`bun build
--target=bun`, [ADR 0003](docs/adr/0003-bundled-entry.md)): it has no dynamic imports, does
not read its own package files, and importing it does nothing by itself.

### Public API

Two exports: the package root, and `@getty/agent-bun-runtime/codex` with the Codex codec
`codex: HookCodec` ([below](#the-codex-codec)). The root:

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
}
type HookHandler = (context: HookContext) => HookEffect | Promise<HookEffect>;
interface HookContext { invocation: HookInvocation; env: Env }
type HookEffect = NoDecisionEffect | AddContextEffect;
interface NoDecisionEffect { kind: "no-decision" }
interface AddContextEffect {
  kind: "add-context"; text: string; audience: "model"; placement: ContextPlacement;
}
type ContextPlacement = "session-start-input" | "subagent-input";
interface HookCodec {
  decode(input: Readonly<Record<string, unknown>>, inputs: DecodeInputs): HookInvocation;
  encode(effect: HookEffect, invocation: HookInvocation): string;
}
interface DecodeInputs { processCwd: string }
interface HookInvocation {
  contractVersion: 1;
  host: { kind: HostKind; surface: HostSurface };   // "codex", "command-hook"
  event: { nativeName: string };
  location: { processCwd: string; hostWorkingDirectory?: string };
  identity: { hostSessionId?: string; hostTurnId?: string };
  native: { input: Readonly<Record<string, unknown>> };
}
type Env = Readonly<Record<string, string | undefined>>;
type OutputWriter = (bytes: Uint8Array) => unknown;
type ErrorCode = "HOOK_INPUT_INVALID" | "HOOK_EVENT_UNSUPPORTED" | "HOOK_EFFECT_INVALID"
  | "HOOK_EFFECT_UNSUPPORTED" | "HANDLER_FAILED" | "OUTPUT_FAILED" | "INTERNAL_ERROR";
type ErrorStage = "input" | "decode" | "handler" | "effect" | "encode" | "output";
```

All fields are `readonly`. The invocation is frozen; a field the host did not send is
absent, never filled with a default; event-specific host fields stay in `native.input`.
A codec translates one host's protocol.

`main()` reads stdin, decodes it with the codec, runs the handler, validates the effect,
encodes it and writes stdout once. It never calls `process.exit`.

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

It handles the Codex command hooks `SessionStart` and `SubagentStart`. Every rule is
source-checked against openai/codex `3f65e9f`; none has run against a real Codex yet
(phase 3a).

| Event | Envelope | Effects | stdout |
|---|---|---|---|
| `SessionStart` | `hostSessionId` from `session_id`, `hostWorkingDirectory` from `cwd` | `no-decision`; `add-context` at `session-start-input` | Nothing; `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}` and LF |
| `SubagentStart` | As `SessionStart`, plus `hostTurnId` from `turn_id` | `no-decision`; `add-context` at `subagent-input` | Nothing; the same object with `SubagentStart` |

- Only `hook_event_name` is required. A known key of the event with the wrong type is
  `HOOK_INPUT_INVALID` (`transcript_path` may be `null`); any other event is
  `HOOK_EVENT_UNSUPPORTED`. Every host key stays in `native.input`.
- For `SubagentStart`, `hostSessionId` is the root thread's: Codex's `session_id` is
  shared by the root thread and all its subagents, and the parent thread's id is not in
  the hook input.
- The other placement, or text with an unpaired UTF-16 surrogate, is
  `HOOK_EFFECT_UNSUPPORTED`.
- In Codex any non-zero exit fails a start hook: stdout and stderr are discarded, so the
  SDK's stderr line is not shown (source-checked,
  `codex-rs/hooks/src/events/session_start.rs:316-330`). The turn stops only when the
  hook is configured with `onFailure: "block"` and runs synchronously (source-checked,
  `codex-rs/hooks/src/events/common.rs:74-90`, `codex-rs/hooks/src/engine/mod.rs:216-226`,
  `session_start.rs:345-348`).

### Exit codes

| Code | When | stdout | stderr |
|---|---|---|---|
| 0 | The effect was encoded and written | The encoded effect; nothing for `no-decision` | Nothing from the SDK |
| 1 | Every failure, typed or not | Nothing | One line: `agent-bun-runtime: <CODE>: <message>` |

The SDK never returns 2 for its own failures (some hosts read 2 as a block, and no MVP
effect blocks), and its codes stay within 0–255. Line breaks in the message become
spaces. The codes:

| Code | Meaning |
|---|---|
| `HOOK_INPUT_INVALID` | stdin is empty, incomplete, too large, not UTF-8, not JSON, not an object, or unreadable; or the codec found the host object malformed |
| `HOOK_EVENT_UNSUPPORTED` | The codec does not handle this event |
| `HOOK_EFFECT_INVALID` | The handler returned no effect, a malformed one, or one with unknown fields |
| `HOOK_EFFECT_UNSUPPORTED` | A kind, audience or placement outside the vocabulary, or one the codec cannot deliver for this event |
| `HANDLER_FAILED` | The handler threw or rejected with something other than an `AgentRuntimeError` |
| `OUTPUT_FAILED` | Writing stdout failed (bytes may already be written) |
| `INTERNAL_ERROR` | Any other untyped error, naming the stage (a bug in the SDK or a codec) |

An `AgentRuntimeError` the handler throws keeps its own code. Through a starter, the
entry's exit code reaches the host unchanged.

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
