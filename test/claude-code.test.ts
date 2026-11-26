// The Claude Code codec (k36, k26, k31): decodes SessionStart, UserPromptSubmit,
// PreToolUse, PostToolUse and CwdChanged from test/fixtures/claude-code/input/, partial/ and
// generic/, rejects every malformed/ fixture, and encodes every row of output/effects.json
// byte for byte through main(). The last block runs an entry as a real Bun process on pipes.
// Evidence for the fixtures is in their README: four recorded by loadguard k7 on Claude Code
// 2.1.283, the rest schema-checked or synthetic; no Claude Code runs here, so this proves the
// codec, not the host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claudeCodeModule from "../src/claude-code.js";
import { claudeCode } from "../src/claude-code.js";
import { codecImplementation } from "../src/codec.js";
import { AgentRuntimeError, main, type HookEffect, type HookInvocation } from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures", "claude-code");
const ENTRY = join(FIXTURES, "entry.ts");
const PROCESS_CWD = "/consumer";
const textEncoder = new TextEncoder();

type Input = Record<string, unknown>;
const fixture = async (path: string): Promise<Input> => (await Bun.file(join(FIXTURES, path)).json()) as Input;
const fixtureBytes = async (path: string) => await Bun.file(join(FIXTURES, path)).bytes();
const names = (dir: string) => readdirSync(join(FIXTURES, dir)).filter((name) => name.endsWith(".json")).sort();

const implementation = codecImplementation(claudeCode);
const decode = (input: Input): HookInvocation => implementation.decode(input, { processCwd: PROCESS_CWD });
const encode = (effects: readonly HookEffect[], input: Input): string => implementation.encode(effects, decode(input));

function expectError(run: () => unknown, code: string, stage: string): AgentRuntimeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError);
    const typed = error as AgentRuntimeError;
    expect({ code: typed.code, stage: typed.stage }).toEqual({ code, stage } as never);
    return typed;
  }
  throw new Error("expected an AgentRuntimeError, nothing was thrown");
}
const unsupported = (run: () => unknown) => expectError(run, "HOOK_EFFECT_UNSUPPORTED", "encode");

type Placement = Extract<HookEffect, { kind: "add-context" }>["placement"];
const PLACEMENTS: readonly Placement[] = ["session-start-input", "subagent-input", "prompt-input", "tool-result"];
const addContext = (placement: Placement, text = "ctx"): HookEffect => ({ kind: "add-context", text, audience: "model", placement });
const notifyUser = (text = "note"): HookEffect => ({ kind: "notify-user", text });
const permission = (decision: "allow" | "deny" | "ask", reason?: string): HookEffect =>
  reason === undefined ? { kind: "tool-permission", decision } : { kind: "tool-permission", decision, reason };
const toolInput = (input: Record<string, unknown>): HookEffect => ({ kind: "tool-input", input });

// One input fixture per event with rules, and the placement that event delivers.
const EVENT_FIXTURE: Record<string, string> = {
  SessionStart: "input/session-start.startup.json",
  UserPromptSubmit: "input/user-prompt-submit.json",
  PreToolUse: "input/pre-tool-use.bash.json",
  PostToolUse: "input/post-tool-use.bash.json",
  CwdChanged: "input/cwd-changed.json",
};
const OWN_PLACEMENT: Record<string, Placement | undefined> = {
  SessionStart: "session-start-input",
  UserPromptSubmit: "prompt-input",
  PostToolUse: "tool-result",
  PreToolUse: undefined,
  CwdChanged: undefined,
};
const EVENTS = Object.keys(EVENT_FIXTURE);
const eventInput = (event: string) => fixture(EVENT_FIXTURE[event] as string);

const INPUTS = names("input").map((name) => `input/${name}`);
const PARTIALS = names("partial").map((name) => `partial/${name}`);
const GENERICS = names("generic").map((name) => `generic/${name}`);
// Rejected by the core reader before any codec sees them.
const READER_ONLY = new Set(["empty.json", "truncated.json", "not-an-object.json"]);
const MALFORMED = names("malformed");
const LENIENT = names("lenient");

describe("exported surface", () => {
  test("src/claude-code.ts exports the codec value and nothing else", () => {
    expect(Object.keys(claudeCodeModule)).toEqual(["claudeCode"]);
  });

  test("the codec speaks for claude-code as a command hook", async () => {
    expect(claudeCode.host).toBe("claude-code");
    expect(decode(await fixture(EVENT_FIXTURE.SessionStart as string)).host).toStrictEqual({ kind: "claude-code", surface: "command-hook" });
  });

  test("the fixture directories are enumerated, not listed: none of them is empty", () => {
    for (const list of [INPUTS, PARTIALS, GENERICS, MALFORMED, LENIENT]) expect(list.length).toBeGreaterThan(0);
    expect(MALFORMED).toContain("empty.json");
  });
});

