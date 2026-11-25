# 0004: One starter per OS, Windows from phase 1

Status: accepted, 2026-11-25 (owner: plan Windows in from the start).

## Context

The windows-developer hub measured how hosts start hooks on Windows (Claude Code
2.1.287; `~/dev/windows-developer/docs/hook-start-windows.md` and
`starter-konvention.md`). The target is Windows **without** Git Bash. Codex offers
`commandWindows`; how Codex runs it on Windows is not measured.

## Decision

- `getty-bun.sh` (POSIX `sh`) for Linux, later macOS; `getty-bun.ps1` for Windows. It
  must run on Windows PowerShell 5.1 (always present) and on PowerShell 7.
- Under Git Bash, MSYS or Cygwin, `getty-bun.sh` forwards to `getty-bun.ps1` and does
  no locking or download of its own. A slot has exactly one lock implementation.
- WSL is Linux with its own store under the WSL home; never a Windows `bun.exe`.
- Lock on Windows: `.NET File.Open` with `FileShare.None` on the lock file, retained for
  the whole critical section (as in the contract). Not a named mutex: `Local\` is per
  logon session, and the lock must belong to the store path.
- The PowerShell starter runs Bun through `System.Diagnostics.Process` with raw byte
  copies of stdin and stdout, never through `&`: Windows PowerShell 5.1 did not pass the
  end of stdin to a native program (measured by windows-developer, probe y4).
- Both starters run one shared `bun:test` scenario suite; CI covers `ubuntu-latest`,
  `ubuntu-24.04-arm`, `windows-latest` with `powershell` and `pwsh`.

## Consequences

- Each Windows hook pays a PowerShell start (~720 ms measured by windows-developer) plus
  Bun's start. Acceptable for Codex `SessionStart` and `SubagentStart`; phase 1 measures
  it, and the Claude Code adapter on Windows is decided with that number (plan, open
  decisions).
- A Group Policy execution policy overrides `-ExecutionPolicy Bypass`; the starter then
  cannot run, and the consumer's doctor must say so.
- Real-host checks on Windows go as cards to the windows-developer board.
