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
| `getty-bun.sh`, `getty-bun.ps1` | The starters (POSIX `sh` on Linux and macOS, Windows PowerShell 5.1 and 7); each carries one pin block |
| `getty-bun.cmd` | The polyglot for Claude Code hooks in shell form (below, "Polyglot"); it carries no pin block |
| `render-template.ts` | Generates the starters of the skilletor template `getty-bun-install` (`skills/getty-bun-install/bootstrap/*.njk`) from the starters and the whole table and copies `getty-bun.cmd` there, or checks them |

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

(One target shown; every version lists all seven.)

- `versions` maps an exact Bun version to its entry. A new version is a new key; existing
  entries are never edited.
- `targets` holds exactly seven targets: `linux-x64`, `linux-x64-baseline`,
  `linux-aarch64`, `darwin-x64`, `darwin-aarch64`, `windows-x64`,
  `windows-x64-baseline`. A missing or an extra target fails the render. musl and
  `windows-aarch64` come later as new targets in the render and the starters, then in
  the table (ADR 0005). There is no `darwin-x64-baseline` (below, "macOS").
- `archive`: the release asset's file name, a plain `.zip` name. The download URL is
  `<base>/bun-v<version>/<archive>`, `<base>` being `GETTY_BUN_MIRROR` or
  `https://github.com/oven-sh/bun/releases/download` (for Bun's own assets this is the
  plan's `bun-<target>.zip`). `GETTY_BUN_MIRROR` takes the downloader's schemes:
  `getty-bun.sh` those of curl (http, https, file, ...) or, without curl, of wget (http,
  https, ftp; no file); `getty-bun.ps1` http, https and file. (file with curl: executed,
  CI 45589361806, scenario jobs linux-x64 139119150180 and linux-arm64 139119150223; the
  wget path: not checked, the suite never runs it. file with `getty-bun.ps1`: executed,
  CI 45589361806, scenario jobs Windows PowerShell 5.1 139119150551 and PowerShell 7
  139119150607, and a local run with pwsh 7 on Linux, not in CI.)
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
and `unzip -l`; the two `darwin` rows on 2026-11-27 with `sha256sum -c` against the
signed `SHASUMS256.txt` and `unzip -Z1`):

| Target | Archive | SHA256 | Member |
|---|---|---|---|
| `linux-x64` | `bun-linux-x64.zip` | `94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb` | `bun-linux-x64/bun` |
| `linux-x64-baseline` | `bun-linux-x64-baseline.zip` | `dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463` | `bun-linux-x64-baseline/bun` |
| `linux-aarch64` | `bun-linux-aarch64.zip` | `18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84` | `bun-linux-aarch64/bun` |
| `darwin-x64` | `bun-darwin-x64.zip` | `a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd` | `bun-darwin-x64/bun` |
| `darwin-aarch64` | `bun-darwin-aarch64.zip` | `b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10` | `bun-darwin-aarch64/bun` |
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
| 1.4.5 | 2026-11-19 08:48:42 UTC, good signature by `F3DCC08A8572C0749B3E18888EAB4D40A7B22B59` | 2026-11-25, GnuPG 2.4.7, throwaway `GNUPGHOME`; again 2026-11-27 for the `darwin` rows (same signature date and signer, GnuPG 2.4.7, throwaway `GNUPGHOME`, the commands below) |

## Adding a version

ADR 0005. Downloads are untrusted data: each release goes into its own new, empty
directory under `.dev/` (gitignored); never use your own keyring.

```sh
v=1.4.6                                   # the version to add
d=.dev/release/bun-v$v
mkdir -p .dev/release && mkdir "$d"       # fails if it exists: must be new and empty
base=https://github.com/oven-sh/bun/releases/download/bun-v$v
curl -fsSL --proto '=https' -o "$d/SHASUMS256.txt.asc" "$base/SHASUMS256.txt.asc"
for t in linux-x64 linux-x64-baseline linux-aarch64 darwin-x64 darwin-aarch64 windows-x64 windows-x64-baseline; do
  curl -fsSL --proto '=https' -o "$d/bun-$t.zip" "$base/bun-$t.zip"
done

export GNUPGHOME="$(mktemp -d "$PWD/.dev/gnupg.XXXXXX")"   # mode 700, empty
sed -n '/^-----BEGIN PGP PUBLIC KEY BLOCK-----$/,/^-----END PGP PUBLIC KEY BLOCK-----$/p' \
  bootstrap/README.md | gpg --batch --import
gpg --batch --assert-signer F3DCC08A8572C0749B3E18888EAB4D40A7B22B59 \
  --verify --output "$d.verified.txt" "$d/SHASUMS256.txt.asc"   # must exit 0

(cd "$d" && grep -E '  bun-(linux-x64|linux-x64-baseline|linux-aarch64|darwin-x64|darwin-aarch64|windows-x64|windows-x64-baseline)\.zip$' \
  "../bun-v$v.verified.txt" | sha256sum -c -)                  # seven OK
for t in linux-x64 linux-x64-baseline linux-aarch64 darwin-x64 darwin-aarch64 windows-x64 windows-x64-baseline; do
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
  starters for the new version and run the scenario suite against them. Regenerate the
  template with `render-template.ts`: it embeds every version of the table. The commit names
  the verification (signer fingerprint, signature date, GnuPG version).

## Pin block

Each starter carries exactly one pin block. Both starters carry it byte for byte
identical: every line is a `#` comment, which is a comment in `sh` and in PowerShell.
The block is the only thing that selects the Bun version and the archive.

Format:

```
# >>> getty-bun pin: generated, do not edit >>>
# version <version>
# platforms <platform> [<platform>...]
# target <target> <archive> <sha256> <member>
# <<< getty-bun pin <<<
```

- The first and last lines are fixed marker lines, exactly as shown.
- The second line is the version line. Then, only when the consumer declares its
  platforms (`render-pin.ts --platforms`, `vars.bun_platforms`), one platforms line:
  each of `linux`, `darwin`, `windows` at most once, at least one, in the declared
  order. Then one target line per target, in this order: `linux-x64`,
  `linux-x64-baseline`, `linux-aarch64`, `darwin-x64`, `darwin-aarch64`, `windows-x64`,
  `windows-x64-baseline`. Ten lines in all, eleven with the platforms line.
