/** Native phase-two integration. Fixture creation and MCP responses are deterministic
 * transport checks, not an injected host Agent. Mouse/keyboard actions use the real WebView.
 * Network aborts and corrupt localStorage are explicit DIAG_ONLY fault injections. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? path.join(root, 'artifacts/atomic-phase2-20260909'));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9340');
const page = browser.contexts()[0].pages().find(page => page.url() === 'http://tauri.localhost/');
assert(page, 'Use the native WebView.');
page.setDefaultTimeout(10000);
const port = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
assert.equal(port, Number(process.env.SPELLCAST_TEST_PORT ?? 47200)); assert.notEqual(port, 47194, 'Never run this against user data.');
const base = 'http://127.0.0.1:' + port;
let session, rpcId = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++rpcId } : {}), method, params }) });
  session ??= response.headers.get('Mcp-Session-Id');
  const text = await response.text(); assert(response.ok, text); if (!text.trim()) return;
  const value = JSON.parse(/^(event|data):/.test(text) ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n') : text);
  assert(!value.error, JSON.stringify(value)); return value.result;
}
async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args }); assert(!result.isError, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
}
async function api(url, method = 'GET', data) {
  const response = await fetch(base + url, { method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
  const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
}
async function until(read, label, timeout = 12000) {
  const start = Date.now();
  do { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() - start < timeout);
  throw new Error(label + ' did not settle');
}
const board = () => api('/api/board');
const object = async id => (await board()).canvas.objects.find(object => object.id === id);
const pose = async id => (await board()).canvas.items.find(item => item.item_id === id);
const frame = id => page.locator('.canvas-frame[data-item-id="' + id + '"]');
const toolbar = page.locator('.canvas-toolbar');
async function clickToolbar(name) {
  const button = toolbar.getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) {
    await toolbar.locator('.canvas-tool-more > summary').click();
    await button.waitFor({ state: 'visible' });
  }
  await button.click();
}
async function done() { const button = toolbar.getByRole('button', { name: 'Back to canvas', exact: true }); if (await button.count()) await button.click(); }
async function select(id) {
  await done();
  await clickToolbar('All items');
  await page.locator('.canvas-overview-card[data-item-id="' + id + '"]').getByRole('button', { name: 'Locate', exact: true }).click();
  await frame(id).locator('.canvas-card-drag').click();
}
async function chooseLayers(ids) {
  await done(); await clickToolbar('Layers');
  for (let index = 0; index < ids.length; index++) {
    await page.locator('.canvas-layer-row[data-item-id="' + ids[index] + '"],.canvas-layer-row[data-composition-id="' + ids[index] + '"]')
      .locator('.canvas-layer-pick').click({ modifiers: index ? ['Shift'] : [] });
  }
  await page.keyboard.press('Escape');
}
async function drag(id, dx, dy) {
  const box = await frame(id).locator('.canvas-card-drag').boundingBox(); assert(box);
  const x = box.x + Math.min(box.width / 2, 100), y = box.y + Math.min(box.height / 2, 100);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
}
async function restore(id) {
  await clickToolbar('Removed');
  await page.locator('.canvas-removed [data-item-id="' + id + '"]').getByRole('button', { name: 'Restore to canvas', exact: true }).click();
  await until(async () => !(await pose(id)).removed, 'restored presentation');
}
async function workClick(work, selector) {
  await work.locator(selector).waitFor({ state: 'visible' });
  await work.evaluate(async () => { if (window.spellcast?.ready) await window.spellcast.ready; });
  const child = await work.locator(selector).evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  const host = await (await work.frameElement()).evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, scale: rect.width / node.offsetWidth, left: node.clientLeft, top: node.clientTop }; });
  const hit = { x: host.x + (host.left + child.x) * host.scale, y: host.y + (host.top + child.y) * host.scale };
  const blocked = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? { tag: el.tagName, className: el.className, id: el.id } : null;
  }, hit);
  result.workClicks = [...(result.workClicks ?? []), { selector, hit, blocked }];
  await page.mouse.click(hit.x, hit.y);
}
const result = { native: true, modelDriver: 'deterministic direct MCP fixture; native host registration and actual task wakeup not asserted', faults: ['DIAG_ONLY network abort', 'DIAG_ONLY corrupt native draft storage'], checks: [] };
const pass = text => { result.checks.push(text); console.log('PASS ' + text); };
const story = 'phase2-story-source', visual = 'phase2-visual-source';
const batch = (id, operations, reads = [], source_id = story, feedback_sequences = []) => call('spellcast_canvas_batch', { source_id, request_id: id, operations, reads, feedback_sequences });
const textObject = (id, title, text, x) => ({ op: 'create', id, content: { type: 'text', title, text }, placement: { x, y: 30, width: 380, height: 300 } });
try {
  await page.locator('#locale').selectOption('en');
  if (await page.locator('#mode-focus').isVisible()) await page.locator('#mode-focus').click();
  await toolbar.waitFor();
  if (process.argv.includes('--verify-restart')) {
    const saved = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')), current = await board();
    assert.deepEqual(current.canvas.objects, saved.expected.objects);
    assert.deepEqual(current.canvas.items, saved.expected.items);
    assert.deepEqual(current.canvas.compositions, saved.expected.compositions);
    assert.deepEqual(current.replies, saved.expected.replies);
    await select('combined');
    assert.equal(await page.locator('#input').inputValue(), saved.draftMarker);
    const workObject = saved.expected.objects.find(object => object.content.type === 'reply' && object.content.id === 'harbor-work');
    await select(workObject.id); await page.keyboard.press('Enter');
    const work = await (await frame(workObject.id).locator('iframe').elementHandle()).contentFrame(); assert(work);
    const state = saved.expected.replies.find(reply => reply.id === 'harbor-work').blocks[0].state;
    await until(async () => await work.locator('#count').textContent() === String(state.count), 'reopened work state');
    assert((await frame(workObject.id).locator('.artifact-selection').textContent()).includes(state.selection.label));
    await select('combined'); await page.screenshot({ path: path.join(output, 'detail.png') });
    saved.processRestart = true; await writeFile(path.join(output, 'result.json'), JSON.stringify(saved, null, 2));
    console.log('PASS native process restart preserves identities, compositions, content, state and composer draft');
  } else {
    assert.equal((await board()).canvas.objects.length, 0, 'Start with a fresh isolated test database.');
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'atomic-composition-check', version: '1' } });
    await rpc('notifications/initialized', {}, true);
    const tools = await rpc('tools/list', {}); assert(tools.tools.some(tool => tool.name === 'spellcast_canvas_batch'));
    const workReply = await call('spellcast_artifact', { source_id: visual, source_label: 'Visual studio', reply_id: 'harbor-work', block_id: 'scene', title: 'Lantern harbor', directory: path.join(root, 'scripts/fixtures/atomic-composition'), entry: 'index.html' });
    const workId = (await board()).canvas.objects.find(object => object.content.type === 'reply' && object.content.id === workReply.id).id;
    await api('/api/canvas/batch', 'POST', { request_id: 'fixture-work-position', operations: [{ op: 'place', id: workId, expected_revision: 1, fields: { x: 30, y: 900, width: 850, height: 680 } }] });
    const initial = await batch('story-candidates', [
      textObject('harbor', '雾港档案', '雾港每夜失去一个名字。', 30),
      textObject('tower', '灯塔失语', '最后一盏灯不再指向归航者。', 480),
      textObject('letter', '潮汐来信', '每天退潮，都留下尚未寄出的信。', 930),
      { op: 'compose', id: 'inner', expected_revision: 0, title: '港与灯', members: ['harbor', 'tower'] },
      { op: 'compose', id: 'outer', expected_revision: 0, title: '故事候选', members: ['inner', 'letter'] },
    ]);
    const bundle = workReply.blocks[0].bundle_id;
    await batch('visual-candidates', [
      { op: 'create', id: 'cover', content: { type: 'image', title: '静默的灯', src: '/artifacts/' + bundle + '/harbor.svg', alt: '安静雾港中的灯塔' }, placement: { x: 480, y: 420, width: 560, height: 370 } },
      { op: 'create', id: 'signal-cover', content: { type: 'image', title: '回声的灯', src: '/artifacts/' + bundle + '/signal.svg', alt: '灯光照向归来的名字' }, placement: { x: 1110, y: 420, width: 560, height: 370 } },
      { op: 'create', id: 'color', content: { type: 'shape', title: '琥珀', shape: 'ellipse', fill: '#D9A75A', text: '暖光' }, placement: { x: 940, y: 690, width: 140, height: 90, z: 12 } },
    ], [], visual);
    await until(() => frame('harbor').count(), 'native objects');
    assert.equal(initial.result.status, 'applied');
    await select('harbor'); await page.keyboard.press('Enter');
    await frame('harbor').locator('.canvas-native-title').fill('留名之港');
    await frame('harbor').locator('.canvas-native-title').press('End');
    await frame('harbor').locator('.canvas-native-title').press('Delete');
    assert(!(await pose('harbor')).removed);
    await frame('harbor').getByRole('button', { name: 'Save', exact: true }).click();
    await until(async () => (await object('harbor')).content.title === '留名之港', 'native title edit');
    assert.equal((await object('harbor')).content.text, '雾港每夜失去一个名字。');
    await done(); assert.equal(await frame('harbor').locator('.canvas-native-heading').textContent(), '留名之港');
    pass('native field editing preserves other content, keeps the title visible, and typing cannot remove the object');

    const beforeConflict = await board();
    const conflict = await batch('merge-stale', [
      { op: 'patch_content', id: 'harbor', expected_revision: 1, fields: { text: '灯塔的每次闪光，都召回雾港遗失的一个名字。' } },
      { op: 'patch_content', id: 'tower', expected_revision: 1, fields: { text: '灯塔守望者必须选择最后要召回的人。' } },
    ], [{ kind: 'content', id: 'harbor', revision: 1 }, { kind: 'content', id: 'tower', revision: 1 }]);
    assert.equal(conflict.result.status, 'proposed');
    assert(conflict.result.targets.some(target => target.id === 'harbor' && target.status === 'conflict'));
    assert(conflict.result.targets.some(target => target.id === 'tower' && target.status === 'ready'));
    assert.deepEqual((await board()).canvas.objects, beforeConflict.canvas.objects);
    await clickToolbar('Proposals');
    const proposal = page.locator('.canvas-proposal[data-request-id="merge-stale"]');
    await until(async () => await proposal.getByRole('button', { name: 'Apply after review', exact: true }).isEnabled(), 'review refresh');
    assert((await proposal.textContent()).includes('雾港每夜失去一个名字。'));
    assert((await proposal.textContent()).includes('灯塔的每次闪光，都召回雾港遗失的一个名字。'));
    await page.screenshot({ path: path.join(output, 'proposal.png') });
    await proposal.getByRole('button', { name: 'Apply after review', exact: true }).click();
    await until(async () => (await object('harbor')).content_revision === 3, 'reviewed batch');
    assert.equal((await object('harbor')).content.title, '留名之港');
    assert.deepEqual(await object('letter'), beforeConflict.canvas.objects.find(object => object.id === 'letter'));
    await page.keyboard.press('Escape'); pass('real stale-version conflict is atomic; explicit review applies only requested fields');

    await select('harbor'); await chooseLayers(['outer']);
    const previous = await board(), before = previous.canvas.items.filter(item => ['harbor', 'tower', 'letter'].includes(item.item_id));
    await drag('harbor', 52, 28);
    await until(async () => (await pose('tower')).x !== before.find(item => item.item_id === 'tower').x, 'group movement');
    const moved = await board(), delta = moved.canvas.items.find(item => item.item_id === 'harbor').x - before.find(item => item.item_id === 'harbor').x;
    for (const item of before) assert(Math.abs(moved.canvas.items.find(next => next.item_id === item.item_id).x - item.x - delta) < .01);
    assert.deepEqual(moved.canvas.items.find(item => item.item_id === 'cover'), previous.canvas.items.find(item => item.item_id === 'cover'));
    await clickToolbar('Undo layout');
    await until(async () => Math.abs((await pose('harbor')).x - before.find(item => item.item_id === 'harbor').x) < .01, 'group undo');
    for (const item of before) assert(Math.abs((await pose(item.item_id)).x - item.x) < .01);
    await clickToolbar('Redo layout');
    await until(async () => Math.abs((await pose('tower')).x - before.find(item => item.item_id === 'tower').x - delta) < .01, 'group redo');
    pass('nested composition moves together, keeps unrelated poses, and has one coherent undo/redo');

    await select('harbor'); await chooseLayers(['outer']);
    const networkBodies = [];
    const abort = route => { networkBodies.push(route.request().postDataJSON()); return route.abort(); };
    await page.route('**/api/canvas/batch', abort);
    const beforeFailure = await board(); await drag('harbor', 36, 20);
    await toolbar.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'visible' });
    assert.deepEqual((await board()).canvas.items, beforeFailure.canvas.items);
    await page.unroute('**/api/canvas/batch', abort);
    const retryRequest = page.waitForRequest(request => request.url().endsWith('/api/canvas/batch') && request.method() === 'POST');
    await toolbar.getByRole('button', { name: 'Retry', exact: true }).click();
    assert.deepEqual((await retryRequest).postDataJSON(), networkBodies[0], 'Retry must preserve the whole request, including versions.');
    await until(async () => (await pose('tower')).revision > beforeFailure.canvas.items.find(item => item.item_id === 'tower').revision, 'retained group retry');
    pass('failed group move retains local poses and retries an identical atomic request');

    await chooseLayers(['inner']); await clickToolbar('Ungroup');
    await until(async () => !(await board()).canvas.compositions.some(group => group.id === 'inner'), 'nested ungroup');
    assert.deepEqual((await board()).canvas.compositions.find(group => group.id === 'outer').members, ['harbor', 'tower', 'letter']);
    await chooseLayers(['cover', 'signal-cover']); await clickToolbar('Group');
    const visualGroup = await until(async () => (await board()).canvas.compositions.find(group => group.members.includes('cover') && group.members.includes('signal-cover')), 'user composition');
    result.visualGroup = visualGroup.id; pass('host grouping and nested ungroup persist stable memberships');

    await select('cover'); await clickToolbar('Zoom out');
    await clickToolbar('Zoom out');
    await clickToolbar('Work inside');
    const image = frame('cover').locator('.canvas-native-image');
    await until(() => image.evaluate(image => image.naturalWidth > 0), 'native image resource');
    const rect = await image.evaluate(image => { const r = image.getBoundingClientRect(), ratio = image.naturalWidth / image.naturalHeight;
      if (r.width / r.height > ratio) { const width = r.height * ratio; return { x: r.x + (r.width - width) / 2, y: r.y, width, height: r.height }; }
      const height = r.width / ratio; return { x: r.x, y: r.y + (r.height - height) / 2, width: r.width, height }; });
    await page.mouse.move(rect.x + rect.width * .2, rect.y + rect.height * .15); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * .65, rect.y + rect.height * .7, { steps: 8 }); await page.mouse.up();
    const highlight = await frame('cover').locator('.canvas-native-region').boundingBox(); assert(highlight);
    assert(Math.abs(highlight.width - rect.width * .45) < 3, 'Selection highlight uses the same scale as the image.');
    await chooseLayers(['cover', 'harbor']);
    await page.locator('#recipient').selectOption(story);
    const ask = '合并雾港和灯塔方向，保留留名之港这个标题，让框选灯光更温暖。';
    await page.locator('#input').fill(ask); await page.locator('#input').press('Delete');
    await page.locator('#send').click();
    const feedback = await until(async () => (await api('/api/feedback')).pending.find(event => event.text === ask), 'multi-anchor feedback');
    assert.equal(feedback.source_id, story); assert.equal(feedback.anchors.length, 2);
    const imageAnchor = feedback.anchors.find(anchor => anchor.object_id === 'cover');
    assert.equal(imageAnchor.region.resource, '/artifacts/' + bundle + '/harbor.svg');
    assert.equal(imageAnchor.region.unit, 'normalized'); assert(Math.abs(imageAnchor.region.width - .45) < .02);
    assert.equal(feedback.anchors.find(anchor => anchor.object_id === 'harbor').content_revision, (await object('harbor')).content_revision);
    assert(!(await api('/api/feedback')).pending.some(event => event.source_id === visual));
    const listened = await call('spellcast_listen', { source_id: story, since: 0, wait: 0 }); assert(listened.events.some(event => event.seq === feedback.seq));
    const response = await batch('combined-response', [{ ...textObject('combined', '留名之港：灯塔的最后一封信', '暖光逐个唤回港口遗失的名字。守塔人发现，最后一个名字属于自己。', 930), placement: { x: 930, y: 900, width: 680, height: 420 } }], feedback.anchors.map(anchor => ({ kind: 'content', id: anchor.object_id, revision: anchor.content_revision })), story, [feedback.seq]);
    assert.equal(response.result.status, 'applied');
    const receipt = (await api('/api/feedback')).deliveries.find(receipt => receipt.event.seq === feedback.seq);
    assert.equal(receipt.phase, 'responded'); assert(receipt.response_object_ids.includes('combined'));
    await call('spellcast_ack', { source_id: story, sequences: [feedback.seq] });
    pass('scaled image region and multiple content versions reach one source; MCP response/ack preserve linkage');

    await select('color'); assert.equal(await frame('color').locator('.canvas-native-shape').count(), 1);
    await select('cover'); const hiddenPose = await pose('cover'); await page.keyboard.press('Delete');
    await until(async () => (await pose('cover')).removed, 'image removal'); assert(await object('cover'));
    await restore('cover'); const restored = await pose('cover');
    for (const field of ['x', 'y', 'width', 'height', 'z']) assert.equal(restored[field], hiddenPose[field]);
    assert((await board()).canvas.compositions.find(group => group.id === visualGroup.id).members.includes('cover'));
    pass('overlapping shape and image can be selected independently; remove/restore retains image and composition');

    await select('letter'); await page.keyboard.press('Enter'); await frame('letter').locator('.canvas-native-text').fill('保留这一份离线草稿。');
    const nativeKey = 'spellcast.canvas-native-drafts.v1', savedDrafts = await page.evaluate(key => localStorage.getItem(key), nativeKey); assert(savedDrafts.includes('离线草稿'));
    await page.reload(); await toolbar.waitFor(); await select('letter'); await page.keyboard.press('Enter');
    assert.equal(await frame('letter').locator('.canvas-native-text').inputValue(), '保留这一份离线草稿。');
    await page.evaluate(key => localStorage.setItem(key, '{invalid'), nativeKey); await page.reload(); await toolbar.waitFor(); await select('letter'); await page.keyboard.press('Enter');
    await frame('letter').locator('.canvas-native-text').fill('仍在窗口内的内容。');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), nativeKey), '{invalid');
    assert(await frame('letter').locator('.canvas-native-notice').textContent());
    await done(); await frame('letter').locator('.canvas-card-drag').click(); await page.keyboard.press('Delete');
    assert(!(await pose('letter')).removed, 'Cannot destroy an unpersisted native draft by removing its frame.');
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: nativeKey, value: savedDrafts });
    await page.reload(); await toolbar.waitFor(); await select('letter'); await page.keyboard.press('Enter');
    assert.equal(await frame('letter').locator('.canvas-native-text').inputValue(), '保留这一份离线草稿。');
    await frame('letter').getByRole('button', { name: 'Save', exact: true }).click();
    await until(async () => (await object('letter')).content.text === '保留这一份离线草稿。', 'recovered draft save');
    pass('native drafts reopen; corrupt storage is retained and unsafe removal is blocked');

    await select(workId); await page.keyboard.press('Enter');
    await toolbar.getByRole('button', { name: 'Back to canvas', exact: true }).waitFor({ state: 'visible' });
    const work = await (await frame(workId).locator('iframe').elementHandle()).contentFrame(); assert(work);
    await work.locator('#signal').waitFor({ state: 'visible' });
    await work.evaluate(async () => { if (window.spellcast?.ready) await window.spellcast.ready; });
    result.workReady = {
      active: await frame(workId).evaluate(node => node.classList.contains('is-active')),
      signalVisible: await work.locator('#signal').isVisible(),
      lampVisible: await work.locator('#lamp').isVisible(),
      count: await work.locator('#count').textContent(),
      spellcast: await work.evaluate(() => Boolean(window.spellcast)),
    };
    result.workBefore = await work.locator('#count').textContent();
    await workClick(work, '#signal');
    await until(async () => (await work.locator('#count').textContent())?.trim() === '1', 'artifact count became 1 after Send signal');
    await workClick(work, '#lamp');
    result.workAfter = { count: await work.locator('#count').textContent(), selection: await frame(workId).locator('.artifact-selection').textContent() };
    await done(); await chooseLayers([workId, 'signal-cover']); await page.locator('#recipient').selectOption(visual);
    const stateAsk = '保留当前灯光状态，并比较这张候选图。';
    await page.locator('#input').fill(stateAsk); await page.locator('#send').click();
    const workFeedback = await until(async () => (await api('/api/feedback')).pending.find(event => event.text === stateAsk), 'artifact multi-anchor feedback');
    const artifactAnchor = workFeedback.anchors.find(anchor => anchor.object_id === workId).artifact;
    assert.equal(artifactAnchor.state.count, 1); assert.equal(artifactAnchor.state.selection.label, 'Lighthouse lamp');
    const persistedWork = (await board()).replies.find(reply => reply.id === workReply.id).blocks[0];
    assert.equal(artifactAnchor.state_revision, persistedWork.state_revision); assert.deepEqual(artifactAnchor.state, persistedWork.state);
    pass('global multi-object feedback flushes declared work state and captures its exact saved selection');

    result.draftMarker = '未发送：记住雾港的回声';
    await select('combined'); await page.locator('#input').fill(result.draftMarker);
    await page.reload(); await toolbar.waitFor(); await select('combined'); assert.equal(await page.locator('#input').inputValue(), result.draftMarker);
    const final = await board();
    result.expected = { objects: final.canvas.objects, items: final.canvas.items, compositions: final.canvas.compositions, replies: final.replies };
    pass('reload preserves stable identities, compositions, content and multi-anchor draft routing');
    await clickToolbar('Fit all');
    await page.screenshot({ path: path.join(output, 'verified.png') });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ ...result, error: String(error), stack: error.stack }, null, 2));
  throw error;
} finally {
  if (session) await fetch(base + '/mcp', { method: 'DELETE', headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' } }).catch(() => {});
  await browser.close();
}
