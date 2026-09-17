# Enter a work without changing its viewport

Double-clicking a standalone interactive work previously exposed the generic block heading, focus/ask/edit actions, run controls and management sections inside the same fixed-size component. The work's viewport then shrank and the host gained a scrollbar.

Standalone Canvas works now use the same viewport and frame layout before and after activation. Double-click transfers keyboard/pointer input to the work. Its metadata, editor, stop/restart, size mode, export, capture and source/version controls are available through the separate **Work settings / 作品设置** button in the Canvas selection toolbar.

The settings dialog contains only controls; the iframe is never moved into it. It does not participate in the component's layout or inherit its display scale. Closed dialog controls are skipped when deciding where activation should focus. Stopped works show a compact inline notice with a Run action; error messages also use this notice. Existing artifact sandbox, state persistence and feedback boundaries remain in place. The other native atom editors and multi-block replies retain their existing controls.

Explicit work size-mode changes now report logical content height, excluding Canvas zoom/component scale. The Canvas adds only its actual header space instead of a fixed allowance for management controls.

## Verification

Browser acceptance used the real frontend plus an isolated Rust server/SQLite fixture: `artifacts/durable-canvas-work/browser-1789491656338/`.

- At approximately 40% canvas zoom, the work iframe rectangle was identical before and after a real double-click: x 848.9762, y 181.9847, width 233.3810, height 161.0153 screen pixels.
- The host content had clientHeight = scrollHeight = 400 and overflow hidden in both states; activation produced no host scrollbar.
- The slider accepted 15 → 21 through actual UI input.
- Opening settings and its Source and versions section left the iframe rectangle unchanged. The settings dialog itself rendered at 720 screen pixels wide.
- Stop removed the running iframe. After closing settings, the work showed Stopped and Run. Run restored the saved value 21.
- The metadata editor opened with its title/description inputs and Save/Cancel actions. It was cancelled without a content change; closing settings returned focus to the existing work with value 21.
- A screenshot at approximately 80% canvas zoom showed the work, its own title and slider, with management controls outside the work viewport.
- Pending feedback and deliveries both remained 0. The isolated service and browser tab were closed.

TypeScript, Vite, artifact capture protocol checks, Tauri build and `git diff --check` passed. No Rust behavior changed, so the preceding 151 Rust tests were not rerun. No injected failure scenario was used to separately exercise the new error notice. Native drag/activation acceptance is not claimed for this change; the interaction evidence is from the browser.

## Runtime

Desktop executable SHA256: `224a6e23c0e95e0be19f62ffe394df5d65bb232b511f1492b24defae59ea4af1`.

Deployment: `artifacts/workbench-20260914/canvas-work-entry-20260916/`, running PID at deployment 60428. The updater backed up the database, runtime and profile. Before/after preservation checks passed with 6 nodes, 5 edges, 2 replies, 13 messages, 20 objects and 2 compositions. No production content, placement or feedback was changed for testing.
