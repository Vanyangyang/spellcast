# Canvas component content scaling

The previous resize fix synchronized the HTML frame with X6 geometry, but changed only the container dimensions. Text, buttons and spacing retained their logical pixel sizes. This change gives each presentation a persisted `content_scale` and scales the existing HTML tree uniformly.

## Behavior

- Corner handles scale the complete component proportionally; side handles are hidden. Shift + arrow resizing follows the same rule.
- Text, controls, image previews, annotation markers and sandboxed works scale together. The DOM and running iframe are reused.
- Canvas zoom remains independent and applies on top of the saved component scale.
- Layout save/reload and undo/redo preserve the scale. Existing placements default to 1. The Rust boundary accepts finite values from 0.01 through 100; existing size limits still apply.
- Explicit agent placement updates may change width/height without changing scale to adjust layout space. A partial placement update preserves the existing scale.
- During corner dragging, component content and floating controls do not intercept pointer input. This also fixes an observed drag that stayed active when its release landed under the floating toolbar.
- No local resize, selection, annotation lookup or work parameter change submits task feedback.

## Verification

TypeScript and Vite builds passed. The focused scale check covers saved reload, undo/redo and repeated drag calculations. All 60 core tests and 91 bridge tests passed. Tauri built with the existing nine dead-code warnings.

Browser acceptance used the real frontend and an isolated Rust server/SQLite database, with no real Codex task bound:

- Comparison: dragged from 700 × 560 to 840 × 672. The HTML logical size stayed 700 × 560; its scale became 1.2. Measured screen dimensions of heading, button, image and annotation badge each grew by 1.2 (within floating-point measurement error).
- Repeated the drag across the floating toolbar after fixing release interception. It ended without a follow-up click and produced the layout-saved receipt. Reload retained scale 1.2.
- Canvas zoom changed from the displayed 60% to 45%. The screen-width ratios of frame, image and annotation were all approximately 0.751479; component scale remained 1.2.
- Shift + Right saved scale 1.228571; the normal Undo layout and Redo layout actions restored 1.2 and 1.228571 respectively.
- Clicking the scaled annotation badge opened the correct comparison annotation and its pinned context.
- Running work: set the gap to 21, dragged to scale 0.8, and observed the retained value. The iframe screen width changed from 428.133 to 342.507, also 0.8. The slider then accepted 24 and saved it.
- Final isolated feedback counters: pending 0, deliveries 0. The temporary service and browser tab were closed.

An early drag before the release-interception fix did not save and remained active; it is not counted as a persistence pass. The fixture was explicitly reset before the successful repeat. Browser evidence is in `artifacts/durable-canvas-work/browser-1789489203151/`.

## Running desktop version

- Executable: `src-tauri/target/debug/spellcast.exe`
- SHA256: `b3e266df7e9e6ee95d5e22780286337fb755355a528651e624d43a66b4a45d39`
- PID at deployment: 63212
- Plugin: `0.3.0+sc.bbb06cbd4063`, installed payload verification passed (plugin content unchanged).
- The deployment backed up the database, executable/resources and plugin profile. Before/after preservation checks passed: 6 nodes, 5 edges, 2 replies, 13 messages, 20 objects and 2 compositions.
- Deployment evidence: `artifacts/workbench-20260914/canvas-content-scale-20260916/`.

The updated native window and accessibility tree were confirmed. Its screenshot was obscured by another foreground surface, and native activation was unavailable, so no new native drag acceptance is claimed. Real drag and interaction measurements above are browser evidence. No production content or layout was modified for testing.
