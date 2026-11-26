// The phase 2 gate (k24): the tarball from `bun pm pack`, bundled with `bun build
// --target=bun` into a scratch consumer, runs offline through the starter under test.
//
//   GETTY_BUN_TEST_GATE=1 GETTY_BUN_TEST_STARTER=sh|powershell|pwsh bun test ./test/gate/
//
// Skipped (one test named with the reason) unless GETTY_BUN_TEST_GATE=1: it packs, installs
// and bundles, which the unit run does not need. Needs the fixture archives of the
// bootstrap suite (bun bootstrap/test/fetch-fixtures.ts, into .dev/fixtures).
//
// What it proves: the packed package, as a consumer bundles it, behaves like the source
// tests say, through the real starter, the installed slot's Bun and real pipes, with no
// network after the slot install. It does not prove a host: the inputs are the
// source-checked Codex fixtures of test/fixtures/codex, not a real Codex run (phase 3a).
// Every hook run uses a hostile project directory as its cwd (k29): a bunfig.toml with a
// preload and a [define], a .env.local, and BUN_OPTIONS=--preload=... in the env. Bun would
// run all of it for a raw `bun entry.js`; the starter must not let any of it act (the
// control test proves the attacks fire, so the gate cannot pass vacuously).
// Temporary directories carry the prefix abr-gate- and go in this file's afterAll; only
// processes the harness or this file started are killed (killTree, by recorded handle).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE, H, OFFLINE_MIRROR, hostileEnv, makeHostile, markersLeft, type Harness, type Hostile, type Sandbox, type FixtureServer } from "./support.js";
// undefined members while the gate is skipped; nothing below runs then
const { REPO, buildEnv, expectExit, killTree, realRoutes, run, startServer, starter, starterCmd } = (H ?? {}) as Harness;

const FIXTURES = join(import.meta.dir, "..", "fixtures", "codex");
const BOUND_MS = 30_000;
const BUNDLE = "bundle/entry.js"; // relative to the consumer root, always with /
// What the hooks run: a plain wrapper around the bundle (see beforeAll).
const ENTRY = "bundle/wrap.js";

if (!GATE) {
  test.skip("phase 2 gate skipped: set GETTY_BUN_TEST_GATE=1 (and GETTY_BUN_TEST_STARTER) to pack, bundle and run it", () => {});
}

// What the "large" mode of the generated entry answers for the SubagentStart fixture.
const LARGE_OUTPUT = `${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SubagentStart",
    additionalContext: "0123456789abcdef-Grüße-\n".repeat(Math.ceil((256 * 1024) / 24)),
  },
})}\n`;
const bytes = async (path: string) => await Bun.file(join(FIXTURES, path)).bytes();
const text = (b: Uint8Array) => new TextDecoder().decode(b);


