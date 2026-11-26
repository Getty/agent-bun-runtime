// Fails unless a `bun test --reporter=junit` report shows tests that actually ran.
// A gate that skips itself (env var unset, wrong starter, no matching file) exits 0 in
// bun test; this turns "nothing ran" and "anything skipped" into a failed CI step.
// Default is strict: 0 tests, any skipped test or any failure exits 1.
// Usage: bun .github/scripts/assert-tests-ran.ts [--allow-skips] [--require-ran <name substring>]... <junit.xml>
//   --allow-skips   tolerate skipped tests (the SDK suite skips Windows-only cases elsewhere)
//   --require-ran   a testcase whose name contains the substring must exist and not be
//                   skipped (repeatable)
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let allowSkips = false;
const required: string[] = [];
let file: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--allow-skips") allowSkips = true;
  else if (arg === "--require-ran") {
    const value = args[++i];
    if (!value) {
      console.error("--require-ran needs a name substring");
      process.exit(2);
    }
    required.push(value);
  } else file = arg;
}
if (!file) {
  console.error("usage: assert-tests-ran.ts [--allow-skips] [--require-ran <substring>] <junit.xml>");
  process.exit(2);
}

let xml: string;
try {
  xml = readFileSync(file, "utf8");
} catch (error) {
  console.error(`no junit report at ${file}: ${(error as Error).message}`);
  process.exit(1);
}

const root = /<testsuites\b[^>]*>/.exec(xml)?.[0];
if (!root) {
  console.error(`${file} has no <testsuites> element`);
  process.exit(1);
}
const attr = (name: string): number => {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(root);
  return match ? Number(match[1]) : Number.NaN;
};

const tests = attr("tests");
const skipped = attr("skipped");
const failures = attr("failures");
console.log(`tests=${tests} skipped=${skipped} failures=${failures}`);

if (!Number.isFinite(tests) || !Number.isFinite(skipped) || !Number.isFinite(failures)) {
  console.error("could not read tests/skipped/failures from the report");
  process.exit(1);
}
if (tests === 0) {
  console.error("the report lists 0 tests: the gate did not run");
  process.exit(1);
}
if (skipped > 0 && !allowSkips) {
  console.error(`${skipped} of ${tests} tests were skipped: a skipped gate is not a pass`);
  process.exit(1);
}
if (failures > 0) {
  console.error(`${failures} tests failed`);
  process.exit(1);
}

for (const needle of required) {
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].filter((m) =>
    (/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? "").includes(needle),
  );
  if (cases.length === 0) {
    console.error(`no testcase with "${needle}" in its name`);
    process.exit(1);
  }
  if (cases.some((m) => /<skipped\b/.test(m[3] ?? ""))) {
    console.error(`testcase "${needle}" was skipped: it must run here`);
    process.exit(1);
  }
  console.log(`required testcase ran: ${needle}`);
}
