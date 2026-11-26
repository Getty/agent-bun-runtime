// The phase 2b gate, part (b) (k33): a scratch plugin built from the install template
// skills/getty-bun-install. Its .njk files are rendered with real nunjucks 3.2.4 the way
// skilletor renders them, the rendered starters go into <plugin>/bootstrap/, the bundled
// entry (the packed SDK) into <plugin>/dist/hook.js, and a Claude Code hook input runs through
// the rendered starter. On the sh legs that is the skill's hook line as written:
// `getty-bun.sh run dist/hook.js claude-code`. On the Windows legs it is the rendered .ps1
// with the same `claude-code` argument, not the line Claude Code on Windows would run (which
// starter line a Windows plugin uses there is an open owner decision): those legs prove the
// rendered .ps1 plus the codec, not Claude Code on Windows. First run installs from the local
// fixture archives, the next ones take the fast path; every run starts in the hostile project
// directory of k29.
//
//   GETTY_BUN_TEST_GATE=1 GETTY_BUN_TEST_STARTER=sh|powershell|pwsh \
//   GETTY_BUN_TEST_NUNJUCKS=<dir> bun test ./test/gate/
//
// GETTY_BUN_TEST_NUNJUCKS is a directory that contains node_modules/nunjucks, version 3.2.4
// (skilletor's `nunjucks ^3.2.4`; locally .dev/njk, made by `bun add nunjucks@3.2.4` in it).
// With the gate enabled and the variable unset, or not pointing at nunjucks 3.2.4, the
// describe's beforeAll throws and every test of this file FAILS with the reason: never a
// skip, because the CI's JUnit check fails on skips. The gate off: one skipped test, as in
// gate.test.ts.
//
// What it proves: the template renders (with skilletor's Environment options) to starters
// that install Bun from local archives and run a bundled entry. It does not prove skilletor
// itself (no skilletor runs: no CLI, no trust, no sync) and not a host.
// Temporary directories carry the prefix abr-gate- and go in this file's afterAll.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATE,
  H,
  buildConsumer,
  hostileEnv,
  makeHostile,
  markersLeft,
  type Harness,
  type Hostile,
  type Sandbox,
} from "./support.js";

const { REPO, buildEnv, realRoutes, run, startServer, starterCmd } = (H ?? {}) as Harness;

const CC = join(import.meta.dir, "..", "fixtures", "claude-code");
const TEMPLATE = join(import.meta.dir, "..", "..", "skills", "getty-bun-install");
const STARTERS = ["getty-bun.sh", "getty-bun.ps1"];
const BUN_VERSION = "1.4.5";
const NUNJUCKS_VERSION = "3.2.4";
const ENTRY = "dist/hook.js"; // as the skill's hook line has it

if (!GATE) {
  test.skip("phase 2b plugin gate skipped: set GETTY_BUN_TEST_GATE=1, GETTY_BUN_TEST_STARTER and GETTY_BUN_TEST_NUNJUCKS to render the template and run it", () => {});
}

const read = async (path: string) => await Bun.file(join(CC, path)).bytes();
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// The nunjucks module of $GETTY_BUN_TEST_NUNJUCKS, or an Error that says what to fix.
function loadNunjucks(): any {
  const dir = process.env.GETTY_BUN_TEST_NUNJUCKS;
  const how = `set GETTY_BUN_TEST_NUNJUCKS to a directory that contains node_modules/nunjucks (version ${NUNJUCKS_VERSION}), for example the directory where \`bun add nunjucks@${NUNJUCKS_VERSION}\` ran`;
  if (!dir) throw new Error(`GETTY_BUN_TEST_NUNJUCKS is not set: the plugin gate needs real nunjucks and never skips; ${how}`);
  const pkgPath = join(dir, "node_modules", "nunjucks", "package.json");
  if (!existsSync(pkgPath)) throw new Error(`GETTY_BUN_TEST_NUNJUCKS=${dir} has no node_modules/nunjucks/package.json; ${how}`);
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (version !== NUNJUCKS_VERSION) throw new Error(`GETTY_BUN_TEST_NUNJUCKS=${dir} holds nunjucks ${version}, the gate renders with ${NUNJUCKS_VERSION}; ${how}`);
  return createRequire(pkgPath)("nunjucks");
}

