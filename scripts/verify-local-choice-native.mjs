import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const api = 'http://127.0.0.1:47321';
const get = async route => { const r = await fetch(api + route); assert(r.ok); return r.json(); };
const board = await get('/api/board');
if (process.argv[2] === 'seed') {
  assert.equal(board.canvas.objects.length, 0);
  const r = await fetch(api + '/api/canvas/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: 'native-local-choice-fixture', operations: [{ op: 'create', id: 'native-local-choice', content: { type: 'block', block: { type: 'comparison', id: 'choice', title: '原生本地选择验收', criteria: ['状态'], options: [{ id: 'a', title: '方案 A', summary: '', values: ['可选'] }, { id: 'b', title: '方案 B', summary: '', values: ['可选'] }] } }, placement: { x: 48, y: 48, width: 600, height: 420 } }] }) });
  assert(r.ok); assert.equal((await r.json()).result.status, 'applied'); console.log('Isolated native fixture prepared; no UI action simulated.');
} else {
  const object = board.canvas.objects.find(o => o.id === 'native-local-choice');
  assert.equal(object.content.block.selected_id, 'b'); assert.equal(object.content_revision, 2);
  const feedback = await get('/api/feedback'); assert.deepEqual(feedback.pending, []); assert.deepEqual(feedback.deliveries, []);
  const result = { pass: true, method: 'Native desktop input through Computer Use; HTTP prepares and checks an isolated fixture only', object_id: object.id, selected_id: 'b', revision: object.content_revision, pending: 0, deliveries: 0, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.resolve(import.meta.dirname, '../artifacts/workbench-20260914/native-workbench-20260914-0739/native-choice-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
