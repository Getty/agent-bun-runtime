// A hook entry on main() for test/on-failure-silent.test.ts, with either real codec. argv[2]
// "codex" or "claude-code"; ABR_TEST_ON_FAILURE sets onFailure (absent: not passed);
// ABR_TEST_MAX_INPUT_BYTES sets maxInputBytes; ABR_TEST_EFFECTS is the effect or list of
// effects the handler returns as JSON, "throw" makes it throw. Not a host artifact.
import { claudeCode } from "../../src/claude-code.js";
import { codex } from "../../src/codex.js";
import { main, type HookEffect } from "../../src/index.js";

const effects = process.env.ABR_TEST_EFFECTS ?? '{"kind":"no-decision"}';
const onFailure = process.env.ABR_TEST_ON_FAILURE;
const max = process.env.ABR_TEST_MAX_INPUT_BYTES;

process.exit(
  await main({
    codec: process.argv[2] === "codex" ? codex : claudeCode,
    ...(max === undefined ? {} : { maxInputBytes: Number(max) }),
    ...(onFailure === undefined ? {} : { onFailure: onFailure as "open" | "closed" | "silent" }),
    handler: () => {
      if (effects === "throw") throw new Error("handler failed on purpose");
      return JSON.parse(effects) as HookEffect | HookEffect[];
    },
  }),
);
