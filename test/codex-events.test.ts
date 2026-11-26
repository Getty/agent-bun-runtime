// The Codex codec's events beyond SessionStart and SubagentStart (cards k30, k26):
// UserPromptSubmit, PreToolUse and PostToolUse decode, the effects add-context at
// prompt-input and tool-result, tool-permission deny, tool-input, notify-user and lists of
// effects encode to the exact .out bytes of test/fixtures/codex/output/. Rules are
// source-checked against openai/codex 3f65e9f (see the fixtures README); no Codex runs here,
// so this proves the codec, not the host.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codex } from "../src/codex.js";
import { codecImplementation } from "../src/codec.js";
import { AgentRuntimeError, main, type HookEffect, type HookInvocation } from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures", "codex");
const PROCESS_CWD = "/consumer";
const textEncoder = new TextEncoder();

type Input = Record<string, unknown>;

const fixture = async (path: string): Promise<Input> => (await Bun.file(join(FIXTURES, path)).json()) as Input;
const fixtureBytes = async (path: string) => await Bun.file(join(FIXTURES, path)).bytes();
// Small fixtures: a synchronous read keeps the table tests readable; a fresh copy each time.
const fixtureSync = (path: string): Input => JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as Input;
const string = async (path: string) => (await Bun.file(join(FIXTURES, path)).json()) as string;

const CONTEXT = await string("output/context.json");
const NOTIFY = await string("output/notify-user.json");
const REASON = await string("output/pre-tool-use.deny-reason.json");
const BASH_INPUT = (await fixture("output/pre-tool-use.bash.updated-input.json")) as { command: string };

const implementation = codecImplementation(codex);
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

const addContext = (placement: Extract<HookEffect, { kind: "add-context" }>["placement"], text = CONTEXT): HookEffect => ({
  kind: "add-context",
  text,
  audience: "model",
  placement,
});
const notifyUser = (text = NOTIFY): HookEffect => ({ kind: "notify-user", text });
const deny = (reason: string): HookEffect => ({ kind: "tool-permission", decision: "deny", reason });
const toolInput = (input: Record<string, unknown>): HookEffect => ({ kind: "tool-input", input });

const UPS = "input/user-prompt-submit.json";
const PRE_BASH = "input/pre-tool-use.bash.json";
const PRE_PATCH = "input/pre-tool-use.apply-patch.json";
const POST_BASH = "input/post-tool-use.bash.json";
const SESSION = "input/session-start.startup.json";
const SUBAGENT = "input/subagent-start.json";

