/**
 * Native AI-first game workspace check against a fresh isolated debug app (run through
 * scripts/run-native-check.mjs). It connects the isolated database to a real repository read-only
 * (SPELLCAST_GAME_ROOT, default the local VESPERIX checkout), proves the repository is unchanged,
 * and never binds a Codex task, so no delivery can reach a real task. Seeded proposals are
 * user-authored test data in the isolated database; the Agent path is covered by Rust tests.
 *
 *   node scripts/run-native-check.mjs check-game-ai-native --cdp 9352 --port 47214 [--size 1600x1000]
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const gameRoot = path.resolve(process.env.SPELLCAST_GAME_ROOT ?? 'G:/u2dProject/u6project/VESPERIX');
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? 'artifacts/native-checks/check-game-ai-native'); await mkdir(output, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9352');
const page = browser.contexts()[0].pages().find(p => p.url() === 'http://tauri.localhost/'); assert(page, 'main window');
page.setDefaultTimeout(30000);
const port = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(s => s.port));
assert(![47193, 47194].includes(port), 'Never the user bridge');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = async code => { await browser.close().catch(() => {}); process.exitCode = code; await sleep(300); process.exit(code); };
const git = args => execFileSync('git', ['-C', gameRoot, ...args], { encoding: 'utf8' });
const report = { scope: 'isolated native app (own identifier, port, database, WebView profile); real repository read-only; no task bound', port, gameRoot, checks: [], screenshots: [] };
const ok = name => { report.checks.push(name); console.log(`ok - ${name}`); };
const get = async route => { const response = await fetch(`http://127.0.0.1:${port}${route}`); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value; };
/** Writes go through the page, with the private window key and the app's own trusted origin. */
const post = (route, body) => page.evaluate(async ([route, body, port]) => {
  const key = await window.__TAURI_INTERNALS__.invoke('project_window_key');
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-spellcast-window': key }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
}, [route, body, port]);
const shot = async name => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file); };

