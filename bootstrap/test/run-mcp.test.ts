// Release 0.2.0 rework (hub card agent-developer k14), docs/plan.md "Rework after the hub review":
// `run-mcp <entry> [args...]`, the starter mode for a long-lived stdio (MCP) server.
//
//   slot ready     exactly `run` (exec, same PID, stdin/stdout, exit code)
//   slot missing   no install of its own; waits for the slot a SessionStart `ensure` installs, for at
//                  most GETTY_BUN_MCP_WAIT seconds, then behaves as `run`
//   every other way (still missing after the wait, mismatch, invalid GETTY_HOME / GETTY_BUN_LOCK_WAIT /
//                  GETTY_BUN_MCP_WAIT, unsupported or undeclared platform, no entry argument):
//                  one `getty-bun: ` stderr line, then a STUB server that never ends before
//                  `initialize` (Claude Code 2.1.332 blocks a server that does for about 15 minutes):
//                  an answer for every message with an id, verbatim (number or string), only the
//                  top-level id and method count; end of input exits 0; a signal ends it within 0.5 s.
//   Windows        `getty-bun.ps1 run-mcp` and the Git Bash forwarding fail with one line, exit 1
//                  (MCP through the PowerShell starter is k13).
//
// GETTY_BUN_MCP_WAIT=1 keeps the stub tests fast. Not checked here: a missing or broken pin block (the
// pin block's text is the posix worker's), and that no child of the stub outlives a signal to the
// starter (the spec names only the starter's own end).
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/run-mcp.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HOST_PLATFORM,
  IS_WIN,
  REAL_VERSION,
  STARTER,
  cleanupAll,
  descendantsOf,
  exists,
  expectExit,
  failureLine,
  findGitBashExe,
  hostTargets,
  install,
  killRecorded,
  lines,
  plantSlot,
  realRoutes,
  run,
  sandbox,
  snapshot,
  starter,
  startLive,
  startServer,
  starterCmd,
  status,
  track,
  type Live,
  type Sandbox,
} from "./lib/harness";
import { testWhen } from "./lib/when";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

// Other interpreters for the stub (POSIX starter only; no install is involved, so k60 does not bite).
// BusyBox sh runs awk in-process and kept the shell's traps once: the stub ignored TERM/INT/HUP.
function otherShell(name: string): { argv: string[] | null; missing: string } {
  const fromPath = (n: string) => Bun.which(n);
  let bin: string | null;
  if (name === "busybox sh") {
    const named = process.env.GETTY_BUN_TEST_BUSYBOX;
    bin = named ? (existsSync(named) ? named : null) : fromPath("busybox");
    return { argv: bin === null ? null : [bin, "sh"], missing: "no busybox (set GETTY_BUN_TEST_BUSYBOX=/path/to/busybox)" };
  }
  if (name === "zsh as sh") {
    bin = fromPath("zsh"); // zsh in its native mode is not a supported interpreter: only `zsh --emulate sh`
    return { argv: bin === null ? null : [bin, "--emulate", "sh"], missing: "zsh is not installed on this machine" };
  }
  bin = fromPath(name);
  return { argv: bin === null ? null : [bin], missing: `${name} is not installed on this machine` };
}
const shellTest = (name: string, shell: string, fn: (argv: string[]) => Promise<void>) => {
  const o = otherShell(shell);
  testWhen(!IS_WIN && STARTER === "sh" && o.argv !== null, STARTER !== "sh" ? "POSIX starter only" : IS_WIN ? WIN_REASON : o.missing, `${name} under ${shell}`, () => fn(o.argv!));
};

const WIN_REASON = "Windows: run-mcp through the PowerShell starter is only a clear failure (k13)";
const posix = (name: string, fn: () => Promise<void>) => testWhen(!IS_WIN, WIN_REASON, name, fn);
const OTHERS = ["linux", "darwin", "windows"].filter((p) => p !== HOST_PLATFORM);

