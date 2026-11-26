# Claude Code hook fixtures

Hook stdin and expected hook stdout for the Claude Code codec `src/claude-code.ts`
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `CwdChanged`; card k36).
No fixture here comes from a Claude Code run of this repository.

**Evidence.** Each row names one of:

- **executed (loadguard k7, CC 2.1.283)**: copied byte for byte from loadguard
  `b517415`, `t/fixtures/` (added in loadguard `98af840`, k7). loadguard recorded them as
  the verbatim stdin of its hook in one isolated `claude -p` session on Linux with Claude
  Code 2.1.283, 2026-09-26 (its `t/fixtures/README.md`). The paths in them are that
  throwaway session's.
- **schema-checked**: built field by field from the hook input schemas of
  `@anthropic-ai/claude-code-linux-x64@2.1.332` (npm latest on 2026-11-26, never run),
  `cc@N` being a byte offset into its `claude` binary: the common keys at cc@331043635,
  per event `SessionStart` cc@331049055, `UserPromptSubmit` cc@331047365, `PreToolUse`
  cc@331045181, `PostToolUse` cc@331046105, `CwdChanged` cc@331057289; and from the
  builders that fill them (`Sh` cc@345560895; `SessionStart` cc@345541894,
  `UserPromptSubmit` cc@345553032, `PreToolUse` cc@344148346, `PostToolUse` cc@344149310,
  `CwdChanged` cc@345534790). Values follow the examples of the hooks reference,
  https://code.claude.com/docs/en/hooks, fetched 2026-11-26 (`hooks.md:N`, a line of its
  markdown).
- **synthetic**: made to exercise the decoder; the row says what it changes.

## Byte conventions

- **Input** files hold what Claude Code writes to the hook's stdin:
  `JSON.stringify(hookInput)` and one LF (serialized at cc@345645322 with
  `function _(e,n,r){return JSON.stringify(e,n,r)}`, cc@328987159; written as
  `ps+g+"\n"`, `ps` empty, at cc@345587062). The recorded files end in that LF as well.
  The `malformed/` files `empty.json` and `truncated.json` are the exceptions.
