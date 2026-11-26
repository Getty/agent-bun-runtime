/**
 * The Codex codec: command hooks `SessionStart`, `SubagentStart`, `UserPromptSubmit`,
 * `PreToolUse` and `PostToolUse`; any other event is decoded generically.
 *
 * Every Codex rule below is source-checked against openai/codex
 * 3f65e9f13165d85d1b1fbe20ce06c55758f927b9, never executed; paths are relative to its
 * repository root. Real Codex runs are phase 3a (k22).
 */
import { decodeGenericEvent, defineCodec, type HookCodec } from "./codec.js";
import { createInvocation, type HookInvocation } from "./context.js";
import type { AddContextEffect, ContextPlacement, HookEffect, ToolInputEffect, ToolPermissionEffect } from "./effects.js";
import { AgentRuntimeError } from "./errors.js";

type CodexEvent = "SessionStart" | "SubagentStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse";

interface EventRule {
  /**
   * The keys this codec lifts into the envelope, besides `session_id` and `cwd`: `turn_id`
   * (`hostTurnId`) and `tool_name` (`tool.name`). Only lifted keys are type-checked.
   */
  readonly lifts: readonly ("turn_id" | "tool_name")[];
  /** The one placement Codex delivers `additionalContext` to for this event, if any. */
  readonly placement?: ContextPlacement;
}

const EVENTS: Readonly<Record<CodexEvent, EventRule>> = {
  // SessionStartCommandInput, codex-rs/hooks/src/schema.rs:497-511. The context becomes a
  // developer message before the turn's first model request
  // (codex-rs/core/src/hook_runtime.rs:908-924, codex-rs/core/src/session/turn.rs:387).
  SessionStart: {
    lifts: [],
    placement: "session-start-input",
  },
  // SubagentStartCommandInput, schema.rs:547-563. The context lands in the subagent's
  // thread only (codex-rs/hooks/src/events/session_start.rs:264-272,
  // codex-rs/core/tests/suite/subagent_notifications.rs:678-704).
  SubagentStart: {
    lifts: ["turn_id"],
    placement: "subagent-input",
  },
  // UserPromptSubmitCommandInput, schema.rs:565-584, built at
  // codex-rs/hooks/src/events/user_prompt_submit.rs:83-94 from the prompt's text items
  // (codex-rs/core/src/hook_runtime.rs:731-745). The context becomes a developer message
  // recorded right after the user prompt (codex-rs/core/src/session/turn.rs:1215-1245,
  // hook_runtime.rs:771-828, :908-924), from
  // `hookSpecificOutput.additionalContext` (user_prompt_submit.rs:170-181).
  UserPromptSubmit: {
    lifts: ["turn_id"],
    placement: "prompt-input",
  },
  // PreToolUseCommandInput, schema.rs:276-297, built at
  // codex-rs/hooks/src/events/pre_tool_use.rs:181-197. Codex reads `additionalContext`
  // here too (pre_tool_use.rs:230-240), but the vocabulary has no placement for it.
  PreToolUse: {
    lifts: ["turn_id", "tool_name"],
  },
  // PostToolUseCommandInput, schema.rs:321-343, built at
  // codex-rs/hooks/src/events/post_tool_use.rs:154-170 after a successful tool call
  // (codex-rs/core/src/tools/registry.rs:1061-1079). The context becomes a developer
  // message after the tool's result (registry.rs:1081-1089, hook_runtime.rs:908-924),
  // from `hookSpecificOutput.additionalContext` (post_tool_use.rs:204-215).
  PostToolUse: {
    lifts: ["turn_id", "tool_name"],
    placement: "tool-result",
  },
};

// Tools whose rewrite Codex reads from the string field `command` alone: `Bash`
// (codex-rs/core/src/tools/hook_names.rs:53-56) takes `command` into the call's `cmd` and
// keeps its other arguments (codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:370-388,
// codex-rs/core/src/tools/handlers/mod.rs:112-121, :142-151); `apply_patch`
// (hook_names.rs:34-39) parses `command` as the patch (handlers/apply_patch.rs:377-382).
// Any other key of `updatedInput` would be dropped without a word.
const COMMAND_TOOLS: readonly string[] = ["Bash", "apply_patch"];

const HOST = { kind: "codex", surface: "command-hook" } as const;

// Unpaired UTF-16 surrogates: with the `u` flag a valid pair is one code point, not `Cs`.
const LONE_SURROGATE = /\p{Cs}/u;

// What Rust's `str::trim` removes: `char::is_whitespace`, the Unicode `White_Space`
// property. JavaScript's `trim` differs (it removes U+FEFF and keeps U+0085).
const RUST_BLANK = /^\p{White_Space}*$/u;