- A starter whose platform the platforms line does not list does nothing: `run`,
  `run-ready` and `ensure` exit 0 with nothing on stdout and one `getty-bun: ` line on
  stderr, without detecting the target or touching the store; `status` prints
  `{"pin":"<version>","target":null,"slot":null,"state":"undeclared"}` and exits 0.
  `getty-bun.sh` is `linux` or `darwin` (`uname -s` `Linux`, `Darwin`; any other system
  is its lower-cased `uname -s`, so it is undeclared too); under Git Bash it forwards
  before reading the pin, so `getty-bun.ps1` decides as `windows`. The usage, `GETTY_HOME`,
  `GETTY_BUN_LOCK_WAIT` and pin checks come first and still fail with exit 1. Without a
  platforms line every platform is declared.
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
# target darwin-x64 bun-darwin-x64.zip a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd bun-darwin-x64/bun
# target darwin-aarch64 bun-darwin-aarch64.zip b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10 bun-darwin-aarch64/bun
# target windows-x64 bun-windows-x64.zip 815ab45ec7f549abf87e6869584b506eab088e24225683957b7e150b47d6de30 bun-windows-x64/bun.exe
# target windows-x64-baseline bun-windows-x64-baseline.zip 3c081c73865e7a3453a9d514cc2ba3d699880621bcf67bb17241ff5194cb1d4b bun-windows-x64-baseline/bun.exe
# <<< getty-bun pin <<<
```

With `--platforms linux,darwin` the line `# platforms linux darwin` follows the version
line.

**Reading it in a starter.** Read the starter's own file line by line; from the begin
marker on, take the line starting with `# version `, the line starting with
`# platforms ` if there is one, and the line starting with
`# target <detected target> ` (with the trailing space, so `linux-x64` does not match
`linux-x64-baseline`); stop at the end marker. Compare whole lines and prefixes as
plain strings, never as regular expressions or after trimming. Split the target line's
rest on single spaces into archive, SHA256 and member. A missing block, a missing
version line or a missing target line is a starter failure (one `getty-bun: ` line,
exit 1), never a fallback. The fast path needs only the version line; the target line
is needed for install.

- `sh`: one `while IFS= read -r line` loop over the file with `case` on the exact
  strings; it keeps the target lines and picks the detected target's line after the
  target is known (the x64 choice looks at the slots, which needs the version); no
  subprocess. A loop of this shape parsed the 1.4.5 block under `dash` in
  about 3 ms per run, process start included.
- PowerShell: `[System.IO.File]::ReadAllLines($PSCommandPath)`, exact comparison
  (`-ceq`, `StartsWith(..., [StringComparison]::Ordinal)`), `.Split(' ')`. Not
  `-match` (regex) and not `Select-String`.

## Render CLI: `render-pin.ts`

