// Reader and builder for bootstrap/versions.json (shape defined in bootstrap/README.md):
// { versions: { "<v>": { targets: { "<target>": { archive, sha256, member } } } } }

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface TargetEntry {
  archive: string;
  sha256: string;
  member: string;
}
export interface Table {
  versions: Record<string, { targets: Record<string, TargetEntry> }>;
}

export function loadRealTable(): Table {
  const p = join(resolve(import.meta.dir, "../../.."), "bootstrap", "versions.json");
  return JSON.parse(readFileSync(p, "utf8")) as Table;
}

export function archiveInfo(table: Table, version: string, target: string): TargetEntry {
  const e = table.versions[version]?.targets[target];
  if (!e) throw new Error(`table has no ${version}/${target}`);
  return e;
}

/**
 * A table with only `version`, whose targets are copied from the real 1.4.5 entry (the
 * render insists on all five) and overridden for `targets` with the test archive's
 * sha256 and member.
 */
export function tableWith(
  real: Table,
  version: string,
  targets: Record<string, { sha256: string; member: string }>,
): Table {
  const base = real.versions["1.4.5"]!.targets;
  const out: Record<string, TargetEntry> = {};
  for (const [t, e] of Object.entries(base)) {
    out[t] = targets[t] ? { archive: e.archive, ...targets[t]! } : { ...e };
  }
  return { versions: { [version]: { targets: out } } };
}
