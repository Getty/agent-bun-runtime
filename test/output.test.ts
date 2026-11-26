// k11: all hook stdout goes through writeOutput, which writes nothing for empty output.
// Bun 1.4.5 on Windows fails an empty Bun.write to a stdout pipe with EINVAL (CI 45572032454);
// the process test below can only fail for that reason on Windows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOutput } from "../src/output.js";

const EXIT_BOUND_MS = 10_000;
const TEST_TIMEOUT_MS = EXIT_BOUND_MS + 10_000; // above the bound, so the bound can fire

// Runs a fixture script as a child with stdout and stderr pipes and waits for it within the
// bound. Kills only the child it started, and only when the bound runs out.
async function runScript(script: string, args: string[], home: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "fixtures", script), ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, GETTY_HOME: home },
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), EXIT_BOUND_MS);
  });
  const code = await Promise.race([proc.exited, bound]);
  clearTimeout(timer);
  if (code === "timeout") {
    proc.kill();
    await proc.exited;
    throw new Error(`${script} did not exit within ${EXIT_BOUND_MS} ms`);
  }
  return { code, stdout: await stdout, stderr: await stderr };
}

describe("writeOutput", () => {
  test("empty output never reaches the writer", async () => {
    const calls: Uint8Array[] = [];
    await writeOutput(new Uint8Array(), (bytes) => {
      calls.push(bytes);
    });
    expect(calls).toEqual([]);
  });

  test("non-empty output reaches the writer once, byte for byte", async () => {
    const calls: Uint8Array[] = [];
    const bytes = new TextEncoder().encode("{\"ok\":\"ü\"}\n");
    await writeOutput(bytes, async (chunk) => {
      calls.push(chunk);
    });
    expect(calls).toEqual([bytes]);
  });

  test("a failing writer rejects", async () => {
    await expect(
      writeOutput(new Uint8Array([1]), () => {
        throw new Error("EPIPE");
      }),
    ).rejects.toThrow("EPIPE");
  });
});

describe("writeOutput to a real stdout pipe", () => {
  let home = "";
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "abr-sdk-test-"));
  });
  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  for (const [label, text] of [
    ["empty", ""],
    ["non-empty", "Grüße\n"],
  ] as const) {
    test(`${label} output: exit 0, stdout byte for byte`, async () => {
      const { code, stdout, stderr } = await runScript("write-output.ts", [text], home);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: text, stderr: "" });
    }, TEST_TIMEOUT_MS);
  }
});

// k11 negative control. Windows only, because Linux accepts an empty write to a pipe: there
// the raw child exits 0 and the control would only show that Linux is not affected. On
// windows-latest (CI 45579886904) the same raw write fails with EINVAL on a pipe, which is
// the failure writeOutput's guard prevents. A pass here means the control still bites, so
// the "no-decision" tests above are a real regression test on Windows.
describe("an unguarded empty Bun.write to a stdout pipe (k11 negative control)", () => {
  let home = "";
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "abr-sdk-test-"));
  });
  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  test.skipIf(process.platform !== "win32")(
    "fails with EINVAL on Windows (skipped off Windows: Bun only fails there)",
    async () => {
      const { code, stdout, stderr } = await runScript("raw-empty-write.ts", [], home);
      expect(stdout).toBe("");
      expect(code).not.toBe(0);
      expect(stderr).toContain("EINVAL");
    },
    TEST_TIMEOUT_MS,
  );
});
