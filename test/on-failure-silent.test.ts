// onFailure "silent" (plan, "Release 0.2.0", item 8): every SDK failure returns exit 0, writes
// nothing to stdout and exactly one "agent-bun-runtime: <CODE>: <message>" line to stderr; the
// line is the one "open" (exit 1, the default) and "closed" (exit 2) write. Both real codecs,
// in process through main() and as a real Bun process on pipes. The malformed inputs are the
// loadguard P1 set: empty, not json, truncated JSON, non-object, non-UTF-8, a key of the wrong
// type, over the input limit. In-process tests prove main() with the codecs, the process
// tests the exit code of a real entry; neither runs a host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "../src/claude-code.js";
import { defineCodec } from "../src/codec.js";
import { codex } from "../src/codex.js";
import { AgentRuntimeError, main, type HookCodec, type HookHandler, type MainOptions } from "../src/index.js";
import { testImplementation } from "./fixtures/codec.js";

const ENTRY = join(import.meta.dir, "fixtures", "silent-entry.ts");
const enc = new TextEncoder();
const LINE = /^agent-bun-runtime: [A-Z_]+: [^\r\n]+\n$/;

let home = "";
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "abr-silent-test-"));
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

interface Host {
  name: "codex" | "claude-code";
  codec: HookCodec;
  session: string; // a valid SessionStart object
  badKey: string; // SessionStart with a key of the wrong type
}
const HOSTS: Host[] = [
  {
    name: "codex",
    codec: codex,
    session: JSON.stringify({ session_id: "s1", cwd: "/project", hook_event_name: "SessionStart", source: "startup" }),
    badKey: JSON.stringify({ session_id: 123, cwd: "/project", hook_event_name: "SessionStart", source: "startup" }),
  },
  {
    name: "claude-code",
    codec: claudeCode,
    session: JSON.stringify({ session_id: "s1", cwd: "/project", hook_event_name: "SessionStart", source: "startup" }),
    badKey: JSON.stringify({ session_id: 123, cwd: "/project", hook_event_name: "SessionStart", source: "startup" }),
  },
];

const NO_DECISION = { kind: "no-decision" } as const;
const CONTEXT = { kind: "add-context", text: "hello", audience: "model", placement: "session-start-input" } as const;
// placement for another event: the codec cannot encode it for SessionStart
const MISPLACED = { kind: "add-context", text: "hello", audience: "model", placement: "subagent-input" } as const;

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sent) {
          sent = true;
          if (bytes.length > 0) controller.enqueue(bytes);
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

interface Outcome {
  code: number;
  stdout: string[];
  stderr: string[];
}

async function run(host: Host, handler: HookHandler, input: string | Uint8Array, options: Partial<MainOptions>): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const code = await main({
    codec: host.codec,
    handler,
    stdin: bytesStream(bytes),
    stdout: (out) => {
      stdout.push(new TextDecoder().decode(out));
    },
    stderr: (text) => {
      stderr.push(text);
    },
    env: {},
    cwd: "/consumer",
    ...options,
  });
  return { code, stdout, stderr };
}

const ok: HookHandler = () => NO_DECISION;
const throwing = (error: unknown): HookHandler => () => {
  throw error;
};

interface Failure {
  label: string;
  handler: HookHandler;
  input: (host: Host) => string | Uint8Array;
  options?: Partial<MainOptions>;
  code: string; // the expected error code
}
const failures: Failure[] = [
  { label: "input: empty", handler: ok, input: () => "", code: "HOOK_INPUT_INVALID" },
  { label: "input: not json", handler: ok, input: () => "not json\n", code: "HOOK_INPUT_INVALID" },
  { label: "input: truncated JSON", handler: ok, input: (h) => h.session.slice(0, 40), code: "HOOK_INPUT_INVALID" },
  { label: "input: not an object", handler: ok, input: () => "[1,2]\n", code: "HOOK_INPUT_INVALID" },
  {
    label: "input: non-UTF-8 bytes",
    handler: ok,
    input: () => Uint8Array.of(...enc.encode('{"hook_event_name":"SessionStart","x":"'), 0xff, ...enc.encode('"}')),
    code: "HOOK_INPUT_INVALID",
  },
  { label: "input: a key of the wrong type (session_id 123)", handler: ok, input: (h) => h.badKey, code: "HOOK_INPUT_INVALID" },
  { label: "input: over maxInputBytes", handler: ok, input: (h) => h.session, options: { maxInputBytes: 16 }, code: "HOOK_INPUT_INVALID" },
  { label: "decode: no hook_event_name", handler: ok, input: () => "{}", code: "HOOK_INPUT_INVALID" },
  { label: "handler: throws an Error", handler: throwing(new Error("boom\nsecond")), input: (h) => h.session, code: "HANDLER_FAILED" },
  { label: "handler: throws a string", handler: throwing("plain"), input: (h) => h.session, code: "HANDLER_FAILED" },
  {
    label: "handler: throws a typed error",
    handler: throwing(new AgentRuntimeError("HOOK_EFFECT_UNSUPPORTED", "handler", "typed")),
    input: (h) => h.session,
    code: "HOOK_EFFECT_UNSUPPORTED",
  },
  { label: "effect: returns nothing", handler: (() => undefined) as unknown as HookHandler, input: (h) => h.session, code: "HOOK_EFFECT_INVALID" },
  { label: "effect: an empty list", handler: (() => []) as unknown as HookHandler, input: (h) => h.session, code: "HOOK_EFFECT_INVALID" },
  { label: "effect: an unknown kind", handler: (() => ({ kind: "bogus" })) as unknown as HookHandler, input: (h) => h.session, code: "HOOK_EFFECT_UNSUPPORTED" },
  { label: "encode: the codec rejects the effect for the event", handler: () => MISPLACED, input: (h) => h.session, code: "HOOK_EFFECT_UNSUPPORTED" },
  {
    label: "output: the stdout writer fails",
    handler: () => CONTEXT,
    input: (h) => h.session,
    options: { stdout: () => Promise.reject(new Error("EPIPE")) },
    code: "OUTPUT_FAILED",
  },
];