describe("decode: UserPromptSubmit, PreToolUse, PostToolUse", () => {
  test(`${UPS}: envelope with the turn id and no tool`, async () => {
    const input = await fixture(UPS);
    const invocation = decode(input);
    expect(invocation).toStrictEqual({
      envelopeVersion: 1,
      host: { kind: "codex", surface: "command-hook" },
      event: { nativeName: "UserPromptSubmit" },
      location: { processCwd: PROCESS_CWD, hostWorkingDirectory: input.cwd as string },
      identity: { hostSessionId: input.session_id as string, hostTurnId: input.turn_id as string },
      native: { input },
    });
    expect("tool" in invocation).toBe(false);
  });

  test.each([
    [PRE_BASH, "PreToolUse", "Bash"],
    [PRE_PATCH, "PreToolUse", "apply_patch"],
    [POST_BASH, "PostToolUse", "Bash"],
  ] as const)("%s: %s envelope with tool %s", async (path, event, name) => {
    const input = await fixture(path);
    const invocation = decode(input);
    expect(invocation).toStrictEqual({
      envelopeVersion: 1,
      host: { kind: "codex", surface: "command-hook" },
      event: { nativeName: event },
      location: { processCwd: PROCESS_CWD, hostWorkingDirectory: input.cwd as string },
      identity: { hostSessionId: input.session_id as string, hostTurnId: input.turn_id as string },
      tool: { name: name, input: input.tool_input },
      native: { input },
    });
    expect(invocation.tool?.input).toBe(input.tool_input);
    expect(Object.isFrozen(invocation.tool)).toBe(true);
    expect(Object.isFrozen(invocation.tool?.input)).toBe(true);
  });

  test("the tool is Codex's canonical name, taken as sent", async () => {
    const input = await fixture(PRE_BASH);
    input.tool_name = "mcp__server__lookup";
    input.tool_input = { query: "x", limit: 3 };
    expect(decode(input).tool).toStrictEqual({ name: "mcp__server__lookup", input: { query: "x", limit: 3 } });
  });

  test("tool_input and tool_response are any JSON value", async () => {
    for (const value of [null, 0, "text", [1, "a"], { nested: { list: [null] } }, true]) {
      const pre = await fixture(PRE_BASH);
      pre.tool_input = value;
      expect(decode(pre).tool).toStrictEqual({ name: "Bash", input: value });
      const post = await fixture(POST_BASH);
      post.tool_input = value;
      post.tool_response = value;
      expect(decode(post).tool?.input).toStrictEqual(value);
    }
  });

  test("without tool_name or without tool_input there is no tool", async () => {
    for (const path of [PRE_BASH, POST_BASH]) {
      const noName = await fixture(path);
      delete noName.tool_name;
      const noInput = await fixture(path);
      delete noInput.tool_input;
      const neither = await fixture(path);
      delete neither.tool_name;
      delete neither.tool_input;
      for (const input of [noName, noInput, neither]) {
        const invocation = decode(input);
        expect("tool" in invocation).toBe(false);
        expect(invocation.tool).toBeUndefined();
      }
    }
  });

  test("only the event name is required: partial PreToolUse, PostToolUse and UserPromptSubmit decode", () => {
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      const invocation = decode({ hook_event_name: event });
      expect(invocation).toStrictEqual({
        envelopeVersion: 1,
        host: { kind: "codex", surface: "command-hook" },
        event: { nativeName: event },
        location: { processCwd: PROCESS_CWD },
        identity: {},
        native: { input: { hook_event_name: event } },
      });
    }
  });

  test("tool_name on an event that has no tool is kept in native.input, not mapped", async () => {
    const prompt = await fixture(UPS);
    prompt.tool_name = "Bash";
    prompt.tool_input = { command: "ls" };
    expect("tool" in decode(prompt)).toBe(false);
    const session = await fixture(SESSION);
    session.tool_name = "Bash";
    session.tool_input = {};
    expect("tool" in decode(session)).toBe(false);
  });

  test("turn_id is the turn id on all three events and on SessionStart it is not mapped", async () => {
    for (const path of [UPS, PRE_BASH, POST_BASH]) {
      const input = await fixture(path);
      expect(decode(input).identity.hostTurnId).toBe(input.turn_id as string);
    }
    const session = await fixture(SESSION);
    session.turn_id = "t-9";
    expect("hostTurnId" in decode(session).identity).toBe(false);
  });

  const WRONG: unknown[] = [1, true, null, [], {}];
  // Lifted into the envelope, so type-checked (ADR 0009): null is invalid too.
  const LIFTED: Array<[string, string[]]> = [
    [UPS, ["session_id", "turn_id", "cwd"]],
    [PRE_BASH, ["session_id", "turn_id", "cwd", "tool_name"]],
    [POST_BASH, ["session_id", "turn_id", "cwd", "tool_name"]],
  ];
  const lifted = LIFTED.flatMap(([path, keys]) => keys.map((key) => [path, key] as const));
  // Everything else stays unchecked in native.input.
  const UNCHECKED: Array<[string, string[]]> = [
    [UPS, ["agent_id", "agent_type", "model", "permission_mode", "prompt", "transcript_path"]],
    [PRE_BASH, ["model", "permission_mode", "tool_use_id", "transcript_path"]],
    [POST_BASH, ["model", "permission_mode", "tool_use_id", "tool_response", "transcript_path"]],
  ];
  const unchecked = UNCHECKED.flatMap(([path, keys]) => keys.map((key) => [path, key] as const));

  test.each(lifted)("%s: a wrong type for the lifted key %s, null included, is HOOK_INPUT_INVALID naming the key", async (path, key) => {
    for (const value of WRONG) {
      const input = await fixture(path);
      input[key] = value;
      const error = expectError(() => decode(input), "HOOK_INPUT_INVALID", "decode");
      expect(error.message).toContain(key);
    }
  });

  test.each(unchecked)("%s: any value for the unchecked key %s is accepted and kept unchanged in native.input", async (path, key) => {
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

  test("tolerated/pre-tool-use.tool-use-id-number.json decodes like pre-tool-use.bash.json, the value kept", async () => {
    const odd = await fixture("tolerated/pre-tool-use.tool-use-id-number.json");
    const invocation = decode(odd);
    expect(invocation.native.input).toStrictEqual(odd);
    expect(invocation.native.input.tool_use_id).toBe(7);
    expect(invocation.tool).toStrictEqual(decode(await fixture(PRE_BASH)).tool);
    expect(invocation.identity).toStrictEqual({ hostSessionId: odd.session_id as string, hostTurnId: odd.turn_id as string });
  });

  test("the malformed fixture: tool_name 7 is HOOK_INPUT_INVALID", async () => {
    const bad = await fixture("malformed/pre-tool-use.tool-name-number.json");
    expect(expectError(() => decode(bad), "HOOK_INPUT_INVALID", "decode").message).toContain("tool_name");
  });

  test("a PostToolUse key on PreToolUse is unknown: kept, unchecked", async () => {
    const input = await fixture(PRE_BASH);
    input.tool_response = 5;
    input.prompt = ["x"];
    expect(decode(input).native.input.tool_response).toBe(5);
  });
});

describe("encode: no-decision on the new events", () => {
  test.each([UPS, PRE_BASH, PRE_PATCH, POST_BASH])("%s: empty", async (path) => {
    expect(encode([{ kind: "no-decision" }], await fixture(path))).toBe("");
    expect(await fixtureBytes("output/no-decision.out")).toEqual(new Uint8Array(0));
  });
});

describe("encode: add-context at prompt-input and tool-result", () => {
  test.each([
    [UPS, "prompt-input", "output/user-prompt-submit.add-context.out"],
    [POST_BASH, "tool-result", "output/post-tool-use.add-context.out"],
  ] as const)("%s at %s: the bytes of %s", async (path, placement, out) => {
    const text = encode([addContext(placement)], await fixture(path));
    expect(textEncoder.encode(text)).toEqual(await fixtureBytes(out));
  });

  test("every other placement on UserPromptSubmit and PostToolUse is unsupported, naming it", async () => {
    const all = ["session-start-input", "subagent-input", "prompt-input", "tool-result"] as const;
    for (const [path, own] of [
      [UPS, "prompt-input"],
      [POST_BASH, "tool-result"],
    ] as const) {
      for (const placement of all.filter((p) => p !== own)) {
        const error = unsupported(() => encode([addContext(placement)], fixtureSync(path)));
        expect(error.message).toContain(placement);
      }
    }
  });

  test("the new placements are refused on the older events", async () => {
    for (const path of [SESSION, SUBAGENT]) {
      for (const placement of ["prompt-input", "tool-result"] as const) {
        unsupported(() => encode([addContext(placement)], fixtureSync(path)));
      }
    }
  });

  test("PreToolUse has no add-context placement at all", () => {
    for (const placement of ["session-start-input", "subagent-input", "prompt-input", "tool-result"] as const) {
      unsupported(() => encode([addContext(placement)], fixtureSync(PRE_BASH)));
    }
  });

  test("a lone surrogate in the text is unsupported at the new placements, a valid pair is delivered", async () => {
    for (const [path, placement] of [
      [UPS, "prompt-input"],
      [POST_BASH, "tool-result"],
    ] as const) {
      for (const text of ["\uD800", "a\uDC00", "\uDE80\uD83D"]) {
        unsupported(() => encode([addContext(placement, text)], fixtureSync(path)));
      }
      const out = encode([addContext(placement, "pair 𝄞 ok")], fixtureSync(path));
      expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("pair 𝄞 ok");
    }
  });
});

describe("encode: tool-permission", () => {
  test("deny: the bytes of pre-tool-use.deny.out", async () => {
    const text = encode([deny(REASON)], await fixture(PRE_BASH));
    expect(textEncoder.encode(text)).toEqual(await fixtureBytes("output/pre-tool-use.deny.out"));
  });

  test("deny is only deny and the reason: one object, one LF, no updatedInput", () => {
    const text = encode([deny("no")], fixtureSync(PRE_BASH));
    expect(text).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}\n');
  });

  test("the reason is delivered untrimmed", () => {
    const out = JSON.parse(encode([deny("  keep me \n")], fixtureSync(PRE_BASH)));
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("  keep me \n");
  });

  // Rust's str::trim removes the Unicode White_Space property; JavaScript's trim differs.
  const WHITE_SPACE = [
    "\u0009", "\u000A", "\u000B", "\u000C", "\u000D", "\u0020", "\u0085", "\u00A0", "\u1680",
    "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008",
    "\u2009", "\u200A", "\u2028", "\u2029", "\u202F", "\u205F", "\u3000",
  ];

  test.each(WHITE_SPACE.map((char) => [`U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`, char] as const))(
    "a reason of only %s is unsupported",
    (_label, char) => {
    const error = unsupported(() => encode([deny(char)], fixtureSync(PRE_BASH)));
    expect(error.message).toContain("white space");
    unsupported(() => encode([deny(` ${char}${char} `)], fixtureSync(PRE_BASH)));
  });

  test("all White_Space characters together are unsupported", () => {
    unsupported(() => encode([deny(WHITE_SPACE.join(""))], fixtureSync(PRE_BASH)));
  });

  // JavaScript's trim removes U+FEFF but Rust does not; JavaScript keeps U+0085 and Rust removes it.
  test("U+FEFF, U+200B, U+180E and U+2060 are not White_Space: a reason of only those is delivered", () => {
    for (const char of ["\uFEFF", "\u200B", "\u180E", "\u2060"]) {
      const out = JSON.parse(encode([deny(char)], fixtureSync(PRE_BASH)));
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe(char);
    }
  });

  test("white space around a visible character is delivered", () => {
    for (const reason of ["\u0085x", "x\u3000", " \u00A0y\u2028 "]) {
      const out = JSON.parse(encode([deny(reason)], fixtureSync(PRE_BASH)));
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe(reason);
    }
  });

  test.each(["allow", "ask"] as const)("%s is unsupported, with and without a reason", (decision) => {
    for (const effect of [
      { kind: "tool-permission", decision },
      { kind: "tool-permission", decision, reason: "fine" },
    ] as HookEffect[]) {
      const error = unsupported(() => encode([effect], fixtureSync(PRE_BASH)));
      expect(error.message).toContain(decision);
    }
  });

  test("a lone surrogate in the reason is unsupported, a valid pair is delivered", () => {
    for (const reason of ["\uD800", "a\uDC00b", "x\uD83D", "\uDE80\uD83D"]) {
      unsupported(() => encode([deny(reason)], fixtureSync(PRE_BASH)));
    }
    const out = JSON.parse(encode([deny("𝄞 no")], fixtureSync(PRE_BASH)));
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("𝄞 no");
  });

  test("tool-permission on any other event is unsupported", () => {
    for (const path of [UPS, POST_BASH, SESSION, SUBAGENT]) {
      unsupported(() => encode([deny("no")], fixtureSync(path)));
    }
  });
});

