// Shared helpers of the bootstrap scenario suite: starter selection, isolated sandboxes,
// the local fixture server, process spawning and directory inspection.
// Nothing here touches the real ~/.getty: every sandbox sets GETTY_HOME, HOME and
// USERPROFILE to directories under one fresh temporary directory.

import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
// Path comparison lives in lib/paths.ts: a module with no test hooks, so paths.test.ts can
// import it without loading the rest of this file.
export { canonPath, samePath } from "./paths";
export { targetsFor } from "./targets";
import { targetsFor } from "./targets";
import { archiveInfo, loadRealTable, tableWith, type Table } from "./table";

export const IS_WIN = process.platform === "win32";
export const REPO = resolve(import.meta.dir, "../../..");
export const BOOTSTRAP = join(REPO, "bootstrap");
export const REAL_VERSION = "1.4.5";
export const FIXTURE_DIR = join(REPO, ".dev", "fixtures", `bun-v${REAL_VERSION}`);
export const FETCH_COMMAND = "bun bootstrap/test/fetch-fixtures.ts";
// The pin render of the posix worker (bootstrap/README.md defines its CLI).
export const RENDER_SCRIPT = join(BOOTSTRAP, "render-pin.ts");

export type StarterKind = "sh" | "powershell" | "pwsh";

export function starterKind(): StarterKind {
  const v = (process.env.GETTY_BUN_TEST_STARTER ?? "").trim();
  if (v === "") return IS_WIN ? "powershell" : "sh";
  if (v === "sh" || v === "powershell" || v === "pwsh") return v;
  throw new Error(`GETTY_BUN_TEST_STARTER must be sh, powershell or pwsh, got "${v}"`);
}
export const STARTER = starterKind();
export const STARTER_FILE = STARTER === "sh" ? "getty-bun.sh" : "getty-bun.ps1";
export const POLYGLOT_FILE = "getty-bun.cmd";

/** Targets the starter may detect on this host; the fixture server offers all of them. */
export function hostTargets(): string[] {
  const t = targetsFor(process.platform, process.arch);
  if (t === null) throw new Error(`bootstrap suite: unsupported host ${process.platform}/${process.arch} (no starter target)`);
  return t;
}

/** The platform word of the pin block's `# platforms` line for this host. */
export const HOST_PLATFORM: "linux" | "darwin" | "windows" =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";

export const UMLAUTS = "Grüße äöü ß 日本語 €\n";

// ---------------------------------------------------------------------------------------
// fixtures

const fixtureCache = new Map<string, Uint8Array>();

export async function fixtureArchive(target: string): Promise<Uint8Array> {
  const hit = fixtureCache.get(target);
  if (hit) return hit;
  const file = join(FIXTURE_DIR, `bun-${target}.zip`);
  if (!existsSync(file)) {
    throw new Error(
      `fixture archive missing: ${file}\n` +
        `The suite never downloads from GitHub. Run: ${FETCH_COMMAND}`,
    );
  }
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  fixtureCache.set(target, bytes);
  return bytes;
}

export const archivePath = (version: string, target: string) => `/bun-v${version}/bun-${target}.zip`;

export interface RequestRecord {
  path: string;
  method: string;
  /** the Range header as received, or null */
  range: string | null;
  status: number;
}

export interface FixtureServer {
  url: string;
  counts: Map<string, number>;
  /** every request in order, with the Range header the client sent */
  requests: RequestRecord[];
  total(): number;
  count(path: string): number;
  /** requests for any archive (".zip") */
  archives(): number;
  /** archive body bytes handed to clients (a cut response counts what it sent before the cut) */
  bytesServed(): number;
  /** resolves once `n` responses have been cut (see ServerOptions.cut) */
  cutReached(n?: number): Promise<void>;
  stop(): void;
}

export interface ServerOptions {
  delayMs?: number;
  /**
   * answer `Range: bytes=N-` with 206 and the rest, and with 416 (`Content-Range: bytes *` + `/len`,
   * no body) when N is the archive's length or more, as a real server does (default: Range is
   * ignored, 200, whole body)
   */
  ranges?: boolean;
  /**
   * Cut the first `requests` (default 1) archive responses after `afterBytes` body bytes: "stall"
   * keeps the connection open and silent, "drop" ends the whole server with the body unfinished
   * (a later request is refused; a test that goes on starts another server), "end" is a raw TCP
   * server (Bun.serve cannot do this: it drops the declared Content-Length when a body closes
   * early) that sends the headers with the whole length, `afterBytes` of the body and then closes
   * the connection with a FIN, staying up (Windows PowerShell 5.1 can take that for the end of the
   * file). A cut response announces the whole length it would have sent.
   */
  cut?: { afterBytes: number; mode: "stall" | "drop" | "end"; requests?: number };
}

/**
 * The "end" cut: hand-written HTTP/1.1 over a Bun.listen socket. Every request is answered once
 * and the connection closed; the first `cut.requests` archive responses stop after `afterBytes`
 * body bytes with the full Content-Length announced.
 */
