import { describe, expect, test } from "bun:test";
import { AgentRuntimeError } from "../src/index.js";

describe("AgentRuntimeError", () => {
  test("carries code, stage and message and is an Error", () => {
    const cause = new Error("inner");
    const error = new AgentRuntimeError("HOOK_INPUT_INVALID", "input", "stdin is empty", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AgentRuntimeError");
    expect(error.code).toBe("HOOK_INPUT_INVALID");
    expect(error.stage).toBe("input");
    expect(error.message).toBe("stdin is empty");
    expect(error.cause).toBe(cause);
  });
});