describe("encode: tool-input", () => {
  test("Bash: the bytes of pre-tool-use.bash.tool-input.out", async () => {
    const text = encode([toolInput(BASH_INPUT)], await fixture(PRE_BASH));
    expect(textEncoder.encode(text)).toEqual(await fixtureBytes("output/pre-tool-use.bash.tool-input.out"));
  });

  test("the rewrite is allow plus updatedInput: it grants nothing more, and carries no reason", () => {
    const out = JSON.parse(encode([toolInput({ command: "ls" })], fixtureSync(PRE_BASH)));
    expect(out).toStrictEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "ls" } },
    });
  });

  test.each([
    [PRE_BASH, "Bash"],
    [PRE_PATCH, "apply_patch"],
  ])("%s: %s takes exactly { command: string }", (path) => {
    const input = { command: "*** Begin Patch\n*** End Patch\n" };
    const out = JSON.parse(encode([toolInput(input)], fixtureSync(path)));
    expect(out.hookSpecificOutput.updatedInput).toStrictEqual(input);
    const empty = JSON.parse(encode([toolInput({ command: "" })], fixtureSync(path)));
    expect(empty.hookSpecificOutput.updatedInput).toStrictEqual({ command: "" });
  });

  test.each([PRE_BASH, PRE_PATCH])("%s: anything but exactly { command: string } is unsupported", (path) => {
    const shapes: Array<Record<string, unknown>> = [
      {},
      { cmd: "ls" },
      { command: "ls", timeout: 5 },
      { command: "ls", yield_time_ms: 1 },
      { command: 1 },
      { command: null },
      { command: ["ls"] },
      { command: { a: 1 } },
      { command: undefined as unknown as string, extra: "x" },
    ];
    for (const shape of shapes) {
      const error = unsupported(() => encode([toolInput(shape)], fixtureSync(path)));
      expect(error.message).toContain("command");
    }
  });

  test("another tool takes any JSON object, nested", () => {
    const input = fixtureSync(PRE_BASH);
    input.tool_name = "mcp__server__lookup";
    input.tool_input = { query: "x" };
    const rewrite = { query: "y", filters: { tags: ["a", "b"], depth: 2 }, flag: null };
    const out = JSON.parse(encode([toolInput(rewrite)], input));
    expect(out.hookSpecificOutput.updatedInput).toStrictEqual(rewrite);
  });

  test("without a tool in the invocation it is unsupported: the rewrite cannot be checked", () => {
    for (const drop of ["tool_name", "tool_input"] as const) {
      const input = fixtureSync(PRE_BASH);
      delete input[drop];
      unsupported(() => encode([toolInput({ command: "ls" })], input));
    }
    unsupported(() => encode([toolInput({ command: "ls" })], { hook_event_name: "PreToolUse" }));
  });

  test("tool-input on any other event is unsupported", () => {
    for (const path of [UPS, POST_BASH, SESSION, SUBAGENT]) {
      unsupported(() => encode([toolInput({ command: "ls" })], fixtureSync(path)));
    }
  });

  test("a lone surrogate anywhere in a key or string of the input is unsupported", () => {
    const tool = fixtureSync(PRE_BASH);
    tool.tool_name = "mcp__server__lookup";
    tool.tool_input = {};
    const cases: Array<Record<string, unknown>> = [
      { "k\uD800": "v" },
      { k: "v\uDC00" },
      { k: ["ok", "x\uD83D"] },
      { k: { deep: { "\uDE80": 1 } } },
      { k: [[{ "a\uD800b": true }]] },
      { k: { list: [{ s: "\uDE80\uD83D" }] } },
    ];
    for (const input of cases) unsupported(() => encode([toolInput(input)], structuredClone(tool)));
    unsupported(() => encode([toolInput({ command: "a\uD800" })], fixtureSync(PRE_BASH)));
    unsupported(() => encode([toolInput({ command: "a\uD800" })], fixtureSync(PRE_PATCH)));
  });

  test("a valid surrogate pair in a key or value is delivered", () => {
    const tool = fixtureSync(PRE_BASH);
    tool.tool_name = "mcp__server__lookup";
    tool.tool_input = {};
    const input = { "key 𝄞": ["v 🚀", { "𝄞": "ü" }] };
    expect(JSON.parse(encode([toolInput(input)], tool)).hookSpecificOutput.updatedInput).toStrictEqual(input);
  });
});

