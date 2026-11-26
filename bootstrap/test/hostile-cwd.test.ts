// k29: a hook runs with the session cwd, which is the user's project, so the project may be
// hostile. Bun reads ./bunfig.toml (preload, [define]) and ./.env* from its cwd; the starter
// must keep all of that, and BUN_OPTIONS from the environment, away from the entry, without
// changing the cwd the entry sees.
//
// Every attack is first run against a raw Bun (a control inside each test), so a test cannot
// pass because the attack never worked on the platform: a control that does not fire fails.
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/hostile-cwd.test.ts

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IS_WIN,
  REAL_VERSION,
  STARTER,
  expectExit,
  exists,
  findGitBashExe,
  install,
  realRoutes,
  run,
  samePath,
  sandbox,
  slotBun,
  startServer,
  starter,
  starterCmd,
  track,
  type RunResult,
  type Sandbox,
} from "./lib/harness";

setDefaultTimeout(300_000);

const ENTRY = `// reports what the project could have changed; cwd must stay the project
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  dotenv: process.env.HOSTILE_DOTENV ?? null,
  dotenvLocal: process.env.HOSTILE_DOTENV_LOCAL ?? null,
  defineEnv: process.env.HOSTILE_DEFINE_ENV ?? null,
  defineGlobal: typeof HOSTILE_DEFINE_GLOBAL === "undefined" ? null : HOSTILE_DEFINE_GLOBAL,
  preloaded: (globalThis as any).__hostilePreload ?? null,
}) + "\\n");
`;

interface Attack {
  project: string;
  projectPreloadMarker: string;
  optionsPreloadMarker: string;
  /** markers of the negative checks (see hostile()); none may exist after a starter run */
  negativeMarkers: string[];
  env: Record<string, string>;
  entry: string;
}

/** A scratch "project" with bunfig.toml, .env and .env.local, and a BUN_OPTIONS preload. */
async function hostile(sb: Sandbox): Promise<Attack> {
  const parent = join(sb.tmp, "parent");
  const project = join(parent, "project");
  const markers = join(sb.tmp, "markers");
  await mkdir(project, { recursive: true });
  await mkdir(markers, { recursive: true });
  const projectPreloadMarker = join(markers, "project-preload");
  const optionsPreloadMarker = join(markers, "bun-options-preload");
  const q = (p: string) => JSON.stringify(p);
  await writeFile(
    join(project, "pre.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${q(projectPreloadMarker)}, "ran");
(globalThis as any).__hostilePreload = "project";
console.error("HOSTILE PRELOAD RAN from project");
`,
  );
  await writeFile(
    join(project, "bunfig.toml"),
    `preload = ["./pre.ts"]

[define]
"process.env.HOSTILE_DEFINE_ENV" = "\\"defined\\""
HOSTILE_DEFINE_GLOBAL = "\\"defined\\""
`,
  );
  await writeFile(join(project, ".env"), "HOSTILE_DOTENV=from-dotenv\n");
  await writeFile(join(project, ".env.local"), "HOSTILE_DOTENV_LOCAL=from-dotenv-local\n");
  const optionsPreload = join(markers, "options-preload.ts");
  await writeFile(
    optionsPreload,
    `import { writeFileSync } from "node:fs";
writeFileSync(${q(optionsPreloadMarker)}, "ran");
console.error("HOSTILE BUN_OPTIONS PRELOAD RAN");
`,
  );
  // Negative checks WITHOUT a firing control: Bun itself is expected to ignore these (the posix
  // worker saw no effect on Linux even without the starter's flags), so no control shows them
  // fire. They are evidence for Windows (brief point 0) that nothing else reads a preload: a
  // bunfig.toml in the PARENT of the project cwd, ~/.bunfig.toml (HOME and USERPROFILE are the
  // sandbox's user-home), $XDG_CONFIG_HOME/.bunfig.toml, and NODE_OPTIONS=--require=<script>.
  const negativeMarkers: string[] = [];
  const negative = async (name: string, dir: string, file: string) => {
    const marker = join(markers, `neg-${name}`);
    const script = join(markers, `neg-${name}.ts`);
    await mkdir(dir, { recursive: true });
    await writeFile(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${q(marker)}, "ran");\nconsole.error("HOSTILE ${name} PRELOAD RAN");\n`);
    await writeFile(join(dir, file), `preload = [${q(script.replaceAll("\\", "/"))}]\n`);
    negativeMarkers.push(marker);
  };
  const xdgConfig = join(sb.tmp, "xdg-config");
  await negative("parent-bunfig", parent, "bunfig.toml");
  await negative("home-bunfig", sb.userHome, ".bunfig.toml");
  await negative("xdg-bunfig", xdgConfig, ".bunfig.toml");
  const nodeScript = join(markers, "node-options.cjs");
  const nodeMarker = join(markers, "neg-node-options");
  await writeFile(nodeScript, `require("node:fs").writeFileSync(${q(nodeMarker)}, "ran");\nconsole.error("HOSTILE NODE_OPTIONS RAN");\n`);
  negativeMarkers.push(nodeMarker);
  const entry = join(sb.root, "entries", "hostile.ts");
  await writeFile(entry, ENTRY);
  const env: Record<string, string> = {
    ...sb.env,
    // forward slashes, as the gate does: Windows backslashes in BUN_OPTIONS may be eaten by its
    // option splitting, which would fail the control for parsing reasons
    BUN_OPTIONS: `--preload=${optionsPreload.replaceAll("\\", "/")}`,
    NODE_OPTIONS: `--require=${nodeScript.replaceAll("\\", "/")}`,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: join(sb.tmp, "xdg-cache"),
    XDG_DATA_HOME: join(sb.tmp, "xdg-data"),
    TMPDIR: join(sb.tmp, "scratch-tmp"),
    TMP: join(sb.tmp, "scratch-tmp"),
    TEMP: join(sb.tmp, "scratch-tmp"),
  };
  // `bun test` sets NODE_ENV=test, under which Bun does not load .env.local; a hook has no such variable
  delete env.NODE_ENV;
  await mkdir(env.TMPDIR!, { recursive: true });
  return { project, projectPreloadMarker, optionsPreloadMarker, negativeMarkers, env, entry };
}