```
bun bootstrap/render-pin.ts --table FILE --version V [--platforms P,...] FILE...
bun bootstrap/render-pin.ts --table FILE --version V [--platforms P,...] --check FILE...
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
- `--platforms` takes a comma-separated list of `linux`, `darwin`, `windows` (each at
  most once, at least one) and adds the platforms line; without it the block has none.
  For a consumer's CI: the list is `package.json` `gettyBun.platforms`, in its order.
- Options may come in any order; every other argument is a `FILE`, which therefore must
  not begin with `-`.

| Exit | When |
|---|---|
| 0 | Every `FILE` rendered (or, with `--check`, equal to a fresh render) |
| 1 | Anything else, with one stderr line beginning `getty-bun: `; never 2 |

Failures, each one line; all but a write error are found before any file is written:

- usage (missing `--table`, `--version` or `FILE`, unknown option, `--platforms` twice)
- `platforms: unknown platform "<p>"`, `platforms: <p> is listed twice`,
  `platforms: at least one of linux, darwin, windows is needed`
- table unreadable or not JSON (`cannot read table <path>: ENOENT`)
- `version <V> is not in table <path>`
- a target missing or unknown, or a field of the wrong shape, naming version and target
- `<file>: pin block markers not found`, `more than one pin block`,
  `end marker before begin marker` (a file with CRLF line endings has no marker lines)
- `cannot read file <path>`, `cannot write file <path>`

Only the selected version's entry is validated.

## Template render: `render-template.ts`

```
bun bootstrap/render-template.ts [--check] [--nunjucks DIR]
```

Writes `skills/getty-bun-install/bootstrap/getty-bun.sh.njk` and `getty-bun.ps1.njk`
from `getty-bun.sh`, `getty-bun.ps1` and `versions.json` (fixed paths), exec bit taken
from the starter, and copies `getty-bun.cmd` byte for byte, exec bit included, to
`skills/getty-bun-install/bootstrap/getty-bun.cmd`: it holds no pin, and skilletor
copies a file without `.njk` byte for byte (skilletor's `references/templates.md`,
"Rendering"), so the template needs no nunjucks quoting for it. Each `.njk` is the starter in nunjucks `{% raw %}` regions, its pin
block replaced by a lookup of `vars.bun_version` in a table of the rendered pin block of
every version (keys `"pin <version>"`: no `Object.prototype` member has a space). A
missing `vars.bun_version` or one not in the table calls the undefined function
`vars_bun_version_is_missing_or_not_in_the_getty_bun_install_version_table`, so the
render fails with that name in the message (skilletor renders with
`throwOnUndefined`, which alone would only catch printing an undefined value). Each
version's block is split after its version line; there, `vars.bun_platforms` (optional, a
list) renders the platforms line as `render-pin.ts --platforms` does, and a value that is
not a non-empty list of unique `linux`, `darwin`, `windows` (an unknown or repeated name,
an empty list, a string, `null`) calls the undefined function
`vars_bun_platforms_must_be_a_list_of_unique_linux_darwin_windows` and fails the render.
Without `vars.bun_platforms` the block is the one without the line. A starter
that contains a nunjucks raw tag cannot be quoted and fails the generation. Every
version is validated as `render-pin.ts` validates the selected one.

- `--check`: writes nothing; exit 1 when a `.njk` differs from a fresh generation (text
  or exec bit), or the copy of `getty-bun.cmd` from `bootstrap/getty-bun.cmd` (bytes or
  exec bit). The gate against drift between `bootstrap/` and the template.
- `--nunjucks DIR`: a nunjucks package directory (skilletor uses nunjucks `^3.2.4`; the
  repository has no nunjucks dependency, so install it in a scratch directory under
  `.dev/`). After generating or checking, renders each `.njk` as skilletor does
  (`autoescape: false`, `throwOnUndefined: true`, context `{ vars }`) and fails unless
  every table version renders byte for byte to the starter with that version's pin
  block, the starter's own pin renders to the starter file itself, `bun_platforms`
  `["linux"]`, `["linux", "darwin"]` and `["windows", "darwin", "linux"]` render to the
  block with that platforms line, `vars` without `bun_version`, with `0.0.0-unknown` and
  with `constructor` fail with the first name above, and `bun_platforms` `[]`, `["bsd"]`,
  `["linux", "linux"]`, `["Linux"]`, `"linux"` and `null` fail with the second.

```sh
mkdir -p .dev/njk && (cd .dev/njk && echo '{"private":true}' >package.json && ../harness/bun add nunjucks@3.2.4)
.dev/harness/bun bootstrap/render-template.ts --check --nunjucks .dev/njk/node_modules/nunjucks
```

Exit 0 when everything holds; otherwise 1 with one `getty-bun: ` stderr line per finding.

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

## Starting Bun: no project configuration

A hook runs with the user's project as its working directory, and the starter keeps that
directory (the SDK reports it as `process.cwd()`). Bun would read the project's
`bunfig.toml` (`preload` runs code before the entry, `[define]` rewrites the entry's
code), its `.env`, `.env.local` and `.env.<NODE_ENV>`, and flags from `BUN_OPTIONS`
(`--preload` included, even past `--config`). Other variables in the hook's environment
load code or move it outside the plugin, and `--config` does not touch them:
`BUN_INSPECT_PRELOAD` adds a preload, `BUN_INSPECT` and `BUN_INSPECT_CONNECT_TO` start the
debugger, whose client evaluates code, `NODE_PATH` resolves bare specifiers outside the
plugin, `NODE_COMPILE_CACHE` and `BUN_RUNTIME_TRANSPILER_CACHE_PATH` pick cache
directories whose entries Bun restores as code, and `BUN_INTERNAL_WEBVIEW_HOST` (macOS)
turns the process into a webview host that never runs the entry. So the starters run the
entry as

```
<slot>/bin/bun --no-install --config=<empty file> --no-env-file <root>/<entry> [args...]
```

and the staging probe as `bun --config=<empty file> --no-env-file --version`, each with
`BUN_OPTIONS`, `BUN_INSPECT_PRELOAD`, `BUN_INSPECT`, `BUN_INSPECT_CONNECT_TO`, `NODE_PATH`,
`NODE_COMPILE_CACHE` and `BUN_INTERNAL_WEBVIEW_HOST` removed from Bun's environment, so
the entry does not see them either, and `BUN_RUNTIME_TRANSPILER_CACHE_PATH` set to `0`
(k46): removing it would let Bun pick its default cache directory, and Bun writes a
`.pile` per transpiled non-bundled entry into the user's cache. `0` turns that cache off;
a bundle built with `--target=bun` (`// @bun`) is not cached either way. (Bun 1.4.5
linux-x64, executed 2026-11-27 with `getty-bun.sh`: a 320 KB `.ts` entry run through
the starter with the variable set to a directory and `XDG_CACHE_HOME` and `HOME` empty
wrote nothing; the same Bun with the same flags and no variable wrote
`$XDG_CACHE_HOME/bun/@t@/<hash>.pile`.)
`getty-bun.sh` uses `/dev/null` as the empty file: it exists on every POSIX system and
needs nothing created. `getty-bun.ps1` has no `/dev/null` (and `NUL` is not checked), so
it keeps one empty file for all versions at `<GETTY_HOME>\runtimes\bun\.config\bunfig.toml`,
created by `run` and `ensure` with an atomic rename when it is missing; a file with
content or a directory at that path fails with exit 1 and is left alone. `status`
creates nothing. A `--config` file that does not exist makes Bun exit 1, which a
caller cannot tell from an entry's exit 1, so the file must exist. Under Git Bash the sh
starter removes these variables before it forwards to PowerShell; `getty-bun.ps1` removes
them from its own process environment once, at the start, and never edits the child's
environment block (.NET rebuilds that block and throws on names that differ only in case,
such as `Path` and `PATH`). The scenarios in `bootstrap/test/hostile-cwd.test.ts` and the
gate check all of this on every CI leg, Windows PowerShell 5.1 and pwsh included (all
16 jobs green in CI run 45905322296; the run before it failed on pwsh, which shows the
k40 checks ran there). (Bun 1.4.5 linux-x64:
executed; without these, a project `preload`, a `[define]`, `.env`, `.env.local` and a
`BUN_OPTIONS` preload all reached the entry; with them none did. k40, same platform: the
suite removes all seven other variables and checks that none reaches the entry. Its
controls ran a raw Bun with these flags: a `BUN_INSPECT_PRELOAD` module ran before the
entry, `NODE_PATH` resolved a bare specifier outside the plugin, and `NODE_COMPILE_CACHE`
and `BUN_RUNTIME_TRANSPILER_CACHE_PATH` made Bun write to the chosen directories (that
Bun restores those entries as code is source-checked at `bun-v1.4.5`). The debugger
effect was executed only by a raw probe outside the suite: `BUN_INSPECT` opened a
listener, `BUN_INSPECT_CONNECT_TO` dialled `tcp://` and `unix://` addresses; a
`BUN_INSPECT` value with `?wait=1` held the process until a debugger attached, which
holds a hook until the host's timeout. `BUN_INTERNAL_WEBVIEW_HOST` is source-checked
only (macOS). The variables kept are in the table below; loader variables such as
`LD_PRELOAD` are not Bun's and out of scope.
`bun --version` ignores a project `bunfig.toml` and a `BUN_OPTIONS` preload, but
`BUN_OPTIONS=--help` replaced its output and failed the install. `~/.bunfig.toml`, `$XDG_CONFIG_HOME/.bunfig.toml`, a
`bunfig.toml` in the parent directory and `NODE_OPTIONS=--require` had no effect on a file
run. A bundle built with `bun build --target=bun` (marked `// @bun`) is not rewritten by a
project's `[define]`; a plain entry is.)

The cleanup reaches the whole process tree below the starter: whatever the entry starts
(`node`, `npm`, another Bun) inherits the cleaned environment, so it loses the user's
`NODE_PATH` and `NODE_COMPILE_CACHE`, and debugging an entry with `BUN_INSPECT` through the
starter does not work; run the slot's Bun by hand for that (k47).

Variables Bun reads that the starters keep, because they load no code (k40, k48):

| Variable | Bun 1.4.5 source | Verdict |
|---|---|---|
| `NODE_OPTIONS` | | Bun ignores it for a file run (`--require` in it had no effect, executed above) |
| `XDG_CACHE_HOME`, `HOME` | | The user's own directories; with the transpiler cache at `0` the entry writes no cache there |
| `NODE_CHANNEL_FD` | | An IPC descriptor from a parent; loads no code |
| `NODE_DISABLE_COMPILE_CACHE` | `src/bun_core/env_var.rs:188`; `src/jsc/NodeCompileCache.rs:292-312` (start-up), `:334-346` (`module.enableCompileCache()`) | Harmless: only switches the compile cache off; it never loads or writes anything |
| `NODE_COMPILE_CACHE_PORTABLE` | `src/bun_core/env_var.rs:186`; `src/jsc/NodeCompileCache.rs:285-288` | Harmless: only makes cache keys relative to the cache directory. It acts only on a cache that is on, and with `NODE_COMPILE_CACHE` removed only the entry itself can turn one on (`module.enableCompileCache()`), in a directory it chooses |
| `BUN_JSC_*` | `src/jsc/bindings/ZigGlobalObject.cpp:305-307`, `:385-403`; `src/jsc/lib.rs:552-563` | Harmless for isolation: each sets one JavaScriptCore option (JIT tiers, GC, profiling, diagnostics), applied before any code runs; none loads code. A user's debugging switch: `BUN_JSC_samplingProfilerPath` with `BUN_JSC_useSamplingProfiler=1` writes a profile into the named directory at exit, and an unknown option name makes Bun exit 1 with its own `error: invalid JSC environment variable` before the entry runs, which a caller cannot tell from an entry's exit 1. `bun --version`, the staging probe, ignores them |

(Source-checked at tag `bun-v1.4.5`, commit `a7733435cf40`, in a sparse clone of
`oven-sh/bun`'s `src/`, 2026-11-27; the JavaScriptCore option list itself, in Bun's WebKit
fork, was not read. Executed 2026-11-27 with Bun 1.4.5 linux-x64-baseline, same commit,
the starter's flags: `BUN_JSC_noSuchOption=1` exit 1 with that error and the entry not
run, `--version` with it 1.4.5 and exit 0; `BUN_JSC_useJIT=0` ran the entry; the sampling
profiler wrote `SamplingProfile.*.txt` into the named directory; with
`NODE_DISABLE_COMPILE_CACHE=1` `module.enableCompileCache(<dir>)` returned status 3,
"Disabled by NODE_DISABLE_COMPILE_CACHE", and wrote nothing; `NODE_COMPILE_CACHE_PORTABLE=1`
ran the entry unchanged.)

## POSIX starter: tools

`getty-bun.sh` runs under any POSIX `sh` (tested with `dash` and `busybox sh`) on Linux
and macOS. The fast path uses only shell builtins and `uname`, plus `sed` on Linux x64
while neither x64 slot exists and `/usr/sbin/sysctl` on an x64 macOS (below, "POSIX
starter: targets"). An install also needs, on `PATH`:

| Tool | Requirement |
|---|---|
| `flock` (Linux) | util-linux `flock`: the starter uses `-w` (bounded wait) and `-E` (timeout exit code) |
| `perl` (macOS) | The Perl macOS ships (`/usr/bin/perl`, which `/usr/bin/shasum` runs on too), with the core modules `Fcntl` and `Time::HiRes` |
| `unzip` | Info-ZIP `unzip`: the starter lists members with `-Z1`, which BusyBox `unzip` lacks. A BusyBox built to prefer its applets (Debian's `busybox-static` 1.37.0) runs its own `unzip` before `PATH` when it is the `sh`, so an install under it fails at the member list with one `getty-bun: ` line; the fast path needs no `unzip` (executed 2026-11-27 on Linux, measured by the reviewer: with `sh` resolving to that BusyBox, 98 of the current suite's 230 tests fail, every install with that line; 2 of the 98 because its `uname` applet likewise runs before the suite's fake `uname` on `PATH`; card `k60`) |
| `curl`, or else `wget` | `curl` with `-q` (no `~/.curlrc`); GNU Wget 1.16 or later with `--no-config` (no wgetrc); BusyBox `wget` has no `--no-config` |
| `sha256sum`, or else `shasum` | coreutils `sha256sum`, or Perl's `shasum -a 256` |
| `mktemp`, `mkdir`, `mv`, `rm`, `chmod`, `date`, `id`, `tr`, `cat`, `sleep`, `kill` | coreutils (tested) or the macOS base system (not checked); `mktemp` needs `-d` with a template |

Neither fetcher reads its configuration files, so a `~/.curlrc` or `~/.wgetrc` cannot
change the download; a proxy comes from the usual environment variables (`https_proxy`,
`no_proxy`). A missing tool fails before anything is written, with one `getty-bun: `
line naming it; a tool of the wrong kind fails at the step that uses it, also with one
line.

## POSIX starter: targets, `run-ready`, download

**Targets.** `uname -s` and `uname -m`, on every call. Linux: `x86_64` -> x64, `aarch64`
or `arm64` -> `linux-aarch64`; no glibc loader but a musl one fails as unsupported. On
x64 the starter takes the first slot that exists of `linux-x64`, then
`linux-x64-baseline`, as `getty-bun.ps1` does on Windows: `ready` runs it, `mismatch`
fails closed, and a mismatching `linux-x64` slot is never skipped for a ready baseline
one. Only when neither exists does it read the CPU: `linux-x64` when the first `flags`
line of `/proc/cpuinfo` lists `avx2` (one `sed` that stops at that line), otherwise or
when it cannot be read `linux-x64-baseline`. `status` with neither slot reports `missing`
and that detected target. macOS (`Darwin`): `arm64` -> `darwin-aarch64`; `x86_64` ->
`darwin-x64`, unless `/usr/sbin/sysctl -n sysctl.proc_translated` prints `1` (a shell
under Rosetta 2 on Apple silicon), which selects `darwin-aarch64`, the binary Bun's own
installer picks there too. Any other system or machine is unsupported (exit 1).

Cost on Linux, linux-x64 host with AVX2 (Xeon E5-2680 v4, `dash`, Bun 1.4.5), measured
2026-11-27, N = 20 interleaved, wall clock per call:

| Call | 0.1.0 starter, median | this starter, median |
|---|---:|---:|
| `run` of a one-line entry, slot ready | 34.3 ms | 10.7 ms |
| `status`, slot ready | 27.6 ms | 4.6 ms |
| `status`, no slot (CPU read) | | 8.3 ms |
| the slot's Bun alone, same entry and flags | 6.8 ms | 6.8 ms |

`bootstrap/test/measure-hook.ts 20` on the same host: starter overhead over the bare Bun
28 ms before, 4 ms after (0.1.0 read `/proc/cpuinfo` with a shell `read` loop, one byte
per system call, on every call).

**macOS.** Evidence: source-checked against Apple's and Bun's documentation and the
binaries; macOS itself runs only in CI. No `darwin-x64-baseline` target, for two
reasons. In Bun 1.4.5 `bun-darwin-x64.zip` and `bun-darwin-x64-baseline.zip` carry
byte-identical `bun` executables (98251056 bytes, `cmp` finds no difference; so do
`linux-x64` and `linux-x64-baseline`, 107394952 bytes; executed 2026-11-27 on the
signature-checked archives). And every darwin binary declares macOS 13.0 as its minimum
(`LC_BUILD_VERSION` minos 13.0.0, SDK 26.5, read from the Mach-O headers), whose Intel
Macs (Apple, "macOS Ventura is compatible with these computers", support.apple.com
102861, fetched 2026-11-27: MacBook Pro and iMac 2017 and later, MacBook 2017, MacBook
Air 2018 and later, Mac mini 2018, iMac Pro 2017, Mac Pro 2019) all have Kaby Lake or
newer cores, or Skylake-W and Cascade Lake-W Xeons, all with AVX2 (documented by Intel,
not fetched). A hypervisor that hides AVX2 from a macOS guest, or an unsupported Mac
patched to run macOS 13, is not covered; there the identical binary would behave as the
baseline one does. Bun's `install.sh` (bun.sh/install,
fetched 2026-11-27) still probes AVX2 on `darwin-x64` for pinned older versions and says
current releases alias the name. The lock: macOS ships no `flock(1)`; `/usr/bin/lockf`
runs a command under a lock (it cannot lock the starter's fd 9), and `shlock` decides by
PID, which the lock rules forbid. So `getty-bun.sh` on macOS takes the same `flock(2)`
lock through `perl` on the inherited fd 9, polling every 50 ms with `LOCK_NB` until
`GETTY_BUN_LOCK_WAIT` runs out (exit 3, the same timeout message as with `flock -E 3`);
the lock stays with the open file on fd 9 when perl exits and closes with the install's
command group, before Bun starts. (The perl lock executed on Linux, perl 5.40.1, in a
copy of the starter forced onto it: timeout after 2024 ms with `GETTY_BUN_LOCK_WAIT=2`,
18 ms with 0, three parallel `run`s sharing one download, and mutual exclusion with
`flock(1)` both ways. On macOS: not checked; it runs only in the CI macOS legs of
release 0.2.0, item 5.)
Hashing: `sha256sum` when on `PATH`, else `shasum -a 256`; no `/proc`: the `.installing`
record has `processStartToken` and `environmentId` `null` there.

**`run-ready <entry> [args...]`.** The x64 slot choice and the checks of `run`. The slot
`ready`: exactly `run`. `missing`: exit 0, nothing on stdout, and on stderr
`getty-bun: Bun <version> <target> is not installed yet (<slot>); run-ready skipped <entry>`;
no lock, no staging, no download. `mismatch`, an invalid environment or an unsupported
target: as `run`, exit 1.

**Download.** Under the install lock the archive downloads to
`<GETTY_HOME>/runtimes/bun/.downloads/<version>/<target>/<archive>.part`, resumed when
an earlier install left part of it (`curl -C -`, `wget -c`). A server that ignores the
range starts the file over: curl exits 33 without writing, the starter removes the
`.part` and downloads again; wget restarts by itself. An interrupted install (signal,
SIGKILL, timeout, network error) keeps the `.part`; a checksum mismatch after the
download deletes it before the failure. A verified archive moves into the staging
directory, so a published install leaves the download directory empty. The fetcher runs
in the background with its stdin, stdout and stderr away from the caller's and fd 9
closed; beside it a watchdog subshell checks once a second whether the starter still
exists (`kill -0`) and stops the fetcher when it does not. A signal the starter traps
(HUP, INT, TERM) stops both through the exit cleanup. (Executed 2026-11-27 against a
local mirror sending 64 KiB per 100 ms: after `kill -9` of the starter, `curl` was gone
461 ms later in three runs, and each next install resumed with `Range: bytes=<n>-`;
TERM, INT and HUP ended the starter with exit 1 within 2 ms, no child left, staging and
`.installing` removed, the `.part` kept; resume against a range server, restart against
one without, and the deletion after a checksum mismatch with curl 8.14.1 and GNU Wget
1.25.0.) **Limit:** the watchdog sees a starter that is killed but not yet reaped by its
parent (a zombie) as alive, so the download runs on until its parent reaps it; a host
process that never waits for its children keeps it running (executed with a Python
parent that waited only after six seconds: `curl` stopped 0.5 s after the reap).

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

**Evidence.** The labels in this section say what backs a claim. *Executed, CI
45572032454*: the shared scenario suite in CI run 45572032454 (commit `d822139`) on
GitHub's `windows-2025-vs2026` image 20261116.315.1, under Windows PowerShell
5.1.26100.33822 and PowerShell 7.6.10, with Git for Windows' bash 5.3.15 and Defender
real-time protection off. *Source-checked (`getty-bun.ps1:<lines>`)*: read in the
starter at those lines. *A local run with pwsh 7 on Linux, not in CI* adds to a source
check: the Windows worker's local unit tests on PowerShell 7.7.0 on Linux, which are not
in the repository and ran neither on Windows nor under 5.1; such a run is no label of
its own. *Not checked*: nothing has run it.

**Targets.** `windows-x64` when `IsProcessorFeaturePresent` reports AVX2, otherwise
`windows-x64-baseline`; the check compiles through `Add-Type`, and where that cannot
load (Constrained Language Mode, no compiler) the answer is `windows-x64-baseline`. An
x64 Bun whose `--version` probe dies with `STATUS_ILLEGAL_INSTRUCTION` publishes
nothing; the starter then installs `windows-x64-baseline` under that target's own
lock. ARM64 fails as an unsupported target. (The `Add-Type` check and the ARM64 failure,
simulated through `PROCESSOR_ARCHITECTURE`: executed, CI 45572032454; there the check
chose `windows-x64`, logged as `target windows-x64` by both per-hook cost jobs after a
fresh `ensure` (jobs 139060757366 and 139060757556). The illegal-instruction fallback:
source-checked (`getty-bun.ps1:583-600`), a local run with pwsh 7 on Linux and a
fixture probe that exits with that code, not in CI. A real CPU without AVX2, and
Constrained Language Mode, which also restricts the .NET calls the rest of the starter
makes: not checked.)

**Fast path.** The starter takes the first slot that exists of `windows-x64`, then
`windows-x64-baseline`, without detecting the CPU: `ready` runs it, `mismatch` fails
closed (a damaged `windows-x64` slot is never skipped for a ready baseline slot), and
only when neither exists does it detect the target and install. `status` reports that
slot, or, with neither present, the detected target's. The fast path uses no `Add-Type`
and no cmdlet from a module that 5.1 would have to load (`[type]::new()`, never
`New-Object`); the per-hook CI job measures what that costs. (`ready`, `mismatch` for a
tampered receipt or a missing or empty `bun.exe`, and `missing`: executed, CI
45572032454. The slot order and the own-functions-only rule: source-checked
(`getty-bun.ps1:179-214`, `:687-737`), a local run with pwsh 7 on Linux, not in CI.)

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
hold a fresh `bun.exe`), a timed-out one is not; the move of the verified archive into
staging and the rename into the slot are retried for about 10 s on sharing violations. (The download window against a stalling and a
trickling local server, the probe kill and the timed-out probe without retry:
source-checked (`getty-bun.ps1:313-349`, `:430-433`, `:448`), a local run with pwsh 7
on Linux, not in CI. The error-mode calls run, best effort, in every install of CI
45572032454; that they took effect and keep a crash dialog away, the probe retry and the
rename and archive move retries: not checked.)

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

**`run-ready`.** As in `getty-bun.sh`: the fast path's slot choice; a `ready` slot runs
as `run`, `mismatch`, an invalid environment and an unsupported target fail as `run`.
With neither slot present it prints
`getty-bun: Bun <version> <target> is not installed yet (<slot>); run-ready skipped <entry>`
on stderr and exits 0; it takes no lock and writes nothing, not even
`.config\bunfig.toml`. It detects no CPU there: `Add-Type` compiles C# and would cost
every hook that runs before the install, so the line names the first candidate,
`windows-x64`, and its slot, which an install on a CPU without AVX2 replaces by
`windows-x64-baseline` (`status` and the install still detect). (A local run with pwsh
7.7.0 on Linux, not in CI, before the detection was dropped: the line, exit 0 and an
absent `GETTY_HOME` afterwards; on Windows: not checked yet, CI legs pending.)

**Download and resume.** Under the install lock the archive downloads to
`<GETTY_HOME>\runtimes\bun\.downloads\<version>\<target>\<archive>.part`, in process
through `HttpWebRequest`, so there is no download process to outlive a killed starter.
Bytes already there (an interrupted install's) are asked for with `AddRange(<length>)`:
a `206` whose `Content-Range` starts at that length appends, any other success (a server
that ignores the range, a `file://` mirror) writes the file over, and a `416` leaves it
as it is for the checksum to decide (curl `-C -` treats a `416` alike); a `206` for
another offset deletes the `.part` and fails. A body that ends before its
`Content-Length` (for a `206`, before the `Content-Range` total) fails with one
`getty-bun: ` line, as curl's exit 18 does, and keeps what arrived for the next install's
resume. A failed, stalled or interrupted download keeps the `.part`; a checksum mismatch deletes it before the failure; a verified archive
moves into the staging directory. (A local run with pwsh 7.7.0 on Linux against a local
range server and a test copy of the starter whose pin names a fixture archive, not in
CI: resume from 100 bytes with `Range: bytes=100-`, a restart against a server that
ignores the range, a `416` on a complete `.part`, the deletion after a mismatch for a
junk and an oversize `.part`, a `404` that kept a 50-byte `.part` and the next install
resuming it with `Range: bytes=50-`. The early end of a body: a local run with pwsh 7.7.0
on Linux, not in CI, against a server that closes after 500 of 1024 bytes (`200`) and
after 100 more (`206`): both failed with the `.part` kept (500, then 600 bytes), and the
next call resumed it to 1024; .NET on pwsh 7 raised the early end itself, so the
starter's own byte count was not reached there; .NET Framework under 5.1, Windows and a
killed download: not checked yet, CI legs pending.)

**Platforms.** The pin's platforms line declares `windows` for `getty-bun.ps1` and so for
the Git Bash forwarding. Without it, after the usage, `GETTY_HOME`,
`GETTY_BUN_LOCK_WAIT` and pin checks and before the architecture check, `run`,
`run-ready` and `ensure` print
`getty-bun: platform windows is not declared in the pin of <starter> (platforms <list>); <command> skipped[ <entry>]`
on stderr and exit 0, and `status` prints
`{"pin":"<version>","target":null,"slot":null,"state":"undeclared"}`; an ARM64 Windows
therefore exits 0 there too. (A local run with pwsh 7.7.0 on Linux, `PROCESSOR_ARCHITECTURE`
`ARM64`, platforms `linux darwin` and `linux windows`, not in CI; on Windows: not checked
yet, CI legs pending.)

**Transpiler cache.** `getty-bun.ps1` sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH` to `0` in
its own process environment (`SetEnvironmentVariable`), where it removes the other
variables, so the probe and the entry inherit it (k46). (A local run with pwsh 7.7.0 on
Linux: the entry saw `0` with the variable set to a directory by the caller; on Windows:
not checked yet, CI legs pending.)

**Entry arguments.** `-File` hands the arguments after the script path to PowerShell's
parameter binding before the script sees them in `$args`: pwsh 7 splits `-x:foo` into
`-x` and `foo`, makes `-x:` and the next argument one parameter, and drops `--%` (pwsh
7.7.0 on Linux, executed below; Windows PowerShell 5.1: not checked). So the
starter takes its arguments from the process's own argument vector,
`[Environment]::GetCommandLineArgs()`, which that binding does not touch: the arguments
after the first `-File` (or `-f`, `-fi`, `-fil`; with `-`, `--` or `/`) whose next
argument is a path ending in the running script's file name. Every entry argument that
`-File` accepts (below), `-x`, `-x:foo`, `-x:`, `--`, `--%`, `-File`, `-Command` and the
empty string included, then reaches the entry unchanged when the starter is started with
`powershell.exe` or `pwsh` `-File` by a program that builds the command line itself (a
host's exec form, Bun, the test suite) and through the Git Bash forwarding (which calls
`-File`, arguments unchanged). The polyglot's batch part passes `%*` to `-File`, so it
hands on what `cmd.exe` received, and the empty string is the exception wherever a
PowerShell session writes the native call: Windows PowerShell 5.1 drops an empty argument
(`''`, `""`) from the command line of any native command, and pwsh 7.3 and later do the
same for a `.cmd` or `.bat`, which their default `PSNativeCommandArgumentPassing`
`Windows` passes the legacy way. So an empty entry argument does not survive the
polyglot's hook line under PowerShell (5.1 or 7), nor a Codex `commandWindows` line in a
Windows PowerShell 5.1 session; under pwsh 7.3 and later it survives the
`commandWindows` call of `powershell.exe -File`. (Documented: `about_Preference_Variables`,
`PSNativeCommandArgumentPassing`, its legacy list and the legacy dropping of empty
strings; for this starter derived, not checked on Windows.) The vector is the process
command line split by the C runtime's rules; a caller that quotes by those rules, as Bun, MSYS and the starter itself do, gets its arguments back.
A starter called any other way (with `&` inside another PowerShell session, or as pwsh's
positional script without `-File`) falls back to `$args`, with the re-parsing above. In a
PowerShell command line (Codex's `commandWindows` in a PowerShell session, the polyglot's
hook line), `--%` is PowerShell's own stop-parsing token and never reaches the native
call: write `'--%'` (in a `commandWindows` line: not checked on Windows). In the
polyglot's hook line under PowerShell even `'--%'` is lost, and an argument that begins
with `-` and contains a blank arrives split (Polyglot, below). (A local run with pwsh 7.7.0 on Linux, not in CI: the 0.1.0 starter
passed `-x`, `-x`, `foo`, `--`, `-`, `-File`, `-Command`, `a b`, `-x`, `y` for
`-x -x:foo -- - --% -File -Command 'a b' -x: y`; this one passes
`-x`, `-x:foo`, `--`, `-`, `--%`, `-File`, `-Command`, `a b`, `$x`, `-x:`, `y`, `-x:$true`,
`-args` and the empty string as given, `-f` abbreviated works, and `&` inside `-Command`
falls back. On Windows: executed, CI 46031834399, Windows PowerShell 5.1 and pwsh 7
legs: the list `-x`, `-x:foo`, `--`, `--%`, `-File`, `-Command`, `x`, `-Command x`,
`-NoProfile`, `-ExecutionPolicy`, `Bypass`, `-Verbose`, `-ErrorAction:Stop`, `-Debug`,
the empty string, `-x:`, `c"d` and `e\` reached the entry unchanged, as a whole, each
alone and through the Git Bash forwarding (`bootstrap/test/entry-args.test.ts`); the
polyglot rows: Polyglot, below. Arguments with spaces, quotes, a trailing backslash and
non-ASCII text: executed, CI 45572032454, before this change.)

What `-File` rejects: it makes an argument after the script path that begins with `-`
a parameter, and binding can fail on one of them in PowerShell before the starter runs,
with PowerShell's own "argument "name" is not valid" message on stderr and exit 1, not a
`getty-bun: ` line, so no reading of the argument vector can recover it. Which ones
fail depends on the PowerShell version:

- Windows PowerShell 5.1 called directly rejected a lone `-` (executed: CI 46027293350,
  the 5.1 leg, `-` followed by `--%` in the list `... "--", "-", "--%", "-File", ...`;
  CI 46031834399, the 5.1 leg, a lone `-` as the only entry argument) and passed `-:foo`
  with exit 0 (executed, CI 46031834399, the 5.1 leg).
- pwsh 7 called directly passed a lone `-` and rejected `-:foo` (executed, CI 46031834399,
  the pwsh leg).
- Through the Git Bash forwarding and through the polyglot (both start 5.1): on each leg
  of CI 46031834399 one forwarding row and three of the six polyglot rows for `-` and
  `-:foo` exited 0 where 1 was expected; which token passed which path is not determined
  (`bootstrap/test/windows-dash-limit.test.ts`, `polyglot.test.ts`).
- A dash followed by nothing but blanks: source-checked only (below), not executed.

So on Windows an entry takes no lone `-` and no argument that begins with `-:`. The open
source does not explain 5.1: in PowerShell v6.0.0 and master, `CommandLineParameterParser.cs`
makes every argument after the script that begins with a dash a parameter (master: one
longer than the dash alone, so pwsh 7 keeps a lone `-` as a plain argument), the name of
`-` and of `-:foo` comes out empty, and `MergedCommandParameterMetadata.GetMatchingParameter`
throws on an empty name; `ParameterBinderController` calls it for a parameter with a value
(`BindParameter`) and for one without, whether or not another argument follows
(`ReparseUnboundArguments`). That predicts the pwsh 7 results and the 5.1 rejection of
a lone `-`; read as 5.1, the v6.0.0 code would also fail on `-:foo`, which the 5.1 run
contradicts. Windows PowerShell 5.1's own source is not published, so why it passes
`-:foo`: not checked; the rule above avoids both shapes. (Source-checked:
PowerShell v6.0.0 and master, `CommandLineParameterParser.cs`, `Parameter.cs`,
`MergedCommandParameterMetadata.cs`, master `ParameterBinderController.cs`; the comment
above `Get-Arguments` in `getty-bun.ps1`.)

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

## Polyglot: `getty-bun.cmd`

`getty-bun.cmd` ([ADR 0010](../docs/adr/0010-claude-code-on-windows-cmd-polyglot.md))
serves Claude Code hooks in shell form, whose one line has to start under `sh -c` on Linux
and macOS, under Git Bash on Windows and under PowerShell on Windows without Git Bash.
It holds no pin and selects no version, so the template copies it unchanged; it must sit
next to `getty-bun.sh` and `getty-bun.ps1`. Pure ASCII, LF line endings.

The hook line, shell form (no `args`):

```
. "${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.cmd" run dist/hook.js; exit $LASTEXITCODE
```

in `hooks.json`:

```json
"command": ". \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.cmd\" run dist/hook.js; exit $LASTEXITCODE"
```

- `.` is the one call both families read alike: a POSIX shell sources the file with the
  arguments, PowerShell's dot-source operator runs a `.cmd` through `cmd.exe` with them.
- The double quotes keep a root with spaces in one word, in both.
- `; exit $LASTEXITCODE` is for PowerShell, whose `-Command` turns any non-zero exit code
  of a native last command into 1 (documented for 5.1 and 7; executed with pwsh 7.7.0 on
  Linux: `sh -c 'exit 2'` as the last command gave 1, with the tail 2). Claude Code's exit
  2 needs it. A POSIX shell never reaches it, since the polyglot replaces the shell by
  `exec` or exits. Its limit: when PowerShell cannot find the polyglot, `$LASTEXITCODE` is
  unset and the line exits 0 after PowerShell's error on stderr. How Claude Code hands the
  line to PowerShell, and whether it substitutes `${CLAUDE_PLUGIN_ROOT}` into it before
  (PowerShell would read `${CLAUDE_PLUGIN_ROOT}` as its own, empty variable): not checked
  here; windows-developer measured a dot-sourced polyglot starting (probe q6).
- The polyglot call comes first in the line, nothing before it (the dash fallback below
  needs that and fails otherwise). A command substitution inside the line (`$(...)`,
  backticks) runs twice under dash, once in dash and once in the bash that re-runs the
  line: keep them out of it.
- Entry arguments: words that mean the same to `sh` and PowerShell; quote anything else in
  single quotes. On Windows, `cmd.exe` reads the arguments as PowerShell writes them onto
  its command line, so `&`, `|`, `<`, `>`, `^` and `%` there are `cmd.exe`'s: keep them
  out of polyglot lines (not checked). From a PowerShell hook shell (Windows PowerShell
  5.1 and pwsh 7) `'--%'` does not reach the entry and an argument that begins with `-`
  and contains a blank (`'-Command x'`) arrives as two (`-Command`, `x`); with Git Bash
  as the hook shell the same list arrived unchanged (executed, CI 46031834399,
  `bootstrap/test/polyglot.test.ts`; `cmd.exe` running the `.cmd` itself: checked there
  for stdin, stdout and exit code only; where PowerShell loses them: not checked). So a polyglot line passes neither; plus the Windows limits of `-File` above
  (no lone `-`, nothing beginning with `-:`).

**POSIX side.** The batch part is a here-document to `:` for the shell. The shell part
then hands the call to `sh <dir>/getty-bun.sh "$@"` by `exec`, so Bun runs under the hook
shell's PID and the exit code is the starter's. A sourced file has no reliable `$0`:

| Shell | `. file args` sets `$@` | names the sourced file | `<dir>` from |
|---|---|---|---|
| bash 5.2.37, also as `sh` and `--posix` (macOS `/bin/sh`, Git Bash's `sh`) | yes | `BASH_SOURCE` | `BASH_SOURCE` |
| BusyBox sh 1.37.0 | yes | no | `$CLAUDE_PLUGIN_ROOT/bootstrap` |
| dash 0.5.12 (Debian and Ubuntu `/bin/sh`) | no: it ignores them, `$@` stays the shell's own | no | bash, below |
| zsh 5.9 | yes | `$0` (`FUNCTION_ARGZERO`, its default) | `$0` |

A shell that runs the file as a script (`sh getty-bun.cmd run ...`) has it in `$0`. In
dash, which drops the arguments, the polyglot reads its own shell's command line from
`/proc/$$/cmdline` (with `xargs -0`) and, when it is `<sh> -c '<line>'`, `<line>`
starts with `. ` and the word after the dot names `getty-bun.cmd` (`getty-bun.cmd` or a
path ending in `/` or `\` and `getty-bun.cmd`; the word is a double- or single-quoted
string, optionally followed by unquoted text, or an unquoted word, then a blank or the end
of the line), runs that same line again under `bash` by `exec`: the dot then passes the
arguments and `BASH_SOURCE` names the file. Never from bash or zsh, so it cannot loop.
Whatever ran in dash before the polyglot would run a second time under bash, so the first
word is the gate: a line such as `. ./side.sh; . "<root>/bootstrap/getty-bun.cmd" run
e.js` fails, after `side.sh` has run once. Without `/proc`, `bash` or `xargs`, or with
any other line, it fails with one `getty-bun: ` line and exit 1, as it does when no
directory is found. Extra
arguments of the `sh -c` itself (`sh -c '<line>' a b`) would reach dash as `$@`; Claude
Code passes none. (Executed with the in-progress `getty-bun.sh` of 0.2.0 against a local
mirror, on Linux: dash 0.5.12, bash 5.2.37, `bash --posix` and BusyBox 1.37.0 ran the line
above with a root containing a space, the entry got `-x`, `-x:foo`, `--`, `-`, `--%`,
`-File`, `-Command`, `a b` and `$x`, the hook input on stdin and exit 7 back; dash and
bash ran Bun under the shell's PID; without `CLAUDE_PLUGIN_ROOT` dash (through bash) and
bash ran, BusyBox failed with the one line; dash without `bash` on `PATH` failed with the
one line; `sh getty-bun.cmd` from another directory and from `bootstrap/` ran; zsh 5.9
(Debian's `zsh-static`) ran the line with exit 2 back and, without `CLAUDE_PLUGIN_ROOT`,
found the file through `$0`. `bootstrap/test/polyglot.test.ts` passed for `sh`, dash, bash,
BusyBox sh and zsh: 20 tests. macOS and Git Bash: not checked yet, CI legs pending. The
first-word gate, a local run outside the suite with a stub `getty-bun.sh` on Linux, not in
CI: dash re-ran `. "<root>/..."`, `. '<root>/...'`, `. "$VAR/bootstrap/getty-bun.cmd"` and
`. "$VAR"/bootstrap/getty-bun.cmd` with their arguments; `. ./side.sh; . "<root>/..." run
e.js` and `. "<root>/bootstrap/getty-bun.cmd";. ./side.sh run e.js` failed with the one
line and exit 1, `side.sh` having run once in the first; bash, zsh 5.9 and BusyBox sh with
`CLAUDE_PLUGIN_ROOT` ran unchanged.)

**Batch side.** `cmd.exe` skips the first line (a label to it), and runs

```
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0getty-bun.ps1" %*
exit /b %ERRORLEVEL%
```

with `@echo off`, so nothing but the starter writes to stdout; stdin, stdout and stderr
pass from `cmd.exe` to PowerShell unchanged, and the exit code is the starter's. These are
the Codex `commandWindows` flags; Windows PowerShell 5.1 by its absolute path, since
`cmd.exe` looks in the current directory before `PATH` and a hook's current directory is
the user's project. `%~dp0` is the polyglot's own directory, `%*` the arguments as
`cmd.exe` received them; `getty-bun.ps1` then reads them from its process command line
(above, "Entry arguments"). LF line endings (`.gitattributes` `eol=lf`): `cmd.exe` runs
an LF-only batch file line by line, but its label search for `goto` and `call :label` and
its parenthesised blocks are unreliable there, so the batch part has none of them, and
`cmd.exe` stops at `exit /b` before it reaches the POSIX part. (Not checked yet: the batch
side under PowerShell 5.1, 7 and `cmd.exe`, CI legs pending; the cost of the extra
PowerShell start on a desktop: a windows-developer card.)

**Limits of the batch side.** What the environment around `cmd.exe` can do to the line,
none of it checked on Windows:

- *AutoRun.* PowerShell starts a `.cmd` as `cmd.exe /c <file> <args>`, without `/d`, so a
  `Command Processor\AutoRun` registry value (`conda init` writes one) runs first; its
  output can land on the hook's stdout, ahead of the hook JSON, and a `cd` in it changes
  the directory the starter and the entry start in. (Derived from `cmd /?` on `/d` and
  AutoRun; how PowerShell builds the call: not checked.)
- *UNC current directory.* With the hook's current directory on a UNC path
  (`\\server\share\...`), `cmd.exe` warns that it does not support it and switches to
  the Windows directory, so the entry's `processCwd` is `C:\Windows`, not the project.
  (Derived from `cmd.exe`'s documented behavior; the stream of the warning and the rest:
  not checked.)
- *`SystemRoot` unset.* `%SystemRoot%` then stays literal, the PowerShell path does not
  exist, `cmd.exe` reports that on stderr and exits 9009, which `exit $LASTEXITCODE` passes
  on. (Derived; not checked.)
- *`$` or a backtick in the plugin root.* PowerShell expands both inside the line's
  double quotes, looks for a polyglot that does not exist, writes its error on stderr and,
  with `$LASTEXITCODE` unset, the line exits 0: the hook fails open. (Derived from
  PowerShell's double-quoted string rules; not checked.)