describe("decode: input/", () => {
  const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

  test.each(INPUTS)("%s: the envelope", async (path) => {
    const input = await fixture(path);
    const event = input.hook_event_name as string;
    const invocation = decode(input);
    expect(EVENTS).toContain(event);
    expect(invocation).toStrictEqual({
      envelopeVersion: 1,
      host: { kind: "claude-code", surface: "command-hook" },
      event: { nativeName: event },
      location: { processCwd: PROCESS_CWD, hostWorkingDirectory: input.cwd as string },
      identity: { hostSessionId: input.session_id as string },
      ...(TOOL_EVENTS.has(event) ? { tool: { name: input.tool_name as string, input: input.tool_input } } : {}),
      native: { input },
    });
    expect(invocation.native.input).toBe(input);
    expect(Object.isFrozen(invocation.native.input)).toBe(true);
  });

  test("the recorded loadguard Bash call: tool Bash with {command: pwd}", async () => {
    const invocation = decode(await fixture("input/pre-tool-use.bash.json"));
    expect(invocation.tool).toStrictEqual({ name: "Bash", input: { command: "pwd" } });
    expect(invocation.identity).toStrictEqual({ hostSessionId: "5181ef18-e570-4eb7-9469-cd109a82b317" });
    expect(invocation.location.hostWorkingDirectory).toStartWith("/tmp/claude-1000/");
  });

  test("an MCP tool in a subagent: the tool is the MCP tool, agent keys stay native", async () => {
    const invocation = decode(await fixture("input/pre-tool-use.mcp-subagent.json"));
    expect(invocation.tool).toStrictEqual({ name: "mcp__docs__search", input: { query: "hooks", limit: 5 } });
    expect(invocation.native.input.agent_id).toBe("a3f9c1d2e4b5");
    expect(invocation.native.input.mcp_server).toStrictEqual({ name: "docs", source: "plugin" });
    expect(invocation.identity).toStrictEqual({ hostSessionId: "6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f" });
  });

  test("PostToolUse: tool_response and duration_ms stay in native.input; a string response is accepted", async () => {
    const failed = decode(await fixture("input/post-tool-use.failed-string-response.json"));
    expect(typeof failed.native.input.tool_response).toBe("string");
    expect(failed.tool?.name).toBeDefined();
    const ran = decode(await fixture("input/post-tool-use.bash.json"));
    expect(typeof ran.native.input.duration_ms).toBe("number");
    expect(ran.tool).toStrictEqual({ name: "Bash", input: { command: "echo LOADGUARD_PROBE_B" } });
  });

  test("CwdChanged: old_cwd and new_cwd stay native, the working directory is cwd", async () => {
    const input = await fixture("input/cwd-changed.json");
    const invocation = decode(input);
    expect(invocation.native.input.old_cwd).toBe(input.old_cwd as string);
    expect(invocation.native.input.new_cwd).toBe(input.new_cwd as string);
    expect(invocation.location.hostWorkingDirectory).toBe(input.cwd as string);
    expect("tool" in invocation).toBe(false);
  });

  test("Windows paths are kept as sent", async () => {
    const input = await fixture("input/pre-tool-use.write.windows.json");
    const invocation = decode(input);
    expect(invocation.tool?.input).toBe(input.tool_input);
    expect(invocation.location.hostWorkingDirectory).toBe(input.cwd as string);
  });

  test("Claude Code has no turn id: hostTurnId is never set, prompt_id stays native", async () => {
    for (const path of [...INPUTS, ...PARTIALS]) {
      const input = await fixture(path);
      const invocation = decode(input);
      expect("hostTurnId" in invocation.identity).toBe(false);
    }
    const prompt = await fixture("input/user-prompt-submit.json");
    expect(typeof prompt.prompt_id).toBe("string");
    expect(decode(prompt).native.input.prompt_id).toBe(prompt.prompt_id as string);
    // even a turn_id key (not a Claude Code key) is not mapped
    const withTurn = { ...(await fixture(EVENT_FIXTURE.SessionStart as string)), turn_id: "t-1" };
    expect("hostTurnId" in decode(withTurn).identity).toBe(false);
  });

  test("key order does not matter: the same envelope for reversed keys", async () => {
    for (const path of INPUTS) {
      const input = await fixture(path);
      const reversed = Object.fromEntries(Object.entries(input).reverse());
      const { native: _a, ...rest } = decode(input);
      const { native: _b, ...restReversed } = decode(reversed);
      expect(restReversed).toStrictEqual(rest);
    }
  });

  test("unknown keys, also null ones, stay in native.input unchecked", async () => {
    for (const event of EVENTS) {
      const input = { ...(await eventInput(event)), future_key: null, another: { a: [1] } };
      const invocation = decode(input);
      expect(invocation.native.input.future_key).toBeNull();
      expect(invocation.native.input.another).toStrictEqual({ a: [1] });
    }
  });

  test("enum strings are not checked against a list, and an empty transcript_path is accepted", async () => {
    const input = await fixture("input/session-start.startup.json");
    input.source = "a-future-source";
    input.permission_mode = "somethingNew";
    input.transcript_path = "";
    const invocation = decode(input);
    expect(invocation.native.input.source).toBe("a-future-source");
  });

  test("tool_name and tool_input on an event without a tool are not mapped", async () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "CwdChanged"]) {
      const input = { ...(await eventInput(event)), tool_name: "Bash", tool_input: { command: "ls" } };
      expect("tool" in decode(input)).toBe(false);
    }
  });

  test("tool_input is any JSON value, null included, and is used as sent", async () => {
    for (const value of [null, 0, "text", [1, "a"], { nested: { list: [null] } }, false]) {
      for (const event of ["PreToolUse", "PostToolUse"]) {
        const input = { ...(await eventInput(event)), tool_input: value, tool_response: value };
        expect(decode(input).tool).toStrictEqual({ name: "Bash", input: value });
      }
    }
  });
});