async function realServer(opts: { delayMs?: number } = {}) {
  const s = startServer(await realRoutes(), opts);
  track(() => s.stop());
  return s;
}

/** Start `starter run-mcp ...` with a stdin pipe; GETTY_BUN_MCP_WAIT=1 unless the test says otherwise. */
function startMcp(sb: Sandbox, args: string[], env: Record<string, string> = {}, shell: string[] | null = null): Live {
  const cmd = starterCmd(sb.root, ["run-mcp", ...args]);
  if (shell !== null) cmd.splice(0, 1, ...shell); // the same `sh <starter> ...` line under another interpreter
  return startLive(cmd, { env: { ...sb.env, GETTY_BUN_MCP_WAIT: "1", ...env }, cwd: sb.cwd });
}

type Msg = Record<string, any>;
const parse = (text: string): Msg[] =>
  lines(text).map((l) => {
    try {
      return JSON.parse(l) as Msg;
    } catch {
      throw new Error(`a stdout line is not JSON: ${JSON.stringify(l)} (all stdout ${JSON.stringify(text)})`);
    }
  });

/** The stdout of a stub is JSON-RPC and nothing else: complete lines, each a JSON object with jsonrpc "2.0". */
function expectOnlyJsonRpc(stdout: string): Msg[] {
  if (stdout !== "") expect(stdout.endsWith("\n"), `stdout does not end in a newline: ${JSON.stringify(stdout)}`).toBe(true);
  const msgs = parse(stdout);
  for (const m of msgs) expect(m.jsonrpc, `message without jsonrpc "2.0": ${JSON.stringify(m)}`).toBe("2.0");
  return msgs;
}

/** Exactly one `getty-bun: ` line on stderr, as a stub writes it. */
function oneLine(live: Live): string {
  const l = lines(live.stderr());
  expect(l.length, `stderr must be one getty-bun line, got ${JSON.stringify(live.stderr())}`).toBe(1);
  expect(l[0]!.startsWith("getty-bun: ")).toBe(true);
  return l[0]!;
}