const CLEAN = (project: string) => ({
  cwd: project,
  dotenv: null,
  dotenvLocal: null,
  defineEnv: null,
  defineGlobal: null,
  preloaded: null,
});

/** The control: a raw Bun in the hostile cwd. Every attack must show an effect here. */
async function expectAttackEffective(a: Attack, bunPath: string): Promise<void> {
  const r = await run([bunPath, "--no-install", a.entry], { env: a.env, cwd: a.project, timeoutMs: 60_000 });
  const why = `control (raw ${bunPath} in the project cwd) exit ${r.code}, stderr ${JSON.stringify(r.err)}, stdout ${JSON.stringify(r.out)}`;
  expect(r.code, why).toBe(0);
  const seen = JSON.parse(r.out);
  expect(samePath(seen.cwd, a.project), why).toBe(true);
  expect(seen.dotenv, `.env not loaded: ${why}`).toBe("from-dotenv");
  expect(seen.dotenvLocal, `.env.local not loaded: ${why}`).toBe("from-dotenv-local");
  expect(seen.defineEnv, `[define] of process.env.X had no effect: ${why}`).toBe("defined");
  expect(seen.defineGlobal, `[define] of a global had no effect: ${why}`).toBe("defined");
  expect(seen.preloaded, `bunfig preload did not run: ${why}`).toBe("project");
  expect(await exists(a.projectPreloadMarker), `bunfig preload left no marker: ${why}`).toBe(true);
  expect(await exists(a.optionsPreloadMarker), `BUN_OPTIONS preload left no marker: ${why}`).toBe(true);
  await rmMarkers(a);
}

async function rmMarkers(a: Attack): Promise<void> {
  await rm(a.projectPreloadMarker, { force: true });
  await rm(a.optionsPreloadMarker, { force: true });
  for (const m of a.negativeMarkers) await rm(m, { force: true }); // whatever a raw Bun did: not asserted
}

async function expectNoEffect(a: Attack, r: RunResult): Promise<void> {
  const why = `exit ${r.code}, stderr ${JSON.stringify(r.err)}, stdout ${JSON.stringify(r.out)}`;
  expectExit(r, 0);
  expect(r.err, why).not.toContain("HOSTILE");
  expect(await exists(a.projectPreloadMarker), `the project's preload ran: ${why}`).toBe(false);
  expect(await exists(a.optionsPreloadMarker), `the BUN_OPTIONS preload ran: ${why}`).toBe(false);
  for (const m of a.negativeMarkers) expect(await exists(m), `${m} ran: ${why}`).toBe(false);
  const seen = JSON.parse(r.out);
  expect(samePath(seen.cwd, a.project), `entry cwd ${seen.cwd} is not the project: ${why}`).toBe(true);
  expect({ ...seen, cwd: a.project }, why).toEqual(CLEAN(a.project));
}

