// Effect validation: a value the vocabulary lacks is unsupported; a missing value, a value
// of the wrong type or an unknown field is invalid. Never a silent conversion.
import { describe, expect, test } from "bun:test";
import { AgentRuntimeError, type ErrorCode } from "../src/index.js";
import { validateEffect } from "../src/effects.js";

function rejects(value: unknown, code: ErrorCode): AgentRuntimeError {
  try {
    validateEffect(value);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError);
    const typed = error as AgentRuntimeError;
    expect({ code: typed.code, stage: typed.stage }).toEqual({ code, stage: "effect" });
    return typed;
  }
  throw new Error(`expected ${code} for ${JSON.stringify(value)}`);
}

const context = { kind: "add-context", text: "Use the house style.", audience: "model" } as const;

describe("validateEffect", () => {
  test("no-decision is accepted", () => {
    expect(validateEffect({ kind: "no-decision" })).toEqual({ kind: "no-decision" });
  });

  for (const placement of ["session-start-input", "subagent-input"] as const) {
    test(`add-context with placement ${placement} is accepted`, () => {
      const effect = { ...context, placement };
      expect(validateEffect(effect)).toEqual(effect);
    });
  }

  test("a handler that returns nothing is invalid, not a no-decision", () => {
    expect(rejects(undefined, "HOOK_EFFECT_INVALID").message).toContain("no effect");
  });

  for (const value of [null, "no-decision", 0, [], [{ kind: "no-decision" }]]) {
    test(`a non-object effect (${JSON.stringify(value)}) is invalid`, () => {
      rejects(value, "HOOK_EFFECT_INVALID");
    });
  }

  test("a missing or non-string kind is invalid", () => {
    rejects({}, "HOOK_EFFECT_INVALID");
    rejects({ kind: 1 }, "HOOK_EFFECT_INVALID");
  });

  test("a kind outside the MVP vocabulary is unsupported", () => {
    const error = rejects({ kind: "deny-pending-tool", reason: "no" }, "HOOK_EFFECT_UNSUPPORTED");
    expect(error.message).toContain("deny-pending-tool");
  });

  test("add-context without text, with non-string or empty text is invalid", () => {
    rejects({ kind: "add-context", audience: "model", placement: "subagent-input" }, "HOOK_EFFECT_INVALID");
    rejects({ ...context, placement: "subagent-input", text: 42 }, "HOOK_EFFECT_INVALID");
    rejects({ ...context, placement: "subagent-input", text: "" }, "HOOK_EFFECT_INVALID");
  });

  test("add-context without audience is invalid; an audience other than model is unsupported", () => {
    rejects({ kind: "add-context", text: "x", placement: "subagent-input" }, "HOOK_EFFECT_INVALID");
    rejects({ ...context, placement: "subagent-input", audience: "user" }, "HOOK_EFFECT_UNSUPPORTED");
  });

  test("add-context without placement is invalid; a placement outside the MVP is unsupported", () => {
    rejects(context, "HOOK_EFFECT_INVALID");
    rejects({ ...context, placement: 3 }, "HOOK_EFFECT_INVALID");
    const error = rejects({ ...context, placement: "future-turn" }, "HOOK_EFFECT_UNSUPPORTED");
    expect(error.message).toContain("future-turn");
  });

  test("unknown fields are invalid", () => {
    rejects({ kind: "no-decision", text: "dropped?" }, "HOOK_EFFECT_INVALID");
    rejects({ ...context, placement: "subagent-input", repeat: true }, "HOOK_EFFECT_INVALID");
  });
});
