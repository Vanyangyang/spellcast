# AI-first game workspace (VESPERIX)

Date: 2026-09-27. The user confirmed the direction: 游戏开发 organises the whole VESPERIX game
with an Agent, shown as one projection at three scales. No minimal loop, no manual form entry
at the top level, no fake AI button.

## What the user sees

- **Game home** is the default view of 游戏开发. At the top: the breadcrumb (全貌 › 体验 › 对象),
  the real Agent-connection state, and one composer: 说出目标或指出问题. Manual tools live in
  **工具**: 系统与内容（手动）, 事项, 重新读取来源. The planning tool's own row (系统关系图, 流程与试走,
  对象目录, 数值总览, 写内容, 新建对象, 专注编辑) is one **手动工具** menu; the R0–R2 filter appears only
  where it filters.
- **全貌 / Overview**: the player loop table verbatim from `Atlas/domains/cycle.md` (设计意图), the
  world and regions with their dungeons and zones (配置事实), the zones that declare routes as
  explorable experiences, counts of what was indexed, missing main quests, and an always visible
  "Unity／玩家验证：未接入，状态未知".
- **文档审查大板** is a temporary old-material review entry from 全貌. Useful material should
  ultimately become game systems, rules and content through the existing review/adoption flow;
  this inventory is not a second permanent design library or an automatic migration.
  It inventories Markdown under `Assets/Documents`, grouped by directory and region.
  Selecting text immediately opens an in-reader toolbar with **询问** and **划掉**. Ctrl/Meta
  selection or an explicit append-selection toggle collects several passages; ordinary selection
  replaces the temporary set. There is no keep or underline action. Strikeout means the user does
  not need this passage, is visible on the source and is reversible; it never deletes source files.
  Persisted strikeouts use `scope: spellcast.document-selection.v1`, `result: discard`, a stable
  document-and-version record ID, and one versioned reference per merged range. The fragment is
  `#LstartLine-LendLine@startOffset-endOffset`, with UTF-16 offsets into the normalized source text
  and an exclusive end. A source hash mismatch never applies an old mark to new text. Removing
  all ranges cancels the marker record without deleting its history. Previous whole-document
  decisions and local marks remain historical data; they are not rewritten as passage decisions.
  Comments use existing project work records with scope
  `spellcast.document-review.v1`: `result` is the note, `goal` is the optional source excerpt,
  and the first reference identifies the exact document URI, optional `#Lstart-Lend`, and SHA-256.
  Additional references are evidence; a `spellcast://project/<id>/record/<id>` reference links a
  reply to its parent. Source version mismatches are visible and never silently reanchor a note.
  `active` / `done` describes comment resolution, not source correctness or game verification.
  Agent and user provenance, revisions and history use the existing project record store.
  Selected-text questions use the goal delivery path with `entity_kind: document_question`,
  an explicit bound target, source path/hash and the quoted passages. They remain unsent without
  a target. Answers are versioned review records linked by `spellcast://project/<id>/goal/<id>`;
  only a valid answer from the receiving Agent updates the response receipt. They do not require
  adopting a design proposal. Source excerpts are reference material, not execution instructions.
  The Agent audit button fills
  the goal composer; it does not send anything by itself. Cleanup follows the user's review.
- **体验 / Experience** (e.g. `zone_forest_shrine_outer`): the declared route, each location's
  encounters and reward tables, missions linked by dungeon, target enemy or ID (with the basis
  shown), and design-document sections that mention the zone.
- **对象 / Object** (a location): design intent (document sections by ID, prose before fenced
  examples), configuration facts with source JSON and SHA-256, static C# leads for the fields in
  play, the verification boundary with related records, and proposals for this place.
- **当前工作**: proposals to review, goals with their real delivery state, tracked work records.

## Data and authority

| Piece | Where | Notes |
|---|---|---|
| Projection | `game_config.rs`, `game_projection.rs` | Read-only, bounded, cached by stamps, parallel cold reads; source path + SHA-256 everywhere; `runtime_verified: false`. |
| Goal | `project_goals.rs`, table `spellcast_project_goals` | Saved before sending; `unsent` until the user picks a bound Codex task; delivery reuses durable feedback (`say_with_project_context`, kind `goal` or `document_question`). Not a work record; "转为事项跟踪" creates one explicitly. |
| Proposal | `project_proposals.rs`, `project_proposal_store.rs`, tables `spellcast_project_proposals(+_history)` | Outside canonical objects/records and not exported. Complete proposed states with base revisions, basis, sources, reasons, boundaries. Decided items immutable. |
| Decision | `RecordChange::DecideProposal` | User only: adopt (transactional, `adopt_proposal` history, confirmed+locked or unconfirmed), revise, return (note required; sent back only if the author task is still bound), dismiss. Stale bases, newly existing targets and locks without explicit unlock are refused with explanations. |
| Agent boundary | `guard_agent_change` in the record store | For every Agent credential, including local owner automation: no `put_object`/`restore_object`/`set_object_lock` on planning design, no `confirmed`, no decisions. Records and non-planning objects stay Agent-writable. |

Tables are created with `CREATE TABLE IF NOT EXISTS` outside the versioned project schema, so an
older build still opens a database this build has used (it ignores the new tables).

## Hosts