describe("decode: partial/ keeps the missing keys missing", () => {
  test("session-start.event-only, pre-tool-use.event-only, cwd-changed.event-only: nothing but the event", async () => {
    for (const [path, event] of [
      ["partial/session-start.event-only.json", "SessionStart"],
      ["partial/pre-tool-use.event-only.json", "PreToolUse"],
      ["partial/cwd-changed.event-only.json", "CwdChanged"],
    ] as const) {
      const input = await fixture(path);
      expect(decode(input)).toStrictEqual({
        envelopeVersion: 1,
        host: { kind: "claude-code", surface: "command-hook" },
        event: { nativeName: event },
        location: { processCwd: PROCESS_CWD },
        identity: {},
        native: { input },
      });
    }
  });

  test("pre-tool-use.no-tool-input: the session and cwd are mapped, there is no tool", async () => {
    const input = await fixture("partial/pre-tool-use.no-tool-input.json");
    const invocation = decode(input);
    expect("tool" in invocation).toBe(false);
    expect(invocation.identity).toStrictEqual({ hostSessionId: input.session_id as string });
    expect(invocation.location.hostWorkingDirectory).toBe(input.cwd as string);
  });

  test("session-start.remote-call: the remote session id is the session id, an empty transcript path is fine", async () => {
    const invocation = decode(await fixture("partial/session-start.remote-call.json"));
    expect(invocation.identity).toStrictEqual({ hostSessionId: "served:unknown" });
    expect(invocation.native.input.transcript_path).toBe("");
  });

  test("without tool_name there is no tool either", async () => {
    const input = await fixture("input/pre-tool-use.bash.json");
    delete input.tool_name;
    expect("tool" in decode(input)).toBe(false);
  });
});

describe("decode: generic/ and unknown events", () => {
  test.each(GENERICS)("%s: decoded generically, session and cwd only", async (path) => {
    const input = await fixture(path);
    const invocation = decode(input);
    expect(invocation).toStrictEqual({
      envelopeVersion: 1,
      host: { kind: "claude-code", surface: "command-hook" },
      event: { nativeName: input.hook_event_name as string },
      location: { processCwd: PROCESS_CWD, hostWorkingDirectory: input.cwd as string },
      identity: { hostSessionId: input.session_id as string },
      native: { input },
    });
    expect("tool" in invocation).toBe(false);
  });

  test("keys of a generic event are not type-checked", async () => {
    const input = await fixture("generic/pre-compact.json");
    expect(decode(input).native.input.custom_instructions).toBeNull();
    for (const value of [1, [], {}, null, true]) {
      const odd = { hook_event_name: "Stop", prompt: value, tool_name: value, transcript_path: value, source: value };
      expect(decode(odd).event.nativeName).toBe("Stop");
    }
  });

  test("a non-string session_id or cwd of a generic event is left out, not rejected", () => {
    const invocation = decode({ hook_event_name: "Notification", session_id: 5, cwd: null });
    expect(invocation.location).toStrictEqual({ processCwd: PROCESS_CWD });
    expect(invocation.identity).toStrictEqual({});
  });

  test.each(["", "sessionstart", "SessionEnd", "SubagentStart", "SubagentStop", "Notification", "PermissionRequest"])(
    "event %p is decoded generically",
    (event) => {
      expect(decode({ hook_event_name: event }).event.nativeName).toBe(event);
    },
  );

  test("the event name is matched exactly: a case variant of a known event is generic, no tool", async () => {
    const input = { ...(await fixture("input/pre-tool-use.bash.json")), hook_event_name: "pretooluse", tool_name: 5 };
    expect("tool" in decode(input)).toBe(false);
  });

  test("Object.prototype names are not events with rules", () => {
    for (const event of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(decode({ hook_event_name: event, session_id: "s" }).identity).toStrictEqual({ hostSessionId: "s" });
      expect(encode([{ kind: "no-decision" }], { hook_event_name: event })).toBe("");
      unsupported(() => encode([notifyUser()], { hook_event_name: event }));
    }
  });
});

