// Release 0.2.0 item 7: a pin block may carry `# platforms <p> [<p>...]` after `# version`
// (linux, darwin, windows; rendered from vars.bun_platforms, here with render-pin.ts --platforms).
// A starter whose platform is not listed (`linux`, `darwin`; `windows` for getty-bun.ps1 and the
// Git Bash forwarding): run, run-ready and ensure exit 0 with nothing on stdout and one
// `getty-bun: ` line on stderr, no download, nothing created under GETTY_HOME; `status` prints
//   {"pin":"<v>","target":null,"slot":null,"state":"undeclared"}
// and exits 0. A listed platform behaves as before; a block without the line is unchanged.
//
// The render tests of the platforms line itself are in render-pin.test.ts and
// render-template.test.ts. Not checked here: that an undeclared starter detects no target
// (nothing observable from outside without a probe of its own commands).
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/platforms.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  HOST_PLATFORM,
  IS_WIN,
  REAL_VERSION,
  STARTER,
  cleanupAll,
  exists,
  expectExit,
  failureLine,
  hostTargets,
  plantSlot,
  ranTarget,
  realRoutes,
  sandbox,
  snapshot,
  starter,
  startServer,
  status,
  track,
} from "./lib/harness";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

const ALL = ["linux", "darwin", "windows"];
const OTHERS = ALL.filter((p) => p !== HOST_PLATFORM);

async function serverAndSandbox(platforms: string[] | undefined) {
  const server = startServer(await realRoutes());
  track(() => server.stop());
  const sb = await sandbox({ mirror: server.url, platforms });
  return { server, sb };
}

describe(`item 7: a platform the pin block does not list [${STARTER}]`, () => {
  for (const cmd of [["run", "entries/echo.ts", "3"], ["run-ready", "entries/echo.ts", "3"], ["ensure"]]) {
    test(`${cmd[0]}: exit 0, nothing on stdout, one getty-bun line, nothing under GETTY_HOME, no request`, async () => {
      const { server, sb } = await serverAndSandbox(OTHERS);
      const r = await starter(sb, cmd, { stdin: "must not be echoed\n" });
      expectExit(r, 0);
      expect(r.out).toBe("");
      failureLine(r); // exactly one line, starting "getty-bun: "
      expect(await snapshot(sb.home)).toEqual([]);
      expect(await exists(sb.home)).toBe(false);
      expect(server.total()).toBe(0);
    });
  }

  test("status: the undeclared state with a null target and slot, exit 0, nothing created", async () => {
    const { server, sb } = await serverAndSandbox(OTHERS);
    const r = await starter(sb, ["status"]);
    expectExit(r, 0);
    expect(r.out.trim()).toBe(`{"pin":"${REAL_VERSION}","target":null,"slot":null,"state":"undeclared"}`);
    expect(JSON.parse(r.out)).toEqual({ pin: REAL_VERSION, target: null, slot: null, state: "undeclared" });
    expect(await snapshot(sb.home)).toEqual([]);
    expect(server.total()).toBe(0);
  });

  // Windows legs only (the other starters have no PROCESSOR_ARCHITECTURE to simulate; not registered
  // elsewhere, not a skip): an undeclared platform ends before any architecture check, so an
  // unsupported ARM64 is no failure there.
  if (IS_WIN) {
    for (const cmd of [["ensure"], ["run", "entries/echo.ts", "3"], ["status"]]) {
      test(`PROCESSOR_ARCHITECTURE=ARM64 on an undeclared platform: ${cmd[0]} exits 0, not 1 for the unsupported architecture`, async () => {
        const { server, sb } = await serverAndSandbox(OTHERS);
        const r = await starter(sb, cmd, { env: { PROCESSOR_ARCHITECTURE: "ARM64", PROCESSOR_ARCHITEW6432: null } });
        expectExit(r, 0);
        if (cmd[0] === "status") expect(JSON.parse(r.out)).toEqual({ pin: REAL_VERSION, target: null, slot: null, state: "undeclared" });
        else {
          expect(r.out).toBe("");
          expect(failureLine(r)).not.toMatch(/unsupported target|ARM64/);
        }
        expect(await snapshot(sb.home)).toEqual([]);
        expect(server.total()).toBe(0);
      });
    }
  }

  test("a ready slot does not make the platform declared: run does not start the entry", async () => {
    const { server, sb } = await serverAndSandbox(OTHERS);
    await plantSlot(sb, hostTargets()[0]!);
    const before = await snapshot(sb.home);
    for (const cmd of [["run", "entries/info.ts"], ["run-ready", "entries/info.ts"], ["ensure"]]) {
      const r = await starter(sb, cmd);
      expectExit(r, 0);
      expect(r.out, `${cmd[0]} started the entry`).toBe("");
      failureLine(r);
    }
    expect(await snapshot(sb.home)).toEqual(before);
    expect(server.total()).toBe(0);
  });
});

describe(`item 7: a platform the pin block lists, or no platforms line [${STARTER}]`, () => {
  const cases: Array<[string, string[] | undefined]> = [
    [`only ${HOST_PLATFORM}`, [HOST_PLATFORM]],
    [`${HOST_PLATFORM} among the others`, [...OTHERS, HOST_PLATFORM]],
    ["all three platforms", ALL],
    ["no platforms line", undefined],
  ];
  for (const [label, platforms] of cases) {
    test(`${label}: ensure installs, status is ready, run runs the entry`, async () => {
      const { server, sb } = await serverAndSandbox(platforms);
      const st0 = await status(sb);
      expect(st0.state).toBe("missing");
      expect(hostTargets()).toContain(st0.target);

      const e = await starter(sb, ["ensure"]);
      expectExit(e, 0);
      expect(e.out).toBe("");
      expect(server.archives()).toBe(1);
      expect((await status(sb)).state).toBe("ready");

      const r = await starter(sb, ["run", "entries/echo.ts", "4"], { stdin: "declared\n" });
      expectExit(r, 4);
      expect(r.out).toBe("declared\n");
      const ready = await starter(sb, ["run-ready", "entries/echo.ts", "4"], { stdin: "declared\n" });
      expectExit(ready, 4);
      expect(ready.out).toBe("declared\n");
    });
  }

  test("a listed platform finds a planted slot as before", async () => {
    const { server, sb } = await serverAndSandbox([HOST_PLATFORM]);
    const target = hostTargets()[0]!;
    await plantSlot(sb, target);
    const r = await starter(sb, ["run", "entries/info.ts"]);
    expectExit(r, 0);
    expect(ranTarget(r.out, target)).toBe(true);
    expect(server.total()).toBe(0);
  });
});
