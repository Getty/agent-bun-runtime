# getty-bun

Getty's Bun runtime for agent plugins: the bootstrap that installs an exact, verified Bun
per user (`bootstrap/`) and the SDK `@getty/bun-runtime` that plugins run on. Every Getty
plugin for Claude Code, Codex and Hermes ends up here: starter, our Bun, TypeScript.
Coordinated from the hub `~/dev/agent-developer`.

## Repository language

Write repository content in **English**.

## Before working

- **Plan and phase gates:** [docs/plan.md](docs/plan.md). It adapts
  [the handoff](docs/handoff/2026-11-25-bun-runtime-handoff.md); where they disagree, the
  plan wins.
- **Decisions:** [docs/adr/](docs/adr/).
- **Invariants, layout, checks:** skills [getty-bun-core](.claude/skills/getty-bun-core/SKILL.md),
  [getty-bun-bootstrap](.claude/skills/getty-bun-bootstrap/SKILL.md),
  [getty-bun-windows](.claude/skills/getty-bun-windows/SKILL.md).
- **Ownership and verification:** [.claude/rules/getty-bun-rules.md](.claude/rules/getty-bun-rules.md).
- **Runtime contract:** skill `getty-bun-integration` (contract proposal v0.2).

## The agent team

- `getty-bun-scout`: reads and reports; changes nothing.
- `getty-bun-posix-worker`, `getty-bun-windows-worker`: the two starters.
- `getty-bun-sdk-worker`, `getty-bun-codex-worker`, `getty-bun-claude-worker`: the SDK
  core and its host codecs.
- `getty-bun-ci-worker`: GitHub Actions.
- `getty-bun-bootstrap-test-writer`, `getty-bun-sdk-test-writer`: tests only.
- `getty-bun-reviewer`, `getty-bun-windows-reviewer`: review and checks; change nothing.
- `getty-bun-release-manager`: owns authorized commits, `Changes` and release checks.

Lanes: [.claude/rules/getty-bun-rules.md](.claude/rules/getty-bun-rules.md).

Work belongs on the karr board (`karr list --compact`). Newly created agents may require a
fresh Claude Code session.

## Shared rules and skills

`.claude/skilletor.json` declares sources and the `getty-house` bundle.
`skilletor sync --scope project` installs shared files; edit managed copies at their
source. Project agents, the three `getty-bun-*` skills, settings and skilletor
configuration are tracked; installed rules/skills, the lock and local settings are not.

## Rules

- Nothing is tagged or published (npm included) without explicit authorization. Pushing
  work branches for CI is authorized; `main` gets reviewed work only.
- Never touch the real `~/.getty` in a test: set `GETTY_HOME` (and `HOME`, `CODEX_HOME`
  for host runs) to a temporary directory.
