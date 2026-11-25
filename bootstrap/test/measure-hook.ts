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
  findGitBashExe,
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
  // Observed rows are evidence, never failures: exit codes, bytes and timeouts are data.
  //  - Codex nesting: Codex runs commandWindows in its session shell,
  //    `powershell -NoProfile -Command <line>` (source-checked openai/codex 3f65e9f), so two
  //    PowerShell starts per hook.
  //  - Git Bash: bash.exe -> getty-bun.sh -> PowerShell -> Bun (the sh starter forwards).
  interface Seen {
    ms: number;
    code: number | null;
    timedOut: boolean;
    out: string;
    err: string;
  }
  interface Observed {
    label: string;
    seen: Seen[];
  }
  const observed: Observed[] = [];
  let directOut = "";

  async function observe(label: string, cmd: string[]): Promise<void> {
    const seen: Seen[] = [];
    for (let i = 0; i < n; i++) {
      try {
        const r = await run(cmd, { env: sb.env, cwd: sb.cwd, stdin, timeoutMs: 30_000 });
        seen.push({ ms: r.ms, code: r.code, timedOut: r.timedOut, out: r.out, err: r.err });
        if (r.timedOut && seen.filter((x) => x.timedOut).length >= 2) break; // enough evidence
      } catch (e) {
        seen.push({ ms: 0, code: null, timedOut: false, out: "", err: `spawn failed: ${e}` });
        break;
      }
    }
    observed.push({ label, seen });
    // the main table counts only runs that exited 0
    const done = seen.filter((x) => !x.timedOut && x.code === 0).map((x) => x.ms).sort((a, b) => a - b);
    rows.push({
      label: `${label} (${done.length} of ${seen.length} runs exited 0; those only)`,
      median: done.length ? done[done.length >> 1]! : NaN,
      min: done.length ? done[0]! : NaN,
      max: done.length ? done[done.length - 1]! : NaN,
    });
  }

  if (STARTER !== "sh") {
    directOut = (
      await run(starterCmd(sb.root, ["run", "entries/hook.ts"]), { env: sb.env, cwd: sb.cwd, stdin, timeoutMs: 60_000 })
    ).out;
    const line = starterCmd(sb.root, ["run", "entries/hook.ts"])
      .map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
      .join(" ");
    await observe(`Codex nesting: powershell -NoProfile -Command "<${STARTER} -File starter run>"`, [
      "powershell",
      "-NoProfile",
      "-Command",
      line,
    ]);
    const bash = findGitBashExe();
    if (bash) {
      await observe("Git Bash -> getty-bun.sh -> Windows PowerShell 5.1 -> Bun (the forwarding prefers 5.1 on both legs: Windows reviewer, source-checked)", [
        bash,
        join(sb.root, "bootstrap", "getty-bun.sh").replace(/\\/g, "/"),
        "run",
        "entries/hook.ts",
      ]);
    } else {
      console.warn("[measure-hook] no Git Bash found: the Git Bash row is left out");
    }
  }
  const f = (x: number) => (Number.isNaN(x) ? "n/a" : x.toFixed(0));
  console.log(`### Per-hook cost: ${STARTER} on ${process.platform}/${process.arch}, N = ${n}`);
  console.log("");
  console.log("| What | median ms | min ms | max ms |");
  console.log("|---|---:|---:|---:|");
  for (const r of rows) console.log(`| ${r.label} | ${f(r.median)} | ${f(r.min)} | ${f(r.max)} |`);
  console.log("");
  const over = rows[2]!.median - rows[1]!.median;
  const esc = (t: string) => JSON.stringify(t).replace(/\|/g, "\\|");
  for (const o of observed) {
    console.log(`#### ${o.label}: recorded as data (not a pass or fail)`);
    console.log("");
    console.log("| run | exit code | timed out | stdout equals the direct form | stdout (JSON-escaped) | stderr (JSON-escaped) |");
    console.log("|---:|---:|---|---|---|---|");
    o.seen.forEach((r, i) =>
      console.log(
        `| ${i + 1} | ${r.code ?? "none"} | ${r.timedOut} | ${r.out === directOut} | ${esc(r.out)} | ${esc(r.err.slice(0, 200))} |`,
      ),
    );
    console.log("");
  }
  if (observed.length) console.log(`Direct form stdout: ${esc(directOut)}\n`);
  console.log(`Starter overhead over the bare Bun: ${f(over)} ms median (target ${st.target}${IS_WIN ? ", Windows" : ""}).`);
} finally {
  server.stop();
  const { rm } = await import("node:fs/promises");
  await rm(sb.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
