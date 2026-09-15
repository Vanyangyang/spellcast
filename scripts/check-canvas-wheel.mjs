/** Real mouse wheel regression check against a running native Spellcast window. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9337');
const native = browser.contexts()[0].pages().find(p => p.url() === 'http://tauri.localhost/'); assert(native);
native.setDefaultTimeout(10000);
const graph = native.locator('.canvas-graph > svg > .x6-graph-svg-viewport');
const toolbar = native.locator('.canvas-toolbar');
const reset = toolbar.locator('button').filter({ hasText: /^\d+%$/ });
const scale = () => graph.evaluate(g => g.transform.baseVal.consolidate().matrix.a);
const rendered = () => native.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function assertLabel() { assert.equal(await reset.innerText(), Math.round(await scale() * 100) + '%'); }
try {
  assert.equal(await native.locator('.canvas-reader[open]').count(), 0, 'Close the reader before testing canvas navigation.');
  const port = await native.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(s => s.port));
  const board = async () => (await fetch('http://127.0.0.1:' + port + '/api/board')).json();
  const beforeBoard = await board();
  await reset.click(); assert.equal(await scale(), 1); await assertLabel();
  const at = await native.locator('.canvas-viewport').evaluate(view => {
    const r = view.getBoundingClientRect();
    for (const y of [.25, .5, .75]) for (const x of [.25, .5, .75]) {
      const p = { x: Math.round(r.left + r.width * x), y: Math.round(r.top + r.height * y) }, hit = document.elementFromPoint(p.x, p.y);
      if (hit?.closest('.canvas-viewport') === view && !hit.closest('.canvas-frame')) return p;
    }
    throw new Error('The viewport needs a blank point for this check.');
  });
  const local = () => graph.evaluate((g, p) => new DOMPoint(p.x, p.y).matrixTransform(g.getScreenCTM().inverse()).toJSON(), at);
  const anchored = await local();
  await native.mouse.move(at.x, at.y); await native.mouse.wheel(0, -120); await rendered();
  const enlarged = await scale(); assert(enlarged > 1); await assertLabel();
  const after = await local(); assert(Math.abs(after.x - anchored.x) < .01 && Math.abs(after.y - anchored.y) < .01, 'Wheel zoom moved the point under the cursor.');
  await native.mouse.wheel(0, 120); await rendered(); const reduced = await scale(); assert(reduced < enlarged); await assertLabel();
  await toolbar.getByRole('button', { name: /^(Zoom in|放大|拡大)$/ }).click(); await assertLabel();
  await toolbar.getByRole('button', { name: /^(Zoom out|缩小|縮小)$/ }).click(); await assertLabel();
  await reset.click(); assert.equal(await scale(), 1); await assertLabel();
  await toolbar.getByRole('button', { name: /^(Fit all|查看全部|全体を表示)$/ }).click(); await assertLabel();
  const fitted = await scale(); await native.mouse.move(at.x, at.y); await native.mouse.wheel(0, 120); await rendered();
  const belowFit = await scale(); assert(belowFit <= fitted, 'Zooming out after Fit all must not jump up to an unrelated wheel minimum.'); await assertLabel();
  await native.mouse.wheel(0, -120); await rendered(); assert(await scale() > belowFit); await assertLabel();
  await toolbar.locator('select').selectOption({ index: 1 });
  const reader = native.locator('.canvas-reader[open]');
  const content = reader.locator('.canvas-frame-content'), rect = await content.boundingBox(); assert(rect);
  const unchanged = await scale(); await native.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .5); await native.mouse.wheel(0, 120); await rendered();
  assert.equal(await scale(), unchanged, 'Scrolling opened content must not zoom the outer canvas.');
  await reader.locator(':scope > header').getByRole('button', { name: /^(Close|关闭|閉じる)$/ }).click();
  const afterBoard = await board(); assert.deepEqual(afterBoard.canvas, beforeBoard.canvas); assert.deepEqual(afterBoard.nodes, beforeBoard.nodes); assert.deepEqual(afterBoard.replies, beforeBoard.replies);
  const result = { plainWheelZoomsIn: enlarged, plainWheelZoomsOut: reduced, cursorAnchored: true, livePercentage: true, zoomOutAfterFit: { fitted, belowFit }, openedContentScrollDoesNotZoomCanvas: true, savedContentAndLayoutUnchanged: true };
  const output = path.resolve('artifacts/canvas-wheel'); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); await native.screenshot({ path: path.join(output, 'verified.png') });
  console.log(JSON.stringify(result)); process.exit(0);
} catch (error) { console.error(error.stack ?? error); process.exit(1); }
