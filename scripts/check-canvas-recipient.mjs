/** Browser regression with explicit host-status fixtures; never sends to a real task. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/workbench-20260914', `recipient-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
await build({ stdin: { contents: "export * from './src/canvas-recipient'; export {setLocale} from './src/i18n'; import './src/canvas-studio.css';", resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', external: ['/fonts/*'], outfile: path.join(output, 'harness.js') });
const server = createServer((req, res) => {
  if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(req.url || '')) { res.setHeader('Content-Type', 'font/woff2'); res.end(fs.readFileSync(path.join(root, 'public', req.url.slice(1)))); return; }
  if (req.url === '/harness.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(output, 'harness.js'))); }
  else if (req.url === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(output, 'harness.css'))); }
  else { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/harness.css"></head><body><div id="recipient-route" class="composer-task"><span id="recipient-summary"></span><button id="recipient-change" type="button"></button><div id="recipient-picker" class="composer-route-options" hidden><label for="recipient-workspace">工作区</label><select id="recipient-workspace"></select><label for="recipient">Codex 任务</label><select id="recipient"></select></div></div><p id="status" role="status"></p><textarea id="draft">未发送的修改意见</textarea><button id="send">继续</button></body></html>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { pass: false, method: 'Real browser controls and application recipient module; task statuses are fixtures, no host task deletion or delivery', checks: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(async () => {
    const { CanvasRecipient, originalTask, setLocale } = await import('/harness.js'); setLocale('zh-CN');
    const bindings = [
      { source_id: 'a', thread_id: 'thread-a', cwd: 'G:/A', label: '设计任务' },
      { source_id: 'b', thread_id: 'thread-b', cwd: 'G:/B', label: '执行任务' },
      { source_id: 'a-copy', thread_id: 'thread-a', cwd: 'g:\\a\\', label: '重复来源' },
      { source_id: 'c', thread_id: 'thread-c', cwd: 'G:/A', label: '同工作区任务' },
      { source_id: 'd', thread_id: 'thread-d', cwd: 'G:/Team/Project', label: '同名工作区之一' },
      { source_id: 'e', thread_id: 'thread-e', cwd: 'G:/Other/Project', label: '同名工作区之二' },
    ];
    const board = { nodes: [{ id: 'node', source_id: 'a', captured_context: { thread_id: 'thread-a', cwd: 'G:/A', goal: '原始设计' } }], replies: [], canvas: { objects: [
      { id: 'legacy', content: { type: 'node', id: 'node' } },
      { id: 'native', source_id: 'b', content: { type: 'text', title: '参考' } },
      { id: 'free', content: { type: 'text', title: '本地点子' } },
    ], compositions: [{ id: 'idea', source_id: 'a' }] } };
    const selection = { object_id: 'legacy', object_ids: ['legacy'], anchors: [{ object_id: 'legacy' }] };
    const state = { board, selection, bindings, statuses: { a: 'available', b: 'available' }, calls: [], hold: false, resolve: null, commits: [], drafts: [] };
    const control = new CanvasRecipient(document.querySelector('#recipient'), document.querySelector('#recipient-workspace'), document.querySelector('#status'), async target => {
      state.calls.push(target.source_id);
      const value = { ...target, label: '', status: state.statuses[target.source_id] || 'unlinked', checked_at_ms: Date.now(), message: '' };
      if (state.hold && target.source_id === 'a') return new Promise(resolve => state.resolve = () => resolve(value));
      return value;
    }, blocked => document.querySelector('#send').disabled = blocked, {root:document.querySelector('#recipient-route'),summary:document.querySelector('#recipient-summary'),toggle:document.querySelector('#recipient-change'),picker:document.querySelector('#recipient-picker')});
    document.querySelector('#recipient').addEventListener('recipient-change', () => {
      state.commits.push(control.target()?.source_id); state.drafts.push({ target_source_id: control.target()?.source_id, text: document.querySelector('#draft').value });
    });
    Object.assign(window, { state, control, originalTask });
    window.render = () => control.update(state.board, state.selection, state.bindings, [{id:'unlinked',label:'未关联来源'}]);
    window.render();
  });
  const value = () => page.locator('#recipient').inputValue();
  const selectedText = () => page.locator('#recipient option:checked').textContent();
  const choose = async source => {
    if (await page.locator('#recipient-picker').isHidden()) await page.locator('#recipient-change').click();
    const workspace = await page.evaluate(source => 'workspace:' + state.bindings.find(b => b.source_id === source).cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(), source);
    await page.selectOption('#recipient-workspace', workspace);
    await page.selectOption('#recipient', source);
  };
  const check = label => report.checks.push(label);
  assert.equal(await value(), 'a'); assert.match(await selectedText(), /设计任务.*原任务/);
  assert.equal(await page.locator('#recipient-picker').isHidden(),true);
  assert.match(await page.locator('#recipient-summary').textContent(),/发送给：设计任务.*原任务/);
  await page.locator('#recipient-change').click();
  assert.equal(await page.locator('#recipient-picker').isVisible(),true);
  assert.equal(await page.locator('#send').isDisabled(),true);
  await page.selectOption('#recipient-workspace','workspace:g:/b');
  await page.locator('#recipient-workspace').press('Escape');
  assert.equal(await page.locator('#recipient-picker').isHidden(),true);
  assert.equal(await value(),'a'); assert.equal(await page.locator('#draft').inputValue(),'未发送的修改意见');
  check('Recipient controls start collapsed; Change opens them, Escape cancels browsing and keeps the original destination and draft');
  assert.equal(await page.locator('#recipient-workspace').inputValue(), 'workspace:g:/a');
  assert.deepEqual(await page.locator('#recipient option').evaluateAll(options => options.map(o => o.value)), ['', 'a', 'c']);
  assert.deepEqual(await page.locator('#recipient-workspace option').evaluateAll(options => options.map(o => o.value)), ['', 'workspace:g:/a','workspace:g:/b','workspace:g:/team/project','workspace:g:/other/project']);
  check('Original workspace is selected; only its tasks appear, duplicate sources collapse and identical directory names remain distinct');
  check('Original task is selected even when an old Canvas object only stores its source on the underlying node');
  const resolution = await page.evaluate(() => {
    const { board, bindings } = state;
    const group = originalTask(board, { object_id: 'native', object_ids: ['native', 'legacy'], composition_id: 'idea' }, bindings);
    const rebound = originalTask(board, state.selection, [{ ...bindings[0], thread_id: 'replacement', label: 'Wrong task' }]);
    const free = originalTask(board, { object_id: 'free' }, bindings);
    return { group, rebound, free };
  });
  assert.equal(resolution.group.source_id, 'a'); assert.equal(resolution.rebound.thread_id, 'thread-a'); assert.notEqual(resolution.rebound.label, 'Wrong task'); assert.equal(resolution.free, undefined);
  check('Composition owner wins over reference components; captured identity survives rebinding; local content stays unassigned');
  const confirmation = page.getByRole('alertdialog');
  await page.locator('#recipient-change').click();
  await page.selectOption('#recipient-workspace', 'workspace:g:/b');
  assert.deepEqual(await page.locator('#recipient option').evaluateAll(options => options.map(o => o.value)), ['', 'b']);
  assert.equal(await value(), ''); assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(await page.evaluate(async () => control.verify().then(() => 'unexpected', () => 'blocked')), 'blocked');
  assert.equal(await page.locator('#draft').inputValue(), '未发送的修改意见');
  check('Changing workspace only changes candidates; it clears the visible task and blocks sending until a task is chosen');
  await choose('b'); await confirmation.waitFor();
  assert.equal(await value(), 'a'); assert.equal(await page.locator('#send').isDisabled(), true);
  assert.match(await confirmation.innerText(), /设计任务/); assert.match(await confirmation.innerText(), /执行任务/);
  assert.match(await confirmation.innerText(), /G:\/A/); assert.match(await confirmation.innerText(), /G:\/B/);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '取消');
  assert.equal(await page.evaluate(async () => control.verify().then(() => 'unexpected', () => 'blocked')), 'blocked');
  await page.screenshot({ path: path.join(output, 'switch-confirmation.png') });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await value(), 'a'); assert.deepEqual(await page.evaluate(() => state.commits), []);
  assert.equal(await page.locator('#recipient-picker').isHidden(),true);
  assert.equal(await page.locator('#recipient-workspace').inputValue(), 'workspace:g:/a');
  assert.equal(await page.locator('#draft').inputValue(), '未发送的修改意见');
  await choose('b'); await confirmation.waitFor(); await page.keyboard.press('Escape');
  assert.equal(await value(), 'a'); assert.equal(await confirmation.count(), 0);
  check('Cancel and Escape retain original recipient and draft, pending confirmation blocks sending');
  await choose('b'); await confirmation.getByRole('button', { name: '确认切换', exact: true }).click();
  await page.evaluate(() => window.render()); assert.equal(await value(), 'b');
  assert.equal(await page.locator('#recipient-picker').isHidden(),true);
  assert.equal(await page.locator('#recipient-summary').textContent(),'发送给：执行任务');
  assert.deepEqual(await page.evaluate(() => state.drafts), [{ target_source_id: 'b', text: '未发送的修改意见' }]);
  await choose('a'); assert.equal(await confirmation.count(), 0); assert.equal(await value(), 'a');
  check('Only explicit confirmation commits the new task; returning to original needs no warning and nothing is sent');
  await page.evaluate(() => { control.resetChoice('b'); window.render(); }); assert.equal(await value(), 'b');
  check('Explicit recipient survives refresh and draft restoration');
  await page.evaluate(async () => { control.resetChoice(); window.render(); state.statuses.a = 'deleted'; await control.verify().catch(() => {}); });
  assert.equal(await value(), 'a'); assert.match(await selectedText(), /原任务已删除.*设计任务/);
  assert.match(await page.locator('#recipient-summary').textContent(),/原任务已删除.*设计任务/);
  assert.equal(await page.locator('#send').isDisabled(), true); assert.match(await page.locator('#status').textContent(), /已删除/);
  await page.screenshot({ path: path.join(output, 'deleted-original.png') });
  await choose('b'); await confirmation.waitFor(); assert.match(await confirmation.innerText(), /原任务已删除/);
  await confirmation.getByRole('button', { name: '确认切换', exact: true }).click(); assert.equal(await value(), 'b');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  assert.equal(await page.evaluate(async () => (await control.verify()).thread_id), 'thread-b');
  check('Deleted original remains visibly selected and blocks sending; choosing an alternative is explicit and works');
  for (const status of ['unknown', 'unlinked', 'changed']) {
    await page.evaluate(async status => { state.statuses.a = status; control.resetChoice(); window.render(); await control.verify().catch(() => {}); }, status);
    assert.doesNotMatch(await selectedText(), /已删除/); assert.doesNotMatch(await page.locator('#status').textContent(), /已删除/);
  }
  check('Temporary failure, missing binding and changed association are never labeled deleted');
  await page.evaluate(() => { state.hold = true; state.statuses.a = 'available'; window.pending = control.verify().then(() => 'unexpected', () => 'cancelled'); });
  await page.waitForFunction(() => Boolean(state.resolve));
  await choose('b');
  await confirmation.getByRole('button', { name: '确认切换', exact: true }).click();
  assert.equal(await page.evaluate(async () => { state.resolve(); return await window.pending; }), 'cancelled'); assert.equal(await value(), 'b');
  check('Late original-task lookup cannot overwrite a newer choice or authorize a stale send');
  await page.evaluate(() => { state.hold = false; control.resetChoice(); window.render(); });
  await choose('b'); await confirmation.waitFor();
  await page.evaluate(() => { state.selection = { object_id: 'native', object_ids: ['native'] }; control.resetChoice(); window.render(); });
  assert.equal(await confirmation.count(), 0); assert.equal(await value(), 'b');
  check('Switching Canvas content dismisses pending confirmation before it can change another object');
  await page.evaluate(() => { state.selection = { object_id: 'legacy', object_ids: ['legacy'] }; control.resetChoice(); window.render(); });
  await choose('b'); await confirmation.waitFor();
  await page.evaluate(() => { state.bindings[1].thread_id = 'replacement-b'; window.render(); });
  assert.equal(await confirmation.count(), 0); assert.equal(await value(), 'a');
  check('Rebinding the proposed destination invalidates the pending confirmation');
  await page.evaluate(() => { state.selection = null; control.resetChoice(); window.render(); });
  assert.equal(await page.locator('#recipient-workspace').inputValue(), '');
  assert.equal(await page.locator('#recipient-route').isHidden(),true);
  assert.equal(await page.locator('#recipient').isDisabled(), true); assert.equal(await page.locator('#send').isDisabled(), true);
  assert.deepEqual(await page.locator('#recipient option').evaluateAll(options => options.map(o => o.value)), ['']);
  assert.equal(await page.locator('#status').isHidden(), true);
  check('An empty Canvas selection never offers an all-task list or an enabled send action');
  report.pass = true;
} finally {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify({ ...report, output }));
}
