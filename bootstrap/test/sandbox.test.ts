// k43: the suite's own hygiene. A full `bun test bootstrap/test` used to leave ~46
// getty-bun-test-* sandboxes in TMPDIR because lib/harness.ts registered its afterEach at
// import time (it attached to one file only), and a starter run could write Bun's default
// transpiler cache into the developer's real cache because XDG_CACHE_HOME (Windows:
// LOCALAPPDATA, TEMP) passed through. Three checks:
//  - every test file that uses the harness registers the cleanup itself (static, catches a
//    new file at once, also one whose tests are all skipped);
//  - two such files run together leave no getty-bun-test-* directory (dynamic: a child
//    `bun test` with its own TMPDIR);
//  - a sandbox scopes the cache and temp variables to itself, whatever the caller's are.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP, IS_WIN, REPO, STARTER, cleanupAll, exists, run, sandbox, samePath } from "./lib/harness";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

const TEST_DIR = join(BOOTSTRAP, "test");

const mine: string[] = [];
afterEach(async () => {
  while (mine.length) await rm(mine.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe(`suite hygiene (k43) [${STARTER}]`, () => {
  test("every test file that imports the harness registers its own cleanup", async () => {
    const names = (await readdir(TEST_DIR)).filter((f) => f.endsWith(".test.ts")).sort();
    const using: string[] = [];
    for (const f of names) {
      const text = await readFile(join(TEST_DIR, f), "utf8");
      if (!/from "\.\/lib\/harness"/.test(text)) continue;
      using.push(f);
      const registers = /\b(afterEach|afterAll)\(\s*cleanupAll\s*\)/.test(text);
      expect(registers, `${f} imports the harness but never calls afterEach(cleanupAll) or afterAll(cleanupAll)`).toBe(true);
    }
    expect(using).toContain("scenarios.test.ts");
    expect(using).toContain("hostile-cwd.test.ts");
  });

  test("two test files run together leave no getty-bun-test-* directory in TMPDIR", async () => {
    const scratch = realpathSync.native(await mkdtemp(join(tmpdir(), "getty-bun-leakcheck-")));
    mine.push(scratch);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.TMPDIR = env.TMP = env.TEMP = scratch;
    env.GETTY_BUN_TEST_STARTER = STARTER;
    // one cheap sandbox-using test from each of two files; neither is this file
    const r = await run(
      [
        process.execPath,
        "test",
        join(TEST_DIR, "scenarios.test.ts"),
        join(TEST_DIR, "hostile-cwd.test.ts"),
        "-t",
        "wrong checksum|BUN_OPTIONS=--help",
      ],
      { env, cwd: REPO, timeoutMs: 280_000 },
    );
    // the child's own verdict does not matter here (a starter under development may fail its
    // tests); that it ran one test in each file, and what it left behind, does
    const log = `${r.out}\n${r.err}`;
    expect(log, "the child run did not run one test in each of two files").toMatch(/Ran 2 tests across 2 files/);
    const left = (await readdir(scratch)).filter((n) => n.startsWith("getty-bun-test-"));
    expect(left, `left behind in ${scratch}`).toEqual([]);
  });

  test("a sandbox scopes the cache and temporary directories to itself, whatever the caller set", async () => {
    const names = IS_WIN ? ["LOCALAPPDATA", "TEMP", "TMP"] : ["XDG_CACHE_HOME", "TMPDIR"];
    // the temp variables stay as they are (this process makes the sandbox in tmpdir()); the
    // cache variable is the one a caller sets to its real cache
    const callerOwned = names.filter((n) => n === "XDG_CACHE_HOME" || n === "LOCALAPPDATA");
    const saved = callerOwned.map((n) => [n, process.env[n]] as const);
    mine.push(join(tmpdir(), "getty-bun-caller-owned")); // whatever the harness's own Bun writes there
    for (const n of callerOwned) process.env[n] = join(tmpdir(), "getty-bun-caller-owned", n);
    try {
      const sb = await sandbox();
      for (const n of names) {
        const v = sb.env[n];
        expect(v, `${n} is not set in the sandbox environment`).toBeTruthy();
        expect(samePath(v!, sb.tmp) || samePath(join(v!, ".."), sb.tmp), `${n}=${v} is outside the sandbox ${sb.tmp}`).toBe(true);
        expect(await exists(v!), `${n}=${v} does not exist`).toBe(true);
      }
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });
});
