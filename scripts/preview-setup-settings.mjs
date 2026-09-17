/** Browser Use fixture: real UI, simulated setup results, no Codex or production API calls. */
import { createServer } from 'node:http';
import { build } from 'vite';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/settings-trust-20260915', `browser-${Date.now()}`), dist = path.join(output, 'dist');
fs.mkdirSync(output, { recursive: true });
let scenario = 'trusted'; const calls = [];
const kinds = { trusted: 'verified', untrusted: 'installed_pending_trust', modified: 'installed_pending_trust', unknown: 'installed_unverified', disabled: 'installed_unverified', missing: 'not_installed' };
function report() { return { client: 'codex', kind: kinds[scenario], hook_trust: scenario === 'missing' ? null : scenario, complete_supported: true, installed: scenario !== 'missing', note: 'Isolated setup fixture', done: [], not_done: [], conflicts: [], source_path: 'C:/Fixture/plugins/spellcast', cache_path: 'C:/Fixture/cache/spellcast', mcp_url: origin + '/mcp' }; }
const lastActivity = Date.now() - 61 * 60 * 1000;
const health = { surface: 'focus', port: 47369, calls: 2, last_call_ms: lastActivity, paused: false, observer_enabled: true, agents: [{ client: 'rmcp 3.2.0', last_call_ms: lastActivity }, { client: 'codex-mcp-client 0.154.0-alpha.6.2', last_call_ms: lastActivity }] };
let connection = 'internal';
const connections = ['internal', 'mixed', 'external', 'unknown', 'empty', 'offline'];
function connectionHealth() {
  const agents = connection === 'internal' ? health.agents.slice(0, 1)
    : connection === 'mixed' ? [{ client: 'rmcp 3.2.0', last_call_ms: Date.now() }, health.agents[1]]
    : connection === 'external' ? health.agents.slice(1)
    : connection === 'unknown' ? [{ client: 'custom-client 1.0.0', last_call_ms: lastActivity }] : [];
  return { ...health, agents };
}
const board = { topic: '', form: 'spatial', form_reason: '', nodes: [], edges: [], replies: [], messages: [], canvas: { revision: 1, objects: [], items: [], compositions: [] } };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:");
  if (url.pathname === '/__stop') { res.end('Stopped.'); server.close(); return; }
  if (url.pathname === '/__scenario') {
    if (Object.hasOwn(kinds, url.searchParams.get('state'))) scenario = url.searchParams.get('state');
    if (connections.includes(url.searchParams.get('connection'))) connection = url.searchParams.get('connection');
    calls.push({ scenario, connection, path: '/__scenario' });
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(`<h1>隔离设置验收</h1><p>当前模拟状态：${scenario}；连接：${connection}。回到设置页，点击重新检查。</p>${Object.keys(kinds).map(s => `<p><a href="/__scenario?state=${s}">${s}</a></p>`).join('')}<h2>连接显示</h2>${connections.map(s => `<p><a href="/__scenario?connection=${s}">${s}</a></p>`).join('')}<a href="/">打开应用</a><p><a href="/__evidence">验收记录</a></p>`); return;
  }
  if (url.pathname === '/__evidence') {
    const value = { method: 'Browser Use, real frontend with simulated setup transport; no native install, trust write, model turn or production API', calls };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(value, null, 2));
    res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(`<pre>${JSON.stringify(value, null, 2)}</pre><form action="/__stop"><button>结束测试</button></form>`); return;
  }
  if (url.pathname.startsWith('/__setup/')) {
    calls.push({ path: url.pathname, method: req.method, scenario });
    if (url.pathname.endsWith('/install')) scenario = 'untrusted';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(report())); return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST') calls.push({ path: url.pathname, method: req.method });
    if (connection === 'offline' && url.pathname === '/api/health') { res.statusCode = 503; res.end('{"error":"Isolated unavailable service"}'); return; }
    const routes = { '/api/board': board, '/api/health': connectionHealth(), '/api/surface': health, '/api/feedback': { bindings: [], deliveries: [], pending: [] }, '/api/events': { events: [], last_seq: 0 }, '/api/forms': { forms: [] }, '/api/memories': { memories: [] }, '/api/observer/status': { enabled: true, paused: false, allowed: true, policy_revision: 1 } };
    res.setHeader('Content-Type', 'application/json'); res.statusCode = routes[url.pathname] ? 200 : 404; res.end(JSON.stringify(routes[url.pathname] || { error: 'Unexpected fixture route' })); return;
  }
  const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  const ext = path.extname(file); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[ext] || 'text/html;charset=utf-8');
  let data = fs.readFileSync(file); if (ext === '.html') data = data.toString().replace('<head>', `<head><script>localStorage.setItem('spellcast.locale','zh-CN');localStorage.setItem('spellcast.mode','focus');</script>`);
  res.end(data);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await build({ root, logLevel: 'error', define: { 'import.meta.env.VITE_API_URL': JSON.stringify(origin) }, plugins: [{ name: 'isolated-setup-transport', enforce: 'pre', transform(code, id) {
  if (!id.replaceAll('\\', '/').endsWith('/src/api.ts')) return;
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['completeSetupStatus', 'completeSetupInstall'].includes(n.name?.text));
  for (const node of [...edits].reverse()) {
    const install = node.name.text === 'completeSetupInstall';
    code = code.slice(0, node.getStart(source)) + `export async function ${node.name.text}(client: string, url: string): Promise<SetupReport> { return (await fetch('${origin}/__setup/${install ? 'install' : 'status'}', { method: '${install ? 'POST' : 'GET'}' })).json(); }` + code.slice(node.end);
  }
  if (edits.length !== 2) throw Error('Setup transport fixture was not installed');
  return { code, map: null };
} }], build: { outDir: dist, emptyOutDir: false } });
console.log(JSON.stringify({ ready: true, origin, output }));
