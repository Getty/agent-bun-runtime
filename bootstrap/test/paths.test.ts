// The suite's own path comparison (lib/harness.ts samePath): scenarios compare the slot and
// execPath a starter reports with the path the test built, which on Windows may differ in
// case or use 8.3 short names (RUNNER~1) for the same file.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WIN, canonPath, samePath } from "./lib/harness";

describe("samePath", () => {
  test("a path that does not exist yet resolves through its existing ancestor", async () => {
    const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "getty-bun-paths-")));
    try {
      await mkdir(join(dir, "real"));
      expect(samePath(join(dir, "real", "a", "b"), join(dir, "real", "a", "b"))).toBe(true);
      expect(samePath(join(dir, "real", "a", "b"), join(dir, "real", "a", "c"))).toBe(false);
      expect(canonPath(join(dir, "real", "a", "b")).toLowerCase()).toBe(join(dir, "real", "a", "b").toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(IS_WIN)("a symlinked directory and its target are the same path", async () => {
    const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "getty-bun-paths-")));
    try {
      await mkdir(join(dir, "real"));
      await symlink(join(dir, "real"), join(dir, "link"));
      expect(samePath(join(dir, "link", "x", "y"), join(dir, "real", "x", "y"))).toBe(true);
      expect(samePath(join(dir, "link", "x"), join(dir, "real", "y"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!IS_WIN)("on Windows case and separators do not matter", async () => {
    const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "getty-bun-paths-")));
    try {
      expect(samePath(dir.toUpperCase(), dir.toLowerCase().replace(/\\/g, "/"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
