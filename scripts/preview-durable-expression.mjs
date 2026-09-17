/**
 * Isolated browser acceptance for durable annotations and fixed image/artifact references.
 * Setup uses a fresh Rust SQLite server and direct MCP transport only. It never binds or wakes
 * a real desktop task, and this script is intentionally not a host-native Agent acceptance.
 */
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.env.SPELLCAST_ACCEPTANCE_WORK_DIR || path.join(root, 'tests/fixtures/durable-canvas-work');
const output = path.join(root, 'artifacts/durable-canvas-work', `browser-${Date.now()}`);
const dist = path.join(output, 'dist');
const backendOrigin = 'http://127.0.0.1:47369';
const binding = {
  source_id: 'fixture-durable-expression',
  thread_id: '22222222-2222-4222-8222-222222222222',
  cwd: 'G:/Fixtures/DurableCanvasWork',
  label: 'Durable Canvas fixture only',
};
const calls = [];
const layoutDelay = Math.max(0, Math.min(3000, Number(process.env.SPELLCAST_ACCEPTANCE_LAYOUT_DELAY_MS) || 0));
const withDataEdge = process.env.SPELLCAST_ACCEPTANCE_DATA_EDGE === '1';
const observations = [];
const mcp = { session: null, catalog: [], calls: [] };

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// A deterministic local PNG is used only to seed immutable references. The work itself captures
// its live canvas with `onSnapshot`, so an acceptance click still exercises the real SDK protocol.
function calendarPng(gap) {
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let index = 0; index < 8; index++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(type, bytes) {
    const tag = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([tag, bytes])));
    return Buffer.concat([length, tag, bytes, checksum]);
  }
  const width = 360, height = 144, raw = Buffer.alloc(height * (width * 3 + 1));
  const normalized = Math.max(0, Math.min(30, Number(gap) || 0)) / 30;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const column = Math.floor((x - 12) / 68);
    const inside = column >= 0 && column < 5 && x > 16 + column * 68 && x < 72 + column * 68;
    const first = inside && y > 27 && y < 43 + (1 - normalized) * 9;
    const secondStart = 50 + normalized * 16;
    const second = inside && y > secondStart && y < secondStart + 20;
    const grid = x % 68 === 11 || y === 21 || y === 49 || y === 77 || y === 105;
    const color = first ? [190, 222, 211] : second ? [237, 188, 151] : grid ? [220, 216, 205] : [255, 253, 247];
    for (let channel = 0; channel < 3; channel++) raw[y * (width * 3 + 1) + 1 + x * 3 + channel] = color[channel];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}

