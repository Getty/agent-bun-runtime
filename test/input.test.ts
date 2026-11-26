// The stdin rule: read one complete JSON object, not to end of input, bounded in size.
import { describe, expect, test } from "bun:test";
import { AgentRuntimeError, DEFAULT_MAX_INPUT_BYTES } from "../src/index.js";
import { readJsonObject } from "../src/input.js";

const enc = new TextEncoder();

interface Probe {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
}

// A pull-on-demand stream (highWaterMark 0) over the given chunks. With `close` false it
// never ends, like a host that keeps stdin open after the hook object.
function source(parts: Array<string | Uint8Array>, close = true): Probe {
  let next = 0;
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        const part = parts[next++];
        if (part !== undefined) controller.enqueue(typeof part === "string" ? enc.encode(part) : part);
        else if (close) controller.close();
        // else: leave the read pending forever
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

async function inputError(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError);
    const typed = error as AgentRuntimeError;
    expect(typed.code).toBe("HOOK_INPUT_INVALID");
    expect(typed.stage).toBe("input");
    return typed;
  }
  throw new Error("expected HOOK_INPUT_INVALID, got a result");
}

describe("readJsonObject", () => {
  test("resolves with the object while the stream stays open", async () => {
    const probe = source(['{"hook_event_name":"SessionStart","n":1}\n'], false);
    expect(await readJsonObject(probe.stream)).toEqual({ hook_event_name: "SessionStart", n: 1 });
  });

  test("assembles an object split across chunks, a UTF-8 character included", async () => {
    const bytes = enc.encode('{"text":"Grüße"}');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "ü"
    const probe = source([bytes.slice(0, 3), bytes.slice(3, cut), bytes.slice(cut)], false);
    expect(await readJsonObject(probe.stream)).toEqual({ text: "Grüße" });
  });

  test("braces, brackets and escaped quotes inside strings do not end the object", async () => {
    const text = '{"a":"}{\\"\\\\","b":[1,{"c":"]}"}],"d":"\\\\"}';
    const probe = source([text, "garbage"], false);
    expect(await readJsonObject(probe.stream)).toEqual(JSON.parse(text));
  });

  test("leading whitespace is skipped", async () => {
    const probe = source([" \t\r\n", '\n {"a":true}'], false);
    expect(await readJsonObject(probe.stream)).toEqual({ a: true });
  });

  test("one leading UTF-8 byte order mark is skipped, also split across chunks", async () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    expect(await readJsonObject(source([bom, '{"a":1}'], false).stream)).toEqual({ a: 1 });
    expect(await readJsonObject(source([Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf), '{"a":2}'], false).stream)).toEqual({ a: 2 });
  });

  test("a second byte order mark, or one after whitespace, is an input error", async () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    await inputError(readJsonObject(source([bom, bom, '{"a":1}'], false).stream));
    await inputError(readJsonObject(source([" ", bom, '{"a":1}'], false).stream));
  });

  test("stops after the object: later chunks are never pulled and the stream is cancelled", async () => {
    const probe = source(['{"a":1}  {"second":2}', '{"third":3}'], false);
    expect(await readJsonObject(probe.stream)).toEqual({ a: 1 });
    expect(probe.pulls()).toBe(1);
    expect(probe.cancelled()).toBe(true);
  });

  test("empty input is an input error", async () => {
    const error = await inputError(readJsonObject(source([]).stream));
    expect(error.message).toContain("empty");
  });

  test("whitespace-only input is an input error", async () => {
    const error = await inputError(readJsonObject(source([" \n\t "]).stream));
    expect(error.message).toContain("empty");
  });

  test("input that ends inside the object is an input error", async () => {
    const error = await inputError(readJsonObject(source(['{"a":"open']).stream));
    expect(error.message).toContain("incomplete");
  });

  for (const text of ["[1,2]", '"text"', "42", "null", "true"]) {
    test(`a JSON value that is not an object (${text}) is an input error`, async () => {
      const probe = source([text], false);
      const error = await inputError(readJsonObject(probe.stream));
      expect(error.message).toContain("not a JSON object");
      expect(probe.cancelled()).toBe(true);
    });
  }

  test("malformed JSON inside the braces is an input error", async () => {
    const error = await inputError(readJsonObject(source(['{"a":}'], false).stream));
    expect(error.message).toContain("not valid JSON");
  });

  test("invalid UTF-8 is an input error", async () => {
    const bytes = new Uint8Array([...enc.encode('{"a":"'), 0xff, ...enc.encode('"}')]);
    const error = await inputError(readJsonObject(source([bytes], false).stream));
    expect(error.message).toContain("UTF-8");
  });

  test("an object of exactly maxBytes is accepted", async () => {
    const text = '{"a":"1234567"}'; // 15 bytes
    expect(await readJsonObject(source([text], false).stream, { maxBytes: 15 })).toEqual({ a: "1234567" });
  });

  test("input over maxBytes is an input error, and reading stops at the limit", async () => {
    const probe = source(['{"a":"12', "345678", '9"}', "never pulled"], false);
    const error = await inputError(readJsonObject(probe.stream, { maxBytes: 12 }));
    expect(error.message).toContain("12 bytes");
    expect(probe.pulls()).toBe(2);
    expect(probe.cancelled()).toBe(true);
  });

  test("leading whitespace counts toward maxBytes", async () => {
    await inputError(readJsonObject(source(["      ", '{"a":1}'], false).stream, { maxBytes: 10 }));
  });

  test("a stream that fails is an input error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("EIO");
      },
    });
    const error = await inputError(readJsonObject(stream));
    expect(error.message).toContain("could not be read");
  });

  test("the default bound is 1 MiB", () => {
    expect(DEFAULT_MAX_INPUT_BYTES).toBe(1024 * 1024);
  });

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    test(`maxBytes ${bad} is rejected as a programming error`, async () => {
      await expect(readJsonObject(source(["{}"]).stream, { maxBytes: bad })).rejects.toThrow(RangeError);
    });
  }
});
