// main(): the single response owner. Exit 0 when the effect was encoded and written; 1 for
// every failure, with exactly one stderr line "agent-bun-runtime: <CODE>: <message>" and no
// stdout. Never 2.
import { describe, expect, test } from "bun:test";
import { AgentRuntimeError, main, type HookContext, type HookHandler, type MainOptions } from "../src/index.js";
import { testCodec } from "./fixtures/codec.js";

// stdin that never ends, like a host that keeps it open after the hook object.
function openStdin(text: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sent) controller.enqueue(new TextEncoder().encode(text));
        sent = true;
      },
    },
    { highWaterMark: 0 },
  );
}

interface Outcome {
  code: number;
  stdout: string[];
  stderr: string[];
}

const SUBAGENT = JSON.stringify({ hook_event_name: "SubagentStart", cwd: "/project", agent_type: "worker" });
const SESSION = JSON.stringify({ hook_event_name: "SessionStart", source: "startup" });

async function run(handler: HookHandler, input = SUBAGENT, options: Partial<MainOptions> = {}): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main({
    codec: testCodec,
    handler,
    stdin: openStdin(input),
    stdout: (bytes) => {
      stdout.push(new TextDecoder().decode(bytes));
    },
    stderr: (text) => {
      stderr.push(text);
    },
    env: {},
    cwd: "/consumer",
    ...options,
  });
  return { code, stdout, stderr };
}

function failure(code: string, message: string): Outcome {
  return { code: 1, stdout: [], stderr: [`agent-bun-runtime: ${code}: ${message}\n`] };
}

