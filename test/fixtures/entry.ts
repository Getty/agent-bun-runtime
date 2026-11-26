// A hook entry on main() with the stand-in codec, reading the real stdin and writing the
// real stdout and stderr. argv[2] "exit": the documented form process.exit(await main(...));
// "exitcode": only process.exitCode, so the process must end on its own. The handler
// returns the input's "effect" field. That field set to "throw", "throw-typed" or
// "throw-string" makes the handler throw an Error, an AgentRuntimeError (HOOK_EFFECT_UNSUPPORTED)
// or a plain string; an absent field makes it return nothing. ABR_TEST_MAX_INPUT_BYTES sets
// maxInputBytes, ABR_TEST_ON_FAILURE sets onFailure (passed as given, so an invalid value
// reaches main()).
import { AgentRuntimeError, main, type HookEffect } from "../../src/index.js";
import { testCodec } from "./codec.js";

const max = process.env.ABR_TEST_MAX_INPUT_BYTES;
const onFailure = process.env.ABR_TEST_ON_FAILURE;

const code = await main({
  codec: testCodec,
  ...(max === undefined ? {} : { maxInputBytes: Number(max) }),
  ...(onFailure === undefined ? {} : { onFailure: onFailure as "open" | "closed" }),
  handler: ({ invocation }) => {
    const effect = invocation.native.input.effect;
    if (effect === "throw") throw new Error("handler failed on purpose");
    if (effect === "throw-typed") {
      throw new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "handler", "typed on purpose");
    }
    if (effect === "throw-string") throw "plain string on purpose";
    return effect as HookEffect;
  },
});

if (process.argv[2] === "exit") process.exit(code);
process.exitCode = code;
