// The phase 1 scenario suite (docs/plan.md, "Phase 1 scenarios"), run against the starter
// named by GETTY_BUN_TEST_STARTER: sh, powershell or pwsh.
//
//   bun bootstrap/test/fetch-fixtures.ts     once: real 1.4.5 archives into .dev/fixtures
//   bun test bootstrap/test                  the suite (never downloads from GitHub)
//   GETTY_BUN_TEST_REAL=1 bun test ...       also the one test against the real release

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { archiveInfo, loadRealTable } from "./lib/table";
import { fileEntry, readZip, writeZip } from "./lib/zip";
import {
  IS_WIN,
  REAL_VERSION,
  STARTER,
  UMLAUTS,
  archivePath,
  expectExit,
  failureLine,
  fakeBunDir,
  findGitBashExe,
  hostTargets,
  samePath,
  holdLock,
  install,
  listDir,
  lockFile,
  publishedTargets,
  realRoutes,
  run,
  sandbox,
  slotBun,
  slotDir,
  snapshot,
  stagingLeft,
  starter,
  starterCmd,
  startServer,
  tryLock,
  status,
  tableForArchives,
  sha256Hex,
  exists,
  fixtureArchive,
  track,
  type Sandbox,
} from "./lib/harness";

setDefaultTimeout(300_000);

const realTable = loadRealTable();

function serve(routes: Record<string, Uint8Array>, delayMs?: number) {
  const s = startServer(routes, { delayMs });
  track(() => s.stop());
  return s;
}
async function realServer(delayMs?: number) {
  return serve(await realRoutes(), delayMs);
}

const slotOf = (sb: Sandbox, target: string) => slotDir(sb, REAL_VERSION, target);

