// Render tests (card k6, adopted by the test-writer lane): bootstrap/render-pin.ts.
// Run with the rest: bun test bootstrap/test
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RENDER = resolve(import.meta.dir, "../render-pin.ts");
const REAL_TABLE = resolve(import.meta.dir, "../versions.json");
const BEGIN = "# >>> getty-bun pin: generated, do not edit >>>";
const END = "# <<< getty-bun pin <<<";
const TARGETS = [
  "linux-x64",
  "linux-x64-baseline",
  "linux-aarch64",
  "darwin-x64",
  "darwin-aarch64",
  "windows-x64",
  "windows-x64-baseline",
];
const FAKE = "0.0.1-test";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "k6-render-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixtureTable(mutate?: (t: any) => void): string {
  const targets: Record<string, unknown> = {};
  TARGETS.forEach((t, i) => {
    targets[t] = {
      archive: `bun-${t}.zip`,
      sha256: String(i + 1).repeat(64),
      member: `bun-${t}/${t.startsWith("windows-") ? "bun.exe" : "bun"}`,
    };
  });
  const table: any = { versions: { [FAKE]: { targets } } };
  mutate?.(table);
  const path = join(dir, "test table.json");
  writeFileSync(path, JSON.stringify(table, null, 2));
  return path;
}

function fixtureBlock(platforms?: string): string {
  const lines = [BEGIN, `# version ${FAKE}`];
  if (platforms !== undefined) lines.push(`# platforms ${platforms}`);
  TARGETS.forEach((t, i) => {
    const member = `bun-${t}/${t.startsWith("windows-") ? "bun.exe" : "bun"}`;
    lines.push(`# target ${t} bun-${t}.zip ${String(i + 1).repeat(64)} ${member}`);
  });
  lines.push(END);
  return lines.join("\n");
}

function scratch(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function render(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, RENDER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

function expectOneError(r: ReturnType<typeof render>, fragment: string) {
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  const lines = r.stderr.split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(1);
  expect(lines[0].startsWith("getty-bun: ")).toBe(true);
  expect(lines[0]).toContain(fragment);
}

const SH_HEAD = "#!/bin/sh\n# starter header\n";
const SH_TAIL = "\necho 'body stays'\n";
const PS_HEAD = "$ErrorActionPreference = 'Stop'\r\n# ps header\n";
const PS_TAIL = "\nWrite-Output 'body stays'\n";

test("fills an empty block and keeps everything outside it byte for byte", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${SH_HEAD}${BEGIN}\n${END}${SH_TAIL}`);
  const r = render("--table", table, "--version", FAKE, sh);
  expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(readFileSync(sh, "utf8")).toBe(`${SH_HEAD}${fixtureBlock()}${SH_TAIL}`);
});

test("writes a byte-identical block into every file", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${SH_HEAD}${BEGIN}\n${END}${SH_TAIL}`);
  const ps = scratch("a.ps1", `${PS_HEAD}${BEGIN}\n${END}${PS_TAIL}`);
  expect(render("--table", table, "--version", FAKE, sh, ps).code).toBe(0);
  expect(readFileSync(sh, "utf8")).toBe(`${SH_HEAD}${fixtureBlock()}${SH_TAIL}`);
  expect(readFileSync(ps, "utf8")).toBe(`${PS_HEAD}${fixtureBlock()}${PS_TAIL}`);
});

test("replaces a stale block and is idempotent", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${SH_HEAD}${BEGIN}\n# version 9.9.9\n# junk\n${END}${SH_TAIL}`);
  expect(render("--table", table, "--version", FAKE, sh).code).toBe(0);
  const once = readFileSync(sh, "utf8");
  expect(once).toBe(`${SH_HEAD}${fixtureBlock()}${SH_TAIL}`);
  expect(render("--table", table, "--version", FAKE, sh).code).toBe(0);
  expect(readFileSync(sh, "utf8")).toBe(once);
});

test("--check passes on a fresh render and changes nothing", () => {
  const table = fixtureTable();
  const content = `${SH_HEAD}${fixtureBlock()}${SH_TAIL}`;
  const sh = scratch("a.sh", content);
  const r = render("--check", "--table", table, "--version", FAKE, sh);
  expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(readFileSync(sh, "utf8")).toBe(content);
});

test("--check fails on a stale block, names the file, changes nothing", () => {
  const table = fixtureTable();
  const content = `${SH_HEAD}${BEGIN}\n# version 9.9.9\n${END}${SH_TAIL}`;
  const sh = scratch("stale.sh", content);
  const r = render("--table", table, "--version", FAKE, "--check", sh);
  expectOneError(r, sh);
  expect(readFileSync(sh, "utf8")).toBe(content);
});