- **Key order** follows the builder: `Sh`'s keys (`session_id`, `transcript_path`,
  `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `agent_id`, `agent_type`,
  `effort`), then `hook_event_name` and the event's keys. A key whose value is
  `undefined` is left out by JSON.stringify. The recorded files show the same order. A
  decoder must not depend on it.
- **Values** in schema-checked files are placeholders: `/home/dev/...` and
  `C:\Users\dev\...`, UUID session and prompt ids, `toolu_...` tool use ids.
- **Output** `.out` files are the exact stdout bytes the encoder writes:
  `JSON.stringify(object)` and one LF, written by hand from the hooks reference, not
  produced by the codec. `output/effects.json` names for each the event (one name, a
  list of names, or `*` for any event) and the list of effects the handler returns, in
  the handler's order; a list's order does not change the bytes.
  Claude Code trims stdout and reads it as JSON when it starts with `{` (`k8`,
  cc@340850125; hooks.md:829-837), so the LF and the key order are the codec's choice.

## input/: what Claude Code sends

| File | Evidence | Case |
|---|---|---|
| `session-start.startup.json` | schema-checked | New session: `source` `startup`, `model`; no `permission_mode` (`SessionStart` passes none to `Sh`), no `prompt_id` (absent until the first prompt, hooks.md:758) |
| `session-start.resume.json` | schema-checked | The resume example of hooks.md:1336-1347 with `scratchpad_dir`, `session_title` and the four resume fields (v2.1.251 or later, hooks.md:1324-1331) |
| `session-start.clear.json` | schema-checked | `/clear` without `model`, which "can be omitted, for example after `/clear`" (hooks.md:1318) |
| `user-prompt-submit.json` | schema-checked | The example of hooks.md:1555-1562 with `scratchpad_dir` and `prompt_id` |
| `user-prompt-submit.titled.json` | schema-checked | As above, `permission_mode` `acceptEdits`, `session_title` (hooks.md:1552) |
| `pre-tool-use.bash.json` | executed (loadguard k7, CC 2.1.283) | loadguard `bash-plain.json`: `Bash` with `{"command":"pwd"}` |
| `pre-tool-use.bash-background.json` | executed (loadguard k7, CC 2.1.283) | loadguard `bash-background.json`: `run_in_background: true` |
| `pre-tool-use.bash-probe.json` | executed (loadguard k7, CC 2.1.283) | loadguard `updated-input/probe-a.pre.json`: the call whose input probe A rewrote with `updatedInput` alone (`output/pre-tool-use.tool-input.out` is that hook's output) |
| `pre-tool-use.mcp-subagent.json` | schema-checked | An MCP tool in a subagent: `agent_id`, `agent_type`, `effort` (an object, hooks.md:763), `mcp_server` `{name, source}` (cc@331042534, v2.1.274 or later, hooks.md:1886), `permission_mode` `auto` |
| `pre-tool-use.write.windows.json` | schema-checked | `Write` with Windows paths; the backslash form follows hooks.md:1888-1906, not observed on Windows |
| `post-tool-use.bash.json` | executed (loadguard k7, CC 2.1.283) | loadguard `updated-input/probe-a.post.json`: the rewritten command after it ran, with `tool_response` and `duration_ms` |
| `post-tool-use.write.json` | schema-checked | The example of hooks.md:2378-2395 |
| `post-tool-use.failed-string-response.json` | schema-checked | `tool_response` a string: "For a failed call, `tool_response` is the error text as a string" (hooks.md:2375) |
| `cwd-changed.json` | schema-checked | The example of hooks.md:3202-3209 with `prompt_id`; no `permission_mode` (`CwdChanged` passes none to `Sh`) |

## partial/: keys a 2.1.332 host always sends, left out

The decoder accepts them (only `hook_event_name` is required; `session_id`, `cwd` and,
on the tool events, `tool_name` must be strings when present), with the keys missing from
the envelope.

| File | Evidence | Case |
|---|---|---|
| `session-start.event-only.json` | synthetic | Only `hook_event_name` |
| `pre-tool-use.event-only.json` | synthetic | Only `hook_event_name`: no `tool` in the envelope |
| `pre-tool-use.no-tool-input.json` | synthetic | `pre-tool-use.bash.json` without `tool_input`: no `tool` in the envelope |
| `cwd-changed.event-only.json` | synthetic | Only `hook_event_name` |
| `session-start.remote-call.json` | schema-checked | What `Sh` writes for a remote call (cc@345560895): `session_id` `served:unknown`, `transcript_path` `""` |

## generic/: events without rules

Valid Claude Code inputs of events the codec decodes generically
(`decodeGenericEvent`): `session_id` and `cwd`, everything else in `native.input`, no
`tool`; only `no-decision` encodes (`""`), anything else (`notify-user` included) is
`HOOK_EFFECT_UNSUPPORTED`.

| File | Evidence | Case |
|---|---|---|
| `stop.json` | schema-checked | `Stop` with `stop_hook_active`, `last_assistant_message`, empty `background_tasks` and `session_crons` (schema cc@331051301) |
| `pre-compact.json` | schema-checked | `PreCompact` with `custom_instructions` `null` (`.nullable()` in schema cc@331052975); the generic decoder does not check it |

## malformed/: what the decoder rejects

The decoder checks only the keys it lifts into the envelope (ADR 0009): `hook_event_name`
(a string, required), `session_id` and `cwd` on the five events, `tool_name` on `PreToolUse`
and `PostToolUse` (strings when present; `null` is rejected, the 2.1.332 schemas have no
nullable there). Through `main()` each file ends in exit 1 (exit 2 with
`onFailure: "closed"`), no stdout and one stderr line
`agent-bun-runtime: HOOK_INPUT_INVALID: ...`. All synthetic.

| File | Case | Rejected by |
|---|---|---|
| `empty.json` | Zero bytes | Core reader |
| `truncated.json` | `session-start.startup.json` cut after 60 bytes, no LF | Core reader |
| `not-an-object.json` | A JSON array holding the startup input | Core reader |
| `missing-hook-event-name.json` | Startup input without `hook_event_name` | Decoder |
| `hook-event-name-number.json` | `hook_event_name` is `7` | Decoder |
| `session-start.session-id-number.json` | `session_id` is `1` (common key, cc@331043635) | Decoder |
| `session-start.session-id-null.json` | `session-start.startup.json` with `session_id` `null`: not nullable in the schema (cc@331043635) | Decoder |
| `pre-tool-use.tool-name-number.json` | `pre-tool-use.bash.json` with `tool_name` `1` | Decoder |
| `post-tool-use.tool-name-null.json` | `post-tool-use.bash.json` with `tool_name` `null` (cc@331046105) | Decoder |

## lenient/: wrong types on keys the decoder does not lift

Each decodes like the file it was made from: the wrong value stays in `native.input`,
unchecked, and the envelope is the same. A Claude Code release that changes the type of a
key no consumer reads must not fail every hook. All synthetic; until the k36 review
finding they were `malformed/`.

| File | Case | Decodes as |
|---|---|---|
| `session-start.model-null.json` | `model` is `null` (the schema has it optional, not nullable, cc@331049055) | `SessionStart`, `session_id` and `cwd` lifted |
| `session-start.context-tokens-string.json` | `context_tokens` is a string, the schema a number | As above |
| `user-prompt-submit.prompt-number.json` | `prompt` is `42` | `UserPromptSubmit` |
| `user-prompt-submit.effort-array.json` | `effort` is an array, the schema an object | `UserPromptSubmit` |
| `pre-tool-use.mcp-server-string.json` | `pre-tool-use.bash.json` with `mcp_server` a string | `PreToolUse` with `tool` as in `pre-tool-use.bash.json` |
| `post-tool-use.duration-ms-string.json` | `post-tool-use.bash.json` with `duration_ms` `"227"` | `PostToolUse` with `tool` as in `post-tool-use.bash.json` |
| `cwd-changed.new-cwd-null.json` | `new_cwd` is `null` | `CwdChanged` |

## output/: what the encoder writes

The add-context text holds quotes, a backslash, a newline, a tab, non-ASCII and an
astral character. Every `.out` file but `no-decision.out` follows the hook output schema
`NM` (cc@338275692). A list becomes one object with the keys in a fixed order:
`systemMessage`, `hookSpecificOutput`, inside it `hookEventName`, `permissionDecision`,
`permissionDecisionReason`, `updatedInput`, `additionalContext` (the order of
hooks.md:2102-2114). The effects of the combined rows are listed out of that order on
purpose.

| File | Effect on event | Follows |
|---|---|---|
| `session-start.add-context.out` | `add-context` at `session-start-input` on `SessionStart` | hooks.md:1167-1184, :1356; schema cc@338277170 |
| `user-prompt-submit.add-context.out` | `add-context` at `prompt-input` on `UserPromptSubmit` | hooks.md:1185, :1584; schema cc@338276709 |
| `post-tool-use.add-context.out` | `add-context` at `tool-result` on `PostToolUse` | hooks.md:1186, :2410; schema cc@338278101 |
| `post-tool-use.add-context.lone-surrogate.out` | As above, text with an unpaired surrogate, written as the escape `\ud800` | Claude Code parses stdout with `JSON.parse` (cc@328987414, from `k8` cc@340850125), which accepts the escape; what happens to the string after that is not checked |
| `pre-tool-use.allow.out` | `tool-permission` `allow`, no reason | hooks.md:2085-2098; enum cc@338275648, schema cc@338276422 |
| `pre-tool-use.allow-reason.out` | `tool-permission` `allow` with a reason (debug log only, hooks.md:2092) | As above |
| `pre-tool-use.deny.out` | `tool-permission` `deny` with a reason (shown to Claude) | As above; the reason is hooks.md:1258's example |
| `pre-tool-use.ask.out` | `tool-permission` `ask` with a reason (shown in the prompt) | As above |
| `pre-tool-use.ask-no-reason.out` | `tool-permission` `ask`, no reason | As above |
| `pre-tool-use.tool-input.out` | `tool-input` `{"command":"echo LOADGUARD_PROBE_B"}`, no decision | hooks.md:2093; the same object loadguard's probe A printed (`updated-input/probe-a.hook-out.json`, with spaces), after which the rewritten command ran (executed, loadguard k7, CC 2.1.283) |
| `notify-user.out` | `notify-user` alone on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` or `CwdChanged`: top-level `systemMessage` only | hooks.md:1115 (universal field), :1014 (`PreToolUse`), :3222 (`CwdChanged`: a terminal notification in interactive sessions, not in the SDK stream); schema cc@338276066; parser `rse` copies it for any event, cc@345564904 |
| `session-start.add-context.notify-user.out` | `notify-user` then `add-context` at `session-start-input` on `SessionStart`: `systemMessage` beside `hookSpecificOutput` | As `notify-user.out` and `session-start.add-context.out`; skilletor writes the same pair (its `src/hooks.ts:336-341`) |
| `pre-tool-use.allow.tool-input.out` | `tool-input` then `tool-permission` `allow` with a reason on `PreToolUse`: one `hookSpecificOutput` with `permissionDecision`, `permissionDecisionReason`, `updatedInput` | "Combine with `allow` to auto-approve" (hooks.md:2093), example hooks.md:2102-2114; branch cc@345565260 |
| `no-decision.out` | `no-decision` on any event: zero bytes, exit 0 | "Plain text, or nothing" with exit 0 is a success (hooks.md:817) |