function imageReference(operation) {
  return { object_id: operation.id, content_revision: 1, title: operation.content.title, alt: operation.content.alt, src: operation.content.src };
}
function artifactBlock(reply) {
  const block = reply?.blocks?.find(item => item.type === 'artifact' && item.id === 'calendar-work');
  if (!block) throw Error('Published calendar work is missing its artifact block');
  return block;
}
function artifactReference(board, replyId, objectId) {
  const reply = board.replies.find(item => item.id === replyId);
  const block = artifactBlock(reply);
  const object = board.canvas.objects.find(item => item.id === objectId);
  if (!object) throw Error('Published calendar work is missing its Canvas object');
  return {
    object_id: object.id,
    content_revision: object.content_revision,
    block_id: block.id,
    bundle_id: block.bundle_id,
    state_revision: block.state_revision,
    title: block.title || reply.title,
    state: clone(block.state || {}),
    ...(block.state_preview ? { preview: clone(block.state_preview) } : {}),
  };
}
function sameIdea(layout, first, second) {
  const groups = layout.compositions || [];
  const reaches = (id, target, seen = new Set()) => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return groups.find(group => group.id === id)?.members.some(member => reaches(member, target, seen)) || false;
  };
  return groups.some(group => reaches(group.id, first) && reaches(group.id, second));
}
function imageState(board, ownerId, reference) {
  const source = board.canvas.objects.find(item => item.id === reference.object_id);
  if (!source || source.content.type !== 'image') return 'missing';
  if (!sameIdea(board.canvas, ownerId, source.id)) return 'detached';
  return source.content_revision === reference.content_revision && source.content.src === reference.src ? 'saved' : 'changed';
}
function artifactState(board, ownerId, reference) {
  const source = board.canvas.objects.find(item => item.id === reference.object_id);
  if (!source || source.content.type !== 'reply') return 'missing';
  if (!sameIdea(board.canvas, ownerId, source.id)) return 'detached';
  const reply = board.replies.find(item => item.id === source.content.id);
  const block = reply?.blocks?.find(item => item.id === reference.block_id);
  if (!reply || block?.type !== 'artifact') return 'missing';
  const current = { object_id: source.id, content_revision: source.content_revision, block_id: block.id, bundle_id: block.bundle_id, state_revision: block.state_revision, title: block.title || reply.title, state: block.state || {}, ...(block.state_preview ? { preview: block.state_preview } : {}) };
  return JSON.stringify(current) === JSON.stringify(reference) ? 'saved' : 'changed';
}
function annotationState(board, annotation) {
  const source = board.canvas.objects.find(item => item.id === annotation.anchor.object_id);
  if (!source) return 'removed';
  return source.content_revision === annotation.anchor.content_revision ? 'saved' : 'updated';
}
function compactSummary(board, feedback) {
  const references = [];
  for (const object of board.canvas.objects) {
    if (object.content.type !== 'block') continue;
    const block = object.content.block;
    if (block.type === 'comparison') for (const option of block.options) {
      if (option.image) references.push({ owner: object.id, target: `option:${option.id}`, kind: 'image', state: imageState(board, object.id, option.image) });
      if (option.artifact) references.push({ owner: object.id, target: `option:${option.id}`, kind: 'artifact', state: artifactState(board, object.id, option.artifact), gap: option.artifact.state?.gap });
    }
    if (block.type === 'sequence') for (const step of block.steps) {
      if (step.image) references.push({ owner: object.id, target: `step:${step.id}`, kind: 'image', state: imageState(board, object.id, step.image) });
      if (step.artifact) references.push({ owner: object.id, target: `step:${step.id}`, kind: 'artifact', state: artifactState(board, object.id, step.artifact), gap: step.artifact.state?.gap });
    }
  }
  return {
    objects: board.canvas.objects.map(object => ({ id: object.id, revision: object.content_revision, type: object.content.type })),
    annotations: (board.canvas.annotations || []).map(annotation => ({ id: annotation.id, revision: annotation.revision, removed: annotation.removed, object_id: annotation.anchor.object_id, state: annotationState(board, annotation) })),
    references,
    feedback: { pending: feedback.pending.length, deliveries: feedback.deliveries.length },
    calls: calls.map(call => ({ route: call.route, status: call.status || 'recorded' })),
  };
}

async function api(route, method = 'GET', body, record = true) {
  const response = await fetch(backendOrigin + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (record && method !== 'GET') calls.push({ at: Date.now(), route: `${method} ${route}`, status: response.status, body });
  if (!response.ok) throw Error(`${method} ${route}: ${JSON.stringify(value)}`);
  if (route === '/api/canvas/batch' && value.result?.status !== 'applied') throw Error(`Fixture batch was not applied: ${JSON.stringify(value.result)}`);
  return value;
}

let rpcId = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(backendOrigin + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
      ...(mcp.session ? { 'Mcp-Session-Id': mcp.session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++rpcId } : {}), method, params }),
  });
  mcp.session ??= response.headers.get('Mcp-Session-Id');
  const text = await response.text();
  if (!response.ok) throw Error(`MCP ${method}: ${text}`);
  if (!text.trim()) return undefined;
  const payload = JSON.parse(/^(event|data):/.test(text)
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    : text);
  if (payload.error) throw Error(`MCP ${method}: ${JSON.stringify(payload.error)}`);
  return payload.result;
}
async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError) throw Error(`MCP ${name}: ${JSON.stringify(result)}`);
  mcp.calls.push({ at: Date.now(), name, arguments: args });
  const text = result?.content?.find(item => item.type === 'text')?.text;
  return result?.structuredContent ?? (text ? JSON.parse(text) : result);
}