test("--check reports every differing file", () => {
  const table = fixtureTable();
  const a = scratch("a.sh", `${BEGIN}\n${END}\n`);
  const b = scratch("b.ps1", `${BEGIN}\n${END}\n`);
  const r = render("--check", "--table", table, "--version", FAKE, a, b);
  expect(r.code).toBe(1);
  const lines = r.stderr.split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(2);
  expect(lines.every((l) => l.startsWith("getty-bun: "))).toBe(true);
  expect(lines[0]).toContain(a);
  expect(lines[1]).toContain(b);
});

test("an unknown version fails with one line and writes nothing", () => {
  const table = fixtureTable();
  const content = `${BEGIN}\n${END}\n`;
  const sh = scratch("a.sh", content);
  expectOneError(render("--table", table, "--version", "9.9.9", sh), "9.9.9");
  expect(readFileSync(sh, "utf8")).toBe(content);
});

test("a target missing from the table fails with one line naming it", () => {
  const table = fixtureTable((t) => delete t.versions[FAKE].targets["linux-aarch64"]);
  const content = `${BEGIN}\n${END}\n`;
  const sh = scratch("a.sh", content);
  expectOneError(render("--table", table, "--version", FAKE, sh), "linux-aarch64");
  expect(readFileSync(sh, "utf8")).toBe(content);
});

// Release 0.2.0 item 5: the two macOS targets are part of the block, in this order.
test("the block lists the seven targets in order, the macOS ones between Linux and Windows", () => {
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expect(render("--table", fixtureTable(), "--version", FAKE, sh).code).toBe(0);
  const targets = readFileSync(sh, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("# target "))
    .map((l) => l.split(" ")[2]);
  expect(targets).toEqual([
    "linux-x64",
    "linux-x64-baseline",
    "linux-aarch64",
    "darwin-x64",
    "darwin-aarch64",
    "windows-x64",
    "windows-x64-baseline",
  ]);
});

test("a table without the macOS targets fails with one line naming the first one missing", () => {
  const table = fixtureTable((t) => delete t.versions[FAKE].targets["darwin-x64"]);
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), "darwin-x64");
});

test("a darwin-x64-baseline target fails: macOS has no baseline build", () => {
  const table = fixtureTable((t) => {
    t.versions[FAKE].targets["darwin-x64-baseline"] = {
      archive: "bun-darwin-x64-baseline.zip",
      sha256: "f".repeat(64),
      member: "bun-darwin-x64-baseline/bun",
    };
  });
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), "darwin-x64-baseline");
});

// Release 0.2.0 item 7: `# platforms <p> [<p>...]` after `# version`, from --platforms; without
// the flag the block is as before.
test("--platforms adds one platforms line after the version line, in the given order", () => {
  const sh = scratch("a.sh", `${SH_HEAD}${BEGIN}\n${END}${SH_TAIL}`);
  const r = render("--table", fixtureTable(), "--version", FAKE, "--platforms", "linux,darwin", sh);
  expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(readFileSync(sh, "utf8")).toBe(`${SH_HEAD}${fixtureBlock("linux darwin")}${SH_TAIL}`);
});

test("--platforms with one platform, and with all three", () => {
  for (const [flag, line] of [
    ["windows", "windows"],
    ["linux,darwin,windows", "linux darwin windows"],
  ] as const) {
    const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
    expect(render("--table", fixtureTable(), "--version", FAKE, "--platforms", flag, sh).code).toBe(0);
    expect(readFileSync(sh, "utf8")).toBe(`${fixtureBlock(line)}\n`);
  }
});

test("--platforms writes the same line into every file", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${SH_HEAD}${BEGIN}\n${END}${SH_TAIL}`);
  const ps = scratch("a.ps1", `${PS_HEAD}${BEGIN}\n${END}${PS_TAIL}`);
  expect(render("--table", table, "--version", FAKE, "--platforms", "linux", sh, ps).code).toBe(0);
  expect(readFileSync(sh, "utf8")).toBe(`${SH_HEAD}${fixtureBlock("linux")}${SH_TAIL}`);
  expect(readFileSync(ps, "utf8")).toBe(`${PS_HEAD}${fixtureBlock("linux")}${PS_TAIL}`);
});

test("without --platforms the block has no platforms line, and a stale one is removed", () => {
  const sh = scratch("a.sh", `${BEGIN}\n# version 9.9.9\n# platforms linux\n${END}\n`);
  expect(render("--table", fixtureTable(), "--version", FAKE, sh).code).toBe(0);
  const text = readFileSync(sh, "utf8");
  expect(text).not.toContain("# platforms");
  expect(text).toBe(`${fixtureBlock()}\n`);
});

