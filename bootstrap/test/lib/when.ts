// A test that is registered either way: when `cond` is false it is skipped, and its name and a
// console line say why, so the JUnit report and the log name every skip (a skip is never silent).
// No test hooks here.
import { test } from "bun:test";

export function testWhen(
  cond: boolean,
  reason: string,
  name: string,
  fn: () => Promise<void> | void,
  timeoutMs?: number,
): void {
  if (cond) {
    test(name, fn, timeoutMs);
    return;
  }
  console.warn(`[bootstrap-test] SKIP ${name}: ${reason}`);
  test.skip(`${name} (SKIPPED: ${reason})`, fn);
}
