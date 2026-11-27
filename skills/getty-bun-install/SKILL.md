---
name: getty-bun-install
description: "Use when putting the getty-bun starters (getty-bun.sh, getty-bun.ps1, getty-bun.cmd) into an agent plugin or tool, wiring its Claude Code or Codex hooks through them, setting or bumping vars.bun_version or vars.bun_platforms, or when a plugin's bootstrap/getty-bun.* differs from a fresh render."
---

# getty-bun-install

This skill is a skilletor template. Rendered, its directory holds the two getty-bun
starters pinned to the consumer's `vars.bun_version`, and the polyglot beside them:

```
bootstrap/getty-bun.sh    POSIX sh starter (Linux, macOS; under Git Bash it forwards to the .ps1)
bootstrap/getty-bun.ps1   Windows PowerShell 5.1 / 7 starter
bootstrap/getty-bun.cmd   polyglot for Claude Code hooks in shell form (no pin; copied unchanged)
```

Each starter carries one pin block: the Bun version and the SHA256 per target, from the version
table of the agent-bun-runtime release this skill came from. skilletor renders the skill
either into the harness's skills directory (`.claude/skills/getty-bun-install/`) or, with
`"into": "plugin"`, into the plugin's own `skills/getty-bun-install/` (section 1); either
way the plugin gets the starters into `bootstrap/` by copy, and its CI checks the copy. Using the runtime afterwards (status, troubleshooting): skill `getty-bun`. Building
the entry on `@getty/agent-bun-runtime`: skill `getty-bun-integration`.

## 1. Pin the version

In the plugin's `.claude/skilletor.json` (project scope):

```json
{
  "sources": {
    "agent-bun-runtime": {
      "git": "https://github.com/Getty/agent-bun-runtime",
      "ref": "v0.2.0",
      "path": "skills"
    }
  },
  "vars": { "bun_version": "1.4.5", "bun_platforms": ["linux", "darwin", "windows"] },
  "install": { "skills": ["getty-bun-install@agent-bun-runtime"] }
}
```

- `vars.bun_version` has no default: a plugin pins explicitly. Missing, or a version the
  template's table does not carry, fails the render with
  `Unable to call vars_bun_version_is_missing_or_not_in_the_getty_bun_install_version_table`.
  Fix the var or move `ref` to a release whose table has that version; never edit a pin
  block by hand.
- `ref` pins skill and SDK together: use the tag of the `@getty/agent-bun-runtime`
  version in the plugin's `package.json`.
- Keep `gettyBun.bunVersion` in the plugin's `package.json` equal to `vars.bun_version`.
- `vars.bun_platforms` is optional: the platforms the plugin runs on, a list of unique
  `linux`, `darwin`, `windows`, in the same order as `gettyBun.platforms` in
  `package.json`. It renders one `# platforms` line into the pin block; on a platform it
  does not list, `run`, `run-ready` and `ensure` exit 0 with one `getty-bun: ` line and
  install nothing (`run-mcp` serves its stub), and `status` says `undeclared`. Without it, the block has no such line
  and every platform is served. Any other value fails the render with
  `Unable to call vars_bun_platforms_must_be_a_list_of_unique_linux_darwin_windows`.

**Into the plugin** (skilletor card `k286`, on its `main` from 2026-11-27, not in a
skilletor release yet): instead of the string, name the install as

```json
"install": { "skills": [ { "skill": "getty-bun-install@agent-bun-runtime", "into": "plugin" } ] }
```

skilletor then renders the skill once, with the project's vars, into the plugin's own
skills directory (`skills/getty-bun-install/`, or under the `skills` path of
`.claude-plugin/plugin.json`), whatever the `targets`, and not into `.claude/skills`. The
plugin commits that copy; skilletor's lock owns it as `plugin:skills/getty-bun-install`,
so `sync` updates it and `check` reports drift, and on a fresh checkout files equal to the
render are adopted. Project scope only, skills only; a project without
`.claude-plugin/plugin.json` is a config error. The skill then also ships to the plugin's
users as one of its skills. Section 2 copies from `skills/getty-bun-install/bootstrap/`
instead, and section 4 compares against that path. (Documented by skilletor, README,
"Shipping a rendered skill in your plugin", and `skills/skilletor/references/sync.md`;
skilletor ships its own `skills/getty-bun-install/` that way. Not executed by
agent-bun-runtime.)

