import type { HookCodec } from "./codec.js";
import type { Env, HookContext } from "./context.js";
import { validateEffect, type HookEffect } from "./effects.js";
import { AgentRuntimeError, type ErrorCode, type ErrorStage } from "./errors.js";
import { readJsonObject } from "./input.js";
import { writeOutput, writeStdout, type OutputWriter } from "./output.js";

/** The plugin's logic for one invocation. */
export type HookHandler = (context: HookContext) => HookEffect | Promise<HookEffect>;

export interface MainOptions {
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
}

const encoder = new TextEncoder();

/**
 * Runs one hook invocation and returns the exit code; it never calls `process.exit`.
 * Reads one JSON object from stdin, decodes it, runs the handler, validates the effect,
 * encodes it and writes stdout once. Returns 0 when the effect was encoded and written;
 * 1 for every failure, after exactly one stderr line `agent-bun-runtime: <CODE>: <message>`
 * and with nothing on stdout. Never 2: some hosts read 2 as a block.
 */
export async function main(options: MainOptions): Promise<number> {
  const writeError = options.stderr ?? writeStderr;
  let output: Uint8Array;
  try {
    output = await respond(options);
  } catch (error) {
    await report(writeError, error);
    return 1;
  }
  try {
    await writeOutput(output, options.stdout ?? writeStdout);
  } catch (cause) {
    await report(
      writeError,
      new AgentRuntimeError("OUTPUT_FAILED", "output", `stdout could not be written: ${describe(cause)}`, { cause }),
    );
    return 1;
  }
  return 0;
}

async function respond(options: MainOptions): Promise<Uint8Array> {
  const input = await step("input", () =>
    readJsonObject(
      options.stdin ?? Bun.stdin.stream(),
      options.maxInputBytes === undefined ? {} : { maxBytes: options.maxInputBytes },
    ),
  );
  const invocation = await step("decode", () => options.codec.decode(input, { processCwd: options.cwd ?? process.cwd() }));
  const context: HookContext = Object.freeze({ invocation, env: options.env ?? process.env });
  const effect = validateEffect(await step("handler", () => options.handler(context)));
  const text = await step("encode", () => {
    const encoded = options.codec.encode(effect, invocation);
    if (typeof encoded !== "string") throw new Error("the codec returned no string");
    if (encoded === "" && effect.kind !== "no-decision") {
      throw new Error(`the codec returned no output for ${effect.kind}`);
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

function describe(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  return String(value);
}