const DISCOVER = `{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"protocolVersion":"2026-07-28"}}`;
const INITIALIZE = (v: string) =>
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${v}","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}`;
const INITIALIZED = `{"jsonrpc":"2.0","method":"notifications/initialized"}`;

/** What Claude Code sends first, answered by a stub: discover, initialize, initialized, ping. Returns the live handle after exit 0. */
async function shortSession(live: Live): Promise<{ msgs: Msg[]; line: string }> {
  for (const l of [DISCOVER, INITIALIZE("2025-11-25"), INITIALIZED, `{"jsonrpc":"2.0","id":2,"method":"ping"}`]) live.write(`${l}\n`);
  live.endInput();
  const out = await live.readAll(30_000);
  expect(await live.exit(30_000), `stderr ${JSON.stringify(live.stderr())}`).toBe(0);
  const msgs = expectOnlyJsonRpc(out);
  expect(msgs.map((m) => m.id), "one answer per message with an id, in order, the notification unanswered").toEqual([
    "server-discover-probe-1",
    1,
    2,
  ]);
  expect(msgs[1]!.result.serverInfo.name).toBe("getty-bun-stub");
  return { msgs, line: oneLine(live) };
}

// ---------------------------------------------------------------------------------------
describe(`run-mcp: slot ready behaves as run [${STARTER}]`, () => {
  posix("the entry runs under the starter's PID, answers line by line, end of input and its exit code pass through, no request, no stub line", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    const requests = server.total();
    const live = startMcp(sb, ["entries/serve.ts"]);
    const first = await live.readLine(60_000);
    const m = /^ready:(\d+)$/.exec(first);
    expect(m, `first stdout line was ${JSON.stringify(first)}, stderr ${JSON.stringify(live.stderr())}`).not.toBeNull();
    expect(Number(m![1]), "the entry runs under another PID than the starter process").toBe(live.pid);
    for (const l of ["one", "zwei äöü"]) {
      live.write(`${l}\n`);
      expect(await live.readLine(30_000)).toBe(`reply:${l}:ü`);
    }
    live.endInput();
    expect(await live.readAll(30_000)).toBe(`ready:${live.pid}\nreply:one:ü\nreply:zwei äöü:ü\nbye:eof\n`);
    expect(await live.exit(30_000), `stderr ${JSON.stringify(live.stderr())}`).toBe(10);
    expect(live.stderr()).toBe("");
    expect(server.total(), "run-mcp made a request").toBe(requests);
  });

  posix("stdin, stdout, stderr and the exit code are those of run", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    const input = new Uint8Array([...Buffer.from("zeile eins üä\n"), 0, 1, 2, 254, 255, 10, 13, 10]);
    const viaRun = await starter(sb, ["run", "entries/echo.ts", "7"], { stdin: input });
    const viaMcp = await starter(sb, ["run-mcp", "entries/echo.ts", "7"], { stdin: input, env: { GETTY_BUN_MCP_WAIT: "1" } });
    expectExit(viaRun, 7);
    expectExit(viaMcp, 7); // 2 would pass through too: starter() allows it for run-mcp
    expect(Buffer.from(viaMcp.stdout).equals(Buffer.from(input)), `stdout ${JSON.stringify(viaMcp.out)}`).toBe(true);
    expect(viaMcp.err).toBe(viaRun.err);
  });

  posix("the entry's arguments are those of run", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    const args = ["a b", 'c"d', "e\\", "über", "--flag"];
    const viaRun = await starter(sb, ["run", "entries/info.ts", ...args]);
    const viaMcp = await starter(sb, ["run-mcp", "entries/info.ts", ...args]);
    expectExit(viaMcp, 0);
    expect(JSON.parse(viaMcp.out)).toEqual(JSON.parse(viaRun.out));
    expect(JSON.parse(viaMcp.out).argv).toEqual(args);
  });
});

// ---------------------------------------------------------------------------------------
describe(`run-mcp: slot missing [${STARTER}]`, () => {
  posix("an ensure that finishes during the wait: the real entry answers, under the starter's PID", async () => {
    const server = await realServer({ delayMs: 300 });
    const sb = await sandbox({ mirror: server.url });
    expect((await status(sb)).state).toBe("missing");
    const live = startMcp(sb, ["entries/serve.ts"], { GETTY_BUN_MCP_WAIT: "90" });
    await Bun.sleep(800); // run-mcp is waiting now: nothing installed yet
    expect(live.proc.exitCode, "run-mcp ended while the slot was missing").toBeNull();
    const ensured = await starter(sb, ["ensure"]); // the SessionStart hook, started from the fixture mirror
    expectExit(ensured, 0);
    const first = await live.readLine(60_000);
    expect(first, `stderr ${JSON.stringify(live.stderr())}`).toBe(`ready:${live.pid}`);
    live.endInput();
    expect(await live.readAll(30_000)).toBe(`ready:${live.pid}\nbye:eof\n`);
    expect(await live.exit(30_000)).toBe(10);
    expect(live.stderr(), "a real server needs no stub line").toBe("");
  });

  posix("no install at all: after about the wait the stub answers; run-mcp created nothing and asked for nothing", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    const t0 = performance.now();
    const live = startMcp(sb, ["entries/serve.ts"]); // GETTY_BUN_MCP_WAIT=1
    live.write(`${DISCOVER}\n`);
    const first = parse(await live.readLine(30_000))[0]!;
    const ms = performance.now() - t0;
    expect(first.id).toBe("server-discover-probe-1");
    expect(ms, "the stub answered before the wait ended").toBeGreaterThan(750);
    expect(ms, "the stub took far longer than the wait").toBeLessThan(15_000);
    live.endInput();
    await live.readAll(30_000);
    expect(await live.exit(30_000)).toBe(0);
    oneLine(live);
    expect(await snapshot(sb.home), "run-mcp created something under GETTY_HOME (lock, staging, download)").toEqual([]);
    expect(await exists(sb.home)).toBe(false);
    expect(server.total(), "run-mcp asked the mirror for something").toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
describe(`run-mcp: slot ready, entry file missing [${STARTER}]`, () => {
  posix("the stub answers, one getty-bun line, end of input exits 0 (not Bun's exit 1)", async () => {
    const server = await realServer();
    const sb = await sandbox({ mirror: server.url });
    await install(sb);
    const requests = server.total();
    const before = await snapshot(sb.home);
    const live = startMcp(sb, ["entries/does-not-exist.ts"]);
    await shortSession(live);
    expect(await snapshot(sb.home), "the stub changed GETTY_HOME").toEqual(before);
    expect(server.total(), "the stub asked the mirror for something").toBe(requests);
  });
});

// ---------------------------------------------------------------------------------------
describe(`run-mcp: the stub server [${STARTER}]`, () => {
  async function fullSession(shell: string[] | null) {
    const sb = await sandbox();
    const live = startMcp(sb, ["entries/serve.ts"], {}, shell);
    const requests = [
      DISCOVER,
      INITIALIZE("2025-11-25"),
      INITIALIZED,
      `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
      // an "id" and a "method" inside params never count, whatever the key order
      `{"id":3,"jsonrpc":"2.0","method":"tools/call","params":{"name":"x","arguments":{"id":99,"method":"initialize"}}}`,
      `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"x","arguments":{"id":98,"method":"ping"}},"id":4}`,
      `{"jsonrpc":"2.0","id":"p-1","method":"ping"}`,
      `this is not json {{{`,
      ``,
      `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"id":77,"requestId":1}}`,
      `{"jsonrpc":"2.0","id":5,"method":"resources/list"}`,
      `{"jsonrpc":"2.0","id":0,"method":"ping"}`,
    ];
    for (const l of requests) live.write(`${l}\n`);
    live.endInput();
    const msgs = expectOnlyJsonRpc(await live.readAll(30_000));
    expect(await live.exit(30_000), `stderr ${JSON.stringify(live.stderr())}`).toBe(0);
    expect(msgs.map((m) => m.id), "one answer per message with an id, top-level id verbatim, nothing for notifications or garbage").toEqual([
      "server-discover-probe-1",
      1,
      2,
      3,
      4,
      "p-1",
      5,
      0,
    ]);
    const [discover, init, list, callFirst, callLast, ping, unknown, zero] = msgs;
    expect(discover!.error?.code, "server/discover is an unknown method with an id").toBe(-32601);
    expect(init!.result.protocolVersion).toBe("2025-11-25");
    expect(init!.result.capabilities).toEqual({ tools: {} });
    expect(init!.result.serverInfo.name).toBe("getty-bun-stub");
    expect(init!.result.serverInfo.version).toBe(REAL_VERSION);
    expect(typeof init!.result.instructions).toBe("string");
    expect(init!.result.instructions).toMatch(/next session/i);
    expect(list!.result).toEqual({ tools: [] });
    expect(callFirst!.result).toEqual({ content: [] });
    expect(callLast!.result).toEqual({ content: [] });
    expect(ping!.result).toEqual({});
    expect(unknown!.error.code).toBe(-32601);
    expect(zero!.result).toEqual({});
    oneLine(live);
  }

  posix("a full session: discover, initialize, initialized, tools/list, tools/call with an id inside the arguments, ping, unknown, garbage", () => fullSession(null));

  for (const sh of ["bash", "zsh as sh", "busybox sh"]) shellTest("a full session: the stub transcript", sh, (argv) => fullSession(argv));

  posix("initialize echoes the protocolVersion the client asked for", async () => {
    const sb = await sandbox();
    const live = startMcp(sb, ["entries/serve.ts"]);
    live.write(`${INITIALIZE("2024-11-05")}\n`);
    live.endInput();
    const msgs = expectOnlyJsonRpc(await live.readAll(30_000));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.result.protocolVersion).toBe("2024-11-05");
    expect(await live.exit(30_000)).toBe(0);
  });

  posix("stays until end of input: it does not end on its own before initialize completes", async () => {
    const sb = await sandbox();
    const live = startMcp(sb, ["entries/serve.ts"]);
    await Bun.sleep(2500); // past the one-second wait
    expect(live.proc.exitCode, `the stub ended by itself; stderr ${JSON.stringify(live.stderr())}`).toBeNull();
    expect(live.proc.signalCode).toBeNull();
    live.write(`${INITIALIZE("2025-11-25")}\n`);
    expect(parse(await live.readLine(10_000))[0]!.id).toBe(1);
    live.endInput();
    expect(await live.exit(30_000)).toBe(0);
  });

  // each reason ends in a stub, not in an exit
  const reasons: Array<{ name: string; setup: (sb: Sandbox) => Promise<{ args?: string[]; env?: Record<string, string>; named?: RegExp }>; sandboxOpts?: () => Promise<Parameters<typeof sandbox>[0]> }> = [
    {
      name: "mismatch slot",
      setup: async (sb) => ({ named: new RegExp(escape(await plantSlot(sb, hostTargets()[0]!, { receiptVersion: "0.0.1" }))) }),
    },
    { name: "mirror unreachable and no slot (nothing to download from, and nothing is attempted)", setup: async () => ({}), sandboxOpts: async () => ({ mirror: "http://127.0.0.1:9" }) },
    { name: "invalid GETTY_HOME (relative)", setup: async () => ({ env: { GETTY_HOME: "relative/home" }, named: /GETTY_HOME/ }) },
    { name: "invalid GETTY_BUN_MCP_WAIT", setup: async () => ({ env: { GETTY_BUN_MCP_WAIT: "soon" }, named: /GETTY_BUN_MCP_WAIT/ }) },
    { name: "invalid GETTY_BUN_LOCK_WAIT", setup: async () => ({ env: { GETTY_BUN_LOCK_WAIT: "soon" }, named: /GETTY_BUN_LOCK_WAIT/ }) },
    { name: "undeclared platform", setup: async () => ({}), sandboxOpts: async () => ({ platforms: OTHERS }) },
    {
      name: "unsupported target",
      setup: async (sb) => {
        const dir = join(sb.tmp, "fakeuname");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "uname"), "#!/bin/sh\necho 'Linux armv7l'\n", { mode: 0o755 });
        return { env: { PATH: `${dir}:${sb.env.PATH}` }, named: /armv7l/ };
      },
    },
    { name: "no entry argument", setup: async () => ({ args: [] }) },
  ];
  for (const r of reasons) {
    posix(`${r.name}: one getty-bun line, then a stub that answers discover, initialize and ping and exits 0 at end of input`, async () => {
      const server = await realServer();
      const sb = await sandbox({ mirror: server.url, ...((await r.sandboxOpts?.()) ?? {}) });
      const s = await r.setup(sb);
      const before = await snapshot(sb.home);
      const live = startMcp(sb, s.args ?? ["entries/serve.ts"], s.env ?? {});
      const { line } = await shortSession(live);
      if (s.named) expect(line).toMatch(s.named);
      if (r.name.startsWith("invalid GETTY_HOME")) expect(await exists(join(sb.cwd, "relative"))).toBe(false);
      else expect(await snapshot(sb.home), "the stub changed GETTY_HOME").toEqual(before);
      if (!r.sandboxOpts) expect(server.total(), "the stub asked the mirror for something").toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------------------
describe(`run-mcp: signals end it within 0.5 s [${STARTER}]`, () => {
  const SIGNALS = [
    ["SIGTERM", 15],
    ["SIGINT", 2],
    ["SIGHUP", 1],
  ] as const;

  /** Signal the starter this test started and require it to end within 0.5 s, by that signal or with 128 + n. */
  async function endedBy(live: Live, sig: (typeof SIGNALS)[number][0], n: number) {
    const kids = descendantsOf(live.pid); // recorded now: the one PID and what it started, nothing by name
    track(() => killRecorded(kids));
    const t0 = performance.now();
    live.kill(sig);
    const r = await Promise.race([live.proc.exited.then(() => "exited" as const), Bun.sleep(3000).then(() => "late" as const)]);
    const ms = performance.now() - t0;
    expect(r, `still running 3 s after ${sig}; stderr ${JSON.stringify(live.stderr())}`).toBe("exited");
    expect(ms, `${sig} took ${ms | 0} ms to end it`).toBeLessThanOrEqual(500);
    const ok = live.proc.signalCode === sig || live.proc.exitCode === 128 + n;
    expect(ok, `ended with exit ${live.proc.exitCode}, signal ${live.proc.signalCode}; wanted ${sig} or 128+${n}`).toBe(true);
  }

  for (const [sig, n] of SIGNALS) {
    posix(`${sig} during the wait (slot missing)`, async () => {
      const sb = await sandbox();
      const live = startMcp(sb, ["entries/serve.ts"], { GETTY_BUN_MCP_WAIT: "60" });
      await Bun.sleep(600);
      expect(live.proc.exitCode, `run-mcp ended on its own; stderr ${JSON.stringify(live.stderr())}`).toBeNull();
      await endedBy(live, sig, n);
    });

    const inStub = async (shell: string[] | null) => {
      const sb = await sandbox();
      const live = startMcp(sb, ["entries/serve.ts"], {}, shell);
      live.write(`{"jsonrpc":"2.0","id":1,"method":"ping"}\n`);
      expect(parse(await live.readLine(30_000))[0]!.id).toBe(1); // the wait is over, the stub is serving
      await endedBy(live, sig, n);
    };
    posix(`${sig} in the stub`, () => inStub(null));
    shellTest(`${sig} in the stub`, "busybox sh", inStub);
    shellTest(`${sig} during the wait (slot missing)`, "busybox sh", async (shell) => {
      const sb = await sandbox();
      const live = startMcp(sb, ["entries/serve.ts"], { GETTY_BUN_MCP_WAIT: "60" }, shell);
      await Bun.sleep(600);
      expect(live.proc.exitCode, `run-mcp ended on its own; stderr ${JSON.stringify(live.stderr())}`).toBeNull();
      await endedBy(live, sig, n);
    });
  }
});

// ---------------------------------------------------------------------------------------
// Windows legs: only the clear failure
const NOT_SUPPORTED = /run-mcp is not supported.*\(k13\)/;
if (IS_WIN) {
  describe(`run-mcp on Windows: a clear failure [${STARTER}]`, () => {
    test("through -File: exit 1, nothing on stdout, one getty-bun line, nothing created under GETTY_HOME", async () => {
      const sb = await sandbox();
      // a relative GETTY_HOME: the starter fails on run-mcp before it reads the environment, so it names run-mcp, not GETTY_HOME
      const r = await starter(sb, ["run-mcp", "entries/info.ts"], { stdin: "never read\n", env: { GETTY_HOME: "relative/home" } });
      expectExit(r, 1);
      expect(r.out).toBe("");
      expect(failureLine(r)).toMatch(NOT_SUPPORTED);
      expect(await exists(join(sb.cwd, "relative"))).toBe(false);
      expect(await snapshot(sb.home)).toEqual([]);
    });

    test("through the Git Bash forwarding: exit 1, nothing on stdout, one getty-bun line", async () => {
      const bash = findGitBashExe();
      if (bash === null) throw new Error("Git Bash bash.exe not found (looked via `git --exec-path` and the standard install paths): a Windows leg needs it");
      const sb = await sandbox();
      const r = await run([bash, join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), "run-mcp", "entries/info.ts"], {
        env: sb.env,
        cwd: sb.cwd,
        timeoutMs: 120_000,
      });
      expectExit(r, 1);
      expect(r.out).toBe("");
      expect(failureLine(r)).toMatch(NOT_SUPPORTED);
      expect(await snapshot(sb.home)).toEqual([]);
    });
  });
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
