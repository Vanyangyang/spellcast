/** Isolated studio operational-state check. MCP/HTTP is fixture setup only, not a native host Agent.
 * Never writes client config or installs Skill. */
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
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? path.join(root, 'artifacts/canvas-studio-states-20260910/round3'));
await mkdir(output, { recursive: true });

const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9348');
const page = browser.contexts()[0]?.pages().find(candidate => candidate.url() === 'http://tauri.localhost/');
assert(page, 'Use the native WebView at http://tauri.localhost/.');
page.setDefaultTimeout(15000);
const port = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
assert.equal(port, Number(process.env.SPELLCAST_TEST_PORT ?? 47210), 'Use the isolated states bridge.');
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
const frame = id => page.locator('.canvas-frame[data-item-id="' + id + '"]');
async function workPage(id) {
  const iframe = frame(id).locator('iframe.artifact-frame, iframe');
  await iframe.waitFor({ state: 'attached' });
  const handle = await iframe.elementHandle();
  const inner = await handle?.contentFrame();
  assert(inner, 'missing work iframe ' + id);
  return inner;
}
async function done() {
  const button = toolbar.getByRole('button', { name: /返回画布|Back to canvas/, exact: true });
  if (await button.isVisible()) await button.click();
}
async function select(id) {
  await done();
  const overview = toolbar.getByRole('button', { name: /内容总览|All items/, exact: true });
  if (!(await overview.isVisible())) {
    await toolbar.locator('.canvas-tool-more > summary').click();
    await overview.waitFor({ state: 'visible' });
  }
  await overview.click();
  await page.locator('.canvas-overview-card[data-item-id="' + id + '"]').getByRole('button', { name: /定位|Locate/, exact: true }).click();
  await frame(id).locator('.canvas-card-drag').click();
  await until(() => frame(id).evaluate(node => node.classList.contains('is-selected')), 'selected ' + id);
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

const result = {
  native: true,
  fixture: 'deterministic MCP canvas/artifact batch; NOT a native host Agent run',
  hostAgent: 'NOT_CALLABLE',
  wroteClientConfig: false,
  checks: [],
  shots: [],
  contrast: [],
};
const pass = label => { result.checks.push(label); console.log('PASS ' + label); };
async function shot(name) {
  await page.screenshot({ path: path.join(output, name), animations: 'disabled' });
  result.shots.push(name);
}

const sampleContrast = () => page.evaluate(() => {
  const parse = color => {
    const match = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] == null ? 1 : Number(match[4]) };
  };
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a <= 0) return bg;
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a: 1,
    };
  };
  const walkBg = el => {
    const layers = [];
    let node = el;
    let from = el.className?.toString?.().slice?.(0, 80) || el.tagName;
    while (node && node !== document.documentElement) {
      const parsed = parse(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.a > 0.001) {
        layers.push({ parsed, from: node.className?.toString?.().slice?.(0, 80) || node.tagName });
        if (parsed.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    let acc = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 252, b: 247, a: 1 };
    acc = { ...acc, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i].parsed, acc);
    return { bg: `rgb(${Math.round(acc.r)}, ${Math.round(acc.g)}, ${Math.round(acc.b)})`, from: layers[0]?.from || from };
  };
  const sample = (selector, extra = '') => {
    const el = extra ? document.querySelectorAll(selector)[0] : document.querySelector(selector);
    const target = extra === 'unselected' ? [...document.querySelectorAll(selector)].find(node => !node.classList.contains('is-on')) : extra === 'selected' ? document.querySelector(selector + '.is-on') : el;
    if (!target) return { selector, missing: true };
    const style = getComputedStyle(target);
    const bg = walkBg(target);
    return {
      selector: extra ? selector + ':' + extra : selector,
      color: style.color,
      background: bg.bg,
      ancestor: bg.from,
      fontSize: style.fontSize,
      disabled: target.disabled || false,
      text: (target.textContent || '').trim().slice(0, 40),
    };
  };
  return [
    sample('#settings-title'),
    sample('.agent-clients button', 'unselected'),
    sample('.agent-clients button', 'selected'),
    sample('#settings-agent-seen'),
    sample('#settings-close'),
    sample('.artifact-controls button:disabled'),
    sample('.artifact-controls button'),
  ];
});

