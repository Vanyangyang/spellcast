/** Native phase-one regression. Only use an isolated test bridge; HTTP prepares unbound fixtures.
 * Real input tests the UI. Aborted requests are DIAG_ONLY fault injection. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let playwright; try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? path.join(root, 'artifacts/atomic-phase1-20260909'));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9338');
const native = browser.contexts()[0].pages().find(p => p.url() === 'http://tauri.localhost/'); assert(native, 'Use the native WebView.');
native.setDefaultTimeout(10000);
const port = await native.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(s => s.port));
assert.equal(port, Number(process.env.SPELLCAST_TEST_PORT ?? 47198), 'Use the isolated bridge, never the user database.'); assert.notEqual(port, 47194);
async function request(url, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:' + port + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
}
const board = () => request('/api/board');
const toolbar = native.locator('.canvas-toolbar');
const frame = key => native.locator('.canvas-frame[data-item-id="' + key + '"]');
const camera = () => native.locator('.canvas-viewport').evaluate(v => { const m = v.querySelector('.x6-graph-svg-viewport').transform.baseVal.consolidate().matrix; return { scale: m.a, x: (v.clientWidth / 2 - m.e) / m.a, y: (v.clientHeight / 2 - m.f) / m.a }; });
const drafts = () => native.evaluate(() => JSON.parse(localStorage.getItem('spellcast.reply-drafts.v1') ?? '[]'));
async function until(read, label = 'condition', timeout = 10000) { const start = Date.now(); do { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() - start < timeout); throw Error(label + ' did not settle.'); }
const shown = async key => Boolean((await board()).canvas.items.find(p => p.item_id === key && !p.removed));
const pose = async key => (await board()).canvas.items.find(p => p.item_id === key);
// Playwright's frame locator hit-test misses SVG-scaled iframe coordinates. Map the observed rectangle, then send real pointer input.
async function workClick(work, selector) {
  const child = await work.locator(selector).evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const host = await (await work.frameElement()).evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, scale: r.width / el.offsetWidth, left: el.clientLeft, top: el.clientTop }; });
  await native.mouse.click(host.x + (host.left + child.x) * host.scale, host.y + (host.top + child.y) * host.scale);
}
async function select(key) {
  const done = toolbar.getByRole('button', { name: 'Back to canvas', exact: true }); if (await done.count()) await done.click();
  await until(() => toolbar.locator('option[value="' + key + '"]').count(), 'published object');
  await toolbar.getByRole('button', { name: 'All items', exact: true }).click();
  await native.locator('.canvas-overview-card[data-item-id="' + key + '"]').getByRole('button', { name: 'Locate', exact: true }).click();
  await frame(key).locator('.canvas-card-drag').click();
  assert(await frame(key).evaluate(f => f.classList.contains('is-selected')));
}
async function restore(key) {
  await toolbar.getByRole('button', { name: 'Removed', exact: true }).click();
  await native.locator('.canvas-removed [data-item-id="' + key + '"]').getByRole('button', { name: 'Restore to canvas', exact: true }).click();
  await until(() => shown(key), 'restored object');
}
const result = { native: true, fixtureSetup: 'HTTP, unbound source', faultInjection: 'DIAG_ONLY aborts', checks: [] };
const pass = name => { result.checks.push(name); console.log('PASS ' + name); };
try {
  if (process.argv.includes('--verify-restart')) {
    const saved = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')), current = await board();
    for (const o of saved.expected.objects) assert.deepEqual(current.canvas.objects.find(x => x.id === o.id), o);
    for (const p of saved.expected.items) assert.deepEqual(current.canvas.items.find(x => x.item_id === p.item_id), p);
    for (const r of saved.expected.replies) assert.deepEqual(current.replies.find(x => x.id === r.id), r);
    assert((await drafts()).some(d => d.object_id === saved.textObject && d.text === saved.draftMarker));
    await toolbar.waitFor(); await frame(saved.textObject).waitFor();
    await select(saved.textObject); assert.equal(await native.locator('#input').inputValue(), saved.draftMarker);
    const workReply = saved.expected.replies.find(r => r.blocks[0].type === 'artifact');
    const workObject = saved.expected.objects.find(o => o.content.type === 'reply' && o.content.id === workReply.id);
    await select(workObject.id); await toolbar.getByRole('button', { name: 'Work inside', exact: true }).click();
    const work = await (await frame(workObject.id).locator('iframe').elementHandle()).contentFrame();
    await until(async () => await work.locator('#note').inputValue() === workReply.blocks[0].state.note, 'work after process restart');
    await toolbar.getByRole('button', { name: 'Back to canvas', exact: true }).click();
    saved.restart = true; await writeFile(path.join(output, 'result.json'), JSON.stringify(saved, null, 2));
    console.log('PASS native process restart preserved identities, removed placement, content, work state and draft.'); process.exit(0);
  }
  await native.locator('#locale').selectOption('zh-CN'); await native.locator('#locale').selectOption('en');
  if (await native.locator('#mode-focus').isVisible()) await native.locator('#mode-focus').click();
  await toolbar.waitFor();
  const before = await board(), suffix = Date.now(), source = 'verification:atomic-phase1:' + suffix;
  assert(!(await request('/api/feedback')).bindings.some(b => b.source_id === source));
  const textId = 'atomic-text-' + suffix, workId = 'atomic-work-' + suffix, marker = 'UNSENT_ATOMIC_DRAFT_' + suffix;
  await request('/api/replies', 'POST', { id: textId, source_id: source, title: 'Atomic text', blocks: [{ id: 'text', type: 'text', title: 'Original title', text: 'Original text.' }] });
  const note = await request('/api/nodes', 'POST', { title: 'Atomic thought', body: 'Preserved thought.', source_id: source });
  await request('/api/artifacts', 'POST', { source_id: source, reply_id: workId, block_id: 'work', title: 'Atomic work', directory: path.join(root, 'scripts/fixtures/atomic-work'), entry: 'index.html' });
  const current = await board(), objectId = (type, id) => current.canvas.objects.find(o => o.content.type === type && o.content.id === id).id;
  const textKey = objectId('reply', textId), noteKey = objectId('node', note.id), workKey = objectId('reply', workId);
  for (const key of [textKey, noteKey, workKey]) assert.match(key, /^[0-9a-f-]{36}$/);
  assert.equal((await pose(textKey)).appearance, 'plain'); pass('opaque identity and plain initial presentation');

  await select(textKey);
  assert(await frame(textKey).locator('.canvas-frame-content').evaluate(c => c.inert));
  await frame(textKey).locator('.canvas-card-drag').dblclick({ position: { x: 20, y: 20 } });
  assert(await frame(textKey).evaluate(f => f.classList.contains('is-active'))); assert.equal(await native.locator('.canvas-reader[open]').count(), 0);
  await frame(textKey).getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = frame(textKey).locator('textarea'); await editor.fill('Edited in place.'); await editor.press('Delete');
  assert(await shown(textKey));
  await frame(textKey).getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await board()).replies.find(r => r.id === textId).blocks[0].text === 'Edited in place.', 'inline edit');
  const edited = (await board()).replies.find(r => r.id === textId);
  assert((await request('/api/feedback')).pending.some(e => e.object_id === textKey && e.object_revision === edited.revision && e.source_id === source), 'Feedback must carry the stable object and exact content revision.');
  await toolbar.getByRole('button', { name: 'Back to canvas', exact: true }).click(); pass('double-click activates inline; text input cannot remove content');

  await select(workKey); await native.keyboard.press('Enter');
  let work = await (await frame(workKey).locator('iframe').elementHandle()).contentFrame();
  await work.getByRole('textbox', { name: 'Work note', exact: true }).fill('Saved native work note');
  await workClick(work, '#increment');
  await workClick(work, '#select');
  await until(async () => { const state = (await board()).replies.find(r => r.id === workId).blocks[0].state; return state?.count === 1 && state.selection?.ids?.[0] === 'count'; }, 'saved work state and selection');
  const view = await camera();
  await workClick(work, '#note'); await native.keyboard.press('End'); await native.keyboard.press('Delete');
  const rect = await frame(workKey).locator('iframe').boundingBox(); await native.mouse.move(rect.x + 80, rect.y + 100); await native.mouse.wheel(0, 200);
  assert.deepEqual(await camera(), view); assert(await shown(workKey));
  await toolbar.getByRole('button', { name: 'Back to canvas', exact: true }).click(); pass('Enter activates sandboxed work; its typing and wheel preserve canvas');

  await select(textKey); const startPose = await pose(textKey);
  const blockedLayout = route => route.request().method() === 'POST' ? route.abort('failed') : route.continue();
  await native.route('**/api/canvas', blockedLayout); await native.keyboard.press('ArrowRight');
  await toolbar.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'visible' });
  await native.keyboard.press('Delete'); assert(await shown(textKey)); assert.deepEqual(await pose(textKey), startPose);
  await native.unroute('**/api/canvas', blockedLayout); await toolbar.getByRole('button', { name: 'Retry', exact: true }).click();
  await until(async () => (await pose(textKey)).x === startPose.x + 20, 'retained failed movement');
  pass('failed layout prevents removal and Retry preserves the local move');

  await select(textKey); await native.keyboard.press('Shift+ArrowLeft');
  await until(async () => (await pose(textKey)).width === startPose.width - 20, 'resized presentation');
  await toolbar.getByRole('button', { name: 'Card frame', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Bring to front', exact: true }).click();
  await until(async () => { const p = await pose(textKey); return p.appearance === 'card' && p.z > startPose.z; }, 'style and z');
  const rememberedPose = await pose(textKey);
  await native.keyboard.press('Delete'); assert(await shown(textKey));
  await toolbar.getByRole('button', { name: 'All items', exact: true }).click(); await native.keyboard.press('Delete'); assert(await shown(textKey)); await native.keyboard.press('Escape');
  await select(textKey);
  const composer = native.locator('#input'); await composer.fill(marker); await composer.press('Delete'); assert(await shown(textKey));
  await until(async () => (await drafts()).some(d => d.object_id === textKey && d.text === marker), 'canonical composer draft');
  await select(textKey);
  const blockedRemove = route => route.request().method() === 'DELETE' ? route.abort('failed') : route.continue();
  await native.route('**/api/canvas', blockedRemove); await native.keyboard.press('Delete');
  await until(async () => await native.locator('#app-notice').innerText() === 'Failed to fetch', 'failed removal response'); assert(await shown(textKey));
  await native.unroute('**/api/canvas', blockedRemove); await native.keyboard.press('Delete');
  await until(async () => !await shown(textKey), 'removed presentation');
  assert((await board()).replies.some(r => r.id === textId)); assert((await drafts()).some(d => d.object_id === textKey && d.text === marker));
  await native.keyboard.press('Delete'); assert(await shown(noteKey));
  await restore(textKey); assert.deepEqual({ ...await pose(textKey), revision: 0 }, { ...rememberedPose, revision: 0 });
  pass('remove/restore keep content, draft and complete placement; toolbar/modal/no-selection protected');

  await select(workKey); await native.keyboard.press('Backspace'); await until(async () => !await shown(workKey));
  await restore(workKey); await toolbar.getByRole('button', { name: 'Work inside', exact: true }).click();
  work = await (await frame(workKey).locator('iframe').elementHandle()).contentFrame();
  await until(async () => await work.locator('#count').innerText() === '1', 'restored artifact state');
  assert.equal(await work.locator('#note').inputValue(), 'Saved native work note'); pass('restored work resumes saved parameters');
  await toolbar.getByRole('button', { name: 'Back to canvas', exact: true }).click();
  // DIAG_ONLY migration fixture: two previously saved local drafts for the same work, neither may overwrite the other.
  const workReply = (await board()).replies.find(r => r.id === workId), workBlock = workReply.blocks[0];
  const legacyKey = 'spellcast.artifact-state.' + JSON.stringify([source, workId, 'work']);
  const canonicalKey = 'spellcast.artifact-state.' + JSON.stringify([workKey, 'work']);
  const legacyRaw = JSON.stringify({ bundle: workBlock.bundle_id, revision: workBlock.state_revision, state: { count: 41, note: 'Legacy candidate' } });
  const canonicalRaw = JSON.stringify({ bundle: workBlock.bundle_id, revision: workBlock.state_revision, state: { count: 42, note: 'Canonical candidate' } });
  await native.evaluate(({ legacyKey, canonicalKey, legacyRaw, canonicalRaw }) => {
    if (localStorage.getItem(legacyKey) || localStorage.getItem(canonicalKey)) throw Error('Unexpected pre-existing fixture draft.');
    localStorage.setItem(legacyKey, legacyRaw); localStorage.setItem(canonicalKey, canonicalRaw);
  }, { legacyKey, canonicalKey, legacyRaw, canonicalRaw });
  await native.reload(); await toolbar.waitFor(); await until(() => toolbar.locator('option[value="' + workKey + '"]').count());
  await toolbar.locator('.canvas-jump').selectOption(workKey);
  const reader = native.locator('.canvas-reader');
  await reader.getByRole('button', { name: 'Inspect unsaved parameters', exact: true }).click();
  const merge = reader.locator('.artifact-source-body > textarea');
  await merge.waitFor(); assert.equal(JSON.parse(await merge.inputValue()).count, 42);
  assert.deepEqual(await native.evaluate(keys => keys.map(key => localStorage.getItem(key)), [legacyKey, canonicalKey]), [legacyRaw, canonicalRaw]);
  assert.equal((await board()).replies.find(r => r.id === workId).blocks[0].state.count, 1, 'Conflicting local drafts must not save themselves.');
  const saveMerged = reader.getByRole('button', { name: 'Save merged parameters', exact: true }); assert(await saveMerged.isDisabled());
  await merge.fill(JSON.stringify({ count: 43, note: 'Merged legacy and canonical' }));
  await reader.getByText('A separate legacy parameter draft is preserved', { exact: true }).click();
  assert(await reader.getByText(legacyRaw, { exact: true }).isVisible());
  await reader.getByRole('button', { name: 'Discard this legacy draft', exact: true }).click();
  await saveMerged.click();
  await until(async () => (await board()).replies.find(r => r.id === workId).blocks[0].state?.count === 43, 'explicit draft merge');
  assert.deepEqual(await native.evaluate(keys => keys.map(key => localStorage.getItem(key)), [legacyKey, canonicalKey]), [null, null]);
  await reader.getByRole('button', { name: 'Run', exact: true }).click();
  const recoveredWork = await (await reader.locator('iframe').elementHandle()).contentFrame();
  await until(async () => await recoveredWork.locator('#note').inputValue() === 'Merged legacy and canonical');
  await reader.locator(':scope > header').getByRole('button', { name: 'Close', exact: true }).click();
  pass('conflicting legacy and canonical drafts remain separate until explicitly merged; saved work resumes');
  await select(noteKey);
  for (let i = 0; i < 40; i++) { await native.keyboard.press('Shift+ArrowLeft'); await native.keyboard.press('Shift+ArrowUp'); }
  await until(async () => { const p = await pose(noteKey); return p.width === 48 && p.height === 48; }, '48px presentation');
  await native.keyboard.press('Enter');
  await toolbar.getByRole('button', { name: 'Back to canvas', exact: true }).click();
  assert(await frame(noteKey).locator('.canvas-frame-content').evaluate(c => c.inert));
  pass('48px content keeps an accessible host return control');
  const notePose = await pose(noteKey); await native.keyboard.press('Backspace'); await until(async () => !await shown(noteKey));
  assert((await board()).nodes.some(n => n.id === note.id)); assert.equal((await pose(noteKey)).x, notePose.x);
  const after = await board();
  for (const field of ['nodes', 'replies', 'edges']) assert.deepEqual(after[field].filter(value => before[field].some(old => old.id === value.id)), before[field]);
  for (const p of before.canvas.items) assert.deepEqual(after.canvas.items.find(item => item.item_id === p.item_id), p);
  result.textObject = textKey; result.draftMarker = marker;
  result.expected = { objects: after.canvas.objects.filter(o => [textKey, noteKey, workKey].includes(o.id)), items: after.canvas.items.filter(p => [textKey, noteKey, workKey].includes(p.item_id)), replies: after.replies.filter(r => [textId, workId].includes(r.id)) };
  await native.reload(); await toolbar.waitFor();
  await frame(textKey).waitFor();
  assert.equal(await frame(noteKey).count(), 0); assert((await drafts()).some(d => d.object_id === textKey && d.text === marker));
  pass('reload preserves hidden presentation and canonical draft; unrelated data unchanged');
  await toolbar.getByRole('button', { name: 'Fit all', exact: true }).click();
  await native.screenshot({ path: path.join(output, 'verified.png') });
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.checks)); process.exit(0);
} catch (error) {
  await native.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await native.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.txt'), String(error.stack ?? error)); console.error(error.stack ?? error); process.exit(1);
}