function startEndingServer(routes: Record<string, Uint8Array>, opts: ServerOptions): FixtureServer {
  const cut = opts.cut!;
  const counts = new Map<string, number>();
  const requests: RequestRecord[] = [];
  let served = 0;
  let cuts = 0;
  const cutWaiters: Array<{ n: number; resolve: () => void }> = [];
  const enc = new TextEncoder();
  const server = Bun.listen<{ head: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        sock.data = { head: "" };
      },
      data(sock, chunk) {
        sock.data.head += Buffer.from(chunk).toString("latin1");
        if (!sock.data.head.includes("\r\n\r\n")) return;
        const lines = sock.data.head.split("\r\n");
        const [method, target] = lines[0]!.split(" ") as [string, string];
        const path = new URL(target, "http://x").pathname;
        const range = lines.find((l) => /^range:/i.test(l))?.replace(/^range:\s*/i, "") ?? null;
        counts.set(path, (counts.get(path) ?? 0) + 1);
        const rec: RequestRecord = { path, method, range, status: 404 };
        requests.push(rec);
        sock.data.head = "";
        const body = routes[path];
        if (!body) {
          sock.end(enc.encode("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"));
          return;
        }
        let start = 0;
        let status = 200;
        let extra = "";
        const m = opts.ranges && range ? /^bytes=(\d+)-$/.exec(range) : null;
        if (m && Number(m[1]) >= body.length) {
          rec.status = 416;
          sock.end(enc.encode(`HTTP/1.1 416 Range Not Satisfiable\r\ncontent-range: bytes */${body.length}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`));
          return;
        }
        if (m) {
          start = Number(m[1]);
          status = 206;
          extra = `content-range: bytes ${start}-${body.length - 1}/${body.length}\r\n`;
        }
        rec.status = status;
        const slice = body.subarray(start);
        const cutting = path.endsWith(".zip") && cuts < (cut.requests ?? 1);
        const sent = cutting ? slice.subarray(0, cut.afterBytes) : slice;
        const head = `HTTP/1.1 ${status} ${status === 206 ? "Partial Content" : "OK"}\r\ncontent-type: application/zip\r\n${extra}content-length: ${slice.length}\r\nconnection: close\r\n\r\n`;
        const out = Buffer.concat([enc.encode(head), sent]);
        let at = 0;
        const pump = () => {
          while (at < out.length) {
            const n = sock.write(out.subarray(at));
            if (n <= 0) return; // backpressure: drain() calls again
            at += n;
          }
          if (path.endsWith(".zip")) served += sent.length;
          sock.end();
          if (cutting) {
            cuts++;
            const mine = cuts;
            for (const w of cutWaiters.filter((w) => w.n <= mine)) w.resolve();
          }
        };
        (sock.data as { pump?: () => void }).pump = pump;
        pump();
      },
      drain(sock) {
        (sock.data as { pump?: () => void }).pump?.();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    requests,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    count: (p) => counts.get(p) ?? 0,
    archives: () => [...counts].filter(([p]) => p.endsWith(".zip")).reduce((a, [, n]) => a + n, 0),
    bytesServed: () => served,
    cutReached: (n = 1) => (cuts >= n ? Promise.resolve() : new Promise<void>((resolve) => cutWaiters.push({ n, resolve }))),
    stop: () => server.stop(true),
  };
}

