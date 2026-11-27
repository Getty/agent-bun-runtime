// Template render: generates the starters of the skilletor template getty-bun-install
// (skills/getty-bun-install/bootstrap/getty-bun.{sh,ps1}.njk) from bootstrap/getty-bun.{sh,ps1}
// and every version in bootstrap/versions.json, and copies bootstrap/getty-bun.cmd, which
// holds no pin, byte for byte to skills/getty-bun-install/bootstrap/getty-bun.cmd: skilletor
// copies a file without .njk byte for byte, exec bit included.
//
//   bun bootstrap/render-template.ts [--check] [--nunjucks DIR]
//
// Without --check it writes both .njk files and the copy; with --check it exits 1 when one
// differs from a fresh generation (bytes or exec bit). --nunjucks DIR (a nunjucks package
// directory, skilletor's nunjucks ^3.2.4) renders each .njk the way skilletor does and
// exits 1 unless every version in the table renders byte for byte to the starter with
// that version's pin block (render-pin.ts), the starter's own pin renders to the
// starter file itself, and a missing or unknown vars.bun_version fails the render;
// likewise with vars.bun_platforms (the "# platforms" line of render-pin.ts --platforms),
// and a vars.bun_platforms that is not a list of unique linux, darwin, windows fails it.
// Every failure is one stderr line beginning with "getty-bun: " per finding and exit 1.
import { chmodSync, copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Failure, PLATFORMS, renderBlock, replaceBlock } from "./render-pin.ts";

const ROOT = resolve(import.meta.dir, "..");
const TABLE = join(ROOT, "bootstrap/versions.json");
const STARTERS = ["getty-bun.sh", "getty-bun.ps1"];
const COPIES = ["getty-bun.cmd"];
const OUT_DIR = join(ROOT, "skills/getty-bun-install/bootstrap");
const BEGIN = "# >>> getty-bun pin: generated, do not edit >>>";
const END = "# <<< getty-bun pin <<<";
const USAGE = "usage: render-template.ts [--check] [--nunjucks DIR]";
// Called only when vars.bun_version is missing or not in the table: nunjucks fails the
// render with "Unable to call `<this name>`, which is undefined or falsey".
const NO_PIN = "vars_bun_version_is_missing_or_not_in_the_getty_bun_install_version_table";
// Called when vars.bun_platforms is set but not a non-empty list of unique PLATFORMS.
const BAD_PLATFORMS = "vars_bun_platforms_must_be_a_list_of_unique_linux_darwin_windows";
const RAW_TAG = /\{%-?\s*(end)?raw\s*-?%\}/;

function fail(message: string): never {
  throw new Failure(message);
}

function parseArgs(argv: string[]) {
  let check = false;
  let nunjucks: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--nunjucks" && argv[i + 1] !== undefined) nunjucks = argv[++i];
    else fail(USAGE);
  }
  return { check, nunjucks };
}

function tableVersions(): string[] {
  let table: any;
  try {
    table = JSON.parse(readFileSync(TABLE, "utf8"));
  } catch (e) {
    fail(`cannot read table ${TABLE}: ${(e as { code?: string }).code ?? "not valid JSON"}`);
  }
  const versions = Object.keys(table?.versions ?? {});
  if (versions.length === 0) fail(`table ${TABLE} has no versions`);
  return versions;
}

