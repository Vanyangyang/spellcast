/** Direct local MCP transport check. This does not test a host's injected tool catalog. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.SPELLCAST_API ?? 'http://127.0.0.1:47194';
const source = 'codex:01a0726d-5237-7d02-b889-d0c195cce284';
let session, id = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++id } : {}), method, params }) });
  session ??= response.headers.get('Mcp-Session-Id'); const body = await response.text();
  assert(response.ok, body); if (!body.trim()) return;
  const value = JSON.parse(body.startsWith('event:') || body.startsWith('data:') ? body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n') : body);
  assert(!value.error, JSON.stringify(value.error)); return value.result;
}
async function call(name, args) { const value = await rpc('tools/call', { name, arguments: args }); assert(!value.isError, JSON.stringify(value)); return value; }
const result = { scope: 'actual running native server, direct MCP transport; not injected Codex tools' };
try {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'spellcast-artifact-acceptance', version: '1' } });
  await rpc('notifications/initialized', {}, true);
  const catalog = await rpc('tools/list', {}); result.newTools = catalog.tools.filter(t => ['spellcast_artifact', 'spellcast_artifact_read'].includes(t.name)).map(t => t.name); assert.equal(result.newTools.length, 2);
  const before = await (await fetch(base + '/api/board')).json(); const old = before.replies.find(r => r.id === 'everything-tool-20260907'); assert(old);
  result.bundleRead = !(await call('spellcast_artifact_read', { bundle_id: old.blocks[0].bundle_id })).isError;
  const file = await call('spellcast_artifact_read', { bundle_id: old.blocks[0].bundle_id, file: 'index.html' }); assert(file.content.some(c => c.text?.includes('diagram'))); result.sourceRead = true;
  const seqIndex = process.argv.indexOf('--feedback-seq');
  if (seqIndex >= 0) {
    const seq = Number(process.argv[seqIndex + 1]); assert(Number.isSafeInteger(seq) && seq > 0);
    const listened = await call('spellcast_listen', { source_id: source, since: seq - 1, wait: 0 });
    const event = JSON.parse(listened.content.find(c => c.type === 'text').text).events.find(e => e.seq === seq);
    assert.equal(event?.reply_id, old.id); assert(event.text.startsWith('EVERYTHING_ARTIFACT_ACCEPTANCE_20260907')); assert.equal(event.artifact_context.bundle_id, old.blocks[0].bundle_id); assert.deepEqual(event.artifact_context.state, old.blocks[0].state);
    await call('spellcast_artifact', { source_id: source, source_label: old.source_label, reply_id: old.id, block_id: 'work', title: old.title, description: '已核对储水箱选区，参数与备注保留。', directory: path.join(root, 'artifacts/everything-canvas/builds/tool-final2'), entry: 'index.html', expected_revision: old.revision, feedback_sequences: [seq] });
    const after = await (await fetch(base + '/api/board')).json(), next = after.replies.find(r => r.id === old.id);
    assert.deepEqual(next.blocks[0].state, old.blocks[0].state); assert.equal(next.blocks[0].description, '已核对储水箱选区，参数与备注保留。');
    assert.deepEqual(after.nodes, before.nodes); assert.deepEqual(after.replies.filter(r => r.id !== old.id), before.replies.filter(r => r.id !== old.id));
    result.feedback = { seq, previousBundle: old.blocks[0].bundle_id, bundle: next.blocks[0].bundle_id, revision: next.revision, parametersPreserved: true, awaitingPrimaryAcknowledgement: true };
  }
  const output = path.join(root, 'artifacts/everything-canvas/mcp-checks'); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  if (session) await fetch(base + '/mcp', { method: 'DELETE', headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' } }).catch(() => {});
}
