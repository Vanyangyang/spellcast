/** Isolated browser check for the 3D card and native select palettes. */
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
const output = path.join(root, 'artifacts/workbench-20260914');
fs.mkdirSync(output, { recursive: true });
await build({ stdin: { contents: "import './src/styles.css'; import './src/theme.css'; export { mountSpatial } from './src/forms/spatial.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', outfile: path.join(output, 'spatial-contrast.js'), external: ['/fonts/*'] });

const server = createServer((request, response) => {
  const url = request.url || '';
  if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(url)) { response.setHeader('Content-Type', 'font/woff2'); response.end(fs.readFileSync(path.join(root, 'public', url.slice(1)))); return; }
  const file = url === '/spatial-contrast.js' ? 'spatial-contrast.js' : url === '/spatial-contrast.css' ? 'spatial-contrast.css' : null;
  if (file) { response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(fs.readFileSync(path.join(output, file))); return; }
  response.setHeader('Content-Type', 'text/html;charset=utf-8');
  response.end(`<!doctype html><html><head><link rel="stylesheet" href="/spatial-contrast.css"></head><body class="mode-focus" data-theme="dark">
    <div id="stage"><canvas id="spatial"></canvas></div><aside class="inspector"><p class="eyebrow">这块碎片</p><h2>本地优先</h2>
    <div class="ins-row"><select id="ins-kind"><option>点子</option><option selected>问题</option><option>张力</option></select>
    <select id="ins-weight"><option>未成形</option><option selected>记下</option></select></div></aside>
    <script type="module">import {mountSpatial} from '/spatial-contrast.js';
      const note=(id,title,kind,x,z)=>({id,title,body:'画布里的文字和控件都需要清晰可读。',kind,weight:'note',x,y:0,z,revision:1});
      const board={nodes:[note('a','主题连续性','insight',-4,0),note('b','多 Agent 接入','idea',0,1),note('c','本地优先','risk',4,0)],edges:[],replies:[],messages:[],canvas:{objects:[],items:[]}};
      window.spatial=mountSpatial(document.querySelector('#spatial'),board,'c',()=>{});
    </script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server', '--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 1125, height: 760 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(window.spatial));
  await page.mouse.move(560, 380);
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(500);
  const palette = async () => page.locator('#ins-kind option').first().evaluate(node => {
    const css = getComputedStyle(node); return { color: css.color, background: css.backgroundColor, scheme: css.colorScheme };
  });
  assert.deepEqual(await palette(), { color: 'rgb(244, 241, 234)', background: 'rgb(25, 28, 37)', scheme: 'dark' });
  await page.screenshot({ path: path.join(output, 'spatial-contrast-dark.png') });
  await page.locator('#ins-kind').click();
  await page.screenshot({ path: path.join(output, 'spatial-contrast-select-open.png') });
  await page.keyboard.press('Escape');
  await page.locator('body').evaluate(node => { node.dataset.theme = 'light'; document.documentElement.style.colorScheme = 'light'; });
  assert.deepEqual(await palette(), { color: 'rgb(28, 26, 22)', background: 'rgb(255, 252, 247)', scheme: 'light' });
  await page.screenshot({ path: path.join(output, 'spatial-contrast-light.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, screenshots: ['spatial-contrast-dark.png', 'spatial-contrast-select-open.png', 'spatial-contrast-light.png'], palette: 'dark and light select options readable' }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
