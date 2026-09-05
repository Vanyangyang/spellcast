---
name: spellcast
description: Rules for the Spellcast desktop stage, including sparse bubbles, the board, feedback, and explicit durable memory through spellcast_* tools. Use when the user mentions Spellcast, a bubble, the board, desktop asides, or asks Spellcast to remember, recall, or forget something; and whenever calling a spellcast_* tool. Do not load merely because a task is creative or imaginative.
---

# Spellcast

Spellcast gives the user's existing Agent two surfaces: sparse desktop bubbles and an Everything board for complete, structured replies. The model stays in its host. Spellcast stores and presents content; it does not run a model or wake an inactive task by itself. This skill matches Spellcast 0.2.

## Start with the current surface

Read `spellcast_board` and use one stable `source_id` per host task, such as `codex:task-uuid`. Keep it across turns and pass it when sending bubbles, replies, and listening. A model name alone is not a task identifier. If the tools are unavailable, report the connection gap; a successful direct HTTP test is not host tool registration.

When the board is in focus and the user is working there, make the board the reply surface. A short link or acknowledgement in the host chat is enough; do not duplicate the entire reply. In ambient mode, keep the host conversation coherent on its own and throw only worthwhile side thoughts.

## Throw sparingly

- Use `spellcast_bubble` only for a thought worth the user's attention that does not belong in the main reply: a complaint or friction, doubt, outside suggestion, reminder, risk, aside, or creative spark.
- Default to no bubble. Prefer one; the app admits at most two active bubbles and suppresses recent duplicate thoughts, paused delivery, and delivery while the board is in focus.
- Make `tease` the complete thought, at most 120 characters and readable without chat context. Put optional detail in `body`.
- Choose `kind` honestly. Use `question` only for something that can wait.
- If the result is `not_shown`, `expired`, or `dismissed`, stay quiet in the main conversation and do not rethrow the same thought.
- `accepted` confirms scheduling only. A later `ready` event confirms window initialization; neither proves the user read it.

Never use a bubble for progress narration, tool announcements, status updates, generic praise, repetition of the main reply, or anything the user must see to understand that reply. Never hide a blocking question in a bubble; ask it in the main conversation.

## Reply on the board

Starring a bubble adopts it onto the board. A `kept` event supplies its `node_id`; it is not automatically a request for an expanded reply. When the user asks to explore it, use `spellcast_reply` with that `origin_node_id`, your task's `source_id`, a readable `source_label`, and complete content. Mix the forms that help the thought:

- `text`: framing, a concrete insight, explanation, or decision.
- `comparison`: alternatives with the same criteria and aligned values; give options stable IDs.
- `graph`: explicit relationships with labeled edges; proximity alone must not imply a dependency or causal claim.
- `sequence`: an ordered walkthrough, storyboard, or plan with clear step titles and notes.

Do not force every answer into all four forms. Prefer a focused composition the user can inspect and act on. Use stable reply and block IDs. Re-read `spellcast_board` before editing; use `spellcast_update` for one block with the latest `expected_revision`. If a revision conflicts, reconcile the user's current edits instead of retrying an old whole reply. Preserve user choices and layout unless the request changes them.

`spellcast_present` remains available for arranging kept idea cards (constellation, spatial, timeline, stack). `spellcast_reply` is the complete board-answer surface. Do not clear a board the user edited without their permission.

## Read feedback carefully

Call `spellcast_listen` at a natural checkpoint or the start of a later turn, with your `source_id` and last sequence as `since`. Explicit feedback persists until acknowledged, so it can be returned even if its sequence is older than `since`. After actually handling it, call `spellcast_ack` with your source and the exact handled sequence numbers. Never acknowledge another task's input.

- `reply` and `say` are explicit user input. Bring them into the main conversation only when they change the task.
- `kept` means the user wants the thought to stay on the board; `unkept` withdraws that choice.
- `dismiss` and `expired` mean the thought was not acted on now, not that its content was rejected. Do not argue for it or repeat it.
- `poke` means interest, not agreement.
- `board_edit` and `cleared` mean the board may no longer match the last presentation. Re-read it before relying on it.
- `selection` identifies the reply, block, and chosen option. `reply_edit` means the user changed a block; read that current block before responding. A graph-layout-only move does not ask for a semantic answer.

Feedback is queued until the originating task reads it. Do not promise immediate automatic replies from an inactive host. If the user requests ongoing observation, use an available host lifecycle or scheduling feature within that request; do not create a silent polling service or imply zero model cost.

## Use memory only with clear intent

- Call `spellcast_remember` only when the user explicitly asks to remember something or clearly confirms that it should persist. Save a concise, self-contained fact, preference, decision, or reminder.
- A kept bubble or board item can survive restart but is not automatically memory. Never promote it without the user's intent.
- Call `spellcast_recall` before claiming what Spellcast remembers. An empty query returns recent memories; a text query searches their titles and contents.
- Call `spellcast_forget` with the exact returned memory id when the user asks to remove it. Report success only after the tool succeeds.
