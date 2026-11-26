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
      contractVersion: 1,
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
});
