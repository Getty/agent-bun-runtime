// Shared by the gate test files (gate.test.ts, claude-code.test.ts, plugin.test.ts): the typed
// view of the bootstrap suite's harness, the hostile project of k29 and the packed-SDK
// consumer build. Not a test file (no .test.ts in its name), so `bun test` does not run it.
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface RunResult {
  code: number | null;
  stdout: Uint8Array;
  out: string;
  err: string;
  timedOut: boolean;
}
export interface Sandbox {
  tmp: string;
  home: string;
  userHome: string;
  root: string;
  cwd: string;
  mirror: string | null;
  env: Record<string, string>;
}
export interface FixtureServer {
  url: string;
  archives(): number;
  stop(): void;
}
export interface Harness {
  REPO: string;
  STARTER: string;
  buildEnv(sb: Sandbox): Record<string, string>;
  expectExit(r: { code: number | null; err: string }, want: number): void;
  killTree(proc: { pid: number; kill: () => void; exitCode: number | null; signalCode: unknown }): void;
  realRoutes(): Promise<Record<string, Uint8Array>>;
  run(
    cmd: string[],
    o: { env: Record<string, string>; cwd?: string; stdin?: Uint8Array | string; timeoutMs?: number },
  ): Promise<RunResult>;
  startServer(routes: Record<string, Uint8Array>): FixtureServer;
  starter(sb: Sandbox, args: string[]): Promise<RunResult>;
  starterCmd(root: string, args: string[]): string[];
}

export const GATE = process.env.GETTY_BUN_TEST_GATE === "1";
const HARNESS = join(import.meta.dir, "..", "..", "bootstrap", "test", "lib", "harness.ts");
// Loaded by a computed path (it is not typed under this package's strict tsconfig) and only
// when the gate runs: importing it registers an afterEach that is harmless for the gate files
// (each removes its own temp dirs in its afterAll).
export const H = (GATE ? await import(pathToFileURL(HARNESS).href) : undefined) as Harness | undefined;

export const OFFLINE_MIRROR = "http://127.0.0.1:9"; // the discard port: nothing answers

// A "project" that attacks the Bun started in it. Markers go to files outside the project,
// so the cwd stays the only thing the attack lives in.
export interface Hostile {
  cwd: string;
  bunfigMarker: string;
  optionsMarker: string;
  bunOptions: string;
}
export async function makeHostile(base: string): Promise<Hostile> {
  const cwd = join(base, "project");
  const markers = join(base, "markers");
  await mkdir(cwd, { recursive: true });
  await mkdir(markers, { recursive: true });
  const bunfigMarker = join(markers, "bunfig-preload");
  const optionsMarker = join(markers, "options-preload");
  const optionsPreload = join(base, "options-preload.ts");
  const leave = (marker: string) =>
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`;
  await writeFile(join(cwd, "pre.ts"), leave(bunfigMarker));
  await writeFile(optionsPreload, leave(optionsMarker));
  await writeFile(
    join(cwd, "bunfig.toml"),
    `preload = ["./pre.ts"]\n\n[define]\n"process.env.ABR_GATE_DEFINE" = "\\"-DEFINED\\""\n`,
  );
  await writeFile(join(cwd, ".env.local"), "ABR_GATE_ENVFILE=-ENVFILE\n");
  return { cwd, bunfigMarker, optionsMarker, bunOptions: `--preload=${optionsPreload.replaceAll("\\", "/")}` };
}
// bun test sets NODE_ENV=test, and Bun skips .env.local under it; a host does not set it.
export function hostileEnv(env: Record<string, string>, h: Hostile): Record<string, string> {
  const { NODE_ENV: _drop, ...rest } = env;
  return { ...rest, BUN_OPTIONS: h.bunOptions };
}
export const markersLeft = (h: Hostile) => [h.bunfigMarker, h.optionsMarker].filter((m) => existsSync(m));

/**
 * The consumer the gate files share: the tarball of this checkout (`bun pm pack`, prepack
 * builds dist/), installed without a registry into `root`, its `entrySource` bundled with
 * `bun build --target=bun` to `<root>/<bundle>`, then node_modules, sources and the tarball
 * removed so that only the bundle runs. `toolEnv` is a temp-HOME environment that keeps PATH.
 */
export async function buildConsumer(o: {
  repo: string;
  tmp: string;
  root: string;
  toolEnv: Record<string, string>;
  entrySource: string;
  bundle: string;
  run: Harness["run"];
}): Promise<void> {
  const { root, toolEnv } = o;
  const sh = async (cmd: string[], cwd: string, env: Record<string, string>, what: string) => {
    const r = await o.run(cmd, { env, cwd, timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.err}${r.out}`);
  };
  const packDir = join(o.tmp, `pack-${Math.random().toString(36).slice(2)}`);
  await mkdir(packDir, { recursive: true });
  await sh([process.execPath, "pm", "pack", "--destination", packDir, "--quiet"], o.repo, toolEnv, "bun pm pack");
  const tarballs = (await readdir(packDir)).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`bun pm pack made ${tarballs.length} tarballs`);
  await mkdir(join(root, "src"), { recursive: true });
  await cp(join(packDir, tarballs[0]!), join(root, "sdk.tgz"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "abr-gate-consumer", private: true, type: "module", dependencies: { "@getty/agent-bun-runtime": "file:./sdk.tgz" } }),
  );
  await writeFile(join(root, "src", "entry.ts"), o.entrySource);
  // The package has no runtime dependency: an unreachable registry makes a dependency that
  // creeps in fail the install.
  await sh([process.execPath, "install"], root, { ...toolEnv, BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/" }, "bun install");
  await sh([process.execPath, "build", join("src", "entry.ts"), "--target=bun", "--outfile", o.bundle], root, toolEnv, "bun build");
  await rm(join(root, "node_modules"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(join(root, "src"), { recursive: true, force: true });
  await rm(join(root, "sdk.tgz"), { force: true });
}