describe("encode: tool-permission and tool-input together", () => {
  test("every pair and order is unsupported on PreToolUse", () => {
    const rewrite = toolInput({ command: "ls" });
    for (const permission of [deny("no"), { kind: "tool-permission", decision: "allow" }, { kind: "tool-permission", decision: "ask" }] as HookEffect[]) {
      unsupported(() => encode([permission, rewrite], fixtureSync(PRE_BASH)));
      unsupported(() => encode([rewrite, permission], fixtureSync(PRE_BASH)));
      unsupported(() => encode([rewrite, permission, notifyUser()], fixtureSync(PRE_BASH)));
    }
  });
});

describe("encode: notify-user", () => {
  test("alone: top-level systemMessage only, on all five events", async () => {
    const expected = `${JSON.stringify({ systemMessage: NOTIFY })}\n`;
    for (const path of [SESSION, SUBAGENT, UPS, PRE_BASH, POST_BASH]) {
      expect(encode([notifyUser()], await fixture(path))).toBe(expected);
    }
    expect(expected).toBe(
      '{"systemMessage":"briefing: 1 of 3 declarations did not load: \\"house\\" (C:\\\\Users\\\\dev\\\\rules\\\\house.md).\\nRun `briefing doctor` → details."}\n',
    );
  });

  test.each([
    [SESSION, "session-start-input", "output/session-start.add-context.notify-user.out"],
    [UPS, "prompt-input", "output/user-prompt-submit.add-context.notify-user.out"],
  ] as const)("%s with add-context at %s: the bytes of %s, for either order of the list", async (path, placement, out) => {
    const want = await fixtureBytes(out);
    const input = await fixture(path);
    expect(textEncoder.encode(encode([addContext(placement), notifyUser()], input))).toEqual(want);
    expect(textEncoder.encode(encode([notifyUser(), addContext(placement)], input))).toEqual(want);
  });

  test("notify-user with add-context on SubagentStart and PostToolUse: hookSpecificOutput first, then systemMessage", async () => {
    for (const [path, placement, event] of [
      [SUBAGENT, "subagent-input", "SubagentStart"],
      [POST_BASH, "tool-result", "PostToolUse"],
    ] as const) {
      for (const list of [[addContext(placement), notifyUser()], [notifyUser(), addContext(placement)]]) {
        const out = encode(list, await fixture(path));
        expect(out).toBe(
          `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: CONTEXT }, systemMessage: NOTIFY })}\n`,
        );
      }
    }
  });

  test("with a deny: one object, hookSpecificOutput then systemMessage, either order", () => {
    const want = `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON },
      systemMessage: NOTIFY,
    })}\n`;
    expect(encode([deny(REASON), notifyUser()], fixtureSync(PRE_BASH))).toBe(want);
    expect(encode([notifyUser(), deny(REASON)], fixtureSync(PRE_BASH))).toBe(want);
  });

  test("with a tool-input: one object, hookSpecificOutput then systemMessage, either order", () => {
    const want = `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: BASH_INPUT },
      systemMessage: NOTIFY,
    })}\n`;
    expect(encode([toolInput(BASH_INPUT), notifyUser()], fixtureSync(PRE_BASH))).toBe(want);
    expect(encode([notifyUser(), toolInput(BASH_INPUT)], fixtureSync(PRE_BASH))).toBe(want);
  });

  test("one effect the event cannot deliver rejects the whole list, nothing is dropped", () => {
    unsupported(() => encode([notifyUser(), addContext("session-start-input")], fixtureSync(UPS)));
    unsupported(() => encode([notifyUser(), addContext("prompt-input")], fixtureSync(PRE_BASH)));
    unsupported(() => encode([deny("no"), addContext("prompt-input")], fixtureSync(PRE_BASH)));
    unsupported(() => encode([notifyUser(), { kind: "tool-permission", decision: "allow" }], fixtureSync(PRE_BASH)));
    unsupported(() => encode([notifyUser(), deny("   ")], fixtureSync(PRE_BASH)));
    unsupported(() => encode([notifyUser(), toolInput({ command: 1 })], fixtureSync(PRE_BASH)));
  });

  test("on an event without rules: unsupported alone and in a list, no-decision stays empty", () => {
    for (const event of ["SessionEnd", "Stop", "PreCompact", "SubagentStop"]) {
      const input = { hook_event_name: event };
      expect(encode([{ kind: "no-decision" }], input)).toBe("");
      const error = unsupported(() => encode([notifyUser()], input));
      expect(error.message).toContain(event);
      unsupported(() => encode([notifyUser(), addContext("session-start-input")], input));
      unsupported(() => encode([deny("no")], input));
    }
  });

  test("a lone surrogate in the text is unsupported, alone and in a list; a valid pair is delivered", () => {
    for (const text of ["\uD800", "x\uDC00", "\uDE80\uD83D"]) {
      for (const path of [SESSION, UPS, PRE_BASH, POST_BASH]) {
        unsupported(() => encode([notifyUser(text)], fixtureSync(path)));
      }
      unsupported(() => encode([notifyUser(text), addContext("prompt-input")], fixtureSync(UPS)));
    }
    expect(JSON.parse(encode([notifyUser("𝄞 ok")], fixtureSync(UPS))).systemMessage).toBe("𝄞 ok");
  });

  test("the text is delivered as given: not trimmed, not checked", () => {
    for (const text of ["  padded \n", "{\"continue\":false}", "\uFEFF"]) {
      expect(JSON.parse(encode([notifyUser(text)], fixtureSync(UPS)))).toStrictEqual({ systemMessage: text });
    }
  });
});

