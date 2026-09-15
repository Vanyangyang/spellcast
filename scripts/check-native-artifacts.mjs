/** Real-input checks against the eight named example works in a running native Spellcast window. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts/everything-canvas/native-checks'); await mkdir(output, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9337');
const native = browser.contexts()[0].pages().find(page => page.url() === 'http://tauri.localhost/');
assert(native, 'Use the native Windows WebView, not the web preview.');
native.setDefaultTimeout(12000);
const port = await native.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
const base = 'http://127.0.0.1:' + port;
const report = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 6000) { const start = Date.now(); do { const result = await read(); if (result) return result; await sleep(100); } while (Date.now() - start < timeout); throw new Error('Condition did not become true.'); }
async function reply(name) { const board = await (await fetch(base + '/api/board')).json(); return board.replies.find(reply => reply.id === 'everything-' + name + '-20260907'); }
async function saved(name, predicate) { return until(async () => { const value = await reply(name); return value && predicate(value.blocks[0].state ?? {}) ? value : false; }); }
async function open(name, selector) {
  const dialog = native.locator('.canvas-reader');
  if (await dialog.evaluate(dialog => dialog.open)) await dialog.locator(':scope > header button').click();
  const board = await (await fetch(base + '/api/board')).json();
  const object = board.canvas.objects.find(o => o.content.type === 'reply' && o.content.id === 'everything-' + name + '-20260907'); assert(object);
  await native.locator('.canvas-jump').selectOption(object.id);
  const iframe = dialog.locator('iframe'); await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator(selector).first().waitFor({ state: 'attached' });
  return frame;
}
async function range(frame, selector, value) {
  const input = frame.locator(selector); const spec = await input.evaluate(input => ({ min: Number(input.min), step: Number(input.step) || 1 }));
  await input.focus(); await input.press('Home');
  const steps = Math.round((value - spec.min) / spec.step); assert(steps >= 0 && steps <= 1000);
  for (let i = 0; i < steps; i++) await input.press('ArrowRight');
  assert.equal(Number(await input.inputValue()), value);
}
async function capture(name) { await native.screenshot({ path: path.join(output, name + '.png') }); }

const checks = {
  async search() {
    const frame = await open('search', '#flow svg'); await frame.getByRole('button', { name: '从头开始', exact: true }).click();
    await frame.getByRole('button', { name: '下一步', exact: true }).click(); await frame.getByRole('button', { name: '下一步', exact: true }).click();
    await frame.getByRole('button', { name: '格子 10', exact: true }).click();
    await saved('search', state => state.step === 2 && state.cell === 10);
    await frame.getByRole('button', { name: '播放', exact: true }).click(); await until(async () => Number((await frame.locator('#step').innerText()).split('/')[0]) >= 4);
    await frame.getByRole('button', { name: '暂停', exact: true }).click(); await capture('search');
    return { grid: await frame.locator('#grid [role=button]').count(), mermaid: true, actualStep: await frame.locator('#step').innerText() };
  },
  async data() {
    const frame = await open('data', '.tabulator-row'); await frame.locator('#kind').selectOption('all'); await frame.locator('#kind').selectOption('住宅');
    assert.equal(await frame.locator('#total').innerText(), '608'); assert.equal(await frame.locator('.tabulator-row').count(), 3);
    const row = frame.locator('.tabulator-row').filter({ hasText: '庭院公寓' });
    if (!await row.evaluate(row => row.classList.contains('tabulator-selected'))) await row.click();
    await saved('data', state => state.kind === '住宅' && state.selected.includes('courtyard'));
    await frame.locator('.tabulator-col[tabulator-field="water"]').click();
    await saved('data', state => state.sort?.[0]?.column === 'water'); await capture('data');
    return { rows: 3, total: 608, selected: 'courtyard', chart: await frame.locator('#chart svg').count() };
  },
  async math() {
    const frame = await open('math', '.katex'); await range(frame, '#length', 3);
    const period = parseFloat(await frame.locator('#period').innerText()); assert(Math.abs(period - 3.474609) < .001);
    await frame.getByRole('button', { name: '选择摆锤', exact: true }).click(); await saved('math', state => state.length === 3 && state.selection?.ids?.[0] === 'pendulum-bob');
    await frame.getByRole('button', { name: '播放', exact: true }).click(); await until(async () => parseFloat((await frame.locator('#phase').innerText()).replace('t = ', '')) > .15);
    await frame.getByRole('button', { name: '暂停', exact: true }).click(); await capture('math');
    return { length: 3, period, mathml: await frame.locator('math').count() };
  },
  async assembly() {
    const frame = await open('assembly', '#parts button'); assert.equal(await frame.locator('#parts button').count(), 5);
    await frame.locator('[data-part=rotor]').click(); await range(frame, '#explode', 100); await frame.locator('#side').click();
    await saved('assembly', state => state.selected === 'rotor' && state.explode === 100 && state.camera[0] > state.target[0] + 2 && Math.abs(state.camera[2] - state.target[2]) < .001);
    const before = (await reply('assembly')).blocks[0].state.camera;
    await frame.locator('#viewer canvas').scrollIntoViewIfNeeded(); const rect = await frame.locator('#viewer canvas').boundingBox();
    await native.mouse.move(rect.x + rect.width * .45, rect.y + rect.height * .5); await native.mouse.down();
    await native.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .55, { steps: 8 }); await native.mouse.up();
    await saved('assembly', state => Math.abs(state.camera[0] - before[0]) > .01 || Math.abs(state.camera[2] - before[2]) > .01);
    await frame.locator('#fit').click();
    const gl = await frame.locator('canvas').evaluate(canvas => { const gl = canvas.getContext('webgl2'); return gl && !gl.isContextLost() ? gl.getParameter(gl.VERSION) : null; }); assert(gl);
    await capture('assembly'); return { parts: 5, selected: 'rotor', explode: 100, webgl: gl, realDrag: true };
  },
  async image() {
    const frame = await open('image', '#image img'); await frame.locator('#view').selectOption('original'); assert.equal(await frame.locator('#comparison').isVisible(), false); assert.equal(await frame.locator('#target-label').isVisible(), false);
    await frame.locator('#view').selectOption('compare'); await frame.locator('#target').selectOption('amber'); await range(frame, '#split', 35);
    for (const [id, value] of [['x','20'],['y','15'],['w','60'],['h','40']]) await frame.locator('#' + id).fill(value);
    await frame.locator('#apply').click(); await saved('image', state => state.region?.x === .2 && state.region?.width === .6 && state.target === 'amber');
    await frame.locator('#image').scrollIntoViewIfNeeded(); const rect = await frame.locator('#image').boundingBox();
    await native.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .25); await native.mouse.down();
    await native.mouse.move(rect.x + rect.width * .6, rect.y + rect.height * .5, { steps: 6 }); await native.mouse.up();
    const result = await saved('image', state => state.region && Math.abs(state.region.x - .3) < .02 && Math.abs(state.region.width - .3) < .02);
    assert(Math.abs(Number(await frame.locator('#x').inputValue()) - result.blocks[0].state.region.x * 100) < .1);
    assert(Math.abs(Number(await frame.locator('#w').inputValue()) - result.blocks[0].state.region.width * 100) < .1);
    assert.equal(result.blocks[0].state.selection.coordinate_space, 'normalized-image'); await capture('image');
    return { comparison: 35, asset: result.blocks[0].state.selection.asset, region: result.blocks[0].state.region, realDrag: true };
  },
  async media() {
    const frame = await open('media', '#wave line'); assert.equal(await frame.locator('#wave line').count(), 120);
    await frame.locator('#asset').selectOption('video');
    const duration = await until(() => frame.locator('#video').evaluate(video => Number.isFinite(video.duration) && video.duration)); assert(Math.abs(duration - 8) < .1);
    await frame.locator('#play').click(); await until(() => frame.locator('#video').evaluate(video => video.currentTime > .2)); await frame.locator('#pause').click();
    await frame.locator('#start').fill('1.2'); await frame.locator('#end').fill('3.4'); await frame.locator('#select').click();
    await saved('media', state => state.selection?.time_range?.start === 1.2 && state.selection.time_range.end === 3.4);
    await frame.locator('#loop').click(); let last = 0;
    await until(async () => { const time = await frame.locator('#video').evaluate(video => video.currentTime); const wrapped = time < last - .4; last = time; return wrapped; }, 5500);
    await frame.locator('#loop').click(); await frame.locator('#pause').click();
    await frame.locator('#asset').selectOption('audio'); assert.equal(await frame.locator('#video').isVisible(), false); assert.equal(await frame.locator('#start').inputValue(), '1');
    await frame.locator('#play').click(); await until(() => frame.locator('#audio').evaluate(audio => audio.currentTime > .2)); await frame.locator('#pause').click();
    await frame.locator('#start').fill('2'); await frame.locator('#end').fill('4'); await frame.locator('#select').click(); await saved('media', state => state.asset === 'audio' && state.selection?.time_range?.start === 2);
    await capture('media'); return { duration, videoPlayed: true, audioPlayed: true, loopWrapped: true, modeCleared: true };
  },
  async tool() {
    const frame = await open('tool', '#diagram'); for (const [id, value] of [['area',80],['rain',40],['efficiency',75],['capacity',5000]]) await range(frame, '#' + id, value);
    const input = frame.locator('#note'); const note = await input.inputValue() || '保留这条观察：先比较不同屋顶面积。'; if (!await input.inputValue()) await input.fill(note);
    await frame.getByRole('button', { name: '选择储水箱', exact: true }).click(); await saved('tool', state => state.note === note && state.selection?.ids?.[0] === 'tank');
    assert.equal((await frame.locator('#collected').innerText()).replaceAll(',', ''), '2400');
    await capture('tool'); return { collected: 2400, notePreserved: true, selected: 'tank' };
  },
  async report() {
    const frame = await open('report', '#report h2'); assert.equal(await frame.locator('#report h2').count(), 4); assert.equal(await frame.locator('#report math').count(), 1);
    await frame.locator('#section-2').click(); await saved('report', state => state.selection?.ids?.[0] === 'section-2');
    const artifact = (await reply('report')).blocks[0].bundle_id, file = await fetch(base + '/api/artifacts/' + artifact + '/file?name=rain-garden-report.pdf');
    const bytes = new Uint8Array(await file.arrayBuffer()); assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF'); await capture('report');
    return { chapters: 4, mathml: true, pdfBytes: bytes.length, selected: 'section-2' };
  },
};

try {
  const names = process.argv.slice(2); for (const name of names.length ? names : Object.keys(checks)) {
    assert(checks[name], 'Unknown example: ' + name); const start = Date.now(); const result = await checks[name]();
    report.push({ name, passed: true, elapsed_ms: Date.now() - start, ...result });
    console.log(JSON.stringify(report.at(-1))); await writeFile(path.join(output, 'latest-checks.json'), JSON.stringify(report, null, 2));
  }
  console.log('PASS: native input and persisted state for ' + report.length + ' work(s).');
  process.exit(0); // Close only this CDP client; leave the user's native window running.
} catch (error) {
  console.error(error.stack ?? error); await writeFile(path.join(output, 'latest-failure.txt'), String(error.stack ?? error)); process.exit(1);
}
