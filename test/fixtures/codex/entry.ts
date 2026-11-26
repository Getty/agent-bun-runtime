// A Codex hook entry on main() with the Codex codec, for the end-to-end tests in
// test/codex.test.ts. argv[2] "context": add-context with the text of output/context.json
// at the placement of the decoded event; "none": no-decision.
import { join } from "node:path";
import { codex } from "../../../src/codex.js";
import { main, type HookEffect } from "../../../src/index.js";

const mode = process.argv[2];
const text = (await Bun.file(join(import.meta.dir, "output", "context.json")).json()) as string;

process.exit(
  await main({
    codec: codex,
    handler: ({ invocation }): HookEffect =>
      mode === "none"
        ? { kind: "no-decision" }
        : {
            kind: "add-context",
            text,
            audience: "model",
            placement: invocation.event.nativeName === "SubagentStart" ? "subagent-input" : "session-start-input",
          },
  }),
);
