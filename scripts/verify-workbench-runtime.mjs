import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [mode, run] = process.argv.slice(2);
assert(['before', 'after'].includes(mode) && /^[a-zA-Z0-9-]+$/.test(run));
const output = path.resolve(import.meta.dirname, '../artifacts/workbench-20260914', run);
fs.mkdirSync(output, { recursive: true });
const response = await fetch('http://127.0.0.1:47194/api/board'); assert(response.ok);
const current = await response.json();
const counts = board => ({ nodes: board.nodes.length, edges: board.edges.length, replies: board.replies.length, messages: board.messages.length, objects: board.canvas.objects.length, compositions: board.canvas.compositions.length });
if (mode === 'before') fs.writeFileSync(path.join(output, 'production-before.json'), JSON.stringify(current));
else {
  const original = JSON.parse(fs.readFileSync(path.join(output, 'production-before.json'), 'utf8'));
  function preserved(before, after, at = '$') {
    if (before === null || typeof before !== 'object') { assert.deepEqual(after, before, at); return; }
    if (Array.isArray(before)) { assert(Array.isArray(after), at); assert.equal(after.length, before.length, at + '.length'); before.forEach((item, index) => preserved(item, after[index], `${at}[${index}]`)); }
    else for (const key of Object.keys(before)) preserved(before[key], after?.[key], at + '.' + key);
  }
  preserved(original, current);
  fs.writeFileSync(path.join(output, 'production-preserved.json'), JSON.stringify({ pass: true, counts: counts(current), checkedAt: new Date().toISOString(), scope: 'Every preexisting board field, object, placement, reply, message, edge and composition; new schema defaults may be added.' }, null, 2));
}
console.log(JSON.stringify({ pass: true, mode, counts: counts(current), output }));
