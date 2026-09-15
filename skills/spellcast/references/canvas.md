# Canvas objects, versions, and proposals

When the user asks to explore a kept thought, use `spellcast_reply` with that `origin_node_id`, your task's `source_id`, a readable `source_label`, and complete content. Mix the forms that help the thought:

- `text`: framing, a concrete insight, explanation, or decision.
- `comparison`: alternatives with the same criteria and aligned values; give options stable IDs.
- `graph`: explicit relationships with labeled edges; proximity alone must not imply a dependency or causal claim.
- `sequence`: an ordered walkthrough, storyboard, or plan with clear step titles and notes.

Choose the form that explains the problem well; these four forms are not an expression limit. Prefer a focused composition the user can inspect and act on. Use stable reply and block IDs. Re-read `spellcast_board` before editing; use `spellcast_update` for one block with the latest `expected_revision`. If a revision conflicts, reconcile the user's current edits instead of retrying an old whole reply. Preserve user choices and layout unless the request changes them.

Use `spellcast_canvas_batch` for independently placed text, images, simple shapes, and `block` objects containing one text, comparison, graph or sequence form. Update an independent block with `patch_block`, retaining its block ID and type. Complete interactive works retain their artifact lifecycle and may join the same composition. An idea can combine any of these components; one component is not necessarily a whole idea. Use `compose` with a meaningful title, optional description and ordered members to express that whole. Member order is reading order, not an implicit relationship or layout change.

Read `board.canvas.objects` for stable object IDs; reply/block IDs remain compatibility references for their stored content. Supply opaque IDs when creating objects or groups, and one stable `request_id` for an identical retry. Put creation before operations that reference new IDs. Declare the content, presentation and composition versions you read, plus each write target's expected version. Native images may reference immutable `/artifacts/{bundle_id}/{file}` resources. Recorded origin identifies the workspace and original task; it does not transfer content ownership. Keep different workspaces distinct and do not infer edges from a shared workspace or task.

A conflicting batch changes no content, geometry or memberships and remains a reviewable proposal. User-edited content and user-adjusted presentations are protected even with a current version. Submit only the intended fields; do not replace an entire reply to evade that protection. The user can inspect current and requested values, apply, or dismiss a proposal. Compositions keep stable IDs and members, support whole movement and ungrouping, and do not require a visible container. Ungrouping a nested composition also requires its parent's version dependency. Removing a presentation preserves content and its pose; permanently deleting grouped content separately requires current ancestor composition versions.

Do not write objects owned by another task source; they may be read as context. Unassigned user content stays protected and can receive reviewable proposals. Include every anchored object, available input-source object and referenced composition in `reads` when answering Canvas feedback, plus the exact `feedback_sequences`. User-edited idea names, descriptions and membership order are also protected.

`spellcast_present` remains available for kept idea layouts (constellation, spatial, timeline, stack), and `spellcast_reply` for structured replies. Never reduce the user's requested board reply to a progress notification. Do not clear a board the user edited without their permission.
