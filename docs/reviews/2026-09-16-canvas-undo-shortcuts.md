# Canvas undo shortcuts

Ctrl+Z now invokes the existing layout undo history. Ctrl+Shift+Z and Ctrl+Y redo; Command+Z / Command+Shift+Z are also recognized. Button tooltips and `aria-keyshortcuts` expose the bindings.

The keys apply while the visible Canvas or its toolbar owns focus. Input fields, contenteditable areas, active component content and modal dialogs retain their own keyboard behavior. Focused iframes keep their keys inside the work. Holding a key does not repeatedly drain the history.

This reuses the current in-memory 40-entry position/size history and its normal layout persistence. It does not add deletion/content undo or persist the history across reloads.

Browser acceptance with the real frontend and isolated Rust/SQLite fixture:

- Move Right then immediately Ctrl+Z (before debounce save): original position restored and saved.
- Ctrl+Shift+Z restored the 20-unit move. Ctrl+Z followed by Ctrl+Y produced the same moved position.
- Shift+Right scaled 420 × 220 to 440 × 230.476, content scale 1.04762. Ctrl+Z restored 420 × 220 and content scale 1.
- In the composer, typing `temporary draft` then Ctrl+Z reverted the latest text input to `temporary draf`; the moved Canvas geometry stayed unchanged.
- Pending feedback and deliveries remained 0. No Send action was taken; the isolated service and tab were closed.

TypeScript, Vite, Tauri build and `git diff --check` passed. No Rust behavior changed and no new full Rust test run is claimed. Evidence: `artifacts/durable-canvas-work/browser-1789494025170/`.

Desktop executable SHA256: `277a610b8f75ee6c9b696dd3933752a8ce66a5e70e9b09b647a9d3acf2b276cd`. Deployment and preservation evidence: `artifacts/workbench-20260914/canvas-undo-keys-20260916/`. Production content and layout were not modified for this keyboard test.
