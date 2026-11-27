// Release 0.2.0 item 4: every entry argument reaches the entry byte for byte, also the ones that
// begin with `-`: `-x`, `-x:foo`, `--`, `-`, `--%`, `-File`, `-Command x` (skilletor F4). Until
// 0.2.0 getty-bun.ps1 started with `-File`, so PowerShell's parameter binding took arguments
// that begin with `-` for its own. The rule "entry arguments never begin with `-`" is withdrawn.
//
// Control: a raw Bun hands the same list to the same entry unchanged, so a green starter run cannot
// mean the entry never saw dashes. The other ways of starting the starter are in polyglot.test.ts
// (the .cmd, item 6); here: the starter itself, and on Windows legs the Git Bash forwarding.
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/entry-args.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  IS_WIN,
  STARTER,
  cleanupAll,
  expectExit,
  findGitBashExe,
  install,
  realRoutes,
  run,
  sandbox,
  starter,
  startServer,
  track,
} from "./lib/harness";
import { ENTRY_ARGS } from "./lib/args";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

async function installed() {
  const server = startServer(await realRoutes());
  track(() => server.stop());
  const sb = await sandbox({ mirror: server.url });
  await install(sb);
  return sb;
}

describe(`item 4: arguments that begin with a dash [${STARTER}]`, () => {
  test("control: a raw Bun passes the whole list to the entry unchanged", async () => {
    const sb = await sandbox();
    const r = await run([process.execPath, "--no-install", join(sb.root, "entries", "info.ts"), ...ENTRY_ARGS], { env: sb.env, cwd: sb.cwd });
    expectExit(r, 0);
    expect(JSON.parse(r.out).argv).toEqual(ENTRY_ARGS);
  });

  test("the whole list reaches the entry in order, byte for byte", async () => {
    const sb = await installed();
    const r = await starter(sb, ["run", "entries/info.ts", ...ENTRY_ARGS]);
    expectExit(r, 0);
    expect(JSON.parse(r.out).argv).toEqual(ENTRY_ARGS);
  });

  test("each argument alone reaches the entry byte for byte (a lone `--` as the first one is dropped by Bun itself)", async () => {
    const sb = await installed();
    for (const arg of ENTRY_ARGS) {
      // Bun 1.4.5 consumes a `--` that directly follows the entry (raw control: `bun entry --` gives
      // no argument at all, `bun entry x --` keeps it). The starter cannot change that, so for that
      // one case the expectation is what a raw Bun does; every other argument must arrive as is.
      const raw = await run([process.execPath, "--no-install", join(sb.root, "entries", "info.ts"), arg], { env: sb.env, cwd: sb.cwd });
      const want = arg === "--" ? (JSON.parse(raw.out).argv as string[]) : [arg];
      if (arg !== "--") expect(JSON.parse(raw.out).argv, `control for ${JSON.stringify(arg)}`).toEqual(want);
      const r = await starter(sb, ["run", "entries/info.ts", arg]);
      expectExit(r, 0);
      expect(JSON.parse(r.out).argv, `argument ${JSON.stringify(arg)}`).toEqual(want);
    }
  });

  test("a dash argument after a plain one, and the entry's exit code, still pass through", async () => {
    const sb = await installed();
    const r = await starter(sb, ["run", "entries/echo.ts", "7", "-x", "--", "-File"], { stdin: "in\n" });
    expectExit(r, 7);
    expect(r.out).toBe("in\n");
  });

  test("run-ready passes the same list through", async () => {
    const sb = await installed();
    const r = await starter(sb, ["run-ready", "entries/info.ts", ...ENTRY_ARGS]);
    expectExit(r, 0);
    expect(JSON.parse(r.out).argv).toEqual(ENTRY_ARGS);
  });

  test("the first run of a fresh install passes them too", async () => {
    const server = startServer(await realRoutes());
    track(() => server.stop());
    const sb = await sandbox({ mirror: server.url });
    const r = await starter(sb, ["run", "entries/info.ts", ...ENTRY_ARGS]);
    expect(server.archives(), "this run did not install").toBe(1);
    expectExit(r, 0);
    expect(JSON.parse(r.out).argv).toEqual(ENTRY_ARGS);
  });

  // On a Windows leg a missing Git Bash is a failure, never a skip; elsewhere the test is not applicable
  // The test runs on every Windows leg, whichever starter is under test.
  const bash = IS_WIN ? findGitBashExe() : null;
  if (IS_WIN) {
    test(
      "through the Git Bash forwarding: getty-bun.sh hands the list to PowerShell unchanged",
      async () => {
        if (bash === null) throw new Error("Git Bash bash.exe not found (looked via `git --exec-path` and the standard install paths): a Windows leg needs it");
        await throughGitBash(bash);
      },
    );
  }
});

async function throughGitBash(bash: string) {
  const sb = await installed();
  const r = await run([bash, join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), "run", "entries/info.ts", ...ENTRY_ARGS], {
    env: sb.env,
    cwd: sb.cwd,
    timeoutMs: 120_000,
  });
  expectExit(r, 0);
  expect(JSON.parse(r.out).argv).toEqual(ENTRY_ARGS);
}