async function serverFor() {
  const s = startServer(await realRoutes());
  track(() => s.stop());
  return s;
}

describe(`hostile project cwd (k29) [${STARTER}]`, () => {
  test("installing first run: the project's bunfig.toml, .env and BUN_OPTIONS do not reach the entry; cwd stays the project", async () => {
    const server = await serverFor();
    const sb = await sandbox({ mirror: server.url });
    const a = await hostile(sb);
    await expectAttackEffective(a, process.execPath);

    const r = await run(
      starterCmd(sb.root, ["run", "entries/hostile.ts"]),
      { env: a.env, cwd: a.project, timeoutMs: 120_000 },
    );
    expect(server.archives(), "this run did not install").toBe(1);
    await expectNoEffect(a, r);
  });

  test("fast path (slot already installed): the same attacks have no effect; cwd stays the project", async () => {
    const server = await serverFor();
    const sb = await sandbox({ mirror: server.url });
    const st = await install(sb); // from the neutral cwd
    const a = await hostile(sb);
    await expectAttackEffective(a, slotBun(st.slot));
    const requests = server.total();

    const r = await run(starterCmd(sb.root, ["run", "entries/hostile.ts"]), { env: a.env, cwd: a.project, timeoutMs: 120_000 });
    expect(server.total(), "the fast path made a request").toBe(requests);
    await expectNoEffect(a, r);
  });
});

// k40: Bun 1.4.5 reads more environment variables that load code or change where an entry's
// modules come from than BUN_OPTIONS: BUN_INSPECT_PRELOAD is a preload even under --config and
// --no-env-file, NODE_PATH adds a resolution root, BUN_INSPECT / BUN_INSPECT_CONNECT_TO start a
// debugger, NODE_COMPILE_CACHE and BUN_RUNTIME_TRANSPILER_CACHE_PATH choose cache directories,
// BUN_INTERNAL_WEBVIEW_HOST is macOS-only. The starter removes all seven from the entry's
// environment. Controls first: a raw Bun with the starter's flags must show the preload, the
// NODE_PATH package and the cache writes, so a green starter run cannot mean the attack never
// worked here. The controls set no BUN_INSPECT* and no BUN_INTERNAL_WEBVIEW_HOST (not run raw:
// the debugger and the macOS host mode are not cheap or portable); those three are covered by the
// entry's view of process.env only.
const LOADER_VARS = [
  "BUN_INSPECT_PRELOAD",
  "BUN_INSPECT",
  "BUN_INSPECT_CONNECT_TO",
  "NODE_PATH",
  "NODE_COMPILE_CACHE",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "BUN_INTERNAL_WEBVIEW_HOST",
] as const;

// The transpiler cache stores only entries of 4 KB and more (scout, checked with Bun 1.4.5 on Linux).
const LOADERS_ENTRY = `// reports what the environment could have changed
let pkg: unknown = null;
try { pkg = require("k40-nodepath-pkg"); } catch {}
const names = ${JSON.stringify(LOADER_VARS)};
process.stdout.write(JSON.stringify({
  pkg,
  env: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])),
}) + "\\n");
// padding: ${"x".repeat(6000)}
`;

