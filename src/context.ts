/** The host a codec speaks for. May gain members in a minor release. */
export type HostKind = "codex" | "claude-code";

/** How the host runs the entry: a command hook. May gain members in a minor release. */
export type HostSurface = "command-hook";

/**
 * One hook invocation, normalized (handoff 6.1, cut to what the 0.1.0 events need).
 * Optional fields are absent when the host did not supply them; they are never filled
 * with a default. Event-specific host fields stay in `native.input`. `envelopeVersion` is
 * the version of this shape, not the integration contract's `gettyBun.contractVersion`.
 */
export interface HookInvocation {
  readonly envelopeVersion: 1;
  readonly host: {
    readonly kind: HostKind;
    readonly surface: HostSurface;
  };
  readonly event: {
    /** The host's own event name, unchanged (for Codex e.g. `SubagentStart`). */
    readonly nativeName: string;
  };
  readonly location: {
    /** The working directory of this process, as given to `main()`. */
    readonly processCwd: string;
    /** The working directory the host reported, if it reported one. */
    readonly hostWorkingDirectory?: string;
  };
  readonly identity: {
    readonly hostSessionId?: string;
    readonly hostTurnId?: string;
  };
  /**
   * The tool a `PreToolUse` or `PostToolUse` invocation is about, as the codec decoded it;
   * absent otherwise.
   */
  readonly tool?: {
    readonly name: string;
    readonly input: unknown;
  };
  readonly native: {
    /** The host object read from stdin, frozen. */
    readonly input: Readonly<Record<string, unknown>>;
  };
}

/** Environment variables as given to `main()`. */
export type Env = Readonly<Record<string, string | undefined>>;

/** What a handler receives: the invocation and the explicit process inputs. */
export interface HookContext {
  readonly invocation: HookInvocation;
  readonly env: Env;
}

/** The facts a codec hands to {@link createInvocation}; `undefined` means missing. */
export interface InvocationParts {
  readonly host: HookInvocation["host"];
  readonly nativeEvent: string;
  readonly processCwd: string;
  readonly hostWorkingDirectory?: string | undefined;
  readonly hostSessionId?: string | undefined;
  readonly hostTurnId?: string | undefined;
  readonly tool?: { readonly name: string; readonly input: unknown } | undefined;
  readonly nativeInput: Readonly<Record<string, unknown>>;
}

/**
 * Builds the frozen envelope from explicit parts. Parts that are `undefined` are left out,
 * so `"hostTurnId" in invocation.identity` is false when the host sent none. The native
 * input and the tool input are deep-frozen in place, not copied.
 */
export function createInvocation(parts: InvocationParts): HookInvocation {
  const location: { processCwd: string; hostWorkingDirectory?: string } = { processCwd: parts.processCwd };
  if (parts.hostWorkingDirectory !== undefined) location.hostWorkingDirectory = parts.hostWorkingDirectory;
  const identity: { hostSessionId?: string; hostTurnId?: string } = {};
  if (parts.hostSessionId !== undefined) identity.hostSessionId = parts.hostSessionId;
  if (parts.hostTurnId !== undefined) identity.hostTurnId = parts.hostTurnId;
  const invocation: { -readonly [K in keyof HookInvocation]: HookInvocation[K] } = {
    envelopeVersion: 1,
    host: Object.freeze({ kind: parts.host.kind, surface: parts.host.surface }),
    event: Object.freeze({ nativeName: parts.nativeEvent }),
    location: Object.freeze(location),
    identity: Object.freeze(identity),
    native: Object.freeze({ input: deepFreeze(parts.nativeInput) }),
  };
  if (parts.tool !== undefined) {
    invocation.tool = Object.freeze({ name: parts.tool.name, input: deepFreeze(parts.tool.input) });
  }
  return Object.freeze(invocation);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
