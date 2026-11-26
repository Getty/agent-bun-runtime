import type { HookInvocation } from "./context.js";
import type { HookEffect } from "./effects.js";

/** Process facts `main()` hands to {@link HookCodec.decode}. */
export interface DecodeInputs {
  readonly processCwd: string;
}

/**
 * Translates between one host's hook protocol and the host-neutral core. A codec is pure:
 * no I/O, no environment, no globals. Signal failures with an `AgentRuntimeError`; any
 * other throw becomes `INTERNAL_ERROR`.
 */
export interface HookCodec {
  /**
   * Turns the host object read from stdin into the envelope. In the MVP the codecs live
   * inside this package and build it with `createInvocation` (`src/context.ts`), which
   * the package does not export. Throws `HOOK_INPUT_INVALID` for a malformed host object
   * and `HOOK_EVENT_UNSUPPORTED` for an event the codec does not handle (stage `decode`).
   */
  decode(input: Readonly<Record<string, unknown>>, inputs: DecodeInputs): HookInvocation;

  /**
   * Turns a validated effect into the exact stdout text for this invocation; `""` writes
   * nothing and is accepted only for `no-decision`. Throws `HOOK_EFFECT_UNSUPPORTED`
   * (stage `encode`) for an effect or placement it cannot deliver for this event, never
   * converting it into another effect.
   */
  encode(effect: HookEffect, invocation: HookInvocation): string;
}
