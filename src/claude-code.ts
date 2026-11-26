/**
 * The Claude Code codec: command hooks `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
 * `PostToolUse` and `CwdChanged`; any other event is decoded generically.
 *
 * Evidence, never a real Claude Code run from this repository (phase 2b, k36):
 * - **doc-checked** against the hooks reference https://code.claude.com/docs/en/hooks
 *   (markdown at https://code.claude.com/docs/en/hooks.md), fetched 2026-11-26T20:08:24Z;
 *   `hooks.md:N` is a line of that markdown.
 * - **source-checked** against `@anthropic-ai/claude-code-linux-x64@2.1.332` (npm latest on
 *   2026-11-26, tarball integrity checked, never executed): `cc@N` is a byte offset into
 *   the package's `claude` binary, where the bundled, minified JavaScript is read.
 *   Minified names are quoted as they appear there.
 * - **executed** only where a row says so: loadguard's recorded payloads (loadguard k7,
 *   Claude Code 2.1.283), which the fixtures in `test/fixtures/claude-code/` reuse.
 */
import { decodeGenericEvent, defineCodec, type HookCodec } from "./codec.js";
import { createInvocation, type HookInvocation } from "./context.js";
import type { ContextPlacement, HookEffect, ToolInputEffect, ToolPermissionEffect } from "./effects.js";
import { AgentRuntimeError } from "./errors.js";

type ClaudeCodeEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "CwdChanged";

interface EventRule {
  /** The one placement Claude Code delivers `additionalContext` to for this event, if any. */
  readonly placement?: ContextPlacement;
  /** True when `tool_name` and `tool_input` fill the envelope's `tool`. */
  readonly tool?: true;
}

// For the five events, the decoder checks only the keys it lifts into the envelope
// (ADR 0009): `session_id` and `cwd`, which every event carries (the SDK's hook input
// base schema, cc@331043635: strings; filled by the builder `Sh`, cc@345560895, which
// writes an absent value as `undefined`, left out by JSON.stringify), and, on the two
// tool events, `tool_name`.
// None of them is nullable in the 2.1.332 schemas, so `null` is invalid, not absent.
// The other keys of the schemas cited below are named for the record only and stay
// unchecked in `native.input`: a Claude Code release that changes the type of a key no
// consumer reads must not fail every hook.
const LIFTED_COMMON = ["session_id", "cwd"] as const;

const EVENTS: Readonly<Record<ClaudeCodeEvent, EventRule>> = {
  // Schema cc@331049055 (source enum, agent_type, model, session_title, and on
  // resume/fork the four numbers and the boolean, hooks.md:1311-1349); built by `wDi`
  // (cc@345541894). additionalContext goes "at the start of the conversation, before the
  // first prompt" (hooks.md:1184, :1356); output schema cc@338277170.
  SessionStart: {
    placement: "session-start-input",
  },
  // Schema cc@331047365 (prompt; source an optional enum); built by `NAt`/`xcn`
  // (cc@345553032) with session_title. additionalContext goes "alongside the submitted
  // prompt" (hooks.md:1185, :1584); output schema cc@338276709.
  UserPromptSubmit: {
    placement: "prompt-input",
  },
  // Schema cc@331045181 (tool_name, tool_input, tool_use_id, mcp_server an optional
  // object {name, source}, cc@331042534); built at cc@344148346. tool_input is the
  // schema's any-value type and depends on the tool (hooks.md:1882-1909): not checked.
  // Claude Code also takes additionalContext here (hooks.md:2094), but the vocabulary's
  // `tool-result` placement is PostToolUse's (ADR 0009), so this codec does not offer it.
  PreToolUse: {
    tool: true,
  },
  // Schema cc@331046105 (as PreToolUse plus tool_response, any value, and duration_ms, a
  // number); built at cc@344149310. tool_response is the error text as a string for a
  // failed call (hooks.md:2375). additionalContext goes "alongside the tool result"
  // (hooks.md:1186, :2410); output schema cc@338278101.
  PostToolUse: {
    placement: "tool-result",
    tool: true,
  },
  // Schema cc@331057289 (old_cwd, new_cwd); built by `_Di` (cc@345534790) from `Sh`.
  // "No decision control" (hooks.md:1227, :3220); its output schema (cc@338281479) has
  // only watchPaths, which the vocabulary lacks. Only `no-decision` and the top-level
  // `notify-user` encode (hooks.md:3222); old_cwd and new_cwd stay in `native.input`.
  CwdChanged: {},
};

