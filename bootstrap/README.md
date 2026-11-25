# bootstrap

The getty-bun bootstrap: the starters that install the pinned Bun before Bun exists, the
version table they are pinned from, and the pin render that connects the two. Plan and
interface: [docs/plan.md](../docs/plan.md), "Starter interface (MVP)". Decisions:
[ADR 0001](../docs/adr/0001-layout-and-delivery.md),
[ADR 0004](../docs/adr/0004-one-starter-per-os.md),
[ADR 0005](../docs/adr/0005-bun-pin-and-version-table.md).

| File | What it is |
|---|---|
| `versions.json` | The reviewed version table: per Bun version and target the archive, its SHA256 and the single expected member |
| `render-pin.ts` | The pin render: writes the pin block for one version into the starters, or checks them |
| `getty-bun.sh`, `getty-bun.ps1` | The starters (POSIX `sh`, Windows PowerShell 5.1 and 7); each carries one pin block |

This README is the contract the starters and the scenario suite code against: the table
fields, the pin block format, the render CLI, the receipt and the `.installing` record
below are behavior.

## Version table: `versions.json`

```json
{
  "versions": {
    "1.4.5": {
      "targets": {
        "linux-x64": {
          "archive": "bun-linux-x64.zip",
          "sha256": "94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb",
          "member": "bun-linux-x64/bun"
        }
      }
    }
  }
}
```

(One target shown; every version lists all five.)

- `versions` maps an exact Bun version to its entry. A new version is a new key; existing
  entries are never edited.
- `targets` holds exactly the five MVP targets: `linux-x64`, `linux-x64-baseline`,
  `linux-aarch64`, `windows-x64`, `windows-x64-baseline`. A missing or an extra target
  fails the render. musl, `windows-aarch64` and macOS come later as new targets in the
  render and the starters, then in the table (ADR 0005).
