/** Isolated studio integration check. MCP/HTTP is fixture setup only, not a native host Agent.
 * --verify-restart is a real process relaunch against the same isolated DB + WebView profile.
 * page.reload is not a process restart. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? path.join(root, 'artifacts/canvas-studio-integration-20260910/round3'));
await mkdir(output, { recursive: true });

const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9346');
const page = browser.contexts()[0]?.pages().find(candidate => candidate.url() === 'http://tauri.localhost/');
assert(page, 'Use the native WebView at http://tauri.localhost/.');
page.setDefaultTimeout(15000);
const port = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
assert.equal(port, Number(process.env.SPELLCAST_TEST_PORT ?? 47208), 'Use the isolated studio bridge.');
assert.notEqual(port, 47194, 'Never run studio checks against user data.');
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
async function until(read, label, timeout = 15000) {
  const start = Date.now();
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 120));
  } while (Date.now() - start < timeout);
  throw new Error(label + ' did not settle');
}

const toolbar = page.locator('.canvas-toolbar');
async function clickToolbar(name) {
  const button = toolbar.getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) {
    await toolbar.locator('.canvas-tool-more > summary').click();
    await button.waitFor({ state: 'visible' });
  }
  await button.click();
}
const board = () => api('/api/board');
const object = async id => (await board()).canvas.objects.find(item => item.id === id);
const pose = async id => (await board()).canvas.items.find(item => item.item_id === id);
const frame = id => page.locator('.canvas-frame[data-item-id="' + id + '"]');
async function done() {
  const button = toolbar.getByRole('button', { name: '返回画布', exact: true });
  if (await button.isVisible()) await button.click();
}
async function select(id) {
  await done();
  await clickToolbar('内容总览');
  await page.locator('.canvas-overview-card[data-item-id="' + id + '"]').getByRole('button', { name: '定位', exact: true }).click();
  await frame(id).locator('.canvas-card-drag').click();
  await until(() => frame(id).evaluate(node => node.classList.contains('is-selected')), 'selected ' + id);
}
async function artifactFrame(id) {
  const iframe = frame(id).locator('iframe');
  await iframe.waitFor({ state: 'attached' });
  const handle = await iframe.elementHandle();
  const work = await handle.contentFrame();
  assert(work, 'missing work frame ' + id);
  return work;
}
async function openWork(id) {
  await select(id);
  await page.keyboard.press('Enter');
  return artifactFrame(id);
}
async function workClick(work, selector) {
  const child = await work.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  const hostHandle = await work.frameElement();
  const host = await hostHandle.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, scale: rect.width / node.offsetWidth, left: node.clientLeft, top: node.clientTop };
  });
  await page.mouse.click(host.x + (host.left + child.x) * host.scale, host.y + (host.top + child.y) * host.scale);
}

function lum(color) {
  const match = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  const channels = match.slice(1, 4).map(value => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrastRatio(foreground, background) {
  const a = lum(foreground), b = lum(background);
  if (a == null || b == null) return 0;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}
async function nativePaint(id) {
  return frame(id).evaluate(node => {
    const vis = el => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName, text: el.tagName === 'TEXTAREA' ? el.value : (el.textContent ?? ''),
        color: style.color, background: style.backgroundColor, opacity: style.opacity,
        display: style.display, visibility: style.visibility, hidden: el.hidden,
        x: box.x, y: box.y, w: box.width, h: box.height,
      };
    };
    return {
      heading: vis(node.querySelector('h3.canvas-native-heading')),
      text: vis(node.querySelector('textarea.canvas-native-text')),
      frame: vis(node),
    };
  });
}
function paintVisible(info, title, body) {
  const heading = info?.heading, text = info?.text;
  if (!heading || !text) return false;
  const shown = part => part && part.w > 4 && part.h > 4 && part.opacity !== '0' && part.visibility !== 'hidden' && part.display !== 'none' && !part.hidden;
  if (!shown(heading) || !shown(text)) return false;
  if (!String(heading.text).includes(title) || !String(text.text).includes(body)) return false;
  const paper = 'rgb(247, 246, 242)';
  const headingBg = heading.background === 'rgba(0, 0, 0, 0)' || heading.background === 'transparent' ? paper : heading.background;
  const textBg = text.background === 'rgba(0, 0, 0, 0)' || text.background === 'transparent' ? paper : text.background;
  return contrastRatio(heading.color, headingBg) >= 3 && contrastRatio(text.color, textBg) >= 3;
}
async function waitNoteVisible(id, title, body, label) {
  return until(async () => {
    if (!(await frame(id).count())) return false;
    const info = await nativePaint(id);
    return paintVisible(info, title, body) ? info : false;
  }, label);
}

const result = {
  native: true,
  fixture: 'deterministic MCP canvas/artifact batch; NOT a native host Agent run',
  hostAgent: 'NOT_CALLABLE',
  processRestart: false,
  checks: [],
  shots: [],
};
const pass = label => { result.checks.push(label); console.log('PASS ' + label); };
async function shot(name) {
  await page.screenshot({ path: path.join(output, name), animations: 'disabled' });
  result.shots.push(name);
}

async function platformFonts() {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#settings-open' });
    if (!nodeId) return { status: 'NOT_OBSERVED', reason: 'settings button missing' };
    const fonts = await session.send('CSS.getPlatformFontsForNode', { nodeId });
    return { status: 'observed', fonts };
  } catch (error) {
    return { status: 'NOT_OBSERVED', reason: String(error) };
  }
}

function geom(item) {
  return { x: item.x, y: item.y, width: item.width, height: item.height, z: item.z };
}

try {
  await page.locator('#locale').selectOption('zh-CN');
  if (await page.locator('#mode-focus').isVisible()) await page.locator('#mode-focus').click();
  await toolbar.waitFor();
  await page.evaluate(async () => {
    await document.fonts.load('500 13px "Noto Sans SC"', '画布设置');
    await document.fonts.ready;
  });

  if (process.argv.includes('--verify-restart')) {
    const saved = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
    await clickToolbar('查看全部');
    const current = await board();
    assert.deepEqual(current.canvas.objects, saved.expected.objects);
    assert.deepEqual(current.canvas.items, saved.expected.items);
    assert.deepEqual(current.canvas.compositions ?? [], saved.expected.compositions ?? []);
    assert.deepEqual(current.replies, saved.expected.replies);
    const producer = current.canvas.objects.find(item => item.id === saved.ids.producer);
    const chart = current.canvas.objects.find(item => item.id === saved.ids.chart);
    assert.equal(geom(current.canvas.items.find(item => item.item_id === producer.id)).x, saved.geometry.producer.x);
    assert.equal(geom(current.canvas.items.find(item => item.item_id === chart.id)).width, saved.geometry.chart.width);
    assert.equal((await object('harbor-note')).content.text, '不被改写的说明');
    assert.equal((await object('harbor-note')).content.title, '旁注');
    const notePaint = await waitNoteVisible('harbor-note', '旁注', '不被改写的说明', 'restart note visible');
    result.restartNote = notePaint;
    await select(producer.id);
    let parameter = await openWork(producer.id);
    await until(async () => (await parameter.locator('#tide-value').textContent())?.trim() === String(saved.lastTide.toFixed(1)), 'restart tide');
    const native = await frame('harbor-value').locator('.canvas-native-bound-value').textContent();
    assert.equal(Number(native?.trim()), saved.lastTide);
    await select(saved.ids.chart);
    await until(async () => (await page.locator('#input').inputValue()) === saved.draftMarker, 'restart composer draft');
    result.processRestart = true;
    saved.processRestart = true;
    await shot('restart-verified.png');
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...saved, processRestart: true, restartNote: notePaint, checks: [...saved.checks, 'real process restart preserves objects, geometry, bindings, draft and visible note'] }, null, 2));
    console.log('PASS real process restart preserves objects, geometry, bindings, draft and visible note');
    await browser.close();
    process.exit(0);
  }

  const snapshot = await board();
  assert.equal(snapshot.canvas.objects.length, 0, 'fresh isolated database');
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'canvas-studio-check', version: '1' } });
  await rpc('notifications/initialized', {}, true);

  const parameterReply = await call('spellcast_artifact', {
    source_id: 'harbor-studio',
    source_label: '潮汐港 · 机制探索',
    reply_id: 'harbor-parameter',
    block_id: 'work',
    title: '潮位控制',
    directory: path.join(root, 'examples/linked-harbor/parameter'),
    entry: 'index.html',
    io: { inputs: {}, outputs: { tide: 'number' } },
  });
  const chartReply = await call('spellcast_artifact', {
    source_id: 'harbor-studio',
    source_label: '潮汐港 · 机制探索',
    reply_id: 'harbor-chart',
    block_id: 'work',
    title: '港湾示意图',
    directory: path.join(root, 'examples/linked-harbor/chart'),
    entry: 'index.html',
    io: { inputs: { tide: 'number' }, outputs: {} },
  });
  const published = await board();
  const producer = published.canvas.objects.find(item => item.content.type === 'reply' && item.content.id === parameterReply.id);
  const chartObject = published.canvas.objects.find(item => item.content.type === 'reply' && item.content.id === chartReply.id);
  const producerPose = published.canvas.items.find(item => item.item_id === producer.id);
  const chartPose = published.canvas.items.find(item => item.item_id === chartObject.id);
  const tideBinding = { from: { object_id: producer.id, block_id: 'work', port: 'tide' }, to: { block_id: 'work', port: 'tide' } };
  const nativeBinding = { from: { object_id: producer.id, block_id: 'work', port: 'tide' }, to: { block_id: null, port: 'text' } };
  const placed = await call('spellcast_canvas_batch', {
    source_id: 'harbor-studio',
    request_id: 'harbor-place',
    operations: [
      { op: 'place', id: producer.id, expected_revision: producerPose.revision, fields: { x: 96, y: 72, width: 200, height: 240 } },
      { op: 'place', id: chartObject.id, expected_revision: chartPose.revision, fields: { x: 340, y: 48, width: 720, height: 500 } },
      { op: 'create', id: 'harbor-value', content: { type: 'text', title: '潮位观察', text: '潮位读数' }, placement: { x: 1090, y: 72, width: 200, height: 160 }, bindings: [nativeBinding] },
      { op: 'create', id: 'harbor-note', content: { type: 'text', title: '旁注', text: '不被改写的说明' }, placement: { x: 1090, y: 260, width: 200, height: 140 } },
      { op: 'bind', id: chartObject.id, expected_revision: chartObject.content_revision, bindings: [tideBinding] },
    ],
    reads: [
      { kind: 'content', id: producer.id, revision: producer.content_revision },
      { kind: 'content', id: chartObject.id, revision: chartObject.content_revision },
    ],
  });
  assert.equal(placed.result.status, 'applied');
  await until(async () => frame(producer.id).count() && frame(chartObject.id).count() && frame('harbor-value').count() && frame('harbor-note').count(), 'harbor frames');

  const placedBoard = await board();
  const geometry = {
    producer: geom(placedBoard.canvas.items.find(item => item.item_id === producer.id)),
    chart: geom(placedBoard.canvas.items.find(item => item.item_id === chartObject.id)),
    value: geom(placedBoard.canvas.items.find(item => item.item_id === 'harbor-value')),
    note: geom(placedBoard.canvas.items.find(item => item.item_id === 'harbor-note')),
  };
  assert.equal(geometry.producer.x, 96);
  assert.equal(geometry.producer.width, 200);
  assert.equal(geometry.producer.height, 240);

  let parameter = await openWork(producer.id);
  await until(async () => (await parameter.locator('#tide-value').textContent())?.trim() === '8.0', 'default tide 8');
  await until(async () => {
    const chart = await artifactFrame(chartObject.id);
    const reading = await chart.locator('#reading').textContent();
    const native = await frame('harbor-value').locator('.canvas-native-bound-value').textContent();
    return reading?.includes('8.0') && Number(native?.trim()) === 8;
  }, 'chart and native show 8');
  pass('authored harbor sample binds parameter to map and native value');

  await page.setViewportSize({ width: 1320, height: 860 });
  await done();
  await clickToolbar('查看全部');
  await page.evaluate(() => document.querySelector('.canvas-graph')?.focus());
  const blank = await page.locator('.canvas-graph').boundingBox();
  if (blank) await page.mouse.click(blank.x + 140, blank.y + blank.height - 90);
  await page.keyboard.press('Escape');
  await until(async () => page.locator('.canvas-tool-selection').evaluate(node => node.hidden), 'no selection dock');
  await shot('no-selection.png');

  const chrome = await page.evaluate(() => {
    const more = document.querySelector('.top-more');
    const visible = id => {
      const node = document.querySelector(id);
      if (!node) return false;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 2 && box.height > 2;
    };
    return {
      compact: more?.classList.contains('is-compact'),
      open: more?.open,
      settings: visible('#settings-open'),
      memory: visible('#memory-open'),
      feedback: visible('#feedback-open'),
      composer: document.querySelector('.composer')?.getBoundingClientRect().height ?? 0,
    };
  });
  assert.equal(chrome.compact, false, '1320 top-more should not be compact');
  assert.equal(chrome.settings, true, '1320 Settings missing');
  assert.equal(chrome.memory, true, '1320 Memory missing');
  assert.equal(chrome.feedback, true, '1320 Feedback missing');
  assert(chrome.composer >= 88 && chrome.composer <= 110, 'composer height ' + chrome.composer);
  result.composerHeight = chrome.composer;
  result.platformFonts = await platformFonts();
  pass('1320 Settings/Memory/Feedback are visible and composer is 90–105px');

  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => !node.hidden), 'settings open');
  await shot('dialog-settings.png');
  await page.locator('#settings-close').click();
  await until(() => page.locator('#settings').evaluate(node => node.hidden), 'settings closed');
  await page.locator('#memory-open').click();
  await until(() => page.locator('#memory-dialog').evaluate(node => node.open), 'memory open');
  await shot('dialog-memory.png');
  await page.keyboard.press('Escape');
  await until(() => page.locator('#memory-dialog').evaluate(node => !node.open), 'memory closed');
  await page.locator('#feedback-open').click();
  await until(() => page.locator('#feedback-dialog').evaluate(node => node.open), 'feedback open');
  await shot('dialog-feedback.png');
  await page.locator('#feedback-dialog [data-close]').click();
  await until(() => page.locator('#feedback-dialog').evaluate(node => !node.open), 'feedback closed');
  pass('1320 opens and closes Settings, Memory and Feedback');

  await page.locator('#view-ideas').click();
  await until(() => page.evaluate(() => !document.body.classList.contains('view-replies')), 'ideas view');
  const ideasChrome = await page.evaluate(() => ({
    settings: !!document.querySelector('#settings-open')?.getBoundingClientRect().width,
    memory: !!document.querySelector('#memory-open')?.getBoundingClientRect().width,
    compact: document.querySelector('.top-more')?.classList.contains('is-compact'),
  }));
  assert.equal(ideasChrome.compact, false);
  assert(ideasChrome.settings && ideasChrome.memory, 'ideas view lost top entries');
  await page.locator('#view-replies').click();
  await toolbar.waitFor();
  pass('Idea layouts keeps Settings/Memory/Feedback');

  await select(chartObject.id);
  const selectionUi = await page.evaluate(() => {
    const dock = document.querySelector('.canvas-tool-selection');
    const head = document.querySelector('.canvas-frame.is-plain.is-selected > .canvas-frame-head');
    const dockBox = dock?.getBoundingClientRect();
    const headStyle = head ? getComputedStyle(head) : null;
    const primary = document.querySelector('.canvas-tool-primary');
    const primaryStyle = primary ? getComputedStyle(primary) : null;
    return {
      dockHidden: dock?.hidden ?? true,
      dock: dockBox ? { x: dockBox.x, y: dockBox.y, w: dockBox.width, h: dockBox.height } : null,
      headPointer: headStyle?.pointerEvents,
      headClip: head ? { w: head.getBoundingClientRect().width, h: head.getBoundingClientRect().height, opacity: headStyle.opacity } : null,
      primary: primaryStyle ? { color: primaryStyle.color, background: primaryStyle.backgroundColor, size: primaryStyle.fontSize } : null,
      title: document.querySelector('.canvas-tool-selection-title')?.textContent,
      focus: document.activeElement?.className,
    };
  });
  assert.equal(selectionUi.dockHidden, false);
  const railBox = await page.locator('.canvas-tool-rail').boundingBox();
  const workspaceBox = await page.locator('.canvas-workspace').boundingBox();
  const selectedBox = await frame(chartObject.id).boundingBox();
  assert(railBox && workspaceBox && selectedBox);
  assert(selectionUi.dock.x >= railBox.x + railBox.width - 8, 'dock should sit to the right of the rail');
  assert(selectionUi.dock.x <= railBox.x + railBox.width + 40, 'dock left ' + selectionUi.dock.x + ' rail ' + railBox.x);
  assert(selectionUi.dock.y >= workspaceBox.y && selectionUi.dock.y <= workspaceBox.y + 28, 'dock top ' + selectionUi.dock.y);
  assert(Math.abs(selectionUi.dock.y - selectedBox.y) > 20, 'dock should not follow the selected object');
  assert.equal(selectionUi.headPointer, 'none');
  assert(selectionUi.headClip.w <= 2 && selectionUi.headClip.h <= 2, 'plain head still visible');
  assert.equal(selectionUi.primary.size, '13px');
  result.selectionUi = selectionUi;
  await shot('selection.png');
  await shot('zh-desktop.png');
  pass('one fixed selection dock; plain frame head is not a second toolbar');

  await page.keyboard.press('Enter');
  await until(() => frame(chartObject.id).evaluate(node => node.classList.contains('is-active')), 'chart active');
  await shot('active.png');
  await clickToolbar('返回画布');
  await until(() => frame(chartObject.id).evaluate(node => !node.classList.contains('is-active')), 'chart inactive');
  pass('Work inside and Done round-trip');

  const uiFont = await page.evaluate(() => {
    const button = document.querySelector('.canvas-tool-selection button');
    const style = button ? getComputedStyle(button) : getComputedStyle(document.body);
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  assert.equal(uiFont.overflowX, false, 'horizontal overflow at 1320');
  assert.equal(uiFont.size, '13px');
  assert.equal(['500', '600'].includes(uiFont.weight), true, 'UI weight ' + uiFont.weight);
  assert.match(uiFont.family, /Noto Sans SC|Microsoft YaHei/);
  pass('1320 chrome uses 13px/500 Chinese sans and does not overflow');

  parameter = await openWork(producer.id);
  const parameterLayout = await parameter.evaluate(() => {
    const box = el => {
      const rect = el.getBoundingClientRect();
      return { text: el.textContent?.trim(), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    return {
      body: box(document.body),
      title: box(document.querySelector('h1')),
      slider: box(document.querySelector('#tide-slider')),
      scale: box(document.querySelector('.scale')),
    };
  });
  result.parameterLayout = parameterLayout;
  assert(parameterLayout.title.h > 8 && parameterLayout.slider.w > 40 && parameterLayout.scale.h > 6, 'parameter internals clipped');
  await parameter.getByLabel('Tide level').fill('3');
  await parameter.getByLabel('Tide level').press('Tab');
  await until(async () => {
    const chart = await artifactFrame(chartObject.id);
    const reading = await chart.locator('#reading').textContent();
    const native = await frame('harbor-value').locator('.canvas-native-bound-value').textContent();
    return (await parameter.locator('#tide-value').textContent())?.trim() === '3.0'
      && reading?.includes('3.0') && Number(native?.trim()) === 3;
  }, 'slider 3 reaches map and native');
  pass('real slider updates water reading and native value');

  await done();
  await clickToolbar('查看全部');
  const overlap = await page.evaluate(id => {
    const rail = document.querySelector('.canvas-tool-rail')?.getBoundingClientRect();
    const dock = document.querySelector('.canvas-tool-selection')?.getBoundingClientRect();
    const param = document.querySelector('.canvas-frame[data-item-id="' + id + '"]')?.getBoundingClientRect();
    const graph = document.querySelector('.canvas-graph')?.getBoundingClientRect();
    const hit = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    return { rail, dock, param, graph, railHits: hit(rail, param), dockHits: hit(dock, param) };
  }, producer.id);
  result.parameterOverlap = overlap;
  assert.equal(overlap.railHits, false, 'left rail covers parameter');
  const afterFit = await board();
  assert.equal(geom(afterFit.canvas.items.find(item => item.item_id === producer.id)).x, 96);
  assert.equal(geom(afterFit.canvas.items.find(item => item.item_id === producer.id)).y, 72);
  assert.equal(geom(afterFit.canvas.items.find(item => item.item_id === chartObject.id)).width, 720);
  pass('parameter stays at authored geometry and sits in the usable view');

  const chart = await openWork(chartObject.id);
  await workClick(chart, '#gate-hit');
  await until(async () => {
    const block = (await board()).replies.find(item => item.id === chartReply.id)?.blocks.find(item => item.id === 'work');
    return block?.state?.selection?.id === 'gate' || block?.state?.selected === 'gate';
  }, 'gate selection');
  await shot('selected-or-active.png');
  pass('map gate selection is a real work anchor');

  await done();
  await page.locator('#input').fill('闸口在低潮是否保持关闭？');
  assert.match(await page.locator('#input').inputValue(), /低潮/);
  pass('composer accepts a draft sentence');

  const beforeMove = await board();
  const notePose = beforeMove.canvas.items.find(item => item.item_id === 'harbor-note');
  const valuePose = beforeMove.canvas.items.find(item => item.item_id === 'harbor-value');
  async function drag(id, dx, dy) {
    const box = await frame(id).locator('.canvas-card-drag').boundingBox();
    assert(box);
    const x = box.x + Math.min(box.width / 2, 80), y = box.y + Math.min(box.height / 2, 40);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.mouse.up();
  }
  await select('harbor-note');
  await drag('harbor-note', 40, 30);
  await select('harbor-value');
  await drag('harbor-value', 20, 40);
  await until(async () => {
    const now = await board();
    const note = now.canvas.items.find(item => item.item_id === 'harbor-note');
    const value = now.canvas.items.find(item => item.item_id === 'harbor-value');
    return note.x !== notePose.x && value.y !== valuePose.y;
  }, 'moved two objects');
  const afterMove = await board();
  assert.equal(afterMove.canvas.objects.find(item => item.id === 'harbor-note').content.text, '不被改写的说明');
  assert.equal(afterMove.canvas.objects.find(item => item.id === chartObject.id).id, chartObject.id);
  const chartGeom = afterMove.canvas.items.find(item => item.item_id === chartObject.id);
  const chartBefore = beforeMove.canvas.items.find(item => item.item_id === chartObject.id);
  assert.equal(chartGeom.x, chartBefore.x);
  assert.equal(chartGeom.width, chartBefore.width);

  await clickToolbar('层级');
  await page.locator('.canvas-layer-row[data-item-id="harbor-note"] .canvas-layer-pick').click();
  await page.locator('.canvas-layer-row[data-item-id="harbor-value"] .canvas-layer-pick').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Escape');
  await clickToolbar('组合');
  await until(async () => (await board()).canvas.compositions?.length >= 1, 'grouped');
  const groupId = (await board()).canvas.compositions[0].id;
  await clickToolbar('层级');
  await page.locator('.canvas-layer-row[data-composition-id="' + groupId + '"] .canvas-layer-pick').click();
  await page.keyboard.press('Escape');
  await clickToolbar('解组');
  await until(async () => !(await board()).canvas.compositions?.length, 'ungrouped');
  assert.equal((await object('harbor-note')).content.text, '不被改写的说明');
  pass('two objects move, group and ungroup without rewriting other identities');

  await clickToolbar('层级');
  await page.locator('.canvas-layers').waitFor();
  await shot('layers-or-connections.png');
  await page.locator('.canvas-layers').getByRole('button', { name: '关闭', exact: true }).click();
  await select(chartObject.id);
  await clickToolbar('数据连接');
  await page.locator('.canvas-connections').waitFor();
  await page.locator('.canvas-connections').getByRole('button', { name: '关闭', exact: true }).click();
  await toolbar.locator('.canvas-tool-more > summary').click();
  await toolbar.locator('.canvas-tool-menu button').last().waitFor();
  await page.keyboard.press('Escape');
  pass('Layers, Connections and More remain reachable');

  const edges = await page.evaluate(() => [...document.querySelectorAll('.x6-edge')].map(edge => ({
    id: edge.getAttribute('data-cell-id'),
    stroke: edge.querySelector('path')?.getAttribute('stroke') || getComputedStyle(edge.querySelector('path') || edge).stroke,
  })));
  result.edges = edges;
  assert(edges.some(edge => (edge.id || '').startsWith('data:') || (edge.stroke || '').includes('42, 138, 120') || (edge.stroke || '').includes('#2a8a78') || (edge.stroke || '').toLowerCase().includes('rgb')), 'missing real data edges');
  pass('real connection edges are present for authored bindings');

  const chromeBefore = await toolbar.locator('.canvas-tool-selection button').first().evaluate(node => getComputedStyle(node).fontSize);
  await clickToolbar('缩小');
  await clickToolbar('缩小');
  await clickToolbar('缩小');
  const chromeAfter = await toolbar.locator('.canvas-tool-selection button').first().evaluate(node => getComputedStyle(node).fontSize);
  assert.equal(chromeAfter, chromeBefore);
  assert.equal(chromeAfter, '13px');
  await shot('zoom-far.png');
  pass('host chrome type size is independent of world zoom');

  const removedId = 'harbor-note';
  const noteGeomBeforeRemove = geom(await pose(removedId));
  await select(removedId);
  await page.keyboard.press('Delete');
  await until(async () => (await pose(removedId)).removed, 'removed note');
  await clickToolbar('已移除');
  await page.locator('.canvas-removed [data-item-id="' + removedId + '"]').getByRole('button', { name: '恢复到画布', exact: true }).click();
  await until(async () => !(await pose(removedId)).removed, 'restored note');
  assert.equal((await object(removedId)).content.text, '不被改写的说明');
  assert.equal((await object(removedId)).id, 'harbor-note');
  const restoredGeom = geom(await pose(removedId));
  assert.equal(restoredGeom.x, noteGeomBeforeRemove.x);
  assert.equal(restoredGeom.y, noteGeomBeforeRemove.y);
  assert.equal(restoredGeom.width, noteGeomBeforeRemove.width);
  assert.equal(restoredGeom.height, noteGeomBeforeRemove.height);
  result.restoredNote = await waitNoteVisible(removedId, '旁注', '不被改写的说明', 'restored note heading and text visible');
  await select(removedId);
  await shot('restore-note.png');
  pass('remove and restore keep identity, geometry and visible 旁注 text');

  await page.setViewportSize({ width: 1000, height: 700 });
  await done();
  await clickToolbar('查看全部');
  const compact = await until(async () => page.evaluate(() => {
    const more = document.querySelector('.top-more');
    const box = el => {
      const node = document.querySelector(el);
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2 && getComputedStyle(node).display !== 'none';
    };
    return more?.classList.contains('is-compact') && !box('#settings-open') ? more : null;
  }), '1000 compact more');
  await page.locator('.top-more > summary').click();
  await until(() => page.locator('#settings-open').isVisible(), 'more menu open');
  await shot('more-open.png');
  await page.keyboard.press('Escape');
  await until(() => page.evaluate(() => !document.querySelector('.top-more')?.open), 'more closed by Escape');
  const moreFocus = await page.evaluate(() => document.activeElement?.closest('.top-more')?.tagName || document.activeElement?.tagName);
  result.moreEscape = { focus: moreFocus };
  const desktop = page.getByRole('button', { name: '回到桌面', exact: true });
  assert.equal(await desktop.isVisible(), true, 'desktop entry missing at 1000');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  result.narrowNote = await waitNoteVisible('harbor-note', '旁注', '不被改写的说明', 'narrow restored note still visible');
  await select('harbor-note');
  await shot('narrow-note-focused.png');
  await done();
  await clickToolbar('查看全部');
  const fitIds = [producer.id, chartObject.id, 'harbor-value', 'harbor-note'];
  let previousRects = null;
  result.narrowFit = await until(async () => {
    const now = await page.evaluate(ids => ids.map(id => {
      const node = document.querySelector('.canvas-frame[data-item-id="' + id + '"]');
      const box = node?.getBoundingClientRect();
      return box ? { id, x: box.x, y: box.y, w: box.width, h: box.height } : null;
    }), fitIds);
    if (now.some(item => !item || item.w < 8 || item.h < 8)) return false;
    if (previousRects && now.every((item, index) => {
      const before = previousRects[index];
      return Math.abs(item.x - before.x) < 1 && Math.abs(item.y - before.y) < 1 && Math.abs(item.w - before.w) < 1 && Math.abs(item.h - before.h) < 1;
    })) return now;
    previousRects = now;
    return false;
  }, 'narrow fit rects stable');
  await shot('zh-narrow.png');
  const narrowLayout = await page.evaluate(ids => {
    const box = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, right: rect.right, bottom: rect.bottom };
    };
    const workspace = box(document.querySelector('.canvas-workspace'));
    const rail = box(document.querySelector('.canvas-tool-rail'));
    const composer = box(document.querySelector('.composer'));
    const usable = {
      left: rail.right,
      top: workspace.y + 52,
      right: workspace.right,
      bottom: composer ? composer.y : workspace.bottom,
    };
    const hit = (a, b) => a && b && a.w > 1 && b.w > 1 && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const inside = (rect, slop = 8) => rect && rect.x + slop >= usable.left && rect.y + slop >= usable.top
      && rect.right - slop <= usable.right && rect.bottom - slop <= usable.bottom && rect.w > 8 && rect.h > 8;
    const frames = Object.fromEntries(ids.map(([name, id]) => [name, box(document.querySelector('.canvas-frame[data-item-id="' + id + '"]'))]));
    return {
      usable, rail, workspace, composer,
      ...frames,
      inUsable: {
        parameter: inside(frames.parameter),
        chart: inside(frames.chart),
        value: inside(frames.value),
        note: inside(frames.note),
      },
      railHitsParameter: hit(rail, frames.parameter),
    };
  }, [['parameter', producer.id], ['chart', chartObject.id], ['value', 'harbor-value'], ['note', 'harbor-note']]);
  result.narrowLayout = narrowLayout;
  assert.equal(narrowLayout.inUsable.parameter, true, 'parameter outside usable canvas at 1000');
  assert.equal(narrowLayout.inUsable.chart, true, 'map outside usable canvas at 1000');
  assert.equal(narrowLayout.inUsable.value, true, 'tide value outside usable canvas at 1000');
  assert.equal(narrowLayout.inUsable.note, true, 'note outside usable canvas at 1000');
  assert.equal(narrowLayout.railHitsParameter, false, 'left rail covers parameter at 1000');
  result.narrowNoteAfterFit = await waitNoteVisible('harbor-note', '旁注', '不被改写的说明', 'fit-all note still shows title and body');
  pass('1000 More holds Settings/Memory/Feedback; Escape closes it; restored note text stays visible');
  pass('1000 fit-all keeps parameter, map and native objects in the usable canvas');

  await page.setViewportSize({ width: 1320, height: 860 });
  await until(() => page.evaluate(() => {
    const more = document.querySelector('.top-more');
    const settings = document.querySelector('#settings-open')?.getBoundingClientRect();
    return !more?.classList.contains('is-compact') && settings && settings.width > 2;
  }), 'wide top entries restored');
  await shot('wide-restored.png');
  pass('restoring the wide viewport shows Settings/Memory/Feedback again');

  await page.locator('#mode-desktop').click();
  await until(() => page.evaluate(() => document.body.classList.contains('mode-ambient')), 'ambient');
  const ambient = await page.evaluate(() => ({
    settings: document.querySelector('#settings-open')?.getBoundingClientRect().width > 2,
    memory: document.querySelector('#memory-open')?.getBoundingClientRect().width > 2,
    feedback: document.querySelector('#feedback-open')?.getBoundingClientRect().width > 2,
    compact: document.querySelector('.top-more')?.classList.contains('is-compact'),
  }));
  assert.equal(ambient.compact, false);
  assert(ambient.settings && ambient.memory && ambient.feedback, 'ambient lost top entries');
  await page.locator('#mode-focus').click();
  await toolbar.waitFor();
  pass('ambient mode keeps Settings/Memory/Feedback');

  const final = await board();
  result.expected = {
    objects: final.canvas.objects,
    items: final.canvas.items,
    compositions: final.canvas.compositions,
    replies: final.replies,
  };
  result.ids = { producer: producer.id, chart: chartObject.id, note: 'harbor-note', value: 'harbor-value' };
  result.geometry = {
    producer: geom(final.canvas.items.find(item => item.item_id === producer.id)),
    chart: geom(final.canvas.items.find(item => item.item_id === chartObject.id)),
    note: geom(final.canvas.items.find(item => item.item_id === 'harbor-note')),
    value: geom(final.canvas.items.find(item => item.item_id === 'harbor-value')),
  };
  assert.equal(result.geometry.producer.x, 96);
  assert.equal(result.geometry.producer.y, 72);
  assert.equal(result.geometry.producer.width, 200);
  assert.equal(result.geometry.producer.height, 240);
  result.lastTide = 3;
  const draftMarker = '闸口在低潮是否保持关闭？';
  await page.locator('#input').fill(draftMarker);
  result.draftMarker = await page.locator('#input').inputValue();
  assert.equal(result.draftMarker, draftMarker);
  assert.notEqual(result.draftMarker.trim(), '');
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.checks));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failed.png'), animations: 'disabled' }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ ...result, error: String(error), stack: error.stack }, null, 2));
  throw error;
} finally {
  await browser.close();
}
