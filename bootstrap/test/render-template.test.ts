// Template render tests (card k32): bootstrap/render-template.ts, which generates the
// skilletor template skills/getty-bun-install/bootstrap/getty-bun.{sh,ps1}.njk, and the
// functions bootstrap/render-pin.ts exports to it.
//
// The generator works on fixed paths relative to its own location, so every test that
// writes or mutates copies the files it needs into a temp tree with the same layout and
// runs the copy of the script there. The repository tree is only read.
//
// Real-nunjucks tests need nunjucks, which the repository does not depend on:
// GETTY_BUN_TEST_NUNJUCKS=<dir containing node_modules/nunjucks> (locally .dev/njk).
// They are registered only when the variable is set; one always-registered test fails
// when CI is set and the variable is not, so CI cannot silently skip them.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Failure, renderBlock, replaceBlock } from "../render-pin.ts";

const REPO = resolve(import.meta.dir, "../..");
const REAL_TABLE = join(REPO, "bootstrap/versions.json");
const NJK_REL = "skills/getty-bun-install/bootstrap";
const STARTERS = ["getty-bun.sh", "getty-bun.ps1"];
const BEGIN = "# >>> getty-bun pin: generated, do not edit >>>";
const END = "# <<< getty-bun pin <<<";
const NO_PIN = "vars_bun_version_is_missing_or_not_in_the_getty_bun_install_version_table";
const NJK_DIR = process.env.GETTY_BUN_TEST_NUNJUCKS;
const IS_WIN = process.platform === "win32";