export function startServer(routes: Record<string, Uint8Array>, opts: ServerOptions = {}): FixtureServer {
  if (opts.cut?.mode === "end") return startEndingServer(routes, opts);
  const counts = new Map<string, number>();
  const requests: RequestRecord[] = [];
  let served = 0;
  let cuts = 0;
  const cutWaiters: Array<{ n: number; resolve: () => void }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const range = req.headers.get("range");
      const rec: RequestRecord = { path, method: req.method, range, status: 404 };
      requests.push(rec);
      const body = routes[path];
      if (!body) return new Response("not found", { status: 404 });
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      let start = 0;
      let status = 200;
      const headers: Record<string, string> = { "content-type": "application/zip" };
      const m = opts.ranges && range ? /^bytes=(\d+)-$/.exec(range) : null;
      if (m && Number(m[1]) >= body.length) {
        rec.status = 416;
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${body.length}` } });
      }
      if (m) {
        start = Number(m[1]);
        status = 206;
        headers["content-range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
      }
      const slice = body.subarray(start);
      headers["content-length"] = String(slice.length);
      rec.status = status;
      const cut = opts.cut;
      if (cut && path.endsWith(".zip") && cuts < (cut.requests ?? 1)) {
        cuts++;
        const sent = slice.subarray(0, cut.afterBytes);
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(sent);
            served += sent.length;
            const mine = cuts;
            for (const w of cutWaiters.filter((w) => w.n <= mine)) w.resolve();
            // drop: the server goes away with the body unfinished, which resets the connection
            // (closing or erroring the stream would be logged by Bun or end it as a clean chunked body)
            if (cut.mode === "drop") setTimeout(() => server.stop(true), 50);
          },
          pull() {
            return new Promise(() => {}); // stall: nothing more, never ends; server.stop(true) closes it
          },
        });
        return new Response(stream, { status, headers });
      }
      if (path.endsWith(".zip")) served += slice.length;
      return new Response(slice as unknown as BodyInit, { status, headers }); // typing only: Uint8Array<ArrayBufferLike> vs BodyInit in @types/bun 1.3.0
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    requests,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    count: (p) => counts.get(p) ?? 0,
    archives: () => [...counts].filter(([p]) => p.endsWith(".zip")).reduce((a, [, n]) => a + n, 0),
    bytesServed: () => served,
    cutReached: (n = 1) =>
      cuts >= n ? Promise.resolve() : new Promise<void>((resolve) => cutWaiters.push({ n, resolve })),
    stop: () => server.stop(true),
  };
}

/** Routes serving the real archives of every host target under `version`. */
export async function realRoutes(version = REAL_VERSION): Promise<Record<string, Uint8Array>> {
  const routes: Record<string, Uint8Array> = {};
  for (const t of hostTargets()) routes[archivePath(version, t)] = await fixtureArchive(t);
  return routes;
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A test table pinning `version` to `archives` (target -> bytes), member names from the real table. */
export function tableForArchives(
  version: string,
  archives: Record<string, Uint8Array>,
  members?: Record<string, string>,
): Table {
  const real = loadRealTable();
  const targets: Record<string, { sha256: string; member: string }> = {};
  for (const [t, bytes] of Object.entries(archives)) {
    targets[t] = {
      sha256: sha256Hex(bytes),
      member: members?.[t] ?? archiveInfo(real, REAL_VERSION, t).member,
    };
  }
  return tableWith(real, version, targets);
}

// ---------------------------------------------------------------------------------------
// sandbox

// Cleanup is the test file's own job (project hazard rule): importing this module registers
// no hook. Every test file that imports it calls
//
//   afterEach(cleanupAll);
//
// at its top level; bun attaches that to the file it is called in. A registration made at
// import time attaches to the first file that imports the module and leaves every other file's
// sandboxes behind (k43: 46 getty-bun-test-* directories per full run). sandbox.test.ts runs
// two files together and fails when one leaves a directory.
const cleanups: Array<() => Promise<void> | void> = [];
export function track(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}
export async function cleanupAll(): Promise<void> {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch (e) {
      console.warn(`[bootstrap-test] cleanup failed: ${e}`);
    }
  }
}

async function rmTree(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export interface Sandbox {
  tmp: string;
  home: string; // GETTY_HOME (not created)
  userHome: string; // HOME and USERPROFILE
  root: string; // consumer root
  cwd: string; // working directory of every call: deliberately not the consumer root
  mirror: string | null;
  env: Record<string, string>;
  targetCache?: string;
}

export interface SandboxOptions {
  homeName?: string;
  rootName?: string;
  /** table the pin is rendered from; default: the real table */
  table?: Table;
  version?: string;
  /** mirror base URL; null = none set (real download) */
  mirror?: string | null;
  /** pin block `# platforms` line, rendered with render-pin.ts --platforms; default: none */
  platforms?: string[];
  extraEnv?: Record<string, string>;
}

const ENTRY_ECHO = `// stdin to stdout byte for byte; exit code from argv
const code = Number(process.argv[2] ?? 0);
const input = new Uint8Array(await Bun.stdin.arrayBuffer());
// Bun 1.4.5 on Windows: Bun.write(Bun.stdout, <empty>) to a stdout pipe fails with
// "EINVAL: invalid argument, ftruncate" (executed through the ps1's pipe, CI run
// 45572032454). Whether that is Bun's own or the starter's pipe is NOT CHECKED: the
// diagnostics in scenarios.test.ts record both. The SDK side is card k11. Until then an
// empty input writes nothing.
if (input.length > 0) await Bun.write(Bun.stdout, input);
process.exit(code);
`;
const ENTRY_INFO = `// facts about the Bun that runs this entry
process.stdout.write(JSON.stringify({
  version: Bun.version,
  execPath: process.execPath,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}));
`;
const ENTRY_WAIT = `// says it runs, then blocks until stdin ends; exit code 5
process.stdout.write("ready\\n");
await Bun.stdin.arrayBuffer();
process.stdout.write("done\\n");
process.exit(5);
`;
const ENTRY_LINE = `// reads exactly one line (never waits for end of input), replies, exits 5
let buf = "";
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  if (buf.includes("\\n")) break;
}
const line = buf.slice(0, buf.indexOf("\\n"));
process.stdout.write("reply:" + line + ":\\u00fc\\n");
process.exit(5);
`;
const ENTRY_EMPTYWRITE = `// diagnostic: does an empty Bun.write to a piped stdout fail on this Bun? exit code says
try {
  await Bun.write(Bun.stdout, new Uint8Array());
} catch (e) {
  process.stderr.write("empty write failed: " + e + "\\n");
  process.exit(9);
}
`;
// the long-lived stdio server entry kind (ADR 0011): a ready line with its pid, one reply per
// request line, and its own exit code per cause (end of input 10, SIGINT 11, SIGTERM 12, SIGHUP 13)
const ENTRY_SERVE = `let buf = "";
const dec = new TextDecoder();
const bye = (what, code) => { process.stdout.write("bye:" + what + "\\n", () => process.exit(code)); };
process.on("SIGINT", () => bye("SIGINT", 11));
process.on("SIGTERM", () => bye("SIGTERM", 12));
process.on("SIGHUP", () => bye("SIGHUP", 13));
process.stdout.write("ready:" + process.pid + "\\n");
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    process.stdout.write("reply:" + buf.slice(0, i) + ":\\u00fc\\n");
    buf = buf.slice(i + 1);
  }
}
bye("eof", 10);
`;
const ENTRY_CACHEVAR = `process.stdout.write(JSON.stringify({ cache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? null }));
`;
const ENTRY_EMIT = `process.stdout.write(${JSON.stringify(UMLAUTS)});\n`;
// the trivial hook entry of measure-hook.ts: JSON in, JSON out
export const ENTRY_HOOK = `const input = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify({ ok: true, event: input.event ?? null }));
`;

export async function sandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const tmp = realpathSync.native(await mkdtemp(join(tmpdir(), "getty-bun-test-"))); // long names; "RUNNER~1" 8.3 names on GitHub Windows runners are an assumption, not observed
  track(() => rmTree(tmp));
  const home = join(tmp, opts.homeName ?? "getty-home");
  const userHome = join(tmp, "user-home");
  const root = join(tmp, opts.rootName ?? "consumer");
  const cwd = join(tmp, "cwd");
  await mkdir(userHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  for (const d of Object.values(scopedDirs(tmp))) await mkdir(d, { recursive: true });
  await mkdir(join(root, "bootstrap"), { recursive: true });
  await mkdir(join(root, "entries"), { recursive: true });
  await writeFile(join(root, "entries", "echo.ts"), ENTRY_ECHO);
  await writeFile(join(root, "entries", "info.ts"), ENTRY_INFO);
  await writeFile(join(root, "entries", "emit.ts"), ENTRY_EMIT);
  await writeFile(join(root, "entries", "wait.ts"), ENTRY_WAIT);
  await writeFile(join(root, "entries", "empty-write.ts"), ENTRY_EMPTYWRITE);
  await writeFile(join(root, "entries", "line.ts"), ENTRY_LINE);
  await writeFile(join(root, "entries", "hook.ts"), ENTRY_HOOK);
  await writeFile(join(root, "entries", "serve.ts"), ENTRY_SERVE);
  await writeFile(join(root, "entries", "cachevar.ts"), ENTRY_CACHEVAR);
  // a non-bundled entry big enough for Bun's transpiler cache, which stores only 4 KB and more
  await writeFile(join(root, "entries", "padded.ts"), `process.stdout.write("padded\\n");\n// padding: ${"x".repeat(6000)}\n`);

  if (!existsSync(join(BOOTSTRAP, STARTER_FILE))) {
    throw new Error(`starter under test is missing: ${join(BOOTSTRAP, STARTER_FILE)} (GETTY_BUN_TEST_STARTER=${STARTER})`);
  }
  const copied: string[] = [];
  for (const f of ["getty-bun.sh", "getty-bun.ps1"]) {
    const src = join(BOOTSTRAP, f);
    if (existsSync(src)) {
      const dst = join(root, "bootstrap", f);
      await cp(src, dst);
      copied.push(dst);
    }
  }
  // the polyglot carries no pin: copied unchanged, never rendered (ADR 0010); absent until the
  // windows worker delivers it, which the polyglot tests then report
  const polyglot = join(BOOTSTRAP, POLYGLOT_FILE);
  if (existsSync(polyglot)) await cp(polyglot, join(root, "bootstrap", POLYGLOT_FILE));
  const table = opts.table ?? loadRealTable();
  const version = opts.version ?? REAL_VERSION;
  if (copied.length > 0) await renderPin(tmp, table, version, copied, opts.platforms);

  const mirror = opts.mirror === undefined ? null : opts.mirror;
  const sb: Sandbox = { tmp, home, userHome, root, cwd, mirror, env: {} };
  sb.env = buildEnv(sb, opts.extraEnv);
  return sb;
}

/** Render the pin of `version` from `table` into `files` with the posix worker's render. */
export async function renderPin(tmp: string, table: Table, version: string, files: string[], platforms?: string[]) {
  const tablePath = join(tmp, "table.json");
  await writeFile(tablePath, JSON.stringify(table, null, 2));
  const r = await run(
    [
      process.execPath,
      RENDER_SCRIPT,
      "--table",
      tablePath,
      "--version",
      version,
      ...(platforms ? ["--platforms", platforms.join(",")] : []),
      ...files,
    ],
    { env: { ...cleanProcessEnv(), ...scopedDirs(tmp) }, cwd: tmp, timeoutMs: 60_000 },
  );
  if (r.code !== 0) {
    throw new Error(`pin render failed (exit ${r.code}): ${r.err}\n  ${RENDER_SCRIPT}`);
  }
}

function cleanProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

/** PATH without any directory that holds a bun (harness Bun included). */
export function pathWithoutBun(): string {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const harnessDir = dirname(process.execPath);
  const norm = (p: string) => (IS_WIN ? p.toLowerCase() : p);
  return (process.env[key] ?? "")
    .split(delimiter)
    .filter((d) => d !== "")
    .filter((d) => norm(d) !== norm(harnessDir))
    .filter((d) => !existsSync(join(d, "bun")) && !existsSync(join(d, "bun.exe")) && !existsSync(join(d, "bunx")))
    .join(delimiter);
}

/**
 * Where a starter run may write caches and temporary files: all inside the sandbox, so Bun's
 * default transpiler cache (XDG_CACHE_HOME, else HOME; on Windows LOCALAPPDATA, TEMP) never
 * reaches the developer's real one (k43, windows reviewer on k40).
 */
function scopedDirs(tmp: string): Record<string, string> {
  const scratch = join(tmp, "scratch-tmp");
  return IS_WIN
    ? { LOCALAPPDATA: join(tmp, "local-appdata"), TEMP: scratch, TMP: scratch }
    : { XDG_CACHE_HOME: join(tmp, "xdg-cache"), TMPDIR: scratch };
}

export function buildEnv(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const u = k.toUpperCase();
    if (u === "PATH" || u.startsWith("GETTY_") || u === "CODEX_HOME" || u === "BUN_INSTALL") continue;
    if (u === "XDG_CACHE_HOME" || u === "LOCALAPPDATA" || u === "TEMP" || u === "TMP" || u === "TMPDIR") continue;
    env[k] = v;
  }
  env.PATH = pathWithoutBun();
  env.GETTY_HOME = sb.home;
  env.HOME = sb.userHome;
  env.USERPROFILE = sb.userHome;
  env.CODEX_HOME = join(sb.userHome, ".codex");
  Object.assign(env, scopedDirs(sb.tmp));
  if (sb.mirror) env.GETTY_BUN_MIRROR = sb.mirror;
  return { ...env, ...extra };
}

