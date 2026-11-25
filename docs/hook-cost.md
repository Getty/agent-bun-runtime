# getty-bun: per-hook cost of the starters

The phase 1 gate asks for the per-hook cost on Windows to be measured and recorded. The
numbers also feed the open decision "Claude Code on Windows" in [plan.md](plan.md).

## Method

`bootstrap/test/measure-hook.ts` runs on CI in the `hook-cost` job (one leg per starter).
It installs once from the local fixture server, which is not measured. Then it times N = 10
fast-path calls of a trivial hook entry (JSON on stdin, JSON on stdout), by wall clock
around the spawn. The script logs the median, minimum and maximum of those 10 calls per
row. The tables below show the medians; the ranges follow them.

| Row | What is spawned |
|---|---|
| bare shell | Linux: `sh -c :`. Windows: `<shell> -NoLogo -NoProfile -NonInteractive -Command exit`, the shell's own start. |
| bare Bun | The slot's Bun runs the entry by absolute path with `--no-install`, with no starter. |
| direct exec | The starter's `run` on the fast path: `sh bootstrap/getty-bun.sh run …`, or `<shell> -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bootstrap/getty-bun.ps1 run …`. |
| Codex nesting | Codex runs `commandWindows` inside `powershell -NoProfile -Command <line>` (source-checked, openai/codex `3f65e9f`). The row wraps the direct exec form in that, so two PowerShell processes start for one hook. Exit codes, stdout bytes and timeouts are recorded as data. |
| Git Bash | Git for Windows' `bash.exe` runs `bootstrap/getty-bun.sh run …`, which forwards to `getty-bun.ps1`. The forwarding prefers Windows PowerShell 5.1, so this row measures 5.1 on both Windows legs. Recorded as data, like the Codex nesting. |

## Results

Executed on Bun 1.4.5 in two CI runs on the same images:
- Linux: `ubuntu-latest` (image `ubuntu-26.04`, 20261116.202.1), target `linux-x64`.
- Windows: `windows-latest` (image `windows-2025-vs2026`, 20261116.315.1), target
  `windows-x64`, with Windows PowerShell 5.1.26100.33822 and PowerShell 7.6.10.

The runs:
- run [45572032454](https://github.com/Getty/getty-bun/actions/runs/45572032454),
  commit `d822139`
- run [45579886904](https://github.com/Getty/getty-bun/actions/runs/45579886904),
  commit `78a5d2e`; this run added the Git Bash row

Both commits have the same fast path in both starters, so the difference between the runs
is the runner VM.

| Leg | Run | bare shell | bare Bun | direct exec | Codex nesting | Git Bash | starter over bare Bun |
|---|---|---:|---:|---:|---:|---:|---:|
| Linux, `sh` (dash) | 1 | 1 | 14 | 19 | n/a | n/a | **6 ms** |
| Linux, `sh` (dash) | 2 | 1 | 14 | 19 | n/a | n/a | **5 ms** |
| Windows, `powershell` 5.1 | 1 | 171 | 28 | 375 | 501 | – | **348 ms** |
| Windows, `powershell` 5.1 | 2 | 222 | 31 | 461 | 637 | 554 | **431 ms** |
| Windows, `pwsh` 7 | 1 | 206 | 25 | 397 | 550 | – | **372 ms** |
| Windows, `pwsh` 7 | 2 | 294 | 35 | 556 | 785 | 589 | **522 ms** |

The values are median ms over 10 runs each. On the `pwsh` leg the Git Bash row runs 5.1
(see Method). Ranges for the direct exec form:

| Leg | Run 1 | Run 2 |
|---|---|---|
| Linux | 19–21 | 19–19 |
| 5.1 | 357–407 | 450–476 |
| 7 | 386–428 | 544–582 |

Ranges for the recorded-as-data rows:

| Row | Run 1 | Run 2 |
|---|---|---|
| Codex nesting, 5.1 | 491–509 | 622–660 |
| Codex nesting, 7 | 539–2257 | 767–2620 |
| Git Bash, 5.1 leg | – | 547–574 |
| Git Bash, 7 leg | – | 570–837 |

The script does not log single-run times. Unlike the timed rows, the recorded-as-data rows
keep their first, cold run, so a maximum above 2 s is probably that run. The medians are
unaffected.

In every recorded-as-data run (20 Codex nesting runs per CI run, 20 Git Bash runs in run 2):
- the exit code was 0;
- nothing timed out;
- stdout was byte-identical to the direct form.

## Reading

- **Linux:** the starter costs about 5–6 ms over Bun alone: a `receipt.json` read and a few
  `test`s, then `exec`.
- **Windows:** the starter costs about 350–520 ms over Bun alone, depending on the runner
  VM. These shares are derived from the medians. Run 1 / run 2:

  | Share | 5.1 | 7 |
  |---|---|---|
  | The PowerShell start itself | 171 / 222 ms | 206 / 294 ms |
  | The script's own work: parsing the ps1, reading the receipt, starting `bun.exe` through `System.Diagnostics.Process` with redirected streams, and copying them | 176 / 208 ms | 166 / 227 ms |

- **Codex** adds a second PowerShell start: the outer one is 5.1 and the inner one is the
  starter's shell. A hook costs about 0.5–0.64 s (5.1 inner) or 0.55–0.79 s (7 inner) on
  the runner, before the entry's own work.
- **The Git Bash forwarding** adds about 90 ms to the direct 5.1 form on the same runner
  (554 against 461 ms, run 2). By reading the forwarding code, not measured part by part,
  that is the `bash.exe` start (wrapper and MSYS bash), `uname`, the `cygpath` calls and
  the exec.

## Limits of these numbers

- They are a lower bound for real desktops. The CI runner is a server SKU with Defender
  real-time protection off and code page 65001. The hook-cost job has no environment step
  of its own; these facts were observed in the "Windows environment" step of the scenario
  jobs of the same runs, on the same image.
- On a real Windows machine, windows-developer measured about 720 ms per PowerShell start
  (Claude Code 2.1.287, `docs/hook-start-windows.md` in that repository). A real-host
  measurement is a card for the windows-developer board.
- The run-to-run spread on the runner is about 25 % (5.1) to 40 % (7).
- Only the fast path is measured. An install, which happens once per Bun version and
  target, is not.
- `linux-aarch64` is not measured.
