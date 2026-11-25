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
- **Invariants, layout, checks:** skill [getty-bun-core](.claude/skills/getty-bun-core/SKILL.md).
- **Ownership and verification:** [.claude/rules/getty-bun-rules.md](.claude/rules/getty-bun-rules.md).
- **Runtime contract:** skill `getty-bun-integration` (contract proposal v0.1; v0.2 is
  phase 0 work).

## The agent team

- `getty-bun-scout`: reads and reports; changes nothing.
- `getty-bun-worker`: bootstrap scripts, SDK source, manifests; never commits.
- `getty-bun-test-writer`: writes tests; leaves implementation to the worker.
- `getty-bun-reviewer`: reviews changes and runs checks; changes no files.
- `getty-bun-release-manager`: owns authorized commits, `Changes` and release checks.

Work belongs on the karr board (`karr list --compact`). Newly created agents may require a
fresh Claude Code session.

## Shared rules and skills

`.claude/skilletor.json` declares sources and the `getty-house` bundle.
`skilletor sync --scope project` installs shared files; edit managed copies at their
source. Project agents, `getty-bun-core`, settings and skilletor configuration are
tracked; installed rules/skills, the lock and local settings are not.

## Rules

- Nothing is pushed, tagged or published (npm included) without explicit authorization.
- Never touch the real `~/.getty/runtimes` in a test: use an isolated `HOME`.
