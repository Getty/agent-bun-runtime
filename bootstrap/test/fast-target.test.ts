// Release 0.2.0 item 1: the starter takes the first slot that exists of `<os>-x64`, then
// `<os>-x64-baseline`, and detects the CPU only when neither exists. (getty-bun.ps1 did this
// already; getty-bun.sh did not.) Slots are planted by hand (plantSlot), so no download and no
// real Bun is needed: the fast path never runs the slot's Bun to check it.
//
// A starter that detected the CPU first would pick one target on this machine and miss a slot
// of the other: the two single-slot tests plant each target in turn, so on any x64 host one of
// them is the slot detection would not choose. Hosts without the x64/baseline pair (arm64,
// macOS: no darwin-x64-baseline) skip these tests, with the reason in the name.
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/fast-target.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  REAL_VERSION,
  STARTER,
  cleanupAll,
  expectExit,
  failureLine,
  hostHasAvx2,
  hostTargets,
  plantSlot,
  ranTarget,
  realRoutes,
  samePath,
  sandbox,
  slotDir,
  snapshot,
  starter,
  startServer,
  track,
  type StatusJson,
} from "./lib/harness";
import { testWhen } from "./lib/when";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

const targets = hostTargets();
const hasPair = targets.length === 2 && targets[0]!.endsWith("-x64") && targets[1]!.endsWith("-x64-baseline");
const NO_PAIR = `host ${process.platform}/${process.arch} has no <os>-x64 and <os>-x64-baseline pair`;
const [X64, BASELINE] = hasPair ? [targets[0]!, targets[1]!] : ["", ""];

async function emptyServer() {
  const s = startServer(await realRoutes());
  track(() => s.stop());
  return s;
}

describe(`item 1: the x64 slot choice [${STARTER}]`, () => {
  for (const which of ["x64", "baseline"] as const) {
    testWhen(
      hasPair,
      NO_PAIR,
      `a ready ${which} slot alone is reported ready and run, with no detection and no download`,
      async () => {
        const target = which === "x64" ? X64 : BASELINE;
        const server = await emptyServer();
        const sb = await sandbox({ mirror: server.url });
        const slot = await plantSlot(sb, target);

        const st = JSON.parse((await starter(sb, ["status"])).out) as StatusJson;
        expect(st.target).toBe(target);
        expect(st.state).toBe("ready");
        expect(samePath(st.slot, slot)).toBe(true);

        const ensured = await starter(sb, ["ensure"]);
        expectExit(ensured, 0);
        expect(ensured.out).toBe("");

        const r = await starter(sb, ["run", "entries/info.ts", "one", "two"]);
        expectExit(r, 0);
        expect(ranTarget(r.out, target), `the ${target} slot did not run: stdout ${JSON.stringify(r.out)}, stderr ${JSON.stringify(r.err)}`).toBe(true);
        expect(server.total(), "the fast path made a request").toBe(0);
        // nothing but the planted slot exists: no other slot, no lock, no staging
        const left = await snapshot(join(sb.home, "runtimes"));
        expect(left.filter((l) => !l.startsWith(`bun/${REAL_VERSION}/${target}/`) && l !== `bun/` && l !== `bun/${REAL_VERSION}/`)).toEqual([]);
      },
    );
  }

  for (const which of ["x64", "baseline"] as const) {
    testWhen(
      hasPair,
      NO_PAIR,
      `a mismatching ${which} slot alone fails closed: run names it, nothing is downloaded, the slot is untouched`,
      async () => {
        const target = which === "x64" ? X64 : BASELINE;
        const server = await emptyServer();
        const sb = await sandbox({ mirror: server.url });
        const bad = await plantSlot(sb, target, { receiptVersion: "0.0.1" });
        const before = await snapshot(join(sb.home, "runtimes"));
        const r = await starter(sb, ["run", "entries/info.ts"]);
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(failureLine(r)).toContain(bad);
        expect((JSON.parse((await starter(sb, ["status"])).out) as StatusJson).state).toBe("mismatch");
        expect(await snapshot(join(sb.home, "runtimes"))).toEqual(before);
        expect(server.total()).toBe(0);
      },
    );
  }

  testWhen(hasPair, NO_PAIR, "with both slots ready the x64 one runs", async () => {
    const server = await emptyServer();
    const sb = await sandbox({ mirror: server.url });
    await plantSlot(sb, X64);
    await plantSlot(sb, BASELINE);
    const r = await starter(sb, ["run", "entries/info.ts"]);
    expectExit(r, 0);
    expect(ranTarget(r.out, X64), `stdout ${JSON.stringify(r.out)}`).toBe(true);
    expect((JSON.parse((await starter(sb, ["status"])).out) as StatusJson).target).toBe(X64);
    expect(server.total()).toBe(0);
  });

  testWhen(
    hasPair,
    NO_PAIR,
    "a mismatching x64 slot is not skipped for a ready baseline one: run and ensure fail naming the x64 slot, status says mismatch",
    async () => {
      const server = await emptyServer();
      const sb = await sandbox({ mirror: server.url });
      const bad = await plantSlot(sb, X64, { receiptVersion: "0.0.1" });
      await plantSlot(sb, BASELINE);
      const before = await snapshot(join(sb.home, "runtimes"));

      for (const args of [["run", "entries/info.ts"], ["ensure"]]) {
        const r = await starter(sb, args);
        expectExit(r, 1);
        expect(r.out, `${args[0]} ran the baseline slot: ${r.out}`).toBe("");
        expect(failureLine(r)).toContain(bad);
      }
      const st = JSON.parse((await starter(sb, ["status"])).out) as StatusJson;
      expect(st.target).toBe(X64);
      expect(st.state).toBe("mismatch");
      expect(samePath(st.slot, bad)).toBe(true);
      expect(await snapshot(join(sb.home, "runtimes"))).toEqual(before);
      expect(server.total()).toBe(0);
    },
  );

  test("status with neither slot reports missing and the detected target; nothing is created", async () => {
    const server = await emptyServer();
    const sb = await sandbox({ mirror: server.url });
    const r = await starter(sb, ["status"]);
    expectExit(r, 0);
    const st = JSON.parse(r.out) as StatusJson;
    expect(st.pin).toBe(REAL_VERSION);
    expect(st.state).toBe("missing");
    expect(targets).toContain(st.target);
    if (hasPair && hostHasAvx2() !== null) {
      expect(st.target, `AVX2 ${hostHasAvx2() ? "present" : "absent"} on this CPU`).toBe(hostHasAvx2() ? X64 : BASELINE);
    }
    expect(samePath(st.slot, slotDir(sb, REAL_VERSION, st.target))).toBe(true);
    expect(await snapshot(sb.home)).toEqual([]);
    expect(server.total()).toBe(0);
  });
});
