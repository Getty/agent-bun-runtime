// Downloads the real Bun release archives the scenario suite serves from its local
// fixture server, into .dev/fixtures/bun-v<version>/, and verifies each against
// bootstrap/versions.json. A no-op when the files are present and match.
//
//   bun bootstrap/test/fetch-fixtures.ts
//
// This is the only place the suite's tooling talks to GitHub.

import { mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_DIR, REAL_VERSION, hostTargets, sha256Hex } from "./lib/harness";
import { archiveInfo, loadRealTable } from "./lib/table";

const BASE = "https://github.com/oven-sh/bun/releases/download";
const table = loadRealTable();
await mkdir(FIXTURE_DIR, { recursive: true });

let failed = false;
for (const target of hostTargets()) {
  const want = archiveInfo(table, REAL_VERSION, target).sha256;
  const file = join(FIXTURE_DIR, `bun-${target}.zip`);
  if (existsSync(file)) {
    const have = sha256Hex(new Uint8Array(await Bun.file(file).arrayBuffer()));
    if (have === want) {
      console.log(`ok       ${target} (present, sha256 matches)`);
      continue;
    }
    console.log(`stale    ${target}: sha256 ${have} != table ${want}; downloading again`);
  }
  const url = `${BASE}/bun-v${REAL_VERSION}/bun-${target}.zip`;
  console.log(`download ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    console.error(`fetch-fixtures: ${url} answered HTTP ${res.status}`);
    failed = true;
    continue;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256Hex(bytes);
  if (got !== want) {
    console.error(`fetch-fixtures: ${target}: sha256 ${got} does not match bootstrap/versions.json (${want}); not saved`);
    failed = true;
    continue;
  }
  const part = `${file}.part`;
  await Bun.write(part, bytes);
  await rm(file, { force: true });
  await rename(part, file);
  console.log(`ok       ${target} (downloaded, sha256 matches)`);
}
process.exit(failed ? 1 : 0);