test("--check compares the platforms line: it passes with the same list and fails without or with another", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${fixtureBlock("linux darwin")}\n`);
  expect(render("--check", "--table", table, "--version", FAKE, "--platforms", "linux,darwin", sh)).toEqual({
    code: 0,
    stdout: "",
    stderr: "",
  });
  expectOneError(render("--check", "--table", table, "--version", FAKE, sh), sh);
  expectOneError(render("--check", "--table", table, "--version", FAKE, "--platforms", "linux", sh), sh);
});

test("an unknown platform fails with one line naming it and writes nothing", () => {
  const content = `${BEGIN}\n${END}\n`;
  const sh = scratch("a.sh", content);
  expectOneError(render("--table", fixtureTable(), "--version", FAKE, "--platforms", "linux,plan9", sh), "plan9");
  expect(readFileSync(sh, "utf8")).toBe(content);
  expectOneError(render("--table", fixtureTable(), "--version", FAKE, "--platforms", "Linux", sh), "Linux");
  expect(readFileSync(sh, "utf8")).toBe(content);
});

test("a platform listed twice fails: the list is unique", () => {
  const content = `${BEGIN}\n${END}\n`;
  const sh = scratch("a.sh", content);
  expectOneError(render("--table", fixtureTable(), "--version", FAKE, "--platforms", "linux,linux", sh), "linux");
  expect(readFileSync(sh, "utf8")).toBe(content);
});

test("an empty platform list fails: at least one platform", () => {
  const content = `${BEGIN}\n${END}\n`;
  const sh = scratch("a.sh", content);
  const r = render("--table", fixtureTable(), "--version", FAKE, "--platforms", "", sh);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr.split("\n").filter((l) => l !== "").length).toBe(1);
  expect(readFileSync(sh, "utf8")).toBe(content);
});

test("--platforms without a value is a usage error", () => {
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", fixtureTable(), "--version", FAKE, sh, "--platforms"), "usage");
});

test("a target the starters do not know fails", () => {
  const table = fixtureTable((t) => {
    t.versions[FAKE].targets["linux-x64-musl"] = {
      archive: "bun-linux-x64-musl.zip",
      sha256: "f".repeat(64),
      member: "bun-linux-x64-musl/bun",
    };
  });
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), "linux-x64-musl");
});

test("missing markers fail with one line naming the file; no file is written", () => {
  const table = fixtureTable();
  const good = scratch("good.sh", `${BEGIN}\n${END}\n`);
  const bad = scratch("bad.ps1", "# no markers here\n");
  expectOneError(render("--table", table, "--version", FAKE, good, bad), bad);
  expect(readFileSync(good, "utf8")).toBe(`${BEGIN}\n${END}\n`);
});

test("a begin marker without an end marker fails", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${BEGIN}\n# version 1\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), sh);
});

test("two blocks in one file fail", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), sh);
});

test("an end marker before the begin marker fails", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${END}\n${BEGIN}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), sh);
});

test("a malformed sha256 in the table fails", () => {
  const table = fixtureTable((t) => (t.versions[FAKE].targets["windows-x64"].sha256 = "ABC"));
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), "windows-x64");
});

test("a member with a parent segment fails", () => {
  const table = fixtureTable((t) => (t.versions[FAKE].targets["linux-x64"].member = "../bun"));
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), "linux-x64");
});

test("a malformed version key fails", () => {
  const bad = "1.4.5 latest";
  const table = fixtureTable((t) => (t.versions[bad] = t.versions[FAKE]));
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", bad, sh), "malformed");
});

test("an archive name with a path fails", () => {
  const table = fixtureTable((t) => (t.versions[FAKE].targets["linux-x64"].archive = "x/bun.zip"));
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), "archive");
});

test("a table that is not JSON fails with one line naming it", () => {
  const table = scratch("broken.json", "{ not json");
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), table);
});

test("a missing table file fails with one line naming it", () => {
  const table = join(dir, "nope.json");
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--table", table, "--version", FAKE, sh), table);
});

test("usage errors exit 1, never 2", () => {
  const table = fixtureTable();
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expectOneError(render("--version", FAKE, sh), "usage");
  expectOneError(render("--table", table, sh), "usage");
  expectOneError(render("--table", table, "--version", FAKE), "usage");
  expectOneError(render("--table", table, "--version", FAKE, "--bogus", sh), "usage");
  expectOneError(render("--table"), "usage");
});

test("the real table renders the 1.4.5 block shown in bootstrap/README.md", () => {
  const sh = scratch("a.sh", `${BEGIN}\n${END}\n`);
  expect(render("--table", REAL_TABLE, "--version", "1.4.5", sh).code).toBe(0);
  const block = readFileSync(sh, "utf8");
  const readme = readFileSync(resolve(import.meta.dir, "../README.md"), "utf8");
  expect(readme).toContain(block);
});
