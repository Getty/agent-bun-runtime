# 0001: One repository, two products; bootstrap delivered as a template

Status: accepted, 2026-11-25 (owner: provider is a template, not a CLI).

## Context

Every consumer must know how to install its exact Bun before Bun exists, and consumers
will pin different versions over time. A separate provider CLI would be one more thing
to install first. A skill directory in Getty/skills has no CI.

## Decision

- `getty-bun` holds the bootstrap (`bootstrap/`: both starters, the version table, the
  pin render) and the SDK `@getty/bun-runtime` (repository root).
- The bootstrap is delivered as the skilletor template `getty-bun-install` in Getty/skills,
  next to `getty-bun-integration`. A consumer sets `vars.bun_version`; the template holds
  the reviewed table and renders one pin block (version plus SHA256 per target) into
  both starters. An unknown version fails the render: skilletor treats printing an
  undefined variable as an error.
- The rendered starters are committed into the consumer, because hosts install plugins
  by cloning. The consumer's CI checks that the pin block matches its
  `package.json` `gettyBun.bunVersion`.

## Consequences

- skilletor installs into `.claude/skills` or `.agents/skills`, not into a plugin's own
  tree. Until skilletor on Bun has that render target (phase 3b), the rendered starters
  are copied by hand and the consumer's CI compares them with a fresh render.
- Publishing a new Bun version is a change in getty-bun (table plus tests), then a
  template update in Getty/skills, then one `vars.bun_version` bump per consumer.
