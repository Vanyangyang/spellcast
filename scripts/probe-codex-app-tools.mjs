/** Native Desktop transport acceptance. Default is read-only; --send targets the owned fixture task. */
import net from 'node:net';
import fs from 'node:fs';
const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
if (!pipe) throw Error('The native Codex host did not provide its app-tools pipe.');
const socket = net.createConnection(pipe); let buffer = Buffer.alloc(0), sequence = 0; const pending = new Map();
socket.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0); if (length > 8 * 1024 * 1024) { socket.destroy(Error('Frame too large')); return; }
    if (buffer.length < 4 + length) return;
    const response = JSON.parse(buffer.subarray(4, length + 4).toString()); buffer = buffer.subarray(length + 4);
    const item = pending.get(response.id); if (!item) continue; pending.delete(response.id); clearTimeout(item.timer);
    response.error ? item.reject(Error(response.error.message)) : item.resolve(response.result);
  }
});
socket.on('error', error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
async function request(method, params) {
  const id = ++sequence, bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })); const frame = Buffer.alloc(4 + bytes.length); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4);
  const result = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('Native host timeout')); }, 15000); pending.set(id, { resolve, reject, timer }); });
  socket.write(frame); return result;
}
try {
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const catalog = await request('tools/list', { threadStartKind: 'all' });
  const relevant = catalog.tools.filter(tool => /send_message_to_thread|read_thread|wait_threads/.test(tool.name));
  fs.mkdirSync('artifacts/workbench-20260914', { recursive: true });
  fs.writeFileSync('artifacts/workbench-20260914/native-app-tools-catalog.json', JSON.stringify({ method: 'Real native Desktop pipe tools/list, read only', tools: relevant }, null, 2));
  if (!['--read','--send','--reject'].some(arg=>process.argv.includes(arg))) console.log(JSON.stringify(relevant.map(({ name, namespace, inputSchema }) => ({ name, namespace, inputSchema }))));
  if (process.argv.includes('--reject')) {
    const result = await request('tools/call', { namespace: 'codex_app', tool: 'send_message_to_thread', threadId: process.env.CODEX_THREAD_ID, turnId: 'spellcast-rejection-probe', callId: 'spellcast-reject-' + crypto.randomUUID(), arguments: { threadId: '00000000-0000-4000-8000-000000000000', prompt: 'This is a rejection-only test against an explicitly nonexistent task.' } });
    fs.writeFileSync('artifacts/workbench-20260914/native-app-tools-rejected.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  }
  if (process.argv.includes('--send')) {
    const threadId = '01a09e5a-b2d8-7de0-bd0f-2870c909e188';
    const marker = 'SPELLCAST_NATIVE_DELIVERY_' + crypto.randomUUID();
    const result = await request('tools/call', { namespace: 'codex_app', tool: 'send_message_to_thread', threadId, turnId: 'spellcast-native-ui-probe', callId: 'spellcast-send-' + crypto.randomUUID(), arguments: { threadId, prompt: '这是 Spellcast 原生投递通道的单次验收。只回复：' + marker + '。不要读写任何文件，不要改变现有方案，不要调用其他工具。' } });
    fs.writeFileSync('artifacts/workbench-20260914/native-app-tools-send.json', JSON.stringify({ threadId, marker, result }, null, 2));
    console.log(JSON.stringify({ threadId, marker, result }));
  }
  if (process.argv.includes('--read')) {
    const threadId = process.env.CODEX_THREAD_ID; if (!threadId) throw Error('Missing actual caller task identity');
    const result = await request('tools/call', { namespace: 'codex_app', tool: 'read_thread', threadId, turnId: process.env.CODEX_TURN_ID || 'spellcast-readonly-probe', callId: 'spellcast-readonly-' + crypto.randomUUID(), arguments: { threadId: '01a09e5a-b2d8-7de0-bd0f-2870c909e188', hostId:'local', turnLimit:1, includeOutputs:false, maxOutputCharsPerItem:0 } });
    fs.writeFileSync('artifacts/workbench-20260914/native-app-tools-read-thread.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result).slice(0,3500));
  }
} finally { socket.destroy(); }
