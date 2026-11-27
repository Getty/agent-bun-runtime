---
name: getty-bun-windows
description: Use when writing, testing or reviewing bootstrap/getty-bun.ps1 or anything getty-bun does on native Windows - PowerShell 5.1 compatibility, stdin and stdout passthrough, locking, download, unzip, paths, Git Bash forwarding.
---

# getty-bun on Windows

Target: native Windows **without** Git Bash. **Measured**: the windows-developer hub
(`~/dev/windows-developer/docs/hook-start-windows.md`, `starter-konvention.md`,
`umgebung.md`; Claude Code 2.1.287, Windows 11 25H2, PowerShell 5.1.26100).
**Documented**, **source-checked**: host docs and source, mostly read by the hub finding
`docs/windows-referenzen.md` in `agent-developer` (commits pinned there); for our own
code, `getty-bun.ps1` at `8fc6133` with its line. **Executed**: "scenario N" is that
scenario of `bootstrap/test/scenarios.test.ts`, run on the 5.1 and 7 legs of CI
45603412444; other CI runs are named. All other evidence, unchecked parts included, is in
[bootstrap/README.md](../../../bootstrap/README.md), "Windows starter". Anything else is
a rule or open.

## Language level

`getty-bun.ps1` must run on **Windows PowerShell 5.1** (always present; `pwsh` is often
missing, measured) and on PowerShell 7. Not in 5.1: `??`, `?.`, the ternary operator,
`&&` and `||` between commands, `ForEach-Object -Parallel`, `$IsWindows`,
`ProcessStartInfo.ArgumentList`, `Join-Path` with more than one child. Keep the file pure
ASCII: 5.1 reads a file without BOM in the ANSI code page. Start with
`$ErrorActionPreference = 'Stop'`.

## Invocation

```
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<root>\bootstrap\getty-bun.ps1" run <entry> [args]
```

