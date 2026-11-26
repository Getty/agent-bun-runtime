// A Claude Code hook entry on main() with the Claude Code codec, for the end-to-end tests in
// test/claude-code.test.ts. Not a Claude Code artifact. The handler returns the effect or
// list of effects given as JSON in ABR_TEST_EFFECTS; ABR_TEST_ON_FAILURE sets onFailure.
import { claudeCode } from "../../../src/claude-code.js";
import { main, type HookEffect } from "../../../src/index.js";

const effects = JSON.parse(process.env.ABR_TEST_EFFECTS ?? "null") as HookEffect | HookEffect[];
const onFailure = process.env.ABR_TEST_ON_FAILURE;

process.exit(
  await main({
    codec: claudeCode,
    handler: () => effects,
    ...(onFailure === undefined ? {} : { onFailure: onFailure as "open" | "closed" }),
  }),
);
