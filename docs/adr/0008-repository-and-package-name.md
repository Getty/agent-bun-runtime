# 0008: Repository and package name

Status: accepted, 2026-11-25 (owner; requested through hub `perl-developer`, confirmed in
hub `agent-developer`); supersedes the repository name in
[0001](0001-layout-and-delivery.md) and the package name in
[0006](0006-npm-distribution.md); the git-commit pin before the first release superseded by
[0009](0009-first-release-claude-code-and-consumer-skills.md).

## Context

One short name stood for three things: the repository (`Getty/getty-bun`, checked out at
`~/dev/getty-bun`), the runtime with its starters and store, and, through ADR 0006, the
SDK package `@getty/bun-runtime`. The package has never been published. The owner renamed
the GitHub repository on 2026-11-25 (`gh repo rename`); GitHub redirects the old URL.

## Decision

- Repository `Getty/agent-bun-runtime`, checked out at `~/dev/agent-bun-runtime`.
- npm package `@getty/agent-bun-runtime`, not published yet. The scope `getty` belongs
  to the owner (ADR 0006). The rest of 0006 stands: public, Artistic-2.0, the first
  release by hand, then trusted publishing from GitHub Actions of
  `Getty/agent-bun-runtime`; until then consumers pin a git commit of
  `Getty/agent-bun-runtime`.
- `getty-bun` stays the short name of the runtime: the starters `getty-bun.sh` and
  `getty-bun.ps1` (with their `getty-bun: ` error lines and pin block markers),
  `GETTY_HOME`, the `GETTY_BUN_*` variables, the store `~/.getty/runtimes/bun`, the
  roles `getty-bun-*`, the project skills `getty-bun-*`, the contract skill
  `getty-bun-integration` and the template `getty-bun-install`.
- Earlier ADRs keep their text. In them, `getty-bun` as the repository,
  `Getty/getty-bun` and `@getty/bun-runtime` are read as the names above. Only the
  status lines of 0001 (repository) and 0006 (package) change.

## Consequences

- Documents that record history keep the old names: `docs/handoff/`, `Changes` entries
  under a version line, and the briefs and reports of hub `agent-developer`.
- Cards on this repository's board are referenced as `agent-bun-runtime k13`, not
  `getty-bun k13`.
- The contract skill `getty-bun-integration` and the hub register in Getty/skills name
  the repository and the package by the new names.
- Whether `@getty/agent-bun-runtime` is free on the registry was not looked up (not
  checked); only members of the org `getty` can publish in its scope (derived).
