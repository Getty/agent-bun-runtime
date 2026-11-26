// The Codex codec in a real process (card k23, codec part), beyond test/codex.test.ts, which
// closes stdin after the fixture as Codex does: here stdin stays open after the object, and
// every malformed/ fixture goes through the entry with the code its README names. Mocked
// stdin/stdout would prove the codec only; these use real pipes and a real Bun child, still
// no Codex host (real runs are phase 3a).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures", "codex");
const ENTRY = join(FIXTURES, "entry.ts");
const BOUND_MS = 10_000;

let home = "";
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "abr-sdk-test-"));
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const bytes = async (path: string) => await Bun.file(join(FIXTURES, path)).bytes();

// Writes the fixture, then closes stdin or keeps it open until the entry exits. Kills only the
// child it started, and only when the bound runs out.
async function runEntry(mode: "context" | "none", input: Uint8Array, close: boolean) {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY, mode],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, GETTY_HOME: home },
  });
  const stdout = new Response(proc.stdout).bytes();
  const stderr = new Response(proc.stderr).text();
  try {
    if (input.length > 0) proc.stdin.write(input);
    await proc.stdin.flush();
    if (close) proc.stdin.end();
  } catch {
    // the entry may have exited before reading everything; judged by the result
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BOUND_MS);
  });
  const exited = await Promise.race([proc.exited, bound]);
  clearTimeout(timer);
  if (exited === "timeout") {
    proc.kill();
    await proc.exited;
  }
  try {
    proc.stdin.end();
  } catch {}
  if (exited === "timeout") throw new Error(`entry did not exit within ${BOUND_MS} ms (stdin ${close ? "closed" : "open"})`);
  return { code: exited, stdout: await stdout, stderr: await stderr };
}

describe("the Codex entry with stdin left open after the object", () => {
  for (const [input, out] of [
    ["input/session-start.startup.json", "output/session-start.add-context.out"],
    ["input/subagent-start.json", "output/subagent-start.add-context.out"],
  ] as const) {
    test(`${input}: ends by itself, stdout is the .out file`, async () => {
      expect(await runEntry("context", await bytes(input), false)).toEqual({
        code: 0,
        stdout: await bytes(out),
        stderr: "",
      });
    }, 20_000);
  }

  test("no-decision: exit 0, empty stdout", async () => {
    expect(await runEntry("none", await bytes("input/session-start.startup.json"), false)).toEqual({
      code: 0,
      stdout: new Uint8Array(0),
      stderr: "",
    });
  }, 20_000);
});

describe("every malformed/ fixture through the Codex entry: exit 1, empty stdout, one stderr line", () => {
  const cases: Array<[string, string, boolean]> = [
    // [fixture, code, close stdin]; an input that has no end by itself keeps stdin open
    ["malformed/empty.json", "HOOK_INPUT_INVALID", true],
    ["malformed/truncated.json", "HOOK_INPUT_INVALID", true],
    ["malformed/not-an-object.json", "HOOK_INPUT_INVALID", false],
    ["malformed/missing-hook-event-name.json", "HOOK_INPUT_INVALID", false],
    ["malformed/hook-event-name-number.json", "HOOK_INPUT_INVALID", false],
    ["malformed/subagent-start.turn-id-number.json", "HOOK_INPUT_INVALID", false],
    ["malformed/pre-tool-use.tool-name-number.json", "HOOK_INPUT_INVALID", false],
    ["malformed/session-end.json", "HOOK_EFFECT_UNSUPPORTED", false],
  ];
  for (const [file, code, close] of cases) {
    test(`${file}: ${code}`, async () => {
      const result = await runEntry("context", await bytes(file), close);
      expect(result.code).toBe(1);
      expect(result.stdout).toEqual(new Uint8Array(0));
      const lines = result.stderr.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toStartWith(`agent-bun-runtime: ${code}: `);
    }, 20_000);
  }
});