describe("onFailure silent in process: every failure exits 0 with the line open writes", () => {
  for (const host of HOSTS) {
    describe(host.name, () => {
      test.each(failures)("$label", async ({ handler, input, options, code }) => {
        const given = input(host);
        const open = await run(host, handler, given, { ...options, onFailure: "open" });
        const silent = await run(host, handler, given, { ...options, onFailure: "silent" });
        // the control: the same failure under open is a real failure with one line
        expect(open.code).toBe(1);
        expect(open.stderr).toHaveLength(1);
        expect(open.stderr[0]).toMatch(LINE);
        expect(open.stderr[0]).toStartWith(`agent-bun-runtime: ${code}: `);
        // silent: exit 0, nothing on stdout, the same one line
        expect(silent.code).toBe(0);
        expect(silent.stdout).toEqual([]);
        expect(silent.stderr).toEqual(open.stderr);
      });
    });
  }

  test("an encoding failure of the codec itself (it returns no string) is silent too", async () => {
    const broken = defineCodec("codex", { ...testImplementation, encode: () => 42 as unknown as string });
    const host: Host = { ...HOSTS[0]!, codec: broken };
    const input = JSON.stringify({ hook_event_name: "SubagentStart", cwd: "/p" });
    const handler: HookHandler = () => CONTEXT;
    const open = await run(host, handler, input, { onFailure: "open" });
    const silent = await run(host, handler, input, { onFailure: "silent" });
    expect(open.code).toBe(1);
    expect(open.stderr).toHaveLength(1);
    expect(open.stderr[0]).toStartWith("agent-bun-runtime: INTERNAL_ERROR: encode failed");
    expect(silent).toEqual({ code: 0, stdout: [], stderr: open.stderr });
  });

  test("a failing stderr writer does not change the exit code: still 0", async () => {
    const outcome = await run(HOSTS[0]!, throwing(new Error("boom")), HOSTS[0]!.session, {
      onFailure: "silent",
      stderr: () => {
        throw new Error("stderr closed");
      },
    });
    expect(outcome).toEqual({ code: 0, stdout: [], stderr: [] });
  });

  for (const host of HOSTS) {
    test(`${host.name}: success is unchanged: exit 0 and the output written once`, async () => {
      const silent = await run(host, () => CONTEXT, host.session, { onFailure: "silent" });
      const open = await run(host, () => CONTEXT, host.session, { onFailure: "open" });
      expect(silent.code).toBe(0);
      expect(silent.stdout).toHaveLength(1);
      expect(silent.stdout[0]).not.toBe("");
      expect(silent.stderr).toEqual([]);
      expect(silent).toEqual(open);
      expect(await run(host, ok, host.session, { onFailure: "silent" })).toEqual({ code: 0, stdout: [], stderr: [] });
    });

    test(`${host.name}: open and closed keep exit 1 and 2 with the same one line`, async () => {
      const handler = throwing(new Error("boom"));
      const open = await run(host, handler, host.session, {});
      const closed = await run(host, handler, host.session, { onFailure: "closed" });
      expect(open).toEqual({ code: 1, stdout: [], stderr: ["agent-bun-runtime: HANDLER_FAILED: boom\n"] });
      expect(closed).toEqual({ code: 2, stdout: [], stderr: open.stderr });
    });
  }

  test("an onFailure that is not open, closed or silent is still INTERNAL_ERROR with exit 1", async () => {
    const outcome = await run(HOSTS[0]!, ok, HOSTS[0]!.session, { onFailure: "Silent" as never });
    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr).toHaveLength(1);
    expect(outcome.stderr[0]).toStartWith("agent-bun-runtime: INTERNAL_ERROR: ");
  });
});

