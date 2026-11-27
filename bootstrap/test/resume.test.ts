// Release 0.2.0 item 3, downloads: an interrupted install keeps its partial archive and the next
// install resumes it; a starter killed during a download leaves no download process behind.
//
//   - the archive downloads to <GETTY_HOME>/runtimes/bun/.downloads/<version>/<target>/<archive>.part,
//     only under the install lock;
//   - an interrupted install (signal, kill, timeout, network error) keeps the .part; the next
//     install asks for the rest (HTTP Range) and publishes;
//   - a server that answers without a range starts the file over;
//   - a checksum mismatch after the download deletes the .part before the failure;
//   - POSIX: after SIGKILL of the starter, no curl/wget it started is alive about 2 s later.
//
// The server is a fixture (lib/harness.ts startServer): it cuts the first archive response after
// a fixed number of bytes, either by stalling (the connection stays open and silent) or by
// dropping it, and it records every Range header. The processes killed are the starter the
// test spawned and, for cleanup of a red run, the descendants it recorded by PID and start time:
// no pkill, no pattern.
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/resume.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IS_WIN,
  REAL_VERSION,
  STARTER,
  archivePath,
  cleanupAll,
  descendantsOf,
  exists,
  expectExit,
  failureLine,
  fileSize,
  fixtureArchive,
  holdLock,
  killRecorded,
  lockFile,
  pollUntil,
  publishedTargets,
  realRoutes,
  sandbox,
  stagingLeft,
  starter,
  starterCmd,
  startLive,
  startServer,
  status,
  stillRunning,
  track,
  useMirror,
  type FixtureServer,
  type Live,
  type ProcFact,
  type Sandbox,
  type ServerOptions,
} from "./lib/harness";
import { archiveInfo, loadRealTable } from "./lib/table";
import { testWhen } from "./lib/when";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

const MIB = 1024 * 1024;
const CUT_AT = 8 * MIB; // the stalled or dropped response has delivered this much
const SEED = 2 * MIB; // a partial file planted by the test
const NOT_POSIX = "Windows: the kill is a TerminateProcess of the whole tree, which the SIGKILL and SIGTERM tests are not about";

async function serverWith(opts: ServerOptions): Promise<FixtureServer> {
  const s = startServer(await realRoutes(), opts);
  track(() => s.stop());
  return s;
}

/** The target this host installs and where its `.part` lives. */
async function facts(sb: Sandbox) {
  const st = await status(sb);
  const archive = archiveInfo(loadRealTable(), REAL_VERSION, st.target).archive;
  return {
    target: st.target,
    archive,
    url: archivePath(REAL_VERSION, st.target),
    dir: join(sb.home, "runtimes", "bun", ".downloads", REAL_VERSION, st.target),
    part: join(sb.home, "runtimes", "bun", ".downloads", REAL_VERSION, st.target, `${archive}.part`),
    total: (await fixtureArchive(st.target)).length,
  };
}

/** Start `ensure` against a server that cuts its response; return once the .part has data. */
async function startInterruptedInstall(sb: Sandbox, server: FixtureServer, part: string): Promise<Live> {
  useMirror(sb, server.url);
  const live = startLive(starterCmd(sb.root, ["ensure"]), { env: sb.env, cwd: sb.cwd });
  await Promise.race([
    server.cutReached(),
    live.exit(60_000).then((code) => {
      throw new Error(`the install ended (exit ${code}) before the server cut its response; stderr ${JSON.stringify(live.stderr())}`);
    }),
  ]);
  await pollUntil(async () => ((await fileSize(part)) ?? 0) >= 1 * MIB, 30_000, `${part} to hold data`);
  return live;
}

/** After the interruption: the .part is kept, the slot is not published. Returns the part's size. */
async function expectPartKept(sb: Sandbox, f: Awaited<ReturnType<typeof facts>>): Promise<number> {
  const size = await fileSize(f.part);
  expect(size, `the partial archive ${f.part} was not kept`).not.toBeNull();
  expect(size!).toBeGreaterThan(0);
  expect(size!).toBeLessThan(f.total);
  expect(await publishedTargets(sb, REAL_VERSION)).toEqual([]);
  return size!;
}

/** The next install, from a server that answers ranges: asks for the rest only, publishes. */
async function expectResumes(sb: Sandbox, f: Awaited<ReturnType<typeof facts>>, partSize: number, o: { killed?: boolean } = {}) {
  const next = await serverWith({ ranges: true });
  useMirror(sb, next.url);
  const r = await starter(sb, ["ensure"]);
  expectExit(r, 0);
  expect(r.out).toBe("");
  const archiveRequests = next.requests.filter((q) => q.path === f.url);
  expect(archiveRequests.length, "the install asked for the archive more than once").toBe(1);
  expect(archiveRequests[0]!.range, "the install did not ask for the rest of the archive").toBe(`bytes=${partSize}-`);
  expect(next.bytesServed(), "the install downloaded more than the rest").toBe(f.total - partSize);
  expect((await status(sb)).state).toBe("ready");
  // a SIGKILLed starter cannot clean its own staging directory, and the next install does not
  // sweep it (staging is unchanged by item 3): only a starter that ended on its own leaves none
  if (!o.killed) expect(await stagingLeft(sb)).toEqual([]);
  const ran = await starter(sb, ["run", "entries/info.ts"]);
  expectExit(ran, 0);
  expect(JSON.parse(ran.out).version).toBe(REAL_VERSION);
}

