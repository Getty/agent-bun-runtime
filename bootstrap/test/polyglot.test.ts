// Release 0.2.0 item 6 (ADR 0010): `bootstrap/getty-bun.cmd`, a polyglot. A Claude Code hook that
// must start on Linux, macOS and Windows alike uses shell form and dot-sources it:
//
//   POSIX shell (Linux, macOS, Git Bash):  . "<root>/bootstrap/getty-bun.cmd" run <entry> [args...]
//   PowerShell 5.1 and 7:                  . "<root>\bootstrap\getty-bun.cmd" run <entry> [args...]
//
// As shell code the file hands the call to the getty-bun.sh next to it; as a batch file (run by
// cmd.exe when PowerShell dot-sources it) it runs getty-bun.ps1 next to it. Checked here: stdin and
// stdout byte for byte, the exit code, and the entry's dash arguments (item 4), through every shell
// that is installed. On POSIX legs a shell that is not installed is a skip whose reason is in the
// test's name and in the log; on Windows a missing powershell, pwsh or Git Bash fails the test (a
// Windows leg that skipped its polyglot rows would prove nothing). The release gate (test/gate/)
// never contains a skip.
//
// macOS (darwin) has no /proc and Homebrew has no busybox, so the dash re-run cannot work there:
// no busybox row is registered (not applicable), and the dash row asserts the documented failure
// (one getty-bun line naming the missing arguments, exit 1). /bin/bash (3.2), /bin/sh and zsh pass.
//
// The hook line (ADR 0010) ends in `; exit $LASTEXITCODE`: PowerShell's -Command turns every
// non-zero native exit into 1, so the tail restores the entry's own code. POSIX shells never reach
// the tail (the polyglot execs); a test per POSIX shell checks that it changes no exit code.
// The line is the one constant HOOK below (and the quoting beside it).
//
// Claude Code exports CLAUDE_PLUGIN_ROOT to a hook, so the tests set it as a host does (BusyBox sh
// names a dot-sourced file nowhere and needs it); one test per shell that names its file itself
// runs without it.
//
//   GETTY_BUN_TEST_STARTER=sh bun test bootstrap/test/polyglot.test.ts
//   GETTY_BUN_TEST_BUSYBOX=/path/to/busybox   to name a busybox the PATH does not have

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IS_WIN,
  POLYGLOT_FILE,
  STARTER,
  cleanupAll,
  expectExit,
  findGitBashExe,
  install,
  realRoutes,
  run,
  sandbox,
  startServer,
  track,
  type Sandbox,
} from "./lib/harness";
import { testWhen } from "./lib/when";
import { DASH_ARGS, POSIX_ONLY_ARGS } from "./lib/args";

/** The DASH_ARGS entries the outer PowerShell alters on the way to a `.cmd` (run 46031834399). */
const PS_NATIVE_LIMIT = ["--%", "-Command x"];

const IS_DARWIN = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

setDefaultTimeout(300_000);
afterEach(cleanupAll);

// ---------------------------------------------------------------------------------------
// THE HOOK LINE. `dot` is the dot-source operator, the path is double-quoted as a host's
// ${PLUGIN_ROOT} substitution would be, every other word is single-quoted.
const HOOK = {
  dot: ".",
  tail: "; exit $LASTEXITCODE",
  posix: (cmd: string, words: string[]) => `${HOOK.dot} "${cmd}" ${words.map(shq).join(" ")}${HOOK.tail}`,
  powershell: (cmd: string, words: string[]) => `${HOOK.dot} "${cmd}" ${words.map(psq).join(" ")}${HOOK.tail}`,
};
const shq = (w: string) => `'${w.replaceAll("'", `'\\''`)}'`;
const psq = (w: string) => `'${w.replaceAll("'", "''")}'`;
// ---------------------------------------------------------------------------------------

interface Shell {
  name: string;
  /** the shell names the dot-sourced file itself, so the polyglot needs no CLAUDE_PLUGIN_ROOT */
  namesItsFile: boolean;
  /** null when it can be started, else why not */
  missing: string | null;
  /** the command that runs one hook line in this shell */
  argv(line: string): string[];
  /** the path of the polyglot as this shell takes it */
  path(sb: Sandbox): string;
  words(cmd: string, words: string[]): string;
}

const posixPath = (sb: Sandbox) => join(sb.root, "bootstrap", POLYGLOT_FILE);
const gitPath = (sb: Sandbox) => posixPath(sb).replaceAll("\\", "/");
const which = (n: string) => Bun.which(n);

function posixShell(name: string, bin: string | null, args: string[], namesItsFile = true): Shell {
  return {
    name,
    namesItsFile,
    missing: bin === null ? `${name} is not installed on this machine` : null,
    argv: (line) => [bin!, ...args, "-c", line],
    path: posixPath,
    words: HOOK.posix,
  };
}

