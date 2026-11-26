// An entry on main() as a real process (real Bun child, real pipes): it ends once the hook
// object is read and main() has returned, although its stdin pipe stays open (plan, "Host
// checks", stdin), and its exit code, stdout and stderr follow the exit-code rule.
// These tests prove the SDK against the real process and pipes, not a host.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "fixtures", "entry.ts");
const EXIT_BOUND_MS = 10_000;
const TEST_BOUND_MS = 20_000;
const enc = new TextEncoder();

let home = "";
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "abr-sdk-test-"));
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

type Chunk = string | Uint8Array;

interface RunOptions {
  form?: "exit" | "exitcode";
  /** Written one after the other, each flushed, with a short pause between. */
  chunks: Chunk[];
  /** Close stdin after the chunks (EOF); default: keep it open until the entry has exited. */
  close?: boolean;
  env?: Record<string, string>;
  /** Start reading stdout this long after the child started (a slow host); stderr is read at once. */
  lateReadMs?: number;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts the entry, writes the chunks, then waits for the entry to exit on its own. Kills
// only the process it started, and only when the bound runs out.
async function runEntry(options: RunOptions): Promise<Run> {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY, options.form ?? "exit"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, GETTY_HOME: home, ...options.env },
  });
  const stdout = (async () => {
    if (options.lateReadMs) await pause(options.lateReadMs);
    return await new Response(proc.stdout).text();
  })();
  const stderr = new Response(proc.stderr).text();
  try {
    for (const [index, chunk] of options.chunks.entries()) {
      if (index > 0) await pause(30);
      proc.stdin.write(chunk);
      await proc.stdin.flush();
    }
    if (options.close) proc.stdin.end();
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
    // the entry has ended; its stdin may already be gone
  }
  if (exited === "timeout") throw new Error(`entry did not exit within ${EXIT_BOUND_MS} ms (stdin ${options.close ? "closed" : "open"})`);
  return { code: exited, stdout: await stdout, stderr: await stderr };
}

const runWithOpenStdin = (form: "exit" | "exitcode", input: object) =>
  runEntry({ form, chunks: [`${JSON.stringify(input)}\n`] });

const ADD_CONTEXT = {
  hook_event_name: "SubagentStart",
  effect: { kind: "add-context", text: "Grüße\n", audience: "model", placement: "subagent-input" },
};
const OK: Run = { code: 0, stdout: "Grüße\n", stderr: "" };

function failure(code: string, messagePart: string, run: Run): void {
  expect(run.code).toBe(1);
  expect(run.stdout).toBe("");
  const lines = run.stderr.split("\n");
  expect(lines.length).toBe(2); // exactly one line, newline-terminated
  expect(lines[1]).toBe("");
  expect(lines[0]?.startsWith(`agent-bun-runtime: ${code}: `)).toBe(true);
  expect(lines[0]).toContain(messagePart);
}

describe("an entry on main() with stdin left open", () => {
  for (const form of ["exitcode", "exit"] as const) {
    test(`${form === "exit" ? "process.exit(await main())" : "process.exitCode = await main()"} ends the process`, async () => {
      expect(await runWithOpenStdin(form, ADD_CONTEXT)).toEqual(OK);
    }, TEST_BOUND_MS);
  }

  // k11. On Linux this cannot fail for the Windows reason: Bun accepts an empty write to a
  // pipe there. It proves k11 only on the windows-latest legs, where an unguarded empty
  // Bun.write to a stdout pipe fails with EINVAL (see output.test.ts for the control).
  test("no-decision on a stdout pipe: exit 0, empty stdout, no EINVAL on stderr (k11)", async () => {
    const input = { hook_event_name: "SessionStart", effect: { kind: "no-decision" } };
    const run = await runWithOpenStdin("exit", input);
    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(run.stderr).not.toContain("EINVAL");
  }, TEST_BOUND_MS);
});