/** Point the sandbox at a mirror (after the server exists). */
export function useMirror(sb: Sandbox, url: string | null): void {
  sb.mirror = url;
  sb.env = buildEnv(sb);
}

// ---------------------------------------------------------------------------------------
// spawning

export interface RunResult {
  code: number | null;
  stdout: Uint8Array;
  out: string; // stdout decoded as UTF-8
  err: string; // stderr decoded as UTF-8
  ms: number;
  timedOut: boolean;
}

/**
 * End a process this test spawned. On Windows the whole tree goes (`taskkill /T /F /PID`):
 * a native child can outlive a killed bash.exe and hold files, which made sandbox cleanup
 * fail with EBUSY (CI run 45579886904).
 *
 * taskkill runs only while Bun still holds the process handle (exitCode and signalCode both
 * null): Bun 1.4.5 closes the libuv handle inside its exit callback, before it records the
 * exit status (source-checked, src/spawn/process.rs ~611-623 at bun-v1.4.5), so after an
 * observed exit a bare PID may already belong to someone else. taskkill is called by absolute
 * path and its exit code is logged. A job object (card k13) is the robust fix. POSIX keeps the
 * plain kill.
 */
export function killTree(proc: {
  pid: number;
  kill: () => void;
  exitCode: number | null; // required: a caller passing only {pid, kill} must not count as alive
  signalCode: string | null;
}): void {
  const alive = proc.exitCode === null && proc.signalCode === null;
  if (IS_WIN && alive) {
    try {
      const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
      const r = Bun.spawnSync({
        cmd: [join(root, "System32", "taskkill.exe"), "/T", "/F", "/PID", String(proc.pid)],
        stdout: "ignore",
        stderr: "ignore",
      });
      console.warn(`[killTree] taskkill /T /F /PID ${proc.pid}: exit ${r.exitCode}`);
    } catch (e) {
      console.warn(`[killTree] taskkill could not run: ${e}`);
    }
  }
  try {
    proc.kill();
  } catch {}
}

