// Per-hook cost of the starter under test, as a Markdown table on stdout.
//
//   GETTY_BUN_TEST_STARTER=powershell bun bootstrap/test/measure-hook.ts [N]
//
// Median of N (default 10) fast-path `run` calls of a trivial entry (stdin JSON in, JSON
// out), next to the bare shell start and the slot's Bun running the same entry without the
// starter. Wall clock around the spawn. Needs the fixtures (bootstrap/test/fetch-fixtures.ts);
// the install happens once, from the local fixture server, and is not measured.

import { join } from "node:path";
import {
  IS_WIN,
  STARTER,
  run,
  sandbox,
  slotBun,
  starter,
  startServer,
  realRoutes,
  status,
  starterCmd,
} from "./lib/harness";

const n = Number(process.argv[2] ?? 10);
if (!Number.isInteger(n) || n < 1) {
  console.error("measure-hook: N must be a positive integer");
  process.exit(1);
}
const stdin = JSON.stringify({ event: "SessionStart", cwd: "C:\\x\\y" });
const expected = JSON.stringify({ ok: true, event: "SessionStart" });

const server = startServer(await realRoutes());
const sb = await sandbox({ mirror: server.url });
try {
  const e = await starter(sb, ["ensure"]);
  if (e.code !== 0) throw new Error(`install failed (exit ${e.code}): ${e.err}`);
  const st = await status(sb);

  async function timed(label: string, cmd: string[]) {
    const times: number[] = [];
    for (let i = 0; i < n + 1; i++) {
      const r = await run(cmd, { env: sb.env, cwd: sb.cwd, stdin, timeoutMs: 60_000 });
      if (label !== "bare shell" && (r.code !== 0 || r.out !== expected)) {
        throw new Error(`${label}: exit ${r.code}, stdout ${JSON.stringify(r.out)}, stderr ${r.err}`);
      }
      if (i > 0) times.push(r.ms); // the first call warms file caches and is dropped
    }
    times.sort((a, b) => a - b);
    return { label, median: times[times.length >> 1]!, min: times[0]!, max: times[times.length - 1]! };
  }

  const entry = join(sb.root, "entries", "hook.ts");
  const shellCmd =
    STARTER === "sh"
      ? ["sh", "-c", ":"]
      : [STARTER, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit"];
  const rows = [
    await timed("bare shell", shellCmd),
    await timed("bare Bun (slot Bun, same entry, no starter)", [slotBun(st.slot), "--no-install", entry]),
    await timed((STARTER === "sh" ? "direct exec: sh starter `run` (fast path)" : `direct exec form: ${STARTER} -File starter \`run\` (fast path)`), starterCmd(sb.root, ["run", "entries/hook.ts"])),
  ];
  if (STARTER !== "sh") {
    // Codex runs commandWindows in its session shell, `powershell -NoProfile -Command <line>`
    // (source-checked openai/codex 3f65e9f): two PowerShell starts per hook.
    const line = starterCmd(sb.root, ["run", "entries/hook.ts"])
      .map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
      .join(" ");
    rows.push(
      await timed(`Codex nesting: powershell -NoProfile -Command "<${STARTER} -File starter run>"`, [
        "powershell",
        "-NoProfile",
        "-Command",
        line,
      ]),
    );
  }
  const f = (x: number) => x.toFixed(0);
  console.log(`### Per-hook cost: ${STARTER} on ${process.platform}/${process.arch}, N = ${n}`);
  console.log("");
  console.log("| What | median ms | min ms | max ms |");
  console.log("|---|---:|---:|---:|");
  for (const r of rows) console.log(`| ${r.label} | ${f(r.median)} | ${f(r.min)} | ${f(r.max)} |`);
  console.log("");
  const over = rows[2]!.median - rows[1]!.median;
  console.log(`Starter overhead over the bare Bun: ${f(over)} ms median (target ${st.target}${IS_WIN ? ", Windows" : ""}).`);
} finally {
  server.stop();
  const { rm } = await import("node:fs/promises");
  await rm(sb.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
