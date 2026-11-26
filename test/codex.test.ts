// The Codex codec (k22): decodes SessionStart and SubagentStart from the fixtures in
// test/fixtures/codex/ (source-checked against openai/codex 3f65e9f, see its README),
// encodes no-decision and add-context to the exact .out bytes, and rejects everything else
// with a typed error. The last block pipes the fixtures through an entry on main() as a
// real process. No Codex runs here; real runs are phase 3a.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as codexModule from "../src/codex.js";
import { codex } from "../src/codex.js";
import { codecImplementation } from "../src/codec.js";
import { createInvocation } from "../src/context.js";
import { AgentRuntimeError, main, type HookEffect, type HookInvocation } from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures", "codex");
const ENTRY = join(FIXTURES, "entry.ts");
const PROCESS_CWD = "/consumer";
const EXIT_BOUND_MS = 10_000;
// per-test timeout above the bound, so the bound and the kill in runEntry can fire first
const ENTRY_TEST_TIMEOUT_MS = EXIT_BOUND_MS + 10_000;
const enc = new TextEncoder();

type Input = Record<string, unknown>;

async function fixture(path: string): Promise<Input> {
  return (await Bun.file(join(FIXTURES, path)).json()) as Input;
}

async function fixtureBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  return await Bun.file(join(FIXTURES, path)).bytes();
}

const CONTEXT_TEXT = (await Bun.file(join(FIXTURES, "output", "context.json")).json()) as string;

const codexImplementation = codecImplementation(codex);

function decode(input: Input): HookInvocation {
  return codexImplementation.decode(input, { processCwd: PROCESS_CWD });
}

function caught(run: () => unknown): AgentRuntimeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError);
    return error as AgentRuntimeError;
  }
  throw new Error("expected an AgentRuntimeError, nothing was thrown");
}

function expectError(run: () => unknown, code: string, stage: string): AgentRuntimeError {
  const error = caught(run);
  expect({ code: error.code, stage: error.stage }).toEqual({ code, stage } as never);
  return error;
}

function addContext(placement: "session-start-input" | "subagent-input", text = CONTEXT_TEXT): HookEffect {
  return { kind: "add-context", text, audience: "model", placement };
}

const SESSION_START_INPUTS = [
  "input/session-start.startup.json",
  "input/session-start.resume.json",
  "input/session-start.clear.json",
  "input/session-start.compact.json",
  "input/session-start.fork.json",
  "input/session-start.minimal.json",
  "input/session-start.startup.windows.json",
];

const SUBAGENT_START_INPUTS = [
  "input/subagent-start.json",
  "input/subagent-start.default-role.json",
  "input/subagent-start.minimal.json",
  "input/subagent-start.extra-field.json",
];

const PARTIAL_INPUTS = [
  "partial/session-start.event-only.json",
  "partial/session-start.missing-source.json",
  "partial/subagent-start.event-only.json",
  "partial/subagent-start.missing-agent-type.json",
  "partial/subagent-start.briefing-tests.json",
];

describe("exported surface", () => {
  test("src/codex.ts exports the codec value and nothing else", () => {
    expect(Object.keys(codexModule)).toEqual(["codex"]);
  });
});

