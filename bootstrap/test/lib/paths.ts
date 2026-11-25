// Path comparison for the scenario suite. No test hooks here: paths.test.ts imports this
// file alone.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const IS_WIN = process.platform === "win32";

/**
 * Compare two paths as the file system sees them: long names (not 8.3 short names),
 * canonical case, separators. A path that does not exist yet is resolved through its
 * nearest existing ancestor.
 */
export function canonPath(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      const full = tail.length ? join(real, ...tail.reverse()) : real;
      return IS_WIN ? full.replace(/\//g, "\\").toLowerCase() : full;
    } catch {
      const up = dirname(cur);
      if (up === cur) return IS_WIN ? p.replace(/\//g, "\\").toLowerCase() : p;
      tail.push(cur.slice(up.length).replace(/^[\\/]+/, ""));
      cur = up;
    }
  }
}
export const samePath = (a: string, b: string) => canonPath(a) === canonPath(b);

