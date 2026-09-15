import { createServer } from 'node:http';
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { board, feedback, scope } from './fixtures/feedback-inbox.mjs';
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/workbench-20260915', `inbox-browser-${Date.now()}`), dist = path.join(output, 'dist');
fs.mkdirSync(output, { recursive: true });
const mutations = []; let failFeedback = false;
const health = { surface: 'focus', port: 47368, last_call_ms: 0, calls: 0, agents: [], paused: false, observer_enabled: false };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:");
  if (url.pathname === '/__stop') { res.end('Stopped.'); server.close(); return; }
  if (url.pathname === '/__failure') { failFeedback = url.searchParams.get('on') === '1'; res.setHeader('Content-Type', 'text/html'); res.end(`<p>Feedback failure: ${failFeedback}</p><a href="/">Canvas</a>`); return; }
  if (url.pathname === '/__evidence') { const evidence = { method: 'Browser Use with isolated API fixtures; no production API or native task calls', mutations }; fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)); res.setHeader('Content-Type','text/html;charset=utf-8'); res.end(`<h1>隔离验收</h1><pre>${JSON.stringify(evidence, null, 2).replaceAll('<','&lt;')}</pre><form action="/__stop"><button>结束测试</button></form>`); return; }
  if (url.pathname.startsWith('/api/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === 'POST') mutations.push({ path: url.pathname, body });
    res.setHeader('Content-Type','application/json');
    if (url.pathname === '/api/feedback' && failFeedback) { res.statusCode = 503; res.end('{}'); return; }
    const fixtures = { '/api/board': board, '/api/feedback': feedback, '/api/health': health, '/api/surface': health, '/api/events': { events: [], last_seq: 8 }, '/api/forms': { forms: [] }, '/api/memories': { memories: [] }, '/api/observer/status': { enabled: false, paused: false, allowed: false, reason: 'fixture', policy_revision: 1 } };
    const retry = url.pathname.match(/^\/api\/feedback\/(\d+)\/retry$/);
    if (retry) { const receipt = feedback.deliveries.find(item => item.event.seq === Number(retry[1])); if (receipt) { receipt.phase = 'submitted'; receipt.error = null; res.end(JSON.stringify(receipt)); return; } }
    if (!fixtures[url.pathname]) { res.statusCode = 404; res.end('{"error":"Unexpected fixture route"}'); return; }
    res.end(JSON.stringify(fixtures[url.pathname])); return;
  }
  const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  const ext = path.extname(file); res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[ext] || 'text/html;charset=utf-8');
  let data = fs.readFileSync(file); if (ext === '.html') data = data.toString().replace('<head>', `<head><script>localStorage.setItem('spellcast.locale','zh-CN');localStorage.setItem('spellcast.mode','focus');localStorage.setItem('spellcast.canvas-scope',${JSON.stringify(JSON.stringify(scope))});</script>`);
  res.end(data);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
await build({ root, logLevel: 'error', define: { 'import.meta.env.VITE_API_URL': JSON.stringify(origin) }, build: { outDir: dist, emptyOutDir: false } });
console.log(JSON.stringify({ ready: true, origin, output }));
