// main(): the single response owner. Exit 0 when the effect was encoded and written; every
// failure writes exactly one stderr line "agent-bun-runtime: <CODE>: <message>" and no stdout,
// and exits 1, or 2 only when the entry chose onFailure "closed" (ADR 0009).
import { describe, expect, test } from "bun:test";
import { AgentRuntimeError, main, type ErrorCode, type HookCodec, type HookContext, type HookEffect, type HookHandler, type MainOptions } from "../src/index.js";
import { claudeCode } from "../src/claude-code.js";
import { codex } from "../src/codex.js";
import { defineCodec, type CodecImplementation } from "../src/codec.js";
import { testCodec, testImplementation } from "./fixtures/codec.js";

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
      JSON.stringify({ cwd: "/project" }),
    );
    expect(outcome).toEqual(failure("HOOK_INPUT_INVALID", "hook_event_name is not a string"));
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
    const codec = defineCodec("codex", {
      ...testImplementation,
      encode: () => {
        throw new RangeError("codec bug");
      },
    });
    const outcome = await run(() => ({ kind: "no-decision" }), SESSION, { codec });
    expect(outcome).toEqual(failure("INTERNAL_ERROR", "encode failed: codec bug"));
  });

  test("a codec that returns no string: INTERNAL_ERROR", async () => {
    const codec = defineCodec("codex", { ...testImplementation, encode: () => undefined as unknown as string });
    const outcome = await run(() => ({ kind: "no-decision" }), SESSION, { codec });
    expect(outcome).toEqual(failure("INTERNAL_ERROR", "encode failed: the codec returned no string"));
  });

  test("a codec that encodes add-context as no output: INTERNAL_ERROR, not a silent no-decision", async () => {
    const codec = defineCodec("codex", { ...testImplementation, encode: () => "" });
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

  describe("every failure with the default policy: exit 1 (2 only with onFailure closed), exactly one stderr line, empty stdout", () => {
    const add = (over: object) => () => ({ kind: "add-context", text: "x", audience: "model", placement: "subagent-input", ...over });
    const cases: Array<[string, string, HookHandler, string?]> = [
      ["HOOK_INPUT_INVALID", "decode: malformed host object", () => ({ kind: "no-decision" }), "{}"],
      ["HOOK_EFFECT_UNSUPPORTED", "encode: add-context for an event the stand-in codec has no rules for", add({}) as HookHandler, '{"hook_event_name":"Stop"}'],
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

// onFailure (ADR 0009): "open" (the default) exits 1, "closed" exits 2, the same one stderr
// line; the SDK returns 2 only for "closed".
describe("onFailure", () => {
  const add = (over: object) => () => ({ kind: "add-context", text: "x", audience: "model", placement: "subagent-input", ...over });
  const throwing = (error: unknown) => () => {
    throw error;
  };
  // [label, handler, stdin, options]: one failure of every stage `main()` reports.
  const closedStdin = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const failures: Array<[string, HookHandler, string, Partial<MainOptions>]> = [
    ["input: empty stdin", () => ({ kind: "no-decision" }), "", { stdin: closedStdin() }],
    ["input: too large", () => ({ kind: "no-decision" }), SUBAGENT, { maxInputBytes: 8 }],
    ["decode: no hook_event_name", () => ({ kind: "no-decision" }), "{}", {}],
    ["handler: throws an Error", throwing(new Error("boom")), SUBAGENT, {}],
    ["handler: throws a typed error", throwing(new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "handler", "t")), SUBAGENT, {}],
    ["effect: returns nothing", (() => undefined) as unknown as HookHandler, SUBAGENT, {}],
    ["effect: an empty list", (() => []) as unknown as HookHandler, SUBAGENT, {}],
    ["effect: two of one kind", (() => [add({})(), add({})()]) as unknown as HookHandler, SUBAGENT, {}],
    ["encode: unsupported placement", add({}) as HookHandler, SESSION, {}],
    ["output: the writer fails", add({}) as HookHandler, SUBAGENT, { stdout: () => Promise.reject(new Error("EPIPE")) }],
  ];

  test.each(failures)("%s: closed exits 2 with the line open exits 1 with, and no stdout", async (_label, handler, input, options) => {
    // a stream is read once: the closed-stdin case gets a fresh one per run
    const fresh = (): Partial<MainOptions> => ("stdin" in options ? { ...options, stdin: closedStdin() } : options);
    const open = await run(handler, input, fresh());
    const openExplicit = await run(handler, input, { ...fresh(), onFailure: "open" });
    const closed = await run(handler, input, { ...fresh(), onFailure: "closed" });
    expect(open.code).toBe(1);
    expect(openExplicit).toEqual(open);
    expect(closed.code).toBe(2);
    expect(closed.stderr).toHaveLength(1);
    expect(closed.stderr).toEqual(open.stderr);
    expect(closed.stderr[0]).toMatch(/^agent-bun-runtime: [A-Z_]+: [^\r\n]*\n$/);
    if (options.stdout === undefined) {
      expect(closed.stdout).toEqual([]);
      expect(open.stdout).toEqual([]);
    }
  });

  test("closed does not change success: exit 0, output written", async () => {
    const outcome = await run(add({}) as HookHandler, SUBAGENT, { onFailure: "closed" });
    expect(outcome).toEqual({ code: 0, stdout: ["x"], stderr: [] });
    expect(await run(() => ({ kind: "no-decision" }), SESSION, { onFailure: "closed" })).toEqual({ code: 0, stdout: [], stderr: [] });
  });

  test("closed: a failing stderr writer still ends in exit 2", async () => {
    const outcome = await run(throwing(new Error("boom")), SUBAGENT, {
      onFailure: "closed",
      stderr: () => {
        throw new Error("stderr closed");
      },
    });
    expect(outcome.code).toBe(2);
  });

  test("an onFailure other than open or closed: INTERNAL_ERROR, exit 1, stdin never read, handler never run", async () => {
    for (const value of ["CLOSED", "Open", "", "fail-closed", 2, 0, true, {}, []]) {
      let reads = 0;
      let called = false;
      const stdin = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(new TextEncoder().encode(SUBAGENT));
        },
      }, { highWaterMark: 0 });
      const outcome = await run(
        () => {
          called = true;
          return { kind: "no-decision" };
        },
        SUBAGENT,
        { stdin, onFailure: value as never },
      );
      expect(outcome.code).toBe(1);
      expect(outcome.stdout).toEqual([]);
      expect(outcome.stderr).toHaveLength(1);
      expect(outcome.stderr[0]).toMatch(/^agent-bun-runtime: INTERNAL_ERROR: main\(\): onFailure must be "open" or "closed", got [^\r\n]+\n$/);
      expect({ value, reads, called }).toEqual({ value, reads: 0, called: false });
    }
  });

  test("the invalid value is named in the line", async () => {
    const outcome = await run(() => ({ kind: "no-decision" }), SUBAGENT, { onFailure: "CLOSED" as never });
    expect(outcome.stderr).toEqual(['agent-bun-runtime: INTERNAL_ERROR: main(): onFailure must be "open" or "closed", got "CLOSED"\n']);
  });
});

// HookCodec is opaque (ADR 0009): a plugin picks one of the package's codecs and cannot
// implement one. The runtime check is in main(); the type is nominal.
describe("HookCodec is opaque", () => {
  const rawImplementation: CodecImplementation = testImplementation;
  const impostors: Array<[string, unknown]> = [
    ["a spread copy of a real codec", { ...codex }],
    ["a spread copy of the claude-code codec", { ...claudeCode }],
    ["an object literal with a host, decode and encode", { host: "codex", decode: rawImplementation.decode, encode: rawImplementation.encode }],
    ["an object literal shaped like the implementation", rawImplementation],
    ["an object that inherits from a real codec", Object.create(codex) as object],
    ["a frozen clone with the same prototype", Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(codex) as object) as object, { host: "codex" }))],
    ["an empty object", {}],
    ["null", null],
    ["undefined", undefined],
    ["a string", "codex"],
    ["a function", () => undefined],
  ];

  test.each(impostors)("%s: INTERNAL_ERROR, exit 1, nothing read, nothing written", async (_label, impostor) => {
    let reads = 0;
    let called = false;
    const stdin = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode(SESSION));
      },
    }, { highWaterMark: 0 });
    const outcome = await run(
      () => {
        called = true;
        return { kind: "no-decision" };
      },
      SESSION,
      { codec: impostor as HookCodec, stdin },
    );
    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr).toEqual(["agent-bun-runtime: INTERNAL_ERROR: the codec is not one of this package's codecs\n"]);
    expect({ reads, called }).toEqual({ reads: 0, called: false });
  });

  test("with onFailure closed an impostor ends in exit 2, the same line", async () => {
    const outcome = await run(() => ({ kind: "no-decision" }), SESSION, { codec: { ...codex } as unknown as HookCodec, onFailure: "closed" });
    expect(outcome).toEqual({
      code: 2,
      stdout: [],
      stderr: ["agent-bun-runtime: INTERNAL_ERROR: the codec is not one of this package's codecs\n"],
    });
  });

  test("the real codecs are accepted: a no-decision on each ends in exit 0", async () => {
    for (const [codec, input] of [
      [codex, '{"hook_event_name":"SessionStart"}'],
      [claudeCode, '{"hook_event_name":"SessionStart"}'],
      [testCodec, SESSION],
    ] as const) {
      expect(await run(() => ({ kind: "no-decision" }), input, { codec })).toEqual({ code: 0, stdout: [], stderr: [] });
    }
  });

  test("typecheck: no object literal is a HookCodec, and the removed code is not an ErrorCode", () => {
    // @ts-expect-error a codec is not a plugin interface: HookCodec is nominal
    const literal: HookCodec = { host: "codex", decode: rawImplementation.decode, encode: rawImplementation.encode };
    // @ts-expect-error HOOK_EVENT_UNSUPPORTED is gone (ADR 0009)
    const gone: ErrorCode = "HOOK_EVENT_UNSUPPORTED";
    expect([literal, gone]).toHaveLength(2);
  });
});

