// Characterization of PowerShell's own `-File` limit, not a getty-bun promise: Windows PowerShell 5.1
// rejects a lone `-` argument at binding time (empty parameter name: `Cannot process argument because
// the value of argument "name" is not valid`, exit 1, before the script runs); pwsh 7 accepts it.
// `-:foo` fails on both. The contract on Windows: no lone `-`, no `-:...`. These tests pin the limit
// so a PowerShell that changes it shows up. (Source-checked by the windows worker against
// CommandLineParameterParser; executed only by these tests on a Windows leg.) The polyglot rows are
// in polyglot.test.ts. Windows only: nothing is registered elsewhere.
//
//   GETTY_BUN_TEST_STARTER=powershell|pwsh bun test bootstrap/test/windows-dash-limit.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { IS_WIN, STARTER, cleanupAll, expectExit, findGitBashExe, install, realRoutes, run, sandbox, starter, startServer, track } from "./lib/harness";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

const BINDING = /argument "name" is not valid/;

async function installed() {
  const server = startServer(await realRoutes());
  track(() => server.stop());
  const sb = await sandbox({ mirror: server.url });
  await install(sb);
  return sb;
}

if (IS_WIN) {
  describe(`characterization of PowerShell's -File limit on dash arguments [${STARTER}]`, () => {
    if (STARTER === "pwsh") {
      test("pwsh 7: a lone `-` is accepted and reaches the entry", async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", "-"]);
        expectExit(r, 0);
        expect(JSON.parse(r.out).argv).toEqual(["-"]);
      });
    } else {
      test("Windows PowerShell 5.1: a lone `-` fails -File binding, exit 1, nothing on stdout", async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", "-"]);
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(r.err).toMatch(BINDING);
      });
    }

    for (const arg of ["-:foo"]) {
      test(`${STARTER}: the argument ${JSON.stringify(arg)} fails -File binding, exit 1, nothing on stdout`, async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", arg]);
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(r.err.length).toBeGreaterThan(0);
      });
    }

    // The sh starter forwards to PowerShell 5.1 under Git Bash, so the 5.1 limit shows on both legs.
    for (const arg of ["-", "-:foo"]) {
      test(`through the Git Bash forwarding (Windows PowerShell 5.1): the argument ${JSON.stringify(arg)} fails, exit 1, nothing on stdout`, async () => {
        const bash = findGitBashExe();
        if (bash === null) throw new Error("Git Bash bash.exe not found: a Windows leg needs it");
        const sb = await installed();
        const r = await run([bash, join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), "run", "entries/info.ts", arg], {
          env: sb.env,
          cwd: sb.cwd,
          timeoutMs: 120_000,
        });
        expectExit(r, 1);
        expect(r.out).toBe("");
        if (arg === "-") expect(r.err).toMatch(BINDING);
      });
    }
  });
}
