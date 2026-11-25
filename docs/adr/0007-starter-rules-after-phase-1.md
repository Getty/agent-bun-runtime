# 0007: Starter rules after phase 1

Status: accepted, 2026-11-25 (owner, on the proposal of hub `agent-developer` after the
review of the phase 1 plan update); supersedes the exit-code and hook-timeout parts of
[0002](0002-install-on-demand.md).

## Context

ADR 0002 says that hooks waiting on the install lock "never exit with 2" and that
consumers "set their hook timeout above the lock wait". Phase 1 (merged into `main` at
`262bc95`) and the review of contract v0.2 showed both to be too coarse:

- Read literally, "never exit with 2" also forbids passing on an entry that exits with
  2. Some hosts read 2 as a block, and whether to block is the entry's decision, not the
  starter's.
- A waiter that gets the lock after a holder crashed finds no slot and downloads
  itself, so its hook can last the lock wait plus one download.

## Decision

- The starters never exit with 2 for their own failures: they print one `getty-bun: `
  line on stderr and exit 1.
- `run` passes the entry's exit code through unchanged, 2 included (scenario 8 in
  `bootstrap/test/scenarios.test.ts`, codes 0, 1, 2, 7 and 42, executed on all four
  scenario legs, CI 45603412444). On Windows that code is 0 to 255: Bun 1.4.5 itself
  exits with the low byte of the entry's code (executed, CI 45589361806).
- The lock wait stays below the host hook timeout, and consumers set the hook timeout
  above the lock wait plus one download.

This replaces "They never exit with 2." in the second decision of 0002 and "Consumers set
their hook timeout above the lock wait." in its first consequence. The rest of 0002
stands.

## Consequences

- `docs/plan.md` ("Starter interface"), the skill `getty-bun-bootstrap` and contract v0.2
  in `getty-bun-integration` carry these rules.
- A consumer's hook timeout depends on how long one download takes on the user's link;
  the lock wait (default 300 s, `GETTY_BUN_LOCK_WAIT`) alone is not enough.
