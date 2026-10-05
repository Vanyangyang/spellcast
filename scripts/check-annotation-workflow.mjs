/** Focused annotation UI check with an isolated backend, Vite and browser profile. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = Number(process.env.SPELLCAST_ANNOTATION_API_PORT ?? 47382);
const webPort = Number(process.env.SPELLCAST_ANNOTATION_WEB_PORT ?? 47383);
assert(![47193, 47194].includes(apiPort) && ![47193, 47194].includes(webPort) && apiPort !== webPort, 'Use isolated ports.');
const api = `http://127.0.0.1:${apiPort}`;
const origin = `http://127.0.0.1:${webPort}`;
const state = await mkdtemp(path.join(tmpdir(), 'spellcast-annotation-'));
const serverExe = path.resolve(root, process.env.SPELLCAST_SERVER_EXE ?? 'target/debug/spellcast-server.exe');
for (const url of [`${api}/api/health`, origin]) assert(!(await fetch(url).catch(() => null))?.ok, `${url} is already occupied`);

const children = [];
let browser;
const waitFor = async (read, label, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await read(); if (value) return value; } catch { /* Wait for our processes. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not settle`);
};
const board = async () => {
  const response = await fetch(`${api}/api/board`);
  assert(response.ok, `board ${response.status}`);
  return response.json();
};
const batch = async (request) => {
  const response = await fetch(`${api}/api/canvas/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const value = await response.json();
  assert(response.ok && value.result?.status === 'applied', JSON.stringify(value));
  return value;
};

try {
  children.push(spawn(serverExe, [], { cwd: root, env: { ...process.env, SPELLCAST_PORT: String(apiPort), SPELLCAST_STATE_FILE: path.join(state, 'board.sqlite3') }, windowsHide: true, stdio: 'ignore' }));
  children.push(spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: root, env: { ...process.env, VITE_API_URL: api }, windowsHide: true, stdio: 'ignore' }));
  await waitFor(async () => (await fetch(`${api}/api/health`)).ok, 'isolated backend');
  await waitFor(async () => (await fetch(origin)).ok, 'isolated Vite');

  const block = { id: 'annotation-sequence', type: 'sequence', title: 'Annotation fixture', steps: [
    { id: 'first', title: 'First beat', action: 'Open the scene', feedback: '', note: '' },
    { id: 'second', title: 'Second beat', action: 'Close the scene', feedback: '', note: '' },
  ] };
  await batch({ request_id: 'annotation-create', operations: [{ op: 'create', id: 'annotation-object', content: { type: 'block', block }, placement: { x: 60, y: 60, width: 620, height: 520 } }] });
  const object = (await board()).canvas.objects.find(item => item.id === 'annotation-object');
  assert(object);
  const anchor = { object_id: object.id, content_revision: object.content_revision, block_id: block.id, target: { kind: 'step', id: 'second' } };
  await batch({ request_id: 'annotation-seed', reads: [{ kind: 'content', id: object.id, revision: object.content_revision }], operations: [
    { op: 'annotate', id: 'handled-fixture', expected_revision: 0, anchor, text: 'Earlier handled note' },
    { op: 'annotate', id: 'pending-fixture', expected_revision: 0, anchor, text: 'Earlier pending note' },
  ] });

  browser = await playwright.chromium.launch({ channel: 'msedge', headless: true }).catch(() => playwright.chromium.launch({ headless: true }));
  const context = await browser.newContext({ viewport: { width: 1320, height: 860 } });
  const agentRequests = [];
  await context.route('**/*', async (route, request) => {
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== api) return route.abort('blockedbyclient');
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' } });
    if (request.method() === 'POST' && (/^\/api\/(say|replies\/action)$/.test(url.pathname) || /^\/api\/canvas\/blocks\/.*\/action$/.test(url.pathname))) agentRequests.push(url.pathname);
    const headers = { ...request.headers() }; delete headers.origin; delete headers['sec-fetch-site'];
    const response = await route.fetch({ headers });
    if (url.pathname === '/api/board' || url.pathname === '/api/canvas/batch') {
      const payload = await response.json();
      const annotations = payload.board?.canvas?.annotations ?? payload.canvas?.annotations;
      const handled = annotations?.find(note => note.id === 'handled-fixture');
      if (handled) handled.status = 'handled'; // UI fixture until the backend status transition is exercised separately.
      return route.fulfill({ status: response.status(), headers: { ...response.headers(), 'access-control-allow-origin': origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    }
    return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': origin } });
  });
  await context.addInitScript(() => localStorage.setItem('spellcast.locale', 'zh-CN'));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.locator('#mode-focus').click();
  const frame = page.locator('.canvas-frame[data-item-id="annotation-object"]');
  await frame.waitFor();
  await frame.locator('.canvas-frame-head').getByRole('button', { name: '展开' }).click();
  const reader = page.locator('dialog.canvas-reader[open]');
  await reader.waitFor();
  const cdp = await context.newCDPSession(page);
  const screenshot = async name => {
    const file = path.join(state, name);
    const captured = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(file, Buffer.from(captured.data, 'base64'));
    return file;
  };
  const readerScreenshot = await screenshot('reader-entry.png');
  await reader.locator('.canvas-reader-annotation').click();
  const panel = page.locator('dialog.canvas-annotations[open]');
  await panel.waitFor();
  const cards = panel.locator('.canvas-annotation-card');
  assert(await reader.isVisible(), 'Reader should remain open behind the annotation dialog.');
  await panel.locator('.canvas-annotation-input').fill('Reader note');
  await panel.getByRole('button', { name: '保存到画布' }).click();
  await waitFor(async () => (await board()).canvas.annotations.find(note => note.text === 'Reader note'), 'reader annotation');
  const readerNote = (await board()).canvas.annotations.find(note => note.text === 'Reader note');
  assert.equal(readerNote.anchor.object_id, object.id);
  assert.equal(readerNote.anchor.block_id, undefined);
  assert.deepEqual(agentRequests, [], 'Saving annotation must not send to an Agent.');
  await panel.getByRole('button', { name: '关闭' }).click();
  assert(await reader.isVisible(), 'Closing annotation dialog must return to reader.');

  await reader.locator('.rb-block[data-block-id="annotation-sequence"] .rb-annotate-block').click();
  await panel.locator('.canvas-annotation-input').fill('Block note');
  await panel.getByRole('button', { name: '保存到画布' }).click();
  await waitFor(async () => (await board()).canvas.annotations.find(note => note.text === 'Block note'), 'block annotation');
  const blockNote = (await board()).canvas.annotations.find(note => note.text === 'Block note');
  assert.equal(blockNote.anchor.block_id, block.id);
  assert.equal(blockNote.anchor.target, undefined);
  await panel.getByRole('button', { name: '关闭' }).click();

  await reader.locator('.rb-seq-item[data-target-id="first"] .rb-annotate-target').click();
  assert.equal(await cards.count(), 0, 'Opening beat one must not list object/block notes or notes from beat two.');
  assert.match(await panel.locator('.canvas-annotation-target').textContent(), /第 1 拍: First beat/);
  assert.equal(await panel.getByRole('button', { name: '当前拍', exact: true }).getAttribute('aria-pressed'), 'true');
  await panel.locator('.canvas-annotation-input').fill('Unsent first step');
  await panel.getByRole('button', { name: '关闭' }).click();
  await reader.locator('.rb-seq-item[data-target-id="second"] .rb-annotate-target').click();
  await panel.locator('.canvas-annotation-input').fill('Unsent second step');
  await panel.getByRole('button', { name: '关闭' }).click();
  await reader.locator('.rb-seq-item[data-target-id="first"] .rb-annotate-target').click();
  assert.equal(await panel.locator('.canvas-annotation-input').inputValue(), 'Unsent first step', 'Returning to step one must restore its own draft.');
  await panel.getByRole('button', { name: '保存到画布' }).click();
  await waitFor(async () => (await board()).canvas.annotations.find(note => note.text === 'Unsent first step'), 'restored first-step draft');
  assert.deepEqual((await board()).canvas.annotations.find(note => note.text === 'Unsent first step').anchor.target, { kind: 'step', id: 'first' });
  await panel.getByRole('button', { name: '关闭' }).click();
  await reader.locator('.rb-seq-item[data-target-id="second"] .rb-annotate-target').click();
  assert.equal(await cards.filter({ hasText: 'Unsent first step' }).count(), 0, 'Beat two must never display the saved note from beat one.');
  assert.equal(await cards.filter({ hasText: 'Reader note' }).count(), 0, 'Beat scope must exclude parent object notes.');
  assert.equal(await cards.filter({ hasText: 'Block note' }).count(), 0, 'Beat scope must exclude parent block notes.');
  assert.match(await panel.locator('.canvas-annotation-target').textContent(), /第 2 拍: Second beat/);
  assert.equal(await panel.locator('.canvas-annotation-input').inputValue(), 'Unsent second step', 'Step two draft must remain separate.');
  await panel.locator('.canvas-annotation-input').fill('Step note to delete');
  await panel.getByRole('button', { name: '保存到画布' }).click();
  await waitFor(async () => (await board()).canvas.annotations.find(note => note.text === 'Step note to delete'), 'step annotation');
  const stepNote = (await board()).canvas.annotations.find(note => note.text === 'Step note to delete');
  assert.equal(stepNote.anchor.block_id, block.id);
  assert.deepEqual(stepNote.anchor.target, { kind: 'step', id: 'second' });
  assert.deepEqual(agentRequests, [], 'Adding a step annotation must not send to an Agent.');

  await panel.getByRole('button', { name: '添加注释', exact: true }).click();
  await panel.locator('.canvas-annotation-input').fill('Another second-step note');
  await panel.getByRole('button', { name: '保存到画布' }).click();
  await waitFor(async () => (await board()).canvas.annotations.find(note => note.text === 'Another second-step note'), 'additional note retains beat scope');
  assert.deepEqual((await board()).canvas.annotations.find(note => note.text === 'Another second-step note').anchor.target, { kind: 'step', id: 'second' });
  await panel.getByRole('button', { name: '工作区全部', exact: true }).click();
  assert.equal(await cards.filter({ hasText: 'Unsent first step' }).count(), 1, 'Workspace scope can show notes from other beats explicitly.');
  assert.match(await cards.filter({ hasText: 'Unsent first step' }).locator('.canvas-annotation-source').textContent(), /第 1 拍: First beat/);
  await panel.getByRole('button', { name: '当前拍', exact: true }).click();
  assert.equal(await cards.filter({ hasText: 'Unsent first step' }).count(), 0, 'Switching back restores exact beat filtering.');
  assert.equal(await cards.first().locator('.canvas-annotation-state.is-pending').count(), 1, 'Pending notes should sort before handled notes.');
  assert.equal(await cards.filter({ hasText: 'Earlier handled note' }).locator('.canvas-annotation-state.is-handled').count(), 1);
  const panelScreenshot = await screenshot('reader-annotations.png');
  const stepCard = cards.filter({ hasText: 'Step note to delete' });
  await stepCard.getByRole('button', { name: '删除' }).click();
  await waitFor(async () => (await board()).canvas.annotations.find(note => note.id === stepNote.id)?.removed, 'deleted annotation');
  await panel.getByRole('button', { name: '显示已删除注释' }).click();
  assert.equal(await cards.filter({ hasText: 'Step note to delete' }).locator('.canvas-annotation-state.is-removed').count(), 1);
  await cards.filter({ hasText: 'Step note to delete' }).getByRole('button', { name: '恢复' }).click();
  await waitFor(async () => !(await board()).canvas.annotations.find(note => note.id === stepNote.id)?.removed, 'restored annotation');
  assert.deepEqual(agentRequests, []);
  console.log('PASS reader entry, object/block/step anchors, beat list isolation, retained add target, no Agent send, pending/handled order, delete/restore');
  console.log(`SCREENSHOT ${readerScreenshot}`);
  console.log(`SCREENSHOT ${panelScreenshot}`);
} finally {
  await browser?.close().catch(() => {});
  for (const child of children) if (child.exitCode === null) child.kill();
}