function isCodexEvent(name: string): name is CodexEvent {
  return Object.hasOwn(EVENTS, name);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function inputInvalid(message: string): AgentRuntimeError {
  return new AgentRuntimeError("HOOK_INPUT_INVALID", "decode", message);
}

function unsupported(message: string): AgentRuntimeError {
  return new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "encode", message);
}

function stringField(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

// True when a string anywhere in `value`, a key included, has an unpaired surrogate.
function hasLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") return LONE_SURROGATE.test(value);
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(hasLoneSurrogate);
  return Object.entries(value).some(([key, child]) => LONE_SURROGATE.test(key) || hasLoneSurrogate(child));
}

/**
 * Decode:
 * - `hook_event_name` missing or not a string: `HOOK_INPUT_INVALID`. A string other than
 *   the five events above is decoded generically (`decodeGenericEvent`: `session_id` and
 *   `cwd` when they are strings); its other keys are not checked.
 * - Every other key is optional; the decoder does not require what this Codex commit always
 *   writes (the structs above have no `skip_serializing_if` except on `agent_id` and
 *   `agent_type`), since the release a host runs may differ.
 * - Only the keys the codec lifts into the envelope are type-checked (ADR 0009, k30):
 *   `session_id` and `cwd` on every event, `turn_id` on every event but `SessionStart`,
 *   `tool_name` on `PreToolUse` and `PostToolUse`. Each, when present, must be a string,
 *   else `HOOK_INPUT_INVALID`. `tool_input` is lifted as any JSON value. Every other key
 *   (`transcript_path`, `model`, `permission_mode`, `source`, `prompt`, `agent_id`,
 *   `agent_type`, `tool_use_id`, `tool_response`, unknown keys) stays in `native.input`
 *   unchecked: no consumer of the envelope reads it, and a Codex release that changes
 *   its type must not turn every hook into `HOOK_INPUT_INVALID` (under
 *   `onFailure: "closed"` that would block every `PreToolUse`). A handler that reads one
 *   of them from `native.input` checks its type itself.
 * - `session_id` becomes `hostSessionId`, `cwd` becomes `hostWorkingDirectory`, and for
 *   every event but `SessionStart` `turn_id` becomes `hostTurnId`. For `PreToolUse` and
 *   `PostToolUse` with both `tool_name` and `tool_input` present, `tool` is
 *   `{ name: tool_name, input: tool_input }`; with either missing there is no `tool`.
 *   `tool_name` is Codex's canonical name (`Bash` for shell commands, `apply_patch` for
 *   edits, an MCP tool's own name), not a matcher alias (pre_tool_use.rs:173-180,
 *   hook_names.rs:28-56). The handoff's `hostParentSessionId` is not in the MVP
 *   envelope, and Codex gives nothing to fill it: `session_id` is the identity shared by
 *   the root thread and all its descendants (codex-rs/core/src/session/session.rs:677-680),
 *   not the parent thread, which differs once `agents.max_depth` exceeds its default 1
 *   (codex-rs/core/src/config/mod.rs:294, :4330-4334); the parent's thread id
 *   (`parent_thread_id`, codex-rs/protocol/src/protocol.rs:3327-3328) is not in the hook
 *   input.
 *
 * Encode, always JSON on stdout with exit 0 (plain stdout is trimmed, and stdout that
 * starts with `{` or `[` must parse: session_start.rs:288-313, user_prompt_submit.rs:158-227,
 * pre_tool_use.rs:220-266, post_tool_use.rs:193-262): one object for the whole effect list
 * and one LF. Its keys are only `hookSpecificOutput` and `systemMessage`, in that order,
 * whatever the order of the list; inside `hookSpecificOutput`, `hookEventName` comes
 * first, then the fields of the one effect that fills it, in the order shown below. The
 * order is the codec's choice, not Codex's: serde reads the object by key. No other key:
 * the output wires deny unknown fields (schema.rs:128-141, :143-156, :229-256, :385-425,
 * :427-450), and an output that fails to parse fails the hook.
 * - `no-decision`: `""` on every event (empty stdout and exit 0 add nothing,
 *   session_start.rs:243-246, user_prompt_submit.rs:160, pre_tool_use.rs:221-222,
 *   post_tool_use.rs:194-195).
 * - `add-context` at the event's one placement:
 *   `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":<text>}}`.
 *   `additionalContext` is used as is (session_start.rs:264-272,
 *   codex-rs/hooks/src/events/common.rs:48-66). `PreToolUse` has no placement.
 * - `tool-permission` on `PreToolUse`, decision `deny`:
 *   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<reason>}}`.
 *   Codex blocks the call with the trimmed reason (output_parser.rs:144-152, :514-521,
 *   pre_tool_use.rs:248-255) and fails the hook when the trimmed reason is empty
 *   (output_parser.rs:461-471), so a reason that is all white space (Rust's
 *   `White_Space`) is `HOOK_EFFECT_UNSUPPORTED`. Decisions `allow` and `ask` are
 *   `HOOK_EFFECT_UNSUPPORTED`: Codex rejects both as unsupported and fails the hook
 *   (output_parser.rs:452-460); it can neither grant a call nor ask about it from here.
 * - `tool-input` on `PreToolUse`:
 *   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":<input>}}`.
 *   Codex takes `updatedInput` only with `permissionDecision` `allow`
 *   (output_parser.rs:162-173, :444-456), and that `allow` grants nothing: the rewrite is
 *   applied before the tool runs its own approval, and a changed call drops any earlier
 *   assessment (codex-rs/core/src/tools/registry.rs:907, :1238-1248). With several hooks
 *   the rewrite of the hook that finished last wins (pre_tool_use.rs:153-171). For
 *   `Bash` and `apply_patch` the input must be exactly `{ command: <string> }`, since
 *   Codex reads nothing else (see `COMMAND_TOOLS`); without a `tool` in the invocation
 *   the rewrite cannot be checked against the tool. Both are `HOOK_EFFECT_UNSUPPORTED`.
 *   Whether a rewritten `apply_patch` parses as a patch is Codex's check, at run time
 *   (apply_patch.rs:383-385).
 * - `notify-user`: top-level `{"systemMessage":<text>}`, on all five events. Every one
 *   of their output wires flattens the universal fields, `systemMessage` among them
 *   (schema.rs:88-100; :128-141, :143-156, :385-394, :406-415, :427-440), and every one
 *   turns it into a `Warning` entry of the hook run before it looks at anything else
 *   (session_start.rs:258-263, user_prompt_submit.rs:164-169, pre_tool_use.rs:224-229,
 *   post_tool_use.rs:198-203). Neither the `PreToolUse` nor the `PostToolUse` checks
 *   reject it (output_parser.rs:369-379, :393-399, :499-505). The TUI prints the run's
 *   first `Warning` entry under the hook's line
 *   (codex-rs/tui/src/history_cell/hook_cell.rs:281-330), for a synchronous, non-builtin
 *   hook (codex-rs/core/src/hook_runtime.rs:962-964, :986-1016). The text is not trimmed or checked; the core already requires it
 *   non-empty. For `SubagentStart` the run belongs to the subagent's thread.
 * - A list merges into the one object: `notify-user` beside any one other effect adds
 *   `systemMessage` next to that effect's `hookSpecificOutput`. `tool-permission` and
 *   `tool-input` together are `HOOK_EFFECT_UNSUPPORTED`: Codex fails the hook on
 *   `updatedInput` beside `deny` (output_parser.rs:444-450), and the `allow` it takes
 *   beside `updatedInput` grants nothing. `add-context` with either has no `PreToolUse`
 *   placement. One effect the codec cannot deliver fails the whole list; nothing is
 *   dropped.
 * - `HOOK_EFFECT_UNSUPPORTED` (stage `encode`) for any other placement or event, for a
 *   string to write with an unpaired surrogate (the context text, the `notify-user` text,
 *   the reason, any key or string inside the new input: JSON.stringify writes it as a
 *   `\u` escape that serde_json rejects for a string, read.rs:900-960 in serde_json
 *   1.0.150, Codex locks 1.0.149), for any other effect kind, and for an invocation of
 *   another event every effect but `no-decision`, which is `""`. That includes
 *   `notify-user`: Codex's other events differ (`SessionEnd` ignores stdout,
 *   codex-rs/hooks/src/events/session_end.rs:96-110; `Interrupt` accepts nothing but
 *   `systemMessage`, schema.rs:482-489), and a future event's output is unknown.
 */
