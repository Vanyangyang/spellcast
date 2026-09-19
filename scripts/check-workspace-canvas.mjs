import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'artifacts/workbench-20260914');
fs.mkdirSync(output, { recursive: true });
const origin = 'http://127.0.0.1:47331';
await build({ stdin: { contents: "import './src/styles.css'; import './src/board-workspace.css'; export { mountCanvas } from './src/canvas.ts'; import './src/canvas-studio.css';", resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', outfile: path.join(output, 'canvas-test.js'), define: { 'import.meta.env': '{}' }, external: ['/fonts/*'] });
const server = createServer((request, response) => {
  if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(request.url ?? '')) { response.setHeader('Content-Type', 'font/woff2'); response.end(fs.readFileSync(path.join(root, 'public', request.url.slice(1)))); return; }
  const file = request.url === '/canvas-test.js' ? 'canvas-test.js' : request.url === '/canvas-test.css' ? 'canvas-test.css' : null;
  if (!file) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(fs.readFileSync(path.join(output, file)));
});
await new Promise(resolve => server.listen(47331, '127.0.0.1', resolve));
let browser, page;
const report = { pass: false, method: 'Isolated browser UI with explicit in-memory fixtures; no production API or model responses', errors: [], blocked: [] };
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.blocked.push(url.origin); await route.abort(); return; }
    if (url.pathname === '/scope.html') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/canvas-test.css"><style>
        :root { --font: Arial,sans-serif; --line:#ddd; --line-strong:#aaa; --mute:#817b72; --paper:#fffdf7; --ink:#25221e; --lilac:#b58cdd; --mint:#80baa5; --radius-lg:18px; --radius-md:10px; --glass:#282828; } body{margin:0;font-family:Arial} #host{height:100vh}.canvas-workspace{position:relative}
        </style></head><body class="mode-focus view-replies"><div id="host"></div><script type="module">
        import {mountCanvas} from '/canvas-test.js';
        const ctx=(source,workspace,thread,goal)=>({source_id:source,cwd:workspace,thread_id:thread,project:'同名项目',goal,change:'新的设计约束',captured_at_ms:1});
        const note=(id,title,source,context)=>({id,title,body:'',revision:1,source_id:source,kind:'idea',weight:'note',x:0,y:0,z:0,captured_context:context});
        const object=(id,content,source)=>({id,content,source_id:source,content_revision:1,bindings:[]});
        const place=(id,x,y)=>({item_id:id,x,y,width:360,height:220,z:1,revision:1,removed:false,appearance:'plain',user_modified:false});
        const reconnectSource='codex:11111111-1111-4111-8111-111111111111';
        const board={topic:'scope fixture',form:'spatial',form_reason:'',nodes:[note('na','方案 A：只有标题也要可读','a',ctx('a','G:/Projects/A','ta','设计任务 A')),note('na2','同工作区的另一个任务','a2',ctx('a2','G:/Projects/A','ta2','设计任务 A2')),note('nb','方案 B 的独立想法','b',ctx('b','G:/Projects/B','tb','设计任务 B')),note('nr','重连的原任务',reconnectSource,{source_id:reconnectSource,goal:'原任务',captured_at_ms:1})],replies:[],edges:[],messages:[],canvas:{revision:1,objects:[object('a1',{type:'node',id:'na'},'a'),object('a2',{type:'text',title:'组件文字',text:'原始正文'},'a'),object('other-task',{type:'node',id:'na2'},'a2'),object('b',{type:'node',id:'nb'},'b'),object('legacy',{type:'text',title:'历史记录',text:'未知来源'},'old-agent'),object('reconnect',{type:'node',id:'nr'},reconnectSource)],items:[place('a1',60,90),place('a2',460,90),place('other-task',60,370),place('b',900,90),place('legacy',900,370),place('reconnect',460,370)],compositions:[{id:'idea-composition',revision:1,title:'一个组合 idea',members:['a1','a2'],source_id:'a'}],proposals:[]}};
        window.fixture=board; window.mutations=[];
        const noMutation=async request=>{window.mutations.push(request);throw Error('Unexpected write in scope-only verification')};
        window.canvas=mountCanvas(document.querySelector('#host'),{onSelect(){},onAction:noMutation,onPatch:noMutation,onNodePatch:noMutation,onNodeAsk:noMutation,onCreate:noMutation,onDelete:noMutation,onRestore:noMutation,onLayout:noMutation,onBatch:noMutation,onProposal:noMutation,onReload:async()=>board,onRestoreComposer(){},onError:message=>{window.lastError=message}});
        window.bindings=[{source_id:'a',thread_id:'ta',cwd:'G:/Projects/A',label:'设计任务 A'},{source_id:'a2',thread_id:'ta2',cwd:'G:/Projects/A',label:'设计任务 A2'},{source_id:'b',thread_id:'tb',cwd:'G:/Projects/B',label:'设计任务 B'}];
        window.reconnectSource=reconnectSource;
        window.canvas.update(board); window.canvas.setOverviewMeta({bindings:window.bindings});
        </script></body></html>` });
    } else await route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/scope.html');
  await page.waitForSelector('.canvas-frame[data-item-id="a1"]', { state: 'attached' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const frame = id => page.locator(`.canvas-frame[data-item-id="${id}"]`);
  const workspace = page.locator('#canvas-workspace-select'), task = page.locator('#canvas-task-select');
  await page.waitForFunction(() => document.querySelector('#canvas-workspace-select')?.value === 'workspace:g:/projects/a');
  assert.equal(await frame('a1').isVisible(), true);
  assert.equal(await frame('b').isVisible(), false);
  assert.equal(await frame('legacy').isVisible(), false);
  assert.match(await frame('a1').locator('.canvas-origin').innerText(), /A.*设计任务 A/);
  assert.match(await frame('a1').locator('.canvas-origin').getAttribute('title'), /G:\/Projects\/A/);
  assert.equal(await frame('a1').locator('.rb-block-title').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return range.getBoundingClientRect().width <= node.getBoundingClientRect().width + 1;
  }), true, 'Long idea titles must wrap inside their existing presentation');
  await task.selectOption('thread:ta');
  assert.equal(await frame('other-task').isVisible(), false);
  await frame('a2').locator('.canvas-card-drag').dblclick();
  await frame('a2').locator('.canvas-native-actions button').click();
  const text = page.locator('.canvas-native-editor[data-object-id="a2"] .canvas-native-text');
  await text.fill('跨工作区切换时保留这个未提交草稿');
  await page.keyboard.press('Escape');
  await workspace.selectOption('workspace:g:/projects/b');
  assert.equal(await frame('a1').isVisible(), false);
  assert.equal(await frame('b').isVisible(), true);
  await workspace.selectOption('workspace:g:/projects/a');
  await frame('a2').locator('.canvas-card-drag').dblclick();
  await frame('a2').locator('.canvas-native-actions button').click();
  assert.equal(await text.inputValue(), '跨工作区切换时保留这个未提交草稿');
  await page.keyboard.press('Escape');
  await workspace.selectOption('unsorted');
  assert.equal(await frame('legacy').isVisible(), true);
  assert.equal(await frame('reconnect').isVisible(), true);
  assert.equal(await frame('a1').isVisible(), false);
  await frame('reconnect').locator('.canvas-card-drag').click();
  assert.equal(await frame('reconnect').evaluate(node => node.classList.contains('is-selected')), true);
  await page.evaluate(() => window.canvas.setOverviewMeta({bindings:[...window.bindings,{source_id:window.reconnectSource,thread_id:'11111111-1111-4111-8111-111111111111',cwd:'G:/Projects/A',label:'已重连'}]}));
  assert.equal(await workspace.inputValue(), 'workspace:g:/projects/a');
  assert.equal(await frame('reconnect').isVisible(), true);
  assert.equal(await frame('reconnect').evaluate(node => node.classList.contains('is-selected')), true);
  await page.evaluate(() => window.canvas.selectObject('b'));
  assert.equal(await workspace.inputValue(), 'workspace:g:/projects/b');
  assert.equal(await frame('b').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => window.mutations), []);
  assert.equal(await page.evaluate(() => window.fixture.canvas.compositions[0].members.join(',')), 'a1,a2');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#canvas-workspace-select')?.value === 'workspace:g:/projects/b');
  assert.equal(await frame('b').isVisible(), true);
  await workspace.selectOption('workspace:g:/projects/a');
  await frame('a2').locator('.canvas-card-drag').dblclick();
  await frame('a2').locator('.canvas-native-actions button').click();
  assert.equal(await text.inputValue(), '跨工作区切换时保留这个未提交草稿');
  await page.keyboard.press('Escape');
  for (const width of [1360, 880]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await workspace.evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node; }), true, `Workspace control covered at ${width}px`);
    assert.equal(await task.evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node; }), true, `Task control covered at ${width}px`);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.screenshot({ path: path.join(output, 'workspace-canvas.png'), fullPage: true });
  assert.deepEqual(report.errors, []);
  report.pass = true;
  report.checks = ['same-name projects remain separate', 'tasks within one workspace remain separate', 'captured source is visible', 'unknown legacy records stay unsorted', 'reconnected selection follows its new workspace', 'draft survives scope changes and page reload', 'navigation reveals exact target workspace', 'scope and composition data retained without backend writes'];
} catch (error) {
  report.error = error.stack;
  if (page) {
    report.dom = await page.evaluate(() => ({ workspace: document.querySelector('#canvas-workspace-select')?.value, task: document.querySelector('#canvas-task-select')?.value,
      elements: ['#host', '.canvas-workspace', '.canvas-viewport', '.canvas-graph', '.x6-node', '.canvas-frame'].map(selector => { const node = document.querySelector(selector); if (!node) return { selector }; const r = node.getBoundingClientRect(), css = getComputedStyle(node); return { selector, x:r.x,y:r.y,width:r.width,height:r.height,display:css.display,visibility:css.visibility }; }) }));
    await page.screenshot({ path: path.join(output, 'workspace-canvas-failed.png'), fullPage: true });
  }
}
finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.writeFileSync(path.join(output, 'workspace-canvas-result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
