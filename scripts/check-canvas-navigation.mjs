/** Native usability regression: all gestures use real input; Tidy stays applied and is undoable. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9337');
const native = browser.contexts()[0].pages().find(p => p.url() === 'http://tauri.localhost/'); assert(native);
native.setDefaultTimeout(10000);
const port = await native.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(s => s.port));
const board = async () => (await fetch('http://127.0.0.1:' + port + '/api/board')).json();
const toolbar = native.locator('.canvas-toolbar'), graph = native.locator('.canvas-graph > svg > .x6-graph-svg-viewport');
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? 'artifacts/canvas-navigation'); await mkdir(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Disconnect from the WebView before exiting; exiting with the socket still closing aborts Node on Windows.
const finish = async code => { await browser.close().catch(() => {}); process.exitCode = code; await sleep(300); process.exit(code); };
async function until(read) { const start = Date.now(); do { if (await read()) return; await sleep(100); } while (Date.now() - start < 6000); throw Error('Navigation check did not settle.'); }
const contentId = 'everything-tool-20260907';
async function post(route, body) {
  const response = await fetch('http://127.0.0.1:' + port + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
}
if (await native.locator('#mode-focus').isVisible()) await native.locator('#mode-focus').click();
await toolbar.waitFor();
// The check once ran on a hand-prepared board. On a fresh isolated bridge it seeds the same shape: one
// work (a single artifact block) with a saved note. Never on the user's port.
if (!(await board()).replies.some(r => r.id === contentId)) {
  assert.notEqual(port, 47194, 'Only seed an isolated bridge.');
  const reply = await post('/api/artifacts', { source_id: 'verification:canvas-navigation', reply_id: contentId, block_id: 'work', title: 'Everything tool', directory: path.resolve('scripts/fixtures/atomic-work'), entry: 'index.html' });
  const block = reply.blocks[0];
  await post('/api/artifacts/state', { reply_id: contentId, block_id: block.id, bundle_id: block.bundle_id, expected_state_revision: block.state_revision ?? 0, state: { note: 'Navigation fixture note', count: 2 } });
  // Tidy needs neighbours to arrange.
  for (const [id, title] of [['navigation-a', 'Plan'], ['navigation-b', 'Risks'], ['navigation-c', 'Notes']]) {
    await post('/api/replies', { id, source_id: 'verification:canvas-navigation', title, blocks: [{ id: 'text', type: 'text', title, text: title + ' for the navigation check.' }] });
  }
  await native.reload(); await toolbar.waitFor();
}
const key = (await board()).canvas.objects.find(o => o.content.type === 'reply' && o.content.id === contentId)?.id; assert(key);
// user_modified records that a person placed the card (agent layouts then leave it alone); undo restores
// the geometry, not that history, so poses compare without it.
const poses = items => JSON.stringify(items.map(({ revision, user_modified, ...pose }) => pose));
const frame = native.locator('.canvas-frame[data-item-id="' + key + '"]');
const item = b => b.canvas.items.find(i => i.item_id === key);
const settle = () => native.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** Tidy, Undo/Redo layout and the item jump live in the toolbar's More menu. */
async function moreItem(name) {
  const more = toolbar.locator('.canvas-tool-more');
  if (!await more.evaluate(details => details.open)) await more.locator(':scope > summary').click();
  await more.getByRole('button', { name, exact: true }).click();
}
/** "Back to canvas" sits on the active card's head; the dock repeats it only while that head cannot be used. */
async function backToCanvas() {
  await settle();
  const dock = toolbar.locator('.canvas-tool-selection > .canvas-selection-work');
  if (await dock.isVisible()) return dock.click();
  await native.locator('.canvas-frame.is-active > .canvas-frame-head').getByRole('button', { name: 'Back to canvas', exact: true }).click();
}
/** A single work keeps Run/Stop in its Work settings dialog; the live iframe stays in the card. */
async function workControl(name) {
  const dialog = frame.locator('.artifact-management');
  if (!(await dialog.evaluate(node => node.open))) { await settle(); await toolbar.getByRole('button', { name: 'Work settings', exact: true }).click(); }
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name, exact: true }).click();
}
const closeWorkSettings = async () => { const dialog = frame.locator('.artifact-management'); if (await dialog.evaluate(node => node.open)) await dialog.locator(':scope > header').getByRole('button', { name: 'Close', exact: true }).click(); };
// The camera as Canvas saves it (canvas.ts persistView): the zoom, and the world point at the centre of
// the area right of the tool rail and below the top inset (SAFE_LEFT 88, SAFE_TOP 56). Unlike the raw
// matrix it does not change when the composer grows and the stage gets shorter.
const camera = () => native.locator('.canvas-graph').evaluate(host => {
  const m = host.querySelector('.x6-graph-svg-viewport').transform.baseVal.consolidate().matrix;
  return { scale: m.a, x: (88 + (host.clientWidth - 88) / 2 - m.e) / m.a, y: (56 + (host.clientHeight - 56) / 2 - m.f) / m.a };
});
const sameCamera = (a, b) => Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01;
const savedView = () => native.evaluate(() => { const key = Object.keys(localStorage).find(name => name.startsWith('spellcast.canvas-view')); return key ? JSON.parse(localStorage.getItem(key)) : null; });
async function drag(dx, dy, button = 'left') {
  const rect = await frame.locator('.canvas-card-drag').boundingBox(); assert(rect);
  await native.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .55); await native.mouse.down({ button });
  await native.mouse.move(rect.x + rect.width * .5 + dx, rect.y + rect.height * .55 + dy, { steps: 8 }); await native.mouse.up({ button });
}
try {
  assert.equal(await native.locator('dialog[open]').count(), 0);
  if (process.argv.includes('--wasd')) {
    const before = await board();
    const transform = () => graph.evaluate(g => { const m = g.transform.baseVal.consolidate().matrix; return { x: m.e, y: m.f, scale: m.a }; });
    const canvasClick = async () => {
      const point = await native.locator('.canvas-viewport').evaluate(v => {
        const r = v.getBoundingClientRect();
        for (const y of [.1, .5, .9]) for (const x of [.1, .5, .9]) {
          const p = { x: r.left + r.width * x, y: r.top + r.height * y }, hit = document.elementFromPoint(p.x, p.y);
          if (hit?.closest('.canvas-graph') && !hit.closest('.canvas-frame-head')) return p;
        }
        throw Error('No canvas input point found.');
      });
      await native.mouse.click(point.x, point.y);
      await native.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    await canvasClick();
    for (const [key, dx, dy] of [['w', 0, 48], ['a', 48, 0], ['s', 0, -48], ['d', -48, 0]]) {
      const start = await transform(); await native.keyboard.press(key); const end = await transform();
      assert(Math.abs(end.x - start.x - dx) < .01 && Math.abs(end.y - start.y - dy) < .01, 'Wrong WASD direction: ' + key); assert.equal(end.scale, start.scale);
    }
    const repeatStart = await transform();
    for (let i = 0; i < 3; i++) await native.keyboard.down('w'); await native.keyboard.up('w');
    assert(Math.abs((await transform()).y - repeatStart.y - 144) < .01, 'Repeated keydown must keep moving.');
    for (let i = 0; i < 3; i++) await native.keyboard.press('s');
    // Selecting everything grows the composer (its context line), so the stage gets shorter; the camera must not move.
    const shortcutsStart = await camera(); await native.keyboard.press('Control+a');
    const shortcutsEnd = await camera(); assert(sameCamera(shortcutsEnd, shortcutsStart), 'Ctrl+A moved the camera ' + JSON.stringify({ shortcutsStart, shortcutsEnd }));
    const input = native.locator('#input');
    const original = await input.inputValue();
    try {
      await input.click(); await input.press('Control+End'); const typingStart = await camera();
      await native.keyboard.type('wasd'); assert.equal(await input.inputValue(), original + 'wasd'); assert(sameCamera(await camera(), typingStart), 'Typing moved the camera');
    } finally { await input.fill(original); }
    await canvasClick(); const resumed = await transform(); await native.keyboard.press('w'); assert((await transform()).y > resumed.y); await native.keyboard.press('s');
    await toolbar.getByRole('button', { name: 'All items', exact: true }).click();
    const modalStart = await camera(); await native.keyboard.type('wasd'); assert(sameCamera(await camera(), modalStart), 'A modal let WASD move the camera'); await native.keyboard.press('Escape');
    const after = await board(); for (const field of ['canvas', 'nodes', 'replies']) assert.deepEqual(after[field], before[field]);
    const result = { wasdDirections: true, repeatedKeydown: true, inputAndShortcutsPreserved: true, clickCanvasResumesNavigation: true, modalDoesNotMoveCanvas: true, layoutAndContentUnchanged: true };
    await writeFile(path.join(output, 'wasd.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); await finish(0);
  }
  if (process.argv.includes('--after-restart')) {
    const expected = JSON.parse(await readFile(path.join(output, 'after.json'), 'utf8'));
    const previous = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
    const restored = await board();
    for (const field of ['canvas', 'nodes', 'replies']) assert.deepEqual(restored[field], expected[field]);
    const view = await camera();
    for (const field of ['scale', 'x', 'y']) assert(Math.abs(view[field] - previous.view[field]) < .01, 'View did not survive restart: ' + field + ' ' + JSON.stringify({ view, saved: previous.view }));
    const result = { layoutAndContentRestored: true, viewRestored: true, view };
    await writeFile(path.join(output, 'after-restart.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); await finish(0);
  }
  const before = await board(); await writeFile(path.join(output, 'before.json'), JSON.stringify(before, null, 2));
  await toolbar.getByRole('button', { name: 'All items', exact: true }).click();
  const overview = native.locator('.canvas-overview'); assert.equal(await overview.locator('.canvas-overview-card').count(), before.canvas.items.filter(p => !p.removed).length);
  // Item titles in the overview read at 16px, above the 13px tool chrome (canvas.css).
  assert.equal(await overview.locator('.canvas-overview-open').first().evaluate(b => getComputedStyle(b).fontSize), '16px');
  const overviewCard = await overview.locator('.canvas-overview-card').first().elementHandle();
  await native.keyboard.press('Escape'); await toolbar.getByRole('button', { name: 'All items', exact: true }).click();
  assert(await overviewCard.evaluate(card => card.isConnected), 'An unchanged overview must keep its controls and keyboard focus targets.');
  await native.screenshot({ path: path.join(output, 'overview.png') });
  await overview.locator('[data-item-id="' + key + '"]').getByRole('button', { name: 'Locate', exact: true }).click();
  const zoom = await graph.evaluate(g => g.transform.baseVal.consolidate().matrix.a); assert(zoom >= .5);
  assert(await frame.locator('.canvas-frame-content').evaluate(e => e.inert));
  await drag(90, 40); await until(async () => item(await board()).x !== item(before).x); assert.equal(item(await board()).user_modified, true);
  await moreItem('Undo layout');
  await until(async () => poses((await board()).canvas.items) === poses(before.canvas.items)).catch(async error => { throw new Error(error.message + ' expected ' + poses(before.canvas.items) + ' got ' + poses((await board()).canvas.items)); });
  const stationary = (await board()).canvas.items;
  await toolbar.getByRole('button', { name: 'Hand tool', exact: true }).click();
  let matrix = await graph.getAttribute('transform'); await drag(70, 30); assert.notEqual(await graph.getAttribute('transform'), matrix);
  assert.deepEqual((await board()).canvas.items, stationary);
  await toolbar.getByRole('button', { name: 'Hand tool', exact: true }).click();
  const rect = await frame.locator('.canvas-card-drag').boundingBox(); await native.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  matrix = await graph.getAttribute('transform'); await native.keyboard.down('Space'); await drag(-60, 20); await native.keyboard.up('Space'); assert.notEqual(await graph.getAttribute('transform'), matrix);
  assert.deepEqual((await board()).canvas.items, stationary);
  matrix = await graph.getAttribute('transform'); await drag(45, -30, 'middle'); assert.notEqual(await graph.getAttribute('transform'), matrix); assert.deepEqual((await board()).canvas.items, stationary);
  assert.equal(await native.locator('.canvas-workspace.is-panning').count(), 0, 'Releasing Space or the middle button must end temporary panning.');
  await frame.locator('.canvas-card-drag').dblclick();
  assert(await frame.evaluate(f => f.classList.contains('is-active'))); assert.equal(await frame.locator('.canvas-frame-content').evaluate(c => c.inert), false);
  await workControl('Stop'); await until(async () => await frame.locator('iframe').count() === 0);
  await workControl('Run'); await closeWorkSettings();
  const work = await (await frame.locator('iframe').elementHandle()).contentFrame(); await work.locator('#note').waitFor();
  assert.equal(await work.locator('#note').inputValue(), before.replies.find(r => r.id === contentId).blocks[0].state.note);
  await backToCanvas();
  await drag(37, 0); await until(async () => item(await board()).x !== item(before).x);
  const beforeTidy = (await board()).canvas.items;
  await moreItem('Tidy layout');
  await until(async () => { const items = (await board()).canvas.items; return items.every(i => i.x >= 0 && i.y >= 0) && JSON.stringify(items) !== JSON.stringify(beforeTidy); });
  const tidy = (await board()).canvas.items; assert(new Set(tidy.map(i => i.x)).size > 1);
  await moreItem('Undo layout'); await until(async () => poses((await board()).canvas.items) === poses(beforeTidy));
  await moreItem('Redo layout'); await until(async () => poses((await board()).canvas.items) === poses(tidy));
  const after = await board(); assert.deepEqual(after.replies, before.replies); assert.deepEqual(after.nodes, before.nodes);
  await writeFile(path.join(output, 'after.json'), JSON.stringify(after, null, 2));
  await native.screenshot({ path: path.join(output, 'tidy.png') });
  // The camera is saved per Canvas scope (spellcast.canvas-view:<workspace>:<task>).
  const view = await savedView(); assert(view && view.scale >= .5);
  const result = { overviewCards: tidy.filter(p => !p.removed).length, overviewFontPx: 16, bodyDragAndUndo: true, handPan: true, spacePan: true, middlePan: true, doubleClickActivatesInline: true, tidyIsOneUndoAndRedo: true, contentPreserved: true, view };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); await finish(0);
} catch (error) { await native.keyboard.up('Space').catch(() => {}); await writeFile(path.join(output, 'failure.txt'), String(error.stack ?? error)); console.error(error.stack ?? error); await finish(1); }