describe("decode: malformed/", () => {
  const DECODER = MALFORMED.filter((name) => !READER_ONLY.has(name));
  // Only keys the decoder lifts into the envelope can be rejected (ADR 0009).
  const KEY_OF: Record<string, string> = {
    "missing-hook-event-name.json": "hook_event_name",
    "hook-event-name-number.json": "hook_event_name",
    "session-start.session-id-number.json": "session_id",
    "session-start.session-id-null.json": "session_id",
    "pre-tool-use.tool-name-number.json": "tool_name",
    "post-tool-use.tool-name-null.json": "tool_name",
  };

  test("the table names every decoder-rejected fixture", () => {
    expect([...DECODER].sort()).toEqual(Object.keys(KEY_OF).sort());
  });

  test.each(Object.entries(KEY_OF))("%s: HOOK_INPUT_INVALID naming %s", async (name, key) => {
    const error = expectError(() => decode(fixtureSyncMalformed(name)), "HOOK_INPUT_INVALID", "decode");
    expect(error.message).toContain(key);
  });

  test("the array is not an object for the decoder either", async () => {
    const parsed = await fixture("malformed/not-an-object.json");
    expect(Array.isArray(parsed)).toBe(true);
    expectError(() => decode(parsed), "HOOK_INPUT_INVALID", "decode");
  });

  // The lifted keys: a wrong type or null is invalid, for the events with rules.
  const WRONG: Record<string, unknown[]> = {
    string: [1, true, null, [], {}],
  };
  const LIFTED: Record<string, string[]> = {
    SessionStart: ["session_id", "cwd"],
    UserPromptSubmit: ["session_id", "cwd"],
    PreToolUse: ["session_id", "cwd", "tool_name"],
    PostToolUse: ["session_id", "cwd", "tool_name"],
    CwdChanged: ["session_id", "cwd"],
  };
  const cases = EVENTS.flatMap((event) => (LIFTED[event] as string[]).map((key) => [event, key] as const));

  test.each(cases)("%s: a value of the wrong type for the lifted key %s is HOOK_INPUT_INVALID, null included", async (event, key) => {
    for (const value of WRONG.string as unknown[]) {
      const input = { ...(await eventInput(event)), [key]: value };
      const error = expectError(() => decode(input), "HOOK_INPUT_INVALID", "decode");
      expect(error.message).toContain(key);
      expect(error.message).toContain(event);
    }
  });

  test("a string is accepted for each lifted key (the control of the table above)", async () => {
    for (const [event, key] of cases) {
      const input = { ...(await eventInput(event)), [key]: "s" };
      expect(decode(input).event.nativeName).toBe(event);
    }
  });

  test("a wrong type of another event's key is not checked: it is unknown for this one", async () => {
    const session = { ...(await eventInput("SessionStart")), prompt: 7, tool_name: 7, duration_ms: "x", new_cwd: null };
    expect(decode(session).event.nativeName).toBe("SessionStart");
    const cwd = { ...(await eventInput("CwdChanged")), source: 7, model: null };
    expect(decode(cwd).event.nativeName).toBe("CwdChanged");
  });

  test("tool_input and tool_response of any type are not rejected", async () => {
    const input = { ...(await eventInput("PostToolUse")), tool_input: null, tool_response: [null] };
    expect(decode(input).event.nativeName).toBe("PostToolUse");
  });

  test("hook_event_name must be a string", () => {
    for (const value of [undefined, null, 7, true, ["Stop"], {}]) {
      expectError(() => decode({ hook_event_name: value }), "HOOK_INPUT_INVALID", "decode");
    }
    expectError(() => decode({}), "HOOK_INPUT_INVALID", "decode");
  });
});

describe("decode: lenient/ and unchecked keys (ADR 0009: decoders check only what they lift)", () => {
  const KEY_OF: Record<string, string> = {
    "session-start.model-null.json": "model",
    "session-start.context-tokens-string.json": "context_tokens",
    "user-prompt-submit.prompt-number.json": "prompt",
    "user-prompt-submit.effort-array.json": "effort",
    "pre-tool-use.mcp-server-string.json": "mcp_server",
    "post-tool-use.duration-ms-string.json": "duration_ms",
    "cwd-changed.new-cwd-null.json": "new_cwd",
  };

  test("the table names every lenient fixture", () => {
    expect([...LENIENT].sort()).toEqual(Object.keys(KEY_OF).sort());
  });

  test.each(Object.entries(KEY_OF))("%s: decodes, the envelope as without %s, the value kept unchanged in native.input", async (name, key) => {
    const input = await fixture(`lenient/${name}`);
    const invocation = decode(input);
    const { [key]: _wrong, ...without } = input;
    const { native: _n, ...envelope } = invocation;
    const { native: _m, ...envelopeWithout } = decode(without);
    expect(envelope).toStrictEqual(envelopeWithout);
    expect(envelope.event.nativeName).toBe(input.hook_event_name as string);
    expect(envelope.identity).toStrictEqual({ hostSessionId: input.session_id as string });
    expect(invocation.native.input).toStrictEqual(input);
    expect(invocation.native.input[key]).toStrictEqual(input[key]);
    if (input.tool_name !== undefined) expect(invocation.tool).toStrictEqual({ name: "Bash", input: input.tool_input });
  });

  // One representative unchecked key per event; the value types are the ones the old table rejected.
  const UNCHECKED: Record<string, string[]> = {
    SessionStart: ["transcript_path", "model", "source", "permission_mode"],
    UserPromptSubmit: ["prompt", "effort", "agent_id", "transcript_path"],
    PreToolUse: ["tool_use_id", "mcp_server", "permission_mode", "transcript_path"],
    PostToolUse: ["tool_use_id", "duration_ms", "mcp_server", "transcript_path"],
    CwdChanged: ["old_cwd", "new_cwd", "prompt_id", "scratchpad_dir"],
  };
  const unchecked = EVENTS.flatMap((event) => (UNCHECKED[event] as string[]).map((key) => [event, key] as const));
  const ODD = [1, true, null, [], { a: [null] }, "x"];

  test.each(unchecked)("%s: any value for the unchecked key %s is accepted and kept unchanged in native.input", async (event, key) => {
    const base = await eventInput(event);
    const { native: _b, ...baseEnvelope } = decode(base);
    for (const value of ODD) {
      const input = { ...base, [key]: value };
      const invocation = decode(input);
      const { native: _n, ...envelope } = invocation;
      expect(envelope).toStrictEqual(baseEnvelope);
      expect(invocation.native.input[key]).toStrictEqual(value);
    }
  });
});

