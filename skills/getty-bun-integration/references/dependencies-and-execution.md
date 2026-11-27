# Dependencies and execution

The rules below are Getty's integration policy, implemented by agent-bun-runtime 0.1.0 (starters and SDK). Read [contract.md](contract.md) for ownership, runtime keys, and the starter interface, [sdk.md](sdk.md) for the entry.

## Ship a bundled entry (normal case)

A consumer commits the output of `bun build --target=bun`: its entry plus `@getty/agent-bun-runtime` and any pure-JS dependency (ADR 0003). User machines download exactly one artifact, the pinned Bun, and never run `bun install`; there is no registry access at hook time.

- Bun documents `--target=bun` as "for bundles that run in the Bun runtime"; such output gets a `// @bun` pragma. Packages are bundled by default; anything marked `external` stays an import resolved at runtime, which a bundled consumer must not have. [Bun bundler](https://bun.com/docs/bundler) (documented, not executed)
- The consumer's CI rebuilds with the pinned Bun and compares byte for byte with the committed bundle.
- A bundle marked `// @bun` is not transpiled again at run time, so a project's `[define]` cannot rewrite it even where a `bunfig.toml` were read (executed, Bun 1.4.5 linux-x64, agent-bun-runtime gate); a plain, unbundled entry would be rewritten.
- Keep `package.json` and `bun.lock` in the repository as build inputs; they are resolved in CI, not on user machines.
- `@getty/agent-bun-runtime` is bundle-friendly: ESM, no dynamic imports, no reads of its own package files, no runtime dependencies. Consumers take it from npm at an exact version (0.1.0 and later), never as a git commit: `dist/` is built at pack time and is not in git (ADR 0009; card k28 stays open for a later need). It is a build-time dependency only. The agent-bun-runtime gate bundles the packed tarball into a scratch consumer and runs it through both starters offline.
- A consumer that needs native add-ons or runtime-resolved packages cannot bundle; see the later option below.

## Execute through the starter

Hooks and binaries call `getty-bun.sh run <entry> [args...]` or `getty-bun.ps1 run <entry> [args...]`. The starter ensures the slot, then runs the slot's Bun by absolute path as `bun --no-install --config=<empty file> --no-env-file <root>/<entry> [args...]` with `BUN_OPTIONS` and the preload, debugger, module-path and code-cache variables removed from its environment ([contract.md](contract.md), "Bun without the project", has the list). Never PATH, a `current` link, `bun upgrade`, `bunx`, or a shebang. Bun documents `--no-install` as disabling runtime auto-installation. [Runtime options](https://bun.com/docs/runtime)

- `<entry>` is relative to the consumer root, the parent of the starters' `bootstrap/` directory. The hook's working directory is kept: the entry sees it as `process.cwd()` and `location.processCwd`, and the host's own `cwd` as `location.hostWorkingDirectory`.
- stdout belongs to the entry (hook JSON, MCP); starter messages go to stderr. The starter passes stdin and stdout byte for byte, including end of input. It never exits 2 for its own failures (they exit 1); the entry's exit code passes through unchanged. Executed, scenario 8. An SDK entry returns 0, 1, or 2 only with `onFailure: "closed"` ([sdk.md](sdk.md)).
- On Windows the entry's exit code arrives as 0–255: Bun 1.4.5 itself exits with the low byte (executed, agent-bun-runtime CI 45589361806). Use codes within 0–255 on every OS, 2 only for the host's meaning of 2 (a block).
- Entry arguments pass through unchanged, those beginning with `-` included (from 0.2.0; the 0.1.0 rule "entry arguments never begin with `-`" is withdrawn, ADR 0011, item 5). Three exceptions the starters cannot change: Bun 1.4.5 consumes a lone `--` as the first entry argument, PowerShell drops an empty `''` argument when it calls the polyglot `.cmd`, and on Windows PowerShell's `-File` can reject a lone `-` (Windows PowerShell 5.1, followed by another argument) and an argument beginning with `-:` (version-dependent) before the starter runs (exit 1), so pass neither there; through the polyglot from a PowerShell hook shell also no `--%` and no `-` argument containing a blank (lost or split). In a polyglot hook line write only words that mean the same to `sh` and PowerShell ([contract.md](contract.md), "Starter interface").
- Bun 1.4.5 on Windows: an empty `Bun.write` to stdout on a pipe throws `EINVAL` (`ftruncate`), bare and through the starter (executed, agent-bun-runtime CI 45589361806; card k11; the exit 9 seen there was the test fixture's own `process.exit(9)` after catching the error, `bootstrap/test/lib/harness.ts:236`, not Bun's). `main()` writes stdout once and nothing when the output is empty; a handler never writes stdout itself.
- stdin: `main()` reads one complete JSON object and does not wait for end of input. Codex closes stdin after the object for a local hook and wraps a remote hook so it reaches end of input (source-checked, [codex.md](codex.md), "Validate the integration"); claude-mem (`4dc8e48`) reads one object because "Codex can keep stdin open". The starters end when the entry ends either way (`getty-bun.ps1`: executed, scenario 8b; `getty-bun.sh` `exec`s Bun). End the entry with `process.exit(await main(...))`, so an open timer or socket cannot hold the hook.
- Windows: the PowerShell starter runs Bun through `System.Diagnostics.Process` with raw byte copies, never through `&` (measured by windows-developer: Windows PowerShell 5.1 did not pass the end of stdin to a native program). Details in [paths-platforms.md](paths-platforms.md).
- A missing import fails at run time with an actionable error; `--no-install` prevents an on-demand package download. Do not substitute `bunx` or `npx`.
- Start Bun child processes from the entry with the same absolute executable and the starter's isolation: `process.execPath` with `--no-install --config=<empty file> --no-env-file`, and `BUN_OPTIONS` and the other variables the starters remove ([contract.md](contract.md), "Bun without the project") deleted from the child's environment, keeping `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (below, "Detached long-lived child processes"). The child inherits the hook's working directory (the user's project) and the environment, so without these flags the project's `bunfig.toml` preload or `[define]`, its `.env*` files and a `BUN_OPTIONS` or `BUN_INSPECT_PRELOAD` preload reach it (derived from the starters' executed k29 checks; the child case itself is not executed here). The empty file must exist (a missing `--config` file makes Bun exit 1): `/dev/null` on POSIX; on Windows a file the entry creates empty under a directory it owns. Audit scripts and shebangs rather than assuming they inherit runtime selection through PATH.
- Preserve exit codes and cancellation; do not report success for skipped or failed application work. Test paths containing spaces and non-ASCII characters, and execution from an unrelated working directory.

## Detached long-lived child processes

An entry may start a process that outlives its hook: a watcher, a background sync. The hook returns at once; the child is the consumer's process, not the starter's, and nothing in getty-bun supervises it. "Executed" below means loadguard's part A probes P5 and P2 (Bun 1.4.5 linux-x64, run outside this repository's suite); this repository has no test of its own for detached children.

```ts
import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["--no-install", `--config=${emptyConfig}`, "--no-env-file", childEntry, token],
  { detached: true, stdio: "ignore", cwd: ownDirectory },
);
child.unref();
```

- **Executable, flags, environment.** The slot's Bun (`process.execPath`) with the starter's isolation flags, as in the rule above; `emptyConfig` is `/dev/null` on POSIX. Under the starter the entry's environment is already clean, and the child inherits it: `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (set by the starters from 0.2.0) and none of the variables they remove ([contract.md](contract.md), "Bun without the project"). Pass no `env`, or one built from `process.env`; never delete `BUN_RUNTIME_TRANSPILER_CACHE_PATH`, which would let Bun pick a cache directory in the user's home again. The starters' side is executed (contract.md); the inheritance by a detached child is not executed. A `cwd` the consumer owns (loadguard: `/`) keeps a long-lived process out of the user's project.
- **Own session.** `detached: true` (or `Bun.spawn({ detached: true })`) makes the child the leader of a new session and process group, sid = pgid = pid, reparented to init (ppid 1) when the hook ends; without `detached` it stays in the hook's session (executed, P5). macOS: not checked. Windows: not checked; Windows has no sessions, a detached child there survives the hook, and the host's kill of the PowerShell starter does not reach Bun at all (card `k13`), so on Windows every child the entry starts may outlive the hook.
- **No inherited streams or descriptors.** `stdio: "ignore"` puts fds 0–2 on `/dev/null`; an open fd 5 of the parent was not inherited (executed, P5). The child's stdout and stderr must not be the hook's: a host reads the hook's pipes to end of file, so a child holding them keeps the hook open until the child ends or the timeout hits (pipe semantics, not executed against a host). Log to a file the consumer owns.
- **The hook does not wait.** No `await child.exited`, no reading its output; `unref()` and the usual `process.exit(await main(...))` end the hook while the child runs on.
- **Priority.** `os.setPriority(10)` in the child lowers its own priority (executed, P5); Windows: not checked.
- **Memory.** Budget about 16 MB VmRSS per idle child: Bun idle with a 2-second timer measured 16.3 MB, of which 14.4 MB is the executable shared with every other process running the same slot's Bun and 1.9 MB is anonymous (executed, P2). Start one child per user or per watched object, not one per hook.
- **One instance: a lock.** The child holds an exclusive lock on a file in a directory the consumer owns (never the starter's install lock) for its whole life; a second child that fails to take it exits. `flock(LOCK_EX | LOCK_NB)` through `bun:ffi` (`dlopen("libc.so.6")`) excluded a second Bun process and worked together with `flock(1)` (executed, P5, util-linux 2.41.5); Bun marks `bun:ffi` experimental, so keep `flock(1)` as the fallback. macOS ships no `flock(1)`; macOS and Windows: not checked.
- **It ends on its own.** The child exits when its work is done, when what it watches is gone, or after an idle limit. Nothing ties it to the session: no `SessionEnd` hook ends it (no starter call there), and the host's end of the hook does not reach a detached child.
- **A re-started hook finds it.** The child writes a pid file with a start token (a random value it also gets as an argument) next to its lock. A hook started again treats the child as running only when the lock is held and the pid file's process still carries the token (Linux: `/proc/<pid>/cmdline`), so a reused pid is not mistaken for it; then it starts nothing. Signal only that pid, never by pattern (`pkill`, `pgrep -f`). This is Getty's policy for consumers, not executed.

## Later/optional: dependency install on the user machine

Plan phase 5, only for the first consumer that cannot bundle. Not part of the MVP and not implemented; the procedure below is kept as the contract for that case.

Ship the real `package.json`, application sources, and `bun.lock`. **Explicitly check that the shipped `bun.lock` exists before installation.** Bun documents that `--frozen-lockfile` can succeed without any lockfile by installing from `package.json`, and can migrate another lockfile in memory; a successful frozen command does not prove the intended lockfile was shipped. [Bun install](https://bun.com/docs/pm/cli/install)

Stage each consumer release in its own content-identified cache outside the user's repositories and the shared runtime store. Include manifest/lockfile digests and runtime key in the install identity. Never share a mutable `node_modules` tree merely because consumers share Bun.

1. Resolve the absolute Bun for the consumer's exact version and target through the starter.
2. Acquire consumer-specific coordination (a consumer lock) before mutating its staged dependencies or binding. The runtime-slot mutex protects neither; see [installation-locking.md](installation-locking.md).
3. With the staged package as `cwd`, run that executable with `install --frozen-lockfile`. Do not regenerate the shipped lockfile on the target machine. Fail on disagreement.
4. Set a reviewed lifecycle-script policy. Use `--ignore-scripts` when compatible. Bun supports `trustedDependencies` and also has a default trusted list; absence of a custom list is not a universal script prohibition. [Lifecycle scripts](https://bun.com/docs/pm/lifecycle)
5. Check native dependencies and generated assets on each supported target. Verify imports and a consumer smoke test, then publish the machine-local binding ([contract.md](contract.md), "Consumer binding").

Which component runs this install (a starter command or the consumer) is not decided; the contract adds no starter command for it.