async function recordObservation(label) {
  const [board, feedback] = await Promise.all([api('/api/board', 'GET', undefined, false), api('/api/feedback', 'GET', undefined, false)]);
  const summary = compactSummary(board, feedback);
  observations.push({ label, at: Date.now(), board, feedback, summary });
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({
    method: 'Fresh isolated Rust API/SQLite plus deterministic direct MCP transport. No host-native Agent and no real model task are involved.',
    backendPid: backend.pid, backendOrigin, binding, mcp: { ...mcp, session: Boolean(mcp.session) }, calls, observations,
  }, null, 2));
  return summary;
}

async function seed() {
  await api('/api/replies', 'POST', {
    id: 'durable-fixture-registration', source_id: binding.source_id, source_label: binding.label, title: 'Fixture registration',
    blocks: [{ id: 'fixture-note', type: 'text', text: 'Registers a deterministic local fixture only; no real task is connected.' }],
  });
  let board = await api('/api/board', 'GET', undefined, false);
  const registration = board.canvas.objects.find(object => object.content.type === 'reply' && object.content.id === 'durable-fixture-registration');
  if (!registration) throw Error('Fixture registration object missing');
  const registrationPose = board.canvas.items.find(item => item.item_id === registration.id);
  await api('/api/canvas/batch', 'POST', { request_id: 'hide-durable-fixture-registration', operations: [{ op: 'place', id: registration.id, expected_revision: registrationPose.revision, fields: { removed: true } }] });

  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'durable-expression-preview', version: '1' } });
  await rpc('notifications/initialized', {}, true);
  const catalog = await rpc('tools/list', {});
  mcp.catalog = (catalog?.tools || []).map(tool => tool.name);
  if (!mcp.catalog.includes('spellcast_artifact')) throw Error('The isolated MCP catalog does not expose spellcast_artifact');
  const published = await callTool('spellcast_artifact', {
    source_id: binding.source_id, source_label: binding.label, reply_id: 'durable-calendar-work', block_id: 'calendar-work',
    title: 'Calendar breathing room', description: 'Isolated durable-expression fixture. Controls save only local artifact state.',
    io: { outputs: { summary: 'string' } },
    directory: fixture, entry: 'index.html',
  });
  if (!published?.id) throw Error('spellcast_artifact did not return a board reply');
  board = await api('/api/board', 'GET', undefined, false);
  const workObject = board.canvas.objects.find(object => object.content.type === 'reply' && object.content.id === published.id);
  const workBlock = artifactBlock(board.replies.find(reply => reply.id === published.id));
  if (!workObject) throw Error('Published work has no Canvas object');
  await api('/api/artifacts/state', 'POST', {
    object_id: workObject.id, reply_id: published.id, block_id: workBlock.id, bundle_id: workBlock.bundle_id,
    expected_state_revision: workBlock.state_revision, state: { gap: 15 }, preview: { src: calendarPng(15), alt: 'Weekly calendar with 15-minute meeting gaps' },
  });

  const openImage = { op: 'create', id: 'calendar-open-image', content: { type: 'image', title: 'Open weekly calendar', alt: 'Calendar with breathing room', src: calendarPng(15) }, placement: { x: 0, y: 620, width: 360, height: 220 } };
  const busyImage = { op: 'create', id: 'calendar-busy-image', content: { type: 'image', title: 'Crowded weekly calendar', alt: 'Calendar without enough breathing room', src: calendarPng(2) }, placement: { x: 400, y: 620, width: 360, height: 220 } };
  const comparison = { id: 'calendar-comparison-block', type: 'comparison', title: 'Where should the calendar breathe?', criteria: ['Pacing'], options: [
    { id: 'open', title: 'Protect the gaps', summary: 'Leave time between meetings.', values: ['Spacious'], image: imageReference(openImage) },
    { id: 'busy', title: 'Fill every slot', summary: 'Maximize planned time.', values: ['Dense'], image: imageReference(busyImage) },
  ] };
  const sequence = { id: 'calendar-sequence-block', type: 'sequence', title: 'Try the gap', steps: [
    { id: 'observe', title: 'Observe the schedule', action: 'Notice where consecutive meetings leave no room.' },
    { id: 'adjust', title: 'Adjust the gap', action: 'Move the slider in the calendar work.' },
  ] };
  const sourceText = { op: 'create', id: 'calendar-source-text', content: { type: 'text', title: 'Calendar intent', text: 'Keep 15 minutes between meetings so the plan can absorb change.' }, placement: { x: 780, y: 620, width: 420, height: 220 } };
  for (const operation of [openImage, busyImage, sourceText]) operation.origin = { cwd: binding.cwd, thread_id: binding.thread_id, source_id: binding.source_id, label: binding.label };
  await api('/api/canvas/batch', 'POST', { request_id: 'seed-durable-calendar', operations: [
    { op: 'place', id: workObject.id, expected_revision: board.canvas.items.find(item => item.item_id === workObject.id).revision, fields: { x: 1400, y: 0, width: 580, height: 420 } },
    openImage, busyImage,
    { op: 'create', id: 'calendar-comparison', content: { type: 'block', block: comparison }, placement: { x: 0, y: 0, width: 700, height: 560 }, origin: { cwd: binding.cwd, thread_id: binding.thread_id, source_id: binding.source_id, label: binding.label } },
    { op: 'create', id: 'calendar-sequence', content: { type: 'block', block: sequence }, placement: { x: 760, y: 0, width: 580, height: 560 }, origin: { cwd: binding.cwd, thread_id: binding.thread_id, source_id: binding.source_id, label: binding.label } },
    sourceText,
    // The published work joins the Idea before references are attached; the backend validates that relationship.
    { op: 'compose', id: 'calendar-idea', expected_revision: 0, title: 'Calendar breathing room', members: [workObject.id, 'calendar-comparison', 'calendar-sequence', 'calendar-open-image', 'calendar-busy-image', 'calendar-source-text'] },
  ] });

  board = await api('/api/board', 'GET', undefined, false);
  const currentWork = board.canvas.objects.find(object => object.id === workObject.id);
  const comparisonObject = board.canvas.objects.find(object => object.id === 'calendar-comparison');
  const sequenceObject = board.canvas.objects.find(object => object.id === 'calendar-sequence');
  const idea = board.canvas.compositions.find(composition => composition.id === 'calendar-idea');
  if (!currentWork || !comparisonObject || !sequenceObject || !idea || comparisonObject.content.type !== 'block' || sequenceObject.content.type !== 'block') throw Error('Calendar fixture seed is incomplete');
  const reference = artifactReference(board, published.id, currentWork.id);
  const linkedComparison = clone(comparisonObject.content.block); linkedComparison.options.find(option => option.id === 'open').artifact = clone(reference);
  const linkedSequence = clone(sequenceObject.content.block); linkedSequence.steps.find(step => step.id === 'adjust').artifact = clone(reference);
  await api('/api/canvas/batch', 'POST', { request_id: 'attach-calendar-artifact-references', reads: [{ kind: 'content', id: currentWork.id, revision: currentWork.content_revision }], operations: [
    // Exercise labeled data edges after both endpoints belong to the Idea.
    ...(withDataEdge ? [{ op: 'bind', id: sourceText.id, expected_revision: board.canvas.objects.find(object => object.id === sourceText.id).content_revision,
      bindings: [{ from: { object_id: workObject.id, block_id: workBlock.id, port: 'summary' }, to: { block_id: null, port: 'text' } }] }] : []),
    { op: 'patch_block', id: comparisonObject.id, expected_revision: comparisonObject.content_revision, block: linkedComparison },
    { op: 'patch_block', id: sequenceObject.id, expected_revision: sequenceObject.content_revision, block: linkedSequence },
  ] });

  board = await api('/api/board', 'GET', undefined, false);
  const annotatedComparison = board.canvas.objects.find(object => object.id === 'calendar-comparison');
  const annotatedIdea = board.canvas.compositions.find(composition => composition.id === 'calendar-idea');
  if (!annotatedComparison || !annotatedIdea) throw Error('Cannot add the durable fixture annotation');
  await api('/api/canvas/batch', 'POST', { request_id: 'seed-durable-calendar-annotation', reads: [
    { kind: 'content', id: annotatedComparison.id, revision: annotatedComparison.content_revision },
    { kind: 'composition', id: annotatedIdea.id, revision: annotatedIdea.revision },
  ], operations: [{
    op: 'annotate', id: 'calendar-gap-note', expected_revision: 0,
    anchor: { object_id: annotatedComparison.id, content_revision: annotatedComparison.content_revision, block_id: 'calendar-comparison-block', target: { kind: 'option', id: 'open' }, image: imageReference(openImage), artifact_reference: clone(reference), compositions: [{ id: annotatedIdea.id, revision: annotatedIdea.revision }] },
    text: 'Keep this choice tied to the original 15-minute gap snapshot.',
  }] });
}