// A synchronous read of a malformed fixture for the table above.
function fixtureSyncMalformed(name: string): Input {
  return JSON.parse(readFileSync(join(FIXTURES, "malformed", name), "utf8")) as Input;
}

// main() in process with the real codec: what a plugin's entry sees.
async function runMain(stdin: Uint8Array<ArrayBuffer>, handler: () => HookEffect | HookEffect[], onFailure?: "closed") {
  const stdout: Uint8Array[] = [];
  const stderr: string[] = [];
  const code = await main({
    codec: claudeCode,
    handler,
    stdin: new Blob([stdin]).stream(),
    stdout: (bytes) => {
      stdout.push(bytes.slice());
    },
    stderr: (text) => {
      stderr.push(text);
    },
    env: {},
    cwd: PROCESS_CWD,
    ...(onFailure === undefined ? {} : { onFailure }),
  });
  return { code, stdout, stderr };
}

interface Row {
  event: string | string[];
  effects: HookEffect[];
}

const rows = (await fixture("output/effects.json")) as unknown as Record<string, Row>;

describe("encode: every row of output/effects.json, byte for byte through main()", () => {
  const outFiles = readdirSync(join(FIXTURES, "output")).filter((name) => name.endsWith(".out")).sort();

  test("effects.json names every .out file and only those", () => {
    expect(Object.keys(rows).sort()).toEqual(outFiles);
    expect(outFiles.length).toBeGreaterThan(0);
  });

  const cases = Object.entries(rows).flatMap(([out, { event, effects }]) => {
    const events = event === "*" ? [...EVENTS, "Stop", "PreCompact"] : Array.isArray(event) ? event : [event];
    return events.map((name) => [out, name, effects] as const);
  });

  test.each(cases)("%s on %s: exit 0 and the .out bytes", async (out, event, effects) => {
    const path = EVENT_FIXTURE[event] ?? (event === "Stop" ? "generic/stop.json" : "generic/pre-compact.json");
    const want = await fixtureBytes(`output/${out}`);
    const result = await runMain(await fixtureBytes(path), () => effects);
    expect(result).toEqual({ code: 0, stdout: want.length === 0 ? [] : [want], stderr: [] });
  });

  test.each(cases.filter(([, , effects]) => effects.length > 1))(
    "%s on %s: the reversed list gives the same bytes",
    async (out, event, effects) => {
      const want = await fixtureBytes(`output/${out}`);
      const result = await runMain(await fixtureBytes(EVENT_FIXTURE[event] as string), () => [...effects].reverse());
      expect(result).toEqual({ code: 0, stdout: [want], stderr: [] });
    },
  );

  test("a single effect given as a list of one gives the same bytes as the bare effect", async () => {
    const { effects } = rows["pre-tool-use.deny.out"] as Row;
    const bare = await runMain(await fixtureBytes(EVENT_FIXTURE.PreToolUse as string), () => effects[0] as HookEffect);
    const listed = await runMain(await fixtureBytes(EVENT_FIXTURE.PreToolUse as string), () => effects);
    expect(bare).toEqual(listed);
    expect(bare.stdout).toEqual([await fixtureBytes("output/pre-tool-use.deny.out")]);
  });

  test("every non-empty output is one JSON object ending in exactly one LF", async () => {
    for (const out of outFiles) {
      const bytes = await fixtureBytes(`output/${out}`);
      if (bytes.length === 0) continue;
      const text = new TextDecoder().decode(bytes);
      expect(text.endsWith("}\n")).toBe(true);
      expect(text.indexOf("\n")).toBe(text.length - 1);
      expect(typeof JSON.parse(text)).toBe("object");
    }
  });
});

