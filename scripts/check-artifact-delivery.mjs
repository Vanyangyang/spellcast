/** Native sizing, downloads and restart verification for the eight owned example works. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts/everything-canvas/delivery-checks'); await mkdir(output, { recursive: true });
const downloads = path.join(output, 'downloads'); await mkdir(downloads, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9337');
const native = browser.contexts()[0].pages().find(page => page.url() === 'http://tauri.localhost/'); assert(native);
native.setDefaultTimeout(10000);
const port = await native.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
const base = 'http://127.0.0.1:' + port;
const names = ['search', 'data', 'math', 'assembly', 'image', 'media', 'tool', 'report'];
const selectors = ['#flow svg', '.tabulator-row', '.katex', '#parts button', '#image img', '#wave line', '#diagram', '#report h2'];
const board = async () => (await fetch(base + '/api/board')).json();
const snapshot = state => ({ nodes: state.nodes, replies: state.replies });
async function open(name) {
  const dialog = native.locator('.canvas-reader'); if (await dialog.evaluate(d => d.open)) await dialog.locator(':scope > header button').click();
  const object = (await board()).canvas.objects.find(o => o.content.type === 'reply' && o.content.id === 'everything-' + name + '-20260907'); assert(object);
  await native.locator('.canvas-jump').selectOption(object.id);
  const frame = await (await dialog.locator('iframe').elementHandle()).contentFrame();
  await frame.locator(selectors[names.indexOf(name)]).first().waitFor({ state: 'attached' });
  return frame;
}
const size = value => native.evaluate(value => window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', { label: 'main', value }), value);
const result = {};
try {
  if (process.argv.includes('--after-restart')) {
    const before = JSON.parse(await readFile(path.join(output, 'before-restart.json'), 'utf8'));
    assert.deepEqual(snapshot(await board()), before);
    for (const name of names) await open(name);
    const frame = await open('tool'); assert.equal(await frame.locator('#note').inputValue(), before.replies.find(r => r.id === 'everything-tool-20260907').blocks[0].state.note);
    result.diskStateAfterNormalRestart = true; result.allEightRenderAfterRestart = true;
    await writeFile(path.join(output, 'after-restart.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(0);
  }
  const cdp = await browser.newBrowserCDPSession();
  // WebView2 requires a native Windows path; a slash-separated CDP path cancels at completion.
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  async function download(click) {
    const pending = native.waitForEvent('download', { timeout: 15000 }); await click(); const item = await pending;
    assert.equal(await item.failure(), null); const file = path.join(downloads, item.suggestedFilename());
    assert((await stat(file)).size > 0); return file;
  }
  result.narrow = [];
  await size({ Logical: { width: 880, height: 640 } });
  for (const name of names) {
    const frame = await open(name); const dimensions = await frame.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert(dimensions.scroll <= dimensions.width + 1, name + ' overflows narrow frame');
    await native.screenshot({ path: path.join(output, name + '-narrow.png') }); result.narrow.push({ name, ...dimensions });
  }
  await size({ Physical: { width: 1320, height: 860 } });
  let frame = await open('tool');
  const saved = (await board()).replies.find(r => r.id === 'everything-tool-20260907').blocks[0].state;
  await native.locator('.canvas-reader .artifact-controls').getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal(await native.locator('.canvas-reader iframe').count(), 0);
  await native.locator('.canvas-reader .artifact-controls').getByRole('button', { name: 'Run', exact: true }).click();
  frame = await (await native.locator('.canvas-reader iframe').elementHandle()).contentFrame();
  await frame.locator('#note').waitFor(); assert.equal(await frame.locator('#note').inputValue(), saved.note); result.stopRunRestores = true;
  const csv = await download(() => frame.locator('#csv').click()); assert.match(await readFile(csv, 'utf8'), /collected,2400/);
  const svg = await download(() => frame.locator('#svg').click()); assert.match(await readFile(svg, 'utf8'), /<svg/);
  const zip = await download(() => native.locator('.canvas-reader').getByRole('button', { name: 'Export work', exact: true }).click());
  const files = unzipSync(new Uint8Array(await readFile(zip)));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files['__spellcast-export/state.json'])), saved);
  assert(files['__spellcast-export/manifest.json']); assert(files['__spellcast-export/original-entry.html']);
  assert(Object.keys(files).some(name => name.startsWith('source/'))); assert(files['__spellcast.js']);
  const extracted = path.join(output, 'standalone-tool'); await mkdir(extracted, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) { const target = path.resolve(extracted, name); assert(target.startsWith(extracted + path.sep)); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); }
  frame = await open('report'); const pdf = await download(() => frame.getByRole('link', { name: '下载 PDF', exact: true }).click());
  assert.equal((await readFile(pdf)).subarray(0, 4).toString(), '%PDF');
  result.downloads = { csv, svg, zip, pdf, zipEntries: Object.keys(files).length, extracted };
  const standaloneBrowser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await standaloneBrowser.newPage();
    await page.goto((process.env.SPELLCAST_PREVIEW ?? 'http://127.0.0.1:47193') + '/artifacts/everything-canvas/delivery-checks/standalone-tool/index.html');
    await page.locator('#collected').waitFor(); assert.equal((await page.locator('#collected').innerText()).replaceAll(',', ''), '2400'); assert.equal(await page.locator('#note').inputValue(), saved.note);
    result.standaloneZipRestores = true;
  } finally { await standaloneBrowser.close(); }
  await writeFile(path.join(output, 'before-restart.json'), JSON.stringify(snapshot(await board()), null, 2));
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(0);
} catch (error) {
  await size({ Physical: { width: 1320, height: 860 } }).catch(() => {});
  console.error(error.stack ?? error); process.exit(1);
}
