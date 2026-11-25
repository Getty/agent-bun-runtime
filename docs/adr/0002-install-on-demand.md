# 0002: The starter installs on demand; the SDK never installs

Status: accepted, 2026-11-25 (owner: install on plugin install or update, waiting system).

## Context

Contract v0.1 had hooks only point the agent at a setup skill. The owner wants Bun
installed when a plugin is installed or updated, and everything that needs it to wait
until then. Neither Codex nor Claude Code has an install hook.

## Decision

- Every starter call (`run`, `ensure`) first ensures the pinned Bun: present and
  matching means a fast local check; missing means install under the OS lock.
- After an install or update the first hook, normally `SessionStart`, therefore
  installs. Concurrent hooks block on the same lock, bounded (default 300 s), and then
  either run or fail with one clear stderr line. They never exit with 2.
- `@getty/bun-runtime` never installs, downloads, or edits lockfiles, not even in a
  diagnostic command.
- The setup skill stays as the repair and diagnosis path; it is no longer the install
  path.

## Consequences

- The first hook after an update can take as long as one download. Consumers set their
  hook timeout above the lock wait.
- Contract v0.2 in `getty-bun-integration` replaces the hint-only rule.