export async function run(
  cmd: string[],
  o: {
    env: Record<string, string>;
    cwd?: string;
    stdin?: Uint8Array | string;
    /** stdin is a pipe that is closed at once (not the null device, not a buffer) */
    closePipe?: boolean;
    /** Bun.spawn windowsHide: no window, but the child still gets a console (CREATE_NO_WINDOW) */
    windowsHide?: boolean;
    /** Bun.spawn detached: on Windows DETACHED_PROCESS, no console at all. Exit reporting is
     * source-checked: libuv process.c:1175-1177 registers the exit wait for every child (Windows
     * reviewer, Bun 1.4.5 and oven-sh/libuv@8023581); not executed. */
    detached?: boolean;
    timeoutMs?: number;
  },
): Promise<RunResult> {
  const t0 = performance.now();
  const stdin = o.closePipe ? "pipe" : o.stdin === undefined ? "ignore" : typeof o.stdin === "string" ? Buffer.from(o.stdin) : Buffer.from(o.stdin);
  // windowsHide and detached are handled in Bun 1.4.5's native spawn, js_bun_spawn_bindings.rs
  // :716-722 (windowsHide) and :668-670 (detached): source-checked by the Windows reviewer. Their
  // Windows effects (CREATE_NO_WINDOW, DETACHED_PROCESS) are not executed here.
  const proc = Bun.spawn({
    cmd,
    env: o.env,
    cwd: o.cwd,
    stdin,
    stdout: "pipe",
    stderr: "pipe",
    ...(o.windowsHide ? ({ windowsHide: true } as object) : {}),
    ...(o.detached ? { detached: true } : {}),
  });
  if (o.closePipe) (proc.stdin as { end(): void }).end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc); // only the process this call started (and its children on Windows)
  }, o.timeoutMs ?? 90_000);
  const outP = new Response(proc.stdout).arrayBuffer();
  const errP = new Response(proc.stderr).arrayBuffer();
  await proc.exited;
  clearTimeout(timer);
  const both = await Promise.race([Promise.all([outP, errP]), Bun.sleep(5000).then(() => null)]);
  const stdout = both ? new Uint8Array(both[0]) : new Uint8Array();
  const dec = new TextDecoder();
  const ms = performance.now() - t0;
  return {
    code: proc.exitCode,
    stdout,
    out: dec.decode(stdout),
    err: both ? dec.decode(both[1]) : "",
    ms,
    timedOut,
  };
}

export function starterCmd(root: string, args: string[], kind: StarterKind = STARTER): string[] {
  if (kind === "sh") return ["sh", join(root, "bootstrap", "getty-bun.sh"), ...args];
  return [
    kind,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(root, "bootstrap", "getty-bun.ps1"),
    ...args,
  ];
}

export interface StarterOptions {
  stdin?: Uint8Array | string;
  /** extra environment; a null value removes the variable */
  env?: Record<string, string | null>;
  timeoutMs?: number;
  kind?: StarterKind;
}

/**
 * Call the starter under test. Fails the test when the call timed out and, for every
 * command except `run` and `run-ready` (whose exit code is the entry's), when it exited with 2.
 */
export async function starter(sb: Sandbox, args: string[], o: StarterOptions = {}): Promise<RunResult> {
  const env: Record<string, string> = { ...sb.env };
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  // Claim (Windows reviewer, source-checked, not measured by this suite): the PowerShell
  // starter's default home comes from the user profile API, which does not follow a changed
  // USERPROFILE. Without GETTY_HOME a test could then write to the real profile's .getty,
  // so refuse to spawn. Treated as true until a Windows run shows otherwise.
  if (IS_WIN && !env.GETTY_HOME) {
    throw new Error("refusing to run a starter on Windows without GETTY_HOME (it would touch the real ~/.getty)");
  }
  const r = await run(starterCmd(sb.root, args, o.kind), {
    env,
    cwd: sb.cwd,
    stdin: o.stdin,
    timeoutMs: o.timeoutMs ?? 120_000,
  });
  if (r.timedOut) throw new Error(`starter ${args.join(" ")} timed out after ${r.ms | 0} ms\nstderr: ${r.err}`);
  if (args[0] !== "run" && args[0] !== "run-ready" && r.code === 2) {
    throw new Error(`starter ${args.join(" ")} exited 2 (a starter never exits 2)\nstderr: ${r.err}`);
  }
  return r;
}

export interface StatusJson {
  pin: string;
  target: string;
  slot: string;
  state: string;
}

export async function status(sb: Sandbox, o: StarterOptions = {}): Promise<StatusJson> {
  const r = await starter(sb, ["status"], o);
  if (r.code !== 0) throw new Error(`status exited ${r.code}: ${r.err}`);
  return JSON.parse(r.out) as StatusJson;
}

