/** Real Rust endpoint and native Codex metadata, with an isolated state file. No model turns or production writes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/workbench-20260914', `task-target-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const api = 'http://127.0.0.1:47344';
assert.equal(await fetch(api + '/api/health').catch(() => null), null, 'Isolated port is already occupied');
const backend = spawn(path.join(root, 'target/debug/spellcast-server.exe'), [], { cwd: root, env: { ...process.env, SPELLCAST_PORT: '47344', SPELLCAST_STATE_FILE: path.join(output, 'state.sqlite3') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; backend.stdout.on('data', data => log += data); backend.stderr.on('data', data => log += data);
const report = { pass: false, method: 'Real native metadata only: bind an existing owned task in isolated SQLite; lookup nonexistent UUID; no task deletion, model turn or production changes', checks: {} };
async function request(url, body) { const response = await fetch(api + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value; }
try {
  const start = Date.now(); while (!(await fetch(api + '/api/health').catch(() => null))?.ok) { assert(Date.now() - start < 15000); await new Promise(r => setTimeout(r, 100)); }
  const original = { source_id: 'test-original-task', thread_id: '01a0726d-5237-7d02-b889-d0c195cce284', cwd: root };
  await request('/api/bindings/codex', original);
  report.checks.original = await request('/api/task-target', original); assert.equal(report.checks.original.status, 'available');
  report.checks.wrongWorkspace = await request('/api/task-target', { ...original, cwd: 'G:/DefinitelyAnotherWorkspace' }); assert.equal(report.checks.wrongWorkspace.status, 'changed');
  report.checks.unlinked = await request('/api/task-target', { source_id: 'local-content' }); assert.equal(report.checks.unlinked.status, 'unlinked');
  const missingStart = Date.now();
  report.checks.missing = await request('/api/task-target', { source_id: 'known-removed-source', thread_id: '00000000-0000-4000-8000-000000000000' });
  report.missingDurationMs = Date.now() - missingStart;
  assert.equal(report.checks.missing.status, 'deleted');
  report.checks.retainedWithoutBinding = await request('/api/task-target', { ...original, source_id: 'unbound-original' }); assert.equal(report.checks.retainedWithoutBinding.status, 'unlinked');
  report.checks.archived = await request('/api/task-target', { source_id: 'archived-task-fixture', thread_id: '01a09485-63ca-7661-af9b-f192ffba973d', cwd: 'C:/Users/Administrator/Desktop/temp/all' });
  assert.equal(report.checks.archived.status, 'unlinked', 'A real archived task still exists and must not be called deleted');
  report.pass = true;
} finally {
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(output, 'backend.log'), log);
  if (backend.exitCode === null) { const exit = once(backend, 'exit'); backend.kill(); await exit; }
  console.log(JSON.stringify({ ...report, output }));
}
