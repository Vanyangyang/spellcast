/** Real Rust API + isolated SQLite + browser input. No native host/model acceptance. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/workbench-20260914', `assembly-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const api = 'http://127.0.0.1:47342', origin = 'http://127.0.0.1:47341';
const report = { pass: false, method: 'Browser input against real Rust API and isolated SQLite; HTTP fixture preparation; response loss is diagnostic fault injection; no production data or host-model execution', checks: [], errors: [], blocked: [] };
let backend, browser, page, backendLog = '';
async function request(url, method = 'GET', body) {
  const response = await fetch(api + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
}
const board = () => request('/api/board');
const batch = operations => request('/api/canvas/batch', 'POST', { request_id: crypto.randomUUID(), reads: [], operations });
async function until(fn, message, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { try { const result = await fn(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 80)); } throw new Error(message); }
function startBackend() {
  backend = spawn(path.join(root, 'target/debug/spellcast-server.exe'), [], { cwd: root, env: { ...process.env, SPELLCAST_PORT: '47342', SPELLCAST_STATE_FILE: path.join(output, 'state.sqlite3') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', data => backendLog += data); backend.stderr.on('data', data => backendLog += data);
  return until(async () => { if (backend.exitCode !== null) throw Error('backend exited'); const value = await board(); return value; }, 'Isolated backend did not start');
}
async function stopBackend() { if (backend && backend.exitCode === null) { const exited = once(backend, 'exit'); backend.kill(); await exited; } }
await build({ stdin: { contents: "import './src/styles.css'; import './src/board-workspace.css'; export { mountCanvas } from './src/canvas.ts'; export * as api from './src/api.ts'; export {setLocale} from './src/i18n'; import './src/canvas-studio.css';", resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', outfile: path.join(output, 'harness.js'), define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: origin }) }, external: ['/fonts/*'] });
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>body{margin:0}#host{height:100vh}.canvas-workspace{position:relative}</style></head><body class="mode-focus view-replies"><div id="host"></div><script type="module">
import {mountCanvas,api,setLocale} from '/harness.js'; setLocale('zh-CN');
window.api=api;window.selection=null;window.errors=[];
window.canvas=mountCanvas(document.querySelector('#host'),{
onSelect(value){window.selection=value},onError(message){window.errors.push(message)},onAction:api.actOnBoardReply,onPatch:api.patchBoardReply,
onNodePatch:(id,r)=>api.patchNode(id,r),onNodeAsk:async()=>{},onBlockAction:async(id,r,revision)=>(await api.actOnCanvasBlock(id,{...r,expected_revision:revision})).board,
onCreate:()=>api.createNode({title:'fixture',body:''}),onDelete:api.deleteCanvasItem,onRestore:api.restoreCanvasItem,onLayout:api.patchCanvas,
onBatch:async r=>{const result=await api.applyCanvasBatch(r);if(result.result.status!=='applied')throw Error(result.result.targets.find(t=>t.status!=='ready')?.message||'not applied');return result.board},
onProposal:async(id,action,reads)=>(await api.resolveCanvasProposal(id,action,reads)).board,onReload:api.fetchBoard,onRestoreComposer(){}
});window.refresh=async()=>window.canvas.update(await api.fetchBoard());await window.refresh();window.canvas.setOverviewMeta({bindings:[]});
</script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/api/') || req.url?.startsWith('/artifacts/')) {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(api + req.url, { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json' }, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('Content-Type') || 'application/json' }); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(502); res.end(JSON.stringify({ error: String(error) })); }
    return;
  }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return; }
  if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(req.url || '')) { res.setHeader('Content-Type', 'font/woff2'); res.end(fs.readFileSync(path.join(root, 'public', req.url.slice(1)))); return; }
  const filename = ['/harness.js', '/harness.css'].includes(req.url) ? req.url.slice(1) : null;
  if (!filename) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(output, filename)));
});
await new Promise(resolve => server.listen(47341, '127.0.0.1', resolve));
const pass = label => { report.checks.push(label); console.log('PASS ' + label); };
try {
  // A preexisting listener must not be mistaken for this test process.
  const probe = await fetch(api + '/api/board').catch(() => null); assert.equal(probe, null, 'Test API port is already occupied');
  await startBackend(); assert.equal((await board()).canvas.objects.length, 0);
  await batch([{ op: 'create', id: 'seed-text', origin: { cwd: 'G:/Fixtures/Workbench' }, content: { type: 'text', title: '一个待发展的想法', text: '用多个不同组件共同表达。' }, placement: { x: 50, y: 60, width: 380, height: 280 } }]);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  await context.route('**/*', async route => { const url = new URL(route.request().url()); if (![origin, api].includes(url.origin)) { report.blocked.push(url.origin); await route.abort(); } else await route.continue(); });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin); await page.waitForSelector('.canvas-frame[data-item-id="seed-text"]');
  const toolbar = page.locator('.canvas-toolbar'); const dialog = page.locator('.canvas-insert');
  const workspace = page.locator('#canvas-workspace-select');
  assert.equal(await workspace.inputValue(), 'workspace:g:/fixtures/workbench');
  async function insert(kind, title, body = '') {
    await toolbar.getByRole('button', { name: '添加组件', exact: true }).click();
    await dialog.locator(`label[data-kind="${kind}"]`).click(); await dialog.locator('[name=title]').fill(title);
    if (body) await dialog.locator('[name=text]').fill(body);
    await dialog.getByRole('button', { name: '添加', exact: true }).click();
  }
  let lost = false, creates = [];
  await page.route(origin + '/api/canvas/batch', async route => {
    const payload = route.request().postDataJSON();
    if (payload.operations[0]?.op === 'create') creates.push(payload);
    if (!lost && payload.operations[0]?.content?.block?.type === 'comparison') { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await insert('comparison', '比较两种方案'); await dialog.locator('[role=alert]').waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('[name=title]').inputValue(), '比较两种方案');
  await dialog.getByRole('button', { name: '添加', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(creates.length, 2); assert.deepEqual(creates[0], creates[1]);
  const comparison = (await board()).canvas.objects.find(o => o.content.type === 'block');
  assert(comparison); assert.equal((await board()).canvas.objects.length, 2); assert.equal(comparison.origin.cwd, 'G:/Fixtures/Workbench');
  assert(!comparison.source_id); assert(comparison.user_edited); assert.equal(await workspace.inputValue(), 'workspace:g:/fixtures/workbench');
  pass('Response lost after commit: retry keeps request and object IDs, one component, draft and workspace');
  await insert('graph', '一个关系节点', '还没有明确关系'); await dialog.waitFor({ state: 'hidden' });
  await insert('sequence', '实现步骤', '验证一个最小操作'); await dialog.waitFor({ state: 'hidden' });
  // Public selection API is used only to locate a component; all content changes use real input.
  await page.evaluate(id => window.canvas.selectObject(id), comparison.id);
  const comparisonFrame = page.locator(`.canvas-frame[data-item-id="${comparison.id}"]`);
  await comparisonFrame.locator('.canvas-card-drag').dblclick();
  await comparisonFrame.locator('.rb-pick').last().click();
  await until(async () => (await board()).canvas.objects.find(o => o.id === comparison.id).content.block.selected_id, 'Comparison choice was not persisted');
  const localFeedback = await request('/api/feedback'); assert.deepEqual(localFeedback.pending, []); assert.deepEqual(localFeedback.deliveries, []);
  await comparisonFrame.getByRole('button', { name: '编辑', exact: true }).click();
  await comparisonFrame.getByLabel('方案名', { exact: true }).first().fill('经画布修改的方案 A');
  await comparisonFrame.getByRole('button', { name: '保存', exact: true }).click();
  await until(async () => (await board()).canvas.objects.find(o => o.id === comparison.id).content.block.options[0].title === '经画布修改的方案 A', 'Independent comparison edit was not stored');
  await toolbar.getByRole('button', { name: '返回画布', exact: true }).click();
  pass('Independent comparison supports native editor and a persisted option choice');
  let saved = await board(); const graph = saved.canvas.objects.find(o => o.content.block?.type === 'graph');
  assert.deepEqual(graph.content.block.edges, []); assert.equal(saved.edges.length, 0);
  pass('Independent comparison, graph and sequence use canonical editable objects and no automatic edges');
  const ids = saved.canvas.objects.map(o => o.id);
  await toolbar.getByRole('button', { name: '层级', exact: true }).click();
  for (const [index, id] of ids.entries()) await page.locator(`.canvas-layer-row[data-item-id="${id}"] button`).click({ modifiers: index ? ['Shift'] : [] });
  await page.locator('.canvas-layers').getByRole('button', { name: '关闭', exact: true }).click();
  await toolbar.locator('.canvas-tool-more summary').click(); await toolbar.getByRole('button', { name: '组合', exact: true }).click();
  const ideaDialog = page.locator('.canvas-idea');
  await ideaDialog.locator('[name=title]').fill('一个由四种组件组成的想法'); await ideaDialog.locator('[name=description]').fill('比较说明取舍，关系图表达依赖，步骤承接执行。');
  await ideaDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await toolbar.locator('.canvas-tool-more summary').click(); await toolbar.getByRole('button', { name: '组合', exact: true }).click();
  assert.equal(await ideaDialog.locator('[name=description]').inputValue(), '比较说明取舍，关系图表达依赖，步骤承接执行。');
  await ideaDialog.locator('li').last().getByRole('button', { name: '上移', exact: true }).click();
  const order = await ideaDialog.locator('li').evaluateAll(nodes => nodes.map(n => n.dataset.memberId));
  await ideaDialog.getByRole('button', { name: '保存', exact: true }).click(); await ideaDialog.waitFor({ state: 'hidden' });
  saved = await board(); let idea = saved.canvas.compositions[0]; assert.deepEqual(idea.members, order); assert(idea.user_modified);
  const selection = await page.evaluate(() => window.selection); assert.equal(selection.composition_id, idea.id);
  assert.equal(selection.anchors.length, 4); assert(selection.anchors.every(a => a.compositions.some(c => c.id === idea.id && c.revision === idea.revision)));
  pass('Whole idea has title, description, authored member order and exact-version feedback anchors');
  await toolbar.getByRole('button', { name: '编辑想法', exact: true }).click();
  await ideaDialog.locator('[name=description]').fill('保留尚未提交的整体说明'); await ideaDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload(); await page.waitForSelector('.canvas-toolbar');
  await toolbar.getByRole('button', { name: '层级', exact: true }).click();
  await page.locator(`.canvas-layer-row[data-composition-id="${idea.id}"] button`).click();
  await page.locator('.canvas-layers').getByRole('button', { name: '关闭', exact: true }).click();
  await toolbar.getByRole('button', { name: '编辑想法', exact: true }).click();
  assert.equal(await ideaDialog.locator('[name=description]').inputValue(), '保留尚未提交的整体说明');
  await batch([{ op: 'compose', id: idea.id, expected_revision: idea.revision, title: '外部更新后的名称', description: '外部更新后的说明', members: [...idea.members].reverse() }]);
  await ideaDialog.getByRole('button', { name: '保存', exact: true }).click(); await ideaDialog.locator('[role=alert]').waitFor({ state: 'visible' });
  assert.equal((await board()).canvas.compositions[0].title, '外部更新后的名称');
  assert.equal(await ideaDialog.locator('[name=description]').inputValue(), '保留尚未提交的整体说明');
  await ideaDialog.getByRole('button', { name: '刷新并审阅', exact: true }).click(); await ideaDialog.locator('.canvas-idea-review').waitFor({ state: 'visible' });
  assert.match(await ideaDialog.locator('.canvas-idea-review').innerText(), /外部更新后的说明/);
  await ideaDialog.getByRole('button', { name: '保存', exact: true }).click(); await ideaDialog.waitFor({ state: 'hidden' });
  idea = (await board()).canvas.compositions[0]; assert.equal(idea.description, '保留尚未提交的整体说明'); assert.deepEqual(idea.members, order);
  pass('Idea draft survives page reload; stale writes are rejected; explicit review applies the retained draft');
  await toolbar.getByRole('button', { name: '编辑想法', exact: true }).click();
  await ideaDialog.locator('li').last().getByRole('button', { name: '移出组合', exact: true }).click();
  const beforeDetach = await board();
  await ideaDialog.getByRole('button', { name: '保存', exact: true }).click(); await ideaDialog.waitFor({ state: 'hidden' });
  saved = await board(); assert.equal(saved.canvas.objects.length, 4); assert.equal(saved.canvas.compositions[0].members.length, 3);
  assert.deepEqual(saved.canvas.items, beforeDetach.canvas.items); assert.deepEqual(saved.canvas.objects, beforeDetach.canvas.objects);
  pass('Detach preserves component content and placement');
  await request('/api/artifacts', 'POST', { source_id: 'assembly-fixture', reply_id: 'fixture-work', block_id: 'work', title: '可操作的作品组件', directory: path.join(root, 'scripts/fixtures/atomic-work'), entry: 'index.html' });
  const stale = await fetch(api + '/api/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'stale idea', source_id: 'assembly-fixture', anchors: selection.anchors }) });
  assert(!stale.ok); assert.match(await stale.text(), /想法的说明或成员已经改变/); pass('Stale whole-idea feedback is rejected specifically for its changed composition');
  await page.evaluate(() => window.refresh()); await workspace.selectOption('all');
  const workObject = (await board()).canvas.objects.find(o => o.content.type === 'reply' && o.content.id === 'fixture-work');
  await toolbar.getByRole('button', { name: '层级', exact: true }).click(); await page.locator(`.canvas-layer-row[data-composition-id="${idea.id}"] button`).click();
  await page.locator('.canvas-layers').getByRole('button', { name: '关闭', exact: true }).click(); await toolbar.getByRole('button', { name: '编辑想法', exact: true }).click();
  await ideaDialog.locator('select').selectOption(workObject.id); await ideaDialog.getByRole('button', { name: '保存', exact: true }).click(); await ideaDialog.waitFor({ state: 'hidden' });
  assert((await board()).canvas.compositions[0].members.includes(workObject.id));
  await page.evaluate(id => window.canvas.selectObject(id), workObject.id); await toolbar.getByRole('button', { name: '进入内容', exact: true }).click();
  const workFrame = await (await page.locator(`.canvas-frame[data-item-id="${workObject.id}"] iframe`).elementHandle()).contentFrame();
  await workFrame.getByRole('textbox', { name: 'Work note', exact: true }).fill('同一个 idea 内的作品参数'); await workFrame.locator('#increment').click();
  await until(async () => { const state = (await board()).replies.find(r => r.id === 'fixture-work').blocks[0].state; return state.note === '同一个 idea 内的作品参数' && state.count === 1; }, 'Mixed artifact state was not saved');
  await toolbar.getByRole('button', { name: '返回画布', exact: true }).click();
  saved = await board();
  pass('Existing interactive artifact joins the same idea and preserves independently edited work state');
  const snapshot = structuredClone(saved);
  await stopBackend(); await startBackend(); assert.deepEqual(await board(), snapshot);
  await page.reload(); await page.waitForSelector('.canvas-toolbar');
  assert.equal((await board()).canvas.objects.filter(o => o.origin?.cwd === 'G:/Fixtures/Workbench').length, 4);
  pass('Process restart preserves the complete mixed-component SQLite board and work parameters');
  for (const width of [880, 1360]) { await page.setViewportSize({ width, height: 940 }); await toolbar.getByRole('button', { name: '添加组件', exact: true }).click(); assert(await dialog.getByRole('button', { name: '添加', exact: true }).isVisible()); await dialog.locator('.canvas-insert-cancel').click(); }
  await toolbar.getByRole('button', { name: '查看全部', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'workbench.png'), fullPage: true });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.pass = true;
} catch (error) { report.error = error.stack; if (page) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }); }
finally { await browser?.close(); await stopBackend(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.writeFileSync(path.join(output, 'backend.log'), backendLog); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ ...report, output })); if (!report.pass) process.exitCode = 1;