describe("stdin of an entry: one complete JSON object, not to EOF", () => {
  const text = JSON.stringify(ADD_CONTEXT);
  const bytes = enc.encode(text);

  test("bytes after the object do not matter, and are not waited for", async () => {
    const run = await runEntry({ chunks: [`${text}\n{"second":1} trailing garbage {{{`] });
    expect(run).toEqual(OK);
  }, TEST_BOUND_MS);

  test("the object arrives in two chunks, split inside a string", async () => {
    const cut = text.indexOf("Gr") + 2;
    expect(await runEntry({ chunks: [text.slice(0, cut), text.slice(cut)] })).toEqual(OK);
  }, TEST_BOUND_MS);

  test("the object is split between a backslash and the escaped character", async () => {
    const escaped = JSON.stringify({ ...ADD_CONTEXT, effect: { ...ADD_CONTEXT.effect, text: 'say "hi" }{\n' } });
    const cut = escaped.indexOf('\\"') + 1; // after the backslash
    expect(escaped[cut - 1]).toBe("\\");
    const run = await runEntry({ chunks: [escaped.slice(0, cut), escaped.slice(cut)] });
    expect(run).toEqual({ code: 0, stdout: 'say "hi" }{\n', stderr: "" });
  }, TEST_BOUND_MS);

  test("the object is split inside a multi-byte UTF-8 character", async () => {
    const cut = bytes.indexOf(0xc3) + 1;
    expect(await runEntry({ chunks: [bytes.slice(0, cut), bytes.slice(cut)] })).toEqual(OK);
  }, TEST_BOUND_MS);

  test("one byte per chunk", async () => {
    const small = { hook_event_name: "SubagentStart", effect: { ...ADD_CONTEXT.effect, text: "a\\\"}ü" } };
    const raw = enc.encode(JSON.stringify(small));
    const run = await runEntry({ chunks: Array.from(raw, (byte) => Uint8Array.of(byte)) });
    expect(run).toEqual({ code: 0, stdout: 'a\\"}ü', stderr: "" });
  }, 60_000);

  test("leading whitespace before the object", async () => {
    expect(await runEntry({ chunks: [" \t\r\n\n", `  ${text}`] })).toEqual(OK);
  }, TEST_BOUND_MS);

  test("one leading byte order mark is accepted", async () => {
    expect(await runEntry({ chunks: [Uint8Array.of(0xef, 0xbb, 0xbf), text] })).toEqual(OK);
  }, TEST_BOUND_MS);

  test("a byte order mark split across chunk boundaries", async () => {
    expect(await runEntry({ chunks: [Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf), text] })).toEqual(OK);
  }, TEST_BOUND_MS);

  test("a closed stdin works too", async () => {
    expect(await runEntry({ chunks: [text], close: true })).toEqual(OK);
  }, TEST_BOUND_MS);

  describe("input that is not one complete JSON object: HOOK_INPUT_INVALID, exit 1, empty stdout", () => {
    test("empty (stdin closed at once)", async () => {
      failure("HOOK_INPUT_INVALID", "empty", await runEntry({ chunks: [], close: true }));
    }, TEST_BOUND_MS);

    test("whitespace only (stdin closed)", async () => {
      failure("HOOK_INPUT_INVALID", "empty", await runEntry({ chunks: ["  \n"], close: true }));
    }, TEST_BOUND_MS);

    test("incomplete: the object is cut off and stdin closed", async () => {
      failure("HOOK_INPUT_INVALID", "incomplete", await runEntry({ chunks: [text.slice(0, 40)], close: true }));
    }, TEST_BOUND_MS);

    test("a second byte order mark before the object", async () => {
      const run = await runEntry({ chunks: [Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf), text] });
      failure("HOOK_INPUT_INVALID", "not a JSON object", run);
    }, TEST_BOUND_MS);

    test("a byte order mark after whitespace", async () => {
      const run = await runEntry({ chunks: [" \n", Uint8Array.of(0xef, 0xbb, 0xbf), text] });
      failure("HOOK_INPUT_INVALID", "not a JSON object", run);
    }, TEST_BOUND_MS);

    for (const [label, input] of [
      ["an array", "[1,2]\n"],
      ["a string", '"text"\n'],
      ["a number", "42\n"],
      ["text", "not json at all\n"],
    ] as const) {
      test(`non-object input: ${label}, stdin open`, async () => {
        failure("HOOK_INPUT_INVALID", "not a JSON object", await runEntry({ chunks: [input] }));
      }, TEST_BOUND_MS);
    }

    test("malformed JSON in braces, stdin open", async () => {
      failure("HOOK_INPUT_INVALID", "not valid JSON", await runEntry({ chunks: ['{"a":}\n'] }));
    }, TEST_BOUND_MS);

    test("non-UTF-8 bytes inside the object, stdin open", async () => {
      const bad = Uint8Array.of(...enc.encode('{"hook_event_name":"SessionStart","x":"'), 0xff, ...enc.encode('"}'));
      failure("HOOK_INPUT_INVALID", "UTF-8", await runEntry({ chunks: [bad] }));
    }, TEST_BOUND_MS);

    test("larger than maxInputBytes, stdin open", async () => {
      const run = await runEntry({
        chunks: [text.slice(0, 20), text.slice(20)],
        env: { ABR_TEST_MAX_INPUT_BYTES: "32" },
      });
      failure("HOOK_INPUT_INVALID", "more than 32 bytes", run);
    }, TEST_BOUND_MS);

    test("the same object within maxInputBytes is accepted", async () => {
      const run = await runEntry({ chunks: [text], env: { ABR_TEST_MAX_INPUT_BYTES: String(bytes.length) } });
      expect(run).toEqual(OK);
    }, TEST_BOUND_MS);
  });
});