// ---------------------------------------------------------------------------------------
// inspection

export const bunExe = IS_WIN ? "bun.exe" : "bun";
export const slotDir = (sb: Sandbox, version: string, target: string) =>
  join(sb.home, "runtimes", "bun", version, target);
export const slotBun = (slot: string) => join(slot, "bin", bunExe);
export const lockFile = (sb: Sandbox, version: string, target: string) =>
  join(sb.home, "runtimes", "bun", ".locks", version, target, ".install.lock");
export const stagingDir = (sb: Sandbox) => join(sb.home, "runtimes", "bun", ".staging");

export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Sorted "relative-path size" lines of a tree; a missing dir gives []. Receipts also carry their text. */
export async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string) {
    for (const name of await listDir(d)) {
      const p = join(d, name);
      const s = await stat(p);
      const r = rel ? `${rel}/${name}` : name;
      if (s.isDirectory()) {
        out.push(`${r}/`);
        await walk(p, r);
      } else {
        const extra = name === "receipt.json" ? ` ${await readFile(p, "utf8")}` : "";
        const mode = IS_WIN ? "" : ` ${(s.mode & 0o777).toString(8)}`;
        out.push(`${r} ${s.size}${mode}${extra}`);
      }
    }
  }
  await walk(dir, "");
  return out;
}

/** Whatever a failed install may leave: staging holds nothing. */
export async function stagingLeft(sb: Sandbox): Promise<string[]> {
  return listDir(stagingDir(sb));
}

/** Every directory of `runtimes/bun/<version>`: the published slots of that version. */
export async function publishedTargets(sb: Sandbox, version: string): Promise<string[]> {
  return listDir(join(sb.home, "runtimes", "bun", version));
}

export function lines(s: string): string[] {
  return s.split(/\r?\n/).filter((l) => l !== "");
}

/** Assert an exit code; a failure carries the stderr, so a CI log says why. */
export function expectExit(r: { code: number | null; err: string }, want: number): void {
  if (r.code !== want) {
    throw new Error(`expected exit ${want}, got ${r.code}; stderr: ${JSON.stringify(r.err)}`);
  }
}

/** The failure contract of a starter: one stderr line `getty-bun: ...`, exit 1. */
export function failureLine(r: RunResult): string {
  const l = lines(r.err);
  if (l.length !== 1 || !l[0]!.startsWith("getty-bun: ")) {
    throw new Error(`stderr must be exactly one "getty-bun: " line, got: ${JSON.stringify(r.err)}`);
  }
  return l[0]!;
}

/** Start the real fixture install so a test can begin from `ready`. */
export async function install(sb: Sandbox): Promise<StatusJson> {
  const r = await starter(sb, ["ensure"]);
  if (r.code !== 0) throw new Error(`ensure failed (exit ${r.code}): ${r.err}`);
  return status(sb);
}

// ---------------------------------------------------------------------------------------
// the lock, held by a fixture process of the test (never by the starter)

/**
 * What takes the lock for a fixture process. The starter's lock is flock(2): `flock(1)` on Linux,
 * and on macOS (no flock(1)) the perl that ships there takes the same lock. The fixture uses the
 * same primitive as the starter on each platform; GETTY_BUN_TEST_LOCK_TOOL=perl makes a Linux run
 * use the macOS one, which is how the macOS fixture is checked on Linux.
 */
const LOCK_TOOL: "flock" | "perl" = process.platform === "darwin" || process.env.GETTY_BUN_TEST_LOCK_TOOL === "perl" ? "perl" : "flock";
const PERL_HOLD = `use strict; use Fcntl qw(:flock); open(my $h, ">>", $ARGV[0]) or die "open: $!"; flock($h, LOCK_EX) or die "flock: $!"; $| = 1; print "locked $$\n"; sleep($ARGV[1]);`;
const PERL_TRY = `use strict; use Fcntl qw(:flock); open(my $h, ">>", $ARGV[0]) or exit 2; exit(flock($h, LOCK_EX | LOCK_NB) ? 0 : 1);`;

export interface LockHolder {
  release(): Promise<void>;
}

export async function holdLock(file: string, seconds = 60): Promise<LockHolder> {
  await mkdir(dirname(file), { recursive: true });
  let cmd: string[];
  if (IS_WIN) {
    const ps =
      `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','OpenOrCreate','ReadWrite','None');` +
      `[Console]::Out.WriteLine('locked '+$PID);[Console]::Out.Flush();Start-Sleep -Seconds ${seconds};$f.Dispose()`;
    cmd = ["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps];
  } else if (LOCK_TOOL === "perl") {
    cmd = ["perl", "-e", PERL_HOLD, file, String(seconds)];
  } else {
    cmd = ["flock", file, "sh", "-c", `echo "locked $$"; exec sleep ${seconds}`];
  }
  const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let buf = "";
  const deadline = Date.now() + 30_000;
  let pid = 0;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (value) buf += new TextDecoder().decode(value);
    const m = buf.match(/locked (\d+)/);
    if (m) {
      pid = Number(m[1]);
      break;
    }
    if (done) break;
  }
  if (!pid) {
    killTree(proc);
    throw new Error(`lock holder did not report the lock: ${JSON.stringify(buf)}`);
  }
  let released = false;
  const holder: LockHolder = {
    async release() {
      if (released) return;
      released = true;
      // Only while Bun still holds the handle: on Windows this PID is the holder's own $PID,
      // equal to proc.pid, and may be reused after an observed exit (see killTree).
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          process.kill(pid); // the holder this helper started
        } catch {}
      }
      killTree(proc);
      await proc.exited;
    },
  };
  track(() => holder.release());
  return holder;
}

/**
 * Take the lock without waiting, the way a test fixture would (`flock -n` on POSIX, a
 * PowerShell process opening the file with FileShare.None on Windows). Exit 0 = got it
 * (and released it again), 1 = somebody holds it.
 */
