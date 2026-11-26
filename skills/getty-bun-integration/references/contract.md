# Getty integration contract

Contract version 1 (`gettyBun.contractVersion`), implemented by agent-bun-runtime 0.1.0. These are Getty design decisions, recorded in the `agent-bun-runtime` repository (`docs/plan.md`, `docs/adr/0001`–`0009`); where this skill and they disagree at the release tag, they win.

- **Starters** (`bootstrap/getty-bun.sh`, `bootstrap/getty-bun.ps1`, the version table and the pin render): `bootstrap/README.md` is their behavior contract. Phase 1 gate: CI 45603412444 (pull request) and 45604685681 (`main`) at `262bc95`, 10 of 10 jobs green ([verification.md](verification.md), "Provider gate"). In this skill, "executed, scenario N" means that suite in run 45603412444, on all legs the scenario runs on. Later changes (k29: Bun starts without the project's configuration) are checked by the release's CI.
- **Delivery:** the skilletor template `getty-bun-install` in the release's `skills/`.
- **SDK** `@getty/agent-bun-runtime` with the codecs for Codex and Claude Code ([sdk.md](sdk.md)).
- **Not checked:** how Codex and Claude Code run the starters and the codecs; the CI runners are no desktops, and no real host has run a codec from agent-bun-runtime.

## Responsibilities

| Component | Owns |
| --- | --- |
| Bootstrap (`agent-bun-runtime` `bootstrap/`; delivered as template `getty-bun-install`) | Reviewed version table (SHA256 per target, expected archive member), pin render, the two starters: target detection, install on demand under the OS lock, staging, receipt, atomic publish, fast path, `run`, `ensure`, `status`. |
| SDK `@getty/agent-bun-runtime` | Invocation envelope, the Codex and Claude Code codecs, effects, `main(): Promise<number>`, exit codes. Never installs, downloads, or edits lockfiles, not even in a diagnostic command. |
| Consumer plugin/tool | `gettyBun` pin in `package.json`, `vars.bun_version` for the template, the starters copied from the rendered template and committed, the committed bundled entry built on the SDK, CI that checks both, host hook files, setup skill for repair and diagnosis, hook timeouts above the lock wait plus one download. |
| Agent host | Instruction/skill/hook surfaces, workspace trust, hook review, execution, timeouts. |
| Setup agent | Repair and diagnosis through the packaged setup skill within session authorization; reporting what the starter said. Not the install path. |

Call the provider `getty-bun`; its repository is `agent-bun-runtime`. There is no `getty-bun` command on PATH: the provider is the pair of rendered starters committed into each consumer. Keep the managed executable named `bun` or `bun.exe`. The starter interface is `run`, `ensure`, `status` and nothing else; `repair`, `gc`, upgrade and rollback are later and unspecified. Missing provider behavior (a target, a starter feature, an event or effect) is built in `agent-bun-runtime` first, never worked around in the consumer.

## Starter interface

```text
getty-bun.sh  run <entry> [args...]   ensure, then exec the absolute Bun (flags below)
getty-bun.sh  ensure                  install if missing; nothing on stdout
getty-bun.sh  status                  one JSON object on stdout: pin, target, slot, state
getty-bun.ps1 <same commands>         identical behavior and exit codes
```

Plan, "Starter interface"; details in agent-bun-runtime `bootstrap/README.md`. Executed unless marked otherwise.

- **Location.** A consumer carries the starters as `<consumer-root>/bootstrap/getty-bun.sh` and `<consumer-root>/bootstrap/getty-bun.ps1`; the consumer root is the parent of the starter's directory, never the working directory. `<entry>` is relative to that root, written with `/` (the PowerShell starter converts it).
- **Install on demand.** `run` and `ensure` take the fast path for a matching slot and install a missing one under the OS lock; concurrent calls wait on the same lock, bounded, then re-check (scenarios 1, 2, 3).
- **`status` never installs.** It prints `pin`, `target`, `slot` (absolute) and `state`, one of `ready`, `missing`, `mismatch`, and exits 0 whenever it printed the object, 1 when the state cannot be determined (for example an unsupported target, or an invalid `GETTY_HOME` or `GETTY_BUN_LOCK_WAIT`).
- **Lock released before Bun.** `getty-bun.sh` holds the lock on a descriptor that only the install's command group has open; `getty-bun.ps1` disposes the lock stream after publishing; an entry never holds it. The rule rests on flock(2)/execve(2) semantics ([installation-locking.md](installation-locking.md), step 6); executed (scenario 2b: while an entry runs after a fresh install, the test takes the lock without waiting).
- **Bun without the project.** `run` starts `<slot>/bin/bun --no-install --config=<empty file> --no-env-file <root>/<entry> [args...]` with `BUN_OPTIONS`, `BUN_INSPECT_PRELOAD`, `BUN_INSPECT`, `BUN_INSPECT_CONNECT_TO`, `NODE_PATH`, `NODE_COMPILE_CACHE`, `BUN_RUNTIME_TRANSPILER_CACHE_PATH` and `BUN_INTERNAL_WEBVIEW_HOST` removed from Bun's environment (`BUN_OPTIONS` adds flags such as `--preload` past `--config`; the others add a preload, start the debugger, resolve modules outside the plugin, pick a code cache directory, or on macOS replace the entry with a webview host), and keeps the hook's working directory (the SDK's `location.processCwd`). The empty file is `/dev/null` for `getty-bun.sh` and `<GETTY_HOME>\runtimes\bun\.config\bunfig.toml`, created by `run` and `ensure`, for `getty-bun.ps1`; a missing `--config` file would make Bun exit 1. So the project's `bunfig.toml` (preload, `[define]`), `.env`, `.env.local`, `.env.<NODE_ENV>`, a `BUN_OPTIONS` preload and those variables never reach the entry (`bootstrap/README.md`, "Starting Bun: no project configuration"; executed on Bun 1.4.5 linux-x64, cards k29 and k40: the removal of every variable is tested; the preload, `NODE_PATH` and the cache writes are executed in the suite's controls, the debugger effect only in a raw probe outside the suite, while "restored as code" and the macOS webview host are source-checked; a `BUN_INSPECT` value with `?wait=1` would hold a hook until the host's timeout, as that probe showed; the Windows legs in the release's CI). A Bun child process the entry starts inherits that cwd and environment and needs the same flags ([dependencies-and-execution.md](dependencies-and-execution.md)).
- **Streams.** stdout belongs to the entry (hook JSON); starter messages go to stderr, also during an install inside `run` (scenario 8). Give hook input on a pipe; for a stdin that is a character device under Git Bash, see [paths-platforms.md](paths-platforms.md) (a hint, not a requirement).
- **Exit codes.** Exit 0 when ready; 1 for every starter failure, with one stderr line beginning `getty-bun: ` that names what failed and where. The starter never exits 2 for its own failures (some hosts read 2 as a block); the entry's exit code passes through unchanged, 2 included (scenario 8: 0, 1, 2, 7, 42). 2 stays the entry's (ADR 0007, superseding that part of ADR 0002); an SDK entry returns it only with `onFailure: "closed"` ([sdk.md](sdk.md)).
- **Exit codes on Windows are 0–255.** Bun 1.4.5 on Windows itself exits with the low byte of the entry's code (`process.exit(256)` gives 0), and the starters pass on what Bun exits with (executed, agent-bun-runtime CI 45589361806 and 45597390051). Keep an entry's codes within 0–255.
- **Entry arguments never begin with `-`.** `getty-bun.ps1` runs under `-File`, whose parameter binding may re-parse such an argument (PowerShell 7 splits `-x:foo`: a local run with pwsh 7 on Linux, not in CI; 5.1: not checked). The rule holds on both OS, so one entry call serves both.
- **Fast path.** No network, no hashing, and Bun is not started: the receipt's first three lines name the pinned version and the target, and `bin/bun` (`bin\bun.exe`) is a non-empty regular file (executable on POSIX). Only the install compares `bun --version` with the pin, before publishing (plan, scenario 6; `getty-bun.ps1` also after publishing, see the open difference below). A slot that does not match fails closed with a message naming its path and is never overwritten (scenario 6). A damaged but non-empty executable therefore passes the fast path, and `run` ends with what the OS makes of it, not a `getty-bun: ` line; removing the slot directory lets the next call install it again (`bootstrap/README.md`, "Limit: a damaged executable").
- **Open difference from "identical behavior" (card `agent-bun-runtime k19`).** After publishing and releasing the lock, `getty-bun.ps1` runs `bun --version` on the published `bun.exe` once more and exits 1 if it does not run; the slot stays published, so the next call takes the fast path and the failure shows only once. `getty-bun.sh` has no such probe (source-checked, `getty-bun.ps1:566-572`). agent-bun-runtime decides on `k19` whether to drop it or specify it for both starters.

Environment (contract tests):

| Variable | Effect |
| --- | --- |
| `GETTY_HOME` | Absolute root; overrides `~/.getty` (Windows: user profile plus `\.getty`; a drive-absolute or UNC path, UNC not checked). Set but not absolute is a starter failure. Tests always set it. |
| `GETTY_BUN_MIRROR` | Download base URL, `<base>/bun-v<version>/<archive>`. The pinned checksum still decides. Schemes are the downloader's: `getty-bun.sh` with curl (http, https, file) or wget (no file; that path not checked); `getty-bun.ps1` http, https, file. |
| `GETTY_BUN_LOCK_WAIT` | Bounded lock wait in whole seconds, default 300. Must stay below the host hook timeout, which the consumer sets above the wait plus one download (ADR 0007). |

## Canonical consumer requirement

Place this custom object in the consumer's real `package.json`:

```json
{
  "gettyBun": {
    "contractVersion": 1,
    "bunVersion": "1.4.5"
  }
}
```

The version is the pin of the agent-bun-runtime release you build against (`bootstrap/versions.json` at its tag; 1.4.5 for 0.1.0, confirmed by Getty on 2026-11-25); this example is no compatibility certification. Contract version 1 accepts only stable `major.minor.patch`, without a leading `v`, ranges, tags, prereleases, or build suffixes.

[The schema](../assets/requirement.schema.json) validates the `gettyBun` object, not the entire manifest. Bun does not enforce it, and the starter does not read it: the starter's rendered pin block is the only thing that selects a version. The consumer's CI validates the `gettyBun` object against the schema, which rejects any `contractVersion` other than 1 and a malformed `bunVersion`, and checks that the pin block equals `gettyBun.bunVersion`.

Keep ordinary requirements in `dependencies`/`devDependencies` and commit `bun.lock`; with a bundled entry they are build inputs resolved in CI, not on user machines. Do not infer the runtime pin from an arbitrary executable, `engines`, or a lockfile format. Optional toolchain metadata may mirror the exact pin but must not introduce a second runtime provisioner; see [prior-art.md](prior-art.md).

## Delivery of the starters

- **Pin block and render.** agent-bun-runtime `bootstrap/README.md` ("Pin block", "Render CLI") fixes both. The block is eight `#` lines, byte-identical in both starters: a `version` line, then one `target` line per MVP target with archive name, SHA256 and the one archive member.
- **Template `getty-bun-install`.** The release's `skills/getty-bun-install/` holds both starters as templates with the version table of that release embedded. A consumer installs it with skilletor from `Getty/agent-bun-runtime` at the release tag (`"ref": "v0.1.0"`, `"path": "skills"`) and sets `vars.bun_version`; a missing or unknown version fails the render. skilletor renders only into the skill's own directory, so the consumer **copies** the two rendered starters into its `bootstrap/` and commits them, because hosts install plugins by cloning.
- **CI check in the consumer.** The committed copies equal a fresh render, and the `# version` line equals `gettyBun.bunVersion` (the commands are in skill `getty-bun-install`, "Check the copy in CI").
- A new Bun version is a change in agent-bun-runtime (table plus tests; `bootstrap/README.md`, "Adding a version") and a release, then one `ref` and `vars.bun_version` bump per consumer.

## Shared immutable runtime slots

`runtimeRoot` is `<GETTY_HOME>/runtimes`, resolved once per user and execution environment ([paths-platforms.md](paths-platforms.md)).

| Item | Path relative to `runtimeRoot` |
| --- | --- |
| Runtime slot | `bun/<version>/<target>/` |
| Executable | `bun/<version>/<target>/bin/bun` or `bin/bun.exe` |
| Verified receipt | `bun/<version>/<target>/receipt.json` |
| Permanent mutex | `bun/.locks/<version>/<target>/.install.lock` |
| Attempt status | `bun/.locks/<version>/<target>/.installing` |
| Attempt stage | `bun/.staging/<unique-attempt-id>/` (same filesystem as the slots) |

The runtime key is the exact version plus a target from the reviewed table. MVP targets: `linux-x64`, `linux-x64-baseline`, `linux-aarch64`, `windows-x64`, `windows-x64-baseline`; musl, `windows-aarch64` and macOS come later as explicit entries. Validate targets against the table before using them as path components; never accept arbitrary path fragments.

All consumers in that environment requesting the same key reuse one slot. Different versions coexist. Published executables and receipts are immutable: publish once by one atomic rename of the whole staged slot, receipt included; never overwrite or repair in place. A version change installs a new key beside the old one on the first starter call after the consumer update.

Keep the store outside consumer caches and data that clients may erase on plugin upgrade/uninstall. Consumers must not delete shared runtimes on removal. Sharing is per user/execution environment, not across Windows, WSL, containers, remote hosts, or network-mounted homes.

## Integrity

The version table (`bootstrap/versions.json` in agent-bun-runtime) lists each approved version with the SHA256 of every supported target's archive and the name of the single expected member. Adding a version means verifying Bun's `SHASUMS256.txt` against its GPG signature `SHASUMS256.txt.asc` with the release key whose fingerprint `bootstrap/README.md` records (done for 1.4.5 with GnuPG 2.4.7 and `--assert-signer`), then running the phase 1 scenarios. The starter never downloads `SHASUMS256.txt` at install time and never trusts a checksum fetched next to the archive.

The starter verifies the archive hash before unpacking, accepts only an archive holding exactly the expected member plus its parent directories, extracts that member by name to `bin/bun` (`bin\bun.exe`), and requires `bun --version` to equal the pin before publishing (scenarios 4, 5, 6; `getty-bun.ps1` probes once more after publishing, card `agent-bun-runtime k19`). Then it writes `receipt.json` into the stage. Its form is fixed in `bootstrap/README.md` ("Slot and receipt"): ASCII, LF, two-space indentation, the keys `version`, `target`, `archiveSha256`, `contractVersion`, `archive`, `member`, `binarySha256`, `executable`, `verifiedAt` in that order. The starters read only its first three lines (`{`, version, target, compared as whole strings); they do not read `executable` but take `bin/bun` (`bin\bun.exe`) in the slot. `executable`, the hashes and the timestamp are diagnostics for other readers, which parse the receipt as JSON and ignore unknown keys. A receipt records a verified operation; it does not prove that today's file is intact.

## Consumer binding

**Bundled entry (normal case):** the entry bundles `@getty/agent-bun-runtime`; no consumer lock and no machine-local binding (ADR 0003); `run` needs only the runtime slot. The committed pin block takes the binding's place: every starter call derives the slot from it, and the committed bundle is the only code that runs. A moved or updated plugin needs no rebind.

**Later/optional (plan phase 5, for a consumer that cannot bundle):** a frozen-lockfile dependency install on the user machine under a consumer lock, with a machine-local binding: consumer/content identity, package root, manifest and lockfile digests, runtime key, resolved absolute executable, receipt identity, dependency and smoke-test result. Publish it only after runtime and dependencies pass; reject a mismatch at execution instead of selecting another Bun. The runtime-key mutex does not protect a separate `node_modules` tree. See [dependencies-and-execution.md](dependencies-and-execution.md).

## Portability boundary

Distribute the same bundled TS/JS entry across supported targets without compiling a custom executable per OS. A compatible Bun binary from the table and the matching starter are still required. Shell commands, filesystem conventions, native add-ons (which rule out bundling), and host APIs remain platform-sensitive. Verify these boundaries rather than promising universal execution from a file extension.
