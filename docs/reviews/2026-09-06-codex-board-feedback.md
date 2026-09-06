# Board feedback to the real Codex CLI

Status: implementation proposal, with a local CLI proof. This is not yet wired into Spellcast's board buttons.

## What was verified

- The computer's installed `codex` was updated from 0.147.0 to 0.153.4, matching the official npm registry's current `@openai/codex` version on September 6, 2026.
- A real, visible interactive CLI session runs Sol / high in `G:\Demos\Calendar`.
- Session `01a0753b-0e36-70d1-b010-30a607d95ffe` called registered native Spellcast MCP tools and generated its own calendar-related thoughts. Its source is `codex:calendar-sol-20260906`.
- `codex queue --thread <id> --message <text>` returned queued message `01a07540-fb7e-76f3-81b6-e73f6b1f1b17`. The same session subsequently received that exact message, ran its calendar verification again, and completed the follow-up. A later queue message requested an SVG preview and started another turn in the same visible CLI.
- This proves queue delivery and continued execution in the tested open CLI session. It does not prove recovery after the CLI, host daemon, or computer has exited.

## Smallest useful first integration

Store an explicit binding from Spellcast `source_id` to the host's actual `thread_id`, working directory and verified CLI executable. Neither a model name nor a human-readable source label is a session identity. The binding must come from the host integration or an explicit user selection; never infer it from whichever conversation is most recent.

Keep two distinct board actions:

| User action | Host operation | Meaning |
| --- | --- | --- |
| Send to Codex | `codex queue --thread <bound-id> --message <request>` | Add the instruction to that existing task. |
| Open in Codex | Open a terminal running `codex resume <bound-id> -C <bound-cwd>` | Show the existing conversation. Opening alone does not submit another instruction. |

Use process argument arrays, not a shell command assembled from board text. Preserve the session's selected model and effort. Do not fall back to a new conversation if the binding cannot be resolved.

The existing durable Spellcast feedback inbox can remain the source of truth. Persist the board request first, then queue a concise instruction telling the bound agent to read the relevant Spellcast feedback. The agent produces `spellcast_reply` or `spellcast_update`, and calls `spellcast_ack` only after handling the request. A successful queue operation is not the same as a completed reply.

Keep transport delivery state separate from the agent's acknowledgement: pending, queued, failed, handled. Use the feedback event id to prevent repeated clicks from creating duplicate queue operations. If the queue process exits without a conclusive result, retain an unknown delivery state instead of automatically duplicating the request.

## When a richer host connection is justified

Codex's official App Server API supplies `thread/read`, `thread/resume`, `turn/start`, `turn/steer`, and streamed progress. `turn/steer` requires the current `expectedTurnId`; use it only for an explicitly requested change to active work. Resume and start a turn are separate operations. See the [official App Server protocol](https://developers.openai.com/codex/app-server).

Connect to the runtime that owns the live CLI session. During this test, the desktop task reader reported the CLI task as `notLoaded`, and an unfinished persisted turn as `interrupted`, while the real CLI window was visibly working. A snapshot from another app-server process must not be used to conclude that the CLI is idle or safe to resume elsewhere.

The documented TCP WebSocket transport is experimental. A production integration should select a supported local transport and deliberately own connection/reconnection and approval handling; it should not start an unauthenticated network listener just to send board feedback. The [official CLI reference](https://developers.openai.com/codex/cli/reference) documents interactive `resume` and explicit working-directory selection. The `queue` command above is supported by the installed 0.153.4 CLI's own help and the local execution proof; it was not found on the fetched public reference page.

## Acceptance still required before shipping the integration

Verify open-idle and busy sessions, a closed CLI, a stopped host daemon, unresolved or stale bindings, repeated requests, non-ASCII text and quotes, rejection/error recovery, and a reply returning to the exact originating node. Keep “opened”, “queued”, “running”, and “handled” as separate outcomes. No automatic queue or resume adapter has been added to Spellcast in this change.