describe("decode", () => {
  test.each(SESSION_START_INPUTS)("%s: SessionStart envelope", async (path) => {
    const input = await fixture(path);
    const invocation = decode(input);
    expect(invocation).toStrictEqual({
      envelopeVersion: 1,
      host: { kind: "codex", surface: "command-hook" },
      event: { nativeName: "SessionStart" },
      location: { processCwd: PROCESS_CWD, hostWorkingDirectory: input.cwd as string },
      identity: { hostSessionId: input.session_id as string },
      native: { input },
    });
    expect(invocation.native.input).toBe(input);
    expect(Object.isFrozen(invocation.native.input)).toBe(true);
  });

  test.each(SUBAGENT_START_INPUTS)("%s: SubagentStart envelope, no parent session id", async (path) => {
    const input = await fixture(path);
    const invocation = decode(input);
    expect(invocation).toStrictEqual({
      envelopeVersion: 1,
      host: { kind: "codex", surface: "command-hook" },
      event: { nativeName: "SubagentStart" },
      location: { processCwd: PROCESS_CWD, hostWorkingDirectory: input.cwd as string },
      identity: { hostSessionId: input.session_id as string, hostTurnId: input.turn_id as string },
      native: { input },
    });
    expect("hostParentSessionId" in invocation.identity).toBe(false);
  });

  test("an extra key is kept in native.input unchecked", async () => {
    const invocation = decode(await fixture("input/subagent-start.extra-field.json"));
    expect(invocation.native.input.agent_transcript_path).toBeNull();
  });

  test("partial inputs decode with the missing keys absent", async () => {
    const got: Record<string, unknown> = {};
    for (const path of PARTIAL_INPUTS) {
      const { event, location, identity } = decode(await fixture(path));
      got[path] = { event: event.nativeName, location, identity };
    }
    const cwd = "/home/dev/src/example-project";
    const root = "01a213aa-3839-7c52-9e1b-4f6a2d8c03b7";
    const turn = "01a213ba-86b1-7d8e-9c02-5ab4e71f3d60";
    expect(got).toStrictEqual({
      "partial/session-start.event-only.json": {
        event: "SessionStart",
        location: { processCwd: PROCESS_CWD },
        identity: {},
      },
      "partial/session-start.missing-source.json": {
        event: "SessionStart",
        location: { processCwd: PROCESS_CWD, hostWorkingDirectory: cwd },
        identity: { hostSessionId: root },
      },
      "partial/subagent-start.event-only.json": {
        event: "SubagentStart",
        location: { processCwd: PROCESS_CWD },
        identity: {},
      },
      "partial/subagent-start.missing-agent-type.json": {
        event: "SubagentStart",
        location: { processCwd: PROCESS_CWD, hostWorkingDirectory: cwd },
        identity: { hostSessionId: root, hostTurnId: turn },
      },
      "partial/subagent-start.briefing-tests.json": {
        event: "SubagentStart",
        location: { processCwd: PROCESS_CWD, hostWorkingDirectory: cwd },
        identity: { hostTurnId: "turn_123" },
      },
    });
  });

  test("enum strings are not checked against a list", async () => {
    const session = await fixture("input/session-start.startup.json");
    session.source = "a-future-source";
    session.permission_mode = "dontAsk";
    expect(decode(session).native.input.source).toBe("a-future-source");
    const subagent = await fixture("input/subagent-start.json");
    subagent.agent_type = "";
    expect(decode(subagent).native.input.agent_type).toBe("");
  });

  test("keys of the other event are unknown keys: kept, unchecked, not mapped", async () => {
    const session = await fixture("input/session-start.startup.json");
    session.turn_id = "01a213ba-86b1-7d8e-9c02-5ab4e71f3d60";
    session.agent_type = ["x"];
    const invocation = decode(session);
    expect(invocation.identity).toStrictEqual({ hostSessionId: session.session_id as string });
    const subagent = await fixture("input/subagent-start.json");
    subagent.source = 5;
    expect(decode(subagent).native.input.source).toBe(5);
  });

  // Lifted keys: session_id and cwd on both events, turn_id on SubagentStart only (ADR 0009).
  const LIFTED = [
    ["input/session-start.startup.json", "session_id"],
    ["input/session-start.startup.json", "cwd"],
    ["input/subagent-start.json", "session_id"],
    ["input/subagent-start.json", "cwd"],
    ["input/subagent-start.json", "turn_id"],
  ] as const;
  // Every other key is unchecked: any value stays in native.input and the envelope is unchanged.
  const UNCHECKED = [
    ["input/session-start.startup.json", "transcript_path"],
    ["input/session-start.startup.json", "model"],
    ["input/session-start.startup.json", "permission_mode"],
    ["input/session-start.startup.json", "source"],
    ["input/subagent-start.json", "transcript_path"],
    ["input/subagent-start.json", "model"],
    ["input/subagent-start.json", "agent_id"],
    ["input/subagent-start.json", "agent_type"],
  ] as const;
  const WRONG: unknown[] = [1, true, null, [], {}];

  test.each(LIFTED)("%s: a wrong type for the lifted key %s, null included, is HOOK_INPUT_INVALID", async (path, key) => {
    for (const value of WRONG) {
      const input = await fixture(path);
      input[key] = value;
      const error = expectError(() => decode(input), "HOOK_INPUT_INVALID", "decode");
      expect(error.message).toContain(key);
    }
  });

  test.each(UNCHECKED)("%s: any value for the unchecked key %s is accepted and kept unchanged in native.input", async (path, key) => {
    const base = await fixture(path);
    const { native: _b, ...baseEnvelope } = decode(base);
    for (const value of [...WRONG, "x"]) {
      const input = { ...base, [key]: value };
      const invocation = decode(input);
      const { native: _n, ...envelope } = invocation;
      expect(envelope).toStrictEqual(baseEnvelope);
      expect(invocation.native.input[key]).toStrictEqual(value);
    }
  });

  test.each(["tolerated/session-start.transcript-path-number.json"])("%s: decodes, the odd value kept unchanged in native.input", async (path) => {
    const input = await fixture(path);
    const invocation = decode(input);
    expect(invocation.native.input).toStrictEqual(input);
    expect(invocation.identity).toStrictEqual({ hostSessionId: input.session_id as string });
    expect(invocation.location).toStrictEqual({ processCwd: PROCESS_CWD, hostWorkingDirectory: input.cwd as string });
    expect(invocation.native.input.transcript_path).toBe(0);
  });

  test("transcript_path null is accepted and means missing", async () => {
    for (const path of ["input/session-start.minimal.json", "input/subagent-start.minimal.json"]) {
      const invocation = decode(await fixture(path));
      expect(invocation.native.input.transcript_path).toBeNull();
    }
  });

  test.each([
    ["malformed/missing-hook-event-name.json", "HOOK_INPUT_INVALID"],
    ["malformed/hook-event-name-number.json", "HOOK_INPUT_INVALID"],
    ["malformed/subagent-start.turn-id-number.json", "HOOK_INPUT_INVALID"],
    ["malformed/not-an-object.json", "HOOK_INPUT_INVALID"],
  ])("%s: %s", async (path, code) => {
    const input = await fixture(path);
    expectError(() => decode(input), code, "decode");
  });

  test.each(["", "sessionstart", "SessionEnd", "SubagentStop", "Stop", "PreCompact"])(
    "event %p is decoded generically",
    (event) => {
      expect(decode({ hook_event_name: event }).event.nativeName).toBe(event);
    },
  );
});

