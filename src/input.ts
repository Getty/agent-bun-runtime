import { AgentRuntimeError } from "./errors.js";

/** Default bound for the hook object on stdin, a leading BOM and whitespace included: 1 MiB. */
export const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;

export interface ReadJsonObjectOptions {
  /** Upper bound in bytes for everything read up to the end of the object. */
  readonly maxBytes?: number;
}

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const BOM = [0xef, 0xbb, 0xbf] as const;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function inputError(message: string, cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError("HOOK_INPUT_INVALID", "input", message, cause === undefined ? undefined : { cause });
}

/**
 * Reads one complete JSON object from `stream` and stops: it does not wait for the end of
 * input, because a host may keep stdin open after the hook object. One leading UTF-8 byte
 * order mark is skipped, then whitespace (RFC 8259 section 8.1 lets a parser ignore the
 * BOM; Windows PowerShell 5.1 can write one into a child's redirected stdin under code page
 * 65001); a second BOM, or one after whitespace, is an error. The scan finds the end of
 * the object (string- and escape-aware); JSON.parse then validates it. Bytes that arrived
 * in the same chunk after the object are dropped; nothing further is read. The stream is
 * cancelled before this returns or throws, so a reader left on it cannot keep the process
 * alive.
 *
 * Throws {@link AgentRuntimeError} `HOOK_INPUT_INVALID` (stage `input`) for empty,
 * incomplete, oversized, non-UTF-8, malformed or non-object input, and when the stream
 * fails. Throws RangeError for a `maxBytes` that is not a positive integer.
 */
export async function readJsonObject(
  stream: ReadableStream<Uint8Array>,
  options: ReadJsonObjectOptions = {},
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes must be a positive integer, got ${maxBytes}`);
  }
  const reader = stream.getReader();
  try {
    return parse(await scan(reader, maxBytes));
  } finally {
    // An uncancelled reader keeps Bun 1.4.5 running while stdin stays open (executed,
    // linux-x64-baseline); cancelling ends the read.
    await reader.cancel().catch(() => {});
  }
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
}

async function scan(reader: ChunkReader, maxBytes: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let consumed = 0; // bytes taken from the stream so far, leading BOM and whitespace included
  let bomBytes = 0; // bytes of a leading BOM matched so far, at offsets 0..2 only
  let started = false;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (;;) {
    let result: Awaited<ReturnType<ChunkReader["read"]>>;
    try {
      result = await reader.read();
    } catch (cause) {
      throw inputError(`stdin could not be read: ${describe(cause)}`, cause);
    }
    if (result.done || result.value === undefined) {
      throw inputError(
        started
          ? "stdin ended inside the JSON object (incomplete input)"
          : bomBytes > 0 && bomBytes < BOM.length
            ? "stdin is not a JSON object"
            : "stdin is empty: expected one JSON object",
      );
    }
    const chunk = result.value;
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (consumed + i >= maxBytes) {
        throw inputError(`stdin holds more than ${maxBytes} bytes before the end of the JSON object`);
      }
      const byte = chunk[i] as number;
      if (!started) {
        const offset = consumed + i;
        if (offset === bomBytes && offset < BOM.length && byte === BOM[offset]) {
          bomBytes++;
          continue;
        }
        if (bomBytes > 0 && bomBytes < BOM.length) throw inputError("stdin is not a JSON object");
        if (isWhitespace(byte)) continue;
        if (byte !== OPEN_BRACE) throw inputError("stdin is not a JSON object");
        started = true;
        depth = 1;
        from = i;
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === BACKSLASH) escaped = true;
        else if (byte === QUOTE) inString = false;
      } else if (byte === QUOTE) {
        inString = true;
      } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        depth++;
      } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth--;
        if (depth === 0) {
          parts.push(chunk.subarray(from, i + 1));
          return concat(parts);
        }
      }
    }
    if (started) parts.push(chunk.subarray(from));
    consumed += chunk.length;
  }
}

function parse(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw inputError("stdin is not valid UTF-8", cause);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw inputError(`stdin is not valid JSON: ${describe(cause)}`, cause);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw inputError("stdin is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
