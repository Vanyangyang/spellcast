# Expanded native content editor

The old editor placed its text area in a shrinking display region while title controls and Save occupied a separate, non-shrinking form. A short Canvas presentation could reduce the text region to almost zero height. Both regions also inherited the presentation and camera scaling.

Native text, image and shape editing now opens a document-level dialog outside the scaled SVG frame. The content preview stays in place. Title, body and other fields share one form; the footer keeps Save and draft status reachable. The editor uses normal-size text, focuses the body for text/shapes, supports Ctrl+Enter to save, and returns focus to the Edit button after closing. Esc keeps the existing draft. Linked text explicitly distinguishes the live linked value from the saved text shown when disconnected.

The existing draft key, revision/conflict checks and content-only patch route are retained. A save error stays visible in the editor. The change does not send task feedback or modify presentation geometry.

## Browser acceptance

Real frontend with an isolated Rust/SQLite fixture, evidence under `artifacts/durable-canvas-work/browser-1789527495299/`:

- At 1280 × 720 and 880 × 640, the editor was 780 px wide with 16 px body text and a visible Save button. The final unbound-text check had no outer form overflow. The editor was outside `.canvas-frame`.
- An 18-paragraph draft accepted input and wheel scrolling; the text area's scroll position advanced while Canvas zoom remained 100%.
- Esc and a page reload preserved the title and complete draft. Ctrl+Enter saved both fields and closed the editor.
- A 144 × 72 text presentation with content scale 0.5 still opened a full-size editor. Ctrl+Z in its body reverted the last typed character.
- A newer server edit produced an explicit conflict: Save was disabled, the newer text and local draft were both visible, and only choosing Use draft then Save applied the draft.
- Image editing exposed title/source/alt fields and hid the text area. Shape text and fill changes saved and rendered correctly.
- Original fixture placements were unchanged. Feedback pending/deliveries remained 0. No Send action was taken. The fixture service and browser tab were closed.

## Desktop acceptance and preservation

- TypeScript and Vite passed; Tauri produced the debug application successfully. Vite completed in 4.40 s and the Rust build in 27.79 s, with existing size/dead-code warnings. No new full Rust suite is claimed for this frontend change.
- Initial editor deployment SHA256: `a4b127d846828f0699bba3e22cf367d519fd4bab074ad300fe1132534e9d920e`.
- The normal window and its remaining completion popup were closed normally before replacement. Runtime-only deployment backed up SQLite, the old executable/resources, and the App's local draft storage; it did not run the installed-plugin update step.
- The full before/after board preservation check passed: 6 nodes, 5 edges, 3 replies, 13 messages, 21 objects and 2 compositions.
- On the actual Windows app, double-clicking the existing “搜打” object and clicking Edit opened the independent editor. The title, current linked value and saved original text were visible; the body had focus and Save was disabled because no content was changed. The editor was left open for the user.

Build/deployment/backup evidence: `artifacts/workbench-20260914/native-editor-20260916/`. Source changes are in `src/canvas-native.ts`, `src/canvas-native-editor.css` and `src/i18n/canvas.ts`; the local deployment helper gained a runtime-only mode for this update.

## Follow-up: explain the source and save scope

The ambiguous “联动数值” label is replaced with the connected work's current title, plus an explicit “由来源更新” state. An unavailable source gets a separate explanation. The editable field is labelled “备用正文（断开连接后显示）”, and the footer states that Save changes only the title and fallback text. English and Japanese labels were updated too. `src/canvas.ts` provides the source title to the native renderer without changing the binding or dataflow protocol.

The new isolated fixture (`artifacts/durable-canvas-work/browser-1789529419623/`) verified the source title, unavailable state, save-scope wording and an unclipped 880 × 640 editor. Saving fallback text preserved the source object, source reply/state, connection and all placements. A fixture disconnection then showed the saved text, hid the source panel and returned the field label to ordinary “正文”.

The actual Windows editor displayed `来自「让下一件事，晚一点开始」的内容`, `由来源更新`, the live 15-minute text and the new fallback/save labels. The user's unsaved “是什么？” title survived the update and remains a draft; no production Save action was taken. The editor was left open. The full board preservation check passed with the same 6 nodes, 5 edges, 3 replies, 13 messages, 21 objects and 2 compositions.

Latest deployed SHA256: `5f9a074791d8666cbbc790bd8859fc26ffaa5683d75083261276f884a971b377`. TypeScript, Vite (4.63 s), Tauri build (19.19 s) and whitespace checks passed. Runtime-only deployment and draft/database backups are in `artifacts/workbench-20260914/native-editor-source-20260916/`; the running PID at verification was 32520. The isolated browser and service were closed.