export async function tryLock(file: string): Promise<{ code: number | null; err: string }> {
  await mkdir(dirname(file), { recursive: true });
  const cmd = IS_WIN
    ? [
        "powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        `try{$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','OpenOrCreate','ReadWrite','None');$f.Dispose();exit 0}catch{exit 1}`,
      ]
    : LOCK_TOOL === "perl"
      ? ["perl", "-e", PERL_TRY, file]
      : ["flock", "-n", file, "true"];
  const r = await run(cmd, { env: cleanProcessEnv(), timeoutMs: 30_000 });
  return { code: r.code, err: r.err };
}

/**
 * Git for Windows' two bash executables: `<git>\bin\bash.exe` is a native wrapper (what a
 * user or host finds first), `<git>\usr\bin\bash.exe` is the MSYS bash it starts.
 */
export function gitBashPair(): { wrapper: string; direct: string } | null {
  const wrapper = findGitBashExe();
  if (!wrapper) return null;
  const root = dirname(dirname(wrapper));
  const direct = join(root, "usr", "bin", "bash.exe");
  return existsSync(direct) ? { wrapper, direct } : null;
}

/** Git for Windows' bash.exe (never the WSL launcher in System32); null when absent. */
export function findGitBashExe(): string | null {
  const candidates: string[] = [];
  const g = Bun.spawnSync({ cmd: ["git", "--exec-path"], stdout: "pipe", stderr: "ignore" });
  if (g.exitCode === 0) {
    // <git>/mingw64/libexec/git-core -> <git>/bin/bash.exe
    const p = new TextDecoder().decode(g.stdout).trim().replace(/\//g, "\\");
    candidates.push(join(p, "..", "..", "..", "bin", "bash.exe"), join(p, "..", "..", "bin", "bash.exe"));
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
    if (!base) continue;
    candidates.push(join(base, "Git", "bin", "bash.exe"), join(base, "Programs", "Git", "bin", "bash.exe"));
  }
  candidates.push("C:\\Program Files\\Git\\bin\\bash.exe");
  for (const c of candidates) if (existsSync(c)) return resolve(c);
  return null;
}

/** A fake bun for scenario 7: leaves a marker file and prints a wrong version. */
export async function fakeBunDir(sb: Sandbox): Promise<{ dir: string; marker: string }> {
  const dir = join(sb.tmp, "fakebin");
  const marker = join(sb.tmp, "fake-bun-was-called");
  await mkdir(dir, { recursive: true });
  if (IS_WIN) {
    await writeFile(join(dir, "bun.cmd"), `@echo off\r\necho called> "${marker}"\r\necho 0.0.0-fake\r\n`);
  } else {
    await writeFile(join(dir, "bun"), `#!/bin/sh\necho called > '${marker}'\necho 0.0.0-fake\n`, { mode: 0o755 });
  }
  return { dir, marker };
}

// ---------------------------------------------------------------------------------------
// planted slots: a published slot built by the test, for scenarios that need `ready` or
// `mismatch` without a download (the x64 slot choice, run-ready)

/** The receipt of README.md's canonical bytes, with the table's archive facts for `target`. */
export function receiptText(version: string, target: string, verifiedAt = "2026-11-27T00:00:00Z"): string {
  const e = archiveInfo(loadRealTable(), REAL_VERSION, target);
  const zeros = "0".repeat(64);
  return (
    `{\n  "version": "${version}",\n  "target": "${target}",\n  "archiveSha256": "${e.sha256}",\n` +
    `  "contractVersion": 1,\n  "archive": "${e.archive}",\n  "member": "${e.member}",\n` +
    `  "binarySha256": "${zeros}",\n  "executable": "bin/${bunExe}",\n  "verifiedAt": "${verifiedAt}"\n}\n`
  );
}

/**
 * Publish a slot by hand. The fast path reads the receipt's first lines and checks that bin/bun
 * is a non-empty executable file, never runs it, so the Bun of a planted slot is a script that
 * names its target and echoes its arguments (POSIX) or a copy of the harness Bun (Windows,
 * where a script cannot be a bun.exe; its execPath then names the slot). `receiptVersion`
 * differs from `version` for a slot that does not match.
 */
export async function plantSlot(
  sb: Sandbox,
  target: string,
  o: { version?: string; receiptVersion?: string } = {},
): Promise<string> {
  const version = o.version ?? REAL_VERSION;
  const slot = slotDir(sb, version, target);
  await mkdir(join(slot, "bin"), { recursive: true });
  await writeFile(join(slot, "receipt.json"), receiptText(o.receiptVersion ?? version, target));
  if (IS_WIN) {
    await cp(process.execPath, slotBun(slot));
  } else {
    await writeFile(
      slotBun(slot),
      `#!/bin/sh\nprintf 'fake-bun:%s\\n' '${target}'\nfor a in "$@"; do printf 'arg:%s\\n' "$a"; done\n`,
      { mode: 0o755 },
    );
  }
  return slot;
}

/** Whether `out` (stdout of a run through a planted slot) came from the Bun of `target`. */
export function ranTarget(out: string, target: string): boolean {
  if (!IS_WIN) return out.split("\n").includes(`fake-bun:${target}`);
  try {
    return String(JSON.parse(out).execPath).replaceAll("\\", "/").toLowerCase().includes(`/${target}/bin/`);
  } catch {
    return false;
  }
}

/** Whether this host's CPU has AVX2 (Linux: the flags line of /proc/cpuinfo); null when unknown. */
export function hostHasAvx2(): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const m = /^flags\s*:(.*)$/m.exec(require("node:fs").readFileSync("/proc/cpuinfo", "utf8"));
    return m ? m[1]!.split(/\s+/).includes("avx2") : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// a started process the test talks to (a long-lived stdio server), and process facts

export interface Live {
  pid: number;
  proc: { exitCode: number | null; signalCode: string | null; exited: Promise<number> };
  /** the next complete stdout line, without its newline; fails after timeoutMs */
  readLine(timeoutMs?: number): Promise<string>;
  write(s: string): void;
  endInput(): void;
  /** all stdout so far plus everything until the process closes stdout */
  readAll(timeoutMs?: number): Promise<string>;
  stderr(): string;
  /** signal the one process this handle started: POSIX `kill(signal)`; Windows ends the tree (taskkill /T /F) */
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): void;
  /** wait for the exit; returns the exit code (null: signal) */
  exit(timeoutMs?: number): Promise<number | null>;
}