function busybox(): string | null {
  const named = process.env.GETTY_BUN_TEST_BUSYBOX;
  if (named) return existsSync(named) ? named : null;
  return which("busybox");
}

function powerShell(name: "powershell" | "pwsh", label: string): Shell {
  const bin = which(name);
  return {
    name: label,
    namesItsFile: true,
    missing: bin === null ? `${name} is not installed on this machine` : null,
    argv: (line) => [bin!, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", line],
    path: posixPath,
    words: HOOK.powershell,
  };
}

const gitBash = findGitBashExe();
const gitBashShell = (path: (sb: Sandbox) => string, name = "Git Bash"): Shell => ({
  name,
  namesItsFile: true,
  missing: gitBash === null ? "Git Bash bash.exe not found (looked via `git --exec-path` and the standard install paths)" : null,
  argv: (line) => [gitBash!, "-c", line],
  path,
  words: HOOK.posix,
});
// macOS: the system shells, which are what a hook gets there (Homebrew's bash on the PATH is another one)
const sysSh = (p: string) => (existsSync(p) ? p : null);
const shells: Shell[] = IS_WIN
  ? [powerShell("powershell", "PowerShell 5.1"), powerShell("pwsh", "PowerShell 7"), gitBashShell(gitPath)]
  : [
      posixShell("sh", IS_DARWIN ? sysSh("/bin/sh") : which("sh"), []),
      posixShell("dash", which("dash"), []),
      posixShell(IS_DARWIN ? "bash 3.2 (/bin/bash)" : "bash", IS_DARWIN ? sysSh("/bin/bash") : which("bash"), []),
      // BusyBox sh names a sourced file nowhere (getty-bun.cmd's own comment), and macOS has no busybox
      ...(IS_DARWIN ? [] : [posixShell("busybox sh", busybox(), ["sh"], false)]),
      posixShell("zsh", which("zsh"), []),
    ];
/** Git Bash with the root as Claude Code likely substitutes it: backslashes, then `/bootstrap/getty-bun.cmd`. */
const gitBashMixed = gitBashShell((sb) => `${sb.root}/bootstrap/${POLYGLOT_FILE}`, "Git Bash (backslash root, mixed path)");

/**
 * One polyglot row. POSIX legs: a shell that is not installed is a skip whose reason is in the name.
 * Windows legs: a missing shell is a failure of the test.
 */
function shellTest(shell: Shell, name: string, fn: () => Promise<void>, timeoutMs?: number): void {
  if (!IS_WIN) {
    testWhen(shell.missing === null, shell.missing ?? "", name, fn, timeoutMs);
    return;
  }
  test(
    name,
    async () => {
      if (shell.missing !== null) throw new Error(`${shell.missing}: a Windows leg needs it, this is not a skip`);
      await fn();
    },
    timeoutMs,
  );
}
// (busybox: `busybox sh -c` is argv [busybox, "sh", "-c", line]; posixShell places the extra word before -c)

/** The environment of a hook: the sandbox's plus the plugin root, which Claude Code exports. */
const hookEnv = (sb: Sandbox) => ({ ...sb.env, CLAUDE_PLUGIN_ROOT: sb.root });

async function installed() {
  const server = startServer(await realRoutes());
  track(() => server.stop());
  const sb = await sandbox({ mirror: server.url });
  await install(sb);
  return { sb, server };
}

describe(`item 6: the .cmd polyglot dot-sourced in shell form [${STARTER}]`, () => {
  test("the polyglot file is delivered next to the starters", () => {
    expect(existsSync(join(import.meta.dir, "..", POLYGLOT_FILE)), `bootstrap/${POLYGLOT_FILE} does not exist yet`).toBe(true);
  });

  for (const shell of shells) {
    // macOS has no /proc: dash cannot hand the call to bash. The documented failure is the contract there.
    if (IS_DARWIN && shell.name === "dash") {
      shellTest(
        shell,
        "dash on macOS (no /proc, so no bash re-run): one getty-bun line naming the missing arguments, exit 1, nothing on stdout",
        async () => {
          const sb = await sandbox();
          const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/info.ts"])), { env: hookEnv(sb), cwd: sb.cwd, timeoutMs: 120_000 });
          expectExit(r, 1);
          expect(r.out).toBe("");
          const lines = r.err.split(/\r?\n/).filter((l) => l !== "");
          expect(lines, `stderr ${JSON.stringify(r.err)}`).toHaveLength(1);
          expect(lines[0]).toMatch(/^getty-bun: .*argument/);
        },
      );
      continue;
    }
    shellTest(
      shell,
      `${shell.name}: stdin and stdout byte for byte, the entry's exit code`,
      async () => {
        const { sb, server } = await installed();
        const requests = server.total();
        const input = new Uint8Array([...Buffer.from("zeile eins üä 日本\n"), 0, 1, 2, 254, 255, 10, 13, 10]);
        const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/echo.ts", "7"])), {
          env: hookEnv(sb),
          cwd: sb.cwd,
          stdin: input,
          timeoutMs: 120_000,
        });
        expectExit(r, 7);
        expect(Buffer.from(r.stdout).equals(Buffer.from(input)), `stdout ${JSON.stringify(r.out)}, stderr ${JSON.stringify(r.err)}`).toBe(true);
        expect(server.total(), "the polyglot made a request").toBe(requests);
      },
    );

    // PowerShell hands arguments to a native command (here the .cmd) through its own re-quoting: `--%`
    // disappears and `-Command x` arrives as two arguments (CI run 46031834399, both PowerShell rows).
    // Git Bash and the POSIX shells pass the whole list.
    const viaPowerShell = shell.words === HOOK.powershell;
    const passed = viaPowerShell ? DASH_ARGS.filter((a) => !PS_NATIVE_LIMIT.includes(a)) : DASH_ARGS;
    shellTest(
      shell,
      `${shell.name}: the entry gets its arguments, the dash ones too, and the exit code 0${viaPowerShell ? " (without the two that PowerShell's native-command passing alters)" : ""}`,
      async () => {
        const { sb } = await installed();
        const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/info.ts", "a b", "über", ...passed, ...POSIX_ONLY_ARGS])), {
          env: hookEnv(sb),
          cwd: sb.cwd,
          timeoutMs: 120_000,
        });
        expectExit(r, 0);
        expect(JSON.parse(r.out).argv).toEqual(["a b", "über", ...passed, ...POSIX_ONLY_ARGS]);
      },
    );

    // Characterization of a limit of PowerShell's native-command argument passing, not of getty-bun:
    // the outer PowerShell drops `--%` and splits `-Command x` before the .cmd runs.
    if (viaPowerShell) shellTest(
      shell,
      `${shell.name}: characterization of PowerShell's native-command argument passing: \`--%\` is dropped and \`-Command x\` arrives split`,
      async () => {
        const { sb } = await installed();
        const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/info.ts", "a b", "über", ...DASH_ARGS])), {
          env: hookEnv(sb),
          cwd: sb.cwd,
          timeoutMs: 120_000,
        });
        expectExit(r, 0);
        const expected = DASH_ARGS.filter((a) => a !== "--%").flatMap((a) => (a === "-Command x" ? ["-Command", "x"] : [a]));
        expect(JSON.parse(r.out).argv).toEqual(["a b", "über", ...expected]);
      },
    );

    // Characterization of Windows PowerShell 5.1's `-File` limit, not of getty-bun: the batch part
    // starts powershell.exe (5.1) whichever shell dot-sourced the file. A lone `-` followed by another
    // argument fails binding (CI run 46027293350); the lone last `-` and `-:foo` are not asserted here
    // (run 46031834399 does not tell which rows of this file they hit).
    if (IS_WIN) shellTest(
      shell,
      `${shell.name}: characterization of PowerShell 5.1: a \`-\` followed by another argument makes -File fail before the script, exit 1, nothing on stdout`,
      async () => {
        const { sb } = await installed();
        const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/info.ts", "-", "x"])), {
          env: hookEnv(sb),
          cwd: sb.cwd,
          timeoutMs: 120_000,
        });
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(r.err).toMatch(/argument "name" is not valid/);
      },
    );

    if (shell.words === HOOK.posix) for (const code of [2, 7]) shellTest(
      shell,
      `${shell.name}: the \`; exit $LASTEXITCODE\` tail leaves the entry's exit code ${code} unchanged`,
      async () => {
        const { sb } = await installed();
        const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/echo.ts", String(code)])), {
          env: hookEnv(sb),
          cwd: sb.cwd,
          stdin: "tail\n",
          timeoutMs: 120_000,
        });
        expectExit(r, code);
        expect(r.out).toBe("tail\n");
      },
    );

    // BusyBox sh names a sourced file nowhere: for it the test above, with CLAUDE_PLUGIN_ROOT, is the contract
    if (shell.namesItsFile) shellTest(
      shell,
      `${shell.name}: without CLAUDE_PLUGIN_ROOT the polyglot finds the getty-bun.sh next to it`,
      async () => {
        const { sb } = await installed();
        const env = { ...sb.env };
        delete env.CLAUDE_PLUGIN_ROOT;
        const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/echo.ts", "3"])), {
          env,
          cwd: sb.cwd,
          stdin: "no plugin root\n",
          timeoutMs: 120_000,
        });
        expectExit(r, 3);
        expect(r.out).toBe("no plugin root\n");
      },
    );

    shellTest(
      shell,
      `${shell.name}: a starter failure is exit 1 with one getty-bun line and nothing on stdout`,
      async () => {
        const sb = await sandbox();
        const r = await run(shell.argv(shell.words(shell.path(sb), ["run", "entries/info.ts"])), {
          env: { ...hookEnv(sb), GETTY_HOME: "relative/home" },
          cwd: sb.cwd,
          timeoutMs: 120_000,
        });
        expectExit(r, 1);
        expect(r.out).toBe("");
        expect(r.err.split(/\r?\n/).filter((l) => l !== "").some((l) => l.startsWith("getty-bun: "))).toBe(true);
      },
    );
  }

  if (IS_WIN) {
    shellTest(
      gitBashMixed,
      `${gitBashMixed.name}: stdin and stdout byte for byte, the entry's exit code`,
      async () => {
        const { sb } = await installed();
        expect(gitBashMixed.path(sb), "the root has no backslash").toMatch(/^[A-Za-z]:\\.*\\[^\\/]*\/bootstrap\//);
        const input = new Uint8Array([...Buffer.from("zeile eins üä 日本\n"), 0, 1, 2, 254, 255, 10, 13, 10]);
        const r = await run(gitBashMixed.argv(gitBashMixed.words(gitBashMixed.path(sb), ["run", "entries/echo.ts", "7"])), {
          env: hookEnv(sb),
          cwd: sb.cwd,
          stdin: input,
          timeoutMs: 120_000,
        });
        expectExit(r, 7);
        expect(Buffer.from(r.stdout).equals(Buffer.from(input)), `stdout ${JSON.stringify(r.out)}, stderr ${JSON.stringify(r.err)}`).toBe(true);
      },
    );

    // The batch side without PowerShell in between: cmd.exe runs the file as a batch file (it holds
    // no shell code cmd can see) and the batch part runs getty-bun.ps1 under Windows PowerShell 5.1.
    test("cmd.exe /d /c getty-bun.cmd run: stdin and stdout byte for byte, the entry's exit code", async () => {
      const { sb } = await installed();
      const cmdExe = process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      expect(existsSync(cmdExe), `${cmdExe} does not exist: a Windows leg needs cmd.exe`).toBe(true);
      const input = new Uint8Array([...Buffer.from("zeile eins üä 日本\n"), 0, 1, 2, 254, 255, 10, 13, 10]);
      const r = await run([cmdExe, "/d", "/c", join(sb.root, "bootstrap", POLYGLOT_FILE), "run", "entries/echo.ts", "7"], {
        env: hookEnv(sb),
        cwd: sb.cwd,
        stdin: input,
        timeoutMs: 120_000,
      });
      expectExit(r, 7);
      expect(Buffer.from(r.stdout).equals(Buffer.from(input)), `stdout ${JSON.stringify(r.out)}, stderr ${JSON.stringify(r.err)}`).toBe(true);
    });
  }

  // dash's "." ignores the arguments after the file name, so the polyglot re-runs the shell's own
  // command line under bash (needs /proc, Linux). It must do so only for a line whose first
  // dot-sourced word is the polyglot: this line sources side.sh first, and a re-run of the whole
  // line would run side.sh twice and then call a starter that nobody meant to call.
  if (IS_LINUX) {
    const dash = which("dash");
    testWhen(
      dash !== null,
      "dash is not installed on this machine (CI installs it)",
      "dash guard: a line that dot-sources another file first is not re-run under bash: side.sh runs once, one getty-bun line, exit 1",
      async () => {
        const server = startServer({}); // answers 404 to everything: a wrongly started starter fails fast, offline
        track(() => server.stop());
        const sb = await sandbox({ mirror: server.url });
        const side = join(sb.cwd, "side.sh");
        const log = join(sb.cwd, "side.log");
        await mkdir(sb.cwd, { recursive: true });
        await writeFile(side, `printf 'ran\\n' >> '${log}'\n`);
        const line = `. ./side.sh; . "${join(sb.root, "bootstrap", POLYGLOT_FILE)}" run e.js`;
        const r = await run([dash!, "-c", line], { env: hookEnv(sb), cwd: sb.cwd, timeoutMs: 120_000 });
        expect((await readFile(log, "utf8")).split("\n").filter((l) => l !== ""), `side.sh must run once; stderr ${JSON.stringify(r.err)}`).toEqual(["ran"]);
        expectExit(r, 1);
        expect(r.out).toBe("");
        const lines = r.err.split(/\r?\n/).filter((l) => l !== "");
        expect(lines, `stderr ${JSON.stringify(r.err)}`).toHaveLength(1);
        expect(lines[0]).toMatch(/^getty-bun: /);
        expect(server.total(), "a starter ran and asked the mirror").toBe(0);
      },
    );
  }
});
