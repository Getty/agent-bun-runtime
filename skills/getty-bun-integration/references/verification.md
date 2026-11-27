# Integration verification

Use this to verify an implementation. agent-bun-runtime verifies the starters and the SDK in its own CI gates (below); no consumer integration and no host run (Codex, Claude Code) is recorded here. Select the cases material to the claimed environments and record concrete evidence.

## Establish the test subject

Record the agent-bun-runtime revision the starters were rendered from, the consumer revision, the exact Bun pin, the table's checksum for each target, OS/architecture/libc/CPU target, agent client version, and distribution surface. Identify the actual process executing the tool. A Windows host and its WSL distribution are separate subjects.

Label each finding: **documented** (vendor documentation says so; not run), **source-checked**, **schema-checked**, **scenario-reviewed**, **executed** (with command, host version and platform; for agent-bun-runtime's CI the run ID and commit), **measured by windows-developer** (executed there; cite the hub document), or **not checked**. Never turn source inspection or a successful `--version` command into an end-to-end support claim. A mocked stdin/stdout test proves the codec, not the host. A Windows claim needs a run on Windows.

## Provider gate (agent-bun-runtime, phase 1)

The starters are verified in agent-bun-runtime, not in each consumer. The gate passed at `262bc95`: CI 45603412444 (pull request) and 45604685681 (`main`), 10 of 10 jobs green. One shared `bun:test` suite ran the plan's scenarios 1–10 against both starters on `ubuntu-latest` (linux-x64), `ubuntu-24.04-arm` (linux-arm64) and `windows-latest` under `powershell` (5.1) and `pwsh` (7), scenario 11 on both Windows shells, and further cases: 2b (Bun does not inherit the lock), 8b (the host keeps stdin open), a `file://` mirror, the starter contract and interface details. Each case used `GETTY_HOME` in a fresh temporary directory, a `PATH` without Bun and a fixture server through `GETTY_BUN_MIRROR`; two jobs downloaded from GitHub for real (linux-x64, Windows PowerShell 5.1). `shellcheck` and the pin-block check passed, and the per-hook cost is in agent-bun-runtime `docs/hook-cost.md`. A consumer cites that gate for the agent-bun-runtime commit its starters came from; it does not re-test locking.

## Provider gates (agent-bun-runtime, phases 2 and 2b)

- **Phase 2** (SDK core and the first Codex events): the tarball of `bun pm pack`, bundled with `bun build --target=bun` into a scratch consumer, runs offline through the starters. Green on `main` at `0bc8218`, CI 45886094409 (push).
- **Phase 2b** (the 0.1.0 release): the phase 2 gate run from a hostile project directory (a `bunfig.toml` preload and `[define]`, `.env.local`, `BUN_OPTIONS`, none of which may reach the entry, k29; the starters also remove the preload, debugger, module-path and code-cache variables, k40), Claude Code payloads through both starters, and a scratch plugin rendered from `getty-bun-install` whose starter runs a hook, on all CI legs (`docs/plan.md`, "Phases and gates"). The release checklist (`docs/release-0.1.0.md`) tags only after that gate is green; cite the run of the tagged commit.

These gates prove the codecs against recorded or source-derived payloads, not against a host.

Outside the gates, not checked: any host (Codex, Claude Code); a Windows desktop (Defender real-time protection on, an OEM code page, a proxy, AppLocker or WDAC, Constrained Language Mode); a CPU without AVX2; WSL, musl; a Mac desktop and a Rosetta 2 shell (the CI runners `macos-15`, arm64, and `macos-15-intel`, x64, ran the scenario suite, the gate and the per-hook cost in agent-bun-runtime CI 46035250753 at `8fc6133`, and the SDK tests on `macos-15`); the wget download path in CI; hook cost on `linux-aarch64`.

## Consumer behavior

| Case | Evidence to collect |
| --- | --- |
| First hook, no external Bun/Node | The first hook after plugin install installs through the starter; no hint, setup skill or agent turn is needed. |
| Concurrent first hooks | Two sessions or matching hooks: one download, one publish, all run or fail clearly. |
| Lock wait runs out | One stderr line, exit 1, no partial slot; the hook timeout was above the lock wait plus one download. |
| Matching shared runtime | Two consumers with the same pin use the same absolute slot; the second takes the fast path without network. |
| Wrong PATH Bun | Ignored; neither adopted nor modified. |
| Wrong/corrupt slot | Receipt version or target not matching the pin, or the executable missing or empty: fails closed with the path; no overwrite. A Bun whose `--version` differs from the pin is rejected at install only; the fast path never starts Bun, so a damaged non-empty executable is not caught there (plan, scenario 6). |
| Pin consistency | CI: `gettyBun` validates against the schema (`contractVersion` 1 only); the starters' pin block equals `gettyBun.bunVersion`, and its `# platforms` line equals `gettyBun.platforms` (absent when that is not declared); the committed starters, and `getty-bun.cmd` where the plugin commits it, equal a fresh render of `getty-bun-install` (its "Check the copy in CI"). |
| Bundled entry | CI: a rebuild with the pinned Bun is byte-identical; no `external` packages; a missing import fails at run time without a download. |
| Entry on the SDK | `bun:test` through `main()` with recorded host payloads (host version named) for every wired event and effect; a malformed payload exits 1, or 2 with `onFailure: "closed"`, with one `agent-bun-runtime: ` line; the host comes from the hook command, not the environment ([sdk.md](sdk.md), "Testing"). |
| Hostile project | The hook runs from a project with a `bunfig.toml` preload, `.env.local`, `BUN_OPTIONS`, `BUN_INSPECT_PRELOAD` and `NODE_PATH`; none reaches the entry or a Bun child it starts. |
| Large input | The biggest payload the plugin expects (a `Write` or `PostToolUse` result) stays under `maxInputBytes`, or that hook has its own bound. |
| Offline after install | `run` works without network. |
| Hot hook on `run-ready` | Before the first install has finished: exit 0, nothing on stdout, one `getty-bun: ` line naming the slot and the skipped entry, and no lock, staging or download under `GETTY_HOME`; the host treats the hook as passed within its short timeout. After the `SessionStart` install: runs as `run`. A mismatching slot fails closed as with `run`. |
| Undeclared platform | With `gettyBun.platforms` declared, on a platform it does not list: `run`, `run-ready` and `ensure` exit 0 with nothing on stdout and one `getty-bun: ` line, and install nothing; `status` reports `undeclared` with `target` and `slot` null. An invalid `GETTY_HOME` or `GETTY_BUN_LOCK_WAIT` still exits 1. |
| macOS | On each claimed Mac target, `darwin-x64` and `darwin-aarch64`: the first hook installs (the lock needs the shipped `/usr/bin/perl`); a Rosetta 2 shell on Apple silicon uses the `darwin-aarch64` slot. |
| Native Windows and WSL | Separate roots, targets and slots; Git Bash forwarding uses the same slot and lock as PowerShell. |
| Windows PowerShell | Works on 5.1 and 7 under the host; stdin reaches the entry including end of input, and the hook ends when the entry ends; a blocking execution policy is reported by the setup skill. |
| Paths and protocols | Spaces and non-ASCII characters in `GETTY_HOME` and the consumer root; under Codex also a plugin root with `"`, `$` or `` ` `` (textual `${PLUGIN_ROOT}` substitution, [codex.md](codex.md)); stdout byte for byte (UTF-8); the starter never exits 2 for its own failures; the entry's exit code passes through unchanged, 2 included, and stays within 0–255; every argument after `<entry>` the plugin passes, those beginning with `-` included, reaches the entry byte for byte through each starter path it uses (from 0.2.0), except a lone `--` as the first argument, which Bun consumes, a lone `-` or an argument beginning with `-:` on Windows, which PowerShell's `-File` can reject, `--%` or a `-` argument containing a blank through the polyglot from a PowerShell hook shell, which arrive lost or split, and an empty argument where a PowerShell session writes the native call (the polyglot under PowerShell, a `commandWindows` line in Windows PowerShell 5.1) ([contract.md](contract.md), "Entry arguments pass through unchanged (from 0.2.0)"). |
| Version update A to B | B installs beside A on the first call after update; another consumer pinned to A keeps A. |
| Rollback | The previous plugin release runs on its still-present slot. |
| Host trust/activation | Changed hooks obey native review; Codex re-review after a changed bundled script observed; active definitions verified. |
| Consumer uninstall | Only consumer-owned state is removed; shared runtimes remain. |
| Dependency install (later, phase 5 only) | Missing lockfile rejected before frozen install; failed setup publishes no binding; the previous release stays usable. |

## Lock and crash cases

Exercise the implementation of [installation-locking.md](installation-locking.md) with real concurrent processes (provider side, in agent-bun-runtime). The phase 1 gate executed these (CI 45603412444, every leg):

1. Start multiple requests for one missing key. Observe one publisher; waiters re-read and reuse (scenario 2).
2. Hold the mutex until a waiter's `GETTY_BUN_LOCK_WAIT` runs out: clear message, no partial slot, no state deleted (scenario 3; the holder is a fixture process without a marker).
3. Feed a wrong checksum and an archive with an unexpected or extra member. Nothing is published; staging is cleaned (scenarios 4, 5).
4. Start `run` on a fresh install and take the install lock while the entry runs: Bun does not hold it (scenario 2b).

Candidates beyond the phase 1 gate, proposed for agent-bun-runtime and not in its suite:

5. Hold the mutex with an old or malformed marker. Others wait or time out without deleting state.
6. Interrupt before marker creation, during marker write, after marker publication, and after runtime publication, by a handled signal and by SIGKILL. Verify the next owner recovers or validates without exposing a partial ready slot.
7. Reuse a PID/name with a different start identity; separately deny process inspection. Neither condition bypasses a held mutex or kills a process.
8. Start two stale-state recoverers together. Verify serialization and re-reading after acquisition.
9. Delay an earlier owner's cleanup until a new attempt starts. The new marker survives; the permanent lock object remains unchanged.
10. Kill the coordinator while a worker survives. The worker stays protected or confined to its unique stage and cannot publish shared state.
11. Exercise missing lock capability, foreign environment/protocol, and unverified filesystem semantics. Installation and recovery stop before unsafe mutation.

For process termination tests, use isolated fixture stores and fixture processes. Never kill a user's unrelated process or touch the real `~/.getty`, `~/.codex` or `~/.claude`. A local Linux result does not validate Windows or macOS semantics.

## Adequate verification and reporting

Prioritize the real release gate and concrete failure risks. Do not add tests that merely repeat metadata literals or unrelated broad suites. After meaningful checks pass, stop optional expansion and deliver the work.

Bun outside the starter (a consumer's `bun test`, a probe running an unbundled `.ts` entry) writes its transpiler cache into the user's home unless told otherwise; the starters set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, so this concerns only runs outside them. Bun 1.4.5 put it in `$HOME/.bun/install/cache/@t@/` with only `HOME` set, ignored `BUN_INSTALL_CACHE_DIR` and `BUN_INSTALL` for it, and followed `XDG_CACHE_HOME` to `$XDG_CACHE_HOME/bun/@t@/`; with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` it wrote nothing (executed, Bun 1.4.5 linux-x64, `.dev/harness/bun --no-install --config=/dev/null --no-env-file entry.ts` under `env -i` with a fresh temporary `HOME` per run and an entry of about 3000 lines; a consumer saw it ignore `XDG_CACHE_HOME` as well, not reproduced here; macOS and Windows not checked). A verification run therefore sets `HOME` (and `XDG_CACHE_HOME`) to a temporary directory, or `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` as the starters do.

For documentation-only changes, validate frontmatter, schema/examples, relative references, and an independent realistic integration scenario. Record runtime cases as not executed. For starter or adapter changes, run them in the claimed environments or narrow the support statement to what was observed.

Use [the review template](../assets/integration-review-template.md) to summarize decisions, evidence, limitations, and any required host activation step.