- Measured (probe x9): Claude Code's exec form with `powershell -NoProfile
  -ExecutionPolicy Bypass -File ...` starts; a PowerShell start costs about 720 ms.
- Documented for 5.1 and 7
  ([about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)):
  an execution policy set by Group Policy takes precedence over `-ExecutionPolicy
  Bypass`. If it turns scripts off or is `AllSigned`, the unsigned starter cannot run
  (derived, not measured), which the consumer's doctor must report.
- Claude Code, exec form since 2.1.139 (source-checked, `anthropics/claude-code`
  `4cc5e8b`, `CHANGELOG.md`): `"command": "powershell.exe"` and the flags, the starter
  path and `run <entry>` in `args`, spawned without a shell: no quoting, and `"shell"`
  is ignored (documented, hooks reference, which shows this call as its Windows example).
  It serves Windows only and `hooks.json` has no per-OS field, so a Claude Code plugin
  for Windows uses the `.cmd` polyglot in shell form instead (ADR 0010).
- Codex: `commandWindows` carries the line with the path in double quotes,
  `"${PLUGIN_ROOT}\bootstrap\getty-bun.ps1"`: Codex substitutes `${PLUGIN_ROOT}`
  textually, unquoted, and runs the line in the session shell, by default PowerShell
  (`pwsh`, else `powershell.exe`) as `-NoProfile -Command`, otherwise `cmd /C`; no exec
  form (source-checked, openai/codex `3f65e9f`). Keep the line valid in PowerShell and
  `cmd` alike. Which shell a real desktop uses: a windows-developer card in phase 3a.
- `CLAUDE_ENV_FILE` does not apply to hooks that run in PowerShell (documented, hooks
  reference): set no environment variables through `SessionStart`.
- Entry arguments may start with `-` from 0.2.0: the starter reads
  `[Environment]::GetCommandLineArgs()` after the host's `-File`, not `$args`, which
  `-File`'s parameter binding re-parses (k51; README, Windows starter, entry arguments).
  Not fixable in the script: `-File` can fail before the script runs (exit 1) on a lone
  `-` (5.1 direct, last or followed by another argument; pwsh 7 direct passes both) and
  on `-:…` (pwsh 7 direct; 5.1 direct passes it): executed, CI 46035250753. `- x` fails
  through the forwarding and the polyglot too (same run); a lone last `-` and `-:foo`
  through either: not checked. The polyglot from a PowerShell hook shell loses `'--%'`
  and splits `'-Command x'` (CI 46031834399 and 46035250753; any other `-` argument with
  a blank: derived). README, Windows starter, entry arguments.

## stdin, stdout, exit code

- **Never run Bun with `&`.** Measured (probe y4): PowerShell 5.1 does not pass the end
  of stdin to a native program; the hook hangs until its timeout and the process stays
  behind. PowerShell's pipeline also re-encodes text.
- Use `System.Diagnostics.Process`: `UseShellExecute = $false`,
  `RedirectStandardInput` and `RedirectStandardOutput` true, stderr inherited. Copy
  `[Console]::OpenStandardInput()` to the child's stdin as raw bytes and close it; copy
  the child's `StandardOutput.BaseStream` to `[Console]::OpenStandardOutput()` as raw
  bytes, both asynchronously (`CopyToAsync`) so neither side blocks. Exit with the
  child's `ExitCode`. Executed: scenario 8.
- End when Bun ends, even if the host keeps stdin open: wait for the child and its
  stdout, abandon the stdin copy (executed: scenario 8b).
- `CreateNoWindow = $true`, so no console window opens for a hook (source-checked,
  `getty-bun.ps1:501`, `:758`; claude-mem #2869, #3170). Its limit: Ctrl+C in the
  host's console does not reach Bun, and Bun survives a kill of `powershell.exe` (not
  checked; `k13`).
- Exit codes: an entry's code on Windows is 0-255, since Bun 1.4.5 exits with the low
  byte itself (executed, CI 45589361806; README, "Limit: exit codes through Git Bash").
  The starter never exits 2 for its own failures; the entry's code passes through, 2
  included (ADR 0007).
- 5.1 has only the `Arguments` string: quote every argument by the
  `CommandLineToArgvW` rules (spaces, embedded quotes, trailing backslashes). Executed:
  scenario 8.
- Measured: hosts send UTF-8 JSON on stdin with backslash paths inside, and pass stdout
  through unchanged. The starter's own messages go to stderr as UTF-8 bytes
  (`[Console]::OpenStandardError()`).

## Download, hash, unzip

- Source: the GitHub release zips, `<base>/bun-v<version>/bun-windows-x64.zip` and
  `-baseline.zip` (`<base>` is `GETTY_BUN_MIRROR` or
  `https://github.com/oven-sh/bun/releases/download`), as Bun, pnpm and mise use them
  (source-checked); not the npm package `@oven/bun-windows-x64`.
