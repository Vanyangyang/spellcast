/** Native phase-three Canvas data-link integration. Direct MCP fixture calls are
 * deterministic transport setup only, not native host Agent registration or wakeup.
 * Artifact iframe interaction uses the real WebView; network abort is DIAG_ONLY. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? path.join(root, 'artifacts/atomic-phase3-20260909'));
await mkdir(output, { recursive: true });

const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? 'http://127.0.0.1:9342');
const page = browser.contexts()[0]?.pages().find(candidate => candidate.url() === 'http://tauri.localhost/');
assert(page, 'Use the native WebView at http://tauri.localhost/.');
page.setDefaultTimeout(12000);

// This reads the native bridge status only. All product changes below use MCP/HTTP or real UI input.
const port = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('bridge_status').then(status => status.port));
assert.equal(port, Number(process.env.SPELLCAST_TEST_PORT ?? 47202), 'Use the isolated phase-three bridge.');
assert.notEqual(port, 47194, 'Never run phase-three checks against user data.');
const base = 'http://127.0.0.1:' + port;

let session;
let rpcId = 0;

async function rpc(method, params, notification = false) {
  const response = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++rpcId } : {}), method, params }),
  });
  session ??= response.headers.get('Mcp-Session-Id');
  const text = await response.text();
  assert(response.ok, text);
  if (!text.trim()) return undefined;
  const payload = JSON.parse(/^(event|data):/.test(text)
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    : text);
  assert(!payload.error, JSON.stringify(payload));
  return payload.result;
}

async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert(!result.isError, JSON.stringify(result));
  const text = result.content?.find(item => item.type === 'text')?.text;
  return result.structuredContent ?? JSON.parse(text);
}

async function api(url, method = 'GET', data) {
  const response = await fetch(base + url, {
    method,
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}

async function until(read, label, timeout = 12000) {
  const start = Date.now();
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() - start < timeout);
  throw new Error(label + ' did not settle');
}

const board = () => api('/api/board');
const object = async id => (await board()).canvas.objects.find(item => item.id === id);
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

function artifactBlock(snapshot, replyId) {
  const reply = snapshot.replies.find(item => item.id === replyId);
  assert(reply, 'Missing reply ' + replyId);
  const block = reply.blocks.find(item => item.id === 'work');
  assert(block && block.type === 'artifact', 'Missing artifact block for ' + replyId);
  return block;
}

function canonicalReplyObject(snapshot, replyId) {
  const result = snapshot.canvas.objects.find(item => item.content.type === 'reply' && item.content.id === replyId);
  assert(result, 'Missing canonical Canvas object for legacy reply reference ' + replyId);
  return result;
}

async function done() {
  const button = toolbar.getByRole('button', { name: 'Back to canvas', exact: true });
  if (await button.count()) await button.click();
}

async function select(id) {
  await done();
  await clickToolbar('All items');
  await page.locator('.canvas-overview-card[data-item-id="' + id + '"]').getByRole('button', { name: 'Locate', exact: true }).click();
  await frame(id).locator('.canvas-card-drag').click();
  await until(() => frame(id).evaluate(element => element.classList.contains('is-selected')), 'selected ' + id);
}

async function chooseLayers(ids) {
  await done();
  await clickToolbar('Layers');
  for (let index = 0; index < ids.length; index++) {
    await page.locator('.canvas-layer-row[data-item-id="' + ids[index] + '"],.canvas-layer-row[data-composition-id="' + ids[index] + '"]')
      .locator('.canvas-layer-pick').click({ modifiers: index ? ['Shift'] : [] });
  }
  await page.keyboard.press('Escape');
}

async function artifactFrame(id) {
  const iframe = frame(id).locator('iframe');
  await iframe.waitFor({ state: 'attached' });
  const handle = await iframe.elementHandle();
  assert(handle, 'Missing artifact iframe for ' + id);
  const work = await handle.contentFrame();
  assert(work, 'Missing artifact frame context for ' + id);
  return work;
}

async function openWork(id) {
  await select(id);
  await page.keyboard.press('Enter');
  return artifactFrame(id);
}

// Playwright cannot reliably hit-test the iframe after the Canvas SVG scales it.
async function workClick(work, selector) {
  const child = await work.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  const hostHandle = await work.frameElement();
  assert(hostHandle, 'Missing host frame');
  const host = await hostHandle.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, scale: rect.width / node.offsetWidth, left: node.clientLeft, top: node.clientTop };
  });
  await page.mouse.click(host.x + (host.left + child.x) * host.scale, host.y + (host.top + child.y) * host.scale);
}

async function tideValue(work) {
  const output = work.locator('#tide-value, #current-number').first();
  await output.waitFor({ state: 'attached' });
  const value = Number((await output.textContent())?.trim());
  assert(Number.isFinite(value), 'Expected a numeric tide output.');
  return value;
}

async function waitForLinked(tide, parameter, chart, nativeId, label) {
  await until(async () => {
    const linked = frame(nativeId).locator('.canvas-native-bound-value');
    const [parameterTide, chartTide, chartState, nativeState, nativeTide] = await Promise.all([
      tideValue(parameter),
      tideValue(chart),
      chart.locator('#input-status').getAttribute('data-state'),
      linked.getAttribute('data-state'),
      linked.textContent(),
    ]);
    return parameterTide === tide && chartTide === tide && chartState === 'available'
      && nativeState === 'available' && Number(nativeTide?.trim()) === tide;
  }, label);
}

async function waitForUnavailable(chart, nativeId, label) {
  await until(async () => {
    const [chartState, nativeState] = await Promise.all([
      chart.locator('#input-status').getAttribute('data-state'),
      frame(nativeId).locator('.canvas-native-bound-value').getAttribute('data-state'),
    ]);
    return chartState === 'unavailable' && nativeState === 'unavailable';
  }, label);
}

function sourceEvidence(objectId, object, block) {
  return {
    object_id: objectId,
    content_revision: object.content_revision,
    block_id: 'work',
    bundle_id: block.bundle_id,
    state_revision: block.state_revision,
  };
}

function inputPort(anchor, name) {
  const portValue = anchor?.inputs?.ports?.[name];
  assert(portValue, 'Missing input port ' + name);
  assert.equal(portValue.status, 'available', 'Expected available input port ' + name);
  return portValue;
}

function assertChartStateHasNoInputs(block) {
  const state = block.state ?? {};
  assert.equal(Object.hasOwn(state, 'tide'), false, 'Chart state must not persist upstream tide.');
  assert.equal(Object.hasOwn(state, 'inputs'), false, 'Chart state must not persist an input snapshot.');
}

function assertChartAnchor(anchor, expectedSource, expectedState) {
  assert(anchor, 'Missing chart anchor.');
  assert.equal(anchor.artifact?.state_revision, expectedState.state_revision);
  assert.deepEqual(anchor.artifact?.state, expectedState.state);
  assert.equal(anchor.artifact?.selection?.id, 'harbor');
  assert.equal(anchor.artifact?.state?.selection?.id, 'harbor');
  assert.deepEqual(inputPort(anchor, 'tide').sources, [expectedSource]);
}

function responseReads(event, snapshot) {
  const ids = new Set(event.anchors.map(anchor => anchor.object_id));
  for (const anchor of event.anchors) {
    for (const port of Object.values(anchor.inputs?.ports ?? {})) {
      if (port?.status !== 'available') continue;
      for (const source of port.sources ?? []) ids.add(source.object_id);
    }
  }
  return [...ids].sort().map(id => {
    const current = snapshot.canvas.objects.find(item => item.id === id);
    assert(current, 'Missing current response dependency ' + id);
    return { kind: 'content', id, revision: current.content_revision };
  });
}

const source = 'phase3-tide';
const parameterReplyId = 'phase3-tide-parameter';
const chartReplyId = 'phase3-tide-chart';
const result = {
  native: true,
  modelDriver: 'deterministic direct MCP fixture; NOT native host Agent registration or wakeup',
  faults: ['DIAG_ONLY producer error', 'DIAG_ONLY producer artifact route abort'],
  checks: [],
};
const pass = label => {
  result.checks.push(label);
  console.log('PASS ' + label);
};

const batch = (requestId, operations, reads = [], feedbackSequences = []) => call('spellcast_canvas_batch', {
  source_id: source,
  request_id: requestId,
  operations,
  reads,
  feedback_sequences: feedbackSequences,
});

try {
  await page.locator('#locale').selectOption('en');
  if (await page.locator('#mode-focus').isVisible()) await page.locator('#mode-focus').click();
  await toolbar.waitFor();

  if (process.argv.includes('--verify-restart')) {
    const saved = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
    const current = await board();
    assert.deepEqual(current.canvas.objects, saved.expected.objects);
    assert.deepEqual(current.canvas.items, saved.expected.items);
    assert.deepEqual(current.canvas.compositions ?? [], saved.expected.compositions);
    assert.deepEqual(current.replies, saved.expected.replies);

    const producerObject = canonicalReplyObject(current, saved.ids.parameterReplyId);
    const chartObject = canonicalReplyObject(current, saved.ids.chartReplyId);
    const producerBlock = artifactBlock(current, saved.ids.parameterReplyId);
    const chartBlock = artifactBlock(current, saved.ids.chartReplyId);
    assert.equal(producerBlock.state?.tide, saved.lastTide);
    assert.equal(chartBlock.state?.selection?.id, saved.selection);
    assertChartStateHasNoInputs(chartBlock);

    let parameter = await openWork(producerObject.id);
    let chart = await openWork(chartObject.id);
    await waitForLinked(saved.lastTide, parameter, chart, saved.ids.nativeText, 'fresh linked outputs after process restart');
    await until(async () => {
      const currentChart = artifactBlock(await board(), saved.ids.chartReplyId);
      return currentChart.state?.selection?.id === saved.selection;
    }, 'chart selection after process restart');
    await chooseLayers([chartObject.id, saved.ids.nativeText]);
    await until(async () => (await page.locator('#input').inputValue()) === saved.draftMarker, 'unsent composer draft after process restart');
    await page.screenshot({ path: path.join(output, 'restart-verified.png') });
    saved.processRestart = true;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(saved, null, 2));
    console.log('PASS native process restart preserves objects, layout, work state, fresh data links and chart selection.');
  } else {
    const initialBoard = await board();
    assert.equal(initialBoard.canvas.objects.length, 0, 'Start with a fresh isolated test database.');
    assert.equal(initialBoard.canvas.items.length, 0, 'Start with no persisted Canvas placements.');
    assert.equal(initialBoard.canvas.compositions?.length ?? 0, 0, 'Start with no persisted Canvas compositions.');
    assert.equal(initialBoard.replies.length, 0, 'Start with no persisted replies.');

    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'canvas-links-check', version: '1' } });
    await rpc('notifications/initialized', {}, true);
    const tools = await rpc('tools/list', {});
    for (const name of ['spellcast_artifact', 'spellcast_canvas_batch', 'spellcast_listen', 'spellcast_ack']) {
      assert(tools.tools.some(tool => tool.name === name), 'Missing MCP tool ' + name);
    }

    const parameterReply = await call('spellcast_artifact', {
      source_id: source,
      source_label: 'Phase three tide',
      reply_id: parameterReplyId,
      block_id: 'work',
      title: 'Tide controls',
      directory: path.join(root, 'examples/linked-tide/parameter'),
      entry: 'index.html',
      io: { inputs: {}, outputs: { tide: 'number' } },
    });
    const chartReply = await call('spellcast_artifact', {
      source_id: source,
      source_label: 'Phase three tide',
      reply_id: chartReplyId,
      block_id: 'work',
      title: 'Tide chart',
      directory: path.join(root, 'examples/linked-tide/chart'),
      entry: 'index.html',
      io: { inputs: { tide: 'number' }, outputs: {} },
    });
    assert.equal(parameterReply.id, parameterReplyId);
    assert.equal(chartReply.id, chartReplyId);

    const published = await board();
    const producer = canonicalReplyObject(published, parameterReplyId);
    const chartObject = canonicalReplyObject(published, chartReplyId);
    const producerPose = await pose(producer.id);
    const chartPose = await pose(chartObject.id);
    assert(producerPose && chartPose, 'Published works need Canvas placement records.');

    const bindingFromProducer = to => ({
      from: { object_id: producer.id, block_id: 'work', port: 'tide' },
      to,
    });
    const nativeBinding = bindingFromProducer({ block_id: null, port: 'text' });
    const chartBinding = bindingFromProducer({ block_id: 'work', port: 'tide' });
    const prepared = await batch('phase3-place-and-link', [
      { op: 'place', id: producer.id, expected_revision: producerPose.revision, fields: { x: 40, y: 40, width: 500, height: 650 } },
      { op: 'place', id: chartObject.id, expected_revision: chartPose.revision, fields: { x: 680, y: 40, width: 650, height: 650 } },
      {
        op: 'create',
        id: 'value',
        content: { type: 'text', title: 'Current tide', text: 'Preserved explanation' },
        placement: { x: 700, y: 800, width: 420, height: 280 },
        bindings: [nativeBinding],
      },
      {
        op: 'create',
        id: 'untouched',
        content: { type: 'text', title: 'Unrelated note', text: 'This note remains untouched.' },
        placement: { x: 1160, y: 800, width: 420, height: 280 },
      },
      { op: 'bind', id: chartObject.id, expected_revision: chartObject.content_revision, bindings: [chartBinding] },
    ], [
      { kind: 'content', id: producer.id, revision: producer.content_revision },
      { kind: 'content', id: chartObject.id, revision: chartObject.content_revision },
    ]);
    assert.equal(prepared.result.status, 'applied');
    await until(() => frame(producer.id).count() && frame(chartObject.id).count() && frame('value').count() && frame('untouched').count(), 'placed linked objects');
    const linkedBoard = await board();
    assert.deepEqual(canonicalReplyObject(linkedBoard, chartReplyId).bindings, [chartBinding]);
    assert.deepEqual((await object('value')).bindings, [nativeBinding]);
    assert.equal((await object('value')).content.text, 'Preserved explanation');
    pass('one atomic batch places both work kinds, binds declared ports, preserves native fallback text and keeps an unrelated note');

    let parameter = await openWork(producer.id);
    let chart = await openWork(chartObject.id);
    // Start both iframe runtimes, then leave the parameter work active for real input.
    parameter = await openWork(producer.id);
    await until(async () => artifactBlock(await board(), parameterReplyId).state?.tide === 4, 'default parameter state');
    await until(async () => artifactBlock(await board(), chartReplyId).state?.selection?.id === 'harbor', 'default chart selection');
    await waitForLinked(4, parameter, chart, 'value', 'initial four reaches chart and native text');
    assert.equal((await object('value')).content.text, 'Preserved explanation');
    pass('default tide 4 propagates through the chart and linked native value without replacing saved text');

    const tideLevel = parameter.getByLabel('Tide level', { exact: true });
    await tideLevel.fill('7');
    await tideLevel.press('Tab');
    await until(async () => artifactBlock(await board(), parameterReplyId).state?.tide === 7, 'saved tide seven');
    await waitForLinked(7, parameter, chart, 'value', 'fresh tide seven output');

    chart = await openWork(chartObject.id);
    await workClick(chart, '[data-marker="harbor"]');
    await until(async () => artifactBlock(await board(), chartReplyId).state?.selection?.id === 'harbor', 'saved harbor selection');
    parameter = await openWork(producer.id);
    const tideLevelAtEight = parameter.getByLabel('Tide level', { exact: true });
    await tideLevelAtEight.fill('8');
    await tideLevelAtEight.press('Tab');
    await until(async () => artifactBlock(await board(), parameterReplyId).state?.tide === 8, 'saved tide eight');
    await waitForLinked(8, parameter, chart, 'value', 'fresh tide eight output');
    const atEight = await board();
    const chartAtEight = artifactBlock(atEight, chartReplyId);
    assert.equal(chartAtEight.state?.selection?.id, 'harbor');
    assertChartStateHasNoInputs(chartAtEight);
    pass('real parameter input, scaled Harbor click and later tide change preserve chart-owned selection without persisting inputs');

    let connections = await (async () => {
      await select('value');
      await clickToolbar('Data connections');
      const dialog = page.locator('.canvas-connections');
      await dialog.waitFor({ state: 'visible' });
      return dialog;
    })();
    await connections.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await until(async () => (await object('value')).bindings?.length === 0, 'native binding disconnected');
    assert.equal(await frame('value').locator('.canvas-native-text').isVisible(), true);
    assert.equal(await frame('value').locator('.canvas-native-text').inputValue(), 'Preserved explanation');
    assert.equal((await object('value')).content.text, 'Preserved explanation');

    connections = await (async () => {
      await select('value');
      await clickToolbar('Data connections');
      const dialog = page.locator('.canvas-connections');
      await dialog.waitFor({ state: 'visible' });
      return dialog;
    })();
    const sourceSelect = connections.getByLabel('Output from', { exact: true });
    const options = await sourceSelect.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent ?? '' })));
    const parameterOption = options.find(option => option.text.includes('Tide controls'));
    assert(parameterOption, 'Tide controls must be a selectable output source.');
    assert.equal(options[0]?.value, parameterOption.value, 'Tide controls should be the default first source for this fixture.');
    await sourceSelect.selectOption(parameterOption.value);
    const outputSelect = connections.getByLabel('Output port', { exact: true });
    await until(() => outputSelect.locator('option[value="tide"]').count(), 'declared tide output');
    await outputSelect.selectOption('tide');
    await connections.getByRole('button', { name: 'Connect', exact: true }).click();
    await until(async () => {
      const current = await object('value');
      return JSON.stringify(current?.bindings ?? []) === JSON.stringify([nativeBinding]);
    }, 'native binding restored');
    await waitForLinked(8, parameter, chart, 'value', 'native value after reconnection');
    pass('Data connections UI disconnects to the preserved fallback and reconnects the declared tide output');

    const unrelatedBefore = structuredClone(await object('untouched'));
    await select(producer.id);
    await page.keyboard.press('Enter');
    parameter = await artifactFrame(producer.id);
    await workClick(parameter, '#simulate-failure');
    await waitForUnavailable(chart, 'value', 'DIAG_ONLY producer error propagation');
    assert.deepEqual(await object('untouched'), unrelatedBefore);
    await select(producer.id);
    await page.keyboard.press('Enter');
    await frame(producer.id).getByRole('button', { name: 'Restart', exact: true }).click();
    parameter = await artifactFrame(producer.id);
    chart = await artifactFrame(chartObject.id);
    await waitForLinked(8, parameter, chart, 'value', 'restarted producer output');
    assert.equal(artifactBlock(await board(), parameterReplyId).state?.tide, 8);
    assert.equal(artifactBlock(await board(), chartReplyId).state?.selection?.id, 'harbor');

    await frame(producer.id).getByRole('button', { name: 'Stop', exact: true }).click();
    await waitForUnavailable(chart, 'value', 'stopped producer propagation');
    await frame(producer.id).getByRole('button', { name: 'Run', exact: true }).click();
    parameter = await artifactFrame(producer.id);
    chart = await artifactFrame(chartObject.id);
    await waitForLinked(8, parameter, chart, 'value', 'run producer output');
    assert.equal(artifactBlock(await board(), parameterReplyId).state?.tide, 8);
    pass('DIAG_ONLY reported error and real Stop both invalidate linked values; Restart and Run recover saved tide and chart selection');

    await page.reload();
    await toolbar.waitFor();
    parameter = await artifactFrame(producer.id);
    chart = await artifactFrame(chartObject.id);
    await waitForLinked(8, parameter, chart, 'value', 'page refresh linked output');
    assert.equal(artifactBlock(await board(), chartReplyId).state?.selection?.id, 'harbor');
    pass('page refresh recomputes tide 8 and restores Harbor selection');

    const routingBoard = await board();
    const routingBlock = artifactBlock(routingBoard, parameterReplyId);
    const producerRoute = '**/artifacts/' + routingBlock.bundle_id + '/**';
    const abortProducerArtifact = route => route.abort('connectionfailed');
    await page.route(producerRoute, abortProducerArtifact);
    try {
      await page.reload();
      await toolbar.waitFor();
      chart = await artifactFrame(chartObject.id);
      await waitForUnavailable(chart, 'value', 'DIAG_ONLY producer resource abort propagation');
      assert.equal(artifactBlock(await board(), chartReplyId).state?.selection?.id, 'harbor');
    } finally {
      await page.unroute(producerRoute, abortProducerArtifact);
    }
    await select(producer.id);
    await page.keyboard.press('Enter');
    await frame(producer.id).getByRole('button', { name: 'Restart', exact: true }).click();
    parameter = await artifactFrame(producer.id);
    chart = await artifactFrame(chartObject.id);
    await waitForLinked(8, parameter, chart, 'value', 'producer restart after resource abort');
    assert.equal(artifactBlock(await board(), parameterReplyId).state?.tide, 8);
    assert.equal(artifactBlock(await board(), chartReplyId).state?.selection?.id, 'harbor');
    pass('DIAG_ONLY producer artifact abort makes consumers unavailable without removing chart selection, then Restart recovers');

    // A live inline Ask must refresh its context after the user changes a linked input.
    await select(chartObject.id);
    await page.keyboard.press('Enter');
    const inlineAsk = 'INLINE_TIDE_CONTEXT_ASK';
    const chartCard = frame(chartObject.id);
    await chartCard.getByRole('button', { name: 'Ask', exact: true }).click();
    const inlineInput = chartCard.getByRole('textbox', { name: 'Ask about this block', exact: true });
    await inlineInput.fill(inlineAsk);

    parameter = await openWork(producer.id);
    const levelAtNine = parameter.getByLabel('Tide level', { exact: true });
    await levelAtNine.fill('9');
    await levelAtNine.press('Tab');
    await until(async () => artifactBlock(await board(), parameterReplyId).state?.tide === 9, 'saved tide nine before inline Ask');
    chart = await artifactFrame(chartObject.id);
    await waitForLinked(9, parameter, chart, 'value', 'fresh tide nine output before inline Ask');
    const atNine = await board();
    const producerAtNine = canonicalReplyObject(atNine, parameterReplyId);
    const parameterAtNine = artifactBlock(atNine, parameterReplyId);
    const chartAtNine = artifactBlock(atNine, chartReplyId);
    const expectedNineSource = sourceEvidence(producerAtNine.id, producerAtNine, parameterAtNine);

    await select(chartObject.id);
    await page.keyboard.press('Enter');
    assert.equal(await frame(chartObject.id).getByRole('textbox', { name: 'Ask about this block', exact: true }).inputValue(), inlineAsk);
    await frame(chartObject.id).getByRole('button', { name: 'Send', exact: true }).click();
    const inlineEvent = await until(async () => (await api('/api/feedback')).pending.find(event => event.text === inlineAsk), 'inline Ask feedback');
    const inlineAnchor = inlineEvent.anchors.find(anchor => anchor.object_id === chartObject.id);
    assertChartAnchor(inlineAnchor, expectedNineSource, chartAtNine);
    assert.equal(inlineEvent.artifact_context?.state_revision, chartAtNine.state_revision);
    assert.deepEqual(inlineEvent.artifact_context?.state, chartAtNine.state);
    assert.deepEqual(inputPort(inlineAnchor, 'tide').sources, [expectedNineSource]);
    result.evidence = { inlineAskSeq: inlineEvent.seq, inlineTide: 9, inlineChartStateRevision: chartAtNine.state_revision };
    pass('a still-open inline Ask refreshes to tide 9, Harbor selection and exact saved state before Send');

    parameter = await openWork(producer.id);
    const levelAtEight = parameter.getByLabel('Tide level', { exact: true });
    await levelAtEight.fill('8');
    await levelAtEight.press('Tab');
    await until(async () => artifactBlock(await board(), parameterReplyId).state?.tide === 8, 'restored tide eight');
    chart = await artifactFrame(chartObject.id);
    await waitForLinked(8, parameter, chart, 'value', 'restored tide eight after inline Ask');
    assert.equal(artifactBlock(await board(), chartReplyId).state?.selection?.id, 'harbor');

    await chooseLayers([chartObject.id, 'value']);
    await page.locator('#recipient').selectOption(source);
    const globalAsk = 'GLOBAL_TIDE_LINK_ASK';
    await page.locator('#input').fill(globalAsk);
    await page.locator('#send').click();
    const feedback = await until(async () => (await api('/api/feedback')).pending.find(event => event.text === globalAsk), 'global linked feedback');
    const feedbackBoard = await board();
    const feedbackProducer = canonicalReplyObject(feedbackBoard, parameterReplyId);
    const feedbackParameter = artifactBlock(feedbackBoard, parameterReplyId);
    const feedbackChart = artifactBlock(feedbackBoard, chartReplyId);
    const expectedEightSource = sourceEvidence(feedbackProducer.id, feedbackProducer, feedbackParameter);
    const chartAnchor = feedback.anchors.find(anchor => anchor.object_id === chartObject.id);
    const nativeAnchor = feedback.anchors.find(anchor => anchor.object_id === 'value');
    assertChartAnchor(chartAnchor, expectedEightSource, feedbackChart);
    assert(nativeAnchor, 'Missing linked native text anchor.');
    assert.deepEqual(inputPort(nativeAnchor, 'text').sources, [expectedEightSource]);
    assert.equal(inputPort(nativeAnchor, 'text').value, 8);
    assertChartStateHasNoInputs(feedbackChart);
    assert.equal(feedbackChart.state?.selection?.id, 'harbor');
    assert.equal((await object('value')).content.text, 'Preserved explanation');
    pass('global multi-select feedback carries chart-owned selection, fresh tide 8 input provenance and native linked value without persisting inputs');

    const listened = await call('spellcast_listen', { source_id: source, since: 0, wait: 0 });
    const listenedEvent = listened.events.find(event => event.seq === feedback.seq);
    assert(listenedEvent, 'Direct MCP listen must return the pending global feedback.');
    const freshForResponse = await board();
    const response = await batch('phase3-linked-response', [{
      op: 'create',
      id: 'linked-answer',
      content: { type: 'text', title: 'Tide follow-up', text: 'The harbor marker remains selected while tide 8 feeds both linked views.' },
      placement: { x: 40, y: 1160, width: 620, height: 260 },
    }], responseReads(feedback, freshForResponse), [feedback.seq]);
    assert.equal(response.result.status, 'applied');
    await call('spellcast_ack', { source_id: source, sequences: [feedback.seq] });
    const receipt = await until(async () => (await api('/api/feedback')).deliveries.find(item => item.event.seq === feedback.seq), 'handled response receipt');
    assert.equal(receipt.phase, 'handled');
    pass('deterministic MCP listen, Canvas response reads and acknowledgement record a handled receipt; this does not assert a native Agent loop');

    const draftMarker = 'UNSENT_LINKED_TIDE_DRAFT';
    await page.locator('#input').fill(draftMarker);
    await page.reload();
    await toolbar.waitFor();
    await chooseLayers([chartObject.id, 'value']);
    assert.equal(await page.locator('#input').inputValue(), draftMarker);
    parameter = await artifactFrame(producer.id);
    chart = await artifactFrame(chartObject.id);
    await waitForLinked(8, parameter, chart, 'value', 'fresh linked outputs after draft reload');
    assert.equal(artifactBlock(await board(), chartReplyId).state?.selection?.id, 'harbor');
    pass('an unsent multi-anchor composer draft survives reload with tide 8 and Harbor selection');

    const final = await board();
    const finalProducer = canonicalReplyObject(final, parameterReplyId);
    const finalChart = canonicalReplyObject(final, chartReplyId);
    const finalParameterBlock = artifactBlock(final, parameterReplyId);
    const finalChartBlock = artifactBlock(final, chartReplyId);
    assert.equal(finalParameterBlock.state?.tide, 8);
    assert.equal(finalChartBlock.state?.selection?.id, 'harbor');
    assertChartStateHasNoInputs(finalChartBlock);
    assert.equal((await object('value')).content.text, 'Preserved explanation');
    result.ids = {
      parameterReplyId,
      chartReplyId,
      producer: finalProducer.id,
      chart: finalChart.id,
      nativeText: 'value',
      unrelated: 'untouched',
      response: 'linked-answer',
      producerBundle: finalParameterBlock.bundle_id,
      chartBundle: finalChartBlock.bundle_id,
    };
    result.lastTide = 8;
    result.selection = 'harbor';
    result.draftMarker = draftMarker;
    result.nativeScreenshot = 'verified.png';
    result.expected = {
      objects: final.canvas.objects,
      items: final.canvas.items,
      compositions: final.canvas.compositions ?? [],
      replies: final.replies,
    };
    await clickToolbar('Fit all');
    await page.screenshot({ path: path.join(output, result.nativeScreenshot) });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result.checks));
  }
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({
    ...result,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }, null, 2));
  throw error;
} finally {
  if (session) {
    await fetch(base + '/mcp', {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' },
    }).catch(() => {});
  }
  // Closes only this CDP connection. It does not quit the native application.
  await browser.close();
}
