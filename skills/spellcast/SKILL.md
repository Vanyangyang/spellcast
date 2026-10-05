---
name: spellcast
description: Use connected Spellcast for independent asides as fresh project context emerges during ongoing work, or for its Canvas, task feedback, annotations (注释/批注), and explicit memory. When the user asks to process annotations, handle all pending annotations belonging to the current chat and mark only successfully handled versions complete.
---

# Spellcast

Spellcast gives the user's existing Agent two surfaces: sparse desktop bubbles and a Canvas for kept thoughts, complete replies, and interactive Web works. The main task stays in its host and submits aside checkpoints. For Claude asides the App runs its fixed fresh Claude Code Opus 5.5 xhigh runner and completes the ticket directly; Codex asides use a short-lived isolated Codex child. Spellcast gates checkpoints and delivery; it does not wake an inactive main task by itself.

## Boundaries

- Use one stable `source_id` per host task (for example `codex:task-uuid` or `grok:<session-or-task-id>`) when sending bubbles, publishing Canvas replies, or listening for that task's feedback. Keep it across those turns. A model name is not a task identifier. If those tools are unavailable, report the connection gap; a successful direct HTTP test is not host registration.
- In Codex, bind the current `CODEX_THREAD_ID` from the host's native execution environment, or the current task ID from host startup metadata, via `spellcast_bind_codex` with that UUID, your source, and cwd — only when publishing task-owned bubbles or Canvas replies, or when handling that task's feedback or annotations. Never substitute another task or the most recent conversation. Memory-only work does not bind a task.
- Grok Build hosts use a stable `source_id` such as `grok:<session-or-task-id>`. There is no binding tool; do not invent one or reuse `spellcast_bind_codex`.
- When working on the board, `surface` is the selected presentation mode and `board_focused` is actual window focus. If the board is in focus and the user is working there, make the board the reply surface; a short host acknowledgement is enough.
- Independent asides: the App switch is the authority. If the current context already contains the complete native hook protocol, execute it via native MCP and do not narrate checkpoint, spawn, or complete as chat progress. Otherwise follow [references/asides.md](references/asides.md). unknown is not OFF. Memory-only work does not start aside checks.
- When modifying existing Canvas content, read current versions first. User-edited content and user-adjusted layout stay protected; a conflict remains a reviewable proposal. Do not replace an entire reply to evade that protection. Do not clear a board the user edited without permission. Host tools publish and update this source's content; layout, grouping, annotations, selection and send stay in the Spellcast window.
- Follow the user's host role/model selection for Codex aside children. The App-selected Claude provider uses its fixed runner; do not change the App's provider or create a courier child. Spellcast does not promise automatic asides in every host.
- When the user explicitly asks to process annotations or revise content according to their notes, use `spellcast_annotations` with `action="pending"` for the current task's stable `source_id`. Process every returned page for this chat, including notes on unselected content. Questions about the annotation UI and instructions to postpone processing do not authorize handling notes. After actually handling each note, call `action="complete"` with its exact `id` and `revision`; leave blocked, failed, or unapplied-proposal notes pending. Never change or delete the user's note text to record completion. See [references/canvas.md](references/canvas.md#process-annotations-for-the-current-chat).

## When to read more

- Independent observers, child brief, and bubble display: [references/asides.md](references/asides.md)
- Atomic Canvas objects, versions, proposals, and selected source: [references/canvas.md](references/canvas.md)
- Interactive works, artifacts, and dataflow: [references/works.md](references/works.md)
- Binding, queued/read/replied/handled receipts, ack, and anchors: [references/feedback.md](references/feedback.md)
- Pending annotations, completion state, and user deletion: [references/canvas.md](references/canvas.md#process-annotations-for-the-current-chat)
- Project development records, immutable history, authorized task handoff and portable export: [references/project-records.md](references/project-records.md)
- A delivered 游戏开发 goal (`project_context.kind` is `goal` or `proposal_return`): answer only with `put_proposal`, never direct planning writes; read [references/project-records.md](references/project-records.md) first.
- A delivered document selection question (`project_context.kind` is `document_question`): answer with an attributed `put_record` review comment linked to the exact goal and source, then ack; read [references/project-records.md](references/project-records.md) first. Do not alter the source document or canonical planning design.

## Memory

- Call `spellcast_remember` only when the user explicitly asks to remember something or clearly confirms that it should persist. Save a concise, self-contained fact, preference, decision, or reminder.
- A kept bubble or board item can survive restart but is not automatically memory. Never promote it without the user's intent.
- Call `spellcast_recall` before claiming what Spellcast remembers. An empty query returns recent memories; a text query searches their titles and contents.
- Call `spellcast_forget` with the exact returned memory id when the user asks to remove it. Report success only after the tool succeeds.