Then `skilletor trust agent-bun-runtime` (a project-declared source renders nothing until
trusted) and `skilletor sync --scope project`. A failed render is a `warning: template
error in skill getty-bun-install` line, and sync still exits 0: it installs nothing, or
keeps the copy rendered before (executed, see the end of section 4). Read the sync output.

## 2. Copy the starters into the plugin

```sh
skill=.claude/skills/getty-bun-install    # the rendered copy (Claude target; others alike)
# with "into": "plugin": skill=skills/getty-bun-install
mkdir -p bootstrap
cp -p "$skill/bootstrap/getty-bun.sh" "$skill/bootstrap/getty-bun.ps1" "$skill/bootstrap/getty-bun.cmd" bootstrap/
```

- The plugin root is the parent of `bootstrap/`: the starters find the entry as
  `<root>/<entry>`, from their own path, never from the working directory.
- Commit the files unchanged, beside the bundled entry (`dist/hook.js` below). Both
  starters always: the `.sh` forwards to the `.ps1` under Git Bash. The `.cmd` is what a
  Claude Code hook dot-sources to serve Windows too (section 3); a plugin that does not
  use it may leave it out and drop its `cmp` line in section 4.
- `cp -p` keeps the mode. The hooks start the starters through `sh` and
  `powershell -File`, so no exec bit is needed.
- Commit a `.gitattributes` with `* text=auto eol=lf` (at least
  `bootstrap/getty-bun.sh`, `bootstrap/getty-bun.ps1` and `bootstrap/getty-bun.cmd text
  eol=lf`; the polyglot is built for LF, see agent-bun-runtime `bootstrap/README.md`,
  "Polyglot"). Without it, Git for
  Windows with `core.autocrlf=true` checks out a CRLF `getty-bun.sh`: the Git Bash
  forwarding breaks and the `cmp` of section 4 fails. Rule and reasons: skill
  `getty-bun-integration`,
  [paths-platforms.md](../getty-bun-integration/references/paths-platforms.md),
  "Repository hygiene".

## 3. Wire the hooks

Every hook that needs Bun calls a starter with `run <entry> [args...]`. An entry serving
both hosts takes the host from its own argument (`claude-code`, `codex`); the SDK never
guesses it. Entry arguments pass through unchanged, `-` ones included, with one exception
from Bun 1.4.5: a lone `--` as the first entry argument is dropped; and on Windows pass
no lone `-` and nothing beginning with `-:`, which PowerShell's `-File` can reject, and
through the polyglot from a PowerShell hook shell no `--%` and no `-` argument containing
a blank, which arrive lost or split (skill
`getty-bun-integration`, [contract.md](../getty-bun-integration/references/contract.md),
"Entry arguments pass through unchanged").

