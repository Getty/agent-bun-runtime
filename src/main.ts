import { codecImplementation, type HookCodec } from "./codec.js";
import type { Env, HookContext } from "./context.js";
import { validateEffects, type HookEffect } from "./effects.js";
import { AgentRuntimeError, type ErrorCode, type ErrorStage } from "./errors.js";
import { readJsonObject } from "./input.js";
import { writeOutput, writeStdout, type OutputWriter } from "./output.js";

/**
 * The plugin's logic for one invocation: one effect, or a non-empty list with at most one
 * effect of each kind, `no-decision` only alone. The codec delivers a list as one output.
 */
export type HookHandler = (
  context: HookContext,
) => HookEffect | readonly HookEffect[] | Promise<HookEffect | readonly HookEffect[]>;

/**
 * What `main()` exits with on failure: `"open"` exits 1, so the host goes on (a
 * `PreToolUse` tool runs); `"closed"` exits 2, which Codex and Claude Code read as a block
 * on `PreToolUse` and `UserPromptSubmit`. Both write the same one stderr line.
 */
export type FailurePolicy = "open" | "closed";

export interface MainOptions {
  /** One of this package's codecs, e.g. `codex` from `@getty/agent-bun-runtime/codex`. */
  readonly codec: HookCodec;
  readonly handler: HookHandler;
  /** Default: `Bun.stdin.stream()`. */
  readonly stdin?: ReadableStream<Uint8Array>;
  /** Default: the real stdout. Called at most once, never with empty bytes. */
  readonly stdout?: OutputWriter;
  /** Default: the real stderr. Called once, with one line, on failure only. */
  readonly stderr?: (text: string) => unknown;
  /** Default: `process.env`, read when `main()` is called. */
  readonly env?: Env;
  /** Default: `process.cwd()`, read when `main()` is called. */
  readonly cwd?: string;
  /** Bound for the hook object on stdin; default `DEFAULT_MAX_INPUT_BYTES` (1 MiB). */
  readonly maxInputBytes?: number;
  /** Exit code on failure; default `"open"` (exit 1). */
  readonly onFailure?: FailurePolicy;
}

const encoder = new TextEncoder();

/**
 * Runs one hook invocation and returns the exit code; it never calls `process.exit`.
 * Reads one JSON object from stdin, decodes it, runs the handler, validates the effect
 * or effects, encodes them as one output and writes stdout once. Returns 0 when the
 * output was encoded and written.
 * Every failure writes exactly one stderr line `agent-bun-runtime: <CODE>: <message>` and
 * returns 1, or 2 with `onFailure: "closed"`; 2 only then, since hosts read 2 as a block.
 * Nothing reaches stdout unless the failure is in writing it (`OUTPUT_FAILED`). An
 * `onFailure` other than `"open"` or `"closed"` is a programming error: `INTERNAL_ERROR`
 * and exit 1, before stdin is read, since the intended policy is unknown.
 */
export async function main(options: MainOptions): Promise<number> {
  const writeError = options.stderr ?? writeStderr;
  const policy: unknown = options.onFailure ?? "open";
  if (policy !== "open" && policy !== "closed") {
    await report(
      writeError,
      new AgentRuntimeError(
        "INTERNAL_ERROR",
        "input",
        `main(): onFailure must be "open" or "closed", got ${describeValue(policy)}`,
      ),
    );
    return 1;
  }
  const failed = policy === "closed" ? 2 : 1;
  let output: Uint8Array;
  try {
    output = await respond(options);
  } catch (error) {
    await report(writeError, error);
    return failed;
  }
  try {
    await writeOutput(output, options.stdout ?? writeStdout);
  } catch (cause) {
    await report(
      writeError,
      new AgentRuntimeError("OUTPUT_FAILED", "output", `stdout could not be written: ${describe(cause)}`, { cause }),
    );
    return failed;
  }
  return 0;
}

async function respond(options: MainOptions): Promise<Uint8Array> {
  const codec = codecImplementation(options.codec);
  const input = await step("input", () =>
    readJsonObject(
      options.stdin ?? Bun.stdin.stream(),
      options.maxInputBytes === undefined ? {} : { maxBytes: options.maxInputBytes },
    ),
  );
  const invocation = await step("decode", () => codec.decode(input, { processCwd: options.cwd ?? process.cwd() }));
  const context: HookContext = Object.freeze({ invocation, env: options.env ?? process.env });
  const effects = validateEffects(await step("handler", () => options.handler(context)));
  const text = await step("encode", () => {
    const encoded = codec.encode(effects, invocation);
    if (typeof encoded !== "string") throw new Error("the codec returned no string");
    if (encoded === "" && effects[0]?.kind !== "no-decision") {
      throw new Error(`the codec returned no output for ${effects.map(({ kind }) => kind).join(", ")}`);
    }
    return encoded;
  });
  return encoder.encode(text);
}

// Typed errors pass through; anything else becomes HANDLER_FAILED in the handler stage and
// INTERNAL_ERROR elsewhere.
async function step<T>(stage: ErrorStage, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    const code: ErrorCode = stage === "handler" ? "HANDLER_FAILED" : "INTERNAL_ERROR";
    const message = stage === "handler" ? describe(error) : `${stage} failed: ${describe(error)}`;
    throw new AgentRuntimeError(code, stage, message, { cause: error });
  }
}

async function report(writeError: (text: string) => unknown, error: unknown): Promise<void> {
  const typed =
    error instanceof AgentRuntimeError
      ? error
      : new AgentRuntimeError("INTERNAL_ERROR", "input", describe(error), { cause: error });
  const line = `agent-bun-runtime: ${typed.code}: ${typed.message.replace(/[\r\n]+/g, " ")}\n`;
  try {
    await writeError(line);
  } catch {
    // Nowhere left to report; the exit code still says it failed.
  }
}

async function writeStderr(text: string): Promise<void> {
  await Bun.write(Bun.stderr, text);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : String(value);
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  return String(value);
}