describe.skipIf(!GATE)(`phase 2 gate [${H?.STARTER ?? "skipped"}]`, () => {
  let tmp = "";
  let sb: Sandbox;
  let server: FixtureServer | undefined;
  let contextText = "";
  let hostile: Hostile;

  async function sh(cmd: string[], cwd: string, env: Record<string, string>, what: string) {
    const r = await run(cmd, { env, cwd, timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${r.err}${r.out}`);
    return r;
  }

  beforeAll(async () => {
    tmp = realpathSync.native(await mkdtemp(join(tmpdir(), "abr-gate-")));
    const home = join(tmp, "getty-home");
    const userHome = join(tmp, "user-home");
    const root = join(tmp, "consumer");
    const cwd = join(tmp, "cwd");
    for (const d of [userHome, root, cwd, join(root, "bootstrap"), join(root, "src")]) {
      await mkdir(d, { recursive: true });
    }
    sb = { tmp, home, userHome, root, cwd, mirror: null, env: {} };
    sb.env = buildEnv(sb);
    // bun itself (pack, install, build) runs with the harness Bun and the temp HOME, never
    // the real one; it needs the PATH the harness stripped only for the starter runs.
    const toolEnv = { ...sb.env, PATH: process.env.PATH ?? "" };

    // 1. pack the package of this checkout (prepack builds dist/)
    const packDir = join(tmp, "pack");
    await mkdir(packDir);
    await sh([process.execPath, "pm", "pack", "--destination", packDir, "--quiet"], REPO, toolEnv, "bun pm pack");
    const tarballs = (await readdir(packDir)).filter((f) => f.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);
    await cp(join(packDir, tarballs[0]!), join(root, "sdk.tgz"));

    // 2. scratch consumer: depends on the tarball, installs without a registry
    contextText = (await Bun.file(join(FIXTURES, "output", "context.json")).json()) as string;
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "abr-gate-consumer", private: true, type: "module", dependencies: { "@getty/agent-bun-runtime": "file:./sdk.tgz" } }),
    );
    await writeFile(
      join(root, "src", "entry.ts"),
      `import { main } from "@getty/agent-bun-runtime";
import { codex } from "@getty/agent-bun-runtime/codex";
// argv[2]: "context" answers add-context, "none" answers no-decision.
// argv[3]: "exitcode" ends through process.exitCode alone (the process must end on its own),
// otherwise process.exit(code), the documented entry pattern.
const mode = process.argv[2];
// "large" answers add-context with about 256 KiB of text
const text =
  mode === "large"
    ? "0123456789abcdef-Grüße-\\n".repeat(Math.ceil((256 * 1024) / 24))
    : ${JSON.stringify(contextText)} +
      // empty in a clean run; a project's bunfig [define] or .env.local would fill them (k29)
      (process.env.ABR_GATE_DEFINE_SEEN ?? "") +
      (process.env.ABR_GATE_ENVFILE ?? "");
const code = await main({
    codec: codex,
    handler: ({ invocation }) =>
      mode === "none"
        ? { kind: "no-decision" }
        : {
            kind: "add-context",
            text,
            audience: "model",
            placement: invocation.event.nativeName === "SubagentStart" ? "subagent-input" : "session-start-input",
          },
  });
if (process.argv[3] === "exitcode") process.exitCode = code;
else process.exit(code);
`,
    );
    // The package has no runtime dependency: an unreachable registry makes a dependency that
    // creeps in fail the install.
    await sh([process.execPath, "install"], root, { ...toolEnv, BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/" }, "bun install");
    await sh([process.execPath, "build", join("src", "entry.ts"), "--target=bun", "--outfile", join("bundle", "entry.js")], root, toolEnv, "bun build");
    // bun build --target=bun marks the bundle `// @bun`, which Bun's runtime does not transpile
    // again, so a bunfig [define] cannot rewrite it (executed, Bun 1.4.5). The plain wrapper is
    // transpiled: with a [define] for process.env.ABR_GATE_DEFINE it hands the rewritten value
    // to the bundle. Without one (a clean run, or a starter that keeps bunfig out) it hands "".
    await writeFile(
      join(root, "bundle", "wrap.js"),
      `process.env.ABR_GATE_DEFINE_SEEN = process.env.ABR_GATE_DEFINE ?? "";\nawait import("./entry.js");\n`,
    );
    // only the bundle runs: no node_modules, no sources
    await rm(join(root, "node_modules"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(join(root, "src"), { recursive: true, force: true });
    await rm(join(root, "sdk.tgz"), { force: true });

    // 3. the starters, unchanged from this repository
    for (const f of ["getty-bun.sh", "getty-bun.ps1"]) await cp(join(REPO, "bootstrap", f), join(root, "bootstrap", f));

    // 4. the slot installs once from the local fixtures; every run after that is offline
    server = startServer(await realRoutes());
    sb.mirror = server.url;
    sb.env = buildEnv(sb);
    const ensured = await starter(sb, ["ensure"]);
    expectExit(ensured, 0);
    expect(server.archives()).toBe(1);
    server.stop();
    server = undefined;
    sb.mirror = OFFLINE_MIRROR;
    // From here on every hook run starts in the hostile project and carries BUN_OPTIONS.
    hostile = await makeHostile(join(tmp, "hostile"));
    sb.cwd = hostile.cwd;
    sb.env = hostileEnv(buildEnv(sb), hostile);
  }, 600_000);

  afterAll(async () => {
    server?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const runHook = (mode: "context" | "none", stdin: Uint8Array, root = sb.root) =>
    run(starterCmd(root, ["run", ENTRY, mode]), { env: sb.env, cwd: sb.cwd, stdin, timeoutMs: 120_000 });

  const contextInput = () => bytes("input/session-start.startup.json");
  const contextOut = () => bytes("output/session-start.add-context.out");

  // The control: a raw Bun in a hostile cwd obeys every attack. If this ever passes without
  // the markers and the tags, the attacks no longer work and the tests below prove nothing.
  test("control: a raw bun run in the hostile cwd obeys bunfig preload, [define], .env.local and BUN_OPTIONS", async () => {
    const control = await makeHostile(join(tmp, "control"));
    const r = await run([process.execPath, "--no-install", join(sb.root, ENTRY), "context"], {
      env: hostileEnv(sb.env, control),
      cwd: control.cwd,
      stdin: await contextInput(),
      timeoutMs: 120_000,
    });
    expect(r.err).toBe("");
    expect(markersLeft(control)).toEqual([control.bunfigMarker, control.optionsMarker]);
    expect(r.out).toContain("-DEFINED");
    expect(r.out).toContain("-ENVFILE");
    expect(Buffer.from(r.stdout).equals(Buffer.from(await contextOut()))).toBe(false);
  }, 150_000);

  test("the installing first run and the fast path both ignore the hostile project", async () => {
    // a fresh slot: the first run installs from the local fixture server, inside the hostile cwd
    const fresh: Sandbox = { ...sb, home: join(tmp, "getty-home-hostile"), mirror: null, env: {} };
    const own = await makeHostile(join(tmp, "installing"));
    const srv = startServer(await realRoutes());
    try {
      fresh.mirror = srv.url;
      fresh.env = hostileEnv(buildEnv(fresh), own);
      const input = await contextInput();
      const go = () => run(starterCmd(sb.root, ["run", ENTRY, "context"]), { env: fresh.env, cwd: own.cwd, stdin: input, timeoutMs: 150_000 });
      const first = await go();
      expect(srv.archives()).toBe(1); // this run installed
      expect({ code: first.code, err: first.err }).toEqual({ code: 0, err: "" });
      expect(Buffer.from(first.stdout).equals(Buffer.from(await contextOut()))).toBe(true);
      expect(markersLeft(own)).toEqual([]);
      const second = await go();
      expect(srv.archives()).toBe(1); // the fast path installed nothing
      expect({ code: second.code, err: second.err }).toEqual({ code: 0, err: "" });
      expect(Buffer.from(second.stdout).equals(Buffer.from(await contextOut()))).toBe(true);
      expect(markersLeft(own)).toEqual([]);
    } finally {
      srv.stop();
    }
  }, 400_000);

  test("the consumer is offline and bundle-only", async () => {
    expect(sb.env.GETTY_BUN_MIRROR).toBe(OFFLINE_MIRROR);
    expect(await readdir(sb.root)).not.toContain("node_modules");
    const bundle = text(await Bun.file(join(sb.root, BUNDLE)).bytes());
    // the SDK is inlined: no import or require of it is left (comments may name its path)
    expect(/(?:^|\n)\s*import\b[^\n]*["']@getty\/|require\(["']@getty\//.test(bundle)).toBe(false);
    expect(bundle.includes("class AgentRuntimeError")).toBe(true);
  });

  for (const [label, input, out] of [
    ["SessionStart", "input/session-start.startup.json", "output/session-start.add-context.out"],
    ["SubagentStart", "input/subagent-start.json", "output/subagent-start.add-context.out"],
  ] as const) {
    test(`${label} add-context: stdout is the .out file byte for byte, exit 0, silent stderr`, async () => {
      const r = await runHook("context", await bytes(input));
      expect(r.timedOut).toBe(false);
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      expect(Buffer.from(r.stdout).equals(Buffer.from(await bytes(out)))).toBe(true);
    }, 150_000);

    // The k11 case on Windows: the starter's stdout is a pipe, and an empty Bun.write to it fails.
    test(`${label} no-decision: empty stdout, exit 0, silent stderr`, async () => {
      const r = await runHook("none", await bytes(input));
      expect({ code: r.code, out: r.out, err: r.err }).toEqual({ code: 0, out: "", err: "" });
    }, 150_000);
  }

  describe("invalid input: exit 1, exactly one agent-bun-runtime line, nothing on stdout", () => {
    for (const [file, code] of [
      ["malformed/truncated.json", "HOOK_INPUT_INVALID"],
      ["malformed/empty.json", "HOOK_INPUT_INVALID"],
      ["malformed/not-an-object.json", "HOOK_INPUT_INVALID"],
      ["malformed/session-end.json", "HOOK_EFFECT_UNSUPPORTED"],
    ] as const) {
      test(`${file}: ${code}`, async () => {
        const r = await runHook("context", await bytes(file));
        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        const lines = r.err.split("\n");
        expect(lines).toHaveLength(2); // one line and the empty rest after its newline
        expect(lines[0]).toStartWith(`agent-bun-runtime: ${code}: `);
      }, 150_000);
    }
  });

  // process.exit(code) ends the process whatever stdin does; process.exitCode alone ends it only
  // because main() cancels the stdin reader (executed, Bun 1.4.5), so that form is the one that
  // can tell a leaked reader from a closed one.
  for (const form of ["exit", "exitcode"] as const) {
    test(`stdin kept open after the object, entry ends by ${form === "exit" ? "process.exit" : "process.exitCode"}: the run ends within the bound, output intact`, async () => {
      const proc = Bun.spawn({
        cmd: starterCmd(sb.root, ["run", ENTRY, "context", form]),
        env: sb.env,
        cwd: sb.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(proc.stdout).arrayBuffer();
      const stderr = new Response(proc.stderr).text();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        proc.stdin.write(await bytes("input/subagent-start.json"));
        await proc.stdin.flush(); // and never end(): the host keeps stdin open
        const bound = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), BOUND_MS);
        });
        const exited = await Promise.race([proc.exited, bound]);
        expect(exited).toBe(0);
        expect(Buffer.from(await stdout).equals(Buffer.from(await bytes("output/subagent-start.add-context.out")))).toBe(true);
        expect(await stderr).toBe("");
      } finally {
        clearTimeout(timer);
        killTree(proc); // only the process this test started; a no-op after a normal exit
        try {
          proc.stdin.end();
        } catch {}
      }
    }, 60_000);
  }

  // About 256 KiB through the starter, byte for byte, exit 0. Bun.spawn drains stdout from the
  // start, so this is not a slow reader (the sh test below is). Why it matters on Windows: inside
  // the starter bun.exe writes into a .NET anonymous pipe that PowerShell drains with CopyToAsync
  // (source-checked, bootstrap/getty-bun.ps1:661-664), a path the unit tests do not take. Executed:
  // its earlier form (a 1.5 s sleep before the read) passed on both Windows gate legs of CI run
  // 45883791115.
  test("add-context of about 256 KiB through the starter: byte for byte, exit 0", async () => {
    const proc = Bun.spawn({
      cmd: starterCmd(sb.root, ["run", ENTRY, "large"]),
      env: sb.env,
      cwd: sb.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(proc.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      proc.stdin.write(await bytes("input/subagent-start.json"));
      await proc.stdin.flush();
      const stdout = new Response(proc.stdout).arrayBuffer();
      const bound = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 60_000);
      });
      const exited = await Promise.race([proc.exited, bound]);
      expect(exited).toBe(0);
      const want = LARGE_OUTPUT;
      const got = Buffer.from(await stdout);
      expect(got.length).toBeGreaterThan(256 * 1024);
      expect(got.equals(Buffer.from(want))).toBe(true);
      expect(await stderr).toBe("");
    } finally {
      clearTimeout(timer);
      killTree(proc);
      try {
        proc.stdin.end();
      } catch {}
    }
  }, 120_000);

  // A real slow reader, registered only for the sh starter (so never on Windows). Not a skipIf:
  // the CI gate job fails a leg on any skipped test, so the Windows reports must not contain it.
  // The starter's stdout goes into a pipeline whose reader waits
  // 1.5 s before it reads. Bounded; only the sh this test started is killed.
  if (H?.STARTER === "sh") test("256 KiB into a reader that starts 1.5 s late: byte for byte, exit 0", async () => {
    const proc = Bun.spawn({
      cmd: ["sh", "-c", '{ sh "$1" run "$2" large; echo "status $?" >&2; } | (sleep 1.5; cat)', "_", join(sb.root, "bootstrap", "getty-bun.sh"), ENTRY],
      env: sb.env,
      cwd: sb.cwd,
      stdin: Buffer.from(await bytes("input/subagent-start.json")),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).arrayBuffer();
    const stderr = new Response(proc.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bound = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 60_000);
      });
      expect(await Promise.race([proc.exited, bound])).toBe(0);
      const got = Buffer.from(await stdout);
      expect(got.length).toBeGreaterThan(256 * 1024);
      expect(got.equals(Buffer.from(LARGE_OUTPUT))).toBe(true);
      // the pipeline's own status is cat's, so the starter's status is reported on stderr
      expect(await stderr).toBe("status 0\n");
    } finally {
      clearTimeout(timer);
      killTree(proc);
    }
  }, 120_000);

  test("a consumer root with spaces and non-ASCII characters", async () => {
    const odd = join(tmp, "Grüße consumer ü");
    await cp(sb.root, odd, { recursive: true });
    const r = await runHook("context", await bytes("input/session-start.startup.json"), odd);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(Buffer.from(r.stdout).equals(Buffer.from(await bytes("output/session-start.add-context.out")))).toBe(true);
  }, 150_000);

  test("no hook run of this file left a bunfig or BUN_OPTIONS preload marker", () => {
    expect(markersLeft(hostile)).toEqual([]);
  });
});