describe("encode: the fixed key order, whatever the order of the list", () => {
  const rewrite = toolInput({ z: 1, a: { y: 2, b: [3] } });
  const ask = permission("ask", "check this");
  const note = notifyUser("hello");

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
    );
  }

  test("notify-user, ask with a reason and tool-input: every one of the six orders gives the same line", async () => {
    const input = await fixture(EVENT_FIXTURE.PreToolUse as string);
    const want =
      '{"systemMessage":"hello","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"check this","updatedInput":{"z":1,"a":{"y":2,"b":[3]}}}}\n';
    const orders = permutations([note, ask, rewrite]);
    expect(orders).toHaveLength(6);
    for (const order of orders) expect(encode(order, input)).toBe(want);
    const parsed = JSON.parse(want);
    expect(Object.keys(parsed)).toEqual(["systemMessage", "hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput)).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason", "updatedInput"]);
  });

  test("the updatedInput keeps the order of the keys it was given", async () => {
    const out = encode([rewrite], await fixture(EVENT_FIXTURE.PreToolUse as string));
    expect(out.indexOf('"z"')).toBeLessThan(out.indexOf('"a"'));
    expect(Object.keys(JSON.parse(out).hookSpecificOutput.updatedInput)).toEqual(["z", "a"]);
  });

  test("add-context with notify-user on each placement: systemMessage first, then hookSpecificOutput, either order", async () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
      const placement = OWN_PLACEMENT[event] as Placement;
      const want = `${JSON.stringify({ systemMessage: "hello", hookSpecificOutput: { hookEventName: event, additionalContext: "ctx" } })}\n`;
      const input = await eventInput(event);
      expect(encode([note, addContext(placement)], input)).toBe(want);
      expect(encode([addContext(placement), note], input)).toBe(want);
    }
  });

  test("tool-permission and tool-input: permissionDecision, reason, updatedInput, in that order, either order of the list", async () => {
    const input = await fixture(EVENT_FIXTURE.PreToolUse as string);
    const allow = permission("allow", "ok");
    const want = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"ok","updatedInput":{"command":"ls"}}}\n';
    expect(encode([allow, toolInput({ command: "ls" })], input)).toBe(want);
    expect(encode([toolInput({ command: "ls" }), allow], input)).toBe(want);
  });

  test("allow without a reason and ask without one: no permissionDecisionReason key", async () => {
    const input = await fixture(EVENT_FIXTURE.PreToolUse as string);
    for (const decision of ["allow", "ask"] as const) {
      const parsed = JSON.parse(encode([permission(decision)], input));
      expect(parsed).toStrictEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } });
      const rewritten = JSON.parse(encode([permission(decision), toolInput({ command: "ls" })], input));
      expect("permissionDecisionReason" in rewritten.hookSpecificOutput).toBe(false);
      expect(rewritten.hookSpecificOutput.permissionDecision).toBe(decision);
    }
  });
});

describe("encode: tool-input without a decision, and with one", () => {
  test("alone it carries no permissionDecision: it rewrites and grants nothing", async () => {
    const out = JSON.parse(encode([toolInput({ command: "echo LOADGUARD_PROBE_B" })], await fixture(EVENT_FIXTURE.PreToolUse as string)));
    expect(out).toStrictEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "echo LOADGUARD_PROBE_B" } } });
    expect("permissionDecision" in out.hookSpecificOutput).toBe(false);
  });

  test("any JSON object is delivered for any tool: no per-tool shape rule", async () => {
    const input = await fixture(EVENT_FIXTURE.PreToolUse as string);
    const rewrite = { command: "ls", timeout: 5, description: "x", nested: { list: [null, 1] } };
    expect(JSON.parse(encode([toolInput(rewrite)], input)).hookSpecificOutput.updatedInput).toStrictEqual(rewrite);
    expect(JSON.parse(encode([toolInput({})], input)).hookSpecificOutput.updatedInput).toStrictEqual({});
    const mcp = await fixture("input/pre-tool-use.mcp-subagent.json");
    expect(JSON.parse(encode([toolInput({ query: "other" })], mcp)).hookSpecificOutput.updatedInput).toStrictEqual({ query: "other" });
  });

  test("it does not need a tool in the invocation", () => {
    for (const input of [{ hook_event_name: "PreToolUse" }]) {
      expect(JSON.parse(encode([toolInput({ a: 1 })], input)).hookSpecificOutput.updatedInput).toStrictEqual({ a: 1 });
    }
  });

  test("deny with tool-input is unsupported, in either order, with or without notify-user", async () => {
    const input = await fixture(EVENT_FIXTURE.PreToolUse as string);
    const rewrite = toolInput({ command: "ls" });
    const deny = permission("deny", "no");
    for (const list of [[deny, rewrite], [rewrite, deny], [notifyUser(), deny, rewrite], [rewrite, notifyUser(), deny]]) {
      const error = unsupported(() => encode(list, input));
      expect(error.message).toContain("deny");
    }
  });

  test("deny alone is delivered with its reason", async () => {
    const out = JSON.parse(encode([permission("deny", "no way")], await fixture(EVENT_FIXTURE.PreToolUse as string)));
    expect(out).toStrictEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no way" } });
  });
});

