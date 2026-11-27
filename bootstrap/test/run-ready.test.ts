// Release 0.2.0 item 3: `run-ready <entry> [args...]`, a hook that never installs. Slot `ready`:
// exactly `run`. Slot `missing`: exit 0, nothing on stdout, one stderr line
//   getty-bun: Bun <version> <target> is not installed yet (<slot>); run-ready skipped <entry>
// and no lock, no staging, no download. `mismatch`, an invalid environment and an unsupported
// target: as `run`.
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/run-ready.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IS_WIN,
  REAL_VERSION,
  STARTER,
  cleanupAll,
  exists,
  expectExit,
  failureLine,
  hostTargets,
  holdLock,
  install,
  lines,
  lockFile,
  plantSlot,
  realRoutes,
  samePath,
  sandbox,
  snapshot,
  withoutConfigFile,
  starter,
  startServer,
  track,
  type RunResult,
  type StatusJson,
} from "./lib/harness";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

async function realServer() {
  const s = startServer(await realRoutes());
  track(() => s.stop());
  return s;
}

/** The "not installed yet" line, taken apart so the slot path is compared as a path. */
function expectSkipLine(r: RunResult, st: StatusJson, entry: string) {
  const line = failureLine(r);
  const prefix = `getty-bun: Bun ${REAL_VERSION} ${st.target} is not installed yet (`;
  const suffix = `); run-ready skipped ${entry}`;
  expect(line.startsWith(prefix), `line was ${JSON.stringify(line)}`).toBe(true);
  expect(line.endsWith(suffix), `line was ${JSON.stringify(line)}`).toBe(true);
  expect(samePath(line.slice(prefix.length, line.length - suffix.length), st.slot)).toBe(true);
}

describe(`item 3: run-ready [${STARTER}]`, () => {
  test("slot missing: exit 0, empty stdout, the one getty-bun line, nothing created under GETTY_HOME, no request", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const st = JSON.parse((await starter(sb, ["status"])).out) as StatusJson;
    expect(st.state).toBe("missing");

    const r = await starter(sb, ["run-ready", "entries/echo.ts", "3"], { stdin: "never read\n" });
    expectExit(r, 0);
    expect(r.out).toBe("");
    expectSkipLine(r, st, "entries/echo.ts");
    expect(await snapshot(sb.home), "run-ready created something under GETTY_HOME (lock directory, staging, download)").toEqual([]);
    expect(await exists(sb.home)).toBe(false);
    expect(server.total(), "run-ready asked the mirror for something").toBe(0);
  });

  test("slot missing and the install lock held by another process: run-ready neither waits nor takes it", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const st = JSON.parse((await starter(sb, ["status"])).out) as StatusJson;
    const holder = await holdLock(lockFile(sb, REAL_VERSION, st.target), 120);
    const before = await snapshot(sb.home);

    const t0 = performance.now();
    const r = await starter(sb, ["run-ready", "entries/echo.ts"], { env: { GETTY_BUN_LOCK_WAIT: "60" }, timeoutMs: 30_000 });
    const ms = performance.now() - t0;
    expectExit(r, 0);
    expect(r.out).toBe("");
    expectSkipLine(r, st, "entries/echo.ts");
    expect(ms, "run-ready waited for the lock").toBeLessThan(20_000);
    expect(await snapshot(sb.home)).toEqual(before); // only what the holder made: no staging, no .downloads
    expect(server.total()).toBe(0);
    await holder.release();
  });

  test("slot ready: stdin, stdout, stderr and the exit code are those of run", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    const requests = server.total();
    const input = new Uint8Array([...Buffer.from("zeile eins üä\n"), 0, 1, 2, 254, 255, 10, 13, 10]);

    const viaRun = await starter(sb, ["run", "entries/echo.ts", "7"], { stdin: input });
    const ready = await starter(sb, ["run-ready", "entries/echo.ts", "7"], { stdin: input });
    expectExit(viaRun, 7);
    expectExit(ready, 7);
    expect(Buffer.from(viaRun.stdout).equals(Buffer.from(input)), "run did not echo the input").toBe(true);
    expect(Buffer.from(ready.stdout).equals(Buffer.from(input)), "run-ready's stdout differs from the input").toBe(true);
    expect(ready.err).toBe(viaRun.err);
    expect(server.total()).toBe(requests);
  });

  test("slot ready: the entry's arguments and its info are those of run", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    const args = ["a b", "c\"d", "e\\", "über"];
    const viaRun = await starter(sb, ["run", "entries/info.ts", ...args]);
    const ready = await starter(sb, ["run-ready", "entries/info.ts", ...args]);
    expectExit(viaRun, 0);
    expectExit(ready, 0);
    const a = JSON.parse(viaRun.out);
    const b = JSON.parse(ready.out);
    expect(b.argv).toEqual(args);
    expect(b).toEqual(a);
  });

  test("slot mismatch: exit 1, one getty-bun line naming the slot, slot untouched, nothing downloaded", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const target = hostTargets()[0]!; // the first slot that exists wins on x64, so this one is the answer
    const bad = await plantSlot(sb, target, { receiptVersion: "0.0.1" });
    const before = await snapshot(join(sb.home, "runtimes"));

    const r = await starter(sb, ["run-ready", "entries/info.ts"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    expect(failureLine(r)).toContain(bad);
    expect(withoutConfigFile(await snapshot(join(sb.home, "runtimes")))).toEqual(before);
    expect(server.total()).toBe(0);
  });

  test("a relative GETTY_HOME fails as run does: exit 1 naming the variable, nothing created", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const viaRun = await starter(sb, ["run", "entries/info.ts"], { env: { GETTY_HOME: "relative/home" } });
    const ready = await starter(sb, ["run-ready", "entries/info.ts"], { env: { GETTY_HOME: "relative/home" } });
    expectExit(viaRun, 1);
    expectExit(ready, 1);
    expect(ready.out).toBe("");
    expect(failureLine(ready)).toContain("GETTY_HOME");
    expect(failureLine(ready)).toBe(failureLine(viaRun).replace(/ run /, " run-ready "));
    expect(await exists(join(sb.cwd, "relative"))).toBe(false);
    expect(server.total()).toBe(0);
  });

  test("an unsupported target fails as run does: exit 1 naming the target, nothing created", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    let env: Record<string, string | null>;
    let named: RegExp;
    if (IS_WIN) {
      env = { PROCESSOR_ARCHITECTURE: "ARM64", PROCESSOR_ARCHITEW6432: null };
      named = /arm64|aarch64/i;
    } else {
      const dir = join(sb.tmp, "fakeuname");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "uname"), "#!/bin/sh\necho 'Linux armv7l'\n", { mode: 0o755 });
      env = { PATH: `${dir}:${sb.env.PATH}` };
      named = /armv7l/;
    }
    const r = await starter(sb, ["run-ready", "entries/info.ts"], { env });
    expectExit(r, 1);
    expect(r.out).toBe("");
    expect(failureLine(r)).toMatch(named);
    expect(await snapshot(sb.home)).toEqual([]);
    expect(server.total()).toBe(0);
  });

  test("without an entry run-ready is a usage error: exit 1, one getty-bun line", async () => {
    const sb = await sandbox();
    const r = await starter(sb, ["run-ready"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    expect(lines(r.err).length).toBe(1);
    failureLine(r);
  });
});