export const codex: HookCodec = defineCodec("codex", {
  decode(input, { processCwd }): HookInvocation {
    const event = input.hook_event_name;
    if (typeof event !== "string") {
      throw inputInvalid(`Codex input: hook_event_name is ${typeName(event)}, expected a string`);
    }
    if (!isCodexEvent(event)) return decodeGenericEvent(HOST, event, input, { processCwd });
    const lifts = EVENTS[event].lifts;
    for (const key of ["session_id", "cwd", ...lifts]) {
      const value = input[key];
      if (value === undefined || typeof value === "string") continue;
      throw inputInvalid(`Codex ${event} input: ${key} is ${typeName(value)}, expected a string`);
    }
    const toolName = stringField(input, "tool_name");
    const hasTool = lifts.includes("tool_name") && toolName !== undefined && "tool_input" in input;
    return createInvocation({
      host: HOST,
      nativeEvent: event,
      processCwd,
      hostWorkingDirectory: stringField(input, "cwd"),
      hostSessionId: stringField(input, "session_id"),
      hostTurnId: lifts.includes("turn_id") ? stringField(input, "turn_id") : undefined,
      tool: hasTool ? { name: toolName, input: input.tool_input } : undefined,
      nativeInput: input,
    });
  },

  encode(effects: readonly HookEffect[], invocation: HookInvocation): string {
    const event = invocation.event.nativeName;
    if (effects.every((effect) => effect.kind === "no-decision")) return "";
    if (!isCodexEvent(event)) {
      throw unsupported(`the Codex codec has no rules for event ${JSON.stringify(event)}: only no-decision`);
    }
    const kinds = effects.map((effect) => effect.kind);
    if (event === "PreToolUse" && kinds.includes("tool-permission") && kinds.includes("tool-input")) {
      throw unsupported(
        "Codex PreToolUse cannot deliver tool-permission and tool-input together: Codex fails the hook on updatedInput beside deny, and its allow beside updatedInput grants nothing",
      );
    }
    // At most one effect fills hookSpecificOutput: add-context has no PreToolUse
    // placement, and tool-permission with tool-input is rejected above.
    let specific: Readonly<Record<string, unknown>> | undefined;
    let systemMessage: string | undefined;
    for (const effect of effects) {
      switch (effect.kind) {
        case "no-decision":
          break;
        case "notify-user":
          if (LONE_SURROGATE.test(effect.text)) {
            throw unsupported(`Codex ${event} cannot deliver notify-user text with an unpaired UTF-16 surrogate`);
          }
          systemMessage = effect.text;
          break;
        case "add-context":
          specific = encodeContext(event, effect);
          break;
        case "tool-permission":
          if (event !== "PreToolUse") throw unsupported(`Codex ${event} cannot deliver tool-permission, only PreToolUse`);
          specific = encodePermission(effect);
          break;
        case "tool-input":
          if (event !== "PreToolUse") throw unsupported(`Codex ${event} cannot deliver tool-input, only PreToolUse`);
          specific = encodeToolInput(effect, invocation);
          break;
        default: {
          const kind: unknown = (effect as { kind?: unknown }).kind;
          throw unsupported(`Codex ${event} cannot deliver effect ${JSON.stringify(kind)}`);
        }
      }
    }
    const output: Record<string, unknown> = {};
    if (specific !== undefined) output.hookSpecificOutput = { hookEventName: event, ...specific };
    if (systemMessage !== undefined) output.systemMessage = systemMessage;
    return `${JSON.stringify(output)}\n`;
  },
});

