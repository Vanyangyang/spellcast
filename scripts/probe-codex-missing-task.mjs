import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
const exe = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const child = spawn(exe, ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
const lines = createInterface({ input: child.stdout }); const pending = new Map(); let sequence = 0;
lines.on('line', line => { try { const result = JSON.parse(line); const item = pending.get(result.id); if (item) { clearTimeout(item.timer); pending.delete(result.id); item.resolve(result); } } catch {} });
const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(Error('timeout')), 10000); pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
try {
  await request('initialize', { clientInfo: { name: 'spellcast-task-read-probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const result = await request('thread/read', { threadId: '00000000-0000-4000-8000-000000000000', includeTurns: false });
  const report = { method: 'Read-only lookup of an explicitly nonexistent UUID; no delete, resume, queue or turn start', error: result.error, unexpectedThread: Boolean(result.result?.thread) };
  report.withHistoryError = (await request('thread/read', { threadId: '00000000-0000-4000-8000-000000000000', includeTurns: true })).error;
  report.pages = [];
  for (const archived of [false, true]) {
   let cursor = null;
   for (let index = 0; index < 32; index++) {
    const started = Date.now();
    const page = await request('thread/list', { limit: 100, cursor, archived, modelProviders: [], sourceKinds: ['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'] });
    const entries = page.result?.data || [];
    report.pages.push({ archived, index, ms: Date.now()-started, bytes: Buffer.byteLength(JSON.stringify(page)), error: page.error, count: entries.length, hasNext: Boolean(page.result?.nextCursor), largestFields: entries.flatMap(item => Object.entries(item).map(([key,value]) => ({ key, bytes: Buffer.byteLength(JSON.stringify(value)) }))).sort((a,b) => b.bytes-a.bytes).slice(0,1) });
    cursor = page.result?.nextCursor; if (!cursor) break;
   }
  }
  fs.mkdirSync('artifacts/workbench-20260914', { recursive: true }); fs.writeFileSync('artifacts/workbench-20260914/missing-task-probe.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { child.stdin.end(); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null) child.kill(); lines.close(); }
