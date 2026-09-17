/** Full built app, browser input, isolated API fixtures; no production requests or model turns. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(import.meta.dirname, '..'), dist = path.join(root, 'dist');
const output = path.join(root, 'artifacts/workbench-20260914', `block-focus-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const board = { topic: 'Focus fixture', form: 'spatial', form_reason: '', nodes: [], edges: [], messages: [], replies: [
  { id: 'reply', source_id: 'task-a', source_label: '原设计任务', title: '整份设计方案', revision: 1, created_at_ms: 1, updated_at_ms: 1, blocks: [
    { id: 'a', type: 'text', title: '方案说明', text: '这是说明的正文。' }, { id: 'b', type: 'text', title: '验证方法', text: '这是验证方法的正文。' },
  ] },
], canvas: { revision: 1, objects: [{ id: 'object', source_id: 'task-a', content_revision: 1, content: { type: 'reply', id: 'reply' } }], items: [{ item_id: 'object', revision: 1, x: 100, y: 100, width: 820, height: 620, z: 0, removed: false, appearance: 'card' }], compositions: [], proposals: [] } };
const bindings = [{ source_id: 'task-a', thread_id: '11111111-1111-4111-8111-111111111111', cwd: 'G:/FocusFixture', label: '原设计任务' }, { source_id:'task-b',thread_id:'22222222-2222-4222-8222-222222222222',cwd:'G:/OtherFixture',label:'其他工作区任务' }];
const submissions=[];
const feedback = { bindings, deliveries: [], pending: [] };
const server = createServer((req, res) => {
  const filename = path.resolve(dist, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!filename.startsWith(dist + path.sep) || !fs.existsSync(filename)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.woff2') ? 'font/woff2' : 'text/html;charset=utf-8'); res.end(fs.readFileSync(filename));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { pass: false, method: 'Full dist app with browser input and isolated API fixtures; no production calls', checks: [], unexpected: [], blockedAssets: [], writes: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
  await context.addInitScript(() => { localStorage.setItem('spellcast.locale', 'zh-CN'); localStorage.setItem('spellcast.mode', 'focus'); });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) { report.blockedAssets.push(req.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) { if (url.origin === origin) return route.continue(); report.unexpected.push(req.url()); return route.abort(); }
    let value; const name = req.method() + ' ' + url.pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' } });
    if (name === 'GET /api/board') value = board;
    else if (name === 'GET /api/forms') value = { forms: [{ id: 'spatial', label: '空间', blurb: '' }] };
    else if (name === 'GET /api/health' || name === 'POST /api/surface') value = { surface: 'focus', port: 47348, calls: 0, sources: [{ id: 'task-a', label: '原设计任务' }], observer_enabled: false };
    else if (name === 'GET /api/events') value = { events: [], last_seq: 0 };
    else if (name === 'GET /api/feedback') value = feedback;
    else if (name === 'GET /api/memories') value = { memories: [] };
    else if (name === 'GET /api/observer/status') value = { enabled: false, paused: false, allowed: false, reason: 'fixture', policy_revision: 1 };
    else if (name === 'POST /api/task-target') value = { ...bindings.find(binding=>binding.source_id===req.postDataJSON().source_id), status: 'available', checked_at_ms: Date.now(), message: '' };
    else if (name === 'POST /api/say') { const body=req.postDataJSON(); submissions.push(body); value={...body,seq:102,kind:'say',at_ms:Date.now()}; }
    else { report.unexpected.push(name); return route.abort(); }
    if (req.method() !== 'GET' && !['POST /api/surface', 'POST /api/task-target'].includes(name)) report.writes.push(name);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(value) });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin); await page.locator('.canvas-frame').waitFor({ state: 'attached' });
  await page.waitForFunction(()=>document.querySelector('#send').textContent==='发送' && document.querySelector('#recipient-workspace').options.length>1);
  await page.mouse.click(1280,420);
  await page.waitForFunction(()=>document.querySelector('#form-reason').textContent.includes('先选择'));
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await page.locator('#input').isDisabled(),true);
  assert.equal(await page.locator('#recipient').isDisabled(),true);
  assert.deepEqual(await page.locator('#recipient option').evaluateAll(options=>options.map(o=>o.value)),['']);
  assert.equal(await page.locator('#send').textContent(),'发送');
  assert.equal(await page.locator('#recipient-route').isHidden(),true);
  await page.selectOption('#canvas-workspace-select', 'all');
  const frame = page.locator('.canvas-frame[data-item-id="object"]');
  await frame.locator('.canvas-frame-head button').first().click();
  const first = frame.locator('.rb-block[data-block-id="a"]'), second = frame.locator('.rb-block[data-block-id="b"]');
  await first.locator('.rb-focus-block').waitFor();
  assert.equal(await first.locator('.rb-focus-block').textContent(), '✓ 已选中');
  assert.match(await page.locator('#form-reason').textContent(), /方案说明/);
  assert.equal(await page.locator('#recipient-picker').isHidden(),true);
  assert.match(await page.locator('#recipient-summary').textContent(),/发送给：原设计任务.*原任务/);
  await first.locator('.rb-focus-block').click();
  assert.match(await page.locator('#app-notice:visible').textContent(), /方案说明.*底部输入/);
  report.checks.push('Default first-block selection is explicit; clicking the same block gives visible guidance');
  await second.locator('.rb-focus-block').click();
  assert.equal(await second.locator('.rb-focus-block').textContent(), '✓ 已选中');
  assert.equal(await first.locator('.rb-focus-block').textContent(), '针对这块讨论');
  assert.equal(await first.locator('.rb-focus-block').getAttribute('title'), '针对这块讨论');
  assert.match(await page.locator('#app-notice:visible').textContent(), /验证方法.*底部输入/);
  assert.match(await page.locator('#form-reason').textContent(), /验证方法/);
  assert.doesNotMatch(await page.locator('#form-reason').textContent(), /整份设计方案/);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.rb-block[data-block-id="b"] .rb-focus-block')).backgroundColor === 'rgb(233, 223, 243)');
  const style = await second.locator('.rb-focus-block').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  assert.equal(style.background, 'rgb(233, 223, 243)');
  await page.screenshot({ path: path.join(output, 'selected-block.png') });
  report.checks.push('Clicking another block updates button, highlight, notice and the exact composer target');
  await page.locator('#input').fill('只修改验证方法');
  await first.locator('.rb-focus-block').click(); assert.equal(await page.locator('#input').inputValue(), '');
  await page.locator('#input').fill('只修改方案说明');
  await second.locator('.rb-focus-block').click(); assert.equal(await page.locator('#input').inputValue(), '只修改验证方法');
  await second.locator('.rb-focus-block').click(); assert.equal(await page.locator('#input').inputValue(), '只修改验证方法');
  await first.locator('.rb-focus-block').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#input').inputValue(), '只修改方案说明');
  assert.match(await page.locator('#app-notice:visible').textContent(), /方案说明/);
  report.checks.push('Per-block drafts survive switching and repeated clicks; keyboard activation also provides feedback');
  await page.locator('#recipient-change').click();
  await page.selectOption('#recipient-workspace','workspace:g:/otherfixture');
  assert.equal(await page.locator('#recipient').inputValue(),'');
  assert.deepEqual(await page.locator('#recipient option').evaluateAll(options=>options.map(o=>o.value)),['','task-b']);
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await page.locator('#input').inputValue(),'只修改方案说明');
  await page.selectOption('#recipient','task-b');
  await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.locator('#recipient-workspace').inputValue(),'workspace:g:/focusfixture');
  assert.equal(await page.locator('#recipient').inputValue(),'task-a');
  assert.equal(await page.locator('#recipient-picker').isHidden(),true);
  await page.locator('#recipient-change').click();
  await page.selectOption('#recipient-workspace','workspace:g:/otherfixture');
  await page.selectOption('#recipient','task-b');
  await page.getByRole('alertdialog').getByRole('button',{name:'确认切换',exact:true}).click();
  assert.equal(await page.locator('#recipient-picker').isHidden(),true);
  assert.equal(await page.locator('#recipient-summary').textContent(),'发送给：其他工作区任务');
  await page.locator('#send').click();
  await page.waitForFunction(()=>document.querySelector('#input').value==='');
  assert.equal(submissions.length,1); assert.equal(submissions[0].source_id,'task-b');
  assert.equal(submissions[0].target_thread_id,bindings[1].thread_id);
  assert.equal(submissions[0].anchors[0].object_id,'object'); assert.equal(submissions[0].anchors[0].block_id,'a');
  await page.mouse.click(1280,420);
  await frame.locator('.canvas-frame-head button').first().click();
  await first.locator('.rb-focus-block').click();
  assert.equal(await page.locator('#input').inputValue(),'');
  assert.equal(await page.locator('#recipient').inputValue(),'task-a');
  await page.locator('#input').fill('只修改方案说明');
  report.checks.push('Workspace-first selection retains drafts; confirmed send uses the chosen task and exact anchor, and sent text cannot reappear under the old recipient after reselection');
  const receipt = { event: { seq: 101, at_ms: Date.now(), kind: 'say', text: '修改说明', source_id: 'task-a', object_id: 'object', anchors: [{ object_id: 'object', content_revision: 1, block_id: 'a' }] }, phase: 'submitted', client_message_id: 'native-101', desktop: { accepted_at_ms: Date.now(), host_status: 'submitted' } };
  feedback.deliveries.push(receipt);
  await page.waitForFunction(() => document.querySelector('.composer-delivery-status')?.textContent.includes('已提交原任务'));
  receipt.desktop.host_status = 'active';
  await page.waitForFunction(() => document.querySelector('.composer-delivery-status')?.textContent.includes('原任务运行中'));
  receipt.phase = 'failed'; receipt.error = '原任务本轮已结束，但尚未将结果写回这份画布。';
  await page.waitForFunction(() => document.querySelector('.composer-delivery-status')?.textContent.includes('尚未将结果写回'));
  assert.equal(await page.locator('#input').inputValue(), '只修改方案说明');
  receipt.phase = 'responded'; receipt.error = null;
  await page.waitForFunction(() => document.querySelector('.composer-delivery-status')?.textContent.includes('回复已更新'));
  report.checks.push('Native submission, host progress, missing result and Canvas response stay visible beside the current draft');
  board.canvas.items[0].appearance = 'plain';
  await page.reload(); await frame.waitFor();
  const inactive = await first.evaluate(el => ({ border: getComputedStyle(el).borderColor, shadow: getComputedStyle(el).boxShadow }));
  assert.equal(inactive.shadow, 'none'); assert.match(inactive.border, /rgba\(.*0\)/);
  report.checks.push('Inactive plain content does not inherit the inner selected-block highlight');
  assert.deepEqual(report.writes, ['POST /api/say']); assert.deepEqual(report.unexpected, []); assert.deepEqual(report.errors, []);
  report.pass = true;
} finally { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); await browser?.close(); await new Promise(resolve => server.close(resolve)); console.log(JSON.stringify({ ...report, output })); }