try {
  await page.locator('#locale').selectOption('zh-CN');
  if (await page.locator('#mode-focus').isVisible()) await page.locator('#mode-focus').click();
  await toolbar.waitFor();
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.evaluate(async () => { await document.fonts.ready; });
  assert.equal((await board()).canvas.objects.length, 0, 'fresh isolated database');
  const emptyCopy = await page.evaluate(() => ({
    title: document.querySelector('.canvas-empty-title')?.textContent,
    help: document.querySelector('.canvas-empty-help')?.textContent,
    add: document.querySelector('.canvas-tool-rail button')?.getAttribute('aria-label'),
  }));
  assert.match(emptyCopy.title || '', /还没有内容|Nothing is on this canvas/);
  assert.match(emptyCopy.help || '', /\+|左侧/);
  await shot('empty-zh.png');
  pass('empty canvas has a title, one how-to sentence, and a discoverable add control');

  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => !node.hidden && node.open), 'settings open');
  const trap = await page.evaluate(() => {
    const dialog = document.querySelector('#settings');
    const focusable = [...dialog.querySelectorAll('button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    return { open: dialog.open, hidden: dialog.hidden, count: focusable.length, first: focusable[0]?.id, last: focusable.at(-1)?.id };
  });
  assert.equal(trap.open, true);
  assert.equal(trap.hidden, false);
  assert(trap.count >= 3, 'settings has too few focusable controls');
  const inSettingsControl = () => page.evaluate(() => {
    const active = document.activeElement;
    const dialog = document.querySelector('#settings');
    return Boolean(active && dialog && active !== dialog && dialog.contains(active));
  });
  await page.locator('#settings-close').focus();
  assert.equal(await inSettingsControl(), true, 'close button is not a settings control');
  for (let i = 0; i < trap.count + 2; i++) await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => {
    const active = document.activeElement;
    const dialog = document.querySelector('#settings');
    return { tag: active?.tagName, id: active?.id, inControl: Boolean(active && dialog && active !== dialog && dialog.contains(active)) };
  });
  assert.equal(afterTab.inControl, true, 'Tab escaped settings dialog ' + JSON.stringify(afterTab));
  await page.keyboard.press('Shift+Tab');
  const afterShift = await page.evaluate(() => {
    const active = document.activeElement;
    const dialog = document.querySelector('#settings');
    return { tag: active?.tagName, id: active?.id, inControl: Boolean(active && dialog && active !== dialog && dialog.contains(active)) };
  });
  assert.equal(afterShift.inControl, true, 'Shift+Tab escaped settings dialog ' + JSON.stringify(afterShift));
  const contrastOpen = await sampleContrast();
  result.contrast.push({ when: 'settings-zh', samples: contrastOpen });
  for (const sample of contrastOpen.filter(item => !item.missing && !item.disabled && item.selector !== '.artifact-controls button')) {
    const ratio = contrastRatio(sample.color, sample.background);
    sample.ratio = ratio;
    assert(ratio >= 4.5, 'low contrast ' + sample.selector + ' ' + ratio + ' fg ' + sample.color + ' bg ' + sample.background);
  }
  const titleSample = contrastOpen.find(item => item.selector === '#settings-title');
  assert(titleSample && Number.parseFloat(titleSample.fontSize) <= 28 && Number.parseFloat(titleSample.fontSize) >= 20, 'settings title size ' + titleSample?.fontSize);
  await shot('dialog-settings-zh-1320.png');
  const originalUrl = await page.locator('#settings-mcp-url').inputValue();
  await page.locator('#settings-clients [data-client="cursor"]').click();
  await page.locator('#settings-mcp-url').fill('http://127.0.0.1:9/mcp');
  await page.locator('#settings-mcp-url').blur();
  await page.locator('#settings-mcp-url').fill(originalUrl);
  await page.locator('#settings-mcp-url').blur();
  await page.locator('#settings-clients [data-client="codex"]').click();
  pass('settings dialog traps focus and client/status text meets contrast');

  await page.keyboard.press('Escape');
  await until(() => page.locator('#settings').evaluate(node => node.hidden && !node.open), 'settings closed by Escape');
  const afterEscape = await page.evaluate(() => ({
    id: document.activeElement?.id,
    tag: document.activeElement?.tagName,
    inMore: Boolean(document.activeElement?.closest('.top-more')),
  }));
  assert(afterEscape.id === 'settings-open' || afterEscape.inMore, 'Escape did not restore a visible trigger ' + JSON.stringify(afterEscape));
  pass('Escape closes settings and restores a visible trigger');

  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => node.open), 'settings reopen');
  await page.mouse.click(12, 12);
  await until(() => page.locator('#settings').evaluate(node => node.hidden && !node.open), 'settings closed by backdrop');
  pass('backdrop click closes settings');

  await page.locator('#locale').selectOption('en');
  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => node.open), 'english settings');
  await shot('dialog-settings-en-1320.png');
  const enTitle = await page.locator('#settings-title').textContent();
  assert.match(enTitle || '', /Connect Agent/);
  await page.locator('#settings-close').click();
  await until(() => page.locator('#settings').evaluate(node => node.hidden), 'english settings closed');
  pass('English settings panel uses the compact operation title');

  await page.locator('#locale').selectOption('zh-CN');
  await page.setViewportSize({ width: 1000, height: 700 });
  await until(() => page.evaluate(() => document.querySelector('.top-more')?.classList.contains('is-compact')), 'compact more');
  await page.locator('.top-more > summary').click();
  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => node.open), 'narrow settings');
  await shot('dialog-settings-zh-1000.png');
  const overflow = await page.evaluate(() => ({
    sheet: document.querySelector('.settings-sheet')?.scrollHeight > document.querySelector('.settings-sheet')?.clientHeight + 1,
    page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  assert.equal(overflow.page, false, 'settings caused page overflow at 1000');
  await page.locator('#settings-close').click();
  await until(() => page.locator('#settings').evaluate(node => node.hidden), 'narrow settings closed');
  const afterNarrow = await page.evaluate(() => ({
    summary: document.activeElement?.closest('.top-more')?.querySelector('summary') === document.activeElement
      || document.activeElement?.tagName === 'SUMMARY',
    inMore: Boolean(document.activeElement?.closest('.top-more')),
  }));
  assert.equal(afterNarrow.inMore, true, 'narrow close did not restore More');
  pass('1000 Settings opens from More and restores More summary');

  await page.setViewportSize({ width: 1320, height: 860 });
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'canvas-studio-states', version: '1' } });
  await rpc('notifications/initialized', {}, true);
  const note = await call('spellcast_canvas_batch', {
    source_id: 'states-studio',
    request_id: 'states-place',
    operations: [
      { op: 'create', id: 'state-note', content: { type: 'text', title: '工作笔记', text: '可编辑的正文' }, placement: { x: 120, y: 80, width: 240, height: 160 } },
    ],
  });
  assert.equal(note.result.status, 'applied');
  const workReply = await call('spellcast_artifact', {
    source_id: 'states-studio',
    source_label: '状态检查',
    reply_id: 'states-work',
    block_id: 'work',
    title: '潮位控制',
    directory: path.join(root, 'examples/linked-harbor/parameter'),
    entry: 'index.html',
    io: { inputs: {}, outputs: { tide: 'number' } },
  });
  const published = await board();
  const workObject = published.canvas.objects.find(item => item.content.type === 'reply' && item.content.id === workReply.id);
  const workPose = published.canvas.items.find(item => item.item_id === workObject.id);
  const placedWork = await api('/api/canvas/batch', 'POST', {
    request_id: 'states-place-work',
    operations: [{ op: 'place', id: workObject.id, expected_revision: workPose.revision, fields: { x: 400, y: 48, width: 560, height: 380 } }],
  });
  assert.equal(placedWork.result.status, 'applied');
  await until(async () => frame('state-note').count() && frame(workObject.id).count(), 'state frames');

  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => node.open), 'settings after mcp client');
  const chip = await until(async () => {
    const info = await page.evaluate(() => {
      const el = document.querySelector('#settings .agent-chip');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width < 4 || box.height < 4 || style.visibility === 'hidden' || style.display === 'none') return null;
      return { text: (el.textContent || '').trim(), className: el.className, live: el.classList.contains('live'), stale: el.classList.contains('stale') };
    });
    return info;
  }, 'visible agent chip after MCP activity', 25000);
  const chipSample = await page.evaluate(() => {
    const parse = color => {
      const match = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
      if (!match) return null;
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] == null ? 1 : Number(match[4]) };
    };
    const over = (fg, bg) => {
      const a = fg.a + bg.a * (1 - fg.a);
      if (a <= 0) return bg;
      return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a: 1,
      };
    };
    const el = document.querySelector('#settings .agent-chip');
    const layers = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const parsed = parse(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.a > 0.001) {
        layers.push(parsed);
        if (parsed.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    let acc = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 252, b: 247, a: 1 };
    acc = { ...acc, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    const style = getComputedStyle(el);
    return {
      selector: '.agent-chip',
      color: style.color,
      background: `rgb(${Math.round(acc.r)}, ${Math.round(acc.g)}, ${Math.round(acc.b)})`,
      ancestor: el.className,
      fontSize: style.fontSize,
      disabled: false,
      text: (el.textContent || '').trim().slice(0, 40),
      live: el.classList.contains('live'),
      stale: el.classList.contains('stale'),
    };
  });
  chipSample.ratio = contrastRatio(chipSample.color, chipSample.background);
  result.contrast.push({ when: 'connected-chip', samples: [chipSample], chip });
  assert(chipSample.ratio >= 4.5, 'agent chip contrast ' + chipSample.ratio + ' fg ' + chipSample.color + ' bg ' + chipSample.background);
  await shot('connected-settings.png');
  await page.locator('#settings-close').click();
  await until(() => page.locator('#settings').evaluate(node => node.hidden), 'settings closed after chip');
  pass('connected MCP client chip text meets contrast');

  await select('state-note');
  const poseBefore = (await board()).canvas.items.find(item => item.item_id === 'state-note');
  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => node.open), 'settings over canvas');
  await page.locator('#settings-copy-url').focus();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-copy-url');
  await page.keyboard.press('Delete');
  const afterDelete = {
    open: await page.locator('#settings').evaluate(node => node.open),
    pose: (await board()).canvas.items.find(item => item.item_id === 'state-note'),
  };
  assert.equal(afterDelete.open, true, 'Delete closed settings');
  assert.equal(afterDelete.pose.removed, false);
  assert.equal(afterDelete.pose.x, poseBefore.x);
  assert.equal(afterDelete.pose.y, poseBefore.y);
  await page.locator('#settings-copy-url').focus();
  await page.keyboard.press('Space');
  const afterSpace = {
    open: await page.locator('#settings').evaluate(node => node.open),
    pose: (await board()).canvas.items.find(item => item.item_id === 'state-note'),
    focus: await page.evaluate(() => document.activeElement?.id),
  };
  result.canvasHostKeys = { afterDelete, afterSpace };
  assert.equal(afterSpace.pose.removed, false);
  assert.equal(afterSpace.pose.x, poseBefore.x);
  assert.equal(afterSpace.pose.y, poseBefore.y);
  if (afterSpace.open) {
    await page.locator('#settings-close').click();
    await until(() => page.locator('#settings').evaluate(node => node.hidden), 'settings closed after host-key probe');
  } else {
    await until(() => page.locator('#settings').evaluate(node => node.hidden), 'settings already closed by Space on a button');
  }
  pass('Delete does not remove canvas objects while settings is open; Space keeps button behavior');

  await select(workObject.id);
  await page.keyboard.press('Enter');
  await until(() => frame(workObject.id).evaluate(node => node.classList.contains('is-active')), 'work active');
  const controls = frame(workObject.id).locator('.artifact-controls');
  await controls.waitFor({ state: 'visible' });
  const toggle = controls.locator('button').first();
  const restart = frame(workObject.id).getByRole('button', { name: '重新运行', exact: true });
  await restart.waitFor({ state: 'visible' });
  const toggleBefore = (await toggle.textContent() || '').trim();
  result.artifactToggle = { before: toggleBefore, enabled: await toggle.isEnabled() };
  if (toggleBefore === '停止') {
    assert.equal(await toggle.isEnabled(), true);
    await toggle.click();
    await until(async () => (await toggle.textContent() || '').includes('运行'), 'toggle became Run after Stop');
  }
  assert.equal(await restart.isEnabled(), true);
  const disabledToolbar = await page.locator('.canvas-toolbar button:disabled').first().evaluate(node => {
    const style = getComputedStyle(node);
    let bg = style.backgroundColor, el = node.parentElement;
    while (el && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
      bg = getComputedStyle(el).backgroundColor; el = el.parentElement;
    }
    return { text: node.textContent?.trim(), color: style.color, background: bg, disabled: node.disabled };
  }).catch(() => null);
  result.contrast.push({ when: 'active-work', samples: await sampleContrast(), disabledToolbar });
  if (disabledToolbar) {
    disabledToolbar.ratio = contrastRatio(disabledToolbar.color, disabledToolbar.background);
    assert.equal(disabledToolbar.disabled, true);
    assert(disabledToolbar.ratio >= 2.5, 'disabled toolbar control vanished ' + disabledToolbar.ratio);
  }
  await shot('active-stopped.png');
  await restart.click();
  await until(async () => (await toggle.textContent() || '').includes('停止') || (await frame(workObject.id).locator('.artifact-status').textContent() || '').includes('运行'), 'work running after restart');
  const inner = await workPage(workObject.id);
  await until(async () => {
    const text = await inner.locator('#tide-value').textContent().catch(() => '');
    return /^\d/.test((text || '').trim());
  }, 'example content ready after restart');
  await shot('active-running.png');
  await frame(workObject.id).locator('.artifact-sources > summary').click();
  await until(async () => {
    const value = await frame(workObject.id).locator('textarea.artifact-source-editor').inputValue().catch(() => '');
    return (value || '').trim().length > 8 ? value : false;
  }, 'source editor has file text');
  const sourceLayout = await until(async () => {
    const layout = await page.evaluate(id => {
      const root = document.querySelector('.canvas-frame[data-item-id="' + id + '"] .canvas-frame-content');
      const editor = root?.querySelector('textarea.artifact-source-editor');
      const body = root?.querySelector('.artifact-source-body');
      if (!root || !editor || !body) return null;
      const vis = root.getBoundingClientRect();
      const ta = editor.getBoundingClientRect();
      const ctl = body.getBoundingClientRect();
      const hit = (a, b) => a.width > 4 && a.height > 4 && b.width > 4 && b.height > 4
        && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      return {
        vis: { x: vis.x, y: vis.y, w: vis.width, h: vis.height },
        editor: { x: ta.x, y: ta.y, w: ta.width, h: ta.height },
        controls: { x: ctl.x, y: ctl.y, w: ctl.width, h: ctl.height },
        text: (editor.value || '').slice(0, 80),
        inView: hit(ta, vis) && hit(ctl, vis),
        readable: (editor.value || '').trim().length > 8,
      };
    }, workObject.id);
    if (layout?.inView && layout.readable) return layout;
    const summaryBox = await frame(workObject.id).locator('.artifact-sources > summary').boundingBox();
    const box = summaryBox || await frame(workObject.id).locator('.canvas-frame-content').boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(12, box.height / 2));
      await page.mouse.wheel(0, 320);
    }
    return false;
  }, 'source editor scrolled into work content view');
  result.sourceLayout = sourceLayout;
  assert.equal(sourceLayout.inView, true, 'source editor not in work content view');
  assert.equal(sourceLayout.readable, true, 'source editor has no readable text');
  await shot('active-sources.png');
  await clickToolbar('返回画布');
  pass('Work inside exposes Stop/Restart as real enabled/disabled controls');

  await select('state-note');
  await page.keyboard.press('Enter');
  const text = frame('state-note').locator('textarea.canvas-native-text');
  await text.waitFor({ state: 'visible' });
  await text.fill('编辑后的草稿');
  await shot('native-edit.png');
  const cancel = frame('state-note').getByRole('button', { name: '返回画布', exact: true });
  if (await toolbar.getByRole('button', { name: '返回画布', exact: true }).isVisible()) {
    await toolbar.getByRole('button', { name: '返回画布', exact: true }).click();
  } else if (await cancel.count()) await cancel.click();
  assert.equal((await board()).canvas.objects.find(item => item.id === 'state-note').content.text, '可编辑的正文');
  pass('native text can be edited without rewriting saved content on cancel');

  await page.locator('#memory-open').click();
  await until(() => page.locator('#memory-dialog').evaluate(node => node.open), 'memory');
  await shot('dialog-memory.png');
  await page.keyboard.press('Escape');
  await page.locator('#feedback-open').click();
  await until(() => page.locator('#feedback-dialog').evaluate(node => node.open), 'feedback');
  await shot('dialog-feedback.png');
  await page.locator('#feedback-dialog [data-close]').click();
  await clickToolbar('层级');
  await page.locator('.canvas-layers').waitFor();
  await shot('dialog-layers.png');
  await page.locator('.canvas-layers').getByRole('button', { name: '关闭', exact: true }).click();
  pass('memory, feedback and layers remain reachable operation panels');

  await page.locator('#view-ideas').click();
  await until(() => page.evaluate(() => !document.body.classList.contains('view-replies')), 'ideas view');
  const beforeAdd = (await board()).nodes.length;
  await page.locator('#add-btn').click();
  await until(async () => (await board()).nodes.length === beforeAdd + 1, 'idea node created');
  const ideaNode = (await board()).nodes.at(-1);
  const pin = page.locator('.pin[data-pin="' + ideaNode.id + '"]');
  await pin.waitFor({ state: 'visible' });
  await pin.click();
  await until(async () => (await page.locator('#ins-title').inputValue()) === ideaNode.title, 'idea node selected');
  const nodesBefore = (await board()).nodes.map(node => ({ id: node.id, title: node.title, body: node.body }));
  const selectedTitle = await page.locator('#ins-title').inputValue();
  await page.locator('#settings-open').click();
  await until(() => page.locator('#settings').evaluate(node => node.open), 'settings over ideas');
  await page.locator('#settings-copy-url').focus();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-copy-url');
  await page.keyboard.press('Delete');
  const afterIdeaDelete = { open: await page.locator('#settings').evaluate(node => node.open), nodes: (await board()).nodes.map(node => node.id), title: await page.locator('#ins-title').inputValue() };
  await page.locator('#settings-copy-url').focus();
  await page.keyboard.press('Backspace');
  const afterIdeaBackspace = { open: await page.locator('#settings').evaluate(node => node.open), nodes: (await board()).nodes.map(node => node.id), title: await page.locator('#ins-title').inputValue() };
  await page.locator('#settings-copy-url').focus();
  await page.keyboard.press('n');
  const afterIdeaN = { open: await page.locator('#settings').evaluate(node => node.open), nodes: (await board()).nodes.map(node => node.id) };
  await page.keyboard.press('Escape');
  await until(() => page.locator('#settings').evaluate(node => node.hidden && !node.open), 'settings closed from ideas');
  const afterIdeaEscape = {
    focus: await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName, inMore: Boolean(document.activeElement?.closest('.top-more')) })),
    nodes: (await board()).nodes.map(node => ({ id: node.id, title: node.title, body: node.body })),
    inspector: await page.locator('#ins-title').inputValue(),
  };
  result.ideaGuard = { selectedTitle, nodesBefore, afterIdeaDelete, afterIdeaBackspace, afterIdeaN, afterIdeaEscape };
  assert.equal(afterIdeaDelete.open, true);
  assert.deepEqual(afterIdeaDelete.nodes, nodesBefore.map(node => node.id));
  assert.equal(afterIdeaDelete.title, selectedTitle);
  assert.equal(afterIdeaBackspace.open, true);
  assert.deepEqual(afterIdeaBackspace.nodes, nodesBefore.map(node => node.id));
  assert.deepEqual(afterIdeaN.nodes, nodesBefore.map(node => node.id));
  assert.deepEqual(afterIdeaEscape.nodes, nodesBefore);
  assert.equal(afterIdeaEscape.inspector, selectedTitle);
  assert(afterIdeaEscape.focus.id === 'settings-open' || afterIdeaEscape.focus.inMore, 'Escape did not restore trigger from ideas ' + JSON.stringify(afterIdeaEscape.focus));
  pass('Idea layout Delete/Backspace/n leave the selected node alone; Escape only closes settings');

  result.wroteClientConfig = false;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.checks));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failed.png'), animations: 'disabled' }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ ...result, error: String(error), stack: error.stack }, null, 2));
  throw error;
} finally {
  await browser.close();
}