describe("encode: what an event cannot deliver is HOOK_EFFECT_UNSUPPORTED", () => {
  test("add-context at a placement other than the event's own", async () => {
    for (const event of EVENTS) {
      const own = OWN_PLACEMENT[event];
      for (const placement of PLACEMENTS.filter((p) => p !== own)) {
        const error = unsupported(() => encode([addContext(placement)], fixtureOf(event)));
        expect(error.message).toContain(event);
      }
    }
  });

  test("add-context on PreToolUse and CwdChanged at any placement", () => {
    for (const event of ["PreToolUse", "CwdChanged"]) {
      for (const placement of PLACEMENTS) unsupported(() => encode([addContext(placement)], fixtureOf(event)));
    }
  });

  test("tool-permission and tool-input on every event but PreToolUse", () => {
    for (const event of EVENTS.filter((name) => name !== "PreToolUse")) {
      for (const decision of ["allow", "deny", "ask"] as const) {
        unsupported(() => encode([permission(decision, "x")], fixtureOf(event)));
      }
      unsupported(() => encode([toolInput({ command: "ls" })], fixtureOf(event)));
    }
  });

  test("one effect the event cannot deliver rejects the whole list", () => {
    unsupported(() => encode([notifyUser(), addContext("prompt-input")], fixtureOf("PreToolUse")));
    unsupported(() => encode([notifyUser(), addContext("session-start-input")], fixtureOf("CwdChanged")));
    unsupported(() => encode([addContext("session-start-input"), permission("allow")], fixtureOf("SessionStart")));
    unsupported(() => encode([notifyUser(), toolInput({})], fixtureOf("PostToolUse")));
  });

  test("CwdChanged: no-decision is empty, notify-user alone is delivered, nothing else", async () => {
    const input = await fixture(EVENT_FIXTURE.CwdChanged as string);
    expect(encode([{ kind: "no-decision" }], input)).toBe("");
    expect(encode([notifyUser("moved")], input)).toBe('{"systemMessage":"moved"}\n');
    unsupported(() => encode([addContext("session-start-input")], input));
  });

  test("on an event without rules: only no-decision, every other effect or list is unsupported", async () => {
    for (const path of GENERICS) {
      const input = await fixture(path);
      const event = input.hook_event_name as string;
      expect(encode([{ kind: "no-decision" }], input)).toBe("");
      for (const list of [
        [notifyUser()],
        [addContext("session-start-input")],
        [addContext("prompt-input")],
        [permission("deny", "x")],
        [toolInput({})],
        [notifyUser(), addContext("tool-result")],
      ]) {
        const error = unsupported(() => encode(list, input));
        expect(error.message).toContain(event);
      }
    }
  });

  test("an effect kind outside the vocabulary", () => {
    unsupported(() => encode([{ kind: "block-everything" } as unknown as HookEffect], fixtureOf("SessionStart")));
  });
});

function fixtureOf(event: string): Input {
  return JSON.parse(readFileSync(join(FIXTURES, EVENT_FIXTURE[event] as string), "utf8")) as Input;
}

describe("encode: unpaired surrogates are delivered, not rejected (unlike Codex)", () => {
  // JSON.stringify writes a lone surrogate as a \u escape, which Claude Code's JSON.parse
  // accepts (src/claude-code.ts; what later stages do with it is not checked).
  const LONE = ["\uD800", "a\uDC00b", "\uDE80\uD83D", "x\uD83D"];

  test("in add-context text, at each placement", () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
      for (const text of LONE) {
        const out = encode([addContext(OWN_PLACEMENT[event] as Placement, text)], fixtureOf(event));
        expect(out).toContain("\\ud");
        expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe(text);
      }
    }
  });

  test("in the notify-user text, the deny reason and the updatedInput keys and strings", () => {
    for (const text of LONE) {
      expect(JSON.parse(encode([notifyUser(text)], fixtureOf("PreToolUse"))).systemMessage).toBe(text);
      const denied = JSON.parse(encode([permission("deny", text)], fixtureOf("PreToolUse")));
      expect(denied.hookSpecificOutput.permissionDecisionReason).toBe(text);
      const rewritten = JSON.parse(encode([toolInput({ [`k${text}`]: [text, { deep: text }] })], fixtureOf("PreToolUse")));
      expect(rewritten.hookSpecificOutput.updatedInput).toStrictEqual({ [`k${text}`]: [text, { deep: text }] });
    }
  });

  test("the fixture row for the escape is the bytes the codec writes", async () => {
    const want = new TextDecoder().decode(await fixtureBytes("output/post-tool-use.add-context.lone-surrogate.out"));
    expect(want).toContain("\\ud800");
    expect(encode([addContext("tool-result", "lone \ud800 surrogate")], fixtureOf("PostToolUse"))).toBe(want);
  });
});

