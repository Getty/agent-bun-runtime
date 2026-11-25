# getty-bun: per-hook cost of the starters

The phase 1 gate asks for the per-hook cost on Windows to be measured and recorded. The
numbers also feed the open decision "Claude Code on Windows" in [plan.md](plan.md).

## Method

`bootstrap/test/measure-hook.ts` runs on CI in the `hook-cost` job (one leg per starter).
It installs once from the local fixture server, which is not measured. Then it times N = 10
fast-path calls of a trivial hook entry (JSON on stdin, JSON on stdout), by wall clock
around the spawn. The script logs the median, minimum and maximum of those 10 calls per
row. The table below shows the medians; the ranges follow it.

| Row | What is spawned |
|---|---|
| bare shell | Linux: `sh -c :`. Windows: `<shell> -NoLogo -NoProfile -NonInteractive -Command exit`, the shell's own start. |
| bare Bun | The slot's Bun runs the entry by absolute path with `--no-install`, with no starter. |
| direct exec | The starter's `run` on the fast path: `sh bootstrap/getty-bun.sh run …`, or `<shell> -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bootstrap/getty-bun.ps1 run …`. |
| Codex nesting | Codex runs `commandWindows` inside `powershell -NoProfile -Command <line>` (source-checked, openai/codex `3f65e9f`). The row wraps the direct exec form in that, so two PowerShell processes start for one hook. Exit codes, stdout bytes and timeouts are recorded as data. |

## Results

Executed: CI run [45572032454](https://github.com/Getty/getty-bun/actions/runs/45572032454),
commit `d822139`, Bun 1.4.5.
- Linux: `ubuntu-latest` (image `ubuntu-26.04`, 20261116.202.1), target `linux-x64`.
- Windows: `windows-latest` (image `windows-2025-vs2026`, 20261116.315.1), target
  `windows-x64`, with Windows PowerShell 5.1.26100.33822 and PowerShell 7.6.10.

| Leg | bare shell | bare Bun | direct exec | Codex nesting | starter over bare Bun |
|---|---:|---:|---:|---:|---:|
| Linux, `sh` (dash) | 1 | 14 | 19 | n/a | **6 ms** |
| Windows, `powershell` 5.1 | 171 | 28 | 375 | 501 | **348 ms** |
| Windows, `pwsh` 7 | 206 | 25 | 397 | 550 | **372 ms** |

The values are median ms over 10 runs each. Ranges for the direct exec form:
- Linux: 19–21
- 5.1: 357–407
- 7: 386–428

Ranges for the Codex nesting:
- 5.1: 491–509
- 7: 539–2257. The script does not log single-run times. Unlike the timed rows, this row
  keeps its first, cold run, so the 2257 ms maximum is probably that run. The median is
  unaffected.

In all 20 nested runs the exit code was 0, nothing timed out, and stdout was byte-identical
to the direct form.

## Reading

- **Linux:** the starter costs about 6 ms over Bun alone: a `receipt.json` read and a few
  `test`s, then `exec`.
- **Windows:** the starter costs about 350–370 ms over Bun alone. These shares are derived
  from the medians:
  - about 170 ms (5.1) or 205 ms (7) is the PowerShell start itself;
  - about 175 ms (5.1) or 165 ms (7) is the script's own work: parsing the ps1, reading
    the receipt, starting `bun.exe` through `System.Diagnostics.Process` with redirected
    streams, and copying them.
- **Codex** adds a second PowerShell start, so a hook costs about 0.5 s (5.1 outer, 5.1
  inner) to 0.55 s (5.1 outer, 7 inner) before the entry's own work.

## Limits of these numbers

- They are a lower bound for real desktops. The CI runner is a server SKU with Defender
  real-time protection off and code page 65001. The hook-cost job has no environment step
  of its own; these facts were observed in the "Windows environment" step of the scenario
  jobs in the same run, on the same image. On a real Windows machine windows-developer measured about 720 ms
  per PowerShell start (Claude Code 2.1.287, `docs/hook-start-windows.md` in that
  repository). A real-host measurement is a card for the windows-developer board.
- Only the fast path is measured. An install, which happens once per Bun version and
  target, is not.
- Not measured yet: the Git Bash forwarding (`bash bootstrap/getty-bun.sh` → PowerShell →
  Bun). The row is being added in phase 1. The forwarding picks Windows PowerShell 5.1
  first, so that row measures 5.1 on the `pwsh` leg too. `linux-aarch64` is not measured
  either.
