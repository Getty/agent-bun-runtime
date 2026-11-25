<!-- ack: shape=project manager=none board=karr committer=release-manager outside_input=on headless=off -->
# getty-bun: project rules

## Lanes

| Work | Agent |
|---|---|
| Read code, docs and history, explain relationships | `getty-bun-scout` |
| `bootstrap/`, `src/`, `package.json`, `bun.lock`, CI workflows | `getty-bun-worker` |
| Tests (`test/`, `bootstrap/test/`) and fixtures | `getty-bun-test-writer` |
| Review completed work and run checks independently | `getty-bun-reviewer` |
| Authorized commits, `Changes`, release checks | `getty-bun-release-manager` |

The version table, manifests and CI workflows are behavior: changes belong to the worker,
even when they are JSON or YAML. The main session owns coordination, plain prose
documentation (`docs/`) and team configuration.

## Checks and commits

The checks are listed in `getty-bun-core`. The release manager alone makes authorized
commits and closes their cards; leave other sessions' working-tree changes untouched.

## Board

The board lives in `refs/karr/*`; `karr list --compact` shows open work. There is no
remote yet; once there is one, karr mutations synchronize with `origin`: obtain
authorization for that exchange before the first write.

## With superpowers

Work in the existing checkout; use isolation only when explicitly chosen.
Code tasks go to the worker/test-writer, then the reviewer checks the uncommitted
diff; the release manager makes an authorized commit afterwards.

## Hazards

- A test that installs Bun uses a temporary `HOME`; never the user's `~/.getty`.
- Killing or lock tests use fixture processes only, never an unrelated user process.
- Downloads in tests hit the real release URL only in the dedicated installer job; unit
  tests use a local fixture archive.
- Publishing to npm or creating the GitHub repository needs the owner's go.