describe("main", () => {
  test("add-context: exit 0, the encoded text written once, nothing on stderr", async () => {
    const outcome = await run(() => ({
      kind: "add-context",
      text: "Grüße an den Subagenten",
      audience: "model",
      placement: "subagent-input",
    }));
    expect(outcome).toEqual({ code: 0, stdout: ["Grüße an den Subagenten"], stderr: [] });
  });

  test("no-decision: exit 0 and the stdout writer is never called", async () => {
    expect(await run(() => ({ kind: "no-decision" }), SESSION)).toEqual({ code: 0, stdout: [], stderr: [] });
  });

  test("the handler gets the decoded invocation and the explicit env and cwd", async () => {
    let seen: HookContext | undefined;
    const env = { CODEX_HOME: "/codex-home" };
    await run(
      async (context) => {
        seen = context;
        return { kind: "no-decision" };
      },
      SUBAGENT,
      { env, cwd: "/plugin-root" },
    );
    expect(seen?.env).toBe(env);
    expect(seen?.invocation.event.nativeName).toBe("SubagentStart");
    expect(seen?.invocation.location).toEqual({ processCwd: "/plugin-root", hostWorkingDirectory: "/project" });
    expect(seen?.invocation.native.input).toEqual(JSON.parse(SUBAGENT));
  });

  test("a handler that throws: exit 1, one HANDLER_FAILED line, newlines folded", async () => {
    const outcome = await run(() => {
      throw new Error("boom\nsecond line\r\nthird");
    });
    expect(outcome).toEqual(failure("HANDLER_FAILED", "boom second line third"));
  });

  test("a handler that rejects or throws a non-Error is HANDLER_FAILED too", async () => {
    expect(await run(async () => Promise.reject(new TypeError("bad")))).toEqual(failure("HANDLER_FAILED", "bad"));
    expect(
      await run(() => {
        throw "plain string";
      }),
    ).toEqual(failure("HANDLER_FAILED", "plain string"));
  });

  test("a typed error from the handler keeps its code", async () => {
    const outcome = await run(() => {
      throw new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "handler", "not on this host");
    });
    expect(outcome).toEqual(failure("HOOK_EFFECT_UNSUPPORTED", "not on this host"));
  });

  test("a handler that returns nothing: HOOK_EFFECT_INVALID, never a silent no-decision", async () => {
    const outcome = await run((() => undefined) as unknown as HookHandler);
    expect(outcome).toEqual(failure("HOOK_EFFECT_INVALID", "the handler returned no effect"));
  });

  test("an effect kind outside the MVP: HOOK_EFFECT_UNSUPPORTED", async () => {
    const outcome = await run((() => ({ kind: "deny-pending-tool", reason: "x" })) as unknown as HookHandler);
    expect(outcome).toEqual(failure("HOOK_EFFECT_UNSUPPORTED", 'effect kind "deny-pending-tool" is not supported'));
  });

  test("empty stdin: HOOK_INPUT_INVALID and the handler never runs", async () => {
    let called = false;
    const stdin = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const outcome = await run(
      () => {
        called = true;
        return { kind: "no-decision" };
      },
      SUBAGENT,
      { stdin },
    );
    expect(outcome).toEqual(failure("HOOK_INPUT_INVALID", "stdin is empty: expected one JSON object"));
    expect(called).toBe(false);
  });

  test("maxInputBytes bounds stdin", async () => {
    const outcome = await run(() => ({ kind: "no-decision" }), SUBAGENT, { maxInputBytes: 8 });
    expect(outcome).toEqual(
      failure("HOOK_INPUT_INVALID", "stdin holds more than 8 bytes before the end of the JSON object"),
    );
  });

  test("a decode error from the codec: its code, and the handler never runs", async () => {
    let called = false;
    const outcome = await run(
      () => {
        called = true;
        return { kind: "no-decision" };
      },
      JSON.stringify({ hook_event_name: "PreToolUse" }),
    );
    expect(outcome).toEqual(failure("HOOK_EVENT_UNSUPPORTED", "event PreToolUse is not supported"));
    expect(called).toBe(false);
  });

  test("a placement the codec cannot deliver for the event: HOOK_EFFECT_UNSUPPORTED, no stdout", async () => {
    const outcome = await run(
      () => ({ kind: "add-context", text: "x", audience: "model", placement: "subagent-input" }),
      SESSION,
    );
    expect(outcome).toEqual(
      failure("HOOK_EFFECT_UNSUPPORTED", "placement subagent-input is not supported for SessionStart"),
    );
  });

  test("an untyped error inside the codec: INTERNAL_ERROR naming the stage", async () => {
    const codec = {
      ...testCodec,
      encode: () => {
        throw new RangeError("codec bug");
      },
    };
    const outcome = await run(() => ({ kind: "no-decision" }), SESSION, { codec });
    expect(outcome).toEqual(failure("INTERNAL_ERROR", "encode failed: codec bug"));
  });

  test("a codec that returns no string: INTERNAL_ERROR", async () => {
    const codec = { ...testCodec, encode: () => undefined as unknown as string };
    const outcome = await run(() => ({ kind: "no-decision" }), SESSION, { codec });
    expect(outcome).toEqual(failure("INTERNAL_ERROR", "encode failed: the codec returned no string"));
  });

  test("a codec that encodes add-context as no output: INTERNAL_ERROR, not a silent no-decision", async () => {
    const codec = { ...testCodec, encode: () => "" };
    const outcome = await run(
      () => ({ kind: "add-context", text: "x", audience: "model", placement: "subagent-input" }),
      SUBAGENT,
      { codec },
    );
    expect(outcome).toEqual(failure("INTERNAL_ERROR", "encode failed: the codec returned no output for add-context"));
  });

  test("a failing stdout writer: exit 1 and one OUTPUT_FAILED line", async () => {
    const stderr: string[] = [];
    const code = await main({
      codec: testCodec,
      handler: () => ({ kind: "add-context", text: "x", audience: "model", placement: "subagent-input" }),
      stdin: openStdin(SUBAGENT),
      stdout: () => Promise.reject(new Error("EINVAL: invalid argument")),
      stderr: (text) => {
        stderr.push(text);
      },
      env: {},
      cwd: "/consumer",
    });
    expect({ code, stderr }).toEqual({
      code: 1,
      stderr: ["agent-bun-runtime: OUTPUT_FAILED: stdout could not be written: EINVAL: invalid argument\n"],
    });
  });

  test("a failing stderr writer does not turn a failure into a throw", async () => {
    const outcome = await run(
      () => {
        throw new Error("boom");
      },
      SUBAGENT,
      {
        stderr: () => {
          throw new Error("stderr closed");
        },
      },
    );
    expect(outcome.code).toBe(1);
  });

  describe("every failure: exit 1 (never 2), exactly one stderr line, empty stdout", () => {
    const add = (over: object) => () => ({ kind: "add-context", text: "x", audience: "model", placement: "subagent-input", ...over });
    const cases: Array<[string, string, HookHandler, string?]> = [
      ["HOOK_INPUT_INVALID", "decode: malformed host object", () => ({ kind: "no-decision" }), "{}"],
      ["HOOK_EVENT_UNSUPPORTED", "decode: unsupported event", () => ({ kind: "no-decision" }), '{"hook_event_name":"Stop"}'],
      ["HANDLER_FAILED", "handler throws an Error", () => { throw new Error("x"); }],
      ["HANDLER_FAILED", "handler throws a non-Error", () => { throw 42; }],
      ["HOOK_EFFECT_UNSUPPORTED", "handler throws a typed error", () => { throw new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "handler", "t"); }],
      ["HOOK_EFFECT_INVALID", "handler returns nothing", (() => undefined) as unknown as HookHandler],
      ["HOOK_EFFECT_INVALID", "handler returns null", (() => null) as unknown as HookHandler],
      ["HOOK_EFFECT_INVALID", "add-context without text", add({ text: undefined }) as HookHandler],
      ["HOOK_EFFECT_INVALID", "unknown field on an effect", (() => ({ kind: "no-decision", extra: 1 })) as unknown as HookHandler],
      ["HOOK_EFFECT_UNSUPPORTED", "unsupported kind", (() => ({ kind: "block" })) as unknown as HookHandler],
      ["HOOK_EFFECT_UNSUPPORTED", "unsupported audience", add({ audience: "user" }) as HookHandler],
      ["HOOK_EFFECT_UNSUPPORTED", "unsupported placement", add({ placement: "pre-tool" }) as HookHandler],
    ];
    for (const [code, label, handler, input] of cases) {
      test(`${label}: ${code}`, async () => {
        const outcome = await run(handler, input ?? SUBAGENT);
        expect(outcome.code).toBe(1);
        expect(outcome.stdout).toEqual([]);
        expect(outcome.stderr).toHaveLength(1);
        expect(outcome.stderr[0]).toMatch(new RegExp(`^agent-bun-runtime: ${code}: [^\\r\\n]*\\n$`));
      });
    }

    test("OUTPUT_FAILED: a writer that throws synchronously", async () => {
      const stderr: string[] = [];
      const code = await main({
        codec: testCodec,
        handler: add({}) as HookHandler,
        stdin: openStdin(SUBAGENT),
        stdout: () => {
          throw new Error("EPIPE");
        },
        stderr: (text) => {
          stderr.push(text);
        },
        env: {},
        cwd: "/consumer",
      });
      expect(code).toBe(1);
      expect(stderr).toEqual(["agent-bun-runtime: OUTPUT_FAILED: stdout could not be written: EPIPE\n"]);
    });
  });
});