// main() in process with the real codec: what a plugin's entry sees.
async function runMain(path: string, handler: () => HookEffect | HookEffect[], onFailure?: "closed") {
  const stdout: Uint8Array[] = [];
  const stderr: string[] = [];
  const code = await main({
    codec: codex,
    handler,
    stdin: new Blob([await fixtureBytes(path)]).stream(),
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

describe("main() with the Codex codec: the new events", () => {
  test.each([
    [UPS, () => [addContext("prompt-input")], "output/user-prompt-submit.add-context.out"],
    [POST_BASH, () => [addContext("tool-result")], "output/post-tool-use.add-context.out"],
    [PRE_BASH, () => [deny(REASON)], "output/pre-tool-use.deny.out"],
    [PRE_BASH, () => [toolInput(BASH_INPUT)], "output/pre-tool-use.bash.tool-input.out"],
    [SESSION, () => [notifyUser(), addContext("session-start-input")], "output/session-start.add-context.notify-user.out"],
    [UPS, () => [addContext("prompt-input"), notifyUser()], "output/user-prompt-submit.add-context.notify-user.out"],
  ] as const)("%s: exit 0, stdout is %s", async (path, handler, out) => {
    expect(await runMain(path, handler as () => HookEffect[])).toEqual({
      code: 0,
      stdout: [await fixtureBytes(out)],
      stderr: [],
    });
  });

  test("a single effect, not a list, gives the same bytes", async () => {
    const result = await runMain(PRE_BASH, () => deny(REASON));
    expect(result.stdout).toEqual([await fixtureBytes("output/pre-tool-use.deny.out")]);
  });

  test("a handler sees the tool on PreToolUse", async () => {
    let seen: HookInvocation["tool"];
    await main({
      codec: codex,
      handler: ({ invocation }) => {
        seen = invocation.tool;
        return { kind: "no-decision" };
      },
      stdin: new Blob([await fixtureBytes(PRE_BASH)]).stream(),
      stdout: () => {},
      stderr: () => {},
      env: {},
      cwd: PROCESS_CWD,
    });
    expect(seen).toStrictEqual({ name: "Bash", input: { command: "bun test ./test/" } });
  });

  test.each([
    ["allow", "HOOK_EFFECT_UNSUPPORTED", () => ({ kind: "tool-permission", decision: "allow" }) as HookEffect],
    ["ask", "HOOK_EFFECT_UNSUPPORTED", () => ({ kind: "tool-permission", decision: "ask", reason: "x" }) as HookEffect],
    ["a blank deny reason", "HOOK_EFFECT_UNSUPPORTED", () => deny("\u0085 ")],
    ["deny without a reason (the core)", "HOOK_EFFECT_INVALID", () => ({ kind: "tool-permission", decision: "deny" }) as HookEffect],
    ["Bash with an extra key", "HOOK_EFFECT_UNSUPPORTED", () => toolInput({ command: "ls", timeout: 3 })],
    ["a tool-input that is not JSON (the core)", "HOOK_EFFECT_INVALID", () => toolInput({ command: undefined as unknown as string })],
    ["deny and tool-input", "HOOK_EFFECT_UNSUPPORTED", () => [deny("no"), toolInput({ command: "ls" })]],
  ] as const)("PreToolUse, %s: exit 1, %s, no stdout, one line", async (_label, code, handler) => {
    const result = await runMain(PRE_BASH, handler as () => HookEffect);
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toStartWith(`agent-bun-runtime: ${code}: `);
  });

  test("onFailure closed on an unsupported deny: exit 2, the same line", async () => {
    const handler = () => deny("\u3000");
    const open = await runMain(PRE_BASH, handler);
    const closed = await runMain(PRE_BASH, handler, "closed");
    expect(open.code).toBe(1);
    expect(closed).toEqual({ ...open, code: 2 });
  });

  test("notify-user on an event without rules: exit 1, HOOK_EFFECT_UNSUPPORTED naming the event", async () => {
    const result = await runMain("malformed/session-end.json", () => notifyUser());
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr[0]).toStartWith("agent-bun-runtime: HOOK_EFFECT_UNSUPPORTED: ");
    expect(result.stderr[0]).toContain("SessionEnd");
  });

  test("the malformed tool_name: exit 1, HOOK_INPUT_INVALID, the handler never runs", async () => {
    let called = false;
    const result = await runMain("malformed/pre-tool-use.tool-name-number.json", () => {
      called = true;
      return deny("no");
    });
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toStartWith("agent-bun-runtime: HOOK_INPUT_INVALID: ");
    expect(called).toBe(false);
  });
});
