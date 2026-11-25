---
name: getty-bun-windows
description: Use when writing, testing or reviewing bootstrap/getty-bun.ps1 or anything getty-bun does on native Windows - PowerShell 5.1 compatibility, stdin and stdout passthrough, locking, download, unzip, paths, Git Bash forwarding.
---

# getty-bun on Windows

Target: native Windows **without** Git Bash. The facts below marked "measured" come from
the windows-developer hub (`~/dev/windows-developer/docs/hook-start-windows.md`,
`starter-konvention.md`, `umgebung.md`; Claude Code 2.1.287, Windows 11 25H2,
PowerShell 5.1.26100). Everything else is source-checked until a Windows run shows it.

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

- Measured: the exec form with `powershell -NoProfile -ExecutionPolicy Bypass -File ...`
  starts and costs about 720 ms per start. A Group Policy execution policy overrides
  `Bypass`; then the starter cannot run, which the consumer's doctor must report.
- Codex: `commandWindows` carries this line. Which shell Codex uses for it on Windows
  is not measured; a windows-developer card measures it before phase 3a closes.

## stdin, stdout, exit code

- **Never run Bun with `&`.** Measured (probe y4): PowerShell 5.1 does not pass the end
  of stdin to a native program; the hook hangs until its timeout and the process stays
  behind. PowerShell's pipeline also re-encodes text.
- Use `System.Diagnostics.Process`: `UseShellExecute = $false`,
  `RedirectStandardInput` and `RedirectStandardOutput` true, stderr inherited. Copy
  `[Console]::OpenStandardInput()` to the child's stdin as raw bytes and close it; copy
  the child's `StandardOutput.BaseStream` to `[Console]::OpenStandardOutput()` as raw
  bytes, both asynchronously (`CopyToAsync`) so neither side blocks. Exit with the
  child's `ExitCode`.
- 5.1 has only the `Arguments` string: quote every argument by the
  `CommandLineToArgvW` rules (spaces, embedded quotes, trailing backslashes). Test it.
- Measured: hosts send UTF-8 JSON on stdin with backslash paths inside, and pass stdout
  through unchanged. The starter's own messages go to `[Console]::Error`.

## Download, hash, unzip

- `[Net.ServicePointManager]::SecurityProtocol` must include `Tls12` (.NET Framework may
  default lower); `$ProgressPreference = 'SilentlyContinue'` (the progress bar slows 5.1
  downloads drastically); `Invoke-WebRequest -UseBasicParsing` or `System.Net.WebClient`.
- SHA256 with `Get-FileHash -Algorithm SHA256` or `System.Security.Cryptography.SHA256`.
- Unzip with `System.IO.Compression.ZipFile` (`Add-Type -AssemblyName
  System.IO.Compression.FileSystem` in 5.1) and extract only the expected entry by name.
  Not `Expand-Archive`: slow in 5.1 and extracts everything.

## Lock and publish

- `[System.IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None')`, kept in a variable
  for the whole critical section, disposed in `finally`. Waiting is a retry loop with a
  short sleep until the deadline. Not a named mutex (`Local\` is per logon session).
- Stage under `runtimes\bun\.staging\<id>\`, publish with `[System.IO.Directory]::Move`.
  Antivirus can hold a freshly written `.exe`: retry moves and deletes on a sharing
  violation, bounded (about 10 s), then fail. Never fall back to copying into a slot.

## Paths and environments

- Root: `$env:GETTY_HOME` if set (absolute), else the user profile
  (`[Environment]::GetFolderPath('UserProfile')`) plus `\.getty`. Not `$HOME` or
  `$env:HOME`: Git Bash sets `HOME` to a `/c/Users/...` path.
- Test spaces and non-ASCII characters in `GETTY_HOME` and in the consumer root (an old
  briefing bug on a non-ASCII home). Keep staging ids short (MAX_PATH).
- Git Bash, MSYS, Cygwin: `getty-bun.sh` forwards to this script (paths through
  `cygpath -w`); the slot and lock are the same.
- WSL is Linux: it uses `getty-bun.sh` with its own store, never a Windows `bun.exe`.
- Line endings: `.gitattributes` with `* text=auto eol=lf`, `*.zip binary`; checked-in
  symlinks become text files without developer mode (measured), so use none.

## Targets

`$env:PROCESSOR_ARCHITECTURE` (`AMD64` -> `x64`; check `PROCESSOR_ARCHITEW6432` for a
32-bit host process). AVX2 via `IsProcessorFeaturePresent(40)` through `Add-Type`, only
during install; if detection fails (e.g. Constrained Language Mode), use
`x64-baseline`. ARM64 is not an MVP target: fail with a message.
