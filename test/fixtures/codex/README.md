# Codex hook fixtures

Hook stdin and expected hook stdout for the Codex codec `src/codex.ts` (`SessionStart`,
`SubagentStart`; card k22), used by `test/codex.test.ts`. None of these fixtures comes from
a real Codex run: real runs are phase 3a.

**Evidence.** Every fixture is **source-checked** against openai/codex
`3f65e9f13165d85d1b1fbe20ce06c55758f927b9` (committed 2026-11-25), read in a shallow
clone and never built or run, except where its row says otherwise
(`input/subagent-start.extra-field.json` synthetic, `partial/subagent-start.briefing-tests.json`
from briefing, `output/context.json` encoder input, `entry.ts` a test entry). The `input/`
files (the synthetic one excepted) and `malformed/session-end.json` are also
**schema-checked** against the
schemas Codex generates from the same structs
(`codex-rs/hooks/schema/generated/*.command.input.schema.json`): every required key, no
extra key, and the types, `enum` and `const` values the schema gives. The two `.out`
files are schema-checked against the matching `*.command.output.schema.json`. All paths
below are relative to the Codex repository root.

## Byte conventions

- **Input** files hold what Codex writes to the hook's stdin: one compact JSON object, no
  whitespace, no trailing newline. Codex serializes the struct into a `serde_json::Value`
  (`codex-rs/hooks/src/events/session_start.rs:130-183`), writes `Value::to_string()`
  (`codex-rs/hooks/src/engine/dispatcher.rs:248`) with `write_all`
  (`codex-rs/hooks/src/engine/command_runner.rs:318-327`).
- **Key order** follows the struct declaration. Derived, not checked: `serde_json` keeps
  insertion order only with its `preserve_order` feature, which `codex-tui` enables
  (`codex-rs/tui/Cargo.toml:108`) and the `codex` binary links
  (`codex-rs/cli/Cargo.toml:80`); without that feature the keys come out sorted. A
  decoder must not depend on key order. Phase 3a records the real bytes.
- **Values** are synthetic, shaped the way Codex makes them: ids are UUIDv7 strings
  (`codex-rs/protocol/src/session_id.rs:19-24`, turn ids
  `codex-rs/core/src/session/mod.rs:1368-1375`); `transcript_path` is the thread's rollout
  file `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`
  (`codex-rs/rollout/src/recorder.rs:1668-1690`,
  `codex-rs/rollout/src/rollout_file_name.rs:62-73`); the model slug is the first entry
  of `codex-rs/models-manager/models.json:4`; `/home/dev/...` and `C:\Users\dev\...` are
  placeholders.
- **Output** `.out` files are the exact stdout bytes the encoder writes. The key order and
  the final LF are the codec's choice (k22), not a Codex requirement: Codex
  parses the object through serde, so key order is free, and trims stdout before parsing
  (`codex-rs/hooks/src/events/session_start.rs:245`,
  `codex-rs/hooks/src/engine/output_parser.rs:345-358`). The bytes equal
  `JSON.stringify(object) + "\n"`; checked with Bun 1.4.5 and with Python's `json`
  (compact, `ensure_ascii=False`), identical.
- `output/context.json` holds the `add-context` text as a single JSON string, so a final
  newline added by an editor cannot change it. The text has no trailing newline.

## input/: what Codex sends

