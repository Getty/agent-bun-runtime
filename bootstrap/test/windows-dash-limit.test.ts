// Characterization of PowerShell's own `-File` limit, not a getty-bun promise. Facts, by CI run:
// 46031834399 (jobs 140617316414 windows powershell, 140617316507 windows pwsh): direct on Windows
// PowerShell 5.1 a lone last `-` fails with exit 1 and `Cannot process argument because the value of
// argument "name" is not valid` (no failure annotation for that test), direct `-:foo` exits 0 on 5.1
// and 1 on pwsh 7, a lone `-` passes on pwsh 7. 46027293350: on 5.1 a `-` followed by another argument
// fails with that message. Not asserted, because the annotations do not tell which row hit what: the
// lone `-` and `-:foo` through Git Bash forwarding and the polyglot. The polyglot rows are in
// polyglot.test.ts. Windows only: nothing is registered elsewhere.
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
      test("pwsh 7: a `-` followed by another argument is accepted and reaches the entry", async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", "-", "x"]);
        expectExit(r, 0);
        expect(JSON.parse(r.out).argv).toEqual(["-", "x"]);
      });
      test("pwsh 7: the argument `-:foo` fails -File binding, exit 1, nothing on stdout", async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", "-:foo"]);
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(r.err.length).toBeGreaterThan(0);
      });
    } else {
      test("Windows PowerShell 5.1: a lone last `-` fails -File binding, exit 1, nothing on stdout", async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", "-"]);
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(r.err).toMatch(BINDING);
      });
      test("Windows PowerShell 5.1: a `-` followed by another argument fails -File binding, exit 1, nothing on stdout", async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", "-", "x"]);
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(r.err).toMatch(BINDING);
      });
      test("Windows PowerShell 5.1: the argument `-:foo` passes -File, exit 0 (not rejected as on pwsh 7)", async () => {
        const sb = await installed();
        const r = await starter(sb, ["run", "entries/info.ts", "-:foo"]);
        // Exit 0 only: runs 46031834399 and 46035250753 were green here, but the entry's argv was not
        // observed, so it is not asserted that it is exactly ["-:foo"].
        expectExit(r, 0);
      });
    }

    // The sh starter forwards to PowerShell 5.1 under Git Bash, so the 5.1 limit shows on both legs.
    test("through the Git Bash forwarding (Windows PowerShell 5.1): a `-` followed by another argument fails, exit 1, nothing on stdout", async () => {
      const bash = findGitBashExe();
      if (bash === null) throw new Error("Git Bash bash.exe not found: a Windows leg needs it");
      const sb = await installed();
      const r = await run([bash, join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), "run", "entries/info.ts", "-", "x"], {
        env: sb.env,
        cwd: sb.cwd,
        timeoutMs: 120_000,
      });
      expectExit(r, 1);
      expect(r.out).toBe("");
      expect(r.err).toMatch(BINDING);
    });
  });
}
