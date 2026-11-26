import { createInvocation, type HookInvocation, type HostKind } from "./context.js";
import type { HookEffect } from "./effects.js";

/** Process facts `main()` hands to {@link CodecImplementation.decode}. Internal. */
export interface DecodeInputs {
  readonly processCwd: string;
}

/**
 * What a codec does, inside this package. A codec is pure: no I/O, no environment, no
 * globals. Signal failures with an `AgentRuntimeError`; any other throw becomes
 * `INTERNAL_ERROR`. Not part of the public API: its shape may change in any release.
 */
export interface CodecImplementation {
  /**
   * Turns the host object read from stdin into the envelope, built with
   * `createInvocation` (`src/context.ts`). Throws `HOOK_INPUT_INVALID` (stage `decode`)
   * for a malformed host object. An event the codec has no rules for is decoded
   * generically ({@link decodeGenericEvent}), not rejected.
   */
  decode(input: Readonly<Record<string, unknown>>, inputs: DecodeInputs): HookInvocation;

  /**
   * Turns the validated effects (`validateEffects`: a frozen, non-empty list, at most one
   * of each kind, `no-decision` only alone) into the exact stdout text for this
   * invocation, one output for the whole list; `""` writes nothing and is accepted only
   * for `[no-decision]`. Throws `HOOK_EFFECT_UNSUPPORTED` (stage `encode`) for an effect,
   * placement or combination it cannot deliver for this event, never converting it into
   * another effect.
   */
  encode(effects: readonly HookEffect[], invocation: HookInvocation): string;
}

let create: (host: HostKind, implementation: CodecImplementation) => HookCodec;
let implementationOf: (codec: HookCodec) => CodecImplementation | undefined;

/**
 * A host codec of this package, to pass to `main()`. Plugins pick one
 * (`@getty/agent-bun-runtime/codex`) and cannot implement one: the `#private` field makes
 * the type nominal, so no object literal or other class satisfies it, and its
 * implementation is not part of the public API.
 */
export class HookCodec {
  /** The host this codec speaks for. */
  readonly host: HostKind;
  readonly #implementation: CodecImplementation;

  private constructor(host: HostKind, implementation: CodecImplementation) {
    this.host = host;
    this.#implementation = implementation;
    Object.freeze(this);
  }

  static {
    create = (host, implementation) => new HookCodec(host, implementation);
    implementationOf = (codec) => (#implementation in codec ? codec.#implementation : undefined);
  }
}

/** Makes a codec from an implementation. Internal: codecs live inside this package. */
export function defineCodec(host: HostKind, implementation: CodecImplementation): HookCodec {
  return create(host, Object.freeze({ decode: implementation.decode, encode: implementation.encode }));
}

/** The implementation behind `codec`. Throws TypeError for anything not made by {@link defineCodec}. */
export function codecImplementation(codec: unknown): CodecImplementation {
  const implementation =
    typeof codec === "object" && codec !== null ? implementationOf(codec as HookCodec) : undefined;
  if (implementation === undefined) {
    throw new TypeError("the codec is not one of this package's codecs");
  }
  return implementation;
}

/**
 * Decodes an event a codec has no rules for: `session_id` becomes `hostSessionId` and
 * `cwd` becomes `hostWorkingDirectory` when they are strings (anything else is left out,
 * not rejected); every host key stays in `native.input`. The caller has checked that
 * `hook_event_name` is the string `event`. For such an event only `no-decision` encodes.
 */
export function decodeGenericEvent(
  host: HookInvocation["host"],
  event: string,
  input: Readonly<Record<string, unknown>>,
  { processCwd }: DecodeInputs,
): HookInvocation {
  return createInvocation({
    host,
    nativeEvent: event,
    processCwd,
    hostWorkingDirectory: typeof input.cwd === "string" ? input.cwd : undefined,
    hostSessionId: typeof input.session_id === "string" ? input.session_id : undefined,
    nativeInput: input,
  });
}