// ---------------------------------------------------------------------------------------
describe(`scenario 1: fresh install, then the fast path [${STARTER}]`, () => {
  test("status is missing before, ensure installs once, status is ready, second ensure makes no request", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });

    const before = await starter(sb, ["status"]);
    expectExit(before, 0);
    const st = JSON.parse(before.out);
    expect(Object.keys(st).sort()).toEqual(["pin", "slot", "state", "target"]);
    expect(st.pin).toBe(REAL_VERSION);
    expect(st.state).toBe("missing");
    expect(hostTargets()).toContain(st.target);
    expect(samePath(st.slot, slotOf(sb, st.target))).toBe(true);
    expect(server.total()).toBe(0);
    expect(await exists(st.slot)).toBe(false);

    const first = await starter(sb, ["ensure"]);
    expectExit(first, 0);
    expect(first.out).toBe("");
    expect(server.archives()).toBe(1);
    expect(server.count(archivePath(REAL_VERSION, st.target))).toBe(1);
    expect(server.total()).toBe(1);
    expect(await exists(slotBun(st.slot))).toBe(true);
    expect(await exists(join(st.slot, "receipt.json"))).toBe(true);
    expect(await stagingLeft(sb)).toEqual([]);

    const after = await status(sb);
    expect(after).toEqual({ ...st, state: "ready" });

    const second = await starter(sb, ["ensure"]);
    expectExit(second, 0);
    expect(second.out).toBe("");
    expect(server.total()).toBe(1); // zero new requests

    const third = await starter(sb, ["run", "entries/info.ts"]);
    expectExit(third, 0);
    expect(server.total()).toBe(1);
    expect(JSON.parse(third.out).version).toBe(REAL_VERSION);
  });

  test("the installed slot's Bun is the pinned one and runs", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const st = await install(sb);
    const r = await run([slotBun(st.slot), "--version"], { env: sb.env, cwd: sb.cwd, timeoutMs: 30_000 });
    expectExit(r, 0);
    expect(r.out.trim()).toBe(REAL_VERSION);
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 2: parallel ensure [${STARTER}]`, () => {
  test("four parallel ensure: one archive request, one published slot, all exit 0, staging empty", async () => {
    const server = await realServer(1500); // slow archive: the others reach the lock while it is held
    const sb = await sandbox({ mirror: server.url });
    const results = await Promise.all([1, 2, 3, 4].map(() => starter(sb, ["ensure"])));
    for (const r of results) {
      expect(r.err).toBe(""); // a successful ensure is silent, waiters included
      expectExit(r, 0);
      expect(r.out).toBe("");
    }
    expect(server.archives()).toBe(1);
    const published = await publishedTargets(sb, REAL_VERSION);
    expect(published.length).toBe(1);
    const st = await status(sb);
    expect(published).toEqual([st.target]);
    expect(st.state).toBe("ready");
    expect(await stagingLeft(sb)).toEqual([]);
  });
});

describe(`scenario 2b: the install lock is not leaked into Bun [${STARTER}]`, () => {
  test("while an entry runs under a fresh install, the test can take the install lock without waiting", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const st = await status(sb);
    const proc = Bun.spawn({
      cmd: starterCmd(sb.root, ["run", "entries/wait.ts"]),
      env: sb.env,
      cwd: sb.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    track(() => void proc.kill()); // only the process this test started
    const errP = new Response(proc.stderr).text();
    const reader = proc.stdout.getReader();
    let seen = "";
    const deadline = Date.now() + 120_000;
    while (!seen.includes("ready\n") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (value) seen += new TextDecoder().decode(value);
      if (done) break;
    }
    expect(seen).toContain("ready\n"); // installed, published, entry running
    expect(await exists(slotBun(st.slot))).toBe(true);

    const lock = await tryLock(lockFile(sb, REAL_VERSION, st.target));
    expect(lock.err).toBe("");
    expectExit(lock, 0); // 1 would mean the starter's lock descriptor leaked into Bun

    proc.stdin.end();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) rest += new TextDecoder().decode(value);
      if (done) break;
    }
    expect(await proc.exited).toBe(5);
    expect(rest).toBe("done\n");
    expect(await errP).toBe("");
    expect(server.archives()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 3: a waiter whose lock wait runs out [${STARTER}]`, () => {
  test("lock held by a fixture process, GETTY_BUN_LOCK_WAIT=2: exit 1, getty-bun line, no slot, no staging, no download", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const st = await status(sb);
    const holder = await holdLock(lockFile(sb, REAL_VERSION, st.target));

    const r = await starter(sb, ["ensure"], { env: { GETTY_BUN_LOCK_WAIT: "2" }, timeoutMs: 60_000 });
    expectExit(r, 1);
    expect(r.out).toBe("");
    const msg = failureLine(r);
    expect(msg).toMatch(/time(d)? ?out/i);
    expect(msg).toContain(lockFile(sb, REAL_VERSION, st.target)); // names the lock it waited for
    expect(r.ms).toBeGreaterThan(1500); // it did wait for the lock
    expect(r.ms).toBeLessThan(40_000); // and gave up
    expect(await exists(st.slot)).toBe(false);
    expect(await stagingLeft(sb)).toEqual([]);
    expect(server.archives()).toBe(0); // the download happens under the lock

    // the lock was never stolen: after the holder lets go, the next call installs
    await holder.release();
    const ok = await starter(sb, ["ensure"]);
    expectExit(ok, 0);
    expect((await status(sb)).state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 4: wrong checksum [${STARTER}]`, () => {
  test("a corrupted archive is rejected: exit 1, no slot, staging cleaned", async () => {
    const routes = await realRoutes();
    for (const k of Object.keys(routes)) {
      const bad = new Uint8Array(routes[k]!); // copy; flip a byte in the middle
      bad[bad.length >> 1] ^= 0xff;
      routes[k] = bad;
    }
    const server = serve(routes);
    const sb = await sandbox({ mirror: server.url }); // the real pin
    const st = await status(sb);

    const r = await starter(sb, ["ensure"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    expect(failureLine(r)).toMatch(/sha-?256|checksum/i);
    expect(server.archives()).toBe(1); // it was fetched, then judged
    expect(await exists(st.slot)).toBe(false);
    expect(await publishedTargets(sb, REAL_VERSION)).toEqual([]);
    expect(await stagingLeft(sb)).toEqual([]);
    expect((await status(sb)).state).toBe("missing");
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 5: unexpected or extra archive member [${STARTER}]`, () => {
  async function variant(kind: "extra" | "renamed") {
    const archives: Record<string, Uint8Array> = {};
    const members: Record<string, string> = {};
    for (const t of hostTargets()) {
      const entries = readZip(await fixtureArchive(t));
      const member = archiveInfo(realTable, REAL_VERSION, t).member;
      const dir = member.includes("/") ? member.slice(0, member.lastIndexOf("/") + 1) : "";
      expect(entries.some((e) => e.name === member)).toBe(true); // the fixture holds the member
      if (kind === "extra") {
        entries.push(fileEntry(`${dir}extra-member.txt`, new TextEncoder().encode("not part of Bun\n")));
      } else {
        for (const e of entries) if (e.name === member) e.name = `${dir}not-bun`;
      }
      archives[t] = writeZip(entries);
      members[t] = member; // the table still expects the original member name
    }
    const version = REAL_VERSION;
    const table = tableForArchives(version, archives, members);
    const server = serve(
      Object.fromEntries(Object.entries(archives).map(([t, b]) => [archivePath(version, t), b])),
    );
    const sb = await sandbox({ mirror: server.url, table, version });
    return { sb, server };
  }

  for (const kind of ["extra", "renamed"] as const) {
    test(`${kind === "extra" ? "an extra member" : "a missing expected member (renamed)"} is rejected: exit 1, no slot, staging cleaned`, async () => {
      const { sb, server } = await variant(kind);
      const st = await status(sb);
      const r = await starter(sb, ["ensure"]);
      expectExit(r, 1);
      expect(r.out).toBe("");
      // names the rejected entry, so a ZipFile that cannot read the archive at all stays red
      expect(failureLine(r)).toContain(kind === "extra" ? "extra-member.txt" : "not-bun");
      expect(server.archives()).toBe(1); // the checksum matched, so it got as far as the member check
      expect(await exists(st.slot)).toBe(false);
      expect(await stagingLeft(sb)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------
describe(`scenario 6: a slot that does not match fails closed [${STARTER}]`, () => {
  test("a tampered receipt version: run, ensure fail with the slot path, slot untouched, no download; status says mismatch", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const st = await install(sb);
    const receiptPath = join(st.slot, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(receipt.version).toBe(REAL_VERSION); // README: receipt.json carries `version`
    receipt.version = "0.0.1";
    await writeFile(receiptPath, JSON.stringify(receipt));
    const before = await snapshot(join(sb.home, "runtimes"));
    const requests = server.total();

    for (const args of [["ensure"], ["run", "entries/info.ts"]]) {
      const r = await starter(sb, args);
      expectExit(r, 1);
      expect(r.out).toBe("");
      const msg = failureLine(r);
      expect(msg).toContain(st.slot);
    }
    expect(await snapshot(join(sb.home, "runtimes"))).toEqual(before); // never repaired or overwritten
    expect(server.total()).toBe(requests);

    const s = await starter(sb, ["status"]);
    expectExit(s, 0);
    expect(JSON.parse(s.out).state).toBe("mismatch");
  });

  test("a Bun whose --version differs from the pin is rejected at install: exit 1, no slot, staging cleaned", async () => {
    // pin 1.4.4 to the checksum of the real 1.4.5 archive: the hash matches, the Bun says 1.4.5
    const archives: Record<string, Uint8Array> = {};
    for (const t of hostTargets()) archives[t] = await fixtureArchive(t);
    const version = "1.4.4";
    const table = tableForArchives(version, archives);
    const server = serve(Object.fromEntries(Object.entries(archives).map(([t, b]) => [archivePath(version, t), b])));
    const sb = await sandbox({ mirror: server.url, table, version });
    const st = await status(sb);
    expect(st.pin).toBe(version);

    const r = await starter(sb, ["ensure"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    expect(failureLine(r)).toMatch(/version/i);
    expect(server.archives()).toBe(1);
    expect(await exists(st.slot)).toBe(false);
    expect(await publishedTargets(sb, version)).toEqual([]);
    expect(await stagingLeft(sb)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 7: a wrong bun on PATH is ignored [${STARTER}]`, () => {
  test("a fake bun first on PATH is never called; the entry runs on the slot's Bun", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const fake = await fakeBunDir(sb);
    const sep = IS_WIN ? ";" : ":";
    const env = { PATH: `${fake.dir}${sep}${sb.env.PATH}` };

    const r = await starter(sb, ["run", "entries/info.ts"], { env }); // installs, then runs
    expectExit(r, 0);
    const info = JSON.parse(r.out);
    expect(info.version).toBe(REAL_VERSION);
    const st = await status(sb, { env });
    expect(samePath(info.execPath, slotBun(st.slot))).toBe(true);
    expect(existsSync(fake.marker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 8: run passes stdin, stdout and the exit code through [${STARTER}]`, () => {
  async function ready() {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    return { sb, server };
  }

  test("stdin reaches the entry byte for byte including end of input; stdout comes back byte for byte", async () => {
    const { sb } = await ready();
    // NUL, CRLF, a lone 0xff (invalid UTF-8), UTF-8 umlauts, no trailing newline
    const payload = new Uint8Array([
      ...new TextEncoder().encode('{"msg":"' + UMLAUTS.trim() + '"}\r\n'),
      0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x0a, 0x80,
      ...new TextEncoder().encode("end"),
    ]);
    const r = await starter(sb, ["run", "entries/echo.ts", "0"], { stdin: payload, timeoutMs: 60_000 });
    expectExit(r, 0);
    expect(Buffer.from(r.stdout).equals(Buffer.from(payload))).toBe(true);
    expect(r.err).toBe("");
  });

  test("a large stdin (3 MiB) arrives complete", async () => {
    const { sb } = await ready();
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 0xff;
    const r = await starter(sb, ["run", "entries/echo.ts", "0"], { stdin: big, timeoutMs: 90_000 });
    expectExit(r, 0);
    expect(r.stdout.length).toBe(big.length);
    expect(Buffer.from(r.stdout).equals(Buffer.from(big))).toBe(true);
  });

  test("an empty stdin ends at once", async () => {
    const { sb } = await ready();
    const r = await starter(sb, ["run", "entries/echo.ts", "0"], { stdin: new Uint8Array(), timeoutMs: 60_000 });
    expectExit(r, 0);
    expect(r.stdout.length).toBe(0);
  });

  test("UTF-8 umlauts on stdout are byte for byte", async () => {
    const { sb } = await ready();
    const r = await starter(sb, ["run", "entries/emit.ts"]);
    expectExit(r, 0);
    expect(Buffer.from(r.stdout).equals(Buffer.from(new TextEncoder().encode(UMLAUTS)))).toBe(true);
  });

  for (const code of [0, 1, 2, 7, 42]) {
    test(`the entry's exit code ${code} propagates`, async () => {
      const { sb } = await ready();
      const r = await starter(sb, ["run", "entries/echo.ts", String(code)], { stdin: "x" });
      expectExit(r, code); // 2 is the entry's own code here, not a starter failure
      expect(r.out).toBe("x");
    });
  }

  test("arguments after the entry arrive unchanged (spaces, quotes, trailing backslash, non-ASCII)", async () => {
    const { sb } = await ready();
    const args = ["plain", "with space", 'say "hi"', "trailing\\", "dir with space\\", "äß日"];
    const r = await starter(sb, ["run", "entries/info.ts", ...args]);
    expectExit(r, 0);
    expect(JSON.parse(r.out).argv).toEqual(args);
  });

  test("the consumer root comes from the starter's path, not the working directory", async () => {
    const { sb } = await ready();
    const r = await starter(sb, ["run", "entries/info.ts"]); // cwd is <tmp>/cwd, not the consumer root
    expectExit(r, 0);
    expect(JSON.parse(r.out).argv).toEqual([]);
  });

  test("scenario 8b: the host keeps stdin open; the starter ends once the entry has ended", async () => {
    const { sb } = await ready();
    const proc = Bun.spawn({
      cmd: starterCmd(sb.root, ["run", "entries/line.ts"]),
      env: sb.env,
      cwd: sb.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    track(() => void proc.kill()); // only the process this test started
    const outP = new Response(proc.stdout).arrayBuffer();
    const errP = new Response(proc.stderr).text();
    proc.stdin.write('{"event":"x"}\n'); // one line; the pipe stays open
    proc.stdin.flush();
    const t0 = performance.now();
    const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
    const ms = performance.now() - t0;
    const stillOpen = code === "timeout";
    proc.stdin.end(); // only now
    if (stillOpen) await proc.exited; // let the process end; the assertion below reports it
    const out = Buffer.from(await outP);
    expect(stillOpen).toBe(false); // the starter waited on the open stdin
    expect(code).toBe(5);
    expect(out.equals(Buffer.from('reply:{"event":"x"}:ü\n'))).toBe(true);
    expect(await errP).toBe("");
    expect(ms).toBeLessThan(10_000);
  });

  test("a fresh install inside run puts nothing of the starter on stdout", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const r = await starter(sb, ["run", "entries/echo.ts", "0"], { stdin: "hello\n" });
    expectExit(r, 0);
    expect(r.out).toBe("hello\n");
    expect(server.archives()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 9: spaces and non-ASCII in GETTY_HOME and the consumer root [${STARTER}]`, () => {
  test("install and run work with such paths", async () => {
    const server = await realServer();
    const sb = await sandbox({
      mirror: server.url,
      homeName: "Getty Höme ß 日本",
      rootName: "Prüfung Wurzel ä 日",
    });
    const before = await status(sb);
    expect(before.state).toBe("missing");
    expect(samePath(before.slot, slotOf(sb, before.target))).toBe(true);

    const r = await starter(sb, ["run", "entries/echo.ts", "0"], { stdin: UMLAUTS });
    expectExit(r, 0);
    expect(r.out).toBe(UMLAUTS);
    expect(server.archives()).toBe(1);

    const after = await status(sb);
    expect(after.state).toBe("ready");
    expect(await exists(slotBun(after.slot))).toBe(true);
    expect(await exists(join(after.slot, "receipt.json"))).toBe(true);
    expect(await stagingLeft(sb)).toEqual([]);

    const info = await starter(sb, ["run", "entries/info.ts", "ä b"]);
    expectExit(info, 0);
    expect(JSON.parse(info.out).argv).toEqual(["ä b"]);
  });
});

// ---------------------------------------------------------------------------------------
describe(`scenario 10: offline after install [${STARTER}]`, () => {
  test("with the server stopped, run still works and makes no request", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    const requests = server.total();
    server.stop();

    const r = await starter(sb, ["run", "entries/echo.ts", "0"], { stdin: "offline\n" });
    expectExit(r, 0);
    expect(r.out).toBe("offline\n");
    const e = await starter(sb, ["ensure"]);
    expectExit(e, 0);
    expect(server.total()).toBe(requests);
  });
});

// ---------------------------------------------------------------------------------------
const bashExe = IS_WIN ? findGitBashExe() : null;
const s11Skip = !IS_WIN
  ? "not Windows"
  : STARTER === "sh"
    ? "starter under test is sh"
    : bashExe === null
      ? "Git Bash bash.exe not found (looked via `git --exec-path` and the standard install paths)"
      : null;
if (s11Skip) console.warn(`[bootstrap-test] SKIP scenario 11 (Git Bash forwarding): ${s11Skip}`);

describe(`scenario 11: Git Bash forwarding shares slot and lock with PowerShell [${STARTER}]`, () => {
  const t = s11Skip ? test.skip : test;
  const name = s11Skip
    ? `Git Bash forwarding (SKIPPED: ${s11Skip})`
    : "the sh starter under Git Bash sees the PowerShell slot and respects the PowerShell lock";
  t(name, async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const bash = (args: string[], o: { env?: Record<string, string>; stdin?: string } = {}) =>
      run([bashExe!, join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), ...args], {
        env: { ...sb.env, ...(o.env ?? {}) },
        cwd: sb.cwd,
        stdin: o.stdin,
        timeoutMs: 120_000,
      });

    // installed by PowerShell, seen by Git Bash: same slot, no new download
    const st = await install(sb);
    const requests = server.total();
    const viaBash = await bash(["status"]);
    expectExit(viaBash, 0);
    const bst = JSON.parse(viaBash.out);
    expect(bst.state).toBe("ready");
    expect(bst.pin).toBe(st.pin);
    expect(bst.target).toBe(st.target);
    expect(samePath(bst.slot, st.slot)).toBe(true);
    const ran = await bash(["run", "entries/echo.ts", "0"], { stdin: "via git bash\n" });
    expectExit(ran, 0);
    expect(ran.out).toBe("via git bash\n");
    expect(server.total()).toBe(requests);

    // a lock held the PowerShell way blocks Git Bash: it is the same lock
    const sb2 = await sandbox({ mirror: server.url });
    const st2 = await status(sb2);
    await holdLock(lockFile(sb2, REAL_VERSION, st2.target));
    const blocked = await run(
      [bashExe!, join(sb2.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), "ensure"],
      { env: { ...sb2.env, GETTY_BUN_LOCK_WAIT: "2" }, cwd: sb2.cwd, timeoutMs: 60_000 },
    );
    expectExit(blocked, 1);
    expect(failureLine(blocked)).toContain("getty-bun: ");
    expect(await exists(st2.slot)).toBe(false);
    expect(await stagingLeft(sb2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
describe(`starter contract: environment and errors [${STARTER}]`, () => {
  test("a relative GETTY_HOME is rejected: exit 1, getty-bun line naming GETTY_HOME, nothing created", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    for (const cmd of [["status"], ["ensure"], ["run", "entries/info.ts"]]) {
      const r = await starter(sb, cmd, { env: { GETTY_HOME: "relative-home" } });
      expectExit(r, 1);
      expect(r.out).toBe("");
      expect(failureLine(r)).toContain("GETTY_HOME");
    }
    expect(await listDir(sb.cwd)).toEqual([]);
    expect(await listDir(sb.root)).toEqual(["bootstrap", "entries"]);
    expect(server.total()).toBe(0);
  });

  test("an unknown command fails with a getty-bun line and exit 1, never 2", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const r = await starter(sb, ["frobnicate"]);
    expectExit(r, 1);
    expect(r.out).toBe("");
    failureLine(r);
  });

  test("no command fails with exit 1, never 2", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const r = await starter(sb, []);
    expectExit(r, 1);
    expect(r.out).toBe("");
    failureLine(r);
  });

  test("an unreachable mirror fails the install with exit 1 and a clean store", async () => {
    const server = await realServer();
    const dead = server.url;
    server.stop();
    const sb = await sandbox({ mirror: dead });
    const st = await status(sb);
    const r = await starter(sb, ["ensure"], { timeoutMs: 120_000 });
    expectExit(r, 1);
    expect(r.out).toBe("");
    failureLine(r);
    expect(await exists(st.slot)).toBe(false);
    expect(await stagingLeft(sb)).toEqual([]);
  });

  test("a missing archive (HTTP 404) fails the install with exit 1 and a clean store", async () => {
    const server = serve({});
    const sb = await sandbox({ mirror: server.url });
    const st = await status(sb);
    const r = await starter(sb, ["ensure"]);
    expectExit(r, 1);
    expect(failureLine(r)).toContain("getty-bun: ");
    expect(server.archives()).toBeGreaterThanOrEqual(1);
    expect(await exists(st.slot)).toBe(false);
    expect(await stagingLeft(sb)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
describe(`interface details (docs/plan.md, bootstrap/README.md) [${STARTER}]`, () => {
  test("status, ensure and run exit 1 on an unsupported target, naming it; nothing is created", async () => {
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
    for (const args of [["status"], ["ensure"], ["run", "entries/info.ts"]]) {
      const r = await starter(sb, args, { env });
      expectExit(r, 1);
      expect(r.out).toBe("");
      expect(failureLine(r)).toMatch(named);
    }
    expect(await listDir(sb.home)).toEqual([]);
    expect(server.total()).toBe(0);
  });

  const badWaits = IS_WIN ? ["abc", "-1"] : ["abc", "-1", ""]; // Windows cannot hold an empty variable
  for (const v of badWaits) {
    test(`GETTY_BUN_LOCK_WAIT=${JSON.stringify(v)} fails with exit 1 naming the variable`, async () => {
      const server = await realServer();
      const sb = await sandbox({ mirror: server.url });
      const r = await starter(sb, ["ensure"], { env: { GETTY_BUN_LOCK_WAIT: v } });
      expectExit(r, 1);
      expect(r.out).toBe("");
      expect(failureLine(r)).toContain("GETTY_BUN_LOCK_WAIT");
      expect(server.total()).toBe(0);
      expect(await listDir(sb.home)).toEqual([]);
    });
  }

  if (!IS_WIN) {
    // POSIX only: the default home on Windows comes from the user profile API, which ignores a
    // changed USERPROFILE, so the harness refuses to run a Windows starter without GETTY_HOME.
    test("an empty GETTY_HOME fails with exit 1 naming the variable; nothing is created", async () => {
      const server = await realServer();
      const sb = await sandbox({ mirror: server.url });
      for (const args of [["status"], ["ensure"]]) {
        const r = await starter(sb, args, { env: { GETTY_HOME: "" } });
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(failureLine(r)).toContain("GETTY_HOME");
      }
      expect(await listDir(sb.userHome)).toEqual([]); // no ~/.getty fallback
      expect(await listDir(sb.cwd)).toEqual([]);
      expect(server.total()).toBe(0);
    });
  }

  const breakers: Array<[string, (bun: string) => Promise<void>]> = [["is missing", (bun) => rm(bun)]];
  breakers.push(["is empty (0 bytes)", (bun) => writeFile(bun, new Uint8Array())]);
  if (!IS_WIN) breakers.push(["is not executable", (bun) => chmod(bun, 0o644)]);
  for (const [what, breakIt] of breakers) {
    test(`a slot whose bin/bun ${what} is mismatch: ensure and run exit 1 naming the slot, slot untouched`, async () => {
      const server = await realServer();
      const sb = await sandbox({ mirror: server.url });
      const st = await install(sb);
      await breakIt(slotBun(st.slot));
      const before = await snapshot(join(sb.home, "runtimes"));
      const requests = server.total();

      const s = await starter(sb, ["status"]);
      expectExit(s, 0);
      expect(JSON.parse(s.out).state).toBe("mismatch");
      for (const args of [["ensure"], ["run", "entries/info.ts"]]) {
        const r = await starter(sb, args);
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(failureLine(r)).toContain(st.slot);
      }
      expect(await snapshot(join(sb.home, "runtimes"))).toEqual(before);
      expect(server.total()).toBe(requests);
    });
  }

  test("the receipt after an install has the canonical bytes of bootstrap/README.md", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const t0 = Date.now();
    const st = await install(sb);
    const raw = new Uint8Array(await Bun.file(join(st.slot, "receipt.json")).arrayBuffer());
    expect(raw.every((b) => b < 0x80)).toBe(true); // ASCII
    const text = new TextDecoder().decode(raw);
    expect(text.includes("\r")).toBe(false); // LF only
    expect(text.endsWith("}\n")).toBe(true); // final newline
    const info = archiveInfo(realTable, REAL_VERSION, st.target);
    const entry = readZip(await fixtureArchive(st.target)).find((e) => e.name === info.member)!;
    const binary = entry.method === 8 ? inflateRawSync(entry.raw) : entry.raw;
    const l = text.split("\n");
    expect(l.slice(0, 9)).toEqual([
      "{",
      `  "version": "${REAL_VERSION}",`,
      `  "target": "${st.target}",`,
      `  "archiveSha256": "${info.sha256}",`,
      `  "contractVersion": 1,`,
      `  "archive": "${info.archive}",`,
      `  "member": "${info.member}",`,
      `  "binarySha256": "${sha256Hex(binary)}",`,
      `  "executable": "${IS_WIN ? "bin/bun.exe" : "bin/bun"}",`,
    ]);
    const at = l[9]!.match(/^ {2}"verifiedAt": "(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)"$/);
    expect(at).not.toBeNull();
    const when = Date.parse(at![1]!);
    expect(when).toBeGreaterThan(t0 - 60_000);
    expect(when).toBeLessThan(Date.now() + 60_000);
    expect(l.slice(10)).toEqual(["}", ""]);
  });

  test("while an install runs, .installing holds the record of README.md; a timed-out waiter names it; it is gone afterwards", async () => {
    const server = await realServer(6000); // a slow download keeps the holder in its critical section
    const sb = await sandbox({ mirror: server.url });
    const st = await status(sb);
    const installing = join(dirname(lockFile(sb, REAL_VERSION, st.target)), ".installing");
    const holder = Bun.spawn({
      cmd: starterCmd(sb.root, ["ensure"]),
      env: sb.env,
      cwd: sb.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    track(() => void holder.kill()); // only the process this test started
    const holderErr = new Response(holder.stderr).text();
    const deadline = Date.now() + 60_000;
    while (!(await exists(installing)) && Date.now() < deadline) await Bun.sleep(100);
    expect(await exists(installing)).toBe(true);
    const rec = JSON.parse(await readFile(installing, "utf8"));

    const waiter = await starter(sb, ["ensure"], { env: { GETTY_BUN_LOCK_WAIT: "1" } });
    expectExit(waiter, 1);
    expect(failureLine(waiter)).toContain(installing);

    expect(Object.keys(rec)).toEqual([
      "schemaVersion",
      "pid",
      "processName",
      "processStartToken",
      "installId",
      "environmentId",
      "requestedVersion",
      "target",
    ]);
    expect(rec.schemaVersion).toBe(1);
    expect(rec.pid).toBe(holder.pid); // the starter's own pid
    expect(typeof rec.processName).toBe("string");
    expect(rec.processName).not.toBe("");
    expect(rec.processStartToken === null || typeof rec.processStartToken === "string").toBe(true);
    expect(rec.environmentId === null || typeof rec.environmentId === "string").toBe(true);
    expect(typeof rec.installId).toBe("string");
    expect(rec.installId).not.toBe("");
    expect(rec.requestedVersion).toBe(REAL_VERSION);
    expect(rec.target).toBe(st.target);

    expect(await holder.exited).toBe(0);
    expect(await holderErr).toBe("");
    expect(await exists(installing)).toBe(false); // gone once the install has ended (the order against the lock release is not observed)
    expect(await exists(lockFile(sb, REAL_VERSION, st.target))).toBe(true); // the lock file stays
    expect((await status(sb)).state).toBe("ready");
  });

  test("arguments after the entry arrive unchanged through a fresh install too", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const args = ["plain", "with space", 'say "hi"', "trailing\\", "\u00e4\u00df\u65e5"];
    const r = await starter(sb, ["run", "entries/info.ts", ...args]); // installs, then runs
    expectExit(r, 0);
    expect(server.archives()).toBe(1);
    expect(JSON.parse(r.out).argv).toEqual(args);
  });
});

// ---------------------------------------------------------------------------------------
const real = process.env.GETTY_BUN_TEST_REAL === "1";
if (!real) {
  console.warn("[bootstrap-test] SKIP real GitHub download: set GETTY_BUN_TEST_REAL=1 to run it");
}
describe(`real download [${STARTER}]`, () => {
  const t = real ? test : test.skip;
  t(real ? "installs the pinned Bun from the real GitHub release, then runs an entry" : "real GitHub download (SKIPPED: GETTY_BUN_TEST_REAL is not 1)", async () => {
    const sb = await sandbox({ mirror: null }); // no GETTY_BUN_MIRROR
    expect(sb.env.GETTY_BUN_MIRROR).toBeUndefined();
    const st = await status(sb);
    expect(st.state).toBe("missing");
    const e = await starter(sb, ["ensure"], { timeoutMs: 280_000 });
    expectExit(e, 0);
    expect(e.out).toBe("");
    expect((await status(sb)).state).toBe("ready");
    const r = await starter(sb, ["run", "entries/echo.ts", "3"], { stdin: "real\n" });
    expectExit(r, 3);
    expect(r.out).toBe("real\n");
    expect(await stagingLeft(sb)).toEqual([]);
  });
});
