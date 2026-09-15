---
name: spellcast
description: Use connected Spellcast for independent asides as fresh project context emerges during ongoing work, or for its Canvas, task feedback, and explicit memory.
---

# Spellcast

Spellcast gives the user's existing Agent two surfaces: sparse desktop bubbles and a Canvas for kept thoughts, complete replies, and interactive Web works. The model stays in its host. Independent asides use a short-lived host subagent; Spellcast gates its checkpoint and delivery, but does not run a model or wake an inactive task by itself.

## Boundaries

- Use one stable `source_id` per host task (for example `codex:task-uuid`) when sending bubbles, publishing Canvas replies, or listening for that task's feedback. Keep it across those turns. A model name is not a task identifier. If those tools are unavailable, report the connection gap; a successful direct HTTP test is not host registration.
- In Codex, bind the current `CODEX_THREAD_ID` from the host's native execution environment, or the current task ID from host startup metadata, via `spellcast_bind_codex` with that UUID, your source, and cwd — only when publishing task-owned bubbles or Canvas replies, or when handling that task's feedback. Never substitute another task or the most recent conversation. Memory-only work does not bind a task.
- When working on the board, `surface` is the selected presentation mode and `board_focused` is actual window focus. If the board is in focus and the user is working there, make the board the reply surface; a short host acknowledgement is enough.
- Independent asides: the App switch is the authority. If the current context already contains the complete native hook protocol, execute it via native MCP and do not narrate checkpoint, spawn, or complete as chat progress. Otherwise follow [references/asides.md](references/asides.md). unknown is not OFF. Memory-only work does not start aside checks.
- When modifying existing Canvas content, read current versions first. User-edited content and user-adjusted layout stay protected; a conflict remains a reviewable proposal. Do not replace an entire reply to evade that protection. Do not clear a board the user edited without permission.
- Follow the user's host role/model selection; Spellcast does not choose a model and does not promise automatic asides in every host.

## When to read more

- Independent observers, child brief, and bubble display: [references/asides.md](references/asides.md)
- Atomic Canvas objects, versions, proposals, and selected source: [references/canvas.md](references/canvas.md)
- Interactive works, artifacts, and dataflow: [references/works.md](references/works.md)
- Binding, queued/read/replied/handled receipts, ack, and anchors: [references/feedback.md](references/feedback.md)

## Memory

- Call `spellcast_remember` only when the user explicitly asks to remember something or clearly confirms that it should persist. Save a concise, self-contained fact, preference, decision, or reminder.
- A kept bubble or board item can survive restart but is not automatically memory. Never promote it without the user's intent.
- Call `spellcast_recall` before claiming what Spellcast remembers. An empty query returns recent memories; a text query searches their titles and contents.
- Call `spellcast_forget` with the exact returned memory id when the user asks to remove it. Report success only after the tool succeeds.