describe("events the codec has no rules for", () => {
  test("a string hook_event_name is decoded generically: session id and cwd when strings, nothing else mapped", async () => {
    let seen: HookContext | undefined;
    const input = JSON.stringify({ hook_event_name: "Stop", session_id: "s-1", cwd: "/project", turn_id: "t-1", stop_hook_active: false });
    const outcome = await run(
      (context) => {
        seen = context;
        return { kind: "no-decision" };
      },
      input,
    );
    expect(outcome).toEqual({ code: 0, stdout: [], stderr: [] });
    expect(seen?.invocation.event.nativeName).toBe("Stop");
    expect(seen?.invocation.location).toEqual({ processCwd: "/consumer", hostWorkingDirectory: "/project" });
    expect(seen?.invocation.identity).toEqual({ hostSessionId: "s-1" });
    expect("tool" in (seen?.invocation ?? {})).toBe(false);
    expect(seen?.invocation.native.input).toEqual(JSON.parse(input));
  });

  test("a non-string session_id or cwd is left out, not rejected", async () => {
    let seen: HookContext | undefined;
    const outcome = await run(
      (context) => {
        seen = context;
        return { kind: "no-decision" };
      },
      JSON.stringify({ hook_event_name: "Stop", session_id: 5, cwd: null }),
    );
    expect(outcome.code).toBe(0);
    expect(seen?.invocation.location).toEqual({ processCwd: "/consumer" });
    expect(seen?.invocation.identity).toEqual({});
  });

  test("any effect but no-decision is HOOK_EFFECT_UNSUPPORTED, never HOOK_EVENT_UNSUPPORTED", async () => {
    const effects: HookEffect[] = [
      { kind: "add-context", text: "x", audience: "model", placement: "subagent-input" },
      { kind: "notify-user", text: "x" },
      { kind: "tool-permission", decision: "deny", reason: "x" },
      { kind: "tool-input", input: {} },
    ];
    for (const effect of effects) {
      const outcome = await run(() => effect, JSON.stringify({ hook_event_name: "PreToolUse" }));
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toHaveLength(1);
      expect(outcome.stderr[0]).toStartWith("agent-bun-runtime: HOOK_EFFECT_UNSUPPORTED: ");
      expect(outcome.stderr[0]).not.toContain("HOOK_EVENT_UNSUPPORTED");
    }
  });

  test("an input with no string hook_event_name is still HOOK_INPUT_INVALID", async () => {
    for (const input of ["{}", '{"hook_event_name":null}', '{"hook_event_name":["Stop"]}']) {
      const outcome = await run(() => ({ kind: "no-decision" }), input);
      expect(outcome.stderr[0]).toStartWith("agent-bun-runtime: HOOK_INPUT_INVALID: ");
    }
  });
});

