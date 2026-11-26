// The phase 2b gate, part (a) (k33): a scratch consumer whose one entry serves both hosts by
// argv, as the README "The Claude Code codec" shows. The packed SDK is bundled into it, and
// Claude Code and Codex hook payloads run through the starter under test offline, from the
// hostile project directory of k29.
//
//   GETTY_BUN_TEST_GATE=1 GETTY_BUN_TEST_STARTER=sh|powershell|pwsh bun test ./test/gate/
//
// Registered as one skipped test unless GETTY_BUN_TEST_GATE=1 (see gate.test.ts).
//
// What it proves: the packed package's `./claude-code` and `./codex` subpaths, bundled as a
// consumer does, turn the recorded payloads of test/fixtures/{claude-code,codex}/input into
// the hand-written stdout of the .out files, byte for byte, through the real starter, the
// installed slot's Bun and real pipes; and that `onFailure: "closed"` ends a failing hook with
// exit 2 and one stderr line. It does not prove a host: no real Claude Code or Codex ran. The
// Claude Code inputs are loadguard's recorded payloads (executed, CC 2.1.283) and schema-checked
// files, see test/fixtures/claude-code/README.md.
// Temporary directories carry the prefix abr-gate- and go in this file's afterAll.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATE,
  H,
  OFFLINE_MIRROR,
  buildConsumer,
  hostileEnv,
  makeHostile,
  markersLeft,
  type FixtureServer,
  type Harness,
  type Hostile,
  type Sandbox,
} from "./support.js";

const { REPO, buildEnv, expectExit, realRoutes, run, startServer, starter, starterCmd } = (H ?? {}) as Harness;

const CC = join(import.meta.dir, "..", "fixtures", "claude-code");
const CX = join(import.meta.dir, "..", "fixtures", "codex");
const ENTRY = "bundle/entry.js"; // relative to the consumer root, always with /

if (!GATE) {
  test.skip("phase 2b Claude Code gate skipped: set GETTY_BUN_TEST_GATE=1 (and GETTY_BUN_TEST_STARTER) to pack, bundle and run it", () => {});
}

const read = async (dir: string, path: string) => await Bun.file(join(dir, path)).bytes();
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// The Claude Code cases: input, scenario (the .out file, whose effects output/effects.json
// lists), the event it is for.
const CLAUDE_CASES = [
  ["SessionStart add-context at session-start-input", "input/session-start.startup.json", "session-start.add-context.out"],
  ["SessionStart add-context and notify-user", "input/session-start.startup.json", "session-start.add-context.notify-user.out"],
  ["UserPromptSubmit add-context at prompt-input", "input/user-prompt-submit.json", "user-prompt-submit.add-context.out"],
  ["PostToolUse add-context at tool-result", "input/post-tool-use.bash.json", "post-tool-use.add-context.out"],
  ["PreToolUse deny with a reason", "input/pre-tool-use.bash.json", "pre-tool-use.deny.out"],
  ["PreToolUse allow with tool-input (updatedInput)", "input/pre-tool-use.bash-probe.json", "pre-tool-use.allow.tool-input.out"],
  ["PreToolUse tool-input alone", "input/pre-tool-use.bash-probe.json", "pre-tool-use.tool-input.out"],
  ["CwdChanged notify-user", "input/cwd-changed.json", "notify-user.out"],
] as const;