describe.skipIf(!GATE)(`phase 2b gate, plugin from the install template [${H?.STARTER ?? "skipped"}]`, () => {
  let tmp = "";
  let plugin = "";
  let sb: Sandbox;
  let hostile: Hostile;
  const rendered: Record<string, string> = {};

  beforeAll(async () => {
    const nunjucks = loadNunjucks(); // throws, and fails every test, when it is not there
    tmp = realpathSync.native(await mkdtemp(join(tmpdir(), "abr-gate-")));
    plugin = join(tmp, "plugin");
    const userHome = join(tmp, "user-home");
    for (const d of [userHome, join(plugin, "bootstrap"), join(plugin, "dist")]) await mkdir(d, { recursive: true });
    sb = { tmp, home: join(tmp, "getty-home"), userHome, root: plugin, cwd: join(tmp, "cwd"), mirror: null, env: {} };
    sb.env = buildEnv(sb);
    const toolEnv = { ...sb.env, PATH: process.env.PATH ?? "" };

    // skilletor's rendering: a loader on the skill directory, these options, vars.bun_version
    const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(TEMPLATE), { autoescape: false, throwOnUndefined: true });
    for (const name of STARTERS) {
      rendered[name] = env.render(join("bootstrap", `${name}.njk`).replaceAll("\\", "/"), { vars: { bun_version: BUN_VERSION } });
      // not executable on purpose: the hooks start the starters through sh / powershell -File
      await writeFile(join(plugin, "bootstrap", name), rendered[name]!, { mode: 0o644 });
    }

    // the plugin's bundled entry: the packed SDK, Claude Code codec only, as a plugin has it
    const consumer = join(tmp, "build");
    await mkdir(consumer);
    await buildConsumer({
      repo: REPO,
      tmp,
      root: consumer,
      toolEnv,
      bundle: ENTRY,
      run,
      entrySource: `import { main } from "@getty/agent-bun-runtime";
import { claudeCode } from "@getty/agent-bun-runtime/claude-code";

process.exit(
  await main({
    codec: claudeCode,
    handler: ({ invocation }) =>
      invocation.event.nativeName === "PreToolUse"
        ? { kind: "tool-permission", decision: "deny", reason: "Database writes are not allowed" }
        : {
            kind: "add-context",
            text: "Branch: main\\nRules: \\"quoted\\", back\\\\slash, tab\\there, Grüße, 𝄞",
            audience: "model",
            placement: "session-start-input",
          },
  }),
);
`,
    });
    await Bun.write(join(plugin, ENTRY), Bun.file(join(consumer, ENTRY)));

    await mkdir(sb.cwd, { recursive: true });
    hostile = await makeHostile(join(tmp, "hostile"));
    sb.cwd = hostile.cwd;
  }, 600_000);

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // Also in beforeAll (which fails the file when this does); a named test makes the report say why.
  test(`GETTY_BUN_TEST_NUNJUCKS points at nunjucks ${NUNJUCKS_VERSION}`, () => {
    expect(typeof loadNunjucks().Environment).toBe("function");
  });

  test("the rendered starters are the repository's starters for this pin", () => {
    // The fixture archives the gate installs from are the pinned version's: a template that
    // renders anything else would fail to install, so this names the cause.
    for (const name of STARTERS) {
      const source = readFileSync(join(REPO, "bootstrap", name), "utf8");
      expect(rendered[name]).toContain(`# version ${BUN_VERSION}`);
      expect(rendered[name] === source).toBe(true);
    }
  });

  test("the plugin holds only the starters and the bundled entry", async () => {
    expect((await readdir(join(plugin, "bootstrap"))).sort()).toEqual([...STARTERS].sort());
    expect(await readdir(join(plugin, "dist"))).toEqual(["hook.js"]);
    expect(await readdir(plugin)).not.toContain("node_modules");
  });

  test("a hook through the rendered starter: the first run installs from the local archives, the next one takes the fast path", async () => {
    const srv = startServer(await realRoutes());
    try {
      const env = hostileEnv(buildEnv({ ...sb, mirror: srv.url }), hostile);
      const start = await run(starterCmd(plugin, ["run", ENTRY, "claude-code"]), {
        env,
        cwd: sb.cwd,
        stdin: await read("input/session-start.startup.json"),
        timeoutMs: 150_000,
      });
      expect(srv.archives()).toBe(1); // this run installed
      expect({ code: start.code, err: start.err }).toEqual({ code: 0, err: "" });
      expect(same(start.stdout, await read("output/session-start.add-context.out"))).toBe(true);

      const pre = await run(starterCmd(plugin, ["run", ENTRY, "claude-code"]), {
        env,
        cwd: sb.cwd,
        stdin: await read("input/pre-tool-use.bash.json"),
        timeoutMs: 150_000,
      });
      expect(srv.archives()).toBe(1); // the fast path installed nothing
      expect({ code: pre.code, err: pre.err }).toEqual({ code: 0, err: "" });
      expect(same(pre.stdout, await read("output/pre-tool-use.deny.out"))).toBe(true);
    } finally {
      srv.stop();
    }
  }, 400_000);

  test("no hook run of this file left a bunfig or BUN_OPTIONS preload marker", () => {
    expect(markersLeft(hostile)).toEqual([]);
  });
});
