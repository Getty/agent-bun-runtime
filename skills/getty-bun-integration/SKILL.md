---
name: getty-bun-integration
description: Use when an agent plugin or tool must run TypeScript on Getty's shared per-user Bun runtime (getty-bun) — writing a hook entry on @getty/agent-bun-runtime (main(), the codex or claude-code codec, effects), declaring the Bun version in package.json, wiring Claude Code or Codex hooks through the getty-bun starter, shipping a bundled entry, or reviewing such an integration.
---

# Getty Bun Integration

The Getty integration contract (`gettyBun.contractVersion: 1`) as implemented by
agent-bun-runtime 0.1.0 (`Getty/agent-bun-runtime`). This skill comes from the same
release tag as the SDK you build against; at that tag, the repository's `docs/plan.md`,
`docs/adr/`, `README.md` ("The SDK") and `bootstrap/README.md` are the authority and win
where this skill disagrees. Built and released together:

- the starters `getty-bun.sh` and `getty-bun.ps1` (`bootstrap/`), delivered to plugins
  by the sibling skill `getty-bun-install` (a skilletor template);
- the SDK `@getty/agent-bun-runtime` on npm: `main()`, effects, and the codecs
  `@getty/agent-bun-runtime/codex` and `@getty/agent-bun-runtime/claude-code`.

Running and diagnosing an installed runtime: sibling skill `getty-bun`. No real Codex or
Claude Code has run the codecs from agent-bun-runtime yet (Codex: phase 3a; Claude Code:
only payloads loadguard recorded on 2.1.283); never claim that a host ran your hooks unless
you observed it.

## Inspect the actual integration

1. Inspect the consumer repository, package manifests, release process, and target agent
   client. Follow repository instructions and preserve unrelated work.
2. Identify the execution environment: native Windows, Git Bash, Linux, macOS, WSL,
   remote host, or container. Record the client version and distribution surface.
3. Read [the contract](references/contract.md). Missing provider behavior (a target, a
   starter feature, an event or effect the SDK lacks) is built in agent-bun-runtime
   first, not worked around in the consumer. The starter interface is `run`, `ensure`,
   `status` and, from 0.2.0, `run-ready` (`run` that skips instead of installing, for a
   hook that must never install); invent no other commands.
4. Establish authorization from the session. Prepare concrete changes before required
   host trust/review; do not bypass it.

## Preserve the invariants

- Declare one exact runtime requirement in the consumer's `package.json`:
  `gettyBun.contractVersion: 1` and `gettyBun.bunVersion`, equal to `vars.bun_version`
  of `getty-bun-install` and to the starters' pin block; the consumer's CI checks both.
- **The starter is the only installer.** Every `run`/`ensure` ensures the pinned Bun
  first; the first hook after a plugin install or update installs, concurrent hooks wait
  on the same lock, bounded. The SDK never installs, downloads, or edits lockfiles.
- **Ship a bundled entry.** Commit `bun build --target=bun` output, the SDK bundled in;
  no `bun install` on user machines.
- One verified installation per exact **version and target within one execution
  environment**, in immutable slots under `<GETTY_HOME>/runtimes`. A mismatch fails
  closed. From 0.2.0 the targets include `darwin-x64` and `darwin-aarch64`
  ([paths-platforms.md](references/paths-platforms.md)).
- **Bun starts without the user's project.** The starters run
  `<slot>/bin/bun --no-install --config=<empty file> --no-env-file <root>/<entry>` with
  `BUN_OPTIONS` and the preload, debugger, module-path and code-cache variables removed
  (the list: [contract.md](references/contract.md), "Bun without the project") and the
  hook's working directory kept: the project's `bunfig.toml` (preload, `[define]`),
  `.env*` files and those variables never reach the entry. A Bun child process the entry
  starts through `process.execPath` inherits cwd and environment, so pass it
  `--config=<empty file> --no-env-file` (and `--no-install`) and delete the same
  variables from its environment. Never PATH, a `current` link, `bun upgrade`,
  `bunx`, or a shebang.
- stdout belongs to the entry (one hook JSON, written once by `main()`); every diagnostic
  goes to stderr. The starter exits 1 for its own failures and passes the entry's code
  through unchanged. Entry codes stay within 0–255 (a limit from Windows that holds on
  every OS). Entry arguments pass through unchanged, those beginning with `-` included
  (from 0.2.0; the 0.1.0 rule against them is withdrawn), except that Bun consumes a lone
  `--` as the first entry argument, PowerShell drops an empty `''` argument when it
  calls the `.cmd`, and on Windows: no lone `-` and nothing beginning with `-:`, which
  PowerShell's `-File` can reject (exit 1), and through the polyglot from a PowerShell
  hook shell no `--%` and no `-` argument containing a blank, which arrive lost or split
  ([contract.md](references/contract.md), "Starter interface").
