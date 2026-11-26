/**
 * Error codes the SDK uses (handoff 7.5, cut to 0.1.0). May gain members in a minor release.
 *
 * - `HOOK_INPUT_INVALID`: stdin is empty, incomplete, too large, not UTF-8, not JSON or not
 *   an object, or a codec found the host object malformed.
 * - `HOOK_EFFECT_INVALID`: the handler returned no effect, a malformed one, or a list
 *   that is empty, has two effects of one kind or `no-decision` beside another effect.
 * - `HOOK_EFFECT_UNSUPPORTED`: the effect, its audience or its placement is outside the
 *   vocabulary, or the codec cannot deliver it, or the combination, for this event (for
 *   an event the codec has no rules for, every effect but `no-decision`).
 * - `HANDLER_FAILED`: the handler threw something other than an {@link AgentRuntimeError}.
 * - `OUTPUT_FAILED`: writing the hook output to stdout failed.
 * - `INTERNAL_ERROR`: anything else that was not a typed error (a bug in the SDK or a codec).
 */
export type ErrorCode =
  | "HOOK_INPUT_INVALID"
  | "HOOK_EFFECT_INVALID"
  | "HOOK_EFFECT_UNSUPPORTED"
  | "HANDLER_FAILED"
  | "OUTPUT_FAILED"
  | "INTERNAL_ERROR";

/** Where in `main()` an error arose (handoff 6.4, the single response owner's steps). */
export type ErrorStage = "input" | "decode" | "handler" | "effect" | "encode" | "output";

/**
 * A typed SDK failure. `main()` turns every failure into one stderr line and exit 1, or
 * exit 2 with `onFailure: "closed"`.
 */
export class AgentRuntimeError extends Error {
  override readonly name = "AgentRuntimeError";
  readonly code: ErrorCode;
  readonly stage: ErrorStage;

  constructor(code: ErrorCode, stage: ErrorStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.stage = stage;
  }
}
