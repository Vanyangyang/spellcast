# Codex observer hooks (phase B)

Windows packaging of the native helper has been exercised in this repository. Other operating systems are **not** claimed as tested.

## Three different receipts

| Receipt | Meaning |
| --- | --- |
| Native hook execution / context output | `spellcast-hook` wrote `{hookSpecificOutput:{...}}` to stdout. This is not proof the model read it. |
| Model-triggered checkpoint | The main task called `spellcast_checkpoint` and got `ready`. |
| Observer complete / window ready | The child called `spellcast_observer_complete`, or a bubble window initialized. |

Installing the plugin is not hook trust. Codex still requires an explicit trust step. Do not use `--dangerously-bypass-hook-trust`.

## What the helper does

- Reads a short Codex hook JSON from stdin (`session_id`, `hook_event_name`, `source`, explicit subagent fields).
- Does **not** read user prompts, transcripts, parent history, or project files.
- GETs `http://127.0.0.1:<port>/api/observer/status` over loopback HTTP only (no TLS, no credentials, no redirects, HTTP timeout 500ms).
- Does not open Spellcast SQLite and does not start the app.
- Writes cache under `PLUGIN_DATA/spellcast-hook/` using a hash of endpoint+session_id, never the raw id.
- On errors and timeouts it exits 0 and prints nothing (or one stop notice when withdrawing a previously injected ON).
- Cache “already injected” is not proof the model used the text. Host receipt of injected context remains UNKNOWN. Do not treat helper stdout or `injected=true` as a server receipt.
- Bounded local diagnostics (`diag.jsonl`, ≤256KiB) record enum stages (`parse`, including `unsupported_event` for JSON-legal unregistered hook names, `missing_session`, `child_skip`, `http`, `save`, `action`, `stdout_write`), event name, hashed session, source kind, helper version, and bootstrap digest. They never store prompts, transcripts, cwd, or raw source text. A missing HTTP stage is `not_attempted` (early return) and is not a server receipt. All diagnostic file I/O, including path selection (`exists` / `is_dir`), runs in an isolated worker; the helper waits at most 25ms then exits 0 with stdout already written, without joining a stalled writer. Metadata, truncate, or seek failure drops that line instead of appending at a wrong offset. Append, size check, and rotation run under a cross-process `try_lock_exclusive` (`fs2`); a busy lock drops that line instead of queueing. Diagnostic I/O failure must not change exit 0 or stdout. Cache `injected=true` is not a host receipt that the model used the text.
- Session cache load/decide/save is one file-lock transaction (`fs2`). UserPromptSubmit emits only after a successful save. Missing or unwritable cache: SessionStart may still print a short entry; UserPromptSubmit stays empty. A lock timeout is **Busy** (empty for every event), not the same as missing cache.
- `resume` / `compact` / `clear` SessionStart always refresh while asides are on; they are not suppressed by a stored last_emit tag.
- A status payload whose `policy_revision` is older than the cache is ignored (no Bootstrap and no Stop). Offline fetches have no new revision and must not write revision 0 over a known value.
- Manual Codex plugin install steps are in `hooks/INSTALL.md`. Installing is not hook trust and not a completed checkpoint.

## Events

- `SessionStart` matcher `startup\|resume\|clear\|compact`. Resume/compact always refresh ON context even if `policy_revision` is unchanged.
- `UserPromptSubmit` only emits on a setting change, a missed startup, or recovery. Unchanged turns are empty.
- Child skip follows the Codex hook contract: native non-empty `agent_id`/`agentId` (UserPromptSubmit SubAgent spawn) skips regardless of `agent_type` (`default`, `terra_max`, or other). Compat markers still skip: `is_subagent=true`, non-empty `subagent_id`, or exact `agent_type` `child`/`subagent`/`observer`. `parent_session_id` and `spawned_by` alone do not skip. Unknown extra fields are ignored and never written to diag. SubagentStart/Stop are not registered. This is schema adaptation, not a claim that a local cold-start failure is attributed.
- When the App switch is ON, the injected bootstrap is the **self-contained** parent/child protocol for native MCP. It does not point at Skill or `asides.md`. Checkpoint, observer spawn, and complete are background work, not main-chat progress. The main task does not pre-judge bubble value. Only `ready` starts a child. This document does not claim a later cold task has been run.
- `board_focused` does not withdraw asides; the server checkpoint still gates actual focus.
- Pause or OFF after an injected ON emits one short stop notice.

## Same instance

Package generation writes hook `--endpoint` and MCP `url` together. Do not point MCP at production and the hook at an isolated instance. `--source` hook texts that differ from the repo helper tree are refused (no mixed include_str exe + foreign bootstrap). Pack checks run the built helper against an isolated loopback mock, not production 47194. Windows `commandWindows` is a `powershell.exe` launcher (Join-Path + `PLUGIN_ROOT` env) because Codex executes that string via the user shell; POSIX `command` stays a quoted helper path. Matcher is unchanged. Changing `commandWindows` changes the trusted hook hash; do not write `trusted_hash` or pass a trust-bypass flag.

## Child protocol

The bootstrap carries the parent protocol and the child brief to forward. Skill remains for Canvas, feedback, explicit memory, and aside fallback on hosts without this hook.
