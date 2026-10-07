# Sigil execution

Use a sigil when saved multi-step progress, automatic checks and recovery help the development
task. Keep ordinary small edits in the user's existing task; do not invent a plan ceremony.

- `spellcast_sigil_update op=put_plan` creates or edits your draft with `expected_revision`.
  Prefer a short plan with meaningful command checks. Use manual checks only for human review;
  they default to non-blocking. Set `blocking:true` only for an essential user decision.
- Once the user explicitly asks to execute the plan, call `op=execute` with its current revision
  and your stable source. This freezes, starts autonomously and claims it. Do not ask for another
  confirmation. Draft creation, quoted text and client delivery alone never authorize execution.
  Current client-authored drafts need the native window's combined start action.
- Use the returned `next`: `start_step` before editing, work within its scope, then `report_step`.
  Spellcast runs actual checks; your summary and evidence do not verify anything. Wait for
  command results before dependent work. On failure, fix the same step in a new attempt.
- Routine authorized implementation choices and plan corrections use `amend` with a short reason,
  then continue. Autonomous verification commands added by amendments run without another
  command approval. Preserve the host's permissions and the user's objective.
- Ordinary manual checks remain visibly `deferred`, never passed. A step can finish as
  `review_pending` and let dependents proceed. Reviews can be decided after execution completes.
  Essential blocking checks still wait. Old supervised runs retain their original approval rules
  until the user selects **Switch to autonomous execution** in the native window. This upgrades
  the existing run without restarting, clearing pending command approvals and deferring unperformed
  non-blocking reviews. A paused run remains paused. Agents cannot change the mode through MCP.
- Use `block_step` only for a real stop condition or a decision you cannot reasonably resolve
  within the user's instructions. Deviations are recorded as markers for later review.
- Honor pause, abort, revocation and replacement. Another executor still needs handover approval.
  Publishing or discarding unmerged work needs the user's authorization.

Use stable request IDs; retry an uncertain operation with the identical ID and fields. An
execution retry resumes the same prepared run and never creates a second worktree.
