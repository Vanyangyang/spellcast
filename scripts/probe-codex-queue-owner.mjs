import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
const exe = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const threadId = '01a09e5a-b2d8-7de0-bd0f-2870c909e188';
const child = spawn(exe, ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout });
let nextId = 0;
const pending = new Map();
lines.on('line', line => { try { const message = JSON.parse(line); const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); } } catch {} });
function request(method, params) { return new Promise((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timed out: ${method}`)); }, 10000); pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }); }
const report = { threadId, method: 'Read-only metadata and an explicitly nonexistent queue item; no resume, queue-add, or turn-start' };
try {
  const init = await request('initialize', { clientInfo: { name: 'spellcast-protocol-probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  report.protocolAgent = init.result?.userAgent; child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const read = await request('thread/read', { threadId, includeTurns: false });
  report.thread = read.error || { id: read.result?.thread?.id, cwd: read.result?.thread?.cwd, status: read.result?.thread?.status };
  const loaded = await request('thread/loaded/list', {});
  report.loaded = loaded.error || loaded.result;
  // This ID was never created. Starting an unrelated queued item is impossible.
  const start = await request('thread/queue/start', { threadId, queuedSubmissionId: 'spellcast-probe-nonexistent-20260914-queue-item' });
  report.nonexistentQueueStart = start.error || start.result;
} catch (error) { report.error = error.message; }
finally { child.stdin.end(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); if (child.exitCode === null) child.kill(); lines.close(); }
fs.mkdirSync('artifacts/workbench-20260914', { recursive: true });
fs.writeFileSync('artifacts/workbench-20260914/codex-queue-owner-probe.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