- **Options an entry takes on Windows** have one of three forms only: `-x`, `--name` or
  `--name=value`, with no blank inside; a value that needs a blank goes in an argument of
  its own. The exceptions above are why. (All three forms passed `-File`, the Git Bash
  forwarding and the polyglot: executed, agent-bun-runtime CI 46055182446.)
- **The entry exits 0, 1, or 2 only with `onFailure: "closed"`.** Both hosts read 2 on
  `PreToolUse` and `UserPromptSubmit` as a block, but also act on it elsewhere: on `Stop`
  and `SubagentStop` it keeps the agent working. `"closed"` only on an entry that serves
  nothing but `PreToolUse` or `UserPromptSubmit`; any other entry keeps `"open"` (split
  the entry when a guard needs `"closed"`). `"silent"` (from 0.2.0) exits 0 with nothing on
  stdout for a guard that must stay invisible on broken input ([sdk.md](references/sdk.md)).
- **The host is passed explicitly**: one entry per host, or the host as the entry's
  argument. Codex sets `CLAUDE_PLUGIN_ROOT` too; never detect the host from the
  environment.

## Implement in order

### 1. Declare the pin and the SDK

Merge [package.fragment.json](assets/package.fragment.json); take the version from the
release's `bootstrap/versions.json` (the fragment shows 1.4.5, the pin of 0.1.0).
Validate with [requirement.schema.json](assets/requirement.schema.json). A consumer that
runs only on some OSes declares `gettyBun.platforms` (from 0.2.0;
[contract.md](references/contract.md), "Canonical consumer requirement"). Add
`@getty/agent-bun-runtime` at the exact version of the skill source's `ref` (`0.1.0` for
`v0.1.0`) as a build-time dependency, from npm; a git-commit pin carries no `dist/`.

### 2. Commit the rendered starters

Follow skill `getty-bun-install`: it renders both starters for `vars.bun_version` into its
own directory; the plugin copies them into `bootstrap/` and its CI compares the copy with
a fresh render. Write no installer or locking code in the consumer;
[installation-locking.md](references/installation-locking.md) is what the starters
implement.

### 3. Write the entry

Read [sdk.md](references/sdk.md): `main()`, the codecs, effects, failure policy, input
bound, testing. The entry pattern:

```ts
import { main } from "@getty/agent-bun-runtime";
import { claudeCode } from "@getty/agent-bun-runtime/claude-code";

process.exit(await main({ codec: claudeCode, handler }));
```

A long-lived stdio server (an MCP server) is a second entry kind, started through
`getty-bun.sh run-mcp <entry>`, never `run` (POSIX only in 0.2.0): [contract.md](references/contract.md),
"Long-lived stdio server". An entry that starts a
watcher or background job: [dependencies-and-execution.md](references/dependencies-and-execution.md),
"Detached long-lived child processes".

### 4. Bundle the entry

Read [dependencies-and-execution.md](references/dependencies-and-execution.md). Commit the
bundle; CI rebuilds it with the pinned Bun and compares byte for byte.

### 5. Wire the host

- Codex: [codex.md](references/codex.md): `command` runs `getty-bun.sh`, `commandWindows`
  the PowerShell starter, in a hook file of its own; hook trust and re-review.
- Claude Code: [claude-code.md](references/claude-code.md): `hooks/hooks.json`, shell or
  exec form on Linux; on Windows the `.cmd` polyglot `getty-bun.cmd` (ADR 0010), whose
  hook line skill `getty-bun-install` holds.
- Hermes or another host: no codec exists; it is built in agent-bun-runtime first.

Set every starter hook's `timeout` explicitly, above the lock wait plus one download; put
no starter call on `SessionEnd` (or Codex `Interrupt`), whose budget is seconds.

### 6. Package the setup skill

Read [setup-and-installation.md](references/setup-and-installation.md) and adapt
[setup-skill-template.md](assets/setup-skill-template.md) for repair and diagnosis through
`status` and `ensure`.

### 7. Handle updates and retention

Read [updates-and-retention.md](references/updates-and-retention.md). A Bun bump
re-renders the starters and rebuilds the bundle in one release; the new slot installs
beside the old one. No automatic pruning.

### 8. Verify and deliver

Use [verification.md](references/verification.md) and
[integration-review-template.md](assets/integration-review-template.md). Label evidence:
documented, source-checked, schema-checked, scenario-reviewed, executed (with command,
host version and platform; for agent-bun-runtime's CI the run ID and commit), measured by
windows-developer, or not checked. A test that feeds `main()` a recorded payload proves
the codec, not the host. Deliver concrete changes, the exact pin, supported and tested
targets, update behavior, and remaining gaps.

## Research and rationale

[prior-art.md](references/prior-art.md) covers OpenClaw, mise, pnpm, and metadata
compatibility; [prior-art-plugins.md](references/prior-art-plugins.md) covers AgentPulse,
GStack, and Claude-mem; [sources.md](references/sources.md) maps primary sources, the
agent-bun-runtime decisions, and the windows-developer measurements. Attribute external
facts; Getty paths, fields, locking policy, and lifecycle rules are Getty's design.