- `archive`: the release asset's file name, a plain `.zip` name. The download URL is
  `<base>/bun-v<version>/<archive>`, `<base>` being `GETTY_BUN_MIRROR` or
  `https://github.com/oven-sh/bun/releases/download` (for Bun's own assets this is the
  plan's `bun-<target>.zip`). `GETTY_BUN_MIRROR` takes the downloader's schemes:
  `getty-bun.sh` those of curl (http, https, file, ...) or, without curl, of wget (http,
  https, ftp; no file); `getty-bun.ps1` http, https and file. (file with curl: executed,
  CI 45589361806, scenario jobs linux-x64 139119150180 and linux-arm64 139119150223; the
  wget path: not checked, the suite never runs it. file with `getty-bun.ps1`: executed,
  CI 45589361806, scenario jobs Windows PowerShell 5.1 139119150551 and PowerShell 7
  139119150607, and in the Windows worker's local unit tests on PowerShell 7.7.0 on
  Linux, outside the suite.)
- `sha256`: the archive's SHA256, 64 lowercase hex digits, copied from the signature-
  verified `SHASUMS256.txt` (below). The starter checks it before unpacking; it never
  reads a checksum from a file next to the archive.
- `member`: the one file the starter extracts, by name, to the slot's `bin/bun` or
  `bin\bun.exe`. A relative path of `/`-separated segments of `[0-9A-Za-z._-]`, no
  segment `.` or `..`.

**Archive contents.** An archive is accepted when its entries are exactly `member` plus
directory entries for `member`'s parent directories, nothing else. Bun's archives hold
two entries, e.g. `bun-linux-x64/` and `bun-linux-x64/bun`. A second file, another name
or any other directory is rejected.

Table for 1.4.5 (checked 2026-11-25 against the downloaded archives with `sha256sum -c`
and `unzip -l`):

| Target | Archive | SHA256 | Member |
|---|---|---|---|
| `linux-x64` | `bun-linux-x64.zip` | `94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb` | `bun-linux-x64/bun` |
| `linux-x64-baseline` | `bun-linux-x64-baseline.zip` | `dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463` | `bun-linux-x64-baseline/bun` |
| `linux-aarch64` | `bun-linux-aarch64.zip` | `18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84` | `bun-linux-aarch64/bun` |
| `windows-x64` | `bun-windows-x64.zip` | `815ab45ec7f549abf87e6869584b506eab088e24225683957b7e150b47d6de30` | `bun-windows-x64/bun.exe` |
| `windows-x64-baseline` | `bun-windows-x64-baseline.zip` | `3c081c73865e7a3453a9d514cc2ba3d699880621bcf67bb17241ff5194cb1d4b` | `bun-windows-x64-baseline/bun.exe` |

## Bun's release signing key

Bun signs `SHASUMS256.txt` of every release as a cleartext signature,
`SHASUMS256.txt.asc`. The trust anchor is the full fingerprint:

```
pub   ed25519 2023-01-25 [SC]
      F3DC C08A 8572 C074 9B3E  1888 8EAB 4D40 A7B2 2B59
uid   Robobun <robobun@oven.sh>
sub   cv25519 2023-01-25 [E]
      8CDF 8ECA BE81 CE3F 32AC  0472 36FA 8E87 7B80 AB05
```

**Origin.** The armored key below is the one Bun's own Docker images inline to verify
releases: `dockerhub/debian/Dockerfile` in `oven-sh/bun` at commit
`2e321d89067f623e648fb933daed375dc9e68bca` (main, 2026-11-25), fetched on 2026-11-25
with `gh api 'repos/oven-sh/bun/contents/dockerhub/debian/Dockerfile?ref=2e321d89067f623e648fb933daed375dc9e68bca'`.
The `alpine`, `debian-slim` and `distroless` Dockerfiles at that commit carry a
byte-identical block, and each asserts the signer
`F3DCC08A8572C0749B3E18888EAB4D40A7B22B59`. The key was inlined in commit `c7b06d94bac1`
(2026-10-04); before that the same Dockerfiles fetched this fingerprint from
keys.openpgp.org (seen at `14c23cc42952`, 2024-04-04). Cross-check: keys.openpgp.org
(`/vks/v1/by-fingerprint/F3DCC08A8572C0749B3E18888EAB4D40A7B22B59`, fetched
2026-11-25) serves the same key and UID.

```
-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEY9GQFhYJKwYBBAHaRw8BAQdAkppAqaXl0RkROz6NfdvlwYd2UuUVfHLk2NNY
IzEdnT+0GVJvYm9idW4gPHJvYm9idW5Ab3Zlbi5zaD6IkwQTFgoAOxYhBPPcwIqF
csB0mz4YiI6rTUCnsitZBQJj0ZAWAhsDBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4H
AheAAAoJEI6rTUCnsitZ96UBAMvwCLD6Ud1RZkpvvnGUU+idHt2hcNmYU2d0XxDI
HQ0rAQCA9VFOtjZefQkfhDzgIgnEEdSFXaMiyY+D+LP8awNMCrg4BGPRkBYSCisG
AQQBl1UBBQEBB0BpfePYSOEx8PihYkNXjlK5YT89CGHjEK5etleaB9i6OwMBCAeI
eAQYFgoAIBYhBPPcwIqFcsB0mz4YiI6rTUCnsitZBQJj0ZAWAhsMAAoJEI6rTUCn
sitZvhAA/j4SQxOCLheRG86A2181WAP4qLS1qxSw+fCf28DgiPfbAQCL0kcel+M9
qbRIlMnwn6TwlQgN9w1qqlSnA9CbKXT9Aw==
=dGV6
-----END PGP PUBLIC KEY BLOCK-----
```

Verified versions:

| Version | Signature made | Verified |
|---|---|---|
| 1.4.5 | 2026-11-19 08:48:42 UTC, good signature by `F3DCC08A8572C0749B3E18888EAB4D40A7B22B59` | 2026-11-25, GnuPG 2.4.7, throwaway `GNUPGHOME` |

## Adding a version

ADR 0005. Downloads are untrusted data: each release goes into its own new, empty
directory under `.dev/` (gitignored); never use your own keyring.

```sh
v=1.4.6                                   # the version to add
d=.dev/release/bun-v$v
mkdir -p .dev/release && mkdir "$d"       # fails if it exists: must be new and empty
base=https://github.com/oven-sh/bun/releases/download/bun-v$v
curl -fsSL --proto '=https' -o "$d/SHASUMS256.txt.asc" "$base/SHASUMS256.txt.asc"
for t in linux-x64 linux-x64-baseline linux-aarch64 windows-x64 windows-x64-baseline; do
  curl -fsSL --proto '=https' -o "$d/bun-$t.zip" "$base/bun-$t.zip"
done

export GNUPGHOME="$(mktemp -d "$PWD/.dev/gnupg.XXXXXX")"   # mode 700, empty
sed -n '/^-----BEGIN PGP PUBLIC KEY BLOCK-----$/,/^-----END PGP PUBLIC KEY BLOCK-----$/p' \
  bootstrap/README.md | gpg --batch --import
gpg --batch --assert-signer F3DCC08A8572C0749B3E18888EAB4D40A7B22B59 \
  --verify --output "$d.verified.txt" "$d/SHASUMS256.txt.asc"   # must exit 0

(cd "$d" && grep -E '  bun-(linux-x64|linux-x64-baseline|linux-aarch64|windows-x64|windows-x64-baseline)\.zip$' \
  "../bun-v$v.verified.txt" | sha256sum -c -)                  # five OK
for t in linux-x64 linux-x64-baseline linux-aarch64 windows-x64 windows-x64-baseline; do
  unzip -Z1 "$d/bun-$t.zip"                                     # the member and its directory
done
gpgconf --kill all; rm -rf "$GNUPGHOME"; unset GNUPGHOME
```

- Take the checksums only from gpg's `--output` (the signed text). Do not download
  `SHASUMS256.txt` next to the `.asc`: gpg then warns "not a detached signature" and
  exits 1.
- `gpg` warns that the key "is not certified with a trusted signature": expected in a
  throwaway home. `--assert-signer` with the full fingerprint is the check; a good
  signature from any other key fails it.
- A bad signature, a fingerprint mismatch or a checksum mismatch stops the addition.
- Add the entry to `versions.json`, extend the verified-versions table above, render the
  starters for the new version and run the scenario suite against them. The commit names
  the verification (signer fingerprint, signature date, GnuPG version).

## Pin block

Each starter carries exactly one pin block. Both starters carry it byte for byte
identical: every line is a `#` comment, which is a comment in `sh` and in PowerShell.
The block is the only thing that selects the Bun version and the archive.

Format:

```
# >>> getty-bun pin: generated, do not edit >>>
# version <version>
# target <target> <archive> <sha256> <member>
# <<< getty-bun pin <<<
```

- The first and last lines are fixed marker lines, exactly as shown.
- The second line is the version line. Then one target line per MVP target, in this
  order: `linux-x64`, `linux-x64-baseline`, `linux-aarch64`, `windows-x64`,
  `windows-x64-baseline`. Eight lines in all.
- Fields are separated by one space; no leading or trailing spaces; lines end in LF; the
  block is pure ASCII. The field values are the table's, with the shapes the render
  enforces: `<version>` matches `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`, `<archive>`
  is a plain `.zip` name, `<sha256>` is 64 lowercase hex digits, `<member>` is a relative
  `/`-path of plain segments. None contains a space.
- The block appears once per file. Place it near the top of the starter, before any code,
  so the starter's scan ends early.

Example, version 1.4.5:

```
# >>> getty-bun pin: generated, do not edit >>>
# version 1.4.5
# target linux-x64 bun-linux-x64.zip 94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb bun-linux-x64/bun
# target linux-x64-baseline bun-linux-x64-baseline.zip dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 bun-linux-x64-baseline/bun
# target linux-aarch64 bun-linux-aarch64.zip 18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 bun-linux-aarch64/bun
# target windows-x64 bun-windows-x64.zip 815ab45ec7f549abf87e6869584b506eab088e24225683957b7e150b47d6de30 bun-windows-x64/bun.exe
# target windows-x64-baseline bun-windows-x64-baseline.zip 3c081c73865e7a3453a9d514cc2ba3d699880621bcf67bb17241ff5194cb1d4b bun-windows-x64-baseline/bun.exe
# <<< getty-bun pin <<<
```

**Reading it in a starter.** Read the starter's own file line by line; from the begin
marker on, take the line starting with `# version ` and the line starting with
`# target <detected target> ` (with the trailing space, so `linux-x64` does not match
`linux-x64-baseline`); stop at the end marker. Compare whole lines and prefixes as
plain strings, never as regular expressions or after trimming. Split the target line's
rest on single spaces into archive, SHA256 and member. A missing block, a missing
version line or a missing target line is a starter failure (one `getty-bun: ` line,
exit 1), never a fallback. The fast path needs only the version line; the target line
is needed for install.

- `sh`: one `while IFS= read -r line` loop over the file with `case` on the exact
  strings; no subprocess. A loop of this shape parsed the 1.4.5 block under `dash` in
  about 3 ms per run, process start included.
- PowerShell: `[System.IO.File]::ReadAllLines($PSCommandPath)`, exact comparison
  (`-ceq`, `StartsWith(..., [StringComparison]::Ordinal)`), `.Split(' ')`. Not
  `-match` (regex) and not `Select-String`.

## Render CLI: `render-pin.ts`

```
bun bootstrap/render-pin.ts --table FILE --version V FILE...
bun bootstrap/render-pin.ts --table FILE --version V --check FILE...
```

Runs on Bun at development and CI time; no dependencies, never on a user machine.

- Without `--check`: replaces everything from the begin marker line to the end marker
  line, inclusive, in each `FILE` with a fresh block for version `V` from `--table`.
  Everything outside the block stays byte for byte. A file already up to date is not
  rewritten. Nothing on stdout.
- With `--check`: changes nothing; exits 1 when any `FILE` differs from a fresh render,
  with one `getty-bun: ` stderr line per differing file. For a consumer's CI: the version
  is the consumer's `package.json` `gettyBun.bunVersion`.
- `--table` takes any path, so tests render with a fixture table and a fake version.
- Options may come in any order; every other argument is a `FILE`, which therefore must
  not begin with `-`.

| Exit | When |
|---|---|
| 0 | Every `FILE` rendered (or, with `--check`, equal to a fresh render) |
| 1 | Anything else, with one stderr line beginning `getty-bun: `; never 2 |

Failures, each one line; all but a write error are found before any file is written:

- usage (missing `--table`, `--version` or `FILE`, unknown option)
- table unreadable or not JSON (`cannot read table <path>: ENOENT`)
- `version <V> is not in table <path>`
- a target missing or unknown, or a field of the wrong shape, naming version and target
- `<file>: pin block markers not found`, `more than one pin block`,
  `end marker before begin marker` (a file with CRLF line endings has no marker lines)
- `cannot read file <path>`, `cannot write file <path>`

Only the selected version's entry is validated.

## Slot and receipt

A slot is published once, as a whole directory, by one rename from staging, and never
changed afterwards:

```
<GETTY_HOME>/runtimes/bun/<version>/<target>/
  bin/bun              (bin\bun.exe on Windows)
  receipt.json
```

The installing starter writes `receipt.json` into the staged slot after every check has
passed (archive SHA256, member list, `bun --version`), then renames the slot into place.
Canonical form, the same on every OS: ASCII, LF line endings, two-space indentation, one
key per line, the keys in this order, a final newline. Example (linux-x64-baseline):

```json
{
  "version": "1.4.5",
  "target": "linux-x64-baseline",
  "archiveSha256": "dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463",
  "contractVersion": 1,
  "archive": "bun-linux-x64-baseline.zip",
  "member": "bun-linux-x64-baseline/bun",
  "binarySha256": "f05d28a3862f4b84395c7fa32480b835dd47482e80b7e7a49a115227f0c06083",
  "executable": "bin/bun",
  "verifiedAt": "2026-11-25T10:00:00Z"
}
```

| Key | Value |
|---|---|
| `version` | The pinned Bun version, which `bun --version` reported |
| `target` | The slot's target |
| `archiveSha256` | The pinned SHA256 the downloaded archive matched |
| `contractVersion` | The runtime contract version, the number `1` (contract v0.2 keeps 1) |
| `archive` | The archive file name from the pin |
| `member` | The archive member extracted as the executable |
| `binarySha256` | SHA256 of the extracted executable; recorded for audits, never checked on the fast path |
| `executable` | The executable relative to the slot, with `/`: `bin/bun` or `bin/bun.exe` |
| `verifiedAt` | UTC time of the verification, `YYYY-MM-DDTHH:MM:SSZ` |

**Fast path.** `ready` means: `receipt.json` is a readable regular file, the executable
is a non-empty regular file (executable on POSIX), and the receipt's first three lines
are exactly

```
{
  "version": "<pinned version>",
  "target": "<detected target>",
```

compared as whole strings. That is why the form is fixed: the fast path reads three
lines, parses no JSON, hashes nothing and never starts Bun. No slot at all is `missing`;
anything else (other values, another layout, a missing executable) is `mismatch`, which
fails closed with the slot path and leaves the slot untouched. Other readers parse the
receipt as JSON and ignore keys they do not know; a new key goes after `archiveSha256`.

**Limit: a damaged executable.** The fast path does not look inside the executable. A
`bin/bun` that is non-empty but cannot run (overwritten with zeros or other bytes,
truncated, another architecture) passes as `ready`, and `run` then ends with whatever
the kernel and the shell make of it, not a `getty-bun: ` line. For a file the kernel
refuses to execute, `dash` exits 126 ("Exec format error"), while `busybox sh` runs the
file as a shell script and exits with what that gives: 0 for zeros, 2 for a syntax
error, 127 for an unknown command (executed with `dash` 0.5.12 and BusyBox 1.37.0). An
empty `bin/bun`, which both shells would "run" with exit 0, is a `mismatch`. Checking the ELF header with shell builtins is not sound:
`read` stops only at a newline and reads one byte per system call, and the first newline
in the 1.4.5 binaries is at byte 4240 (x64) and 2416 (aarch64), which costs about 10 ms
per hook (`dash` 13 ms, `busybox` 10 ms, measured on linux-x64-baseline); a damaged file
without newlines takes minutes (a 10 MB zero file: 25 s under `dash`). Repair: remove
the slot directory; the next call installs it again.

## Install lock and `.installing`

`runtimes/bun/.locks/<version>/<target>/` holds `.install.lock`, the permanent backing
file of the OS lock, and while an install runs, `.installing`. The lock holder writes
`.installing` after taking the lock (complete temporary file, then rename in the same
directory) and removes it before releasing the lock, on success and on every failure.
It is diagnostics for a waiter that times out, which names it in its message; it never
grants or proves ownership and no starter deletes a lock because of it.

```json
{
  "schemaVersion": 1,
  "pid": 12345,
  "processName": "sh",
  "processStartToken": "boot:<boot id>/start-ticks:<n>",
  "installId": "<staging directory name>",
  "environmentId": "<hostname>/linux/uid-<uid>",
  "requestedVersion": "1.4.5",
  "target": "linux-x64-baseline"
}
```

`pid` and `processName` are the starter's own. `processStartToken` and `environmentId`
are `null` when the OS does not provide them; the values above are the POSIX starter's
(from `/proc`), and the Windows starter defines its own for these two fields. The lock
is released before Bun starts, so an entry never inherits it.

A holder stopped by a signal it can handle (HUP, INT, TERM) removes `.installing` and its
staging directory. One killed outright (SIGKILL, power loss) leaves both behind: the next
holder overwrites `.installing`, and nothing removes the stale
`runtimes/bun/.staging/<id>/` in the MVP (no garbage collection). A staging directory is
safe to delete while no install runs; a published slot never refers to it.

## POSIX starter: tools

`getty-bun.sh` runs under any POSIX `sh` (tested with `dash` and `busybox sh`). The fast
path uses only shell builtins and `uname`. An install also needs, on `PATH`:

| Tool | Requirement |
|---|---|
| `flock` | util-linux `flock`: the starter uses `-w` (bounded wait) and `-E` (timeout exit code) |
| `unzip` | Info-ZIP `unzip`: the starter lists members with `-Z1`, which BusyBox `unzip` lacks |
| `curl`, or else `wget` | `curl` with `-q` (no `~/.curlrc`); GNU Wget 1.16 or later with `--no-config` (no wgetrc); BusyBox `wget` has no `--no-config` |
| `sha256sum`, or else `shasum` | coreutils `sha256sum`, or Perl's `shasum -a 256` |
| `mktemp`, `mkdir`, `mv`, `rm`, `chmod`, `date`, `id`, `tr` | coreutils (tested); `mktemp` needs `-d` with a template |

Neither fetcher reads its configuration files, so a `~/.curlrc` or `~/.wgetrc` cannot
change the download; a proxy comes from the usual environment variables (`https_proxy`,
`no_proxy`). A missing tool fails before anything is written, with one `getty-bun: `
line naming it; a tool of the wrong kind fails at the step that uses it, also with one
line.

## Windows starter

`getty-bun.ps1` runs under Windows PowerShell 5.1 and PowerShell 7, started as

```
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <root>\bootstrap\getty-bun.ps1 <command> [args...]
```

It keeps the POSIX starter's commands, `status` keys, exit codes and store layout; the
file stays pure ASCII with LF line endings (5.1 reads a file without BOM in the ANSI
code page). `GETTY_HOME` must be a drive-absolute (`C:\...`, `C:/...`) or UNC path;
unset, it is `<user profile>\.getty`, never `$HOME` (Git Bash sets `HOME` to a
`/c/Users/...` path). The executable is `bin\bun.exe`, the receipt's `executable` is
`bin/bun.exe`. (Commands, keys, exit codes, layout and the rejected relative
`GETTY_HOME`: executed, CI 45572032454, except an empty stdin, see `run`. Pure ASCII: the
static CI job. LF only: executed, CI 45572032454, where 5.1 parsed and ran the LF
checkout (`.gitattributes` `eol=lf`) in the parse step and the scenario jobs on that
image. The 5.1 code page, a UNC `GETTY_HOME` and the unset default: not checked.)

**Evidence.** The labels in this section say what ran a claim. *Executed, CI
45572032454*: the shared scenario suite in CI run 45572032454 (commit `d822139`) on
GitHub's `windows-2025-vs2026` image 20261116.315.1, under Windows PowerShell
5.1.26100.33822 and PowerShell 7.6.10, with Git for Windows' bash 5.3.15 and Defender
real-time protection off. *Executed, pwsh 7 on Linux*: the Windows worker's local unit
tests (not in the repository) on PowerShell 7.7.0 on Linux, neither Windows nor 5.1.
*Not checked*: nothing has run it.

**Targets.** `windows-x64` when `IsProcessorFeaturePresent` reports AVX2, otherwise
`windows-x64-baseline`; the check compiles through `Add-Type`, and where that cannot
load (Constrained Language Mode, no compiler) the answer is `windows-x64-baseline`. An
x64 Bun whose `--version` probe dies with `STATUS_ILLEGAL_INSTRUCTION` publishes
nothing; the starter then installs `windows-x64-baseline` under that target's own
lock. ARM64 fails as an unsupported target. (The `Add-Type` check and the ARM64 failure,
simulated through `PROCESSOR_ARCHITECTURE`: executed, CI 45572032454; there the check
chose `windows-x64`, logged as `target windows-x64` by both per-hook cost jobs after a
fresh `ensure` (jobs 139060757366 and 139060757556). The illegal-instruction fallback:
executed, pwsh 7 on Linux, with a fixture probe that exits with that code. A real CPU
without AVX2, and Constrained Language Mode, which also restricts the .NET calls the
rest of the starter makes: not checked.)

**Fast path.** The starter takes the first slot that exists of `windows-x64`, then
`windows-x64-baseline`, without detecting the CPU: `ready` runs it, `mismatch` fails
closed (a damaged `windows-x64` slot is never skipped for a ready baseline slot), and
only when neither exists does it detect the target and install. `status` reports that
slot, or, with neither present, the detected target's. The fast path uses no `Add-Type`
and no cmdlet from a module that 5.1 would have to load (`[type]::new()`, never
`New-Object`); the per-hook CI job measures what that costs. (`ready`, `mismatch` for a
tampered receipt or a missing or empty `bun.exe`, and `missing`: executed, CI
45572032454. The slot order and the own-functions-only rule: executed, pwsh 7 on Linux.)

**Limit: a CPU that loses AVX2.** The fast path does not detect the CPU, so a slot
installed as `windows-x64` stays the first existing slot when the same profile later
runs on a CPU without AVX2 (a VM moved to an older host, a roaming profile). Bun then
dies with an illegal instruction, `run` passes its exit code through as the entry's,
and the fast path has no fallback to `windows-x64-baseline`. The fast path does not set
the error mode either (below), so a Windows Error Reporting dialog may open. Repair:
remove the `windows-x64` slot directory; the next call detects the target and installs
`windows-x64-baseline`. (Not checked.)

**Install bounds.** The download fails when no response arrives within 60 s or less than
60 KiB arrive in a 60 s window, the counterpart of curl's `--speed-limit 1024
--speed-time 60`. The `--version` probe is killed through its process handle after
60 s. During the install the process error mode includes `SEM_FAILCRITICALERRORS` and
`SEM_NOGPFAULTERRORBOX`, which the probes inherit, so a crashing probe ends without a
Windows Error Reporting dialog while the lock is held; the previous mode is restored
before the entry starts. A failed probe is retried once after about 1 s (antivirus may
hold a fresh `bun.exe`), a timed-out one is not; the rename into the slot is retried for
about 10 s on sharing violations. (The download window against a stalling and a
trickling local server, the probe kill and the timed-out probe without retry: executed,
pwsh 7 on Linux. The error-mode calls run, best effort, in every install of CI
45572032454; that they took effect and keep a crash dialog away, the probe retry and the
rename retry: not checked.)

**Lock and `.installing`.** `.install.lock` is opened with `FileShare.None`; a sharing
or lock violation means held and is retried every 200 ms until `GETTY_BUN_LOCK_WAIT`
runs out, any other error fails. The Windows values of the two OS-specific fields:

| Field | Windows value |
|---|---|
| `processStartToken` | `"start-filetime:<n>"`: the starter process's creation time as a UTC FILETIME (100 ns intervals since 1601-01-01) |
| `environmentId` | `"<machine>/windows/<SID>"`: the machine name and the user's SID |

Either is `null` when the starter cannot read it; `processName` is `powershell` or
`pwsh`. (Parallel `ensure`, a waiter whose wait runs out, the `.installing` record and
the lock not leaking into Bun: executed, CI 45572032454.)

**`run`.** Bun starts through `System.Diagnostics.Process` with the entry's arguments
quoted by the `CommandLineToArgvW` rules; stdin and stdout are raw byte copies, stderr
is inherited, and the exit code is Bun's. The starter ends once Bun has ended, even when
the host keeps stdin open. (Executed, CI 45572032454, the open stdin included. An empty
stdin failed there in the test entry's own zero-length `Bun.write` to the stdout pipe,
`EINVAL` from `ftruncate` in Bun 1.4.5, so that case is not shown yet.)

**Limit: entry arguments.** `-File` hands the arguments after the script path to
PowerShell's own parameter binding: an entry argument shaped like `-name:value` or
starting with `-` may be re-parsed by PowerShell (PowerShell 7 splits `-x:foo` into
`-x` and `foo`: executed, pwsh 7 on Linux; 5.1: not checked). Entry arguments must not
start with `-`. (Arguments with spaces, quotes, a trailing backslash and non-ASCII
text: executed, CI 45572032454.)

**Limit: no console of its own.** Bun starts with `CreateNoWindow`, so no console
window opens for a hook. The trade-off: Ctrl+C in the host's console does not reach
Bun, and Bun survives a kill of `powershell.exe`. Both are to be measured on a real host
before phase 3a. (Not checked.)

**Git Bash, MSYS2 and Cygwin.** Under a `uname -s` of `MINGW*`, `MSYS*`, `CYGWIN*` or
`*_NT-*`, `getty-bun.sh` forwards every call to the `getty-bun.ps1` next to it
(`${0%.sh}.ps1`), so both starters share slot and lock. It runs Windows PowerShell
5.1 from `$SYSTEMROOT\System32\WindowsPowerShell\v1.0\powershell.exe` (else
`powershell.exe` or `pwsh.exe` on `PATH`) with the flags above, by `exec` (with a stdin
that is a character device but no terminal, such as `/dev/null`, through an empty pipe,
see the NUL-stdin limit below), arguments unchanged; streams are PowerShell's; exit
code: see the limit below. It needs `cygpath`. A `GETTY_HOME` starting with `/` is
converted with `cygpath -w`; an empty or relative one passes unchanged and is rejected
by `getty-bun.ps1`. A missing `getty-bun.ps1`, `cygpath` or PowerShell fails with one
`getty-bun: ` line. (Shared slot and lock under Git Bash: executed, CI 45572032454. The
converted `GETTY_HOME` and the unchanged arguments under Git Bash: executed, CI
45589361806, `[GETTY_HOME in POSIX form]` and `[arguments]` on both legs, jobs
139119150551 and 139119150607. The failure lines and the empty or relative `GETTY_HOME`
passed unchanged: a local check outside the suite and not in CI, with a fake `cygpath`
and PowerShell under dash 0.5.12, bash 5.2.37 and BusyBox 1.37.0 on Linux (k18 moves it
into the suite); on Git Bash: not checked. The stdin rule of the NUL-stdin limit: the
same local check, and on Git Bash CI 45597390051, see that limit.)

**Limit: PowerShell blocked by policy.** Where AppLocker or App Control (WDAC) blocks
`powershell.exe`, the forwarding's executable check still passes and starting it fails:
the caller sees exit 126 and the shell's own error line, not a `getty-bun: ` line. (Not
checked.)

**Limit: exit codes through Git Bash.** The caller gets PowerShell's exit code as the
MSYS runtime passes it on. Exit codes 0, 1, 2, 7 and 42 come back unchanged by `exec`,
with stdin on a pipe (executed, CI run 45579886904, commit `78a5d2e`, both legs, same
image and versions as above, MSYS runtime 3.6.10-5a1665c8). On the empty-pipe path of
the NUL-stdin limit exit 0 comes back (executed, CI 45597390051, commit `f12fa1d`), and
so does 42: `exec sh getty-bun.sh run entries/echo.ts 42 < /dev/null` inside
`bin\bash.exe`, with `x` on bash's own stdin, returned 42 with empty stdout and no
timeout (executed, CI 45601335472, commit `31a10b0`, jobs 139160728685, 139160728299
and 139160727955; that this `/dev/null` takes the empty pipe: source, with the `chr` it
shows in the NUL-stdin limit). The suite reads these codes
through `Bun.spawn`, whose exit code on Windows is only the low byte of the real one
(source-checked, Bun 1.4.5 `src/spawn/process.rs`). The full code, read as
`$LASTEXITCODE` by an outer Windows PowerShell 5.1 `powershell.exe` with `x` on stdin:
an entry's `process.exit(256)` gives 0 and `process.exit(3221225477)` gives 5, alike
through bare `bun.exe`, through the starter called directly (5.1 and 7 legs) and through
the `bin\bash.exe` forwarding (executed, CI 45589361806, commit `3f6487a`, jobs
139119150551, 139119150607 and 139119150205, and again in CI 45597390051, commit
`f12fa1d`). So Bun 1.4.5 on Windows itself exits with the low byte of the entry's code,
and the starters and the forwarding pass on what Bun exits with, unchanged, for these
values: an entry's exit code on Windows is 0 to 255. The forwarding runs Windows
PowerShell 5.1 when `$SYSTEMROOT` has it (source-checked, `getty-bun.sh`
`forward_to_powershell`; executed but indirect: in the pwsh scenario job 139086960775
of CI 45579886904 the orphaned process left by the forwarded call is named
`powershell`, not `pwsh`). A PowerShell exit code from `0xC0000000` up (an NTSTATUS)
maps differently on the forwarding's two paths. A caller outside MSYS, such as a host,
sees by `exec` 2816 for an access violation, 1024 for an illegal instruction, 2560 for
no memory, 512 for a Ctrl+C exit and 127 for any other, and through the empty pipe of
the NUL-stdin limit 139, 132, 138 and 130, with 127 staying 127. A caller inside MSYS,
such as a Git Bash shell, gets `$?` 139, 132, 138, 130 and 127 on both paths.
(Source-checked, first by the Windows reviewer, `git-for-windows/msys2-runtime` at
`5a1665c8a0fb`, `winsup/cygwin`: `pinfo.cc` 122-184 maps the NTSTATUS to SIGSEGV,
SIGILL, SIGBUS or SIGINT, which are 11, 4, 10 and 2 (`include/cygwin/signal.h` 351-361),
or to exit 127; `pinfo.cc` 205-240 swaps the bytes of the wait status only for a caller
outside MSYS (232); `spawn.cc` 929 takes that path after `exec`; `sigproc.cc` 1341
hands the wait status to a waiting MSYS parent; `dcrt0.cc` 1261 makes the shell's
`exit $?` pass on the low byte. That the shell's `$?` for a child ended by signal N is
128 plus N: the bash manual, EXIT STATUS, checked in the bash 5.2.37 manual page, not in
Git Bash's 5.3.15. On the empty-pipe path bash may also print its own line for the
signal, such as `Segmentation fault`, on stderr: not checked.) What the NTSTATUS of a
native crash becomes through Git Bash, on either path: not measured.

**Limit: Git Bash with a NUL stdin.** Git Bash started with a NUL handle as stdin (what
Bun's stdin `"ignore"` or an empty buffer gives) shows fd 0 as `/dev/null`, `[ -t 0 ]`
false. An MSYS program reading it gets end of input at once (`cat | wc -c` prints 0),
but a native program started with that fd 0 blocks: `powershell.exe` prints
`[Console]::IsInputRedirected` as True and then blocks in `Read`, and the forwarded call
blocks too, also with `MSYS=disable_pcon`. Git for Windows' `bin\bash.exe` wrapper is
not the cause: `usr\bin\bash.exe` started directly blocks the same way. A pipe closed at
once is not affected: MSYS shows `pipe:[0]`, `powershell.exe` reads 0 bytes and the
forwarded call exits 0. (Executed, CI 45589361806, commit `3f6487a`, rows a to d of the
stdin diagnostics and the asserted `usr\bin\bash.exe` case, in each of the three Windows
test jobs 139119150551, 139119150607 and 139119150205; the cause inside MSYS: not
checked.) The forwarding therefore gives PowerShell an empty pipe (`: | powershell.exe
...`, then `exit $?`) when stdin is a character device but no terminal, and keeps `exec`
for a terminal, pipe, file or closed stdin. On Git Bash this ends the hang:
`[ -c /dev/stdin ]` holds for an inherited NUL handle (row a prints `notty`, `chr`,
`/dev/null`; for a pipe closed at once `notty`, `notchr`, `pipe:[0]`), the asserted
`usr\bin\bash.exe` case and a `</dev/null` redirected inside Git Bash exit 0, the
forwarding with `MSYS=disable_pcon` and the `bin\bash.exe` variants (shared console,
`windowsHide`, detached) exit 0 with no output, and the runner's orphan cleanup
terminated no process. A raw `powershell.exe` under MSYS with that stdin still blocks:
the MSYS behavior itself is unchanged. (Executed, CI 45597390051, commit `f12fa1d`, in
each of the three Windows test jobs 139146959172, 139146959347 and 139146959363. The
rule itself: source, `getty-bun.sh` `forward_to_powershell`, and the local check above,
k18.) A `/dev/null` that bash opens itself (`exec </dev/null` inside `bin\bash.exe`,
with `x` on bash's own stdin) is a character device as well (`chr`), so the forwarding
gives it the empty pipe too; yet a raw `powershell.exe` reading it prints True and reads
0 bytes without blocking. In these rows only the inherited NUL handle blocks (row c timed
out again). So far as this row shows, such a `/dev/null` needs no empty pipe; through
the pipe the entry's code still comes back (42, see the exit-code limit). (Executed, CI
45601335472, commit `31a10b0`, jobs 139160728685, 139160728299 and 139160727955; that it
takes the empty pipe: source; the cause inside MSYS: not checked.) On the empty-pipe
path the shell waits for PowerShell, with its own traps removed: a signal sent to the
shell's PID ends only the shell, and PowerShell and Bun keep running (local
check on Linux with a fake PowerShell, which shows it for PowerShell only; on Git Bash:
not checked; k13). Before the rule, such a hang could leave `bun.exe` behind (executed:
the runner terminated an orphaned bash, powershell and bun at the end of each of the
three Windows test jobs of CI 45579886904; k13). A pipe with data through
`bin\bash.exe` passes (executed, CI 45579886904). For Claude Code the windows-developer
repository measured that the hook JSON arrives on stdin and then end of input
(`docs/hook-start-windows.md` there, Claude Code 2.1.287), so that stdin is no NUL
handle; that it is a pipe, which the forwarding hands on by `exec`: inferred, the note
does not record the handle type. For Codex: not measured.

**Limit: MSYS path conversion.** The forwarding sets `MSYS_NO_PATHCONV=1` and
`MSYS2_ARG_CONV_EXCL='*'` so that the MSYS runtime does not rewrite arguments that look
like POSIX paths. Both stay in the environment of PowerShell, Bun and the entry: an MSYS
program the entry starts (`bash`, Git's tools) then passes POSIX paths to native
programs unconverted. The starters leave them in place, since they cannot tell them from
values the user set.
