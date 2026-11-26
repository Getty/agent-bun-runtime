// A stand-in codec for core tests, not the Codex codec: the event comes from
// hook_event_name, SessionStart takes session-start-input, SubagentStart takes
// subagent-input, and context is delivered as the bare text. Any other event is decoded
// generically, and only no-decision encodes for it.
import { AgentRuntimeError } from "../../src/index.js";
import { decodeGenericEvent, defineCodec, type CodecImplementation } from "../../src/codec.js";
import { createInvocation } from "../../src/context.js";

const HOST = { kind: "codex", surface: "command-hook" } as const;

export const testImplementation: CodecImplementation = {
  decode(input, { processCwd }) {
    const event = input.hook_event_name;
    if (typeof event !== "string") {
      throw new AgentRuntimeError("HOOK_INPUT_INVALID", "decode", "hook_event_name is not a string");
    }
    if (event !== "SessionStart" && event !== "SubagentStart") {
      return decodeGenericEvent(HOST, event, input, { processCwd });
    }
    return createInvocation({
      host: HOST,
      nativeEvent: event,
      processCwd,
      hostWorkingDirectory: typeof input.cwd === "string" ? input.cwd : undefined,
      nativeInput: input,
    });
  },
  encode(effects, invocation) {
    const effect = effects[0];
    if (effect === undefined || effects.length > 1) {
      throw new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "encode", "only one effect at once");
    }
    if (effect.kind === "no-decision") return "";
    const event = invocation.event.nativeName;
    if (effect.kind !== "add-context" || (event !== "SessionStart" && event !== "SubagentStart")) {
      throw new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "encode", `${effect.kind} is not supported for ${event}`);
    }
    const wanted = invocation.event.nativeName === "SessionStart" ? "session-start-input" : "subagent-input";
    if (effect.placement !== wanted) {
      throw new AgentRuntimeError(
        "HOOK_EFFECT_UNSUPPORTED",
        "encode",
        `placement ${effect.placement} is not supported for ${invocation.event.nativeName}`,
      );
    }
    return effect.text;
  },
};

export const testCodec = defineCodec("codex", testImplementation);