const ENDINGS = [
  ["drop", "the connection drops after N bytes"],
  // Windows PowerShell 5.1 can read a body that ends early and cleanly as the whole file; the
  // starter must fail on it and keep the .part (the checksum failure of the whole file would delete it)
  ["end", "the body ends early and cleanly after N bytes, shorter than its Content-Length"],
] as const;

describe(`item 3: a download that is interrupted is resumed [${STARTER}]`, () => {
  for (const [mode, what] of ENDINGS) test(`${what}: the install fails (exit 1, one line, staging clean), the .part stays, the next install requests only the rest and publishes`, async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const drop = await serverWith({ ranges: true, cut: { afterBytes: CUT_AT, mode } });
    useMirror(sb, drop.url);

    const r = await starter(sb, ["ensure"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    failureLine(r);
    expect(await stagingLeft(sb)).toEqual([]);
    const size = await expectPartKept(sb, f);
    expect(size, "the .part holds nothing of what arrived before the drop").toBeGreaterThanOrEqual(CUT_AT / 2);
    await expectResumes(sb, f, size);
  });

  testWhen(!IS_WIN, NOT_POSIX, "SIGTERM during the download: the starter ends, the .part stays, the next install resumes it", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const stall = await serverWith({ ranges: true, cut: { afterBytes: CUT_AT, mode: "stall" } });
    const live = await startInterruptedInstall(sb, stall, f.part);
    const kids: ProcFact[] = descendantsOf(live.pid);
    track(() => killRecorded(kids)); // a red run must not leave its curl behind

    live.kill("SIGTERM");
    await live.exit(30_000);
    await Bun.sleep(1000);
    killRecorded(kids); // a download child that outlived the starter would keep writing; stop it so the size is stable
    await expectPartKept(sb, f);
    const size = (await fileSize(f.part))!;
    await expectResumes(sb, f, size);
  });

  testWhen(!IS_WIN, NOT_POSIX, "SIGKILL during the download: the .part stays, the next install resumes it", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const stall = await serverWith({ ranges: true, cut: { afterBytes: CUT_AT, mode: "stall" } });
    const live = await startInterruptedInstall(sb, stall, f.part);
    const kids: ProcFact[] = descendantsOf(live.pid);
    track(() => killRecorded(kids));

    live.kill("SIGKILL");
    await live.exit(30_000);
    await Bun.sleep(3000);
    killRecorded(kids); // the orphan check is the next test; here the size must be stable
    await expectPartKept(sb, f);
    await expectResumes(sb, f, (await fileSize(f.part))!, { killed: true });
  });

  testWhen(IS_WIN, "POSIX has the SIGTERM and SIGKILL tests; this is the Windows one", "the starter is ended during the download (taskkill /T /F): the .part stays, the next install resumes it", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const stall = await serverWith({ ranges: true, cut: { afterBytes: CUT_AT, mode: "stall" } });
    const live = await startInterruptedInstall(sb, stall, f.part);
    live.kill();
    await live.exit(30_000);
    await Bun.sleep(1000);
    await expectPartKept(sb, f);
    await expectResumes(sb, f, (await fileSize(f.part))!, { killed: true });
  });

  testWhen(!IS_WIN, "Windows: getty-bun.ps1 downloads in process and has no child to orphan", "SIGKILL of the starter during a download leaves no curl or wget it started running about 3 s later", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const stall = await serverWith({ ranges: true, cut: { afterBytes: CUT_AT, mode: "stall" } });
    const live = await startInterruptedInstall(sb, stall, f.part);
    const kids = descendantsOf(live.pid); // what the starter started, found by parent PID before the kill
    track(() => killRecorded(kids));
    const downloaders = kids.filter((k) => /^(curl|wget)/.test(k.comm.split("/").pop()!)); // macOS ps prints the path
    expect(downloaders.length, `no curl or wget among the starter's descendants: ${JSON.stringify(kids)}`).toBeGreaterThan(0);

    live.kill("SIGKILL");
    await live.exit(30_000);
    await Bun.sleep(3000);
    const alive = downloaders.filter(stillRunning);
    expect(alive, `download processes still running 3 s after the starter was killed: ${JSON.stringify(alive)}`).toEqual([]);
  });
});