/** Start `cmd` with a pipe for stdin and read its stdout incrementally. Killed in cleanup. */
export function startLive(cmd: string[], o: { env: Record<string, string>; cwd: string }): Live {
  const proc = Bun.spawn({ cmd, env: o.env, cwd: o.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  track(async () => {
    // the process this test started, and what it started (found by parent PID while it lives):
    // a red run must leave neither behind. No kill by name.
    const kids = !IS_WIN && proc.exitCode === null && proc.signalCode === null ? descendantsOf(proc.pid) : [];
    if (proc.exitCode === null && proc.signalCode === null) killTree(proc);
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    killRecorded(kids);
  });
  const dec = new TextDecoder();
  let buf = "";
  let all = "";
  let err = "";
  let closed = false;
  let wake: Array<() => void> = [];
  const poke = () => {
    const w = wake;
    wake = [];
    for (const f of w) f();
  };
  (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      const t = dec.decode(chunk, { stream: true });
      buf += t;
      all += t;
      poke();
    }
    closed = true;
    poke();
  })();
  (async () => {
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) err += dec.decode(chunk, { stream: true });
  })();
  const waitFor = (cond: () => boolean, what: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        if (cond()) return resolve();
        const left = timeoutMs - (Date.now() - t0);
        if (left <= 0) return reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}; stdout so far ${JSON.stringify(all)}, stderr ${JSON.stringify(err)}`));
        const timer = setTimeout(check, Math.min(left, 200));
        wake.push(() => {
          clearTimeout(timer);
          check();
        });
      };
      check();
    });
  return {
    pid: proc.pid,
    proc,
    async readLine(timeoutMs = 60_000) {
      await waitFor(() => buf.includes("\n") || closed, "a stdout line", timeoutMs);
      const i = buf.indexOf("\n");
      if (i < 0) throw new Error(`stdout closed before a line; stdout so far ${JSON.stringify(all)}, stderr ${JSON.stringify(err)}`);
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      return line;
    },
    write(s) {
      (proc.stdin as { write(x: string): number; flush(): void }).write(s);
      (proc.stdin as { flush(): void }).flush();
    },
    endInput() {
      (proc.stdin as { end(): void }).end();
    },
    async readAll(timeoutMs = 60_000) {
      await waitFor(() => closed, "stdout to close", timeoutMs);
      return all;
    },
    stderr: () => err,
    kill(signal) {
      if (IS_WIN || signal === undefined) killTree(proc);
      else proc.kill(signal);
    },
    async exit(timeoutMs = 60_000) {
      const r = await Promise.race([proc.exited.then(() => "exited" as const), Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
      if (r === "timeout") throw new Error(`process ${proc.pid} still running ${timeoutMs} ms after it should have ended; stdout ${JSON.stringify(all)}, stderr ${JSON.stringify(err)}`);
      return proc.exitCode;
    },
  };
}

export interface ProcFact {
  pid: number;
  comm: string;
  /** identity token: the same PID with another token is another process */
  id: string;
}

/** Start identity of a process, or null when it is gone or a zombie. POSIX only. */
export function procIdentity(pid: number): string | null {
  const fs = require("node:fs") as typeof import("node:fs");
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (rest[0] === "Z") return null;
    return rest[19] ?? "";
  } catch {
    // no /proc (macOS): ps
    const r = Bun.spawnSync({ cmd: ["ps", "-o", "stat=,lstart=", "-p", String(pid)], stdout: "pipe", stderr: "ignore" });
    const out = new TextDecoder().decode(r.stdout).trim();
    if (r.exitCode !== 0 || out === "" || out.startsWith("Z")) return null;
    return out;
  }
}

/** The processes that descend from `pid` right now (children, grandchildren, ...), by ppid. POSIX only. */
export function descendantsOf(pid: number): ProcFact[] {
  const r = Bun.spawnSync({ cmd: ["ps", "-A", "-o", "pid=,ppid=,comm="], stdout: "pipe", stderr: "ignore" });
  const kids = new Map<number, Array<{ pid: number; comm: string }>>();
  for (const line of new TextDecoder().decode(r.stdout).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const ppid = Number(m[2]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid)!.push({ pid: Number(m[1]), comm: m[3]!.trim() });
  }
  const out: ProcFact[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      const id = procIdentity(k.pid);
      if (id === null) continue;
      out.push({ pid: k.pid, comm: k.comm, id });
      queue.push(k.pid);
    }
  }
  return out;
}

/** Still the same process (not exited, not reused)? */
export const stillRunning = (f: ProcFact) => procIdentity(f.pid) === f.id;

/** SIGKILL the recorded processes that are still the same ones: only PIDs this test recorded. */
export function killRecorded(list: ProcFact[]): void {
  for (const f of list) {
    if (!stillRunning(f)) continue;
    try {
      process.kill(f.pid, "SIGKILL");
    } catch {}
  }
}

/** Poll `cond` every 100 ms until it is true; fails with `what` after `timeoutMs`. */
export async function pollUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** Size of a file, or null when it does not exist. */
export async function fileSize(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}