const HOST = { kind: "claude-code", surface: "command-hook" } as const;

function isClaudeCodeEvent(name: string): name is ClaudeCodeEvent {
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

/** Rejects a present `key` that is not a string; `null` included. */
function checkString(input: Readonly<Record<string, unknown>>, key: string, event: string): void {
  const value = input[key];
  if (value === undefined || typeof value === "string") return;
  throw inputInvalid(`Claude Code ${event} input: ${key} is ${typeName(value)}, expected a string`);
}

function stringField(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Decode:
 * - Claude Code writes `JSON.stringify(hookInput)` and one LF to the hook's stdin
 *   (cc@345645322 serializes with `_`, JSON.stringify at cc@328987159; written with `+"\n"`
 *   at cc@345587062); the recorded payloads end in that LF (executed, loadguard k7).
 * - Only the keys lifted into the envelope are checked (ADR 0009). `hook_event_name`
 *   missing or not a string: `HOOK_INPUT_INVALID`. For the five events, `session_id` and
 *   `cwd`, and `tool_name` on `PreToolUse` and `PostToolUse` are optional, also where the
 *   schema requires them, since the release a host runs may differ from 2.1.332; present,
 *   they must be strings, and `null` is `HOOK_INPUT_INVALID` too (no `.nullable()` on
 *   them in the schemas, cc@331043635, cc@331045181, cc@331046105). `tool_input` may be
 *   any JSON value. Every other key (`transcript_path`, `prompt_id`, `effort`, `prompt`,
 *   `model`, `mcp_server`, `duration_ms`, `old_cwd`, ...) and every key of another event
 *   stays in `native.input`, unchecked: a release that changes its type must not fail
 *   every hook.
 * - A `hook_event_name` other than the five events above is decoded generically
 *   (`decodeGenericEvent`: `session_id` and `cwd` when they are strings, left out
 *   otherwise, as in the Codex codec); none of its keys is checked.
 * - `session_id` becomes `hostSessionId`, `cwd` becomes `hostWorkingDirectory`. Claude
 *   Code has no turn id: `hostTurnId` is never set (`prompt_id`, absent until the first
 *   prompt, hooks.md:758, stays in `native.input`). For `PreToolUse` and `PostToolUse`,
 *   `tool` is `{ name: tool_name, input: tool_input }` when both keys are present, and
 *   absent otherwise; `tool_input` is used as sent (loadguard k7 recorded it holding only
 *   the keys the model passed).
 *
 * Encode: the whole list becomes one JSON object and one LF, exit 0. Top-level keys only
 * `systemMessage` and `hookSpecificOutput`; the core hands a list with at most one effect
 * of each kind and `no-decision` only alone (`validateEffects`).
 * - `no-decision`: `""` for every event. Empty stdout with exit 0 is a success that
 *   changes nothing (hooks.md:817).
 * - `notify-user` on each of the five events: top-level `systemMessage`, "Warning message
 *   shown to the user" (hooks.md:1115; universal field of the output schema `NM`,
 *   cc@338276066). The parser `rse` (cc@345564001) copies it for any event
 *   (cc@345564904); the runner `QD` (cc@345632145), which runs `SessionStart`,
 *   `UserPromptSubmit`, `PreToolUse` and `PostToolUse`, shows it as a
 *   `hook_system_message` (cc@345682277); hooks.md:1014 names it for `PreToolUse`.
 *   `CwdChanged` (runner `$3o`, cc@345534496) collects it and, in interactive sessions,
 *   shows it as a brief terminal notification that does not reach the SDK message stream
 *   (hooks.md:3222); skilletor measured on 2.1.322 that in `-p` it reached neither the
 *   model nor `stream-json`. Not for other events: "some events discard it or deliver
 *   `systemMessage` somewhere other than the transcript" (hooks.md:749, :1106), such as
 *   to Claude (`DirectoryAdded`, hooks.md:3267), which would break "not the model". An `async` hook's
 *   `systemMessage` goes to Claude on the next turn and is not shown (hooks.md:4301): the
 *   codec cannot see that setting, a plugin must not declare a `notify-user` hook async.
 * - `add-context` at the event's one placement (`SessionStart` session-start-input,
 *   `UserPromptSubmit` prompt-input, `PostToolUse` tool-result): `hookSpecificOutput`
 *   `{"hookEventName":"<event>","additionalContext":<text>}` (hooks.md:1167-1186; output
 *   schema `NM`, cc@338275692).
 * - `tool-permission` on `PreToolUse`: `permissionDecision` `allow`, `deny` or `ask` and,
 *   when the effect has one, `permissionDecisionReason` (hooks.md:2085-2098; enum `U_`
 *   cc@338275648, branch cc@338276422). The core requires a reason for `deny`. `allow`
 *   still leaves deny and ask rules in force (hooks.md:2091).
 * - `tool-input` on `PreToolUse`: `updatedInput` with the effect's object; the input
 *   replaces the whole tool input and permission rules are evaluated against it
 *   (hooks.md:2093). Alone it has no `permissionDecision`, so it rewrites and grants
 *   nothing: doc-checked (hooks.md:2093, "With no `permissionDecision`, auto mode can deny
 *   the changed call", :2120-2135), and executed on Claude Code 2.1.283 by loadguard k7
 *   (probe A: `updatedInput` alone, the rewritten command ran).
 * - `tool-permission` with `tool-input`: one `hookSpecificOutput` with both. `allow`
 *   auto-approves the rewritten call and `ask` shows it to the user (hooks.md:2093,
 *   example :2102-2114); `allow` with `updatedInput` is what `AskUserQuestion` and
 *   `ExitPlanMode` need (hooks.md:2091, :2154). `deny` with `tool-input` is
 *   `HOOK_EFFECT_UNSUPPORTED`: the docs name no meaning for it, and a denied call runs no
 *   input (`rse` stores `updatedInput` whatever the decision, cc@345565260; what follows
 *   is not checked).
 * - `notify-user` with any of the others: `systemMessage` beside the `hookSpecificOutput`
 *   (skilletor writes this pair for add-context, `src/hooks.ts:336-341`).
 * - Key order is fixed, whatever the list's order: `systemMessage`, `hookSpecificOutput`;
 *   inside it `hookEventName`, `permissionDecision`, `permissionDecisionReason`,
 *   `updatedInput`, `additionalContext`, as in hooks.md:2102-2114. Claude Code parses the
 *   object, so the order is the codec's choice, kept for byte-exact fixtures.
 * - Claude Code caps `additionalContext` and `systemMessage` at 10,000 characters each
 *   (`QDe=1e4`, cc@330696271, applied by `jEe`, cc@337801045): a longer one is saved to a
 *   file in the session directory and replaced by its path and a 2,000-character preview
 *   (hooks.md:1098-1102, :1194). The codec does not enforce or measure the cap.
 * - Unpaired UTF-16 surrogates are delivered, not rejected: JSON.stringify writes them as
 *   `\u` escapes, and Claude Code parses hook stdout (`k8`, cc@340850125, then `Lhn`,
 *   cc@340849934) with `JSON.parse` (`Z`, cc@328987414), which accepts them, and checks
 *   the strings with Zod's string type, which does not look at surrogates. What later
 *   stages (the transcript, the API request) do with such a string is not checked.
 * - `HOOK_EFFECT_UNSUPPORTED` (stage `encode`) for another placement, for `add-context`
 *   on `PreToolUse` or `CwdChanged`, for `tool-permission` or `tool-input` on any event
 *   but `PreToolUse`, for `tool-input` with a `deny`, for any other effect kind, and for
 *   an event without rules every list but `[no-decision]`. One effect the event cannot
 *   deliver rejects the whole list.
 */
export const claudeCode: HookCodec = defineCodec("claude-code", {
  decode(input, { processCwd }): HookInvocation {
    const event = input.hook_event_name;
    if (typeof event !== "string") {
      throw inputInvalid(`Claude Code input: hook_event_name is ${typeName(event)}, expected a string`);
    }
    if (!isClaudeCodeEvent(event)) return decodeGenericEvent(HOST, event, input, { processCwd });
    const rule = EVENTS[event];
    for (const key of LIFTED_COMMON) checkString(input, key, event);
    if (rule.tool === true) checkString(input, "tool_name", event);
    const toolName = stringField(input, "tool_name");
    const tool =
      rule.tool === true && toolName !== undefined && input.tool_input !== undefined
        ? { name: toolName, input: input.tool_input }
        : undefined;
    return createInvocation({
      host: HOST,
      nativeEvent: event,
      processCwd,
      hostWorkingDirectory: stringField(input, "cwd"),
      hostSessionId: stringField(input, "session_id"),
      tool,
      nativeInput: input,
    });
  },

  encode(effects: readonly HookEffect[], invocation: HookInvocation): string {
    if (effects.length === 1 && effects[0]?.kind === "no-decision") return "";
    const event = invocation.event.nativeName;
    if (!isClaudeCodeEvent(event)) {
      throw unsupported(`the Claude Code codec has no rules for event ${JSON.stringify(event)}: only no-decision`);
    }
    let systemMessage: string | undefined;
    let additionalContext: string | undefined;
    let permission: ToolPermissionEffect | undefined;
    let updatedInput: ToolInputEffect["input"] | undefined;
    for (const effect of effects) {
      switch (effect.kind) {
        case "notify-user":
          systemMessage = effect.text;
          break;
        case "add-context": {
          const placement = EVENTS[event].placement;
          if (placement === undefined) {
            throw unsupported(`Claude Code ${event} cannot deliver add-context`);
          }
          if (effect.placement !== placement) {
            throw unsupported(
              `Claude Code ${event} cannot deliver add-context at placement ${JSON.stringify(effect.placement)}, only ${placement}`,
            );
          }
          additionalContext = effect.text;
          break;
        }
        case "tool-permission":
          if (event !== "PreToolUse") throw unsupported(`Claude Code ${event} cannot deliver tool-permission`);
          permission = effect;
          break;
        case "tool-input":
          if (event !== "PreToolUse") throw unsupported(`Claude Code ${event} cannot deliver tool-input`);
          updatedInput = effect.input;
          break;
        default: {
          // `no-decision` beside another effect, or a kind this codec does not know.
          const kind: unknown = (effect as { kind?: unknown }).kind;
          throw unsupported(`Claude Code ${event} cannot deliver effect ${JSON.stringify(kind)} in this list`);
        }
      }
    }
    if (permission?.decision === "deny" && updatedInput !== undefined) {
      throw unsupported(`Claude Code ${event} cannot deliver tool-input with a tool-permission deny`);
    }
    // The fixed key order documented above; absent values are left out.
    const specific: Record<string, unknown> = {};
    if (permission !== undefined) {
      specific.permissionDecision = permission.decision;
      if (permission.reason !== undefined) specific.permissionDecisionReason = permission.reason;
    }
    if (updatedInput !== undefined) specific.updatedInput = updatedInput;
    if (additionalContext !== undefined) specific.additionalContext = additionalContext;
    const output: Record<string, unknown> = {};
    if (systemMessage !== undefined) output.systemMessage = systemMessage;
    if (Object.keys(specific).length > 0) output.hookSpecificOutput = { hookEventName: event, ...specific };
    if (Object.keys(output).length === 0) throw unsupported("the Claude Code codec received no effect to deliver");
    return `${JSON.stringify(output)}\n`;
  },
});
