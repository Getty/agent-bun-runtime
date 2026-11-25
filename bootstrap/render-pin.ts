// Pin render: writes the getty-bun pin block from a version table into starter files.
//
//   bun bootstrap/render-pin.ts --table FILE --version V [--check] FILE...
//
// Rewrites the block between the marker lines in each FILE in place, or with
// --check exits 1 when a FILE differs from a fresh render. Every failure is one
// stderr line beginning with "getty-bun: " and exit 1. Format: bootstrap/README.md.
import { readFileSync, writeFileSync } from "node:fs";

const BEGIN = "# >>> getty-bun pin: generated, do not edit >>>";
const END = "# <<< getty-bun pin <<<";
const TARGETS = [
  "linux-x64",
  "linux-x64-baseline",
  "linux-aarch64",
  "windows-x64",
  "windows-x64-baseline",
];
const USAGE = "usage: render-pin.ts --table FILE --version V [--check] FILE...";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const ARCHIVE_RE = /^[0-9A-Za-z._-]+\.zip$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SEGMENT_RE = /^[0-9A-Za-z._-]+$/;

class Failure extends Error {}

function fail(message: string): never {
  throw new Failure(message);
}

function parseArgs(argv: string[]) {
  let table: string | undefined;
  let version: string | undefined;
  let check = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--table" || arg === "--version") {
      const value = argv[++i];
      if (value === undefined) fail(USAGE);
      if (arg === "--table") table = value;
      else version = value;
    } else if (arg === "--check") {
      check = true;
    } else if (arg.startsWith("-")) {
      fail(USAGE);
    } else {
      files.push(arg);
    }
  }
  if (table === undefined || version === undefined || files.length === 0) fail(USAGE);
  return { table, version, check, files };
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read ${what} ${path}: ${(e as { code?: string }).code ?? e}`);
  }
}

function renderBlock(tablePath: string, version: string): string {
  let table: any;
  try {
    table = JSON.parse(readText(tablePath, "table"));
  } catch (e) {
    if (e instanceof Failure) throw e;
    fail(`table ${tablePath} is not valid JSON`);
  }
  const entry = table?.versions?.[version];
  if (!Object.hasOwn(table?.versions ?? {}, version) || typeof entry !== "object") {
    fail(`version ${version} is not in table ${tablePath}`);
  }
  if (!VERSION_RE.test(version)) fail(`table ${tablePath}: version ${version} is malformed`);
  const targets = entry?.targets ?? {};
  for (const name of Object.keys(targets)) {
    if (!TARGETS.includes(name)) {
      fail(`table ${tablePath}: version ${version} has unknown target ${name}`);
    }
  }
  const lines = [BEGIN, `# version ${version}`];
  for (const name of TARGETS) {
    const t = targets[name];
    const where = `table ${tablePath}: version ${version} target ${name}`;
    if (typeof t !== "object" || t === null) fail(`${where} is missing`);
    if (typeof t.archive !== "string" || !ARCHIVE_RE.test(t.archive)) {
      fail(`${where}: archive is not a plain .zip file name`);
    }
    if (typeof t.sha256 !== "string" || !SHA256_RE.test(t.sha256)) {
      fail(`${where}: sha256 is not 64 lowercase hex digits`);
    }
    const segments = typeof t.member === "string" ? t.member.split("/") : [];
    if (
      segments.length === 0 ||
      !segments.every((s: string) => SEGMENT_RE.test(s) && s !== "." && s !== "..")
    ) {
      fail(`${where}: member is not a relative path of plain segments`);
    }
    lines.push(`# target ${name} ${t.archive} ${t.sha256} ${t.member}`);
  }
  lines.push(END);
  return lines.join("\n");
}

function replaceBlock(path: string, text: string, block: string): string {
  const lines = text.split("\n");
  const begins = lines.flatMap((l, i) => (l === BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === END ? [i] : []));
  if (begins.length === 0 || ends.length === 0) fail(`${path}: pin block markers not found`);
  if (begins.length > 1 || ends.length > 1) fail(`${path}: more than one pin block`);
  if (ends[0] < begins[0]) fail(`${path}: pin block end marker before begin marker`);
  lines.splice(begins[0], ends[0] - begins[0] + 1, block);
  return lines.join("\n");
}

function main(argv: string[]): number {
  const { table, version, check, files } = parseArgs(argv);
  const block = renderBlock(table, version);
  const results = files.map((path) => {
    const old = readText(path, "file");
    return { path, old, fresh: replaceBlock(path, old, block) };
  });
  if (check) {
    const stale = results.filter((r) => r.old !== r.fresh);
    for (const r of stale) {
      console.error(
        `getty-bun: ${r.path}: pin block differs from a fresh render of version ${version} from ${table}`,
      );
    }
    return stale.length === 0 ? 0 : 1;
  }
  for (const r of results) {
    if (r.old !== r.fresh) {
      try {
        writeFileSync(r.path, r.fresh);
      } catch (e) {
        fail(`cannot write file ${r.path}: ${(e as { code?: string }).code ?? e}`);
      }
    }
  }
  return 0;
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
