/** Native UI polish checks. MCP/HTTP creates isolated fixtures only; Focus and selection use the real WebView. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? path.join(root, 'artifacts/ui-polish-20260910/final-ui'));
await mkdir(output, { recursive: true });

const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9344');
const page = browser.contexts()[0]?.pages().find(candidate => candidate.url() === 'http://tauri.localhost/');
assert(page, 'Use the native WebView at http://tauri.localhost/.');
page.setDefaultTimeout(12000);
const port = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
assert.equal(port, Number(process.env.SPELLCAST_TEST_PORT ?? 47204), 'Use the isolated polish bridge.');
assert.notEqual(port, 47194, 'Never run polish checks against user data.');
const base = 'http://127.0.0.1:' + port;

async function api(url, method = 'GET', data) {
  const response = await fetch(base + url, {
    method,
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}

let session;
let rpcId = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++rpcId } : {}), method, params }),
  });
  session ??= response.headers.get('Mcp-Session-Id');
  const text = await response.text();
  assert(response.ok, text);
  if (!text.trim()) return undefined;
  const payload = JSON.parse(/^(event|data):/.test(text)
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    : text);
  assert(!payload.error, JSON.stringify(payload));
  return payload.result;
}
async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert(!result.isError, JSON.stringify(result));
  const text = result.content?.find(item => item.type === 'text')?.text;
  return result.structuredContent ?? JSON.parse(text);
}
async function until(read, label, timeout = 12000) {
  const start = Date.now();
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() - start < timeout);
  throw new Error(label + ' did not settle');
}

const toolbar = page.locator('.canvas-toolbar');
const more = toolbar.locator('.canvas-tool-more');
const summary = more.locator(':scope > summary');
const menu = more.locator('.canvas-tool-menu');
const result = { native: true, checks: [], viewports: {}, shots: [] };
const pass = label => { result.checks.push(label); console.log('PASS ' + label); };

async function shot(name) {
  await page.screenshot({ path: path.join(output, name), animations: 'disabled' });
  result.shots.push(name);
}

async function clickToolbar(name) {
  const button = toolbar.getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) {
    await summary.click();
    await button.waitFor({ state: 'visible' });
  }
  await button.click();
}

async function recordViewport(key) {
  result.viewports[key] = await page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
}

await page.locator('#locale').selectOption('en');
if (await page.locator('#mode-focus').isVisible()) await page.locator('#mode-focus').click();
await toolbar.waitFor();

if (process.argv.includes('--tide-closeup')) {
  await page.locator('#locale').selectOption('zh-CN');
  await toolbar.waitFor();
  await clickToolbar('内容总览');
  const chartCard = page.locator('.canvas-overview-card').filter({ hasText: 'Tide chart' });
  assert.equal(await chartCard.count(), 1, 'expected the Tide chart overview card');
  await chartCard.getByRole('button', { name: '定位', exact: true }).click();
  await page.locator('.canvas-frame.is-selected').waitFor();
  await clickToolbar('聚焦所选内容');
  const viewportBox = await page.locator('.canvas-viewport').boundingBox();
  const frameBox = await page.locator('.canvas-frame.is-selected').first().boundingBox();
  assert(viewportBox && frameBox, 'missing focused Tide chart geometry');
  assert(frameBox.x >= viewportBox.x - 2 && frameBox.y >= viewportBox.y - 2, 'Tide chart is clipped at the top or left');
  assert(frameBox.x + frameBox.width <= viewportBox.x + viewportBox.width + 2, 'Tide chart is clipped on the right');
  assert(frameBox.y + frameBox.height <= viewportBox.y + viewportBox.height + 2, 'Tide chart is clipped at the bottom');
  await shot('zh-tide-closeup.png');
  pass('Chinese Focus close-up shows the Tide chart fully');
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.checks));
  await browser.close();
  process.exit(0);
}

if (process.argv.includes('--focus-bounds')) {
  result.fixture = 'deterministic MCP canvas batch; NOT a native host Agent run';
  const snapshot = await api('/api/board');
  assert.equal(snapshot.canvas.objects.length, 0, 'Start the far-selection check on a fresh isolated test database.');
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'focus-bounds-check', version: '1' } });
  await rpc('notifications/initialized', {}, true);
  const created = await call('spellcast_canvas_batch', {
    source_id: 'focus-bounds-fixture',
    request_id: 'focus-bounds-far-pair',
    operations: [
      { op: 'create', id: 'far-west', content: { type: 'text', title: 'West mark', text: 'FOCUS_BOUNDS_WEST' }, placement: { x: 40, y: 80, width: 360, height: 220 } },
      { op: 'create', id: 'far-east', content: { type: 'text', title: 'East mark', text: 'FOCUS_BOUNDS_EAST' }, placement: { x: 12040, y: 80, width: 360, height: 220 } },
    ],
  });
  assert.equal(created.result.status, 'applied');
  await until(async () => (await api('/api/board')).canvas.objects.some(item => item.id === 'far-west')
    && (await api('/api/board')).canvas.objects.some(item => item.id === 'far-east')
    && await page.locator('.canvas-frame[data-item-id="far-west"]').count()
    && await page.locator('.canvas-frame[data-item-id="far-east"]').count(), 'far fixture frames');
  const placed = await api('/api/board');
  const west = placed.canvas.items.find(item => item.item_id === 'far-west');
  const east = placed.canvas.items.find(item => item.item_id === 'far-east');
  assert(east.x - west.x >= 11000, 'fixture objects must be about 12000 world units apart');
  await clickToolbar('Layers');
  await page.locator('.canvas-layers').waitFor();
  await page.locator('.canvas-layer-row[data-item-id="far-west"]').locator('.canvas-layer-pick').click();
  await page.locator('.canvas-layer-row[data-item-id="far-east"]').locator('.canvas-layer-pick').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Escape');
  const selectedIds = await page.locator('.canvas-frame.is-selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')).sort());
  assert.deepEqual(selectedIds, ['far-east', 'far-west']);
  const before = await api('/api/board');
  await clickToolbar('Focus the selection');
  const after = await api('/api/board');
  assert.deepEqual(after.canvas.objects, before.canvas.objects);
  assert.deepEqual(after.canvas.items, before.canvas.items);
  assert.deepEqual(after.replies, before.replies);
  const selectedAfter = await page.locator('.canvas-frame.is-selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')).sort());
  assert.deepEqual(selectedAfter, selectedIds);
  const percent = Number((await toolbar.locator('.canvas-zoom-value').textContent())?.replace('%', ''));
  assert(Number.isFinite(percent), 'missing zoom percent');
  assert.equal(percent >= 1, true, 'Focus zoom went below the canvas 1% floor');
  assert.equal(percent < 20, true, 'Focus zoom stayed at the old 20% floor and cannot fit the far pair');
  result.zoomPercent = percent;
  const viewportBox = await page.locator('.canvas-viewport').boundingBox();
  assert(viewportBox, 'missing canvas viewport');
  for (const id of ['far-west', 'far-east']) {
    const box = await page.locator('.canvas-frame[data-item-id="' + id + '"]').boundingBox();
    assert(box, 'missing frame ' + id);
    assert(box.x >= viewportBox.x - 2 && box.y >= viewportBox.y - 2, id + ' is clipped at the top or left');
    assert(box.x + box.width <= viewportBox.x + viewportBox.width + 2, id + ' is clipped on the right');
    assert(box.y + box.height <= viewportBox.y + viewportBox.height + 2, id + ' is clipped at the bottom');
  }
  await shot('far-pair.png');
  pass('Focus fits a 12000-unit multi-selection below 20% zoom without changing objects or selection');
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.checks));
  await browser.close();
  process.exit(0);
}
await page.setViewportSize({ width: 1320, height: 860 });
await recordViewport('requested1320x860');
await shot('en-desktop.png');
assert.equal(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'toolbar overflows horizontally at desktop width');
pass('toolbar has no horizontal overflow at the recorded desktop viewport');

await summary.click();
await menu.waitFor();
const last = menu.locator('button').last();
await last.scrollIntoViewIfNeeded();
const lastBox = await last.boundingBox();
const menuBox = await menu.boundingBox();
const workspaceBox = await page.locator('.canvas-workspace').boundingBox();
assert(lastBox && menuBox && workspaceBox, 'missing more-menu geometry');
assert(lastBox.y + 1 >= menuBox.y && lastBox.y + lastBox.height <= menuBox.y + menuBox.height + 1, 'last more-menu action is not reachable inside the menu');
assert(menuBox.y + menuBox.height <= workspaceBox.y + workspaceBox.height + 1, 'more menu extends past the canvas workspace');
await shot('en-more-menu.png');
pass('more menu last action is reachable within the canvas workspace');

await page.keyboard.press('Escape');
assert.equal(await summary.evaluate(node => document.activeElement === node), true, 'Escape did not return focus to the more summary');
pass('Escape closes more and returns focus to summary');

await clickToolbar('All items');
const chartCard = page.locator('.canvas-overview-card').filter({ hasText: 'Tide chart' });
assert.equal(await chartCard.count(), 1, 'expected the Tide chart overview card');
await chartCard.getByRole('button', { name: 'Locate', exact: true }).click();
const selected = page.locator('.canvas-frame.is-selected');
await selected.waitFor();
const selectedIds = await selected.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')));
const before = await api('/api/board');
await clickToolbar('Focus the selection');
const after = await api('/api/board');
assert.deepEqual(after.canvas.objects, before.canvas.objects);
assert.deepEqual(after.canvas.items, before.canvas.items);
assert.deepEqual(after.replies, before.replies);
const selectedAfter = await page.locator('.canvas-frame.is-selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')));
assert.deepEqual(selectedAfter, selectedIds);
const viewportBox = await page.locator('.canvas-viewport').boundingBox();
const frameBox = await page.locator('.canvas-frame.is-selected').first().boundingBox();
assert(viewportBox && frameBox, 'missing focused frame geometry');
assert(frameBox.x >= viewportBox.x - 2 && frameBox.y >= viewportBox.y - 2, 'focused frame is clipped at the top or left');
assert(frameBox.x + frameBox.width <= viewportBox.x + viewportBox.width + 2, 'focused frame is clipped on the right');
assert(frameBox.y + frameBox.height <= viewportBox.y + viewportBox.height + 2, 'focused frame is clipped at the bottom');
await shot('en-closeup.png');
pass('Focus selection keeps objects, selection and work state and shows the selection fully');

await clickToolbar('Data connections');
const connections = page.locator('.canvas-connections');
await connections.waitFor();
const summaryText = await connections.locator('div > p').filter({ hasText: '→' }).first().textContent();
assert(summaryText, 'missing connection summary');
assert.equal(/\b[0-9a-f]{8}-[0-9a-f]{4}-/.test(summaryText), false, 'connection summary still shows a raw object id');
assert.equal(summaryText.includes('work.tide'), false, 'connection summary still shows a block-id.port token');
assert.equal(/Tide controls · Tide controls/.test(summaryText), false, 'connection summary repeats the same title');
assert.match(summaryText, /Tide controls · tide → Tide chart · tide/);
await shot('en-connections.png');
await page.locator('.canvas-connections').getByRole('button', { name: 'Close', exact: true }).click();
pass('connection summary uses titles and ports without repeating the same name');

await clickToolbar('Layers');
await page.locator('.canvas-layers').waitFor();
const pressedPick = page.locator('.canvas-layer-pick[aria-pressed="true"]');
const idlePick = page.locator('.canvas-layer-pick[aria-pressed="false"]');
assert.equal(await pressedPick.count() >= 1, true, 'expected a selected layers row');
assert.equal(await idlePick.count() >= 1, true, 'expected an unselected layers row');
const layerPaint = await page.evaluate(() => {
  const on = document.querySelector('.canvas-layer-pick[aria-pressed="true"]');
  const off = [...document.querySelectorAll('.canvas-layer-pick')].find(node => node.getAttribute('aria-pressed') !== 'true');
  if (!on || !off) return null;
  const read = node => { const style = getComputedStyle(node); return [style.backgroundColor, style.borderTopColor, style.boxShadow, style.outlineColor].join('|'); };
  return { on: read(on), off: read(off) };
});
assert(layerPaint, 'missing layers row styles');
assert.notEqual(layerPaint.on, layerPaint.off, 'selected layers row is visually identical to an unselected row');
await shot('en-layers.png');
await page.locator('.canvas-layers').getByRole('button', { name: 'Close', exact: true }).click();
pass('selected layers row is visually distinct from unselected rows');

await shot('composer.png');

await page.setViewportSize({ width: 1000, height: 700 });
await recordViewport('requested1000x700');
await summary.click();
await menu.waitFor();
await menu.locator('button').last().scrollIntoViewIfNeeded();
await shot('en-narrow-more.png');
assert.equal(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'toolbar overflows horizontally at the narrow viewport');
await page.keyboard.press('Escape');
pass('narrow viewport more menu last item remains reachable without horizontal toolbar overflow');

await page.setViewportSize({ width: 1320, height: 860 });
await page.locator('#locale').selectOption('zh-CN');
await toolbar.waitFor();
await shot('zh-desktop.png');
await clickToolbar('层级');
await page.locator('.canvas-layers').waitFor();
await shot('zh-layers.png');
await page.locator('.canvas-layers').getByRole('button', { name: '关闭', exact: true }).click();
pass('Chinese chrome and layers dialog render');

await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.checks));
await browser.close();
