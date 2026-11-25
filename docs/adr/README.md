# Architecture decisions

One file per decision. Status is `accepted` (owner decision or phase 0 call) or
`proposed` (waits for the owner). A later ADR supersedes an earlier one; nothing is
edited in place except the status line.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-layout-and-delivery.md) | One repository, two products; bootstrap delivered as a skilletor template | accepted |
| [0002](0002-install-on-demand.md) | The starter installs on demand under the OS lock; the SDK never installs | accepted |
| [0003](0003-bundled-entry.md) | Consumers ship a bundled entry; no `bun install` on user machines | accepted |
| [0004](0004-one-starter-per-os.md) | POSIX `sh` and PowerShell starters, Windows from phase 1 | accepted |
| [0005](0005-bun-pin-and-version-table.md) | Version table, signature check, MVP targets, pin 1.4.5 candidate | accepted |
| [0006](0006-npm-distribution.md) | `@getty/bun-runtime` on npm, public, Artistic-2.0, trusted publishing | accepted |
