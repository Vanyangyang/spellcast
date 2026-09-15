/** Native UI recovery checks. Network delays/failures below are explicit DIAG_ONLY fault injection. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts/everything-canvas/recovery-checks'); await mkdir(output, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9337');
const native = browser.contexts()[0].pages().find(page => page.url() === 'http://tauri.localhost/'); assert(native);
native.setDefaultTimeout(10000);
const port = await native.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
const base = 'http://127.0.0.1:' + port, source = 'verification:everything-canvas-20260907', id = 'everything-recovery-20260907';
const result = { scope: 'owned native UI fixture; DIAG_ONLY injected transport failures and delays' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 6000) { const start = Date.now(); do { const value = await read(); if (value) return value; await sleep(100); } while (Date.now() - start < timeout); throw new Error('Recovery condition did not become true.'); }
async function board() { return (await fetch(base + '/api/board')).json(); }
async function reply() { return (await board()).replies.find(reply => reply.id === id); }
async function post(url, data) { const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const value = await response.json(); if (!response.ok) throw new Error(value.error || String(response.status)); return value; }
async function publish(label) { const old = await reply(); return post('/api/artifacts', { source_id: source, source_label: '本机恢复验证', reply_id: id, block_id: 'work', title: '恢复验证样本', description: label, directory: path.join(root, 'artifacts/everything-canvas/recovery-work'), entry: 'index.html', ...(old ? { expected_revision: old.revision } : {}) }); }
async function frame() { return (await native.locator('.canvas-reader iframe').elementHandle()).contentFrame(); }
async function sourceEditor() { const details = native.locator('.canvas-reader .artifact-sources'); if (!await details.evaluate(d => d.open)) await details.locator(':scope > summary').click(); const editor = details.locator('.artifact-source-editor'); await until(async () => await editor.count() && await editor.isEnabled()); return { details, editor }; }
let cacheKey;
try {
  const feedback = await (await fetch(base + '/api/feedback')).json(); assert(!feedback.bindings.some(binding => binding.source_id === source), 'This fault fixture must remain unbound to an Agent task.');
  await publish('独立的本机恢复与隔离检查。');
  const dialog = native.locator('.canvas-reader'); if (await dialog.evaluate(d => d.open)) await dialog.locator(':scope > header button').click();
  const object = (await board()).canvas.objects.find(o => o.content.type === 'reply' && o.content.id === id); assert(object);
  cacheKey = 'spellcast.artifact-state.' + JSON.stringify([object.id, 'work']);
  await native.locator('.canvas-jump').selectOption(object.id);
  let work = await frame(); await work.locator('#amount').waitFor();
  await work.locator('#note').fill('RECOVERY_SAVED_NOTE'); await until(async () => (await reply()).blocks[0].state?.note === 'RECOVERY_SAVED_NOTE');
  await native.route('**/api/artifacts/state', route => route.abort('connectionfailed'));
  await work.locator('#amount').focus(); await work.locator('#amount').press('Home'); for (let i = 0; i < 40; i++) await work.locator('#amount').press('ArrowRight');
  await work.locator('#note').fill('RECOVERY_UNSAVED_NOTE');
  await until(() => native.getByRole('button', { name: 'Inspect unsaved parameters', exact: true }).isVisible());
  await publish('Source updated while a simulated transport failure left local parameters unsaved.');
  await native.unroute('**/api/artifacts/state');
  const retained = await native.evaluate(key => JSON.parse(localStorage.getItem(key)), cacheKey);
  assert.equal(retained.state.amount, 40); assert.equal(retained.state.note, 'RECOVERY_UNSAVED_NOTE');
  await native.getByRole('button', { name: 'Inspect unsaved parameters', exact: true }).click();
  const mergedEditor = native.locator('.canvas-reader .artifact-sources textarea'); await mergedEditor.waitFor();
  const merge = JSON.parse(await mergedEditor.inputValue()); assert.equal(merge.amount, 40); assert.equal(merge.note, 'RECOVERY_UNSAVED_NOTE');
  merge.merged = true; await mergedEditor.fill(JSON.stringify(merge, null, 2));
  assert(await native.evaluate(key => Boolean(JSON.parse(localStorage.getItem(key)).merge_draft), cacheKey));
  await native.getByRole('button', { name: 'Save merged parameters', exact: true }).click();
  await until(async () => (await reply()).blocks[0].state?.merged === true);
  await native.locator('.canvas-reader .artifact-controls').getByRole('button', { name: 'Run', exact: true }).click();
  work = await frame(); await work.locator('#note').waitFor(); assert.equal(await work.locator('#note').inputValue(), 'RECOVERY_UNSAVED_NOTE');
  assert.equal(await work.locator('#amount').inputValue(), '40'); result.parameterRecovery = true;

  let panel = await sourceEditor();
  const rawRoute = '**/api/artifacts/*/file?name=second.txt';
  await native.route(rawRoute, async route => { await sleep(450); await route.continue(); });
  await panel.details.getByRole('combobox', { name: 'Asset file', exact: true }).selectOption('second.txt');
  assert.equal(await panel.editor.inputValue(), ''); assert(await panel.details.getByRole('button', { name: 'Save source', exact: true }).isDisabled());
  await until(async () => (await panel.editor.inputValue()).trim() === 'SECOND_FILE_SENTINEL'); await native.unroute(rawRoute);
  await panel.details.getByRole('combobox', { name: 'Asset file', exact: true }).selectOption('index.html');
  await until(async () => await panel.editor.isEnabled() && (await panel.editor.inputValue()).includes('恢复验证样本'));
  result.fileSwitchClearsStaleInput = true;
  const original = await panel.editor.inputValue(), edited = original.replaceAll('恢复验证样本', '恢复验证：源码已修改');
  await panel.editor.fill(edited); await panel.details.getByRole('button', { name: 'Save source', exact: true }).click();
  await native.frameLocator('.canvas-reader iframe').locator('h1').filter({ hasText: '恢复验证：源码已修改' }).waitFor();
  const afterEdit = await reply(), editedBundle = afterEdit.blocks[0].bundle_id;
  assert.equal(afterEdit.blocks[0].state.note, 'RECOVERY_UNSAVED_NOTE'); assert.equal(afterEdit.blocks[0].state.amount, 40); result.sourceEditPreservesParameters = true;
  panel = await sourceEditor(); await until(async () => (await panel.editor.inputValue()).includes('恢复验证：源码已修改'));
  const draft = edited.replace('恢复验证：源码已修改', 'RECOVERY_UNSAVED_SOURCE_DRAFT'); await panel.editor.fill(draft);
  await publish('A newer source revision arrived while an older source draft was open.');
  await native.locator('.canvas-reader .artifact-source-stale').waitFor();
  assert.equal(await panel.editor.inputValue(), draft); assert(await panel.details.getByRole('button', { name: 'Save source', exact: true }).isDisabled());
  const sourceDraftKey = 'spellcast.artifact-source.' + editedBundle + '.index.html';
  assert.equal(await native.evaluate(key => localStorage.getItem(key), sourceDraftKey), draft);
  await native.getByRole('button', { name: 'Open latest source', exact: true }).click();
  panel = await sourceEditor(); await until(async () => (await panel.editor.inputValue()).includes('恢复验证样本'));
  await panel.details.getByRole('combobox', { name: 'Past version', exact: true }).selectOption(editedBundle);
  await panel.details.getByRole('button', { name: 'Restore this version', exact: true }).click();
  await until(async () => (await reply()).blocks[0].bundle_id === editedBundle);
  panel = await sourceEditor(); await until(async () => (await panel.editor.inputValue()) === draft);
  assert.equal((await reply()).blocks[0].state.amount, 40); result.sourceDraftAndVersionRecovery = true;
  // This exact test draft has been recovered and checked; leave its saved source unmodified.
  await native.evaluate(({ key, expected }) => { if (localStorage.getItem(key) === expected) localStorage.removeItem(key); }, { key: sourceDraftKey, expected: draft });
  await panel.editor.fill(edited);

  work = await frame(); await work.locator('#invalid').click(); assert.equal(await work.locator('#status').innerText(), 'invalid state rejected');
  await work.locator('#host').click(); await until(async () => (await work.locator('#status').innerText()) === 'host request rejected');
  result.invalidStateAndHostFetchRejected = true;
  await native.evaluate(() => { window.__artifactPolicyViolations = []; document.addEventListener('securitypolicyviolation', event => window.__artifactPolicyViolations.push({ directive: event.effectiveDirective, url: event.blockedURI })); });
  let escaped = 0; await native.route('https://example.invalid/**', route => { escaped++; return route.abort(); });
  await work.locator('#navigate').click(); await until(() => native.evaluate(() => window.__artifactPolicyViolations.some(event => event.directive === 'frame-src')));
  assert.equal(escaped, 0, 'Frame navigation reached the network instead of being blocked by parent CSP.'); await native.unroute('https://example.invalid/**');
  result.frameNavigationRejected = true;
  await native.locator('.canvas-reader .artifact-controls').getByRole('button', { name: 'Restart', exact: true }).click();
  work = await frame(); await work.locator('#note').waitFor(); assert.equal(await work.locator('#note').inputValue(), 'RECOVERY_UNSAVED_NOTE');
  result.restartedAfterBlockedNavigation = true;
  await native.screenshot({ path: path.join(output, 'recovered.png') });
  result.receipts = (await (await fetch(base + '/api/feedback')).json()).pending.filter(event => event.source_id === source).map(event => event.seq);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  console.log('PASS: native source, parameter and version recovery; DIAG_ONLY fault injection and isolation probes.'); process.exit(0);
} catch (error) {
  await native.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await writeFile(path.join(output, 'failure.txt'), String(error.stack ?? error)); console.error(error.stack ?? error); process.exit(1);
}
