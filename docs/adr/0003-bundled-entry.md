# 0003: Consumers ship a bundled entry

Status: accepted, 2026-11-25 (phase 0 call; reversible per consumer).

## Context

The handoff provisions consumer dependencies on the user machine:
`bun install --frozen-lockfile` from the shipped `bun.lock`, under a consumer lock, then
a binding. That is a second download path (the npm registry), a second lock, and a
binding store, before the first hook can run. The owner asked for the smallest
version that works, as safe as possible.

## Decision

- A consumer commits the output of `bun build --target=bun` (its entry plus
  `@getty/bun-runtime` and any pure-JS dependency) and runs it through the starter.
- The consumer's CI rebuilds with the pinned Bun and compares byte for byte.
- User machines download exactly one artifact, the pinned Bun, verified against the
  reviewed table. No registry access at hook time.

## Consequences

- No consumer lock and no binding in the MVP; `run` needs only the runtime slot.
- A consumer that needs native addons or runtime-resolved packages cannot bundle; the
  handoff's dependency install comes back in phase 5 for that consumer.
- `@getty/bun-runtime` must stay bundle-friendly: ESM, no dynamic requires, no
  filesystem lookups of its own package files.
