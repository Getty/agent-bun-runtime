import { AgentRuntimeError } from "./errors.js";

/**
 * Where added context reaches the model (handoff 6.2, cut to 0.1.0): the input of a new
 * session (`SessionStart`), of a subagent that is starting (`SubagentStart`), of the
 * prompt the user submitted (`UserPromptSubmit`), or the result of a tool that ran
 * (`PostToolUse`). A codec delivers a placement only for the events that support it.
 * May gain members in a minor release.
 */
export type ContextPlacement = "session-start-input" | "subagent-input" | "prompt-input" | "tool-result";

/** Leave the host's normal processing unchanged. Grants nothing. */
export interface NoDecisionEffect {
  readonly kind: "no-decision";
}

/** Add `text` to the model's context at `placement`. */
export interface AddContextEffect {
  readonly kind: "add-context";
  readonly text: string;
  readonly audience: "model";
  readonly placement: ContextPlacement;
}

/**
 * Allow, deny or ask about the tool call of a `PreToolUse` invocation. `reason` is
 * required for `deny`; when present it is a non-empty string.
 */
export interface ToolPermissionEffect {
  readonly kind: "tool-permission";
  readonly decision: "allow" | "deny" | "ask";
  readonly reason?: string;
}

/**
 * Replace the input of the tool call of a `PreToolUse` invocation with `input`, a plain
 * JSON object. Grants nothing: the host's own permission check still applies.
 */
export interface ToolInputEffect {
  readonly kind: "tool-input";
  readonly input: Readonly<Record<string, unknown>>;
}

/** Show `text`, a non-empty string, to the user, not the model. */
export interface NotifyUserEffect {
  readonly kind: "notify-user";
  readonly text: string;
}

/**
 * One thing a handler asks the host to do for one invocation. A handler returns one effect
 * or a list of them ({@link validateEffects}). The kinds may gain members in a minor
 * release.
 */
export type HookEffect =
  | NoDecisionEffect
  | AddContextEffect
  | ToolPermissionEffect
  | ToolInputEffect
  | NotifyUserEffect;

const PLACEMENTS: readonly string[] = [
  "session-start-input",
  "subagent-input",
  "prompt-input",
  "tool-result",
] satisfies ContextPlacement[];
const DECISIONS: readonly string[] = ["allow", "deny", "ask"] satisfies ToolPermissionEffect["decision"][];
const FIELDS: Readonly<Record<HookEffect["kind"], readonly string[]>> = {
  "no-decision": ["kind"],
  "add-context": ["kind", "text", "audience", "placement"],
  "tool-permission": ["kind", "decision", "reason"],
  "tool-input": ["kind", "input"],
  "notify-user": ["kind", "text"],
};

function invalid(message: string): AgentRuntimeError {
  return new AgentRuntimeError("HOOK_EFFECT_INVALID", "effect", message);
}

function unsupported(message: string): AgentRuntimeError {
  return new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "effect", message);
}

/**
 * Checks what a handler returned against the vocabulary and returns it as a
 * {@link HookEffect}. Missing values, wrong types and unknown fields are
 * `HOOK_EFFECT_INVALID`, and so is a `tool-input` whose input is not a plain JSON object
 * (an array, `null`, a class instance, or anything inside that JSON cannot carry
 * unchanged: `undefined`, a function, a non-finite number, a cycle); a kind, audience,
 * placement or decision the vocabulary lacks is `HOOK_EFFECT_UNSUPPORTED` (both stage
 * `effect`). Whether the codec can deliver a valid
 * effect for the event is the codec's check, in `encode`.
 */
export function validateEffect(value: unknown): HookEffect {
  if (value === undefined) throw invalid("the handler returned no effect");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("the effect is not an object");
  }
  const effect = value as Record<string, unknown>;
  const kind = effect.kind;
  if (typeof kind !== "string") throw invalid("the effect has no string kind");
  if (!Object.hasOwn(FIELDS, kind)) throw unsupported(`effect kind ${JSON.stringify(kind)} is not supported`);
  const allowed = FIELDS[kind as HookEffect["kind"]];
  for (const key of Object.keys(effect)) {
    if (!allowed.includes(key)) throw invalid(`effect ${kind} has an unknown field ${JSON.stringify(key)}`);
  }
  if (kind === "add-context") {
    if (typeof effect.text !== "string" || effect.text === "") {
      throw invalid("add-context needs a non-empty string text");
    }
    if (typeof effect.audience !== "string") throw invalid("add-context needs an audience");
    if (effect.audience !== "model") {
      throw unsupported(`add-context audience ${JSON.stringify(effect.audience)} is not supported`);
    }
    if (typeof effect.placement !== "string") throw invalid("add-context needs a placement");
    if (!PLACEMENTS.includes(effect.placement)) {
      throw unsupported(`add-context placement ${JSON.stringify(effect.placement)} is not supported`);
    }
  }
  if (kind === "notify-user" && (typeof effect.text !== "string" || effect.text === "")) {
    throw invalid("notify-user needs a non-empty string text");
  }
  if (kind === "tool-permission") {
    if (typeof effect.decision !== "string") throw invalid("tool-permission needs a decision");
    if (!DECISIONS.includes(effect.decision)) {
      throw unsupported(`tool-permission decision ${JSON.stringify(effect.decision)} is not supported`);
    }
    if (effect.reason === undefined) {
      if (effect.decision === "deny") throw invalid("tool-permission deny needs a non-empty string reason");
    } else if (typeof effect.reason !== "string" || effect.reason === "") {
      throw invalid("tool-permission reason must be a non-empty string");
    }
  }
  if (kind === "tool-input" && !(isPlainObject(effect.input) && isJson(effect.input, new Set()))) {
    throw invalid("tool-input needs an input that is a plain JSON object");
  }
  return effect as unknown as HookEffect;
}

/**
 * Checks what a handler returned, one effect or a list, and returns it as a frozen,
 * non-empty list in the handler's order; a single effect becomes a list of one. Each
 * element is checked by {@link validateEffect}. A list is `HOOK_EFFECT_INVALID` (stage
 * `effect`) when it is empty, has two effects of the same kind, or has `no-decision`
 * beside another effect. `tool-permission` and `tool-input` may come together; whether
 * the host can deliver a combination is the codec's check, in `encode`.
 */
export function validateEffects(value: unknown): readonly HookEffect[] {
  if (!Array.isArray(value)) return Object.freeze([validateEffect(value)]);
  if (value.length === 0) throw invalid("the handler returned an empty list of effects");
  const effects = Array.from(value, (element) => validateEffect(element));
  const kinds = new Set<string>();
  for (const { kind } of effects) {
    if (kinds.has(kind)) throw invalid(`the list of effects has more than one ${kind}`);
    kinds.add(kind);
  }
  if (effects.length > 1 && kinds.has("no-decision")) {
    throw invalid("no-decision cannot be combined with other effects");
  }
  return Object.freeze(effects);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// True when JSON.stringify carries `value` unchanged; `open` holds the containers being
// visited, to reject cycles.
function isJson(value: unknown, open: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!(Array.isArray(value) || isPlainObject(value)) || open.has(value)) return false;
  open.add(value);
  const ok = Object.values(value).every((child) => isJson(child, open));
  open.delete(value);
  return ok;
}
