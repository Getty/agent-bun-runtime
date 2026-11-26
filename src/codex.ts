/**
 * The Codex codec: command hooks `SessionStart` and `SubagentStart`.
 *
 * Every Codex rule below is source-checked against openai/codex
 * 3f65e9f13165d85d1b1fbe20ce06c55758f927b9, never executed; paths are relative to its
 * repository root. Real Codex runs are phase 3a (k22).
 */
import type { HookCodec } from "./codec.js";
import { createInvocation, type HookInvocation } from "./context.js";
import type { ContextPlacement, HookEffect } from "./effects.js";
import { AgentRuntimeError } from "./errors.js";

type CodexEvent = "SessionStart" | "SubagentStart";

interface EventRule {
  /** The keys Codex writes besides `hook_event_name`; all strings, `transcript_path` may be null. */
  readonly keys: readonly string[];
  /** The one placement Codex delivers `additionalContext` to for this event. */
  readonly placement: ContextPlacement;
}

const EVENTS: Readonly<Record<CodexEvent, EventRule>> = {
  // SessionStartCommandInput, codex-rs/hooks/src/schema.rs:497-511. The context becomes a
  // developer message before the turn's first model request
  // (codex-rs/core/src/hook_runtime.rs:908-924, codex-rs/core/src/session/turn.rs:387).
  SessionStart: {
    keys: ["session_id", "transcript_path", "cwd", "model", "permission_mode", "source"],
    placement: "session-start-input",
  },
  // SubagentStartCommandInput, schema.rs:547-563. The context lands in the subagent's
  // thread only (codex-rs/hooks/src/events/session_start.rs:264-272,
  // codex-rs/core/tests/suite/subagent_notifications.rs:678-704).
  SubagentStart: {
    keys: ["session_id", "turn_id", "transcript_path", "cwd", "model", "permission_mode", "agent_id", "agent_type"],
    placement: "subagent-input",
  },
};

const HOST = { kind: "codex", surface: "command-hook" } as const;

// Unpaired UTF-16 surrogates: with the `u` flag a valid pair is one code point, not `Cs`.
const LONE_SURROGATE = /\p{Cs}/u;

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

/**
 * Decode:
 * - `hook_event_name` missing or not a string: `HOOK_INPUT_INVALID`. A string other than
 *   `SessionStart` or `SubagentStart`: `HOOK_EVENT_UNSUPPORTED`; its other keys are not
 *   checked.
 * - Every other key is optional; the decoder does not require what this Codex commit always
 *   writes (schema.rs:497-511, :547-563 have no `skip_serializing_if`), since the release a
 *   host runs may differ. A key of the event's struct that is present must be a string
 *   (`transcript_path` also `null`, Codex's `NullableString`, schema.rs:43-55, meaning no
 *   local rollout, codex-rs/core/src/session/mod.rs:6354-6366); anything else is
 *   `HOOK_INPUT_INVALID`. Enum strings (`source`, `permission_mode`) are not checked
 *   against a list. Unknown keys stay in `native.input`, unchecked.
 * - `session_id` becomes `hostSessionId`, `cwd` becomes `hostWorkingDirectory`, and for
 *   `SubagentStart` `turn_id` becomes `hostTurnId`. The handoff's `hostParentSessionId`
 *   is not in the MVP envelope, and Codex gives nothing to fill it: `session_id` is the
 *   identity shared by the root thread and all its descendants
 *   (codex-rs/core/src/session/session.rs:677-680), not the parent thread, which differs
 *   once `agents.max_depth` exceeds its default 1 (codex-rs/core/src/config/mod.rs:294,
 *   :4330-4334); the parent's thread id (`parent_thread_id`,
 *   codex-rs/protocol/src/protocol.rs:3327-3328) is not in the hook input.
 *
 * Encode:
 * - `no-decision`: `""` (empty stdout and exit 0 add nothing, session_start.rs:243-246).
 * - `add-context` at the event's one placement:
 *   `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":<text>}}` and
 *   one LF. Always JSON: plain stdout is trimmed and stdout that starts with `{` or `[`
 *   must parse (session_start.rs:288-313); `additionalContext` is used as is (:264-272).
 *   No other key: the output wires deny unknown fields (schema.rs:385-425), and an output
 *   that fails to parse fails the hook.
 * - `HOOK_EFFECT_UNSUPPORTED` (stage `encode`) for the other placement, for text with an
 *   unpaired surrogate (JSON.stringify writes it as a `\u` escape that serde_json rejects
 *   for a string: read.rs:900-960 in serde_json 1.0.150, Codex locks 1.0.149), for any
 *   other effect kind and for an invocation of another event.
 */
export const codex: HookCodec = {
  decode(input, { processCwd }): HookInvocation {
    const event = input.hook_event_name;
    if (typeof event !== "string") {
      throw inputInvalid(`Codex input: hook_event_name is ${typeName(event)}, expected a string`);
    }
    if (!isCodexEvent(event)) {
      throw new AgentRuntimeError(
        "HOOK_EVENT_UNSUPPORTED",
        "decode",
        `Codex event ${JSON.stringify(event)} is not handled (SessionStart, SubagentStart)`,
      );
    }
    for (const key of EVENTS[event].keys) {
      const value = input[key];
      if (value === undefined || typeof value === "string") continue;
      if (value === null && key === "transcript_path") continue;
      const expected = key === "transcript_path" ? "a string or null" : "a string";
      throw inputInvalid(`Codex ${event} input: ${key} is ${typeName(value)}, expected ${expected}`);
    }
    return createInvocation({
      host: HOST,
      nativeEvent: event,
      processCwd,
      hostWorkingDirectory: stringField(input, "cwd"),
      hostSessionId: stringField(input, "session_id"),
      hostTurnId: event === "SubagentStart" ? stringField(input, "turn_id") : undefined,
      nativeInput: input,
    });
  },

  encode(effect: HookEffect, invocation: HookInvocation): string {
    const event = invocation.event.nativeName;
    if (!isCodexEvent(event)) {
      throw unsupported(`the Codex codec does not encode for event ${JSON.stringify(event)}`);
    }
    switch (effect.kind) {
      case "no-decision":
        return "";
      case "add-context": {
        const placement = EVENTS[event].placement;
        if (effect.placement !== placement) {
          throw unsupported(
            `Codex ${event} cannot deliver add-context at placement ${JSON.stringify(effect.placement)}, only ${placement}`,
          );
        }
        if (LONE_SURROGATE.test(effect.text)) {
          throw unsupported(`Codex ${event} cannot deliver add-context text with an unpaired UTF-16 surrogate`);
        }
        const output = { hookSpecificOutput: { hookEventName: event, additionalContext: effect.text } };
        return `${JSON.stringify(output)}\n`;
      }
      default: {
        const kind: unknown = (effect as { kind?: unknown }).kind;
        throw unsupported(`Codex ${event} cannot deliver effect ${JSON.stringify(kind)}`);
      }
    }
  },
};
