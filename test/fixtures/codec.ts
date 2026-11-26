// A stand-in codec for core tests, not the Codex codec: the event comes from
// hook_event_name, SessionStart takes session-start-input, SubagentStart takes
// subagent-input, and context is delivered as the bare text.
import { AgentRuntimeError, type HookCodec } from "../../src/index.js";
import { createInvocation } from "../../src/context.js";

export const testCodec: HookCodec = {
  decode(input, { processCwd }) {
    const event = input.hook_event_name;
    if (typeof event !== "string") {
      throw new AgentRuntimeError("HOOK_INPUT_INVALID", "decode", "hook_event_name is not a string");
    }
    if (event !== "SessionStart" && event !== "SubagentStart") {
      throw new AgentRuntimeError("HOOK_EVENT_UNSUPPORTED", "decode", `event ${event} is not supported`);
    }
    return createInvocation({
      host: { kind: "codex", surface: "command-hook" },
      nativeEvent: event,
      processCwd,
      hostWorkingDirectory: typeof input.cwd === "string" ? input.cwd : undefined,
      nativeInput: input,
    });
  },
  encode(effect, invocation) {
    if (effect.kind === "no-decision") return "";
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
