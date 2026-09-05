// A transparent MCP client for recording and reproducing the local demo.
// This is not host tool injection, a model runner, or automatic agent polling.
import { readFileSync } from 'node:fs';
const [name, input] = process.argv.slice(2);
if (!name) throw new Error('Usage: node scripts/demo-mcp.mjs <tool-name> [arguments.json]');
const args = input ? JSON.parse(readFileSync(input, 'utf8')) : {};
const response = await fetch('http://127.0.0.1:47194/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
  body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name, arguments:args } }),
});
const raw = await response.text();
const data = raw.split(/\r?\n/).find(line => line.startsWith('data: '));
const message = JSON.parse(data ? data.slice(6) : raw);
if (!response.ok || message.error || message.result?.isError) throw new Error(JSON.stringify(message));
console.log(JSON.stringify(message.result.structuredContent ?? message.result, null, 2));
