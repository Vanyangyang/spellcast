/** Isolated state regression: no desktop, browser surface, or user settings. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'artifacts/ccgui-compat/ccgui-host-src/package.json'));
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<html><body><main></main></body></html>', { url: 'http://localhost/' });
let setupReads = 0;
dom.window.__TAURI_INTERNALS__ = { invoke: async command => {
  if (command === 'bridge_status') return { port: 47194 };
  if (command === 'host_link_key') return 'a'.repeat(64);
  if (command === 'complete_setup_status') { setupReads++; return {client:'claude-code',installed:true,ccgui_plugin_path:'G:/Fixture/plugin',runtime_verified:false}; }
  throw new Error('Unexpected IPC ' + command);
} };
let live = [], readFailed = false;
const bundle = await build({ stdin: { contents: "export * from './src/host-link-ui'; export * from './src/connection-summary'; export {setLocale} from './src/i18n';", resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'browser', define: { 'import.meta.env': '{}' } });
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, window: dom.window, document: dom.window.document,
  navigator: dom.window.navigator, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  fetch: async () => { if (readFailed) throw new Error('offline'); return { ok: true, json: async () => ({ sessions: live }) }; },
  console, setTimeout, clearTimeout, crypto: globalThis.crypto });
vm.runInContext(bundle.outputFiles[0].text, context);
const api = module.exports; api.setLocale('zh-CN');
const unmount = api.mountHostLinkSettings(dom.window.document.querySelector('main'));
const section = dom.window.document.querySelector('[data-claude-pairing]');
const status = section.querySelector('[role=status]');
const diagnosticRows = () => [...section.querySelectorAll('[data-host-diagnostic-sessions] > li')];
const diagnostics = section.querySelector('[data-host-link-diagnostics]');
// The connection summary (home/settings status area): one row per client, never one per chat.
const overview = dom.window.document.createElement('div'); dom.window.document.body.append(overview);
const paintSummary = () => api.paintClientSummary(overview, [{ client: 'claude-code 2.1.4', last_call_ms: Date.now() }], 'none');
api.watchClientLinks(paintSummary);
const clientRows = () => [...overview.querySelectorAll('.client-summary-row')];
const clientRow = kind => overview.querySelector(`.client-summary-row[data-client="${kind}"]`);
const claudeText = () => clientRow('claude')?.querySelector('.client-summary-detail')?.textContent ?? '';
const dispatch = (name, detail) => dom.window.dispatchEvent(new dom.window.CustomEvent(name, { detail }));
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const host = (id, active = false) => ({ reachable: true, active, label: 'CC GUI · ' + id.slice(0, 8),
  capabilities: ['canvas_requests', 'durable_receipts'], last_seen_ms: 1, expires_at_ms: 2,
  host_pin: { client: 'ccgui', source_id: 'claude:' + id, native_session_id: id, gui_session_id: id, cwd: 'G:/Fixture',
    engine: 'claude', client_instance_id: 'instance-1', window_id: 'window-1', lease_id: 'lease-' + id, generation: 1 } });
const a = host('12345678-1234-4234-8234-123456789abc', true);
const b = host('22345678-1234-4234-8234-123456789abc');

dispatch('spellcast:setup-report', { client: 'claude-code', installed: true, ccgui_plugin_path: 'G:/Fixture/plugin', runtime_verified: false });
assert.equal(status.dataset.hostCheck, 'checking');
await settle();
assert.equal(status.dataset.hostCheck, 'empty');
assert.match(claudeText(), /尚未发现/); assert.equal(clientRow('claude').dataset.state, 'empty');
assert.match(status.textContent, /连接状态会自动更新/);
assert.doesNotMatch(section.textContent, /未配对|打开.*原会话/);
assert.equal(diagnostics.open, false);
assert.equal(section.querySelector('[data-host-diagnostic-help]').hidden, false);
section.querySelector('[data-host-diagnostic-help]').click(); assert.equal(diagnostics.open, true);
assert.equal(section.querySelector('[data-host-link-copy]').closest('details'), diagnostics);
assert.equal(section.querySelector('[data-claude-plugin-folder]').closest('details'), diagnostics);
assert.equal(section.querySelector('[data-claude-host-check]').closest('details'), diagnostics);

live = [a]; dispatch('spellcast:host-sessions', live);
assert.equal(status.dataset.connected, 'true');
assert.match(claudeText(), /1 个聊天连接/); assert.equal(clientRow('claude').dataset.tone, 'live');
assert.doesNotMatch(section.textContent, /请在 CC GUI 打开/);
assert.equal(diagnosticRows()[0].querySelector('strong').textContent, '聊天');
assert.ok(diagnosticRows()[0].textContent.includes(a.host_pin.native_session_id));
assert.ok(diagnosticRows()[0].textContent.includes(a.host_pin.cwd));
assert.doesNotMatch(overview.textContent, /12345678-1234|G:\/Fixture\/plugin/);
assert.deepEqual(clientRows().map(row => row.dataset.client), ['claude']); assert.ok(!overview.textContent.includes('Fixture'));
assert.ok([...overview.querySelectorAll('*')].every(node=>[...node.attributes].every(attribute=>!attribute.value.includes(a.host_pin.native_session_id)&&!attribute.value.includes(a.host_pin.cwd))));
assert.equal(diagnostics.open, true); assert.equal(section.querySelector('[data-host-diagnostic-help]').hidden, true);
diagnostics.open = false; dispatch('spellcast:host-sessions', live); assert.equal(diagnostics.open, false);
assert.equal(diagnosticRows()[0].dataset.recentlyActive, 'true');
assert.match(diagnosticRows()[0].textContent, /最近激活/);

live = [a, { ...b, label: '真实聊天标题' }]; dispatch('spellcast:host-sessions', live);
assert.equal(diagnosticRows()[1].querySelector('strong').textContent, '真实聊天标题');
assert.equal(diagnosticRows()[1].dataset.recentlyActive, 'false');
assert.equal(clientRows().length, 1); assert.match(claudeText(), /2 个聊天连接/); assert.doesNotMatch(overview.textContent, /真实聊天标题/);
live = [{ ...a, active: false }, { ...b, active: true }]; dispatch('spellcast:host-sessions', live);
assert.deepEqual(diagnosticRows().map(row => row.dataset.recentlyActive), ['false', 'true']);

live = [a, { ...a, host_pin: { ...a.host_pin, window_id: 'window-2', lease_id: 'lease-2' } }];
dispatch('spellcast:host-sessions', live);
assert.match(claudeText(), /2 个聊天连接/); assert.equal(diagnosticRows().length, 2); assert.equal(clientRows().length, 1);
assert.deepEqual(diagnosticRows().map(row => row.dataset.recentlyActive), ['true', 'true']);
assert.ok(diagnosticRows()[0].textContent.includes('window-1')); assert.ok(diagnosticRows()[1].textContent.includes('window-2'));
assert.ok(!overview.textContent.includes('window-1')); assert.match(status.textContent,/多个窗口/);

dispatch('spellcast:host-sessions', [{ ...a, reachable: false }, { ...b, capabilities: [] },
  { ...b, host_pin: { ...b.host_pin, client: 'another-client' } }]);
assert.equal(status.dataset.hostCheck, 'empty'); assert.equal(diagnosticRows().length, 0); assert.match(claudeText(), /尚未发现/);
readFailed = true; section.querySelector('[data-claude-host-check]').click(); await settle();
assert.equal(status.dataset.hostCheck, 'error'); assert.match(claudeText(), /无法检查/); assert.equal(clientRow('claude').dataset.state, 'error');
assert.doesNotMatch(claudeText(), /尚未发现|未配对/); assert.doesNotMatch(status.textContent, /尚未发现|未配对/);
assert.equal(section.querySelector('[data-host-diagnostic-help]').hidden, false); assert.equal(diagnostics.open,false);

// Execute the actual main refresh body to catch failure-to-empty event regressions.
const main = readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const start = main.indexOf('async function refreshStatus() {');
const end = main.indexOf('\nfunction applyMode()', start);
assert.ok(start >= 0 && end > start);
let statusFailed = false, hostReadFailed = true;
const refreshContext = vm.createContext({ window: dom.window, CustomEvent: dom.window.CustomEvent,
  fetchStatus: async () => { if (statusFailed) throw new Error('bridge offline'); return {}; },
  fetchHostSessions: async () => { if (hostReadFailed) throw new Error('hosts offline'); return live; },
  bridgeReachable: false, bridgeStatus: null, hostSessions: [], isDesktopShell: () => true,
  applyObserverSlice() {}, paintConnection() {}, paintObserver() {}, paintComposerContext() {}, boardTools: { paintLabels() {} } });
vm.runInContext(main.slice(start, end), refreshContext);
await refreshContext.refreshStatus();
assert.equal(status.dataset.hostCheck, 'error');
hostReadFailed = false; live = []; await refreshContext.refreshStatus();
assert.equal(status.dataset.hostCheck, 'empty');
live = [a, b]; await refreshContext.refreshStatus(); assert.equal(status.dataset.connected, 'true');
statusFailed = true; await refreshContext.refreshStatus();
assert.equal(status.dataset.hostCheck, 'error'); assert.equal(diagnosticRows().length, 0); assert.equal(clientRow('claude').dataset.state, 'error');

readFailed = false; statusFailed = false; await refreshContext.refreshStatus();
api.setLocale('en'); paintSummary(); assert.match(claudeText(), /2 chat connections/);
assert.match(diagnosticRows()[0].textContent, /Recently active/); assert.doesNotMatch(section.textContent, /Open your working conversation/);
assert.equal(diagnostics.open,false);assert.equal(diagnostics.querySelector('summary').textContent,'Advanced / diagnostics');
const binding={source_id:'codex:32345678-1234-4234-8234-123456789abc',thread_id:'32345678-1234-4234-8234-123456789abc',label:'Real Codex chat',cwd:'G:/CodeProject',protocol_agent:'codex',bound_at_ms:1};
const codexStatus=()=>clientRow('codex');
dispatch('spellcast:recipient-evidence',{bindings:[binding],target:binding,confirmed:true,canReturn:true});assert.equal(codexStatus().dataset.state,'bound');assert.doesNotMatch(codexStatus().textContent,/online|connected/i);
assert.deepEqual(clientRows().map(row=>row.dataset.client),['codex','claude']);assert.equal(codexStatus().dataset.tone,'idle');assert.doesNotMatch(overview.textContent,/Real Codex chat|CodeProject/);
const targetStatus={...binding,status:'available',checked_at_ms:Date.now()};
dispatch('spellcast:recipient-evidence',{bindings:[binding],target:binding,status:targetStatus,confirmed:true,canReturn:true});assert.equal(codexStatus().dataset.state,'checked');
dispatch('spellcast:recipient-evidence',{bindings:[binding],target:binding,status:{...targetStatus,status:'unknown'},confirmed:true,canReturn:true});assert.equal(codexStatus().dataset.state,'unknown');
dispatch('spellcast:recipient-evidence',{bindings:[binding],target:binding,status:{...targetStatus,source_id:b.host_pin.source_id},confirmed:true,canReturn:true});assert.equal(codexStatus().dataset.state,'bound');
dispatch('spellcast:recipient-evidence',{bindings:[binding],target:binding,status:{...targetStatus,checked_at_ms:Date.now()-31000},confirmed:true,canReturn:true});assert.equal(codexStatus().dataset.state,'bound');
assert.equal(diagnostics.querySelector('[data-codex-diagnostic-sessions] > li').querySelector('strong').textContent,'Real Codex chat');
dispatch('spellcast:setup-report',{client:'codex',installed:true});await settle();assert.equal(section.hidden,false);assert.equal(diagnostics.open,false);
unmount(); dispatch('spellcast:host-sessions-error'); assert.equal(dom.window.document.querySelector('[data-claude-pairing]'), null);
live=[];const unmountFresh=api.mountHostLinkSettings(dom.window.document.querySelector('main'));
dispatch('spellcast:setup-report',{client:'codex',installed:true,mcp_url:'http://127.0.0.1:47194/mcp'});await settle();
const fresh=dom.window.document.querySelector('[data-claude-pairing]'),advanced=fresh.querySelector('details');
assert.equal(advanced.open,false);assert.equal(fresh.querySelector('[data-host-link-copy]').disabled,true);assert.equal(setupReads,0);
assert.match(fresh.querySelector('[data-host-diagnostic-help]').textContent,/Configure Claude/);
fresh.querySelector('[data-host-diagnostic-help]').click();await settle();assert.equal(advanced.open,true);assert.equal(setupReads,1);assert.equal(fresh.querySelector('[data-host-link-copy]').disabled,false);
dispatch('spellcast:setup-report',{client:'codex',installed:true});await settle();api.setLocale('zh-CN');assert.equal(advanced.open,true);assert.equal(setupReads,1);
advanced.open=false;dispatch('spellcast:host-sessions',[]);assert.equal(advanced.open,false);unmountFresh();
console.log(JSON.stringify({ pass: true, checks: 30, method: 'Isolated DOM + actual main refresh body + connection summary; no CU or desktop automation' }));