describe("encode", () => {
  test("no-decision is empty on both events", async () => {
    expect(await fixtureBytes("output/no-decision.out")).toEqual(new Uint8Array(0));
    for (const path of ["input/session-start.startup.json", "input/subagent-start.json"]) {
      expect(codexImplementation.encode([{ kind: "no-decision" }], decode(await fixture(path)))).toBe("");
    }
  });

  test.each([
    ["input/session-start.startup.json", "session-start-input", "output/session-start.add-context.out"],
    ["input/subagent-start.json", "subagent-input", "output/subagent-start.add-context.out"],
  ] as const)("%s, add-context at %s: the bytes of %s", async (path, placement, out) => {
    const text = codexImplementation.encode([addContext(placement)], decode(await fixture(path)));
    expect(enc.encode(text)).toEqual(await fixtureBytes(out));
  });

  test("the output is one object with hookSpecificOutput only, and one final LF", async () => {
    for (const [path, event, placement] of [
      ["input/session-start.startup.json", "SessionStart", "session-start-input"],
      ["input/subagent-start.json", "SubagentStart", "subagent-input"],
    ] as const) {
      const text = codexImplementation.encode([addContext(placement)], decode(await fixture(path)));
      expect(text.endsWith("}\n")).toBe(true);
      expect(text.indexOf("\n")).toBe(text.length - 1);
      expect(JSON.parse(text)).toStrictEqual({
        hookSpecificOutput: { hookEventName: event, additionalContext: CONTEXT_TEXT },
      });
    }
  });

  test("text that looks like JSON or has outer whitespace stays a JSON string, unchanged", async () => {
    const invocation = decode(await fixture("input/session-start.startup.json"));
    for (const text of ['{"continue":false}', "[1]", "  padded\n\n", "🚀"]) {
      const out = codexImplementation.encode([addContext("session-start-input", text)], invocation);
      expect((JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext).toBe(text);
    }
  });

  test.each([
    ["input/session-start.startup.json", "subagent-input"],
    ["input/subagent-start.json", "session-start-input"],
  ] as const)("%s: placement %s is HOOK_EFFECT_UNSUPPORTED", async (path, placement) => {
    const invocation = decode(await fixture(path));
    const error = expectError(() => codexImplementation.encode([addContext(placement)], invocation), "HOOK_EFFECT_UNSUPPORTED", "encode");
    expect(error.message).toContain(placement);
  });

  test.each(["\uD800", "a\uDC00b", "\uDE80\uD83D", `${CONTEXT_TEXT}\uD83D`])(
    "an unpaired surrogate is HOOK_EFFECT_UNSUPPORTED (%#)",
    async (text) => {
      const invocation = decode(await fixture("input/subagent-start.json"));
      expectError(() => codexImplementation.encode([addContext("subagent-input", text)], invocation), "HOOK_EFFECT_UNSUPPORTED", "encode");
    },
  );

  test("an invocation of another event: no-decision is empty, add-context HOOK_EFFECT_UNSUPPORTED", () => {
    const invocation = createInvocation({
      host: { kind: "codex", surface: "command-hook" },
      nativeEvent: "SessionEnd",
      processCwd: PROCESS_CWD,
      nativeInput: { hook_event_name: "SessionEnd" },
    });
    expect(codexImplementation.encode([{ kind: "no-decision" }], invocation)).toBe("");
    expectError(() => codexImplementation.encode([addContext("session-start-input")], invocation), "HOOK_EFFECT_UNSUPPORTED", "encode");
  });

  test("an effect kind outside the vocabulary is HOOK_EFFECT_UNSUPPORTED", async () => {
    const invocation = decode(await fixture("input/session-start.startup.json"));
    const effect = { kind: "deny-pending-tool", reason: "x" } as unknown as HookEffect;
    expectError(() => codexImplementation.encode([effect], invocation), "HOOK_EFFECT_UNSUPPORTED", "encode");
  });
});

// main() in process: stdin from the fixture bytes, closed after them as Codex closes the
// hook's stdin after write_all (codex-rs/hooks/src/engine/command_runner.rs:318-327).
async function runMain(stdin: Uint8Array<ArrayBuffer>, handler: (invocation: HookInvocation) => HookEffect) {
  const stdout: Uint8Array[] = [];
  const stderr: string[] = [];
  const code = await main({
    codec: codex,
    handler: ({ invocation }) => handler(invocation),
    stdin: new Blob([stdin]).stream(),
    stdout: (bytes) => {
      stdout.push(bytes.slice());
    },
    stderr: (text) => {
      stderr.push(text);
    },
    env: {},
    cwd: PROCESS_CWD,
  });
  return { code, stdout, stderr };
}

const byEvent = (invocation: HookInvocation): HookEffect =>
  addContext(invocation.event.nativeName === "SubagentStart" ? "subagent-input" : "session-start-input");

function outFor(path: string): string {
  return path.includes("subagent-start") ? "output/subagent-start.add-context.out" : "output/session-start.add-context.out";
}

describe("main() with the Codex codec", () => {
  test.each([...SESSION_START_INPUTS, ...SUBAGENT_START_INPUTS, ...PARTIAL_INPUTS])(
    "%s: exit 0 and the .out bytes",
    async (path) => {
      const result = await runMain(await fixtureBytes(path), byEvent);
      expect(result).toEqual({ code: 0, stdout: [await fixtureBytes(outFor(path))], stderr: [] });
    },
  );

  test.each([
    ["malformed/empty.json", "HOOK_INPUT_INVALID"],
    ["malformed/truncated.json", "HOOK_INPUT_INVALID"],
    ["malformed/not-an-object.json", "HOOK_INPUT_INVALID"],
    ["malformed/missing-hook-event-name.json", "HOOK_INPUT_INVALID"],
    ["malformed/hook-event-name-number.json", "HOOK_INPUT_INVALID"],
    ["malformed/subagent-start.turn-id-number.json", "HOOK_INPUT_INVALID"],
    ["malformed/session-end.json", "HOOK_EFFECT_UNSUPPORTED"],
  ])("%s: exit 1, %s, no stdout", async (path, code) => {
    const result = await runMain(await fixtureBytes(path), byEvent);
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toStartWith(`agent-bun-runtime: ${code}: `);
  });

  test("the wrong placement: exit 1, HOOK_EFFECT_UNSUPPORTED, no stdout", async () => {
    const result = await runMain(await fixtureBytes("input/session-start.startup.json"), () => addContext("subagent-input"));
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr[0]).toStartWith("agent-bun-runtime: HOOK_EFFECT_UNSUPPORTED: ");
  });

  test("empty text is the core's HOOK_EFFECT_INVALID, before the codec", async () => {
    const result = await runMain(await fixtureBytes("input/subagent-start.json"), () => addContext("subagent-input", ""));
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toStartWith("agent-bun-runtime: HOOK_EFFECT_INVALID: ");
  });
});

