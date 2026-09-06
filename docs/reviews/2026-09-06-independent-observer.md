# Independent project observers

The host owns model execution. Spellcast now provides a bounded checkpoint and completion protocol; the installed skill connects it to the host's native isolated subagents.

## Implemented behavior

- `spellcast_checkpoint(source_id, snapshot)` accepts a short project/goal/change/facts snapshot at a meaningful checkpoint. Only `ready` supplies an observation brief and permits a child to start. It does not itself spawn a model.
- The host starts a fresh child without conversation history and continues the main task. The child receives only that brief and the observer instructions; it must not inspect unrelated context, edit the project, or delegate.
- `spellcast_observer_complete(observer_id, thought)` consumes the ticket once. `thought=null` completes quietly. A useful thought uses the existing desktop admission and delivery path, bound to the originating source and the active display. Only status and bubble ID are returned; the main task need not read the thought's generation process.
- A newer context invalidates pending work, including during cooldown. Identical content does not cause another observation just because its checkpoint label changed. Cancellation uses `snapshot=null`; old tickets also become invalid after restart.
- Current local limits: 120-second per-source admission interval, 180-second ticket life, four short facts, 64 recently active sources, and 30-minute in-memory source retention. These are product delivery limits, not a global agent policy. No timer automatically starts observers.
- The existing source-scoped durable feedback queue handles explicit follow-up after a child exits. Keeping alone does not request an expansion. No inactive-host wakeup is claimed.

The host/skill is responsible for actually spawning an isolated child and sending honest current-project snapshots. The server cannot prove which model role authored a tool request. Child tool availability, role choice, model choice and context inheritance depend on the host; no model routing policy is embedded in Spellcast.

## Verification

- Bridge tests: **31 passed**, including sparse admission, bounded input, quiet completion, source binding, replay rejection, changed projects, cancellation, expiry, pause and restart invalidation.
- Desktop release build passed. The current local application uses the existing user database; the two pre-existing cards were preserved. The version string remains 0.2.1 for this unreleased working build and does not identify the old release-tag binary.
- Real Codex CLI 0.153.4 spawned an isolated child (`fork_turns=none`), performed its own file check while the child ran, and received only `NATIVE_MCP_OK`. The child actually called registered `spellcast_board`, without an HTTP substitute.
- After rebuilding, a fresh CLI successfully called native `spellcast_board` and reported both new observer tools available.
- A real calendar-project checkpoint called `spellcast_checkpoint`, then spawned a fresh observer while the parent continued packaging the actual desktop application. The child called native `spellcast_observer_complete` with its own project-grounded thought; the parent received only `accepted`. The desktop then emitted `ready` with the original calendar source. This verifies checkpoint → isolated child → native completion → window initialization. It does not prove user attention, interaction, usefulness across tasks, every host, or zero context/token overhead.
- Real user-input handling and the final recording remain to be checked with the standalone calendar desktop window. Browser automation was stopped by its URL policy guard; the user explicitly chose a native desktop calendar instead.

## Installation

Install the updated bundled Spellcast skill and reload the host so the new MCP tools and instructions are registered. Enable independent asides for the current project task. If native isolated children or the completion tool are missing, the skill reports that limitation instead of replacing the child with main-task reasoning or a direct test bubble.
