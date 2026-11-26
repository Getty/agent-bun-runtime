import { AgentRuntimeError } from "./errors.js";

/**
 * Where added context reaches the model (handoff 6.2, cut to the MVP): the input of a new
 * session, or the input of a subagent that is starting. A codec delivers a placement only
 * for the events that support it.
 */
export type ContextPlacement = "session-start-input" | "subagent-input";

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

/** What a handler asks the host to do for one invocation. */
export type HookEffect = NoDecisionEffect | AddContextEffect;

const PLACEMENTS: readonly string[] = ["session-start-input", "subagent-input"] satisfies ContextPlacement[];
const FIELDS: Readonly<Record<HookEffect["kind"], readonly string[]>> = {
  "no-decision": ["kind"],
  "add-context": ["kind", "text", "audience", "placement"],
};

function invalid(message: string): AgentRuntimeError {
  return new AgentRuntimeError("HOOK_EFFECT_INVALID", "effect", message);
}

function unsupported(message: string): AgentRuntimeError {
  return new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "effect", message);
}

/**
 * Checks what a handler returned against the MVP vocabulary and returns it as a
 * {@link HookEffect}. Missing values, wrong types and unknown fields are
 * `HOOK_EFFECT_INVALID`; a kind, audience or placement the vocabulary lacks is
 * `HOOK_EFFECT_UNSUPPORTED` (both stage `effect`). Whether the codec can deliver a valid
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
  return effect as unknown as HookEffect;
}