describe("every SDK failure in a real process: exit 1, one stderr line, empty stdout", () => {
  const cases: Array<[string, object, string, string]> = [
    ["decode error: event the codec does not handle", { hook_event_name: "PreToolUse" }, "HOOK_EVENT_UNSUPPORTED", "PreToolUse"],
    ["decode error: malformed host object", { cwd: "/x" }, "HOOK_INPUT_INVALID", "hook_event_name"],
    ["handler throws an Error", { hook_event_name: "SubagentStart", effect: "throw" }, "HANDLER_FAILED", "handler failed on purpose"],
    ["handler throws a non-Error value", { hook_event_name: "SubagentStart", effect: "throw-string" }, "HANDLER_FAILED", "plain string on purpose"],
    ["handler throws a typed error, which keeps its code", { hook_event_name: "SubagentStart", effect: "throw-typed" }, "HOOK_EFFECT_UNSUPPORTED", "typed on purpose"],
    ["handler returns nothing", { hook_event_name: "SubagentStart" }, "HOOK_EFFECT_INVALID", "no effect"],
    ["invalid effect: add-context without text", { hook_event_name: "SubagentStart", effect: { kind: "add-context", audience: "model", placement: "subagent-input" } }, "HOOK_EFFECT_INVALID", "text"],
    ["unsupported effect kind", { hook_event_name: "SubagentStart", effect: { kind: "deny" } }, "HOOK_EFFECT_UNSUPPORTED", "deny"],
    ["unsupported audience", { hook_event_name: "SubagentStart", effect: { kind: "add-context", text: "x", audience: "user", placement: "subagent-input" } }, "HOOK_EFFECT_UNSUPPORTED", "user"],
    ["placement the codec cannot deliver for the event", { hook_event_name: "SessionStart", effect: { kind: "add-context", text: "x", audience: "model", placement: "subagent-input" } }, "HOOK_EFFECT_UNSUPPORTED", "SessionStart"],
  ];
  for (const [label, input, code, part] of cases) {
    test(label, async () => {
      failure(code, part, await runWithOpenStdin("exit", input));
    }, TEST_BOUND_MS);
  }
});

describe("output larger than a pipe buffer", () => {
  // About 256 KiB, more than a Windows pipe buffer (4 KiB default) and a Linux one (64 KiB): the
  // child must block on a full pipe and finish once the reader starts, 1.5 s after the spawn,
  // with every byte in place.
  const big = "0123456789abcdef-Grüße-\n".repeat(Math.ceil((256 * 1024) / 24));
  test("add-context of about 256 KiB read late: all bytes arrive, exit 0", async () => {
    const input = {
      hook_event_name: "SubagentStart",
      effect: { kind: "add-context", text: big, audience: "model", placement: "subagent-input" },
    };
    expect(enc.encode(big).length).toBeGreaterThan(256 * 1024);
    const run = await runEntry({ chunks: [JSON.stringify(input)], lateReadMs: 1500 });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout.length).toBe(big.length);
    expect(run.stdout === big).toBe(true);
  }, TEST_BOUND_MS + 10_000);
});
