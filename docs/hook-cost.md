# agent-bun-runtime: per-hook cost of the starters

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

Executed on Bun 1.4.5 in three CI runs on the same images:
- Linux: `ubuntu-latest` (image `ubuntu-26.04`, 20261116.202.1), target `linux-x64`.
- Windows: `windows-latest` (image `windows-2025-vs2026`, 20261116.315.1), target
  `windows-x64`, with Windows PowerShell 5.1.26100.33822 and PowerShell 7.6.10.

The runs:
- run [45572032454](https://github.com/Getty/agent-bun-runtime/actions/runs/45572032454),
  commit `d822139`
- run [45579886904](https://github.com/Getty/agent-bun-runtime/actions/runs/45579886904),
  commit `78a5d2e`; this run added the Git Bash row
- run [45589361806](https://github.com/Getty/agent-bun-runtime/actions/runs/45589361806),
  commit `3f6487a`

The three commits have the same fast path in both starters, and `78a5d2e` and `3f6487a`
the same `measure-hook.ts`, so the difference between the runs is the runner VM.

| Leg | Run | bare shell | bare Bun | direct exec | Codex nesting | Git Bash | starter over bare Bun |
|---|---|---:|---:|---:|---:|---:|---:|
| Linux, `sh` (dash) | 1 | 1 | 14 | 19 | n/a | n/a | **6 ms** |
| Linux, `sh` (dash) | 2 | 1 | 14 | 19 | n/a | n/a | **5 ms** |
| Linux, `sh` (dash) | 3 | 1 | 15 | 21 | n/a | n/a | **6 ms** |
| Windows, `powershell` 5.1 | 1 | 171 | 28 | 375 | 501 | – | **348 ms** |
| Windows, `powershell` 5.1 | 2 | 222 | 31 | 461 | 637 | 554 | **431 ms** |
| Windows, `powershell` 5.1 | 3 | 240 | 33 | 482 | 661 | 576 | **449 ms** |
| Windows, `pwsh` 7 | 1 | 206 | 25 | 397 | 550 | – | **372 ms** |
| Windows, `pwsh` 7 | 2 | 294 | 35 | 556 | 785 | 589 | **522 ms** |
| Windows, `pwsh` 7 | 3 | 216 | 25 | 422 | 613 | 445 | **397 ms** |

The values are median ms over 10 runs each. On the `pwsh` leg the Git Bash row runs 5.1
(see Method). Ranges for the direct exec form:

| Leg | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Linux | 19–21 | 19–19 | 20–22 |
| 5.1 | 357–407 | 450–476 | 473–491 |
| 7 | 386–428 | 544–582 | 407–447 |

Ranges for the recorded-as-data rows:

| Row | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Codex nesting, 5.1 | 491–509 | 622–660 | 648–686 |
| Codex nesting, 7 | 539–2257 | 767–2620 | 601–4828 |
| Git Bash, 5.1 leg | – | 547–574 | 563–617 |
| Git Bash, 7 leg | – | 570–837 | 436–689 |

The script does not log single-run times. Unlike the timed rows, the recorded-as-data rows
keep their first, cold run, so a maximum above 2 s is probably that run. The medians are
unaffected.

In every recorded-as-data run (20 Codex nesting runs per CI run, 20 Git Bash runs in each
of runs 2 and 3):
- the exit code was 0;
- nothing timed out;
- stdout was byte-identical to the direct form.

## Reading

- **Linux:** the starter costs about 5–6 ms over Bun alone: a `receipt.json` read and a few
  `test`s, then `exec`.
- **Windows:** the starter costs about 350–520 ms over Bun alone, depending on the runner
  VM. These shares are derived from the medians. Run 1 / run 2 / run 3:

  | Share | 5.1 | 7 |
  |---|---|---|
  | The PowerShell start itself | 171 / 222 / 240 ms | 206 / 294 / 216 ms |
  | The script's own work: parsing the ps1, reading the receipt, starting `bun.exe` through `System.Diagnostics.Process` with redirected streams, and copying them | 176 / 208 / 209 ms | 166 / 227 / 181 ms |

- **Codex** adds a second PowerShell start: the outer one is 5.1 and the inner one is the
  starter's shell. A hook costs about 0.5–0.66 s (5.1 inner) or 0.55–0.79 s (7 inner) on
  the runner, before the entry's own work.
- **The Git Bash forwarding** adds about 90 ms to the direct 5.1 form on the same runner
  (554 against 461 ms in run 2, 576 against 482 ms in run 3). By reading the forwarding
  code, not measured part by part, that is the `bash.exe` start (wrapper and MSYS bash),
  `uname`, the `cygpath` calls and the exec. The forwarding's check for a `/dev/null`
  stdin (two builtin `test`s before the exec) came after these runs: not measured. The
  check takes the empty-pipe path only for a character device that is not a terminal; a
  pipe or a file is neither, so the forwarding keeps the exec for a hook's stdin.
  `measure-hook.ts` passes the hook JSON as a buffer, which `Bun.spawn` writes to a pipe
  (source-checked). Claude Code sends the hook JSON on stdin and then ends it (measured
  by windows-developer, `docs/hook-start-windows.md` there); that its stdin is a pipe is
  inferred, not recorded. For Codex: not measured.

## Limits of these numbers

- They are a lower bound for real desktops. The CI runner is a server SKU with Defender
  real-time protection off and code page 65001. The hook-cost job has no environment step
  of its own; these facts were observed in the "Windows environment" step of the scenario
  jobs of the same runs, on the same image.
- On a real Windows machine, windows-developer measured about 720 ms per PowerShell start
  (Claude Code 2.1.287, `docs/hook-start-windows.md` in that repository). A real-host
  measurement is a card for the windows-developer board.
- The run-to-run spread of the direct exec median on the runner is about 30 % (5.1:
  375–482 ms) to 40 % (7: 397–556 ms).
- Only the fast path is measured. An install, which happens once per Bun version and
  target, is not.
- `linux-aarch64` is not measured.