// The entry as a real Bun process on pipes. stdin gets the fixture bytes and is then
// closed, as Codex does on the local path (command_runner.rs:318-327).
let home = "";
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "abr-codex-test-"));
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function runEntry(mode: "context" | "none", stdin: Uint8Array) {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY, mode],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, GETTY_HOME: home },
  });
  const stdout = new Response(proc.stdout).bytes();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(stdin);
  await proc.stdin.flush();
  proc.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), EXIT_BOUND_MS);
  });
  const exited = await Promise.race([proc.exited, bound]);
  clearTimeout(timer);
  if (exited === "timeout") {
    proc.kill();
    await proc.exited;
    throw new Error(`entry did not exit within ${EXIT_BOUND_MS} ms`);
  }
  return { code: exited, stdout: await stdout, stderr: await stderr };
}

describe("end to end: an entry on main({ codec: codex, handler }) through a pipe", () => {
  test.each([...SESSION_START_INPUTS, ...SUBAGENT_START_INPUTS, ...PARTIAL_INPUTS])(
    "%s: exit 0, stdout is the .out file",
    async (path) => {
      const result = await runEntry("context", await fixtureBytes(path));
      expect(result).toEqual({ code: 0, stdout: await fixtureBytes(outFor(path)), stderr: "" });
    },
    ENTRY_TEST_TIMEOUT_MS,
  );

  test.each(["input/session-start.startup.json", "input/subagent-start.json"])(
    "%s, no-decision: exit 0, stdout is no-decision.out (empty)",
    async (path) => {
      const result = await runEntry("none", await fixtureBytes(path));
      expect(result).toEqual({ code: 0, stdout: await fixtureBytes("output/no-decision.out"), stderr: "" });
    },
    ENTRY_TEST_TIMEOUT_MS,
  );

  test("SessionEnd: exit 1, no stdout, one stderr line", async () => {
    const result = await runEntry("context", await fixtureBytes("malformed/session-end.json"));
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual(new Uint8Array(0));
    expect(result.stderr).toStartWith("agent-bun-runtime: HOOK_EFFECT_UNSUPPORTED: ");
    expect(result.stderr.indexOf("\n")).toBe(result.stderr.length - 1);
  }, ENTRY_TEST_TIMEOUT_MS);
});