fs.mkdirSync(output, { recursive: true });
if (await fetch(backendOrigin + '/api/health').catch(() => null)) throw Error(`Isolated backend port 47369 is occupied: ${backendOrigin}`);
const executable = path.join(root, 'target/debug/spellcast-server.exe');
const backend = spawn(executable, [], {
  cwd: root,
  env: { ...process.env, SPELLCAST_PORT: '47369', SPELLCAST_STATE_FILE: path.join(output, 'state.sqlite3') },
  windowsHide: true,
  stdio: 'ignore',
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend.exitCode !== null) throw Error('Isolated Rust backend exited before becoming ready');
    try {
      const board = await api('/api/board', 'GET', undefined, false);
      if ((board.canvas.objects || []).length || board.replies.length || (board.canvas.annotations || []).length) throw Error('Fresh fixture SQLite database is not empty');
      ready = true; break;
    } catch (error) {
      if (/Fresh fixture SQLite/.test(String(error))) throw error;
      await wait(100);
    }
  }
  if (!ready) throw Error('Isolated Rust backend did not become ready');
  await seed();
} catch (error) {
  backend.kill();
  throw error;
}

let server;
async function proxy(req, res, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (layoutDelay && req.method === 'POST' && url.pathname.startsWith('/api/canvas')) await wait(layoutDelay);
  const headers = {};
  for (const name of ['content-type', 'accept', 'range', 'if-none-match']) if (req.headers[name]) headers[name] = req.headers[name];
  // The backend generates a bundle-scoped CSP from Host. Preserve the preview origin so the
  // injected /artifacts/{bundle}/__spellcast.js stays under the sandbox CSP through this proxy.
  if (url.pathname.startsWith('/artifacts/')) {
    headers.host = req.headers.host || '127.0.0.1';
    // Node fetch replaces Host; http.request preserves the fixture origin without loosening CSP.
    await new Promise((resolve, reject) => {
      const request = httpRequest(backendOrigin + url.pathname + url.search, { method: req.method, headers }, upstream => {
        res.statusCode = upstream.statusCode || 502;
        for (const [name, value] of Object.entries(upstream.headers)) if (value !== undefined && !['connection', 'transfer-encoding'].includes(name)) res.setHeader(name, value);
        upstream.on('error', reject); upstream.on('end', resolve); upstream.pipe(res);
      });
      request.on('error', reject); request.end(body);
    });
    return;
  }
  const upstream = await fetch(backendOrigin + url.pathname + url.search, {
    method: req.method, headers, ...(body.length ? { body } : {}), redirect: 'manual',
  });
  if (url.pathname === '/api/feedback' && req.method === 'GET') {
    const feedback = await upstream.json(); feedback.bindings = [binding];
    res.statusCode = upstream.status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(feedback)); return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') calls.push({ at: Date.now(), route: `${req.method} ${url.pathname}`, status: upstream.status, body: body.toString('utf8') });
  res.statusCode = upstream.status;
  for (const name of ['content-type', 'cache-control', 'content-security-policy', 'access-control-allow-origin', 'x-content-type-options', 'referrer-policy', 'accept-ranges', 'content-range', 'content-disposition', 'location']) {
    const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
  }
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function changeFixture() {
  const board = await api('/api/board', 'GET', undefined, false);
  const sourceText = board.canvas.objects.find(object => object.id === 'calendar-source-text');
  const sourceImage = board.canvas.objects.find(object => object.id === 'calendar-open-image');
  const workObject = board.canvas.objects.find(object => object.content.type === 'reply' && object.content.id === 'durable-calendar-work');
  const workReply = board.replies.find(reply => reply.id === 'durable-calendar-work');
  const work = artifactBlock(workReply);
  if (!sourceText || !sourceImage || !workObject) throw Error('Fixture change targets are missing');
  await api('/api/canvas/batch', 'POST', { request_id: crypto.randomUUID(), operations: [
    { op: 'patch_content', id: sourceText.id, expected_revision: sourceText.content_revision, fields: { text: 'Updated fixture: keep 24 minutes between meetings after the source changed.' } },
    { op: 'patch_content', id: sourceImage.id, expected_revision: sourceImage.content_revision, fields: { title: 'Updated open weekly calendar', src: calendarPng(24), alt: 'Calendar with larger meeting gaps' } },
  ] });
  await api('/api/artifacts/state', 'POST', {
    object_id: workObject.id, reply_id: workReply.id, block_id: work.id, bundle_id: work.bundle_id,
    expected_state_revision: work.state_revision, state: { gap: 24 }, preview: { src: calendarPng(24), alt: 'Weekly calendar with 24-minute meeting gaps' },
  });
  return recordObservation('fixture-source-changed');
}

server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'");
    if (url.pathname === '/__stop' && req.method === 'POST') {
      const summary = await recordObservation('stopped');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(`Stopped isolated preview. ${JSON.stringify(summary)}`);
      backend.kill(); server.close(); return;
    }
    if (url.pathname === '/__change' && req.method === 'POST') {
      await changeFixture(); res.writeHead(303, { Location: '/__acceptance?label=fixture-source-changed' }); res.end(); return;
    }
    if (url.pathname === '/__acceptance') {
      const summary = await recordObservation(url.searchParams.get('label') || 'observe');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>Durable Canvas acceptance</title><h1>Durable Canvas acceptance</h1><p>Fresh isolated Rust API/SQLite and direct MCP fixture setup. No host-native Agent or model task is involved.</p><pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre><p><a href="/">Return to Canvas</a></p><form method="POST" action="/__change"><button>Change source text, image, and work state</button></form><form method="POST" action="/__stop"><button>Stop isolated preview</button></form>`);
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/artifacts/')) {
      if (url.pathname === '/api/task-target' && req.method === 'POST') {
        calls.push({ at: Date.now(), route: 'POST /api/task-target', status: 200, body: binding });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...binding, status: 'available', checked_at_ms: Date.now(), message: 'Deterministic fixture destination; no real model is bound.' })); return;
      }
      if (url.pathname === '/api/say' && req.method === 'POST') {
        // Preserve an inspectable local feedback record but strip the fixture thread before it reaches the backend.
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const submitted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (submitted.source_id !== binding.source_id || submitted.target_thread_id !== binding.thread_id) throw Error('Unexpected fixture feedback target');
        const { target_thread_id, ...localOnly } = submitted;
        const response = await fetch(backendOrigin + '/api/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(localOnly) });
        const body = Buffer.from(await response.arrayBuffer());
        calls.push({ at: Date.now(), route: 'POST /api/say', status: response.status, body: submitted, delivery: 'local fixture only' });
        res.statusCode = response.status; res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json'); res.end(body); return;
      }
      await proxy(req, res, url); return;
    }
    const filename = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!filename.startsWith(dist + path.sep) || !fs.existsSync(filename)) { res.writeHead(404); res.end(); return; }
    const extension = path.extname(filename);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' })[extension] || 'text/html; charset=utf-8');
    let content = fs.readFileSync(filename);
    if (extension === '.html') content = content.toString().replace('<head>', '<head><script>if(!localStorage.getItem("spellcast.locale"))localStorage.setItem("spellcast.locale","zh-CN");localStorage.setItem("spellcast.mode","focus");</script>');
    res.end(content);
  } catch (error) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: String(error) }));
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await build({ root, logLevel: 'error', define: { 'import.meta.env.VITE_API_URL': JSON.stringify(origin) }, build: { outDir: dist, emptyOutDir: false } });
  const summary = await recordObservation('ready');
  console.log(JSON.stringify({ ready: true, origin, output, backendPid: backend.pid, backendOrigin, summary, acceptance: `${origin}/__acceptance` }));
} catch (error) {
  backend.kill(); server.close(); throw error;
}