Only a Codex Desktop task can be bound, receive deliveries and obtain project access: binding and
access verify the actual thread through the Codex app-server (`codex::verify_binding`), and delivery
uses the running Codex Desktop app-tools pipe (`desktop_delivery.rs`). Claude Code, Grok, Cursor and
other MCP hosts can read project data but cannot receive goals or submit proposals here. Without a
bound task the home shows 没有连接的 Codex 任务, a copyable start instruction and earlier tasks that
wrote to the project (linking verifies them); it never shows processing.

## Verification (2026-09-27)

- `cargo test --workspace`: bridge 142, core 61, server 35, hook 11 — pass.
  `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 128 pass, 3 ignored.
  New tests: `project_proposal_tests.rs` (guard, lifecycle, conflicts/locks, review decisions,
  receipts) and `project_goal_tests.rs` (projection from a VESPERIX-shaped fixture, unsent goals,
  goal → bound task → access approval → proposal → adoption → promotion → follow-up → restart,
  return feedback only to a bound author).
- Real VESPERIX projection, read-only (`cargo run -p spellcast-bridge --example inspect-game-projection`):
  4 loop rows, 17 regions, 37 dungeons, 152 zones, 5 routed zones, 6 locations in the outer woods,
  4 related missions, 17 identifiers with design mentions; cold 1.27 s, unchanged 0.13 s.
- Browser fixture `scripts/check-game-ai-workspace.mjs`: 12 checks, dark/light at 1600/1320/880,
  keyboard (Ctrl+Enter, Escape walks back up and closes menus before the workspace), background
  polling never replaces typed text, Agent proposals labelled AI inference and user drafts as
  such, no page errors. It also carries the still-relevant assertions of the retired Level-objects
  fixture: markup in repository names, descriptions, design excerpts, proposal and goal text
  stays literal and never executes; opening reads one overview snapshot and a zone one zone
  snapshot (the old `/game/zones` listing and `/game/actions` requests count as unexpected);
  focus and Refresh stay incremental while 重新读取来源 sends `refresh=true`; a decision against a
  proposal revision that changed meanwhile is refused and shown until refreshed; a transient save
  failure keeps the words and retries with the same goal id; records show only on the object they
  reference; a zone that cannot be projected shows its error and keeps the way back; every
  repository, goal, proposal and decision request carries the window credential.
- `scripts/check-project-game-ui.mjs` is now a compatibility entry that runs the fixture above once
  (the old `SPELLCAST_GAME_TEST_PORT` still selects the preview port; a failure exits non-zero). It
  used to drive the never-mounted `src/project-game-view.ts` and always failed. The object-scoped
  modify/verify endpoint it exercised stays covered by the Rust test
  `project_game::tests::actions_reject_stale_sources_and_retry_with_one_record_and_one_delivery_after_restart`
  (stale source revision, one record and one delivery per retried request, restart).
- Existing checks updated only for navigation (`scripts/check-workspace-nav.mjs`) and passing:
  record workspace (planning, map wheel, flow, workbench, content), planning map model, i18n,
  UI layout (36 screenshots), theme matrix.
- Native isolated app (`scripts/check-game-ai-native.mjs` via `run-native-check.mjs`, own
  identifier/port/DB/WebView profile), connected read-only to the real repository: overview,
  experience and object from real sources, unsent goal with no delivery, in-place adoption with
  user provenance, return without a bound author sends nothing, six successive Escape returns,
  tools menu, both themes at three widths, repository HEAD and working tree unchanged.
- Document board follow-up: the real VESPERIX tree indexed 490 Markdown files in
  `Assets/Documents` without index-limit or decode errors. The browser fixture checked search,
  source preview, literal rendering of an untrusted title and local candidate marking (13 checks);
  the isolated native app opened a real document from the 490-item board and left the repository
  unchanged. The board does not cover Markdown outside `Assets/Documents`.
- Reader follow-up: the browser fixture covers quoted/whole-document notes, failed writes,
  replies, resolution with original author provenance, evidence navigation, shared decisions,
  source-version warnings, and an old reader finishing its save after a new draft was opened.
  Dark/light reader screenshots were inspected at 1600 and 880 widths. The isolated native app
  persisted a note, a reply, a resolution history and a shared decision against a real Markdown
  source; no user database or game repository was written by that test.
- Text-action follow-up: the browser fixture covers automatic floating actions, Ctrl and toggle
  multi-selection, repeated words at distinct offsets, strikeout/undo including complete removal,
  source-version drift, and verified answer IDs. The native app checks two selected passages,
  an unsent question carrying both citations, persisted strikeout and one-range undo after reopening.
  Backend tests cover reply attribution, wrong source/path/hash, unsent goals, and concurrent answer
  registration. No test sent a real question to the user's bound Codex task.

## Not verified

- A real Codex Desktop task receiving a goal and calling `put_proposal`: isolation must not bind a
  real task. The chain is covered by Rust tests with a simulated, already-verified binding; the
  delivery pipe itself is the existing, separately tested path.
- Any Unity or real-player result. Spellcast does not observe runs; the UI says unknown.

## Escape navigation repair

The compatibility check exposed a Chromium 153 behavior: repeatedly preventing a modal dialog's
`cancel` event eventually let Escape close the workspace. `src/project-workspace.ts` now handles
in-app Escape navigation on `keydown` and prevents the default close request before it reaches
`cancel`; `cancel` remains a fallback for closing. The browser fixture exercises repeated
experience-to-overview returns and checks that the workspace stays open.
