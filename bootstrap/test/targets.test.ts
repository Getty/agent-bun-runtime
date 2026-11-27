// Release 0.2.0 item 5 (k4): the suite's own host-to-target mapping, which the fixture server,
// fetch-fixtures.ts and every scenario that names a target use. Pure: every platform and
// architecture is checked on any machine, so the macOS mapping is verified on the Linux leg too.
// What the macOS leg itself runs (the scenarios with darwin targets) is the rest of the suite.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAll, hostTargets, targetsFor } from "./lib/harness";
import { loadRealTable } from "./lib/table";

afterEach(cleanupAll); // nothing here makes a sandbox; every file that imports the harness says so (sandbox.test.ts)

describe("targetsFor (the targets a starter may choose on a host)", () => {
  test("Linux: x64 has the AVX2 and the baseline build, arm64 one build", () => {
    expect(targetsFor("linux", "x64")).toEqual(["linux-x64", "linux-x64-baseline"]);
    expect(targetsFor("linux", "arm64")).toEqual(["linux-aarch64"]);
  });

  test("macOS: one build per architecture and no baseline (Bun 1.4.5 supports only AVX2 Macs)", () => {
    expect(targetsFor("darwin", "x64")).toEqual(["darwin-x64"]);
    expect(targetsFor("darwin", "arm64")).toEqual(["darwin-aarch64"]);
  });

  test("Windows: x64 has the AVX2 and the baseline build; arm64 is not a target", () => {
    expect(targetsFor("win32", "x64")).toEqual(["windows-x64", "windows-x64-baseline"]);
    expect(targetsFor("win32", "arm64")).toBeNull();
  });

  test("anything else has no target", () => {
    expect(targetsFor("freebsd", "x64")).toBeNull();
    expect(targetsFor("linux", "ia32")).toBeNull();
    expect(targetsFor("darwin", "ia32")).toBeNull();
  });

  test("this host's targets are all in the version table, with the archive and member names Bun ships", () => {
    const table = loadRealTable().versions["1.4.5"]!.targets;
    for (const t of hostTargets()) {
      const e = table[t];
      expect(e, `bootstrap/versions.json has no 1.4.5 entry for ${t}`).toBeDefined();
      expect(e!.archive).toBe(`bun-${t}.zip`);
      expect(e!.member).toBe(`bun-${t}/${t.startsWith("windows-") ? "bun.exe" : "bun"}`);
    }
  });

  test("the table carries both macOS targets and no darwin-x64-baseline (item 5)", () => {
    const names = Object.keys(loadRealTable().versions["1.4.5"]!.targets);
    expect(names).toContain("darwin-x64");
    expect(names).toContain("darwin-aarch64");
    expect(names).not.toContain("darwin-x64-baseline");
  });
});