let root: string;
beforeEach(() => {
  // Resolved to the long, native form: the generator builds the paths in its messages from
  // import.meta.dir, so an 8.3 TEMP (RUNNER~1) would not match them on Windows.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "k32-template-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const isExec = (p: string) => (statSync(p).mode & 0o111) !== 0;
const read = (p: string) => readFileSync(p, "utf8");

// A scratch tree: copies of the generator, render-pin, both starters, the table and the
// committed .njk files, in the repository's layout. Returns helpers bound to it.
function scratchTree() {
  const files = [
    "bootstrap/render-template.ts",
    "bootstrap/render-pin.ts",
    "bootstrap/versions.json",
    ...STARTERS.map((s) => `bootstrap/${s}`),
    ...STARTERS.map((s) => `${NJK_REL}/${s}.njk`),
    "bootstrap/getty-bun.cmd",
    `${NJK_REL}/getty-bun.cmd`,
  ];
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    copyFileSync(join(REPO, f), join(root, f));
    chmodSync(join(root, f), statSync(join(REPO, f)).mode & 0o777);
  }
  return {
    path: (rel: string) => join(root, rel),
    njk: (starter: string) => join(root, NJK_REL, `${starter}.njk`),
    starter: (starter: string) => join(root, "bootstrap", starter),
    run: (...args: string[]) => runTemplate(join(root, "bootstrap/render-template.ts"), ...args),
  };
}

function runTemplate(script: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function expectFindings(r: ReturnType<typeof runTemplate>, ...fragments: string[]) {
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  const lines = r.stderr.split("\n").filter((l) => l !== "");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((l) => l.startsWith("getty-bun: "))).toBe(true);
  for (const f of fragments) expect(r.stderr).toContain(f);
}

// ---- drift check ----

test("--check passes on the repository tree and writes nothing", () => {
  const before = STARTERS.map((s) => read(join(REPO, NJK_REL, `${s}.njk`)));
  const r = runTemplate(join(REPO, "bootstrap/render-template.ts"), "--check");
  expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(STARTERS.map((s) => read(join(REPO, NJK_REL, `${s}.njk`)))).toEqual(before);
});

test("--check passes on a scratch copy of the tree", () => {
  const t = scratchTree();
  expect(t.run("--check")).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("generation reproduces the committed .njk files byte for byte", () => {
  const t = scratchTree();
  for (const s of STARTERS) writeFileSync(t.njk(s), "stale\n");
  expect(t.run()).toEqual({ code: 0, stdout: "", stderr: "" });
  for (const s of STARTERS) expect(read(t.njk(s))).toBe(read(join(REPO, NJK_REL, `${s}.njk`)));
  expect(t.run("--check").code).toBe(0);
});

test("generation creates a missing .njk", () => {
  const t = scratchTree();
  rmSync(t.njk("getty-bun.sh"));
  expect(t.run().code).toBe(0);
  expect(read(t.njk("getty-bun.sh"))).toBe(read(join(REPO, NJK_REL, "getty-bun.sh.njk")));
});

for (const s of STARTERS) {
  test(`--check fails on one extra byte in ${s}.njk, names it and changes nothing`, () => {
    const t = scratchTree();
    const drifted = read(t.njk(s)) + "\n";
    writeFileSync(t.njk(s), drifted);
    expectFindings(t.run("--check"), t.njk(s));
    expect(read(t.njk(s))).toBe(drifted);
  });

  test(`--check fails on a missing ${s}.njk`, () => {
    const t = scratchTree();
    rmSync(t.njk(s));
    expectFindings(t.run("--check"), t.njk(s));
    expect(existsSync(t.njk(s))).toBe(false);
  });

  test(`--check fails on a starter change in ${s} without regeneration, passes after it`, () => {
    const t = scratchTree();
    writeFileSync(t.starter(s), read(t.starter(s)) + "\n# an edit outside the pin block\n");
    expectFindings(t.run("--check"), t.njk(s));
    expect(t.run().code).toBe(0);
    expect(read(t.njk(s))).toContain("# an edit outside the pin block");
    expect(t.run("--check")).toEqual({ code: 0, stdout: "", stderr: "" });
  });
}

test("--check fails when versions.json gains a version without regeneration", () => {
  const t = scratchTree();
  const table = JSON.parse(read(t.path("bootstrap/versions.json")));
  const first = Object.keys(table.versions)[0];
  table.versions["9.9.9"] = table.versions[first];
  writeFileSync(t.path("bootstrap/versions.json"), JSON.stringify(table, null, 2));
  expectFindings(t.run("--check"), t.njk("getty-bun.sh"), t.njk("getty-bun.ps1"));
  expect(t.run().code).toBe(0);
  expect(read(t.njk("getty-bun.sh"))).toContain('"pin 9.9.9"');
  expect(t.run("--check").code).toBe(0);
});

// File modes mean nothing on Windows.
if (!IS_WIN) {
  for (const s of STARTERS) {
    test(`--check fails when the exec bit of ${s}.njk differs from the starter's`, () => {
      const t = scratchTree();
      chmodSync(t.njk(s), isExec(t.starter(s)) ? 0o644 : 0o755);
      expectFindings(t.run("--check"), t.njk(s), "exec bit");
    });

    test(`generation gives ${s}.njk the exec bit of the starter, either way`, () => {
      const t = scratchTree();
      for (const mode of [0o755, 0o644]) {
        chmodSync(t.starter(s), mode);
        expect(t.run().code).toBe(0);
        expect(isExec(t.njk(s))).toBe(mode === 0o755);
        expect(t.run("--check").code).toBe(0);
      }
    });
  }
}

// ---- raw tags ----

for (const tag of ["{% raw %}", "{%- endraw -%}", "{%raw%}"]) {
  test(`generation refuses a starter containing ${tag}`, () => {
    const t = scratchTree();
    const njkBefore = STARTERS.map((s) => read(t.njk(s)));
    writeFileSync(t.starter("getty-bun.sh"), read(t.starter("getty-bun.sh")) + `\n# ${tag}\n`);
    expectFindings(t.run(), t.starter("getty-bun.sh"), "raw tag");
    expect(STARTERS.map((s) => read(t.njk(s)))).toEqual(njkBefore);
    expectFindings(t.run("--check"), "raw tag");
  });
}

test("a nunjucks expression or comment in a starter is quoted, not refused", () => {
  const t = scratchTree();
  writeFileSync(t.starter("getty-bun.sh"), read(t.starter("getty-bun.sh")) + "\n# {{ x }} {# y #} {% if z %}\n");
  expect(t.run()).toEqual({ code: 0, stdout: "", stderr: "" });
});

// ---- usage and failures ----

test("usage errors exit 1 with one getty-bun line", () => {
  const t = scratchTree();
  for (const args of [["--bogus"], ["--nunjucks"], ["extra"]]) {
    const r = t.run(...args);
    expectFindings(r, "usage");
    expect(r.stderr.split("\n").filter((l) => l !== "").length).toBe(1);
  }
});

test("a starter without pin markers fails generation, one line naming it", () => {
  const t = scratchTree();
  writeFileSync(t.starter("getty-bun.ps1"), "# no markers\n");
  expectFindings(t.run(), t.starter("getty-bun.ps1"));
});

// ---- render-pin.ts: exports and CLI ----

test("importing render-pin.ts runs no CLI (this test process is still alive)", () => {
  expect(typeof renderBlock).toBe("function");
  expect(typeof replaceBlock).toBe("function");
});

test("renderBlock renders the pin block a starter carries", () => {
  for (const s of STARTERS) {
    const block = renderBlock(REAL_TABLE, "1.4.5");
    expect(read(join(REPO, "bootstrap", s))).toContain(block);
    expect(block.startsWith(BEGIN + "\n# version 1.4.5\n")).toBe(true);
    expect(block.endsWith(END)).toBe(true);
  }
});

test("replaceBlock swaps only the block and is the identity for the starters' own block", () => {
  for (const s of STARTERS) {
    const path = join(REPO, "bootstrap", s);
    const text = read(path);
    expect(replaceBlock(path, text, renderBlock(REAL_TABLE, "1.4.5"))).toBe(text);
    const out = replaceBlock(path, text, "BLOCK");
    expect(out).toContain("\nBLOCK\n");
    expect(out).not.toContain("# version 1.4.5");
    expect(out.length).toBeLessThan(text.length);
  }
});

test("replaceBlock fails with a Failure on missing, doubled or reversed markers", () => {
  expect(() => replaceBlock("f", "none\n", "B")).toThrow(Failure);
  expect(() => replaceBlock("f", `${BEGIN}\n${END}\n${BEGIN}\n${END}\n`, "B")).toThrow(Failure);
  expect(() => replaceBlock("f", `${END}\n${BEGIN}\n`, "B")).toThrow(Failure);
  expect(() => replaceBlock("f", `${BEGIN}\n${END}\n`, "B")).not.toThrow();
});

test("renderBlock throws a Failure naming an unknown version and a missing table", () => {
  expect(() => renderBlock(REAL_TABLE, "9.9.9")).toThrow(Failure);
  expect(() => renderBlock(REAL_TABLE, "9.9.9")).toThrow("9.9.9");
  expect(() => renderBlock(REAL_TABLE, "constructor")).toThrow(Failure);
  expect(() => renderBlock(join(root, "nope.json"), "1.4.5")).toThrow(Failure);
});

test("the render-pin CLI still renders, checks and fails as a script", () => {
  const pin = join(REPO, "bootstrap/render-pin.ts");
  const sh = join(root, "a.sh");
  writeFileSync(sh, `#!/bin/sh\n${BEGIN}\n${END}\necho x\n`);
  expect(runTemplate(pin, "--table", REAL_TABLE, "--version", "1.4.5", "--check", sh).code).toBe(1);
  expect(runTemplate(pin, "--table", REAL_TABLE, "--version", "1.4.5", sh)).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(read(sh)).toBe(`#!/bin/sh\n${renderBlock(REAL_TABLE, "1.4.5")}\necho x\n`);
  expect(runTemplate(pin, "--table", REAL_TABLE, "--version", "1.4.5", "--check", sh).code).toBe(0);
  expectFindings(runTemplate(pin, "--table", REAL_TABLE, "--version", "9.9.9", sh), "9.9.9");
});

// ---- real nunjucks ----

test("real-nunjucks tests are registered whenever CI is set", () => {
  if (process.env.CI && !NJK_DIR) {
    throw new Error(
      "CI is set but GETTY_BUN_TEST_NUNJUCKS is not: the real-nunjucks render tests did not run. " +
        "Set it to a directory containing node_modules/nunjucks (nunjucks 3.2.x).",
    );
  }
});

if (NJK_DIR) {
  const nunjucksPkg = join(resolve(NJK_DIR), "node_modules/nunjucks");
  const nunjucks = require(nunjucksPkg);
  // Skilletor's environment: no autoescape, undefined values throw.
  const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });
  const render = (starter: string, vars: Record<string, unknown>) =>
    env.renderString(read(join(REPO, NJK_REL, `${starter}.njk`)), { vars });
  const versions = Object.keys(JSON.parse(read(REAL_TABLE)).versions);

  test("the nunjucks package is the 3.2 line skilletor uses", () => {
    expect(nunjucks.version ?? JSON.parse(read(join(nunjucksPkg, "package.json"))).version).toMatch(/^3\.2\./);
  });

  for (const s of STARTERS) {
    for (const v of versions) {
      test(`${s}.njk renders for ${v} to the starter with that pin block, byte for byte`, () => {
        const starter = join(REPO, "bootstrap", s);
        expect(render(s, { bun_version: v })).toBe(replaceBlock(starter, read(starter), renderBlock(REAL_TABLE, v)));
      });
    }

    // Release 0.2.0 item 7: vars.bun_platforms adds the `# platforms` line; without it the block is as before
    test(`${s}.njk renders vars.bun_platforms to the starter with that platforms line, byte for byte`, () => {
      const starter = join(REPO, "bootstrap", s);
      for (const platforms of [["linux", "darwin"], ["windows"], ["linux", "darwin", "windows"]]) {
        const want = replaceBlock(starter, read(starter), renderBlock(REAL_TABLE, "1.4.5", platforms));
        expect(want).toContain(`# platforms ${platforms.join(" ")}\n`);
        expect(render(s, { bun_version: "1.4.5", bun_platforms: platforms })).toBe(want);
      }
    });

    test(`${s}.njk fails the render for a platform that is not linux, darwin or windows`, () => {
      expect(() => render(s, { bun_version: "1.4.5", bun_platforms: ["linux", "plan9"] })).toThrow();
      expect(() => render(s, { bun_version: "1.4.5", bun_platforms: ["Linux"] })).toThrow();
    });

    test(`${s}.njk renders for 1.4.5 to the committed starter, byte for byte`, () => {
      expect(render(s, { bun_version: "1.4.5" })).toBe(read(join(REPO, "bootstrap", s)));
    });

    test(`${s}.njk fails for an unknown version, naming the undefined function`, () => {
      expect(() => render(s, { bun_version: "9.9.9" })).toThrow(NO_PIN);
    });

    test(`${s}.njk fails for a missing vars.bun_version, naming the undefined function`, () => {
      expect(() => render(s, {})).toThrow(NO_PIN);
      expect(() => env.renderString(read(join(REPO, NJK_REL, `${s}.njk`)), {})).toThrow();
    });

    test(`${s}.njk fails for Object.prototype names such as constructor`, () => {
      for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
        expect(() => render(s, { bun_version: name })).toThrow(NO_PIN);
      }
    });

    test(`${s}.njk keeps its text outside the pin block raw: braces in the starter survive`, () => {
      const out = render(s, { bun_version: "1.4.5" });
      expect(out).toBe(read(join(REPO, "bootstrap", s)));
      expect(out).not.toContain("{% raw");
    });
  }

  test("render-template --check --nunjucks passes on the tree and on a scratch copy", () => {
    const args = ["--check", "--nunjucks", nunjucksPkg];
    expect(runTemplate(join(REPO, "bootstrap/render-template.ts"), ...args)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(scratchTree().run(...args)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("render-template --nunjucks fails when the starter's own pin is not in the table", () => {
    const t = scratchTree();
    const table = JSON.parse(read(t.path("bootstrap/versions.json")));
    const only = Object.keys(table.versions)[0];
    table.versions["1.4.6"] = table.versions[only];
    delete table.versions[only];
    writeFileSync(t.path("bootstrap/versions.json"), JSON.stringify(table, null, 2));
    // Regenerate for the new table, then verify: the starters still carry the old pin.
    const r = t.run("--nunjucks", nunjucksPkg);
    expectFindings(r, "not in");
  });
}
