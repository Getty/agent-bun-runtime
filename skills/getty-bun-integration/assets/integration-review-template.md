# Getty Bun integration review

Contract version 1 (`gettyBun.contractVersion`), agent-bun-runtime release: ____.

## Subject and status

- Consumer and revision:
- agent-bun-runtime release (skilletor `ref`, `@getty/agent-bun-runtime` version), or missing component:
- Exact Bun requirement (`gettyBun.bunVersion`, `vars.bun_version`) and contract version:
- Reviewed targets and table checksums:
- Agent client version, surface, and distribution route:
- Status: proposed / implemented / source-checked / executed on listed targets:

## Decisions and evidence

| Requirement | Implementation location | Evidence/result |
| --- | --- | --- |
| Canonical `gettyBun` pin in real package.json; CI validates it against the schema | | |
| `getty-bun.sh` and `getty-bun.ps1` (and `getty-bun.cmd` where Claude Code serves Windows) copied from the rendered `getty-bun-install` and committed under `bootstrap/` with `text eol=lf`; CI: pin block equals package.json, a fresh render equals the committed copies, the `.cmd` included | | |
| `gettyBun.platforms` declared where the consumer does not run everywhere; `vars.bun_platforms` in the same order; CI: the `# platforms` line equals `gettyBun.platforms`, absent when undeclared | | |
| `@getty/agent-bun-runtime` from npm at the release's exact version, bundled; entry ends with `process.exit(await main(...))`; host passed by entry or argument, not detected | | |
| Bundled entry committed (`bun build --target=bun`); CI rebuild byte-identical; no external packages | | |
| `onFailure` chosen per entry (`"closed"` only for guards on entries serving nothing but `PreToolUse`/`UserPromptSubmit`; `"open"` on any entry that serves `Stop`, `SubagentStop` or another event; `"silent"` only for a guard that must stay invisible on broken input); `maxInputBytes` fits the largest expected payload | | |
| Effects per event within what the codec delivers; handler never writes stdout | | |
| Bun child processes started with `--no-install --config=<empty file> --no-env-file`, `BUN_OPTIONS` and the other variables the starters remove (contract, "Bun without the project") removed | | |
| Hooks call the starter's `run`; only `run`, `run-ready`, `ensure`, `status` used | | |
| Hot hooks (short timeout, must not wait for an install) use `run-ready`, paired with a `SessionStart` hook that installs (`run` or `ensure`, timeout 600) | | |
| MCP server through the starter (long-lived stdio server): `SessionStart` command hook `ensure` with timeout 600; stdout carries only the protocol; not through the `.cmd` (no shell form) | | |
| Codex `command` and `commandWindows` in a hook file of its own, named by the Codex manifest; `"${PLUGIN_ROOT}"` quoted | | |
| Claude Code hooks in `hooks/hooks.json`; to serve Windows, shell form dot-sourcing the committed `bootstrap/getty-bun.cmd` with `; exit $LASTEXITCODE` (ADR 0010, `getty-bun-install` section 3); arguments only words that mean the same to `sh` and PowerShell | | |
| Hook timeouts set explicitly, above the lock wait plus one download; no starter call on `SessionEnd` or Codex `Interrupt` | | |
| First hook installs without external Bun/Node; concurrent hooks wait | | |
| Shared slot under `<GETTY_HOME>` per version/target/environment | | |
| Starter stdout clean, stderr messages; never exits 2 for its own failures; the entry's exit code passes through unchanged | | |
| Entry exit codes within 0–255; no lone `--` as an entry's first argument, no empty `''` argument through the `.cmd` (other `-` arguments pass unchanged from 0.2.0) | | |
| Windows: PowerShell 5.1 and 7, Process byte copy, Git Bash forwarding | | |
| Setup skill for repair and diagnosis | | |
| Side-by-side update; rollback by previous plugin release | | |
| Shared runtime survives consumer removal | | |
| Host review/activation observed (Codex re-review after changed bundled script) | | |
| Dependency install, consumer lock, binding (later, phase 5 only) | | |

## Checks performed

Record the concrete command or scenario, environment, observed result, and limits. Label each: documented, source-checked, schema-checked, scenario-reviewed, executed, measured by windows-developer, or not checked. Cite the gates of the agent-bun-runtime release (CI run and commit) for the starters and the SDK instead of re-testing locking; they cover CI runners and recorded payloads, not the host. Do not mark unexecuted platform cases as passed.

## Remaining gaps

Identify missing provider behavior, unsupported targets, untested host behavior, or required native review. State the practical next step without implying an unimplemented command exists.

## Sources

List primary documentation and inspected revisions supporting external facts. Mark Getty-specific layout, fields, and lifecycle rules as design decisions (agent-bun-runtime plan and ADRs).