describe("a handler that returns a list", () => {
  function recordingCodec(seen: Array<readonly HookEffect[]>): HookCodec {
    return defineCodec("codex", {
      ...testImplementation,
      encode: (effects) => {
        seen.push(effects);
        return `{"n":${effects.length}}\n`;
      },
    });
  }
  const notify: HookEffect = { kind: "notify-user", text: "hello" };
  const add: HookEffect = { kind: "add-context", text: "ctx", audience: "model", placement: "session-start-input" };

  test("the codec gets the validated list, frozen, in the handler's order, and writes one output", async () => {
    const seen: Array<readonly HookEffect[]> = [];
    const outcome = await run(() => [notify, add], SESSION, { codec: recordingCodec(seen) });
    expect(outcome).toEqual({ code: 0, stdout: ['{"n":2}\n'], stderr: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([notify, add]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  test("a single effect reaches the codec as a list of one", async () => {
    const seen: Array<readonly HookEffect[]> = [];
    await run(() => add, SESSION, { codec: recordingCodec(seen) });
    expect(seen).toEqual([[add]]);
  });

  test("a promise of a list is awaited", async () => {
    const seen: Array<readonly HookEffect[]> = [];
    const outcome = await run(async () => [add, notify], SESSION, { codec: recordingCodec(seen) });
    expect(outcome.code).toBe(0);
    expect(seen).toEqual([[add, notify]]);
  });

  test.each([
    ["an empty list", () => [], "the handler returned an empty list of effects"],
    ["two of one kind", () => [notify, { kind: "notify-user", text: "again" }], "the list of effects has more than one notify-user"],
    ["no-decision beside another effect", () => [{ kind: "no-decision" }, notify], "no-decision cannot be combined with other effects"],
    ["a list with an invalid element", () => [notify, { kind: "notify-user", text: "" }], "notify-user needs a non-empty string text"],
  ] as const)("%s: HOOK_EFFECT_INVALID before the codec is asked", async (_label, handler, message) => {
    const seen: Array<readonly HookEffect[]> = [];
    const outcome = await run(handler as unknown as HookHandler, SESSION, { codec: recordingCodec(seen) });
    expect(outcome).toEqual(failure("HOOK_EFFECT_INVALID", message));
    expect(seen).toEqual([]);
  });

  test("a codec that returns no output for a list that is not no-decision: INTERNAL_ERROR naming the kinds", async () => {
    const codec = defineCodec("codex", { ...testImplementation, encode: () => "" });
    const outcome = await run(() => [notify, add], SESSION, { codec });
    expect(outcome).toEqual(failure("INTERNAL_ERROR", "encode failed: the codec returned no output for notify-user, add-context"));
  });
});