describe.skipIf(!GATE)(`phase 2b gate, Claude Code and Codex payloads [${H?.STARTER ?? "skipped"}]`, () => {
  let tmp = "";
  let sb: Sandbox;
  let hostile: Hostile;
  let server: FixtureServer | undefined;

  beforeAll(async () => {
    tmp = realpathSync.native(await mkdtemp(join(tmpdir(), "abr-gate-")));
    const root = join(tmp, "consumer");
    const userHome = join(tmp, "user-home");
    for (const d of [userHome, root, join(root, "bootstrap")]) await mkdir(d, { recursive: true });
    sb = { tmp, home: join(tmp, "getty-home"), userHome, root, cwd: join(tmp, "cwd"), mirror: null, env: {} };
    sb.env = buildEnv(sb);
    const toolEnv = { ...sb.env, PATH: process.env.PATH ?? "" };

    // scenario name -> the effect list the handler returns
    const effects = (await Bun.file(join(CC, "output", "effects.json")).json()) as Record<string, { effects: unknown[] }>;
    const scenarios: Record<string, unknown> = {};
    for (const [, , out] of CLAUDE_CASES) {
      const entry = effects[out];
      if (entry === undefined) throw new Error(`test/fixtures/claude-code/output/effects.json has no ${out}`);
      scenarios[out] = entry.effects;
    }
    scenarios["codex-user-prompt-submit.add-context"] = [
      { kind: "add-context", text: await Bun.file(join(CX, "output", "context.json")).json(), audience: "model", placement: "prompt-input" },
    ];
    scenarios["codex-pre-tool-use.deny"] = [
      { kind: "tool-permission", decision: "deny", reason: await Bun.file(join(CX, "output", "pre-tool-use.deny-reason.json")).json() },
    ];
    scenarios["none"] = [{ kind: "no-decision" }];

    await buildConsumer({
      repo: REPO,
      tmp,
      root,
      toolEnv,
      bundle: ENTRY,
      run,
      // argv[2] the host, argv[3] the scenario, argv[4] "closed" for onFailure "closed";
      // the scenario "throw" makes the handler fail
      entrySource: `import { main, type HookCodec } from "@getty/agent-bun-runtime";
import { claudeCode } from "@getty/agent-bun-runtime/claude-code";
import { codex } from "@getty/agent-bun-runtime/codex";

const scenarios: Record<string, any> = ${JSON.stringify(scenarios)};
const codecs: Record<string, HookCodec> = { "claude-code": claudeCode, codex };
const codec = codecs[process.argv[2] ?? ""];
if (codec === undefined) {
  process.stderr.write("hook: unknown host " + JSON.stringify(process.argv[2]) + "\\n");
  process.exit(1);
}
const scenario = process.argv[3] ?? "";
process.exit(
  await main({
    codec,
    onFailure: process.argv[4] === "closed" ? "closed" : "open",
    handler: () => {
      if (scenario === "throw") throw new Error("the guard failed");
      const effects = scenarios[scenario];
      if (effects === undefined) throw new Error("unknown scenario " + scenario);
      return effects;
    },
  }),
);
`,
    });
    for (const f of ["getty-bun.sh", "getty-bun.ps1"]) await cp(join(REPO, "bootstrap", f), join(root, "bootstrap", f));

    // the slot installs once from the local fixtures; every run after that is offline
    await mkdir(sb.cwd, { recursive: true });
    server = startServer(await realRoutes());
    sb.mirror = server.url;
    sb.env = buildEnv(sb);
    const ensured = await starter(sb, ["ensure"]);
    expectExit(ensured, 0);
    expect(server.archives()).toBe(1);
    server.stop();
    server = undefined;
    sb.mirror = OFFLINE_MIRROR;
    hostile = await makeHostile(join(tmp, "hostile"));
    sb.cwd = hostile.cwd;
    sb.env = hostileEnv(buildEnv(sb), hostile);
  }, 600_000);

  afterAll(async () => {
    server?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const hook = (host: "claude-code" | "codex", scenario: string, stdin: Uint8Array, ...more: string[]) =>
    run(starterCmd(sb.root, ["run", ENTRY, host, scenario, ...more]), { env: sb.env, cwd: sb.cwd, stdin, timeoutMs: 120_000 });

  test("the consumer is offline and bundle-only, with both codecs inlined", async () => {
    expect(sb.env.GETTY_BUN_MIRROR).toBe(OFFLINE_MIRROR);
    expect(await readdir(sb.root)).not.toContain("node_modules");
    const bundle = new TextDecoder().decode(await Bun.file(join(sb.root, ENTRY)).bytes());
    expect(/(?:^|\n)\s*import\b[^\n]*["']@getty\/|require\(["']@getty\//.test(bundle)).toBe(false);
    expect(bundle).toContain("claude-code");
    expect(bundle).toContain("class AgentRuntimeError");
  });

  describe("Claude Code: stdout is the .out file byte for byte, exit 0, silent stderr", () => {
    for (const [label, input, out] of CLAUDE_CASES) {
      test(label, async () => {
        const r = await hook("claude-code", out, await read(CC, input));
        expect(r.timedOut).toBe(false);
        expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
        expect(same(r.stdout, await read(CC, `output/${out}`))).toBe(true);
      }, 150_000);
    }

    test("PostToolUse no-decision: empty stdout, exit 0, silent stderr", async () => {
      const r = await hook("claude-code", "none", await read(CC, "input/post-tool-use.bash.json"));
      expect({ code: r.code, out: r.out, err: r.err }).toEqual({ code: 0, out: "", err: "" });
    }, 150_000);
  });

  describe("Codex through the same entry", () => {
    test("UserPromptSubmit add-context: stdout is the .out file byte for byte, exit 0", async () => {
      const r = await hook("codex", "codex-user-prompt-submit.add-context", await read(CX, "input/user-prompt-submit.json"));
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      expect(same(r.stdout, await read(CX, "output/user-prompt-submit.add-context.out"))).toBe(true);
    }, 150_000);

    test("PreToolUse deny with a reason: stdout is the .out file byte for byte, exit 0", async () => {
      const r = await hook("codex", "codex-pre-tool-use.deny", await read(CX, "input/pre-tool-use.bash.json"));
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      expect(same(r.stdout, await read(CX, "output/pre-tool-use.deny.out"))).toBe(true);
    }, 150_000);
  });

  describe('onFailure "closed": exit 2, nothing on stdout, exactly one agent-bun-runtime line', () => {
    for (const [host, input, dir] of [
      ["claude-code", "input/pre-tool-use.bash.json", CC],
      ["codex", "input/pre-tool-use.bash.json", CX],
    ] as const) {
      test(`${host}: a failing handler on PreToolUse`, async () => {
        const r = await hook(host, "throw", await read(dir, input), "closed");
        expect(r.timedOut).toBe(false);
        expect(r.code).toBe(2);
        expect(r.out).toBe("");
        const lines = r.err.split("\n");
        expect(lines).toHaveLength(2); // the line and the empty rest after its newline
        expect(lines[0]).toStartWith("agent-bun-runtime: HANDLER_FAILED: ");
      }, 150_000);

      test(`${host}: the same failure without the policy is exit 1`, async () => {
        const r = await hook(host, "throw", await read(dir, input));
        expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: "" });
        expect(r.err.split("\n")[0]).toStartWith("agent-bun-runtime: HANDLER_FAILED: ");
      }, 150_000);
    }

    test("claude-code: truncated input", async () => {
      const r = await hook("claude-code", "none", await read(CC, "malformed/truncated.json"), "closed");
      expect({ code: r.code, out: r.out }).toEqual({ code: 2, out: "" });
      const lines = r.err.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toStartWith("agent-bun-runtime: HOOK_INPUT_INVALID: ");
    }, 150_000);
  });

  test("no hook run of this file left a bunfig or BUN_OPTIONS preload marker", () => {
    expect(markersLeft(hostile)).toEqual([]);
  });
});
