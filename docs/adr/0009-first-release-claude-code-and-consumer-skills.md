# 0009: The first release carries the Claude Code codec and the consumer skills

Status: accepted, 2026-11-26 (owner: release before the consumers are rebuilt, Claude Code
codec and consumer skills in 0.1.0, consumers take npm; `notify-user` and combined
effects in 0.1.0, answered through the hub; the other interface decisions below are the
phase 2b team's, on the owner's brief); supersedes the host order in
`docs/plan.md` and "until the first release consumers pin a git commit" in
[0006](0006-npm-distribution.md) and [0008](0008-repository-and-package-name.md).

## Context

Three consumers asked for the runtime on 2026-11-26: loadguard, agent-irc and skilletor,
all mainly Claude Code plugins. The plan had Codex first (briefing, phase 3a) and Claude
Code with skilletor in phase 3b. The owner released the runtime before any consumer is
rebuilt, so 0.1.0 must carry both hosts, and the interface the SDK exports is hard to
change once it is on npm (hub review of phase 2, F2).

What the consumers use at the commits the brief names (source-checked in phase 2b):

- loadguard (`b517415`): Claude Code `SessionStart`, `UserPromptSubmit` (add context) and
  `PreToolUse` on `Bash` (`deny` with a reason); exit 0 always; input up to 8 MiB.
  It probed `updatedInput` on Claude Code 2.1.283 and dropped it (`docs/design.md:30-47`).
- skilletor (`3641b4b`): Claude Code `SessionStart`, `UserPromptSubmit`, `PostToolUse`,
  `CwdChanged`; Codex `SessionStart`, `UserPromptSubmit`. It writes `additionalContext`
  and a user-visible `systemMessage`, often both at once; it selects the host by argv.
- agent-irc (`5f27895`): its 13 Claude Code and 9 Codex hooks are `"type": "mcp_tool"`
  hooks into its own MCP server, not command hooks. No codec is on its path.

## Decision

**Order.** 0.1.0 carries the Codex and the Claude Code codec. Phase 3b keeps skilletor's
port and the Claude Code start on Windows, not the codec.

**Distribution.** Consumers take `@getty/agent-bun-runtime` from npm, starting with 0.1.0,
and never pin a git commit: `dist/` is built by `prepack` and is not in git (card `k28`
stays open for a later git-pin need). The first publish is by hand by the owner
(ADR 0006), then trusted publishing.

**Consumer skills live here.** `skills/` at the repository root holds the skills a
consumer installs with skilletor from `Getty/agent-bun-runtime`, pinned to the release tag
(`"ref": "v0.1.0"`, `"path": "skills"`): `getty-bun` (use), `getty-bun-integration`
(engineering, the contract, moved from Getty/skills) and `getty-bun-install` (the
template with the starters). The tag pins skill and SDK together. The team skills under
`.claude/skills/` stay internal: `"path": "skills"` limits the source to that directory.

**Public interface of 0.1.0.**

- *Codecs are the package's, not a plugin interface.* `HookCodec` is exported only as an
  opaque type; a plugin picks a codec (`@getty/agent-bun-runtime/codex`,
  `@getty/agent-bun-runtime/claude-code`) and does not implement one. So the codec's
  internal shape (stdout text only) can change without a major release.
- *The host is passed explicitly.* Codex sets `CLAUDE_PLUGIN_ROOT` too, so environment
  variables do not identify the host. An entry serving both hosts takes the host from
  its own argument in the hook command (`getty-bun.sh run dist/hook.js claude-code`) or
  is built twice; the SDK never guesses.
- *Decoders check only what they lift.* A codec checks the type of the keys it maps
  into the envelope (`hook_event_name`, the session id, the working directory, the turn
  id where lifted, the tool name; a wrong type or `null` there is `HOOK_INPUT_INVALID`)
  for the events it has rules for, and leaves every other host key unchecked in
  `native.input`. For other events only `hook_event_name` is checked; a session id or
  working directory that is not a string is left out of the envelope. A host release that changes an unused key then cannot fail every hook,
  which under `"closed"` would block every `PreToolUse`.
- *Unknown events are decoded generically.* Each codec decodes any event that has a
  string `hook_event_name` into the envelope (session, working directory, native input);
  for an event the codec has no rules for, only `no-decision` encodes, every other
  effect is `HOOK_EFFECT_UNSUPPORTED`. `HOOK_EVENT_UNSUPPORTED` is gone.
- *Effects.* `no-decision`; `add-context` (audience `model`) at `session-start-input`,
  `subagent-input`, `prompt-input` (`UserPromptSubmit`) or `tool-result`
  (`PostToolUse`); for `PreToolUse` `tool-permission` (decision `allow`, `deny` or `ask`,
  a reason, required for `deny`) and `tool-input` (replace the tool's input, granting
  nothing). Each codec delivers what its host can and rejects the rest with
  `HOOK_EFFECT_UNSUPPORTED`, never converting it. Codex delivers `deny` and `tool-input`
  (as `allow` plus `updatedInput`, which in Codex rewrites and grants nothing), not
  `allow` or `ask`; Claude Code delivers all three decisions and `tool-input` (as
  `updatedInput` without a decision). `notify-user` shows a text to the user, not the
  model (`systemMessage` in both hosts; card `k26`). A handler returns one effect or a
  list with at most one effect of each kind, which the codec merges into one output
  (skilletor writes context and a message at once); `no-decision` stands alone. All
  effects are JSON on stdout with exit 0.
- *Failure policy per entry.* `main({ onFailure })`: `"open"` (default) exits 1 with the
  one stderr line, so the host goes on (a `PreToolUse` tool runs). `"closed"` exits 2
  with the same line, which both hosts read as a block on `PreToolUse` and
  `UserPromptSubmit` (source-checked and documented, see the plan). The SDK returns 2
  only when the entry chose `"closed"`; the starters pass it through (ADR 0007).
- *Input bound per entry.* `maxInputBytes` stays per `main()` call, default 1 MiB. The
  bound applies before the event is known, so an entry that needs another bound for one
  event gets its own hook command (with an argument) for it.
- *Open unions.* `HostKind` (`codex`, `claude-code`), `HostSurface`, `ContextPlacement`,
  the effect kinds and `ErrorCode` may gain members in any minor release; a handler keeps
  a default branch. Removing or renaming a member is a breaking change.
- *Envelope version.* The envelope's `contractVersion: 1` becomes `envelopeVersion: 1`;
  `gettyBun.contractVersion` in a consumer's `package.json` stays the version of the
  integration contract. Two names for two things.

## Consequences

- `docs/plan.md` gets phase 2b; phase 3b loses the codec. ADRs 0006 and 0008 change only
  their status lines.
- skilletor's port gets its user-visible message (`k26`, pulled into 0.1.0 by the owner).
- A template in skilletor renders only into the skill's own directory
  (`skills/<name>/`), so `getty-bun-install` renders the pinned starters there and the
  plugin copies them into its `bootstrap/`, as the plan already says, checked in CI.
