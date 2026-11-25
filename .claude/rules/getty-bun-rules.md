<!-- ack: shape=project manager=none board=karr committer=release-manager outside_input=on headless=off -->
# getty-bun: project rules

## Lanes

| Work | Agent |
|---|---|
| Read code, docs and history, explain relationships | `getty-bun-scout` |
| `bootstrap/getty-bun.sh`, `bootstrap/versions.json`, pin render | `getty-bun-posix-worker` |
| `bootstrap/getty-bun.ps1`, Git Bash forwarding | `getty-bun-windows-worker` |
| `src/` core, `package.json`, `bun.lock` | `getty-bun-sdk-worker` |
| Codex codec and real Codex probes | `getty-bun-codex-worker` |
| Claude Code codec and real Claude Code probes (phase 3b) | `getty-bun-claude-worker` |
| `.github/` workflows | `getty-bun-ci-worker` |
| `bootstrap/test/`: the shared scenario suite | `getty-bun-bootstrap-test-writer` |
| `test/`: SDK and codec tests | `getty-bun-sdk-test-writer` |
| Review against task, phase gate, ADRs and contract; run checks | `getty-bun-reviewer` |
| Review for native Windows | `getty-bun-windows-reviewer` |
| Authorized commits, `Changes`, release checks | `getty-bun-release-manager` |

A Hermes codec worker joins in phase 5. The version table, the pin block format,
manifests and CI workflows are behavior: changes belong to their worker, even when they
are JSON or YAML. A change to the pin block format touches both starters: the posix
worker defines it, the windows worker follows in the same task. Bootstrap changes get
both reviewers. The main session owns coordination, plain prose documentation
(`docs/`) and team configuration.

## Checks and commits

The checks are listed in `getty-bun-core`. The release manager alone makes authorized
commits and closes their cards; leave other sessions' working-tree changes untouched.

## Board

The board lives in `refs/karr/*`; `karr list --compact` shows open work. karr
mutations synchronize with `origin` (`Getty/getty-bun`); that exchange is authorized for
the session the hub starts here.

## With superpowers

Work in the existing checkout; use isolation only when explicitly chosen.
Code tasks go to the worker/test-writer, then the reviewer checks the uncommitted
diff; the release manager makes an authorized commit afterwards.

## Hazards

- A test that installs Bun uses a temporary `HOME`; never the user's `~/.getty`.
- Killing or lock tests use fixture processes only, never an unrelated user process.
- Downloads in tests hit the real release URL only in the dedicated installer job; unit
  tests use a local fixture archive.
- Publishing to npm needs the owner's go. Pushing work branches to `origin` for CI is
  allowed; `main` gets reviewed work only.
- Real-host Windows checks (Codex or Claude Code on Windows) go as cards to the
  windows-developer board, through the hub.
