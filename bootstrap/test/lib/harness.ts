// Shared helpers of the bootstrap scenario suite: starter selection, isolated sandboxes,
// the local fixture server, process spawning and directory inspection.
// Nothing here touches the real ~/.getty: every sandbox sets GETTY_HOME, HOME and
// USERPROFILE to directories under one fresh temporary directory.

import { afterEach } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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

/** Targets the starter may detect on this host; the fixture server offers all of them. */
export function hostTargets(): string[] {
  const arch = process.arch;
  if (process.platform === "linux") {
    if (arch === "x64") return ["linux-x64", "linux-x64-baseline"];
    if (arch === "arm64") return ["linux-aarch64"];
  }
  if (process.platform === "win32" && arch === "x64") return ["windows-x64", "windows-x64-baseline"];
  throw new Error(`bootstrap suite: unsupported host ${process.platform}/${arch} (MVP targets only)`);
}

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

export interface FixtureServer {
  url: string;
  counts: Map<string, number>;
  total(): number;
  count(path: string): number;
  /** requests for any archive (".zip") */
  archives(): number;
  stop(): void;
}

export function startServer(
  routes: Record<string, Uint8Array>,
  opts: { delayMs?: number } = {},
): FixtureServer {
  const counts = new Map<string, number>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const body = routes[path];
      if (!body) return new Response("not found", { status: 404 });
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      return new Response(body, {
        headers: { "content-type": "application/zip", "content-length": String(body.length) },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    count: (p) => counts.get(p) ?? 0,
    archives: () => [...counts].filter(([p]) => p.endsWith(".zip")).reduce((a, [, n]) => a + n, 0),
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

const cleanups: Array<() => Promise<void> | void> = [];
export function track(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}
try {
  // under `bun test`; measure-hook.ts imports this file outside the runner and cleans up itself
  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      try {
        await fn();
      } catch (e) {
        console.warn(`[bootstrap-test] cleanup failed: ${e}`);
      }
    }
  });
} catch {}

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
  /** starters to copy into the consumer (default both that exist) */
  extraEnv?: Record<string, string>;
}

const ENTRY_ECHO = `// stdin to stdout byte for byte; exit code from argv
const code = Number(process.argv[2] ?? 0);
const input = new Uint8Array(await Bun.stdin.arrayBuffer());
await Bun.write(Bun.stdout, input);
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
const ENTRY_EMIT = `process.stdout.write(${JSON.stringify(UMLAUTS)});\n`;
// the trivial hook entry of measure-hook.ts: JSON in, JSON out
export const ENTRY_HOOK = `const input = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify({ ok: true, event: input.event ?? null }));
`;

export async function sandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "getty-bun-test-")));
  track(() => rmTree(tmp));
  const home = join(tmp, opts.homeName ?? "getty-home");
  const userHome = join(tmp, "user-home");
  const root = join(tmp, opts.rootName ?? "consumer");
  const cwd = join(tmp, "cwd");
  await mkdir(userHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, "bootstrap"), { recursive: true });
  await mkdir(join(root, "entries"), { recursive: true });
  await writeFile(join(root, "entries", "echo.ts"), ENTRY_ECHO);
  await writeFile(join(root, "entries", "info.ts"), ENTRY_INFO);
  await writeFile(join(root, "entries", "emit.ts"), ENTRY_EMIT);
  await writeFile(join(root, "entries", "wait.ts"), ENTRY_WAIT);
  await writeFile(join(root, "entries", "line.ts"), ENTRY_LINE);
  await writeFile(join(root, "entries", "hook.ts"), ENTRY_HOOK);

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
  const table = opts.table ?? loadRealTable();
  const version = opts.version ?? REAL_VERSION;
  if (copied.length > 0) await renderPin(tmp, table, version, copied);

  const mirror = opts.mirror === undefined ? null : opts.mirror;
  const sb: Sandbox = { tmp, home, userHome, root, cwd, mirror, env: {} };
  sb.env = buildEnv(sb, opts.extraEnv);
  return sb;
}

/** Render the pin of `version` from `table` into `files` with the posix worker's render. */
export async function renderPin(tmp: string, table: Table, version: string, files: string[]) {
  const tablePath = join(tmp, "table.json");
  await writeFile(tablePath, JSON.stringify(table, null, 2));
  const r = await run(
    [process.execPath, RENDER_SCRIPT, "--table", tablePath, "--version", version, ...files],
    { env: cleanProcessEnv(), cwd: tmp, timeoutMs: 60_000 },
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

export function buildEnv(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const u = k.toUpperCase();
    if (u === "PATH" || u.startsWith("GETTY_") || u === "CODEX_HOME" || u === "BUN_INSTALL") continue;
    env[k] = v;
  }
  env.PATH = pathWithoutBun();
  env.GETTY_HOME = sb.home;
  env.HOME = sb.userHome;
  env.USERPROFILE = sb.userHome;
  env.CODEX_HOME = join(sb.userHome, ".codex");
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

export async function run(
  cmd: string[],
  o: { env: Record<string, string>; cwd?: string; stdin?: Uint8Array | string; timeoutMs?: number },
): Promise<RunResult> {
  const t0 = performance.now();
  const stdin = o.stdin === undefined ? "ignore" : typeof o.stdin === "string" ? Buffer.from(o.stdin) : Buffer.from(o.stdin);
  const proc = Bun.spawn({ cmd, env: o.env, cwd: o.cwd, stdin, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(); // only the process this call started
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
  env?: Record<string, string>;
  timeoutMs?: number;
  kind?: StarterKind;
}

/**
 * Call the starter under test. Fails the test when the call timed out and, for every
 * command except `run` (whose exit code is the entry's), when it exited with 2.
 */
export async function starter(sb: Sandbox, args: string[], o: StarterOptions = {}): Promise<RunResult> {
  const r = await run(starterCmd(sb.root, args, o.kind), {
    env: { ...sb.env, ...(o.env ?? {}) },
    cwd: sb.cwd,
    stdin: o.stdin,
    timeoutMs: o.timeoutMs ?? 120_000,
  });
  if (r.timedOut) throw new Error(`starter ${args.join(" ")} timed out after ${r.ms | 0} ms\nstderr: ${r.err}`);
  if (args[0] !== "run" && r.code === 2) {
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
        out.push(`${r} ${s.size}${extra}`);
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

/** The failure contract of a starter: one stderr line `getty-bun: ...`, exit 1. */
export function failureLine(r: RunResult): string {
  const l = lines(r.err).filter((x) => x.startsWith("getty-bun: "));
  if (l.length === 0) throw new Error(`no "getty-bun: " line on stderr: ${JSON.stringify(r.err)}`);
  return l.join("\n");
}

/** Start the real fixture install so a test can begin from `ready`. */
export async function install(sb: Sandbox): Promise<StatusJson> {
  const r = await starter(sb, ["ensure"]);
  if (r.code !== 0) throw new Error(`ensure failed (exit ${r.code}): ${r.err}`);
  return status(sb);
}

// ---------------------------------------------------------------------------------------
// the lock, held by a fixture process of the test (never by the starter)

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
    proc.kill();
    throw new Error(`lock holder did not report the lock: ${JSON.stringify(buf)}`);
  }
  let released = false;
  const holder: LockHolder = {
    async release() {
      if (released) return;
      released = true;
      try {
        process.kill(pid); // the holder this helper started
      } catch {}
      proc.kill();
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
    : ["flock", "-n", file, "true"];
  const r = await run(cmd, { env: cleanProcessEnv(), timeoutMs: 30_000 });
  return { code: r.code, err: r.err };
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
