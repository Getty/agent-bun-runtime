// Effect validation: a value the vocabulary lacks is unsupported; a missing value, a value
// of the wrong type or an unknown field is invalid. Never a silent conversion.
import { describe, expect, test } from "bun:test";
import { AgentRuntimeError, type ErrorCode } from "../src/index.js";
import { validateEffect, validateEffects } from "../src/effects.js";

function rejects(value: unknown, code: ErrorCode, validate: (value: unknown) => unknown = validateEffect): AgentRuntimeError {
  try {
    validate(value);
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

  for (const placement of ["session-start-input", "subagent-input", "prompt-input", "tool-result"] as const) {
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

describe("validateEffect: notify-user", () => {
  test("a non-empty text is accepted", () => {
    expect(validateEffect({ kind: "notify-user", text: "Synced 2 skills" })).toEqual({ kind: "notify-user", text: "Synced 2 skills" });
  });

  test("a missing, non-string or empty text is invalid", () => {
    rejects({ kind: "notify-user" }, "HOOK_EFFECT_INVALID");
    rejects({ kind: "notify-user", text: 1 }, "HOOK_EFFECT_INVALID");
    rejects({ kind: "notify-user", text: null }, "HOOK_EFFECT_INVALID");
    rejects({ kind: "notify-user", text: "" }, "HOOK_EFFECT_INVALID");
  });

  test("an unknown field is invalid; audience and placement belong to add-context", () => {
    rejects({ kind: "notify-user", text: "x", audience: "user" }, "HOOK_EFFECT_INVALID");
    rejects({ kind: "notify-user", text: "x", placement: "prompt-input" }, "HOOK_EFFECT_INVALID");
  });
});

describe("validateEffect: tool-permission", () => {
  for (const decision of ["allow", "ask"] as const) {
    test(`${decision} without a reason is accepted`, () => {
      expect(validateEffect({ kind: "tool-permission", decision })).toEqual({ kind: "tool-permission", decision });
    });
  }

  for (const decision of ["allow", "deny", "ask"] as const) {
    test(`${decision} with a reason is accepted`, () => {
      const effect = { kind: "tool-permission", decision, reason: "because" } as const;
      expect(validateEffect(effect)).toEqual(effect);
    });
  }

  test("deny without a reason is invalid", () => {
    const error = rejects({ kind: "tool-permission", decision: "deny" }, "HOOK_EFFECT_INVALID");
    expect(error.message).toContain("deny");
    expect(error.message).toContain("reason");
  });

  test("a deny with an empty or non-string reason is invalid", () => {
    rejects({ kind: "tool-permission", decision: "deny", reason: "" }, "HOOK_EFFECT_INVALID");
    rejects({ kind: "tool-permission", decision: "deny", reason: 7 }, "HOOK_EFFECT_INVALID");
    rejects({ kind: "tool-permission", decision: "deny", reason: null }, "HOOK_EFFECT_INVALID");
  });

  test("an allow or ask with an empty or non-string reason is invalid too", () => {
    for (const decision of ["allow", "ask"]) {
      rejects({ kind: "tool-permission", decision, reason: "" }, "HOOK_EFFECT_INVALID");
      rejects({ kind: "tool-permission", decision, reason: false }, "HOOK_EFFECT_INVALID");
    }
  });

  test("a missing or non-string decision is invalid; a decision outside the vocabulary is unsupported", () => {
    rejects({ kind: "tool-permission" }, "HOOK_EFFECT_INVALID");
    rejects({ kind: "tool-permission", decision: true }, "HOOK_EFFECT_INVALID");
    const error = rejects({ kind: "tool-permission", decision: "defer", reason: "x" }, "HOOK_EFFECT_UNSUPPORTED");
    expect(error.message).toContain("defer");
  });

  test("an unknown field is invalid", () => {
    rejects({ kind: "tool-permission", decision: "allow", input: {} }, "HOOK_EFFECT_INVALID");
  });
});

describe("validateEffect: tool-input", () => {
  test("a plain JSON object is accepted, as given", () => {
    const input = { command: "ls", nested: { list: [1, "a", null, true, { deep: 2.5 }] }, empty: {} };
    expect(validateEffect({ kind: "tool-input", input })).toEqual({ kind: "tool-input", input });
  });

  test("an empty object and a null-prototype object are accepted", () => {
    validateEffect({ kind: "tool-input", input: {} });
    validateEffect({ kind: "tool-input", input: Object.assign(Object.create(null), { a: 1 }) });
  });

  test("a missing input is invalid", () => {
    rejects({ kind: "tool-input" }, "HOOK_EFFECT_INVALID");
  });

  test("an input that is not an object is invalid", () => {
    for (const input of [null, [], [{ command: "x" }], "ls", 1, true, undefined]) {
      rejects({ kind: "tool-input", input }, "HOOK_EFFECT_INVALID");
    }
  });

  test("a class instance, a Date, a Map as the input is invalid", () => {
    class Input {
      command = "ls";
    }
    for (const input of [new Input(), new Date(0), new Map([["command", "ls"]])]) {
      rejects({ kind: "tool-input", input }, "HOOK_EFFECT_INVALID");
    }
  });

  test("values JSON cannot carry unchanged are invalid at any depth", () => {
    const cases: unknown[] = [
      { a: undefined },
      { a: () => 1 },
      { a: Symbol("s") },
      { a: 1n },
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: Number.NEGATIVE_INFINITY },
      { a: new Date(0) },
      { a: new Map() },
      { a: { b: [1, { c: undefined }] } },
      { a: [{ b: () => 1 }] },
      { a: [[Number.NaN]] },
      { a: [new (class Box {})()] },
    ];
    for (const input of cases) rejects({ kind: "tool-input", input }, "HOOK_EFFECT_INVALID");
  });

  test("a cycle is invalid, a shared non-cyclic reference is not", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    rejects({ kind: "tool-input", input: cyclic }, "HOOK_EFFECT_INVALID");
    const deep: Record<string, unknown> = { list: [] };
    (deep.list as unknown[]).push(deep);
    rejects({ kind: "tool-input", input: deep }, "HOOK_EFFECT_INVALID");
    const shared = { x: 1 };
    validateEffect({ kind: "tool-input", input: { a: shared, b: shared, c: [shared, shared] } });
  });

  test("an unknown field is invalid", () => {
    rejects({ kind: "tool-input", input: {}, decision: "allow" }, "HOOK_EFFECT_INVALID");
  });
});

describe("validateEffects", () => {
  const notify = { kind: "notify-user", text: "hello" } as const;
  const add = { kind: "add-context", text: "ctx", audience: "model", placement: "session-start-input" } as const;
  const deny = { kind: "tool-permission", decision: "deny", reason: "no" } as const;
  const input = { kind: "tool-input", input: { command: "ls" } } as const;
  const none = { kind: "no-decision" } as const;
  const list = (value: unknown) => rejects(value, "HOOK_EFFECT_INVALID", validateEffects);

  test("one effect becomes a frozen list of one", () => {
    const effects = validateEffects(notify);
    expect(effects).toEqual([notify]);
    expect(Array.isArray(effects)).toBe(true);
    expect(Object.isFrozen(effects)).toBe(true);
  });

  test("a list is returned frozen, in the handler's order, as a new array", () => {
    const given = [notify, add];
    const effects = validateEffects(given);
    expect(effects).toEqual([notify, add]);
    expect(effects).not.toBe(given);
    expect(Object.isFrozen(effects)).toBe(true);
    expect(validateEffects([add, notify])).toEqual([add, notify]);
  });

  test("a list of one is accepted, also a lone no-decision", () => {
    expect(validateEffects([none])).toEqual([none]);
    expect(validateEffects([add])).toEqual([add]);
  });

  test("an empty list is invalid", () => {
    expect(list([]).message).toContain("empty");
  });

  test("two effects of one kind are invalid, for every kind", () => {
    const pairs: unknown[][] = [
      [notify, { ...notify, text: "again" }],
      [add, { ...add, placement: "subagent-input" }],
      [deny, { ...deny, decision: "ask" }],
      [input, { ...input, input: {} }],
      [none, none],
    ];
    for (const pair of pairs) list(pair);
    expect(list([notify, add, notify]).message).toContain("notify-user");
  });

  test("no-decision beside another effect is invalid, in either order", () => {
    list([none, notify]);
    list([notify, none]);
    list([add, deny, none]);
  });

  test("an element that is itself invalid or unsupported keeps its own code", () => {
    list([notify, { kind: "notify-user", text: "" }]);
    list([notify, undefined]);
    list([notify, [add]]);
    rejects([add, { kind: "block" }], "HOOK_EFFECT_UNSUPPORTED", validateEffects);
  });

  test("tool-permission and tool-input together pass the core; the codec decides", () => {
    expect(validateEffects([deny, input])).toEqual([deny, input]);
    expect(validateEffects([input, notify, add])).toEqual([input, notify, add]);
  });

  test("the order of different kinds does not change what is accepted", () => {
    const all = [notify, add, deny, input];
    const orders = [all, [...all].reverse(), [input, notify, deny, add], [deny, add, input, notify]];
    for (const order of orders) {
      expect(new Set(validateEffects(order).map(({ kind }) => kind))).toEqual(
        new Set(["notify-user", "add-context", "tool-permission", "tool-input"]),
      );
    }
  });

  test("a value that is not a list is validated as one effect: an invalid one stays invalid", () => {
    rejects(undefined, "HOOK_EFFECT_INVALID", validateEffects);
    rejects(null, "HOOK_EFFECT_INVALID", validateEffects);
    rejects({ kind: "no-decision", extra: 1 }, "HOOK_EFFECT_INVALID", validateEffects);
  });
});
