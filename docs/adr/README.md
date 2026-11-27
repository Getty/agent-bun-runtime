# Architecture decisions

One file per decision. Status is `accepted` (owner decision or phase 0 call) or
`proposed` (waits for the owner). A later ADR supersedes an earlier one; nothing is
edited in place except the status line.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-layout-and-delivery.md) | One repository, two products; bootstrap delivered as a skilletor template | accepted, repository name superseded by 0008 |
| [0002](0002-install-on-demand.md) | The starter installs on demand under the OS lock; the SDK never installs | accepted, partly superseded by 0007 |
| [0003](0003-bundled-entry.md) | Consumers ship a bundled entry; no `bun install` on user machines | accepted |
| [0004](0004-one-starter-per-os.md) | POSIX `sh` and PowerShell starters, Windows from phase 1 | accepted |
| [0005](0005-bun-pin-and-version-table.md) | Version table, signature check, MVP targets, pin 1.4.5 (confirmed 2026-11-25) | accepted |
| [0006](0006-npm-distribution.md) | The SDK package on npm, public, Artistic-2.0, trusted publishing | accepted, package name superseded by 0008, git-commit pin superseded by 0009 |
| [0007](0007-starter-rules-after-phase-1.md) | Never 2 for the starter's own failures, the entry's code passes through; hook timeout above the lock wait plus one download | accepted |
| [0008](0008-repository-and-package-name.md) | Repository `Getty/agent-bun-runtime`, package `@getty/agent-bun-runtime`; `getty-bun` stays the runtime's short name | accepted, git-commit pin superseded by 0009 |
| [0009](0009-first-release-claude-code-and-consumer-skills.md) | 0.1.0 carries the Claude Code codec and the consumer skills; consumers take npm; the public interface of 0.1.0 | accepted |
| [0010](0010-claude-code-on-windows-cmd-polyglot.md) | Claude Code on Windows through a dot-sourced `.cmd` polyglot that runs `getty-bun.ps1`; no native shim | accepted |
| [0011](0011-release-0.2.0-interface.md) | 0.2.0: slot-first target, transpiler cache `0`, `run-ready`, resumable download, `-` arguments on Windows, macOS, `gettyBun.platforms`, `onFailure: "silent"`, the long-lived stdio server entry | accepted |