describe(`item 3: what a resumed download may and may not do [${STARTER}]`, () => {
  test("a corrupted .part: the resumed archive fails its checksum (exit 1, one line naming it), the .part is deleted, nothing published, and the next install starts over", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const bytes = Buffer.from(await fixtureArchive(f.target));
    const seeded = Buffer.from(bytes.subarray(0, SEED));
    seeded[1000] = seeded[1000]! ^ 0xff;
    await mkdir(f.dir, { recursive: true });
    await writeFile(f.part, seeded);
    const first = await serverWith({ ranges: true });
    useMirror(sb, first.url);

    const r = await starter(sb, ["ensure"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    expect(failureLine(r)).toMatch(/checksum/i);
    expect(first.requests.find((q) => q.path === f.url)?.range, "the install did not resume the planted .part").toBe(`bytes=${SEED}-`);
    expect(await exists(f.part), "the corrupted .part was kept").toBe(false);
    expect(await publishedTargets(sb, REAL_VERSION)).toEqual([]);
    expect(await stagingLeft(sb)).toEqual([]);

    const again = await serverWith({ ranges: true });
    useMirror(sb, again.url);
    expectExit(await starter(sb, ["ensure"]), 0);
    expect(again.requests.find((q) => q.path === f.url)?.range, "the next install resumed a file that had been deleted").toBeNull();
    expect(again.bytesServed()).toBe(f.total);
    expect((await status(sb)).state).toBe("ready");
  });

  test("a server that ignores Range and answers 200 with the whole file: the install starts the file over and succeeds", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const bytes = await fixtureArchive(f.target);
    await mkdir(f.dir, { recursive: true });
    await writeFile(f.part, bytes.subarray(0, SEED)); // the true prefix: appending a whole body to it would corrupt it
    const plain = await serverWith({ ranges: false });
    useMirror(sb, plain.url);

    const r = await starter(sb, ["ensure"]);
    expectExit(r, 0);
    expect(r.out).toBe("");
    // Either one request whose 200 answer replaces the file, or the first one refused and a second
    // from the start; never an answer appended to the planted prefix (that would fail the checksum).
    const asked = plain.requests.filter((q) => q.path === f.url);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked.length).toBeLessThanOrEqual(2);
    expect(asked[0]!.range, "the install did not try to resume").toBe(`bytes=${SEED}-`);
    expect(asked[0]!.status).toBe(200);
    for (const later of asked.slice(1)) expect(later.range, "a later request still asked for a range").toBeNull();
    expect((await status(sb)).state).toBe("ready");
    expect(await stagingLeft(sb)).toEqual([]);
  });

  test("a complete .part: the server answers 416, the starter keeps the file, the checksum passes and the install publishes without downloading the archive again", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    await mkdir(f.dir, { recursive: true });
    await writeFile(f.part, await fixtureArchive(f.target));
    const server = await serverWith({ ranges: true });
    useMirror(sb, server.url);

    const r = await starter(sb, ["ensure"]);
    expectExit(r, 0);
    expect(r.out).toBe("");
    const asked = server.requests.filter((q) => q.path === f.url);
    expect(asked.length, "the install did not ask the server for the archive").toBeGreaterThanOrEqual(1);
    expect(asked[0]!.range, "the install did not try to resume the complete .part").toBe(`bytes=${f.total}-`);
    expect(asked[0]!.status).toBe(416);
    expect(server.bytesServed(), "the install downloaded the archive again").toBe(0);
    expect(await exists(f.part), "the .part of a published install is still there").toBe(false);
    expect((await status(sb)).state).toBe("ready");
    expect(await stagingLeft(sb)).toEqual([]);
  });

  test("an oversize .part (the archive and more): 416, the checksum fails (exit 1, one line naming it), the .part is deleted, and the next install starts over", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    await mkdir(f.dir, { recursive: true });
    await writeFile(f.part, Buffer.concat([Buffer.from(await fixtureArchive(f.target)), Buffer.from("trailing bytes of a bigger file")]));
    const first = await serverWith({ ranges: true });
    useMirror(sb, first.url);

    const r = await starter(sb, ["ensure"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    expect(failureLine(r)).toMatch(/checksum/i);
    expect(first.bytesServed(), "the install downloaded a body for a .part that was already too long").toBe(0);
    expect(await exists(f.part), "the oversize .part was kept").toBe(false);
    expect(await publishedTargets(sb, REAL_VERSION)).toEqual([]);
    expect(await stagingLeft(sb)).toEqual([]);

    const again = await serverWith({ ranges: true });
    useMirror(sb, again.url);
    expectExit(await starter(sb, ["ensure"]), 0);
    expect(again.requests.find((q) => q.path === f.url)?.range, "the next install resumed a file that had been deleted").toBeNull();
    expect(again.bytesServed()).toBe(f.total);
    expect((await status(sb)).state).toBe("ready");
  });

  test("the .part is made only under the install lock: a waiter whose wait runs out creates no .downloads and asks for nothing", async () => {
    const sb = await sandbox();
    const f = await facts(sb);
    const server = await serverWith({ ranges: true });
    useMirror(sb, server.url);
    const holder = await holdLock(lockFile(sb, REAL_VERSION, f.target), 60);

    const r = await starter(sb, ["ensure"], { env: { GETTY_BUN_LOCK_WAIT: "2" } });
    expectExit(r, 1);
    failureLine(r);
    expect(await exists(join(sb.home, "runtimes", "bun", ".downloads")), ".downloads was created without the lock").toBe(false);
    expect(server.total()).toBe(0);
    await holder.release();
    await rm(join(sb.home, "runtimes", "bun", ".locks"), { recursive: true, force: true });
  });
});