| File | Case | Follows |
|---|---|---|
| `session-start.startup.json` | New thread (`InitialHistory::New`) | Struct `codex-rs/hooks/src/schema.rs:497-511`, built by `SessionStartCommandInput::new` (`schema.rs:526-545`) from `session_start.rs:130-151`; `source` strings `session_start.rs:23-42`, chosen in `codex-rs/core/src/session/session.rs:2197-2208`; `permission_mode` from `codex-rs/core/src/hook_runtime.rs:1121-1129` |
| `session-start.resume.json` | Resumed thread (`InitialHistory::Resumed`, or `Forked` without a fork parent) | As above; `session.rs:2201-2205` |
| `session-start.clear.json` | Cleared thread (`InitialHistory::Cleared`) | As above; `session.rs:2207` |
| `session-start.compact.json` | Same thread as `startup`, after compaction | As above; queued at `codex-rs/core/src/session/mod.rs:5227`, run at the next turn start (`codex-rs/core/src/session/turn.rs:387`, `:822-830`) |
| `session-start.fork.json` | Forked thread with a fork parent | As above; `session.rs:2198-2200` |
| `session-start.minimal.json` | The least Codex sends: all seven keys (Codex has no optional input key for this event; the generated schema's `required` lists all seven), `transcript_path` `null`, `permission_mode` `bypassPermissions` | No `skip_serializing_if` in `schema.rs:497-511`; `NullableString` serializes `None` as `null` (`schema.rs:43-55`); `null` when the thread has no local rollout (`codex-rs/core/src/session/mod.rs:6354-6366`); `bypassPermissions` for approval policy `never` (`hook_runtime.rs:1121-1129`) |
| `session-start.startup.windows.json` | `startup` with Windows paths | Shape as `startup`; the backslash form is derived from `Path::display()` (`session_start.rs:135`, `schema.rs:49`), not observed on Windows |
| `subagent-start.json` | Spawned subagent with role `reviewer` | Struct `schema.rs:547-563`, built `session_start.rs:153-182`; dispatched instead of `SessionStart` for a thread-spawned subagent on source `startup` or `fork` (`hook_runtime.rs:139-164`); `session_id` is the root thread's shared id (`codex-rs/core/src/session/session.rs:677-680`), `agent_id` the subagent's thread id and `agent_type` its role (`hook_runtime.rs:1143-1150`), `turn_id` the subagent's turn (`hook_runtime.rs:152`), `transcript_path` the subagent's rollout |
| `subagent-start.default-role.json` | Subagent spawned without a role | `agent_type` falls back to `default` (`hook_runtime.rs:1146-1148`, `codex-rs/core/src/agent/role.rs:30`; Codex's own test `codex-rs/core/tests/suite/subagent_notifications.rs:651-652`, `:732-735`) |
| `subagent-start.minimal.json` | The least Codex sends: all nine keys, `transcript_path` `null` | As `subagent-start.json`; `schema.rs:43-55`, `codex-rs/core/src/session/mod.rs:6354-6366` |
| `subagent-start.extra-field.json` | **Synthetic.** `subagent-start.json` plus a key Codex does not send for this event at this commit (`agent_transcript_path`, borrowed from `SubagentStopCommandInput`, `schema.rs:607-612`) | Fails Codex's generated schema (`additionalProperties: false`) on purpose: it stands for an additive Codex change, which the proposed decoder tolerates |

## partial/: keys Codex always sends, left out

Codex at this commit never sends these objects. The decoder accepts them, with the keys
missing from the envelope (k22: only `hook_event_name` is required; a present key of the
event's struct must have its type). The pin is a `main` commit, not the release phase 3a
runs (0.153.4), so a real host may omit keys this commit writes; requiring them would cost
the user the context.

| File | Case | Follows |
|---|---|---|
| `session-start.event-only.json` | Only `hook_event_name` | `schema.rs:504-505` |
| `subagent-start.event-only.json` | Only `hook_event_name` | `schema.rs:556-557` |
| `session-start.missing-source.json` | `session-start.startup.json` without `source` | `schema.rs:509-510`. Briefing `f7968f1` (`.claude/skills/briefing-core/references/hook-contract.md`, "SessionStart") checks a missing `source` like `startup` |
| `subagent-start.missing-agent-type.json` | `subagent-start.json` without `agent_type` | `schema.rs:561-562` |
| `subagent-start.briefing-tests.json` | The payload briefing's Codex tests feed its hook: five of the nine keys | Briefing `f7968f1`, `tests/test_briefing_codex.py:60-68` (`_payload`), with `cwd` made concrete. Not a Codex artifact |

## malformed/: what the decoder rejects

The first three exercise the core's reader (k21), which rejects them before the codec
decodes anything; the codec tests can still feed the parsed array to the decoder. Through
`main()` each one ends in exit 1, no stdout and one stderr line with the code below.

| File | Case | Follows |
|---|---|---|
| `empty.json` | Zero bytes | Core reader: no object (`HOOK_INPUT_INVALID`) |
| `truncated.json` | `session-start.startup.json` cut after `transcript_path` | Core reader: input ends inside the object (`HOOK_INPUT_INVALID`) |
| `not-an-object.json` | A JSON array | Core reader (and decoder): not an object (`HOOK_INPUT_INVALID`) |
| `missing-hook-event-name.json` | `startup` input without `hook_event_name` | Decoder: no event (`HOOK_INPUT_INVALID`) |
| `hook-event-name-number.json` | `hook_event_name` is `7` | Decoder: wrong type (`HOOK_INPUT_INVALID`) |
| `session-end.json` | A real Codex `SessionEnd` input, valid for Codex | Struct `schema.rs:513-524`, `reason` const `other` (`schema.rs:805-807`); decoder: unsupported event (`HOOK_EVENT_UNSUPPORTED`) |
| `subagent-start.turn-id-number.json` | `turn_id` is `1` | Decoder: wrong type, `schema.rs:553` (`HOOK_INPUT_INVALID`) |
| `session-start.transcript-path-number.json` | `transcript_path` is `0` | Decoder: string or `null` only, `schema.rs:43-68` (`HOOK_INPUT_INVALID`) |

## output/: what the encoder writes

| File | Effect | Follows |
|---|---|---|
| `context.json` | The `add-context` text: quotes, backslashes, newlines, a tab, non-ASCII and an astral character; well-formed UTF-16 | Input to the encoder, not a Codex artifact |
| `session-start.add-context.out` | `add-context`, audience `model`, placement `session-start-input`, on `SessionStart` | Parsed by `parse_session_start` (`codex-rs/hooks/src/engine/output_parser.rs:93-100`) into `SessionStartCommandOutputWire` (`schema.rs:385-404`); `additionalContext` is used as is, not trimmed (`session_start.rs:264-272`), and recorded as a developer message in the thread (`codex-rs/core/src/context/hook_additional_context.rs:19-42`, `hook_runtime.rs:908-924`) |
| `subagent-start.add-context.out` | `add-context`, audience `model`, placement `subagent-input`, on `SubagentStart` | Parsed by `parse_subagent_start` (`output_parser.rs:102-109`) into `SubagentStartCommandOutputWire` (`schema.rs:406-425`); recorded in the subagent's thread before its first model request (`hook_runtime.rs:139-201`, `turn.rs:387`) |
| `no-decision.out` | `no-decision` on either event: zero bytes, exit 0 | Empty or all-whitespace stdout with exit 0 completes the hook without entries (`session_start.rs:243-246`) |

## entry.ts: the end-to-end entry

`entry.ts` is not a Codex artifact: a hook entry on `main({ codec: codex, handler })` that
`test/codex.test.ts` runs as a real Bun process. The test writes a fixture to its stdin
pipe and closes it, as Codex does on the local path (`command_runner.rs:318-327`); with
argument `context` the handler answers `add-context` with `output/context.json` at the
event's placement, with `none` it answers `no-decision`. Every `input/` and `partial/`
fixture gives the matching `.out` bytes and exit 0.
