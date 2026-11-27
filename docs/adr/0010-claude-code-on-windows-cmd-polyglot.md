# 0010: Claude Code on Windows through a `.cmd` polyglot

Status: accepted, 2026-11-27 (owner, option (b) of question F2 in the skilletor plan,
relayed by hub `agent-developer`, hub card `agent-developer k14`); closes the open
decision "Claude Code on Windows" in `docs/plan.md`.

## Context

Claude Code's `hooks.json` has no per-OS field, so one hook entry must start on Linux,
macOS and Windows alike (`docs/plan.md`, "Open decisions", as it stood at 0.1.0). Of the
entries windows-developer measured that start on both sides from one `hooks.json`
(`docs/hook-start-windows.md` there, Claude Code 2.1.287), two remained without Git Bash:

- (a) the exec form on an extensionless path with a native `.exe` beside it (probe y1);
  a shim that starts Bun itself would be a third reader of the pin block beside the two
  starters, built natively per architecture;
- (b) a dot-sourced `.cmd` polyglot in shell form (probe q6), which pays one PowerShell
  start per hook on Windows (about 720 ms on a desktop; 0.35–0.52 s over Bun on the CI
  runner, [hook-cost.md](../hook-cost.md)).

The consumers asking (skilletor, F2; loadguard and agent-irc defer to it) need a way that
needs no Node on Windows.

## Decision

- agent-bun-runtime ships a third bootstrap file, `bootstrap/getty-bun.cmd`, delivered
  through the template `getty-bun-install` beside the two starters. It is a polyglot: as
  POSIX shell code (dot-sourced by the hook's shell on Linux, macOS and under Git Bash) it
  hands every call to the `getty-bun.sh` next to it; as a batch file (run by `cmd.exe`
  when PowerShell or `cmd` dot-sources or calls it) it runs `getty-bun.ps1` next to it
  under `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`,
  arguments unchanged, and exits with its exit code.
- The polyglot holds no pin and selects no version: the starters stay the only readers
  of the pin block. No native shim.
- A Claude Code hook that must run on Windows uses shell form and dot-sources the
  polyglot; the exact line, its quoting and its measured shells are fixed in the
  delivering task and documented in `getty-bun-install` and `claude-code.md`.
- The polyglot is checked in this repository's CI: on the Linux and macOS legs through
  `sh`, `bash` and the other shells the suite names, on the Windows legs through
  PowerShell 5.1, PowerShell 7 and Git Bash.
- The cost on a real Windows desktop is measured by the windows-developer hub on a card
  there (prepared in the 0.2.0 report); it is not a gate of 0.2.0.

## Consequences

- A Claude Code hook on Windows costs one PowerShell start more than the Codex
  `commandWindows` path (which calls `powershell.exe -File` directly).
- Plugins that serve Claude Code on Windows commit three bootstrap files; the drift check
  compares all three with the render.
- Plugins that serve Claude Code only on Linux and macOS may keep the `sh` lines of 0.1.0.
- dash (`/bin/sh` on Debian and Ubuntu) ignores the arguments of `. file args` (dash
  0.5.12, run by the windows worker). The polyglot then reads its shell's command line from
  `/proc/$$/cmdline` and runs the same line once more under `bash`; this needs `/proc`,
  `bash` and the polyglot call first in the hook line, and fails with one `getty-bun: `
  line otherwise. This workaround is the main session's choice for 0.2.0 (2026-11-27), not
  the owner's; the alternative is a Linux/macOS-only exec-form line (`sh .../getty-bun.sh`)
  for plugins that do not serve Claude Code on Windows.
- The hook line ends in `; exit $LASTEXITCODE`: PowerShell `-Command` turns every non-zero
  exit of a native program into 1 otherwise (pwsh 7.7 on Linux, run by the windows worker);
  POSIX shells never reach the tail.
- MCP servers have no shell form; the polyglot does not start them (agent-irc G4: Windows
  stays off for MCP servers; a Windows MCP launcher and the job object are later, `k13`).
