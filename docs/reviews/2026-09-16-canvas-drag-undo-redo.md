# Canvas drag, undo and redo acceptance

The drag regression had two confirmed causes. An attrs-only X6 `defaultLabel` replaced the built-in label structure; rendering a data edge could throw during a move and interrupt history completion. Label styling now applies to individual labels, preserving X6 markup. Group/layout saves are serialized, and history replay keeps the resulting placements dirty until their own save succeeds, preventing an older save response from restoring the dragged position.

The previous browser checks covered data-edge labels, mouse/keyboard movement, resize followed by movement, and immediate multi-selection undo with a 900 ms save delay. The remaining Windows input check was completed on 2026-09-16 in the existing production window.

## Windows input and persistence evidence

- Sole observed Spellcast process: PID 32064, `src-tauri/target/debug/spellcast.exe`, serving port 47194. Its SHA256 equals the candidate: `2e05d1a008516040ab9fdb723ea74a9523ec1355950f03339628f20560ca2e07`.
- Selected object: `playground-live-text-20260915`, with an existing `summary → text` data connection.
- Actual mouse drag moved its content, selection frame and edge together. The saved placement changed from `(1368, 216)` to `(1536, 288)`.
- Actual Ctrl+Z restored `(1368, 216)`; Ctrl+Y redid the move to `(1536, 288)`; final Ctrl+Z restored `(1368, 216)` again.
- API reads after persistence confirmed presentation revisions `36 → 37 → 38 → 39 → 40`. Width `648`, height `192`, content scale, appearance and z-order remained unchanged.
- Deep comparisons confirmed every other placement, all Canvas objects/compositions/annotations/proposals, and all nodes/edges/replies/messages were unchanged. No Send action was taken.
- The user adjusted camera zoom during the check; that navigation was preserved and is not counted as test input. Two input attempts interrupted by user input were refreshed before proceeding and are not counted as successful actions.

Ctrl+Y is the existing layout redo binding; Ctrl+Shift+Z is also supported. Input fields and active work content retain their own keyboard behavior. This does not add content/deletion undo or history persistence across reloads.

Prior deployment and backup evidence remains in `artifacts/workbench-20260914/canvas-bound-drag-history-20260916/`. The deployed candidate was already built and installed before this continuation; no new build or full test-suite run is claimed here. `git diff --check` passed in this continuation. No additional production instance was launched.