**Claude Code** (`hooks/hooks.json`) on Linux, macOS and Windows: shell form, dot-sourcing
the polyglot ([ADR 0010](https://github.com/Getty/agent-bun-runtime/blob/v0.2.0/docs/adr/0010-claude-code-on-windows-cmd-polyglot.md)):

```json
{ "type": "command",
  "command": ". \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.cmd\" run dist/hook.js claude-code; exit $LASTEXITCODE",
  "timeout": 600 }
```

- On Linux and macOS the hook's shell sources the file, which hands the call to
  `getty-bun.sh` by `exec`; on Windows PowerShell's `.` runs it through `cmd.exe`, which
  starts `getty-bun.ps1` under Windows PowerShell 5.1. Under Git Bash it goes the POSIX
  way and forwards from there.
- `; exit $LASTEXITCODE` keeps the entry's exit code (2 included) under PowerShell, whose
  `-Command` turns any other non-zero code into 1; a POSIX shell never reaches it.
- dash, `/bin/sh` on Debian and Ubuntu, ignores the arguments of `. file args`. The
  polyglot then reads the shell's command line from `/proc` and runs the same line again
  under `bash`; that needs `/proc`, `bash` and `xargs` on the machine and the polyglot
  call first in the line, and fails with one `getty-bun: ` line otherwise. bash (macOS
  `/bin/sh`, Git Bash), BusyBox sh and zsh pass the arguments themselves.
- Arguments in this line: words that mean the same to `sh` and PowerShell; single-quote
  anything else; keep `&`, `|`, `<`, `>`, `^` and `%` out (on Windows `cmd.exe` reads
  them), and `--%` and `-` arguments containing a blank too (a PowerShell hook shell lost
  `'--%'` and split `'-Command x'`: executed, agent-bun-runtime CI 46031834399 and
  46035250753; other `-` arguments with a blank: derived from that one).

Evidence: the line executed locally on Linux under dash 0.5.12 (through bash), bash 5.2.37,
`bash --posix`, BusyBox sh 1.37.0 and zsh 5.9, root with a space, `-` arguments, stdin and
exit codes 2 and 7 (agent-bun-runtime `bootstrap/test/polyglot.test.ts`). On Windows the
same test ran in CI 46031834399 with PowerShell 5.1, PowerShell 7 and Git Bash as the hook
shell: stdin, stdout and exit codes passed in all three, the `-` arguments in Git Bash; under
both PowerShells `'--%'` was lost and `'-Command x'` split (above); CI 46035250753 repeated
that and showed a `-` followed by another argument failing with exit 1 from all three hook
shells (the batch part starts Windows PowerShell 5.1). On macOS (`macos-15` and
`macos-15-intel`, CI 46035250753) the line passed under the system `/bin/sh`, `/bin/bash` 3.2
and zsh; dash there fails with one `getty-bun: ` line, since macOS has no `/proc` for the
bash re-run. Not checked: how Claude Code hands the line to PowerShell and substitutes
`${CLAUDE_PLUGIN_ROOT}` there, and the cost on a real Windows desktop (one more PowerShell start per hook, about 720 ms
measured by windows-developer for probe q6; a measurement card at the windows-developer
hub).

A plugin that serves Claude Code only on Linux and macOS may keep the `sh` lines of 0.1.0
instead and skip the `.cmd`. Shell form:

```json
{ "type": "command",
  "command": "sh \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run dist/hook.js claude-code",
  "timeout": 600 }
```

Exec form (Claude Code 2.1.139 or later; no quoting, `sh` resolved on PATH):

```json
{ "type": "command", "command": "sh",
  "args": ["${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh", "run", "dist/hook.js", "claude-code"],
  "timeout": 600 }
```

**Codex** (its own hook file, named by the `hooks` entry of the Codex manifest, because
Claude Code always reads `hooks/hooks.json` and has no `commandWindows`):

```json
{ "type": "command",
  "command": "sh \"${PLUGIN_ROOT}/bootstrap/getty-bun.sh\" run dist/hook.js codex",
  "commandWindows": "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"${PLUGIN_ROOT}\\bootstrap\\getty-bun.ps1\" run dist/hook.js codex",
  "timeout": 600 }
```

Keep `commandWindows` valid in PowerShell and `cmd` alike: bare `powershell.exe`,
double-quoted paths, no `&`, `$env:` or `%VAR%`, and `'--%'` quoted if an entry takes it.

**Hot hooks: `run-ready`.** A hook with a short budget that must never wait for an install,
such as a `PreToolUse` guard with a 5 s timeout, calls `run-ready` instead of `run`: with
the slot ready it is `run`; while Bun is not installed yet it exits 0 with nothing on
stdout and one `getty-bun: ` line, and installs nothing. Pair it with a `SessionStart` hook
that installs (`run` or `ensure`, timeout 600), so the hot hook stays silent only until
that has finished:

```json
{ "type": "command",
  "command": ". \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.cmd\" run-ready dist/guard.js claude-code; exit $LASTEXITCODE",
  "timeout": 5 }
```

The `sh` and Codex lines take `run-ready` in place of `run` alike. On Windows a polyglot
hook pays one more PowerShell start (above); measure it against such a budget.

**Offline without a slot.** A hook that installs (`run`, `ensure`) and cannot download
ends with exit 1 and one `getty-bun: ` line before the entry runs; `run-ready` stays at
exit 0 while the slot is missing, and the SDK's `onFailure: "silent"` does not apply,
because the entry never started. Codex discards a failed start hook's output, so on
`SessionStart` that line is lost without a trace (run the hook line by hand to see it);
Claude Code shows it. The next hook tries again; a `ready` slot needs no network.

**MCP server: `run-mcp`.** A stdio server (MCP) runs through `run-mcp`, never `run` or
`run-ready`: Claude Code blocks a server for about 15 minutes when it ends before
`initialize`, by its 30 s start timeout or a quick exit alike, and starts it in parallel
to `SessionStart`. `run-mcp` execs the entry when the slot is ready, waits up to
`GETTY_BUN_MCP_WAIT` seconds (default 20) for a missing one, and otherwise serves a stub
without tools until the session ends; it never installs. The server line, with the host
word as its argument (Claude Code `.mcp.json`, Linux and macOS):

```json
{ "mcpServers": { "example": { "command": "sh",
  "args": ["${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh", "run-mcp", "dist/server.js", "claude-code"] } } }
```

and the install beside it, a `SessionStart` hook `ensure` with timeout 600:

```json
{ "type": "command",
  "command": "sh \"${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.sh\" ensure",
  "timeout": 600 }
```

- The first session has the real server only if that install finishes within the wait;
  otherwise it has the stub (no tools, its `instructions` say why) and the next session
  starts the real one.
- Codex: the server declaration finds the starter through a locator and names
  `"env_vars": ["GETTY_HOME", "GETTY_BUN_MIRROR"]`, without which the server looks for Bun
  under `~/.getty` while the hook installs into `$GETTY_HOME` (skill
  `getty-bun-integration`, [codex.md](../getty-bun-integration/references/codex.md)).
- The entry answers `initialize` before anything that can fail, and keeps the lifetime,
  signal and exit rules of [contract.md](../getty-bun-integration/references/contract.md),
  "Long-lived stdio server".
- Not on Windows in 0.2.0: `getty-bun.ps1 run-mcp` fails with one line, exit 1 (`k13`).

`run-mcp` is executed locally in agent-bun-runtime (`bootstrap/test/run-mcp.test.ts`, Linux
`sh`), not yet under a host; the host facts are hub-observed (agent-developer and agent-irc
K9, 2026-11-27, Claude Code 2.1.332, Codex 0.148.0; details in
[claude-code.md](../getty-bun-integration/references/claude-code.md)).

The hook lines are source-checked against the hosts, not executed under them by this
project yet; the starters themselves are executed in agent-bun-runtime CI.

**Timeout.** Set `timeout` explicitly on every starter hook; on every hook that may
install (`run`, `ensure`) above the lock wait
(`GETTY_BUN_LOCK_WAIT`, default 300 s) plus one Bun download (ADR 0007): the first hook
after an install or a Bun bump downloads, and a hook that waited out a crashed installer
downloads itself. `600` leaves 300 s for the download. Host defaults are lower on some
events (Claude Code `UserPromptSubmit`: 30 s). Put no starter call on `SessionEnd` or
Codex `Interrupt`: their budget is seconds. A plugin whose MCP server runs through the
starter runs it with `run-mcp` and adds a `SessionStart` hook `ensure` with timeout 600
(above, "MCP server"); the server's first start finds Bun only if that install finishes
within `run-mcp`'s wait.

Otherwise no separate install hook and no Bun on PATH: the first `run` hook installs,
concurrent hooks wait on the starter's lock.

## 4. Check the copy in CI

The committed starters must equal a fresh render of the pinned version, and the pin must
equal `package.json`. A CI job with skilletor installed (its `install.sh --no-plugin`). A
fresh runner has no `~/.claude`, and skilletor without a detected harness stops with
`no agent harness detected` (exit 2), so the CI job names the target in the user config
first. This line is for the CI job only, and it never replaces an existing file:

```sh
mkdir -p ~/.claude && { [ -e ~/.claude/skilletor.json ] || echo '{"targets":["claude"]}' > ~/.claude/skilletor.json; }
```

Then, in CI and locally:

```sh
skilletor trust agent-bun-runtime
skilletor sync --scope project
cmp bootstrap/getty-bun.sh  .claude/skills/getty-bun-install/bootstrap/getty-bun.sh
cmp bootstrap/getty-bun.ps1 .claude/skills/getty-bun-install/bootstrap/getty-bun.ps1
cmp bootstrap/getty-bun.cmd .claude/skills/getty-bun-install/bootstrap/getty-bun.cmd
test "$(git check-attr eol bootstrap/getty-bun.cmd | sed 's/.*: //')" = lf
grep -qx "# version $(jq -r .gettyBun.bunVersion package.json)" bootstrap/getty-bun.sh
p=$(jq -r '.gettyBun.platforms // empty | join(" ")' package.json)
if [ -n "$p" ]; then grep -qx "# platforms $p" bootstrap/getty-bun.sh
elif grep -q '^# platforms ' bootstrap/getty-bun.sh; then echo 'platforms line without gettyBun.platforms' >&2; exit 1; fi
```

`cmp` fails when the render failed (a fresh checkout has no rendered copy); the `grep`
lines catch a stale local copy. The platforms check wants the `# platforms` line equal to
`gettyBun.platforms`, in its order, and no such line when `package.json` declares none;
written for a shell with `set -e`, as CI steps run. The `check-attr` line fails unless
`.gitattributes` gives the polyglot `eol=lf` (section 2): checked out with CRLF, bash
fails on it with exit 2, which Claude Code reads as a blocking hook (agent-developer
review, 2026-11-27, reproduced there; the line itself executed locally with git 2.47.3,
exit 1 without the attribute, 0 with `* text=auto eol=lf`). Drop the `.cmd`
`cmp` and `check-attr` lines if the plugin does not commit the polyglot. With
`"into": "plugin"` the `cmp` lines compare against `skills/getty-bun-install/bootstrap/`. Run the second block (`trust`, `sync`, `cmp`, `grep`) before
every commit that touches the starters, the pin or the `ref`; a machine where skilletor
detects a harness needs no user-config line.

Evidence: executed 2026-11-26 on linux-x64 (Linux x86_64), skilletor `3641b4b`
(`dist/skilletor.js`, 0.9.0) run on Bun 1.4.5, `HOME` a temporary directory, the source
declared as `"local": "<agent-bun-runtime checkout>", "path": "skills"` instead of `git`/`ref`:
`skilletor sync --scope project` before `trust` installed nothing and named the `trust`
command; `skilletor trust agent-bun-runtime`, then `sync --scope project`, rendered both
starters, and both `cmp` lines against agent-bun-runtime `bootstrap/` passed for 1.4.5.
With `9.9.9`, sync printed the template error and exited 0, kept the 1.4.5 copy, and on an
empty `.claude/skills` installed nothing. Without the user-config `targets`, sync exited 2
as above. Again 2026-11-27 with the 0.2.0 template (same skilletor build and setup,
`vars.bun_platforms` `["linux", "darwin"]`): sync rendered both starters with the line
`# platforms linux darwin`, the `.sh` equal to `render-pin.ts --platforms linux,darwin`,
and copied `getty-bun.cmd` byte for byte. The `version` and `platforms` checks ran against
starters rendered with and without that line (exit 0 and 1 as intended). Not executed: the
`git` source at a release tag and the job in a consumer's CI.

## Bumping Bun

One plugin release: set `vars.bun_version` (and `ref`, if the version comes with a newer
agent-bun-runtime release) and `gettyBun.bunVersion`, sync, copy the starters (and the
`.cmd`), rebuild the
bundled entry with that Bun, commit together. The new slot installs beside the old one on
the first hook. Codex asks for a new hook review when a plugin's bundled scripts change
(documented, not executed).
