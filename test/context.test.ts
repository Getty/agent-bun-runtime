// The envelope (handoff 6.1, cut to the MVP): built from explicit inputs, missing host data
// stays missing, the native input is preserved and frozen.
import { describe, expect, test } from "bun:test";
import { createInvocation } from "../src/context.js";

const host = { kind: "codex", surface: "command-hook" } as const;

describe("createInvocation", () => {
  test("builds the envelope from the given parts", () => {
    const nativeInput = { hook_event_name: "SubagentStart", session_id: "s-1", agent_type: "worker" };
    const invocation = createInvocation({
      host,
      nativeEvent: "SubagentStart",
      processCwd: "/consumer",
      hostWorkingDirectory: "/project",
      hostTurnId: "t-9",
      nativeInput,
    });
    expect(invocation).toEqual({
      envelopeVersion: 1,
      host,
      event: { nativeName: "SubagentStart" },
      location: { processCwd: "/consumer", hostWorkingDirectory: "/project" },
      identity: { hostTurnId: "t-9" },
      native: { input: nativeInput },
    });
    expect(invocation.native.input).toBe(nativeInput);
  });

  test("missing host data stays missing: no key, no default", () => {
    const invocation = createInvocation({
      host,
      nativeEvent: "SessionStart",
      processCwd: "/consumer",
      hostWorkingDirectory: undefined,
      hostSessionId: undefined,
      nativeInput: {},
    });
    expect(Object.keys(invocation.location)).toEqual(["processCwd"]);
    expect(Object.keys(invocation.identity)).toEqual([]);
  });

  test("the envelope and the native input are frozen", () => {
    const invocation = createInvocation({
      host: { ...host },
      nativeEvent: "SessionStart",
      processCwd: "/consumer",
      nativeInput: { nested: { list: [{ deep: true }] } },
    });
    for (const part of [
      invocation,
      invocation.host,
      invocation.event,
      invocation.location,
      invocation.identity,
      invocation.native,
      invocation.native.input,
      invocation.native.input.nested,
      (invocation.native.input.nested as { list: unknown[] }).list,
      (invocation.native.input.nested as { list: unknown[] }).list[0],
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  test("envelopeVersion is 1 and the old contractVersion is gone", () => {
    const invocation = createInvocation({ host, nativeEvent: "SessionStart", processCwd: "/consumer", nativeInput: {} });
    expect(invocation.envelopeVersion).toBe(1);
    expect("contractVersion" in invocation).toBe(false);
    expect(Object.keys(invocation)).toEqual(["envelopeVersion", "host", "event", "location", "identity", "native"]);
  });

  test("tool is absent, not undefined, when the codec gave none", () => {
    const base = { host, nativeEvent: "PreToolUse", processCwd: "/consumer", nativeInput: {} };
    for (const invocation of [createInvocation(base), createInvocation({ ...base, tool: undefined })]) {
      expect("tool" in invocation).toBe(false);
      expect(invocation.tool).toBeUndefined();
    }
  });

  test("tool is {name, input} when given, frozen with its input deep-frozen in place", () => {
    const toolInput = { command: "ls", options: { flags: ["-l", { deep: true }] } };
    const invocation = createInvocation({
      host,
      nativeEvent: "PreToolUse",
      processCwd: "/consumer",
      tool: { name: "Bash", input: toolInput },
      nativeInput: {},
    });
    expect(invocation.tool).toStrictEqual({ name: "Bash", input: toolInput });
    expect(invocation.tool?.input).toBe(toolInput);
    const options = toolInput.options as { flags: unknown[] };
    for (const part of [invocation.tool, toolInput, toolInput.options, options.flags, options.flags[1]]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
    expect(() => {
      (toolInput as { command: string }).command = "rm";
    }).toThrow();
  });

  test("a tool whose input is a string, a number or null is kept as given", () => {
    for (const input of ["text", 7, null, ["a"]]) {
      const invocation = createInvocation({
        host,
        nativeEvent: "PostToolUse",
        processCwd: "/consumer",
        tool: { name: "Custom", input },
        nativeInput: {},
      });
      expect(invocation.tool).toStrictEqual({ name: "Custom", input });
    }
  });

  test("the host kinds codex and claude-code both build an envelope", () => {
    for (const kind of ["codex", "claude-code"] as const) {
      const invocation = createInvocation({
        host: { kind, surface: "command-hook" },
        nativeEvent: "SessionStart",
        processCwd: "/consumer",
        nativeInput: {},
      });
      expect(invocation.host).toStrictEqual({ kind, surface: "command-hook" });
    }
  });
});