describe("main() with the Claude Code codec: failures", () => {
  const sessionBytes = () => fixtureBytes(EVENT_FIXTURE.SessionStart as string);

  test.each(MALFORMED)("malformed/%s: exit 1, HOOK_INPUT_INVALID, no stdout, one line, the handler never runs", async (name) => {
    let called = false;
    const result = await runMain(await fixtureBytes(`malformed/${name}`), () => {
      called = true;
      return { kind: "no-decision" };
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toMatch(/^agent-bun-runtime: HOOK_INPUT_INVALID: [^\r\n]*\n$/);
    expect(called).toBe(false);
  });

  test.each(MALFORMED)("malformed/%s with onFailure closed: exit 2, the same line", async (name) => {
    const open = await runMain(await fixtureBytes(`malformed/${name}`), () => ({ kind: "no-decision" }));
    const closed = await runMain(await fixtureBytes(`malformed/${name}`), () => ({ kind: "no-decision" }), "closed");
    expect(closed).toEqual({ ...open, code: 2 });
  });

  test("an unsupported effect: exit 1 and nothing on stdout; closed: exit 2, the same line", async () => {
    const handler = () => addContext("session-start-input");
    const open = await runMain(await fixtureBytes(EVENT_FIXTURE.PreToolUse as string), handler);
    expect(open.code).toBe(1);
    expect(open.stdout).toEqual([]);
    expect(open.stderr).toHaveLength(1);
    expect(open.stderr[0]).toStartWith("agent-bun-runtime: HOOK_EFFECT_UNSUPPORTED: ");
    const closed = await runMain(await fixtureBytes(EVENT_FIXTURE.PreToolUse as string), handler, "closed");
    expect(closed).toEqual({ ...open, code: 2 });
  });

  test("deny with tool-input through main: HOOK_EFFECT_UNSUPPORTED", async () => {
    const result = await runMain(await fixtureBytes(EVENT_FIXTURE.PreToolUse as string), () => [permission("deny", "no"), toolInput({})]);
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toStartWith("agent-bun-runtime: HOOK_EFFECT_UNSUPPORTED: ");
  });

  test("core errors come before the codec: HOOK_EFFECT_INVALID", async () => {
    for (const handler of [
      () => permission("deny"),
      () => [],
      () => [notifyUser(), notifyUser("again")],
      () => [{ kind: "no-decision" }, notifyUser()],
      () => toolInput({ a: undefined as unknown as string }),
    ] as Array<() => HookEffect | HookEffect[]>) {
      const result = await runMain(await sessionBytes(), handler);
      expect(result.code).toBe(1);
      expect(result.stdout).toEqual([]);
      expect(result.stderr[0]).toStartWith("agent-bun-runtime: HOOK_EFFECT_INVALID: ");
    }
  });
});

// The entry as a real Bun process on pipes: stdin gets the fixture bytes and stays open until
// the entry has exited, as the host keeps it.
let home = "";
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "abr-claude-code-test-"));
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const EXIT_BOUND_MS = 10_000;
async function runEntry(stdin: Uint8Array<ArrayBuffer>, env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, GETTY_HOME: home, ...env },
  });
  const stdout = new Response(proc.stdout).bytes();
  const stderr = new Response(proc.stderr).text();
  try {
    if (stdin.length > 0) proc.stdin.write(stdin);
    await proc.stdin.flush();
  } catch {
    // the entry may end before it has read everything; judged by the result
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), EXIT_BOUND_MS);
  });
  const exited = await Promise.race([proc.exited, bound]);
  clearTimeout(timer);
  if (exited === "timeout") {
    proc.kill();
    await proc.exited;
  }
  try {
    proc.stdin.end();
  } catch {
    // the entry has ended; its stdin may already be gone
  }
  if (exited === "timeout") throw new Error(`entry did not exit within ${EXIT_BOUND_MS} ms (stdin open)`);
  return { code: exited, stdout: await stdout, stderr: await stderr };
}

describe("end to end: an entry on main({ codec: claudeCode, handler }) through a pipe, stdin left open", () => {
  const e2e: Array<[string, string]> = [
    ["session-start.add-context.notify-user.out", "input/session-start.startup.json"],
    ["pre-tool-use.allow.tool-input.out", "input/pre-tool-use.bash.json"],
    ["pre-tool-use.deny.out", "input/pre-tool-use.mcp-subagent.json"],
    ["post-tool-use.add-context.out", "input/post-tool-use.bash.json"],
    ["no-decision.out", "input/cwd-changed.json"],
  ];

  test.each(e2e)("%s on %s: exit 0, stdout is the .out file", async (out, path) => {
    const row = rows[out] as Row;
    const result = await runEntry(await fixtureBytes(path), { ABR_TEST_EFFECTS: JSON.stringify(row.effects) });
    expect(result).toEqual({ code: 0, stdout: await fixtureBytes(`output/${out}`), stderr: "" });
  }, 20_000);

  test("a malformed input: exit 1; with onFailure closed exit 2; no stdout, one line", async () => {
    const bytes = await fixtureBytes("malformed/session-start.session-id-null.json");
    const env = { ABR_TEST_EFFECTS: JSON.stringify({ kind: "no-decision" }) };
    const open = await runEntry(bytes, env);
    const closed = await runEntry(bytes, { ...env, ABR_TEST_ON_FAILURE: "closed" });
    expect(open.code).toBe(1);
    expect(open.stdout).toEqual(new Uint8Array(0));
    expect(open.stderr).toMatch(/^agent-bun-runtime: HOOK_INPUT_INVALID: [^\r\n]*\n$/);
    expect(closed).toEqual({ ...open, code: 2 });
  }, 30_000);

  test("deny with tool-input: exit 2 under closed, nothing on stdout", async () => {
    const effects = [permission("deny", "no"), toolInput({ command: "ls" })];
    const result = await runEntry(await fixtureBytes("input/pre-tool-use.bash.json"), {
      ABR_TEST_EFFECTS: JSON.stringify(effects),
      ABR_TEST_ON_FAILURE: "closed",
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual(new Uint8Array(0));
    expect(result.stderr).toStartWith("agent-bun-runtime: HOOK_EFFECT_UNSUPPORTED: ");
  }, 20_000);
});