function isExec(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

// The starter split around its pin block: text before BEGIN, text after END.
function split(path: string, text: string): [string, string] {
  if (RAW_TAG.test(text)) fail(`${path}: contains a nunjucks raw tag, which the template cannot quote`);
  const marked = replaceBlock(path, text, "\0");
  const [before, after] = marked.split("\0");
  return [before, after];
}

// One .njk: the starter in raw regions, its pin block replaced by a lookup of
// vars.bun_version in a table of every version's rendered block, split after the version
// line, where the platforms line from vars.bun_platforms goes. The keys carry a space
// ("pin 1.4.5"), so no Object.prototype member (constructor, valueOf) can match.
function generate(path: string, text: string, versions: string[]): string {
  const [before, after] = split(path, text);
  const entries = versions.map((v) => {
    const block = renderBlock(TABLE, v);
    if (!/^[ -~\n]*$/.test(block) || /["\\]/.test(block)) fail(`version ${v}: pin block is not plain ASCII`);
    const cut = block.indexOf("\n", block.indexOf("\n") + 1) + 1; // after the version line
    return `${JSON.stringify(`pin ${v}`)}: ${JSON.stringify([block.slice(0, cut), block.slice(cut)])}`;
  });
  const allowed = JSON.stringify(PLATFORMS);
  const platforms =
    `{% if vars.bun_platforms is defined %}{% set ps = vars.bun_platforms %}` +
    `{% if not ps or ps is string or ps.length is not defined or ps.length == 0 %}{{ ${BAD_PLATFORMS}() }}{% endif %}` +
    `{% for p in ps %}{% if not (p in ${allowed}) or ps.indexOf(p) != loop.index0 %}{{ ${BAD_PLATFORMS}() }}{% endif %}{% endfor %}` +
    `# platforms {{ ps | join(" ") }}\n{% endif %}`;
  return (
    "{# Generated by bootstrap/render-template.ts in Getty/agent-bun-runtime; do not edit. #}" +
    `{% raw %}${before}{% endraw %}` +
    `{% set pins = { ${entries.join(", ")} } %}` +
    `{% set key = "pin " + vars.bun_version %}` +
    `{% if key in pins %}{{ pins[key][0] }}${platforms}{{ pins[key][1] }}{% else %}{{ ${NO_PIN}() }}{% endif %}` +
    `{% raw %}${after}{% endraw %}`
  );
}

function verifyNunjucks(dir: string, versions: string[]): string[] {
  const nunjucks = require(resolve(dir));
  const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });
  const problems: string[] = [];
  for (const name of STARTERS) {
    const starterPath = join(ROOT, "bootstrap", name);
    const starter = readFileSync(starterPath, "utf8");
    const njkPath = join(OUT_DIR, `${name}.njk`);
    const njk = readFileSync(njkPath, "utf8");
    const render = (vars: Record<string, unknown>) => env.renderString(njk, { vars });
    for (const v of versions) {
      const want = replaceBlock(starterPath, starter, renderBlock(TABLE, v));
      if (render({ bun_version: v }) !== want) {
        problems.push(`${njkPath}: render for ${v} differs from ${starterPath} with the ${v} pin block`);
      }
    }
    const own = /^# version (.+)$/m.exec(starter.slice(starter.indexOf(BEGIN), starter.indexOf(END)))?.[1];
    if (own === undefined || !versions.includes(own)) {
      problems.push(`${starterPath}: its pin version is not in ${TABLE}`);
    } else if (render({ bun_version: own }) !== starter) {
      problems.push(`${njkPath}: render for ${own} is not byte-identical to ${starterPath}`);
    }
    for (const v of versions) {
      for (const platforms of [["linux"], ["linux", "darwin"], ["windows", "darwin", "linux"]]) {
        const want = replaceBlock(starterPath, starter, renderBlock(TABLE, v, platforms));
        if (render({ bun_version: v, bun_platforms: platforms }) !== want) {
          problems.push(`${njkPath}: render for ${v} with platforms ${platforms} differs from ${starterPath} with that pin block`);
        }
      }
    }
    const failing: Array<[Record<string, unknown>, string]> = [
      [{}, NO_PIN],
      [{ bun_version: "0.0.0-unknown" }, NO_PIN],
      [{ bun_version: "constructor" }, NO_PIN],
      ...[[], ["bsd"], ["linux", "linux"], ["Linux"], "linux", null].map(
        (p): [Record<string, unknown>, string] => [{ bun_version: own ?? versions[0], bun_platforms: p }, BAD_PLATFORMS],
      ),
    ];
    for (const [vars, name] of failing) {
      try {
        render(vars);
        problems.push(`${njkPath}: render with vars ${JSON.stringify(vars)} did not fail`);
      } catch (e) {
        if (!String((e as Error).message).includes(name)) {
          problems.push(`${njkPath}: render with vars ${JSON.stringify(vars)} failed for another reason: ${(e as Error).message}`);
        }
      }
    }
  }
  return problems;
}

function main(argv: string[]): number {
  const { check, nunjucks } = parseArgs(argv);
  const versions = tableVersions();
  const problems: string[] = [];
  for (const name of STARTERS) {
    const starterPath = join(ROOT, "bootstrap", name);
    let starter: string;
    try {
      starter = readFileSync(starterPath, "utf8");
    } catch (e) {
      fail(`cannot read starter ${starterPath}: ${(e as { code?: string }).code ?? e}`);
    }
    const fresh = generate(starterPath, starter, versions);
    const njkPath = join(OUT_DIR, `${name}.njk`);
    if (check) {
      let old: string | undefined;
      try {
        old = readFileSync(njkPath, "utf8");
      } catch {}
      if (old !== fresh) problems.push(`${njkPath} differs from a fresh generation from ${starterPath} and ${TABLE}`);
      else if (isExec(njkPath) !== isExec(starterPath)) problems.push(`${njkPath}: exec bit differs from ${starterPath}`);
    } else {
      try {
        writeFileSync(njkPath, fresh);
        chmodSync(njkPath, isExec(starterPath) ? 0o755 : 0o644);
      } catch (e) {
        fail(`cannot write ${njkPath}: ${(e as { code?: string }).code ?? e}`);
      }
    }
  }
  for (const name of COPIES) {
    const srcPath = join(ROOT, "bootstrap", name);
    let src: Buffer;
    try {
      src = readFileSync(srcPath);
    } catch (e) {
      fail(`cannot read ${srcPath}: ${(e as { code?: string }).code ?? e}`);
    }
    const outPath = join(OUT_DIR, name);
    if (check) {
      let old: Buffer | undefined;
      try {
        old = readFileSync(outPath);
      } catch {}
      if (old === undefined || !src.equals(old)) problems.push(`${outPath} differs from ${srcPath}`);
      else if (isExec(outPath) !== isExec(srcPath)) problems.push(`${outPath}: exec bit differs from ${srcPath}`);
    } else {
      try {
        copyFileSync(srcPath, outPath);
        chmodSync(outPath, isExec(srcPath) ? 0o755 : 0o644);
      } catch (e) {
        fail(`cannot write ${outPath}: ${(e as { code?: string }).code ?? e}`);
      }
    }
  }
  if (nunjucks !== undefined && problems.length === 0) problems.push(...verifyNunjucks(nunjucks, versions));
  for (const p of problems) console.error(`getty-bun: ${p.replace(/\s*\n\s*/g, " ")}`);
  return problems.length === 0 ? 0 : 1;
}

let code: number;
try {
  code = main(process.argv.slice(2));
} catch (e) {
  const message = e instanceof Failure ? e.message : String(e);
  console.error(`getty-bun: ${message.replace(/\s*\n\s*/g, " ")}`);
  code = 1;
}
process.exit(code);
