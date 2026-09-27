/**
 * Compatibility entry for the retired Level-objects browser check. It runs
 * scripts/check-game-ai-workspace.mjs once; it does not start a second fixture.
 *
 * History: this command used to drive src/project-game-view.ts (zone picker, location inspector,
 * object-scoped modify/verify requests). That view was never mounted in the current 游戏开发
 * workspace, so the old fixture waited for a panel that could not appear and always failed. The
 * workspace now mounts the AI-first game home, and the old assertions that still guard real
 * behaviour moved into its fixture:
 *   - repository text (names, descriptions, design excerpts, proposal and goal text) renders as
 *     text and never executes;
 *   - opening loads one combined overview snapshot and entering a zone one zone snapshot; the
 *     retired /game/zones listing and /game/actions requests count as unexpected;
 *   - window focus and Refresh stay incremental; only "重新读取来源" asks for refresh=true;
 *   - a stale write (a proposal revision that changed meanwhile) is refused and shown; a transient
 *     failure keeps the user's words and retries with the same request id;
 *   - records appear only on the object they reference; the selected location stays pressed;
 *   - a zone that cannot be projected shows its error and keeps the way back;
 *   - every repository, goal, proposal and decision request carries the private window credential.
 * The object-scoped action endpoint itself (stale source revision, one record and one delivery per
 * retried request, restart) remains covered by the Rust test
 * project_game::tests::actions_reject_stale_sources_and_retry_with_one_record_and_one_delivery_after_restart.
 * See docs/game-ai-workspace-contract.md.
 *
 *   npm run build && node scripts/check-project-game-ui.mjs
 */
// The old SPELLCAST_GAME_TEST_PORT still chooses the preview port.
if (process.env.SPELLCAST_GAME_TEST_PORT && !process.env.SPELLCAST_GAME_AI_PORT) process.env.SPELLCAST_GAME_AI_PORT = process.env.SPELLCAST_GAME_TEST_PORT;
console.log('check-project-game-ui: compatibility entry; running scripts/check-game-ai-workspace.mjs');
await import('./check-game-ai-workspace.mjs');