- One download path, `[System.Net.WebRequest]`, with `Tls12` added to
  `[Net.ServicePointManager]::SecurityProtocol` by `-bor` (.NET Framework may default
  lower; Bun's `install.ps1` sets none) and `$ProgressPreference = 'SilentlyContinue'`
  (the progress bar slows 5.1 downloads drastically); source-checked,
  `getty-bun.ps1:27`, `:355-375`. No `curl.exe` first. Executed against GitHub: CI
  45603412444, job "real download (windows powershell)".
- SHA256 from the starter's pin block only, never from `SHASUMS256.txt` or a file next to
  the archive (Bun's `install.ps1` checks none). Hash with
  `System.Security.Cryptography.SHA256` (`getty-bun.ps1:451-455`): `Get-FileHash` on 5.1
  ignores the script's `ErrorActionPreference`. Executed: scenario 4.
- Unzip with `System.IO.Compression.ZipFile` (`Add-Type -AssemblyName
  System.IO.Compression.FileSystem` in 5.1). The archive holds exactly the pin's member,
  `bun-windows-x64/bun.exe` (or the baseline's), plus its directory entry; extract that
  entry by name. No `bunx.exe` in the zip. Not `Expand-Archive`: slow in 5.1 and extracts
  everything. Executed: scenario 5.
- Probe `bun.exe --version` in staging, before publish. Retry a failed probe once after
  about 1 s (antivirus may hold a fresh `.exe`), never a timed-out one (source-checked,
  `getty-bun.ps1:526-532`, `:650`; the retry is not checked).
- Open difference from "identical behavior" (card `k19`): `getty-bun.ps1` probes the
  published `bun.exe` a second time after releasing the lock and fails with exit 1,
  leaving the slot as published, if that probe does not pass; the next call takes the
  fast path (source-checked, `getty-bun.ps1:675-681`). `getty-bun.sh` and the README
  have no such second probe.

## Lock and publish

- `[System.IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None')`, kept in a variable
  for the whole critical section and disposed right after publish, before Bun starts
  again for the entry (`getty-bun.ps1:667-671`; executed: scenario 2b), or in `finally`
  on failure. Only the staging probe runs Bun while the lock is held. Waiting is a retry
  loop with a short sleep until the deadline. Not a named mutex (`Local\` is per logon
  session).
- Stage under `runtimes\bun\.staging\<id>\`, publish with `[System.IO.Directory]::Move`.
  Antivirus can hold a freshly written `.exe`: retry moves and deletes on a sharing
  violation, bounded (about 10 s), then fail. Never fall back to copying into a slot.

## Paths and environments

- Root: `$env:GETTY_HOME` if set (absolute), else the user profile
  (`[Environment]::GetFolderPath('UserProfile')`) plus `\.getty`. Not `$HOME` or
  `$env:HOME`: Git Bash sets `HOME` to a `/c/Users/...` path.
- Run the slot's `bun.exe` by absolute path; never look for Bun on `PATH` or in the
  working directory (claude-mem: `where` timeouts, code-page damage, a planted
  `bun.exe`). Executed: scenario 7.
- Write no `PATH` or registry entry (Bun's `install.ps1` writes `HKCU\Environment\Path`
  and an uninstall key); the absolute `-File` call needs neither.
- Test spaces and non-ASCII characters in `GETTY_HOME` and in the consumer root (an old
  briefing bug on a non-ASCII home). Keep staging ids short (MAX_PATH).
- Git Bash, MSYS, Cygwin: `getty-bun.sh` forwards to this script (paths through
  `cygpath -w`); the slot and lock are the same. NUL stdin, exit codes, path conversion:
  README.
- WSL is Linux: it uses `getty-bun.sh` with its own store, never a Windows `bun.exe`.
- Line endings: `.gitattributes` with `* text=auto eol=lf`, `*.zip binary`; checked-in
  symlinks become text files without developer mode (measured), so use none.

## Targets

- Architecture from the environment, not the registry: `PROCESSOR_ARCHITEW6432` (a
  32-bit host process), else `PROCESSOR_ARCHITECTURE`; `AMD64` -> `x64`
  (source-checked, `getty-bun.ps1:102-110`; `AMD64` executed on every Windows leg). Bun's
  `install.ps1` reads the registry, which its comment says also works under x64
  emulation on ARM64; what the environment shows there: not checked.
- ARM64: Bun ships native `windows-aarch64` zips from 1.3.10 (source-checked, mise
  `fd93df2`), but it is not an MVP target: fail with a message naming it (executed,
  simulated through `PROCESSOR_ARCHITECTURE`, CI 45572032454).
- AVX2 via `IsProcessorFeaturePresent(40)` through `Add-Type`, only when no slot exists
  (install, `status`); if it cannot load (Constrained Language Mode, no compiler), use
  `x64-baseline`. An x64 probe that dies with `STATUS_ILLEGAL_INSTRUCTION`
  (`-1073741795`) publishes nothing; then install `windows-x64-baseline` under its own
  lock, as Bun's `install.ps1` does. The `Add-Type` check: executed, CI 45572032454
  (it chose `windows-x64`). The fallback: source-checked (`getty-bun.ps1:692-709`), a
  local run with pwsh 7 on Linux and a fixture probe, not in CI. A CPU without AVX2:
  not checked.
- Fast path: the first slot that exists of `windows-x64`, then `windows-x64-baseline`,
  without CPU detection; a mismatching `windows-x64` slot fails closed and is never
  skipped. A profile moved to a CPU without AVX2 keeps its `windows-x64` slot (README).