const mine: string[] = [];
afterEach(async () => {
  while (mine.length) await rm(mine.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

interface Loaders {
  env: Record<string, string>;
  emptyConfig: string;
  preloadMarker: string;
  transpilerCache: string;
  compileCache: string;
}

const fwd = (p: string) => p.replaceAll("\\", "/");

async function loaderAttack(sb: Sandbox): Promise<Loaders> {
  mine.push(sb.tmp);
  const dir = join(sb.tmp, "loaders");
  const pkgDir = join(dir, "node-path", "k40-nodepath-pkg");
  const transpilerCache = join(dir, "transpiler-cache");
  const compileCache = join(dir, "compile-cache");
  const preloadMarker = join(dir, "inspect-preload-marker");
  const emptyConfig = join(dir, "empty-bunfig.toml");
  await mkdir(pkgDir, { recursive: true });
  await mkdir(transpilerCache, { recursive: true });
  await mkdir(compileCache, { recursive: true });
  await writeFile(join(pkgDir, "index.js"), `module.exports = "from-node-path";\n`);
  await writeFile(emptyConfig, "");
  const preload = join(dir, "inspect-preload.ts");
  await writeFile(
    preload,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(preloadMarker)}, "ran");\nconsole.error("HOSTILE BUN_INSPECT_PRELOAD RAN");\n`,
  );
  await writeFile(join(sb.root, "entries", "loaders.ts"), LOADERS_ENTRY);
  const env: Record<string, string> = {
    ...sb.env,
    BUN_INSPECT_PRELOAD: fwd(preload),
    NODE_PATH: join(dir, "node-path"),
    NODE_COMPILE_CACHE: compileCache,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
    // a unix socket path in the sandbox: Bun 1.4.5 listens there (a socket file, no port) and exits
    // normally; a ws://host:port value would open a port or fail. Executed on Linux only.
    BUN_INSPECT: `ws+unix://${fwd(join(dir, "inspect.sock"))}`,
    // nothing listens at this path: connecting fails fast (executed on Linux: no hang)
    BUN_INSPECT_CONNECT_TO: fwd(join(dir, "connect.sock")),
    BUN_INTERNAL_WEBVIEW_HOST: "1",
  };
  delete env.NODE_ENV;
  return { env, emptyConfig, preloadMarker, transpilerCache, compileCache };
}

async function dirEntries(d: string): Promise<string[]> {
  return readdir(d).catch(() => []);
}

/** Control: the same flags as the starter, a raw Bun, only the loader variables the control can run. */
async function expectLoadersEffective(sb: Sandbox, l: Loaders, bunPath: string): Promise<void> {
  const env = { ...l.env };
  for (const n of ["BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "BUN_INTERNAL_WEBVIEW_HOST"]) delete env[n];
  const r = await run(
    [bunPath, "--no-install", `--config=${l.emptyConfig}`, "--no-env-file", join(sb.root, "entries", "loaders.ts")],
    { env, cwd: sb.cwd, timeoutMs: 60_000 },
  );
  const why = `control (raw ${bunPath}) exit ${r.code}, stderr ${JSON.stringify(r.err)}, stdout ${JSON.stringify(r.out)}`;
  expect(r.code, why).toBe(0);
  expect(await exists(l.preloadMarker), `BUN_INSPECT_PRELOAD did not run under --config --no-env-file: ${why}`).toBe(true);
  expect(JSON.parse(r.out).pkg, `NODE_PATH package not found: ${why}`).toBe("from-node-path");
  expect(await dirEntries(l.transpilerCache), `BUN_RUNTIME_TRANSPILER_CACHE_PATH not written: ${why}`).not.toEqual([]);
  expect(await dirEntries(l.compileCache), `NODE_COMPILE_CACHE not written: ${why}`).not.toEqual([]);
  await rm(l.preloadMarker, { force: true });
  for (const c of [l.transpilerCache, l.compileCache]) {
    for (const f of await dirEntries(c)) await rm(join(c, f), { recursive: true, force: true });
  }
}

async function expectLoadersGone(l: Loaders, r: RunResult): Promise<void> {
  const why = `exit ${r.code}, stderr ${JSON.stringify(r.err)}, stdout ${JSON.stringify(r.out)}`;
  expectExit(r, 0);
  expect(r.err, why).not.toContain("HOSTILE");
  expect(await exists(l.preloadMarker), `the BUN_INSPECT_PRELOAD module ran: ${why}`).toBe(false);
  const seen = JSON.parse(r.out);
  expect(seen.pkg, `the entry resolved a package through NODE_PATH: ${why}`).toBeNull();
  expect(seen.env, `the entry sees loader variables: ${why}`).toEqual(Object.fromEntries(LOADER_VARS.map((n) => [n, null])));
  expect(await dirEntries(l.transpilerCache), `the transpiler cache was written: ${why}`).toEqual([]);
  expect(await dirEntries(l.compileCache), `the compile cache was written: ${why}`).toEqual([]);
}

describe(`loader environment variables (k40) [${STARTER}]`, () => {
  test("installing first run: BUN_INSPECT_PRELOAD, NODE_PATH, the cache and inspector variables do not reach the entry", async () => {
    const server = await serverFor();
    const sb = await sandbox({ mirror: server.url });
    const l = await loaderAttack(sb);
    await expectLoadersEffective(sb, l, process.execPath);

    const r = await run(starterCmd(sb.root, ["run", "entries/loaders.ts"]), { env: l.env, cwd: sb.cwd, timeoutMs: 120_000 });
    expect(server.archives(), "this run did not install").toBe(1);
    await expectLoadersGone(l, r);
  });

  test("fast path (slot already installed): the same variables do not reach the entry", async () => {
    const server = await serverFor();
    const sb = await sandbox({ mirror: server.url });
    const st = await install(sb);
    const l = await loaderAttack(sb);
    await expectLoadersEffective(sb, l, slotBun(st.slot));
    const requests = server.total();

    const r = await run(starterCmd(sb.root, ["run", "entries/loaders.ts"]), { env: l.env, cwd: sb.cwd, timeoutMs: 120_000 });
    expect(server.total(), "the fast path made a request").toBe(requests);
    await expectLoadersGone(l, r);
  });
});

// The probe side: BUN_OPTIONS=--help replaces `bun --version` output with the help text, so a
// starter that leaves BUN_OPTIONS in the staging probe's environment fails the install (HEAD's
// sh starter: exit 1). The entry runs in a neutral cwd here; nothing hostile but the variable.
describe(`BUN_OPTIONS=--help during the install (k29) [${STARTER}]`, () => {
  test("an installing first run succeeds and runs the entry", async () => {
    const server = await serverFor();
    const sb = await sandbox({ mirror: server.url });
    const r = await starter(sb, ["run", "entries/info.ts"], { env: { BUN_OPTIONS: "--help" } });
    expect(server.archives(), "this run did not install").toBe(1);
    expectExit(r, 0);
    expect(JSON.parse(r.out).version, r.err).toBe(REAL_VERSION);
  });
});

// Two environment names that differ only in case (Path and PATH). On Linux they are distinct
// variables and Bun.spawn passes both. On Windows whether Bun.spawn's env object keeps both keys
// is NOT CHECKED (no Windows run yet; if it collapses them the test still runs and still must
// pass, it just no longer builds the pair). The case that matters is a starter whose own process
// environment holds such a pair (MSYS, Cygwin, hand-built blocks): .NET's
// ProcessStartInfo.EnvironmentVariables is case-insensitive on Windows and throws on the pair
// (windows reviewer F1, source-checked). On Linux this test passes against any starter; it can
// only go red on a Windows leg. Registered on every platform, no skip.
describe(`environment with names differing only in case (k29) [${STARTER}]`, () => {
  test("an installing first run and the fast path succeed with both Path and PATH set", async () => {
    const server = await serverFor();
    const sb = await sandbox({ mirror: server.url });
    const env = { ...sb.env, Path: sb.env.PATH ?? "" };
    const first = await run(starterCmd(sb.root, ["run", "entries/info.ts"]), { env, cwd: sb.cwd, timeoutMs: 120_000 });
    expect(server.archives(), "this run did not install").toBe(1);
    expectExit(first, 0);
    expect(JSON.parse(first.out).version, first.err).toBe(REAL_VERSION);
    const fast = await run(starterCmd(sb.root, ["run", "entries/info.ts"]), { env, cwd: sb.cwd, timeoutMs: 120_000 });
    expectExit(fast, 0);
    expect(JSON.parse(fast.out).version, fast.err).toBe(REAL_VERSION);
  });
});

// Git Bash forwarding: the Windows legs only (the sh leg on Windows is the forwarder itself).
// bash.exe missing there is a failure, not a skip.
if (IS_WIN && STARTER !== "sh") {
  describe(`hostile project cwd through Git Bash forwarding (k29) [${STARTER}]`, () => {
    test("getty-bun.sh under Git Bash forwards to the starter; the attacks have no effect; cwd stays the project", async () => {
      const bash = findGitBashExe();
      if (bash === null) throw new Error("Git Bash bash.exe not found on a Windows leg (looked via `git --exec-path` and the standard install paths)");
      const server = await serverFor();
      const sb = await sandbox({ mirror: server.url });
      const st = await install(sb); // PowerShell installs; Git Bash takes the fast path
      const a = await hostile(sb);
      await expectAttackEffective(a, slotBun(st.slot));
      const requests = server.total();

      const r = await run(
        [bash, join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), "run", "entries/hostile.ts"],
        { env: a.env, cwd: a.project, timeoutMs: 120_000 },
      );
      expect(server.total()).toBe(requests);
      await expectNoEffect(a, r);
    });

    test("getty-bun.sh under Git Bash forwarding: the loader variables do not reach the entry (k40)", async () => {
      const bash = findGitBashExe();
      if (bash === null) throw new Error("Git Bash bash.exe not found on a Windows leg (looked via `git --exec-path` and the standard install paths)");
      const server = await serverFor();
      const sb = await sandbox({ mirror: server.url });
      const st = await install(sb);
      const l = await loaderAttack(sb);
      await expectLoadersEffective(sb, l, slotBun(st.slot));
      const r = await run(
        [bash, join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"), "run", "entries/loaders.ts"],
        { env: l.env, cwd: sb.cwd, timeoutMs: 120_000 },
      );
      await expectLoadersGone(l, r);
    });
  });
}