function encodeContext(event: CodexEvent, effect: AddContextEffect): Readonly<Record<string, unknown>> {
  const placement = EVENTS[event].placement;
  if (effect.placement !== placement) {
    const only = placement === undefined ? "it has no placement" : `only ${placement}`;
    throw unsupported(`Codex ${event} cannot deliver add-context at placement ${JSON.stringify(effect.placement)}, ${only}`);
  }
  if (LONE_SURROGATE.test(effect.text)) {
    throw unsupported(`Codex ${event} cannot deliver add-context text with an unpaired UTF-16 surrogate`);
  }
  return { additionalContext: effect.text };
}

function encodePermission(effect: ToolPermissionEffect): Readonly<Record<string, unknown>> {
  if (effect.decision !== "deny") {
    throw unsupported(
      `Codex PreToolUse cannot deliver tool-permission ${JSON.stringify(effect.decision)}: Codex rejects allow and ask, only deny`,
    );
  }
  const reason = effect.reason ?? "";
  if (RUST_BLANK.test(reason)) {
    throw unsupported("Codex PreToolUse cannot deliver a deny whose reason is only white space");
  }
  if (LONE_SURROGATE.test(reason)) {
    throw unsupported("Codex PreToolUse cannot deliver a deny reason with an unpaired UTF-16 surrogate");
  }
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}

function encodeToolInput(effect: ToolInputEffect, invocation: HookInvocation): Readonly<Record<string, unknown>> {
  const tool = invocation.tool;
  if (tool === undefined) {
    throw unsupported("Codex PreToolUse cannot deliver tool-input without tool_name and tool_input in the input");
  }
  const input = effect.input;
  if (COMMAND_TOOLS.includes(tool.name)) {
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== "command" || typeof input.command !== "string") {
      throw unsupported(
        `Codex PreToolUse cannot deliver tool-input for ${tool.name} other than exactly { command: string }: Codex reads nothing else`,
      );
    }
  }
  if (hasLoneSurrogate(input)) {
    throw unsupported("Codex PreToolUse cannot deliver tool-input with an unpaired UTF-16 surrogate in a key or string");
  }
  return { permissionDecision: "allow", updatedInput: input };
}