try {
  const head = git(['rev-parse', 'HEAD']).trim(), statusBefore = git(['status', '--porcelain=v1', '--untracked-files=all']);
  report.repository = { head, dirty_entries_before: statusBefore.split('\n').filter(Boolean).length };
  // Isolated project + read-only connection.
  const projectId = crypto.randomUUID();
  await post('/api/projects/command', { request_id: crypto.randomUUID(), project_id: projectId, op: 'create_project', name: 'VESPERIX · 隔离检查', aliases: [gameRoot.replaceAll('\\', '/')] });
  await post(`/api/projects/${projectId}/game/connection`, { root: gameRoot.replaceAll('\\', '/'), expected_revision: 0, request_id: crypto.randomUUID() });
  // One user-authored proposal (isolated test data): a new content item and a record item.
  const zonePath = 'Assets/Resources/Configs/DungeonExploration/Zones/region_yongsheng_forest/zone_forest_shrine_outer.json';
  const zoneHash = (await page.evaluate(async ([projectId, zonePath, port]) => {
    const key = await window.__TAURI_INTERNALS__.invoke('project_window_key');
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/game/source?path=${encodeURIComponent(zonePath)}`, { headers: { 'x-spellcast-window': key } });
    return response.json();
  }, [projectId, zonePath, port])).hash;
  assert.match(zoneHash, /^[0-9a-f]{64}$/);
  await post('/api/projects/command', { request_id: crypto.randomUUID(), project_id: projectId, op: 'put_proposal', id: 'native-check', expected_revision: 0,
    title: '隔离检查 · 用户起草的提案（非 Agent）', summary: '原生检查写入隔离数据库的样本，用于验证审阅与采纳。',
    subject: { scale: 'experience', zone_id: 'zone_forest_shrine_outer' }, boundaries: '隔离数据库；没有 Unity 或玩家验证。',
    items: [
      { id: 'route', target: 'object', target_id: 'native-outer-route', base_revision: 0, reason: '路线来自 SubLocationRoutes。', basis: ['config'], boundaries: '未在 Unity 中走过。',
        references: [{ label: 'zone_forest_shrine_outer.json', uri: `file:///${gameRoot.replaceAll('\\', '/')}/${zonePath}`, version: zoneHash }],
        object: { name: '外围林地 · 入口到出口', kind: 'content', planning: { scopes: ['R0'], sections: [{ id: 's1', role: 'body', text: '古树根部 → 迷雾小径 → 灵泉 / 林间空地 → 野兽巢穴 → 迷雾出口。' }] } } },
      { id: 'verify', target: 'record', target_id: 'native-verify-route', base_revision: 0, reason: '配置不证明玩家路线。', basis: ['inference'],
        record: { title: '在 Unity 中走一遍外围林地', status: 'planned', boundaries: '尚未运行。' } }] });
  ok('isolated project connected read-only to the real repository; one user-authored proposal seeded');

  // Open the workspace on the AI-first home.
  if (await page.locator('#mode-focus').isVisible().catch(() => false)) await page.locator('#mode-focus').click();
  await page.locator('#projects-open').evaluate(element => element.click());
  const home = page.locator('[data-game-home]');
  await home.locator('[data-gh-section="loop"] tbody tr').first().waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.project-workspace').getAttribute('data-workspace-view'), 'game');
  const loopRows = await home.locator('[data-gh-section="loop"] tbody tr').count();
  const loopText = await home.locator('[data-gh-section="loop"]').innerText();
  const loopPath = (await home.locator('[data-gh-section="loop"] .gh-source').getAttribute('title'))?.split('\n')[0];
  assert(loopRows >= 1, 'loop table from the design source');
  assert(['Assets/Documents/GameDesign/Overview.md', 'Assets/Documents/Atlas/domains/cycle.md'].includes(loopPath));
  assert(loopText.includes(loopPath.split('/').at(-1)), 'loop source shown with its actual document');
  const explorable = await home.locator('[data-gh-section="explorable"] [data-gh-zone]').count();
  assert(explorable >= 1, 'at least one explorable zone');
  assert.equal(await home.locator('[data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_outer"]').count(), 1, '神祠外围 is explorable');
  assert.match(await home.innerText(), /状态未知|Unknown/);
  report.overview = { loop_rows: loopRows, explorable_zones: explorable, counts: (await home.locator('.gh-counts').innerText()) };
  await shot('overview-dark');
  ok(`overview from real sources: ${loopRows} loop rows, ${explorable} explorable zones`);

  await home.locator('[data-gh-action="open-loop-canvas"]').click();
  await page.locator('.canvas-source-table tbody tr').first().waitFor();
  const sourceBoard = await get('/api/board');
  const sourceTables = sourceBoard.canvas.objects.filter(object => object.content.type === 'source_table' && object.content.table.project_id === projectId);
  assert.equal(sourceTables.length, 1, 'one native source table');
  assert.equal(sourceTables[0].content.table.rows.length, loopRows);
  assert.match(sourceTables[0].content.table.hash, /^[0-9a-f]{64}$/);
  await page.locator('#projects-open').evaluate(element => element.click());
  await home.locator('[data-gh-action="open-loop-canvas"]').click();
  await page.locator('.canvas-source-table tbody tr').first().waitFor();
  assert.equal((await get('/api/board')).canvas.objects.filter(object => object.id === sourceTables[0].id).length, 1, 'reopen finds the existing table');
  await page.locator('#projects-open').evaluate(element => element.click());
  await home.locator('[data-gh-section="loop"] tbody tr').first().waitFor();
  ok('native Canvas opens the real design table once with its source hash');

  // The review board reads the repository's full document tree without changing those files.
  await home.locator('[data-gh-action="open-documents"]').click();
  await home.locator('[data-gh-section="documents"]').waitFor();
  const documentCount = await home.locator('[data-gh-document]').count();
  assert(documentCount >= 2, 'indexed document inventory includes the loop source and supporting documents');
  await home.locator('[data-gh-document-search]').fill(loopPath.split('/').at(-1));
  const loopDocument = home.locator(`[data-gh-document="${loopPath}"]`);
  assert.equal(await loopDocument.isVisible(), true);
  await loopDocument.locator('[data-gh-action="read-document"]').click();
  assert.match(await home.locator('[data-gh-document-text]').innerText(), /循环/);
  const noteText = '隔离原生检查：核对四层循环的配置依据。';
  await home.locator('[data-gh-review-draft]').fill(noteText);
  await home.locator('[data-gh-action="save-review-comment"]').click();
  const noteCard = home.locator('[data-gh-review-record]').filter({ hasText: noteText }).first();
  await noteCard.waitFor();
  const savedNotes = await get(`/api/projects/${projectId}/records`);
  const savedNote = savedNotes.find(record => record.scope === 'spellcast.document-review.v1' && record.result === noteText);
  assert(savedNote, 'reader note persisted in project records');
  assert.equal(savedNote.updated_by.kind, 'user');
  assert(savedNote.references[0].uri.includes(loopPath));
  assert.match(savedNote.references[0].version, /^[0-9a-f]{64}$/);
  await noteCard.locator('[data-gh-action="toggle-comment-resolved"]').click();
  await page.waitForFunction(async ([port, projectId, id]) => {
    const rows = await (await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/records`)).json();
    return rows.find(record => record.id === id)?.status === 'done';
  }, [port, projectId, savedNote.id]);
  await noteCard.locator('[data-gh-action="reply-comment"]').click();
  await home.locator('[data-gh-review-draft]').fill('隔离原生检查回复：保留设计，运行结果另行核验。');
  await home.locator('[data-gh-action="save-review-comment"]').click();
  await home.locator('[data-gh-review-record]').filter({ hasText: '隔离原生检查回复' }).first().waitFor();
  const selectDocumentLine = async (line, append = false) => {
    await home.locator('[data-gh-document-text]').evaluate((pre, [line, append]) => {
      const span = pre.querySelector(`[data-gh-document-line="${line}"]`);
      const range = document.createRange(); range.selectNodeContents(span);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      pre.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ctrlKey: append }));
    }, [line, append]);
  };
  await selectDocumentLine(1); await selectDocumentLine(3, true);
  await home.locator('[data-gh-selection-toolbar]').waitFor();
  assert.match(await home.locator('[data-gh-selection-count]').innerText(), /2/);
  await shot('document-selection-popup-dark');
  await home.locator('[data-gh-action="ask-selection"]').click();
  await home.locator('[data-gh-question-draft]').fill('这两段的事实依据是什么？（隔离检查，不发送）');
  await home.locator('[data-gh-action="send-document-question"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-gh-question-status]')].some(node => node.textContent.includes('未发送')));
  const questions = (await get(`/api/projects/${projectId}/goals`)).filter(goal => goal.context.entity_kind === 'document_question');
  assert.equal(questions.length, 1); assert.equal(questions[0].status, 'unsent');
  assert.equal(questions[0].context.entity_id, loopPath);
  assert.match(questions[0].text, /#L1-L1@\d+-\d+/);
  assert.match(questions[0].text, /#L3-L3@\d+-\d+/);
  await selectDocumentLine(1); await selectDocumentLine(3, true);
  await home.locator('[data-gh-action="discard-selection"]').click();
  await page.waitForFunction(async ([port, projectId]) => {
    const rows = await (await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/records`)).json();
    return rows.some(record => record.scope === 'spellcast.document-selection.v1' && record.result === 'discard' && record.references.length === 2);
  }, [port, projectId]);
  await home.locator('[data-gh-discarded-range]').first().click();
  await home.locator('[data-gh-action="undo-discard"]').click();
  await page.waitForFunction(async ([port, projectId]) => {
    const rows = await (await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/records`)).json();
    return rows.some(record => record.scope === 'spellcast.document-selection.v1' && record.result === 'discard' && record.references.length === 1);
  }, [port, projectId]);
  await home.locator('[data-gh-action="close-source"]').click();
  await loopDocument.locator('[data-gh-action="read-document"]').click();
  await home.locator('[data-gh-review-record]').filter({ hasText: noteText }).first().waitFor();
  const reopenedNotes = (await get(`/api/projects/${projectId}/records`)).filter(record => record.scope === 'spellcast.document-review.v1');
  assert.equal(reopenedNotes.length, 2);
  assert(reopenedNotes.some(record => record.references.some(ref => ref.uri === `spellcast://project/${projectId}/record/${savedNote.id}`)), 'reply keeps its parent reference');
  assert.equal(await home.locator('[data-gh-discarded-range]').count(), 1, 'one remaining discarded passage persists after reopening');
  const discarded = (await get(`/api/projects/${projectId}/records`)).find(record => record.scope === 'spellcast.document-selection.v1');
  assert.match(discarded.references[0].uri, /#L3-L3@\d+-\d+$/);
  assert.match(discarded.references[0].version, /^[0-9a-f]{64}$/);
  assert.equal(discarded.updated_by.kind, 'user');
  const noteHistory = await get(`/api/projects/${projectId}/history/record/${savedNote.id}`);
  assert.equal(noteHistory.length, 2, 'note creation and resolution retain immutable history');
  await shot('document-reader-review-dark');
  await home.locator('[data-gh-action="close-source"]').click();
  await home.locator('[data-gh-document-search]').fill('');
  await shot('documents-dark');
  report.documents = { count: documentCount, source: 'Assets/Documents', repository_mutated: false, persisted_comments: reopenedNotes.length, comment_history: noteHistory.length, persisted_discarded_passages: 1, unsent_selected_text_question: questions[0].id };
  await home.locator('[data-gh-action="back-overview"]').click();
  ok(`document reader: ${documentCount} real Markdown sources; Ctrl multi-selection, selected-text question, strikeout/undo and persisted comments`);

  // Experience → object.
  await home.locator('[data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_outer"]').click();
  await home.locator('[data-gh-location="subloc_ancient_tree_root"]').waitFor({ timeout: 60000 });
  const locations = await home.locator('[data-gh-location]').count();
  const chain = await home.locator('[data-gh-section="chain"]').innerText();
  const missions = await home.locator('[data-gh-section="missions"]').innerText();
  const design = await home.locator('[data-gh-section="design"]').innerText();
  assert(locations >= 2); assert.match(chain, /古树根部/);
  report.experience = { locations, missions: missions.slice(0, 400), design: design.slice(0, 400) };
  await shot('experience-dark');
  await home.locator('[data-gh-location="subloc_ancient_tree_root"]').click();
  await home.locator('[data-gh-section="object-config"]').waitFor();
  const objectText = { design: await home.locator('[data-gh-section="object-design"]').innerText(), config: await home.locator('[data-gh-section="object-config"]').innerText(),
    code: await home.locator('[data-gh-section="object-code"]').innerText(), verification: await home.locator('[data-gh-section="object-verification"]').innerText() };
  assert.match(objectText.verification, /状态未知|Unknown/);
  report.object = Object.fromEntries(Object.entries(objectText).map(([key, value]) => [key, value.slice(0, 500)]));
  await home.locator('[data-gh-source]').first().click();
  await page.locator('dialog.gh-source-view[open] [data-gh-source-json]').waitFor();
  assert.match(await page.locator('dialog.gh-source-view').innerText(), /SHA-256 [0-9a-f]{64}/);
  await page.locator('dialog.gh-source-view [data-gh-action="close-source"]').click();
  await shot('object-dark');
  ok(`experience (${locations} locations) and object views read the real zone; source JSON with SHA-256`);

  // No bound task in isolation: the goal is saved as unsent and nothing is delivered.
  await home.locator('[data-gh-goal]').fill('整理古树根部的首次战斗与奖励节奏（隔离检查，不发送）。');
  assert.equal(await home.locator('[data-gh-send]').isDisabled(), true);
  await home.locator('[data-gh-action="save-unsent"]').click();
  await home.locator('[data-gh-side="goals"] [data-gh-goal-id]').filter({ hasText: '整理古树根部的首次战斗与奖励节奏' }).waitFor();
  const goals = await get(`/api/projects/${projectId}/goals`), feedback = await get('/api/feedback');
  const objectGoal = goals.find(goal => goal.context.scale === 'object');
  assert.equal(goals.length, 2); assert.equal(objectGoal.status, 'unsent');
  assert.equal(feedback.bindings.length, 0); assert.equal(feedback.deliveries.length, 0);
  ok('goal saved as unsent with object context; no binding and no delivery exist');

  await page.keyboard.press('Escape'); await home.locator('[data-gh-section="chain"]').waitFor();
  await page.keyboard.press('Escape'); await home.locator('[data-gh-section="loop"]').waitFor();
  for (let attempt = 0; attempt < 4; attempt++) {
    await home.locator('[data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_outer"]').click();
    await home.locator('[data-gh-section="chain"]').waitFor();
    await page.keyboard.press('Escape'); await home.locator('[data-gh-section="loop"]').waitFor();
    assert.equal(await page.locator('dialog.project-workspace').evaluate(dialog => dialog.open), true,
      'repeated Escape must leave the native workspace open');
  }
  ok('six native Escape returns keep the workspace open');

  // Review and adopt in place; return with no bound author keeps the note.
  await home.locator('[data-gh-side="proposals"] [data-proposal-card="native-check"] [data-proposal-action="open"]').click();
  const review = home.locator('[data-proposal-review="native-check"]'); await review.waitFor();
  assert.match(await review.locator('.gh-proposal-head').innerText(), /用户起草/, 'a user draft is not labelled AI inference');
  assert.doesNotMatch(await review.locator('.gh-proposal-head').innerText(), /AI 推断/);
  await shot('review-dark');
  await review.locator('[data-proposal-item="route"] [data-proposal-action="adopt"]').click();
  await page.waitForFunction(() => document.querySelector('[data-proposal-item="route"]')?.dataset.status === 'adopted');
  const objects = await get(`/api/projects/${projectId}/objects`);
  const adopted = objects.find(object => object.id === 'native-outer-route');
  assert(adopted?.planning?.confirmed && adopted.planning.locked);
  const history = await get(`/api/projects/${projectId}/history/object/native-outer-route`);
  assert.equal(history[0].actor.kind, 'user'); assert.equal(history[0].operation, 'adopt_proposal');
  await review.locator('[data-proposal-item="verify"] [data-proposal-action="return"]').click();
  await review.locator('[data-proposal-note-text="return"]').fill('请先在真实存档确认可进入区域。');
  await review.locator('[data-proposal-note="return"] [data-proposal-action="return-send"]').click();
  await page.waitForFunction(() => document.querySelector('[data-proposal-item="verify"]')?.dataset.status === 'returned');
  assert.match(await page.locator('.gh-status').innerText(), /没有关联|not connected/);
  assert.equal((await get('/api/feedback')).deliveries.length, 0, 'returning without a bound author sends nothing');
  ok('adoption wrote a confirmed, locked object with user provenance; return kept the note and sent nothing');

  // Planning and records remain reachable through the tools menu.
  await page.locator('[data-project-tools] > summary').click(); await page.locator('[data-project-view="planning"]').click();
  await page.locator('.project-planning [data-plan-tools]').waitFor();
  await page.locator('[data-project-tools] > summary').click(); await page.locator('[data-project-view="records"]').click();
  await page.locator('.project-workspace-records').waitFor();
  await page.locator('[data-project-tools] > summary').click(); await page.locator('[data-project-view="game"]').click();
  ok('manual planning and records stay available from the tools menu');

  // Widths and themes in the real WebView.
  for (const [theme, sizes] of [['dark', [[1600, 1000], [1320, 900], [880, 800]]], ['light', [[1600, 1000], [880, 800]]]]) {
    await page.evaluate(value => { localStorage.setItem('spellcast.theme', value); document.body.dataset.theme = value; document.dispatchEvent(new CustomEvent('spellcast-theme-change', { detail: value })); }, theme);
    for (const [width, height] of sizes) {
      await page.evaluate(([w, h]) => window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: w, height: h } } }), [width, height]);
      await page.waitForFunction(([w]) => Math.abs(innerWidth - w) <= 2, [width]).catch(() => {});
      await sleep(400);
      const spill = await page.evaluate(() => { const d = document.querySelector('.project-workspace'); return { page: document.documentElement.scrollWidth > innerWidth + 1, panel: d ? d.scrollWidth > d.clientWidth + 2 : false, width: innerWidth }; });
      assert.equal(spill.page || spill.panel, false, `spill at ${theme} ${width}`);
      await shot(`overview-${theme}-${spill.width}`);
    }
  }
  ok('dark/light at 1600/1320/880 in the native WebView without spill');

  const statusAfter = git(['status', '--porcelain=v1', '--untracked-files=all']);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), head); assert.equal(statusAfter, statusBefore, 'the repository working tree is unchanged');
  report.repository.unchanged = true;
  ok('repository HEAD and working tree unchanged');
  report.passed = true;
  await writeFile(path.join(output, 'native-report.json'), JSON.stringify(report, null, 2));
  await finish(0);
} catch (error) {
  report.passed = false; report.error = String(error?.stack || error);
  await writeFile(path.join(output, 'native-report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.error(error); await shot('failure').catch(() => {}); await finish(1);
}
