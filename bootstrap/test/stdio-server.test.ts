// Release 0.2.0 item 9 (ADR 0011): the entry kind "long-lived stdio server" under the starter,
// as an MCP server runs. The entry (lib/harness.ts ENTRY_SERVE) prints `ready:<pid>`, answers every
// request line with `reply:<line>:ü`, and ends with its own code per cause: end of input 10 and
// `bye:eof`, SIGINT 11, SIGTERM 12, SIGHUP 13, each with a `bye:<cause>` line first.
//
// Contract checked: the starter execs Bun under the same PID (POSIX); stdout carries only the
// entry's bytes, also during a first install from the fixture mirror; several request/response
// lines in a row; end of input, SIGINT, SIGTERM and SIGHUP reach the entry, which answers and
// exits with its own code, passed through unchanged.
//
// Windows: the stream part only (the lines, end of input and the exit code); there are no POSIX
// signals and no exec, and the job object that would end a server with its host is k13, out of
// scope for 0.2.0. Those tests are skipped there with that reason in their names.
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/stdio-server.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  IS_WIN,
  STARTER,
  cleanupAll,
  expectExit,
  install,
  realRoutes,
  sandbox,
  startLive,
  startServer,
  starterCmd,
  track,
  type Live,
  type Sandbox,
} from "./lib/harness";
import { testWhen } from "./lib/when";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

const WIN_ONLY_STREAMS = "Windows: no exec and no POSIX signals here, the job object is k13 (out of scope for 0.2.0)";
const LINES = ["first", "zweite zeile äöü", "", "  spaces  ", "日本語", "last one"];

function start(sb: Sandbox): Live {
  return startLive(starterCmd(sb.root, ["run", "entries/serve.ts"]), { env: sb.env, cwd: sb.cwd });
}

async function ready(live: Live): Promise<number> {
  const line = await live.readLine(120_000);
  const m = /^ready:(\d+)$/.exec(line);
  expect(m, `first stdout line was ${JSON.stringify(line)}, stderr ${JSON.stringify(live.stderr())}`).not.toBeNull();
  return Number(m![1]);
}

async function exchange(live: Live, lines: string[]) {
  for (const l of lines) {
    live.write(`${l}\n`);
    expect(await live.readLine(30_000)).toBe(`reply:${l}:ü`);
  }
}

/** Everything the entry writes, in order: the ready line, one reply per request, the bye line. */
const transcript = (pid: number, requests: string[], bye: string) =>
  `ready:${pid}\n${requests.map((l) => `reply:${l}:\u00fc\n`).join("")}bye:${bye}\n`;

async function installedSandbox() {
  const server = startServer(await realRoutes());
  track(() => server.stop());
  const sb = await sandbox({ mirror: server.url });
  await install(sb);
  return { sb, server };
}

describe(`item 9: a long-lived stdio server entry [${STARTER}]`, () => {
  test("several request and response lines in a row; end of input reaches the entry, which answers and exits with its own code", async () => {
    const { sb } = await installedSandbox();
    const live = start(sb);
    const pid = await ready(live);
    await exchange(live, LINES);
    live.endInput();
    expect(await live.readAll(30_000)).toBe(transcript(pid, LINES, "eof"));
    expect(await live.exit(30_000), `stderr ${JSON.stringify(live.stderr())}`).toBe(10);
  });

  testWhen(!IS_WIN, WIN_ONLY_STREAMS, "the starter execs Bun under the same PID: the entry's pid is the one the test started", async () => {
    const { sb } = await installedSandbox();
    const live = start(sb);
    expect(await ready(live), "the entry runs under another PID than the starter process").toBe(live.pid);
    live.endInput();
    expect(await live.exit(30_000)).toBe(10);
  });

  test("a first install from the mirror puts nothing but the entry's bytes on stdout", async () => {
    const server = startServer(await realRoutes(), { delayMs: 300 });
    track(() => server.stop());
    const sb = await sandbox({ mirror: server.url });
    const live = start(sb);
    const pid = await ready(live);
    expect(server.archives(), "this run did not install").toBe(1);
    await exchange(live, LINES.slice(0, 3));
    live.endInput();
    expect(await live.readAll(60_000)).toBe(transcript(pid, LINES.slice(0, 3), "eof"));
    expect(await live.exit(30_000)).toBe(10);
  });

  test("the whole stdout of a run is exactly the entry's lines", async () => {
    const { sb } = await installedSandbox();
    const live = start(sb);
    const pid = await ready(live);
    live.write("one\ntwo\n");
    live.endInput();
    expect(await live.readAll(30_000)).toBe(`ready:${pid}\nreply:one:ü\nreply:two:ü\nbye:eof\n`);
    expect(await live.exit(30_000)).toBe(10);
  });

  for (const [sig, code] of [
    ["SIGINT", 11],
    ["SIGTERM", 12],
    ["SIGHUP", 13],
  ] as const) {
    testWhen(!IS_WIN, WIN_ONLY_STREAMS, `${sig} reaches the entry: it answers bye:${sig} and exits ${code}, passed through`, async () => {
      const { sb } = await installedSandbox();
      const live = start(sb);
      const pid = await ready(live);
      await exchange(live, ["before the signal"]);
      expect(pid, "the entry is not the process the test signals").toBe(live.pid);

      live.kill(sig); // the one process this test started
      expect(await live.readAll(30_000)).toBe(transcript(pid, ["before the signal"], sig));
      expect(await live.exit(30_000), `stderr ${JSON.stringify(live.stderr())}`).toBe(code);
    });
  }
});
