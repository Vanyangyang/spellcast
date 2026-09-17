# Resize grip hit area

The proportional resize handles had only a 10 × 10 screen-pixel hit area. The dot is now visually 10 × 10, with a transparent 28 × 28 hit area and a hover/active halo. The corner position and proportional scaling behavior are unchanged. This enlarges the reachable region along the edges near each corner; it does not turn the entire border into a resize handle.

Browser verification used the real frontend and isolated Rust/SQLite fixture (`artifacts/durable-canvas-work/browser-1789490954216/`):

- At 100% and 40% canvas zoom, the hit area measured 28 × 28 screen pixels; the visible dot measured 10 × 10.
- At each zoom, real drags started 10 pixels outside the dot center, where the old 10 × 10 handle could not be hit. Both resized proportionally and produced the layout-saved receipt.
- Dragging from the component center moved it, retaining its dimensions and content scale.
- Pending feedback and deliveries remained 0. The fixture service and tab were closed.

TypeScript, Vite, Tauri and `git diff --check` passed. This CSS-only change does not rerun the 151 Rust tests from the preceding content-scale change. No production content or placement was changed for the test.

Desktop build SHA256: `05d3cb71b5771fbbae4c6c6df699fdfa7f1504aced622ce164343070bb39b957`. Runtime deployment and preservation evidence is under `artifacts/workbench-20260914/canvas-resize-grip-20260916/`.