// ---- a real Bun process on pipes ------------------------------------------------------------

const EXIT_BOUND_MS = 10_000;
const TEST_BOUND_MS = 20_000;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

// Starts the entry, writes the input, waits for it to exit on its own; stdin stays open unless
// `close`. Kills only the process it started, and only when the bound runs out.
async function runEntry(host: Host, input: string | Uint8Array, env: Record<string, string>, close: boolean): Promise<Run> {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY, host.name],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, GETTY_HOME: home, CODEX_HOME: home, ...env },
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  try {
    if (input.length > 0) {
      proc.stdin.write(input);
      await proc.stdin.flush();
    }
    if (close) proc.stdin.end();
  } catch {
    // the entry may have ended before it read everything (oversized input); judged below
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), EXIT_BOUND_MS);
  });
  const exited = await Promise.race([proc.exited, bound]);
  clearTimeout(timer);
  if (exited === "timeout") {
    proc.kill();
    await proc.exited;
  }
  try {
    proc.stdin.end();
  } catch {
    // the entry has ended
  }
  if (exited === "timeout") throw new Error(`entry did not exit within ${EXIT_BOUND_MS} ms`);
  return { code: exited, stdout: await stdout, stderr: await stderr };
}

interface ProcessFailure {
  label: string;
  input: (host: Host) => string | Uint8Array;
  env?: Record<string, string>;
  close?: boolean;
  code: string;
}
const processFailures: ProcessFailure[] = [
  { label: "empty (stdin closed)", input: () => "", close: true, code: "HOOK_INPUT_INVALID" },
  { label: "not json", input: () => "not json\n", code: "HOOK_INPUT_INVALID" },
  { label: "truncated JSON (stdin closed)", input: (h) => h.session.slice(0, 40), close: true, code: "HOOK_INPUT_INVALID" },
  { label: "not an object", input: () => "[1,2]\n", code: "HOOK_INPUT_INVALID" },
  {
    label: "non-UTF-8 bytes",
    input: () => Uint8Array.of(...enc.encode('{"hook_event_name":"SessionStart","x":"'), 0xff, ...enc.encode('"}')),
    code: "HOOK_INPUT_INVALID",
  },
  { label: "session_id of the wrong type", input: (h) => h.badKey, code: "HOOK_INPUT_INVALID" },
  { label: "over maxInputBytes", input: (h) => h.session, env: { ABR_TEST_MAX_INPUT_BYTES: "16" }, code: "HOOK_INPUT_INVALID" },
  { label: "handler throws", input: (h) => h.session, env: { ABR_TEST_EFFECTS: "throw" }, code: "HANDLER_FAILED" },
  {
    label: "effect rejected by the codec",
    input: (h) => h.session,
    env: { ABR_TEST_EFFECTS: JSON.stringify(MISPLACED) },
    code: "HOOK_EFFECT_UNSUPPORTED",
  },
];

describe("onFailure silent as a real process: exit code 0, empty stdout, one stderr line", () => {
  for (const host of HOSTS) {
    describe(host.name, () => {
      test.each(processFailures)("$label", async ({ input, env, close, code }) => {
        const given = input(host);
        const silent = await runEntry(host, given, { ...env, ABR_TEST_ON_FAILURE: "silent" }, close === true);
        const open = await runEntry(host, given, env ?? {}, close === true); // the default policy
        expect(open.code).toBe(1);
        expect(open.stderr).toStartWith(`agent-bun-runtime: ${code}: `);
        expect(silent.code).toBe(0);
        expect(silent.stdout).toBe("");
        expect(silent.stderr).toMatch(LINE);
        expect(silent.stderr).toBe(open.stderr);
      }, TEST_BOUND_MS);

      test("closed keeps exit 2", async () => {
        const run = await runEntry(host, "[1]\n", { ABR_TEST_ON_FAILURE: "closed" }, false);
        expect(run.code).toBe(2);
        expect(run.stdout).toBe("");
        expect(run.stderr).toStartWith("agent-bun-runtime: HOOK_INPUT_INVALID: ");
      }, TEST_BOUND_MS);

      test("a success is exit 0 with the output and nothing on stderr", async () => {
        const run = await runEntry(
          host,
          host.session,
          { ABR_TEST_ON_FAILURE: "silent", ABR_TEST_EFFECTS: JSON.stringify(CONTEXT) },
          false,
        );
        expect(run.code).toBe(0);
        expect(run.stdout).not.toBe("");
        expect(run.stderr).toBe("");
      }, TEST_BOUND_MS);
    });
  }
});
