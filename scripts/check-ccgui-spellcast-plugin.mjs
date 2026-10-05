import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const source = await readFile(new URL('../extensions/ccgui-spellcast/main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extensions/ccgui-spellcast/manifest.json', import.meta.url), 'utf8'));
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const fields = ['client', 'engine', 'nativeSessionId', 'guiSessionId', 'workspacePath', 'clientInstanceId', 'windowId'];
const targetKey = target => JSON.stringify(fields.map(field => target?.[field]));
const secret = 'a'.repeat(64), legacyLedgerKey = 'delivery-ledger-v1';
const scopedLedgerKey = identity => 'delivery-ledger-v2:' + JSON.stringify([identity.clientInstanceId, identity.windowId]);
const target = (number = 1, document = 'doc-1') => ({ client: 'ccgui', engine: 'claude', nativeSessionId: `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  guiSessionId: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`, workspacePath: `G:/exact/project-${number}`, clientInstanceId: document, windowId: 'window-1', status: 'idle' });
function harness(options = {}) {
  const storage = options.storage || new Map([['bootstrap-key', secret], ['enabled', true]]);
  const sdkLedger = options.sdkLedger || new Map(), backend = options.backend || { hosts: new Map(), items: [], receipts: new Map(), generation: 0 };
  backend.receivedAt ||= new Map();
  const initialTarget = options.target || target(), ledgerKey = scopedLedgerKey(initialTarget);
  const documentIdentity = { clientInstanceId: initialTarget.clientInstanceId, windowId: initialTarget.windowId };
  const state = { current: options.noSelection ? null : initialTarget, open: new Map(), now: options.now || 100000, failWrite: null, httpHook: options.httpHook || null, submitHook: null,
    transports: [], submissions: [], selected: [], timers: new Map(), eventListeners: new Set(), chatListeners: new Set(), effects: [], states: [], cursor: 0, settings: null, storageReads: [], storageWrites: [], identityCalls: 0 };
  if (state.current) state.open.set(targetKey(state.current), state.current);
  let timerId = 0;
  const ctx = {
    host: { isWeb: false },
    react: {
      createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; },
      useState(initial) { const index = state.cursor++; if (!(index in state.states)) state.states[index] = initial; return [state.states[index], value => { state.states[index] = typeof value === 'function' ? value(state.states[index]) : value; }]; },
      useEffect(effect) { state.effects.push(effect()); },
    },
    storage: {
      async get(key) { state.storageReads.push(key); assert.ok(state.identityCalls > 0, 'identity must precede storage reads'); return clone(storage.get(key) ?? null); },
      async set(key, value) { state.storageWrites.push(key); if (state.failWrite?.(key, value)) throw new Error('storage failure'); storage.set(key, clone(value)); },
      async delete(key) { storage.delete(key); },
    },
    ui: { registerSettingsSection(definition) { state.settings = definition.component; return () => { state.settings = null; }; } },
    events: { on(topic, callback) { assert.equal(topic, 'session://activated'); state.eventListeners.add(callback); if (options.retained) callback(clone(options.retained)); return () => state.eventListeners.delete(callback); } },
    sessions: { async selectSession(engine, id, cwd) { state.selected.push([engine, id, cwd]); } },
    chat: {
      async identity() { state.identityCalls++; if (options.identityThrows) throw new Error('identity not available'); return clone(options.identity === undefined ? documentIdentity : options.identity); },
      async current() { return clone(state.current); },
      async inspect(value) { return clone(state.open.get(targetKey(value)) || null); },
      async receipt(id) { const value = sdkLedger.get(id); return value && value.target.clientInstanceId === documentIdentity.clientInstanceId && value.target.windowId === documentIdentity.windowId ? clone(value) : null; },
      async submit(request) {
        assert.ok(state.open.has(targetKey(request.target)), 'submission must address an exact open target');
        const saved = storage.get(ledgerKey)?.requests.find(record => record.id === request.requestId);
        assert.ok(saved?.attempted, 'submission intent must already be durable');
        if (sdkLedger.has(request.requestId)) throw new Error('fake SDK forbids duplicate submission');
        state.submissions.push(clone(request));
        const value = { requestId: request.requestId, target: request.target, runId: 'run-' + request.requestId, status: options.busy ? 'queued' : 'executing', acceptedAt: state.now, updatedAt: state.now };
        sdkLedger.set(request.requestId, clone(value));
        if (state.submitHook) return state.submitHook(request, value);
        return clone(value);
      },
      onEvent(callback) { state.chatListeners.add(callback); return () => state.chatListeners.delete(callback); },
    },
    bridge: { async invoke(command, args) {
      assert.equal(command, 'plugin_http_request'); assert.ok(args.url.startsWith('http://127.0.0.1:47194/'));
      const url = new URL(args.url), body = args.body ? JSON.parse(args.body) : undefined;
      state.transports.push({ path: url.pathname, query: url.search, body: clone(body) });
      if (url.pathname === '/api/hosts/receipt') {
        const saved = storage.get(ledgerKey)?.requests.find(record => record.id === body.request_id);
        assert.deepEqual(saved?.pending, body, 'exact pending receipt must be durable before EVERY transport');
      }
      const custom = await state.httpHook?.({ url, body, args });
      if (custom) return custom;
      const ok = value => ({ status: 200, body: JSON.stringify(value) });
      if (url.pathname === '/api/hosts/register') {
        assert.equal(args.headers.Authorization, 'Bearer ' + secret);
        const { capabilities, active, label, ...identity } = body;
        assert.deepEqual(capabilities, ['canvas_requests', 'durable_receipts']);
        const pin = { ...identity, lease_id: 'lease-' + ++backend.generation, generation: backend.generation };
        const host = { pin, token: 'lease-token-' + backend.generation, expiresAt: state.now + 30000, active };
        for (const old of backend.hosts.values()) if (old.pin.gui_session_id === pin.gui_session_id && old.pin.client_instance_id === pin.client_instance_id && old.pin.window_id === pin.window_id) old.dead = true;
        backend.hosts.set(pin.lease_id, host);
        return ok({ host_pin: pin, lease_token: host.token, expires_at_ms: host.expiresAt, heartbeat_interval_ms: 10000 });
      }
      const host = backend.hosts.get(body?.host_pin.lease_id || url.searchParams.get('lease_id'));
      if (!host || host.dead || host.expiresAt <= state.now || args.headers.Authorization !== 'Bearer ' + host.token) return { status: 403, body: '{}' };
      if (url.pathname === '/api/hosts/heartbeat') {
        assert.deepEqual(body.host_pin, host.pin); host.expiresAt = state.now + 30000;
        if (body.active) host.active = true;
        return ok({ expires_at_ms: host.expiresAt });
      }
      if (url.pathname === '/api/hosts/requests') {
        const since = Number(url.searchParams.get('since'));
        const items = backend.items.filter(item => item.event.host_pin.lease_id === host.pin.lease_id && item.event.seq > since && !backend.receipts.has(item.event.request_id)).slice(0, 64);
        return ok({ requests: items, last_seq: items.at(-1)?.event.seq || since, ...(host.focus ? { focus: host.focus } : {}) });
      }
      if (url.pathname === '/api/hosts/receipt') {
        assert.deepEqual(body.host_pin, host.pin);
        const old = backend.receipts.get(body.request_id), item = backend.items.find(value => value.event.request_id === body.request_id);
        assert.equal(item?.event.seq, body.event_seq);
        if (old && old.receipt_seq === body.receipt_seq) { assert.deepEqual(body, old); return ok({}); }
        assert.ok(!old || body.receipt_seq > old.receipt_seq, 'receipt sequence must increase');
        const phase = old?.phase || 'queued';
        assert.ok(!['completed', 'failed', 'unknown'].includes(phase), 'terminal phase must be fenced');
        if (phase === 'queued') assert.ok(['queued', 'received', 'failed', 'unknown'].includes(body.phase), 'durable received cannot be skipped');
        if (body.text !== undefined) { assert.equal(body.phase, 'completed'); assert.ok(Array.from(body.text).length <= 16000); }
        if (['queued', 'received'].includes(body.phase) && !backend.receivedAt.has(body.request_id)) backend.receivedAt.set(body.request_id, state.now);
        backend.receipts.set(body.request_id, clone(body)); return ok({});
      }
      throw new Error('unexpected HTTP path');
    } },
  };
  if (options.chatFactory) {
    ctx.chat = options.chatFactory({ state, storage, ledgerKey, identity: documentIdentity });
    const identityMethod = ctx.chat.identity;
    ctx.chat.identity = async () => { state.identityCalls++; return identityMethod(); };
  }
  if (options.identityMissing) delete ctx.chat.identity;
  const sandbox = vm.createContext({ setTimeout(callback, ms) { const id = ++timerId; state.timers.set(id, { callback, due: state.now + ms }); return id; },
    clearTimeout(id) { state.timers.delete(id); }, Date: class extends Date { static now() { return state.now; } }, console });
  vm.runInContext(source.replace('export default function activate', 'function activate') + '\nglobalThis.activatePlugin = activate;', sandbox);
  const dispose = sandbox.activatePlugin(ctx);
  const drain = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  const tick = async (ms = 350) => { state.now += ms; for (const [id, timer] of [...state.timers]) if (timer.due <= state.now) { state.timers.delete(id); timer.callback(); } await drain(); };
  const render = () => { state.cursor = 0; return state.settings(); };
  const nodes = node => [node, ...(node.children || []).filter(child => child && typeof child === 'object').flatMap(nodes)];
  const button = (text, tree = render()) => nodes(tree).find(node => node.type === 'button' && node.children.includes(text));
  const signalActivation = async event => { for (const callback of state.eventListeners) callback(clone(event)); await drain(); };
  const activate = async value => { state.current = value; if (value) state.open.set(targetKey(value), value); for (const callback of state.eventListeners) callback({ engine: value?.engine || null, sessionId: value?.nativeSessionId || null, target: clone(value) }); await drain(); };
  const enqueue = (id, seq, lease = [...backend.hosts.values()].at(-1), notice = 'continue ' + id) => {
    const item = { event: { request_id: id, seq, host_pin: clone(lease.pin), text: 'raw ' + id }, notice, phase: 'queued' }; backend.items.push(item); return item;
  };
  const emit = async (id, status, text, overrides = {}) => {
    const value = { ...sdkLedger.get(id), status, text, ...overrides }; sdkLedger.set(id, clone(value)); for (const callback of state.chatListeners) callback(clone(value)); await drain();
  };
  return { state, storage, sdkLedger, backend, ctx, drain, tick, dispose, activate, signalActivation, enqueue, emit, render, button, ledgerKey,
    diagnosisKey: 'diagnosis-v1:' + JSON.stringify([documentIdentity.clientInstanceId, documentIdentity.windowId]) };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
let actualSdk;
async function loadActualSdk() {
  if (actualSdk) return actualSdk;
  const hostRoot = '../artifacts/ccgui-compat/ccgui-host-src/';
  const ts = createRequire(new URL(hostRoot + 'package.json', import.meta.url))('typescript');
  const [bridgeSource, typesSource] = await Promise.all(['src/features/plugins/runtime/chat-bridge.ts', 'src/features/chat/store/types.ts']
    .map(path => readFile(new URL(hostRoot + path, import.meta.url), 'utf8')));
  const compile = (code, dependencies) => {
    const exports = {}, sandbox = vm.createContext({ exports, structuredClone, console, require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'composition uses only declared injected SDK dependencies: ' + name);
      return dependencies[name];
    } });
    const result = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    vm.runInContext(result.outputText, sandbox); return exports;
  };
  const types = compile(typesSource, {});
  const bridge = compile(bridgeSource, { '@/lib/events': { listenEngineEvents() { throw new Error('engine listener must be injected'); } },
    '@/lib/id': { newId() { throw new Error('run ID must be injected'); } }, '@/lib/transport': { isWeb: false }, '@/features/chat/store/types': types });
  actualSdk = { ...bridge, HostChatBusyError: types.HostChatBusyError }; return actualSdk;
}
function actualChatFactory(sdk, options = {}, capture) {
  return ({ state, storage, ledgerKey, identity }) => {
    const hostKey = sdk.hostChatLedgerKey(identity), subscribers = new Set();
    const control = { status: options.status || 'idle', calls: [], actualStarts: 0, publicStatuses: [], engineCallback: null,
      resolveAck: null, committedThrow: false, hostKey, bridge: null };
    const nativeStorage = {
      async get(pluginId, key) { assert.equal(pluginId, manifest.id); return clone(storage.get(key) || null); },
      async set(pluginId, key, value) {
        assert.equal(pluginId, manifest.id); storage.set(key, clone(value));
        if (options.commitThenThrow && !control.committedThrow && value.entries.some(entry => entry.receipt.status === 'queued')) {
          control.committedThrow = true; throw new Error('native KV committed but ACK was lost');
        }
      },
    };
    const host = {
      identity, current() { return state.current ? { ...state.current, status: control.status } : null; },
      inspect(value) { const found = state.open.get(targetKey(value)); return found ? { ...found, status: control.status } : null; },
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); }, wasInterrupted() { return false; },
      async send(value, prompt, runId) {
        const durable = storage.get(ledgerKey)?.requests.find(record => record.prompt === prompt && record.attempted);
        assert.ok(durable, 'composed adapter intent must precede a native send attempt');
        control.calls.push({ target: clone(value), prompt, runId });
        if (options.busyBeforeSpawn) { control.status = 'busy'; throw new sdk.HostChatBusyError(); }
        control.actualStarts++;
        if (options.deferAck) return new Promise(resolve => { control.resolveAck = resolve; });
        return { runId, sessionId: value.nativeSessionId };
      },
    };
    let run = 0;
    const bridge = sdk.createHostChatBridge(manifest.id, nativeStorage, { host: async () => host,
      listen: async callback => { control.engineCallback = callback; return () => { control.engineCallback = null; }; },
      now: () => state.now, runId: () => 'run-composed-' + ++run });
    control.bridge = bridge;
    bridge.onEvent(value => control.publicStatuses.push(value.status)); capture(control); return bridge;
  };
}
const composedTarget = (number = 1) => { const value = target(number); return { ...value, guiSessionId: value.nativeSessionId }; };
test('single-file SDK contract and least permissions', async () => {
  assert.ok(!/\bimport\s|\beval\s*\(|new Function|__TAURI__|document\.|window\./.test(source));
  assert.deepEqual(manifest.permissions, ['host:chat', 'host:session', 'events', 'storage', 'ui:settings-section', 'network:127.0.0.1:47194']);
});
test('public identity is required before any ledger access, including empty selection', async () => {
  for (const options of [{ identityMissing: true }, { identity: null }, { identity: { clientInstanceId: '', windowId: 'window' } },
    { identity: { clientInstanceId: 'doc', windowId: 'bad\nwindow' } }, { identityThrows: true }]) {
    const f = harness(options); try {
      await f.drain(); assert.equal(f.state.storageReads.length, 0); assert.equal(f.state.storageWrites.length, 0); assert.equal(f.state.transports.length, 0);
      assert.ok(f.render().children.find(node => node.props?.role === 'status').children[0].includes('chat.identity()'));
      f.button('连接').props.onClick(); await f.drain(); assert.equal(f.state.transports.length, 0); assert.equal(f.state.storageWrites.length, 0);
    } finally { f.dispose(); }
  }
  const f = harness({ noSelection: true }); try {
    await f.drain(); assert.ok(f.state.storageReads.includes(f.ledgerKey)); assert.equal(f.backend.hosts.size, 0);
    await f.activate(target()); assert.equal(f.backend.hosts.size, 1); assert.equal(f.state.identityCalls, 1);
  } finally { f.dispose(); }
});
test('busy SDK acceptance stays queued while durable receipt records model-read timing', async () => {
  const f = harness({ busy: true }); try {
    await f.drain(); f.enqueue('busy', 1); await f.tick();
    assert.equal(f.backend.receipts.get('busy').phase, 'queued'); assert.ok(f.backend.receivedAt.get('busy') > 0);
    assert.equal(f.storage.get(f.ledgerKey).requests[0].phase, 'queued');
    assert.deepEqual(f.state.transports.filter(value => value.path === '/api/hosts/receipt').map(value => value.body.phase), ['queued']);
    await f.tick(); assert.equal(f.state.submissions.length, 1);
    await f.emit('busy', 'executing'); await f.emit('busy', 'completed', 'after original chat becomes idle');
    assert.equal(f.backend.receipts.get('busy').phase, 'completed');
  } finally { f.dispose(); }
});
test('cold null current becomes ready within bounded startup discovery and remains inactive', async () => {
  const f = harness({ noSelection: true }), expected = target(2);
  try {
    await f.drain(); assert.equal(f.backend.hosts.size, 0);
    assert.deepEqual(f.storage.get(f.diagnosisKey), { enabled: true, hasCredential: true, currentReady: false, stage: 'waiting_for_session', httpStatus: null });
    await f.tick(200); f.state.current = expected; f.state.open.set(targetKey(expected), expected); await f.tick(200);
    assert.equal(f.backend.hosts.size, 1); assert.equal([...f.backend.hosts.values()][0].active, false);
    assert.equal([...f.backend.hosts.values()][0].pin.native_session_id, expected.nativeSessionId);
    assert.equal(f.storage.get(f.ledgerKey).active, null); assert.equal(f.storage.get(f.diagnosisKey).stage, 'registered');
    assert.ok(f.state.transports.filter(value => value.path === '/api/hosts/register' || value.path === '/api/hosts/heartbeat').every(value => value.body.active === false));
  } finally { f.dispose(); }
});
test('first transient registration retries with backoff only the complete frozen startup tuple', async () => {
  for (const response of ['http', 'connection']) {
    let attempts = 0;
    const f = harness({ httpHook({ url }) {
      if (url.pathname === '/api/hosts/register' && ++attempts === 1) {
        if (response === 'connection') throw new Error('raw transport contains ' + secret);
        return { status: 500, body: JSON.stringify({ error: secret, prompt: 'must never enter diagnosis' }) };
      }
    } });
    try {
      await f.drain(); assert.equal(f.backend.hosts.size, 0); assert.equal(f.storage.get(f.diagnosisKey).stage, 'registration_retry');
      assert.equal(f.storage.get(f.diagnosisKey).httpStatus, response === 'http' ? 500 : null);
      const frozen = target(); f.state.current = target(3); f.state.open.set(targetKey(f.state.current), f.state.current);
      await f.tick(249); assert.equal(attempts, 1); await f.tick(1); assert.equal(attempts, 2);
      const registered = [...f.backend.hosts.values()][0];
      assert.deepEqual([registered.pin.native_session_id, registered.pin.gui_session_id, registered.pin.cwd, registered.pin.client_instance_id, registered.pin.window_id],
        [frozen.nativeSessionId, frozen.guiSessionId, frozen.workspacePath, frozen.clientInstanceId, frozen.windowId]);
      assert.equal(registered.active, false); assert.equal(f.state.submissions.length, 0); assert.equal(f.storage.get(f.diagnosisKey).stage, 'registered');
      const diagnostic = JSON.stringify(f.storage.get(f.diagnosisKey)); assert.ok(!diagnostic.includes(secret)); assert.ok(!diagnostic.includes('prompt'));
    } finally { f.dispose(); }
  }
});
test('bad pairing credential stops registration without hammering or changing stored enable/key', async () => {
  for (const status of [401, 403]) {
    let attempts = 0;
    const f = harness({ httpHook({ url }) { if (url.pathname === '/api/hosts/register') { attempts++; return { status, body: JSON.stringify({ error: secret }) }; } } });
    try {
      await f.drain(); for (let index = 0; index < 30; index++) await f.tick(350);
      await f.activate(target(2)); await f.tick(350);
      assert.equal(attempts, 1); assert.equal(f.backend.hosts.size, 0); assert.equal(f.storage.get('enabled'), true); assert.equal(f.storage.get('bootstrap-key'), secret);
      assert.deepEqual(f.storage.get(f.diagnosisKey), { enabled: true, hasCredential: true, currentReady: true, stage: 'pairing_error', httpStatus: status });
      assert.ok(f.render().children.find(node => node.props?.role === 'status').children[0].includes('连接密钥无效'));
      assert.ok(f.state.storageWrites.every(key => key === f.diagnosisKey));
      f.state.httpHook = null; f.render().children.find(node => node.type === 'input').props.onChange({ target: { value: secret } });
      f.button('连接').props.onClick(); await f.drain(); assert.equal(f.backend.hosts.size, 1); assert.equal([...f.backend.hosts.values()][0].active, true);
      assert.equal(f.storage.get(f.diagnosisKey).stage, 'registered');
    } finally { f.dispose(); }
  }
});
test('new explicit B activation cancels frozen loading startup A', async () => {
  const f = harness(), cold = target(1), explicit = target(2);
  try {
    f.state.open.clear(); await f.drain(); assert.equal(f.backend.hosts.size, 0);
    await f.signalActivation({ engine: 'claude', sessionId: explicit.nativeSessionId });
    f.state.current = explicit; f.state.open.set(targetKey(explicit), explicit); await f.tick(200);
    f.state.open.set(targetKey(cold), cold); await f.tick(1000);
    assert.equal(f.backend.hosts.size, 1); assert.equal([...f.backend.hosts.values()][0].pin.native_session_id, explicit.nativeSessionId);
    assert.equal([...f.backend.hosts.values()][0].active, true);
    assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/register').length, 1);
  } finally { f.dispose(); }
});
test('pairing authentication stop survives same-document plugin reload until explicit reconnect', async () => {
  let attempts = 0, next;
  const f = harness({ httpHook({ url }) { if (url.pathname === '/api/hosts/register') { attempts++; return { status: 401, body: '{}' }; } } });
  try {
    await f.drain(); assert.equal(attempts, 1); f.dispose();
    next = harness({ storage: f.storage, backend: f.backend, sdkLedger: f.sdkLedger, now: f.state.now }); await next.drain(); await next.tick(5000);
    assert.equal(next.state.transports.filter(value => value.path === '/api/hosts/register').length, 0);
    assert.equal(next.storage.get(next.diagnosisKey).stage, 'pairing_error'); assert.equal(next.storage.get('enabled'), true);
    next.render().children.find(node => node.type === 'input').props.onChange({ target: { value: secret } });
    next.button('连接').props.onClick(); await next.drain(); assert.equal(next.backend.hosts.size, 1);
    assert.equal(next.storage.get(next.diagnosisKey).stage, 'registered');
  } finally { f.dispose(); next?.dispose(); }
});
test('first registration recovery cannot rewrite another original lease pending pin or sequence', async () => {
  const f = harness(); let newAttempts = 0;
  try {
    await f.drain(); f.enqueue('old-pending', 1); await f.tick();
    f.state.httpHook = ({ url, body }) => {
      if (url.pathname === '/api/hosts/receipt' && body.request_id === 'old-pending' && body.phase === 'completed') return { status: 500, body: '{}' };
      if (url.pathname === '/api/hosts/register' && body.native_session_id === target(2).nativeSessionId && ++newAttempts === 1) return { status: 500, body: '{}' };
    };
    await f.emit('old-pending', 'completed', 'old exact result'); const saved = clone(f.storage.get(f.ledgerKey).requests[0]);
    assert.equal(saved.pending.phase, 'completed'); await f.activate(target(2)); await f.tick(250);
    const preserved = f.storage.get(f.ledgerKey).requests.find(record => record.id === 'old-pending');
    assert.deepEqual(preserved.pending, saved.pending); assert.equal(preserved.seq, saved.seq); assert.equal(preserved.leaseId, saved.leaseId);
    assert.deepEqual(preserved.target, saved.target); assert.equal(f.state.submissions.length, 1); assert.equal(newAttempts, 2);
  } finally { f.dispose(); }
});
test('cold loading and registration failures stop after the bounded budget, diagnostics contain no raw secrets', async () => {
  let attempts = 0;
  const f = harness({ httpHook({ url }) { if (url.pathname === '/api/hosts/register') { attempts++; return { status: 503, body: JSON.stringify({ error: secret }) }; } } });
  const loading = harness({ noSelection: true });
  try {
    await Promise.all([f.drain(), loading.drain()]);
    for (let index = 0; index < 50; index++) await Promise.all([f.tick(200), loading.tick(200)]);
    assert.equal(f.storage.get(f.diagnosisKey).stage, 'registration_timeout'); assert.equal(loading.storage.get(loading.diagnosisKey).stage, 'loading_timeout');
    const stopped = attempts; await f.tick(5000); assert.equal(attempts, stopped); assert.ok(stopped <= 8);
    loading.state.current = target(); loading.state.open.set(targetKey(target()), target()); await loading.tick(5000); assert.equal(loading.backend.hosts.size, 0);
    assert.deepEqual(Object.keys(f.storage.get(f.diagnosisKey)).sort(), ['currentReady', 'enabled', 'hasCredential', 'httpStatus', 'stage']);
    assert.ok(!JSON.stringify(f.storage.get(f.diagnosisKey)).includes(secret));
  } finally { f.dispose(); loading.dispose(); }
});
test('two simultaneous documents keep separate native KV snapshots and pending receipts', async () => {
  const firstTarget = target(1, 'doc-1'), secondTarget = { ...target(2, 'doc-2'), windowId: 'window-2' };
  const first = harness({ target: firstTarget });
  const second = harness({ target: secondTarget, storage: first.storage, sdkLedger: first.sdkLedger, backend: first.backend });
  try {
    await Promise.all([first.drain(), second.drain()]); assert.notEqual(first.ledgerKey, second.ledgerKey);
    const leaseFor = id => [...first.backend.hosts.values()].find(host => host.pin.client_instance_id === id);
    first.enqueue('window-first', 1, leaseFor('doc-1')); second.enqueue('window-second', 2, leaseFor('doc-2'));
    second.state.httpHook = ({ url, body }) => url.pathname === '/api/hosts/receipt' && body.phase === 'executing' ? { status: 500, body: '{}' } : undefined;
    await Promise.all([first.tick(), second.tick()]);
    assert.equal(first.sdkLedger.get('window-first').status, 'executing'); assert.equal(second.sdkLedger.get('window-second').status, 'executing');
    const savedSecond = clone(first.storage.get(second.ledgerKey)); assert.equal(savedSecond.requests[0].pending.phase, 'executing');
    const pendingSeq = savedSecond.requests[0].pending.receipt_seq;
    await first.emit('window-first', 'completed', 'first window result');
    assert.deepEqual(first.storage.get(second.ledgerKey), savedSecond, 'first window completion must preserve every byte of second snapshot');
    assert.equal(first.backend.receipts.get('window-first').phase, 'completed');
    second.sdkLedger.delete('window-second'); second.state.httpHook = null; await second.tick();
    assert.equal(second.backend.receipts.get('window-second').phase, 'unknown'); assert.ok(second.backend.receipts.get('window-second').receipt_seq > pendingSeq);
    assert.equal(second.state.submissions.length, 1); assert.equal(second.state.submissions[0].target.windowId, 'window-2');
    assert.ok(first.state.storageWrites.filter(key => key.startsWith('delivery-ledger-')).every(key => key === first.ledgerKey));
    assert.ok(second.state.storageWrites.filter(key => key.startsWith('delivery-ledger-')).every(key => key === second.ledgerKey));
  } finally { first.dispose(); second.dispose(); }
});
test('startup and retained activation do not claim attention; explicit connect does', async () => {
  const f = harness({ retained: { engine: 'claude', sessionId: target().nativeSessionId, target: target() } });
  try {
    await f.drain(); assert.equal([...f.backend.hosts.values()][0].active, false);
    const input = f.render().children.find(node => node.type === 'input'); input.props.onChange({ target: { value: secret } });
    f.button('连接').props.onClick(); await f.drain();
    assert.ok(f.state.transports.some(value => value.path === '/api/hosts/heartbeat' && value.body.active));
    await f.tick(6000); assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/heartbeat').at(-1).body.active, false);
  } finally { f.dispose(); }
});
test('switch mid-send freezes full identity; open original uses public SDK signature', async () => {
  const f = harness(); try {
    await f.drain(); f.state.submitHook = async (request, value) => { f.state.current = target(2); return clone(value); };
    f.enqueue('switch', 1); await f.tick(); assert.equal(f.state.submissions[0].target.nativeSessionId, target().nativeSessionId);
    await f.emit('switch', 'completed', 'original answer'); assert.equal(f.backend.receipts.get('switch').host_pin.native_session_id, target().nativeSessionId);
    f.button('打开原聊天').props.onClick(); await f.drain(); assert.deepEqual(f.state.selected[0], ['claude', target().guiSessionId, target().workspacePath]);
  } finally { f.dispose(); }
});
test('a completion focus request selects that chat once and answers with attention', async () => {
  const f = harness(); try {
    await f.drain();
    const lease = [...f.backend.hosts.values()][0];
    const attention = () => f.state.transports.filter(value => value.path === '/api/hosts/heartbeat' && value.body.active).length;
    const before = attention();
    lease.focus = { id: 'focus-1' };
    await f.tick();
    assert.deepEqual(f.state.selected, [['claude', target().guiSessionId, target().workspacePath]]);
    assert.equal(attention(), before + 1, 'attention is attested even when selecting the chat raises no activation event');
    // Spellcast keeps delivering the request until it sees that attention; the plugin acts on each id once.
    await f.tick(); await f.tick();
    assert.equal(f.state.selected.length, 1);
    lease.focus = { id: 'focus-2' }; await f.tick();
    assert.equal(f.state.selected.length, 2);
    assert.equal(f.render().children.some(node => typeof node === 'object' && node.props?.role === 'status' && node.children.includes('连接或持久化失败；请求仍保留，请检查本机连接。')), false);
  } finally { f.dispose(); }
});
test('a failing chat switch does not stop the poll, later requests and Canvas requests still work', async () => {
  const f = harness(); try {
    await f.drain();
    const lease = [...f.backend.hosts.values()][0];
    f.ctx.sessions.selectSession = async () => { throw new Error('unknown session'); };
    lease.focus = { id: 'broken' }; await f.tick();
    f.enqueue('after-failure', 1); await f.tick();
    assert.equal(f.state.submissions.length, 1, 'the poll kept going and accepted the Canvas request');
    f.ctx.sessions.selectSession = async (engine, id, cwd) => { f.state.selected.push([engine, id, cwd]); };
    lease.focus = { id: 'fixed' }; await f.tick();
    assert.equal(f.state.selected.length, 1);
  } finally { f.dispose(); }
});
test('a paused plugin ignores focus requests', async () => {
  const f = harness(); try {
    await f.drain();
    const lease = [...f.backend.hosts.values()][0];
    f.button('暂停').props.onClick(); await f.drain();
    lease.focus = { id: 'while-paused' }; await f.tick(); await f.tick();
    assert.equal(f.state.selected.length, 0);
  } finally { f.dispose(); }
});
test('Unicode scalar 16k boundary and host truncation flag', async () => {
  const f = harness(); try {
    await f.drain(); f.enqueue('emoji', 1); await f.tick(); const text = '😀'.repeat(15999) + '中🙂尾';
    await f.emit('emoji', 'completed', text); const body = f.backend.receipts.get('emoji');
    assert.equal(Array.from(body.text).length, 16000); assert.ok(body.text.endsWith('中')); assert.equal(body.truncated, true);
    assert.equal(f.sdkLedger.get('emoji').text, text);
    f.enqueue('flag', 2); await f.tick(); await f.emit('flag', 'completed', 'short', { truncated: true }); assert.equal(f.backend.receipts.get('flag').truncated, true);
  } finally { f.dispose(); }
});
test('storage failure blocks receipt transport on all retries and never replays submission', async () => {
  const f = harness(); try {
    await f.drain(); f.enqueue('storage', 1); await f.tick();
    const before = f.state.transports.filter(value => value.path === '/api/hosts/receipt').length;
    f.state.failWrite = (key, value) => key === f.ledgerKey && value.requests.some(record => record.pending?.phase === 'completed');
    await f.emit('storage', 'completed', 'safe result'); await f.tick(); await f.tick();
    assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/receipt').length, before);
    f.state.failWrite = null; await f.tick(); assert.equal(f.backend.receipts.get('storage').phase, 'completed'); assert.equal(f.state.submissions.length, 1);
  } finally { f.dispose(); }
});
test('storage failure before SDK submission never launches an ambiguous intent', async () => {
  const f = harness(); try {
    await f.drain(); f.enqueue('intent', 1);
    f.state.failWrite = (key, value) => key === f.ledgerKey && value.requests.some(record => record.attempted);
    await f.tick(); assert.equal(f.state.submissions.length, 0);
    f.state.failWrite = null; await f.tick(); assert.equal(f.state.submissions.length, 0); assert.equal(f.backend.receipts.get('intent').phase, 'unknown');
  } finally { f.dispose(); }
});
test('ambiguous HTTP ack retries identical payload with stable sequence across reload', async () => {
  const f = harness(); let reloaded;
  try {
    await f.drain(); f.enqueue('reload', 1); await f.tick(); const original = f.backend.receipts.get('reload');
    // Simulate server acceptance followed by a lost response.
    f.state.httpHook = ({ url, body }) => { if (url.pathname === '/api/hosts/receipt' && body.phase === 'completed') { f.backend.receipts.set(body.request_id, clone(body)); return { status: 500, body: '{}' }; } };
    await f.emit('reload', 'completed', 'durable answer'); const pending = clone(f.storage.get(f.ledgerKey).requests[0].pending);
    assert.ok(pending.receipt_seq > original.receipt_seq); f.dispose();
    reloaded = harness({ storage: f.storage, sdkLedger: f.sdkLedger, backend: f.backend, now: f.state.now }); await reloaded.drain();
    const replay = reloaded.state.transports.find(value => value.path === '/api/hosts/receipt'); assert.deepEqual(replay.body, pending); assert.equal(reloaded.state.submissions.length, 0);
    assert.equal(f.storage.get(f.ledgerKey).requests[0].seq, pending.receipt_seq);
    await reloaded.emit('reload', 'completed', 'different late output'); assert.deepEqual(f.backend.receipts.get('reload'), pending);
  } finally { f.dispose(); reloaded?.dispose(); }
});
test('acknowledged sequence and fingerprint survive same-document reload', async () => {
  const f = harness(); let next;
  try {
    await f.drain(); f.enqueue('sequence', 1); await f.tick(); const seq = f.backend.receipts.get('sequence').receipt_seq; f.dispose();
    next = harness({ storage: f.storage, sdkLedger: f.sdkLedger, backend: f.backend, now: f.state.now }); await next.drain();
    assert.equal(next.state.transports.filter(value => value.path === '/api/hosts/receipt').length, 0);
    await next.emit('sequence', 'completed', 'final'); assert.ok(f.backend.receipts.get('sequence').receipt_seq > seq); assert.equal(next.state.submissions.length, 0);
  } finally { f.dispose(); next?.dispose(); }
});
test('failed acknowledged-state save replays the already durable identical pending receipt', async () => {
  const f = harness(); let next;
  try {
    await f.drain(); f.enqueue('ack-save', 1); await f.tick();
    f.state.failWrite = (key, value) => key === f.ledgerKey && value.requests.some(record => record.phase === 'completed' && !record.pending);
    await f.emit('ack-save', 'completed', 'saved pending'); const accepted = clone(f.backend.receipts.get('ack-save'));
    assert.ok(f.storage.get(f.ledgerKey).requests[0].pending); f.dispose();
    next = harness({ storage: f.storage, sdkLedger: f.sdkLedger, backend: f.backend, now: f.state.now }); await next.drain();
    assert.deepEqual(next.state.transports.find(value => value.path === '/api/hosts/receipt').body, accepted); assert.equal(next.state.submissions.length, 0);
  } finally { f.dispose(); next?.dispose(); }
});
test('unknown and terminal outcomes fence late events and model replay', async () => {
  const f = harness(); try {
    await f.drain(); f.enqueue('unknown', 1); f.state.submitHook = async () => { f.sdkLedger.delete('unknown'); throw new Error('lost SDK result'); };
    await f.tick(); await f.tick(); assert.equal(f.backend.receipts.get('unknown').phase, 'unknown');
    const before = f.state.transports.length; await f.emit('unknown', 'completed', 'late', { target: target(), requestId: 'unknown' });
    assert.equal(f.state.transports.length, before); assert.equal(f.state.submissions.length, 1);
  } finally { f.dispose(); }
});
test('conflicting duplicates reject event seq, prompt and exact GUI target', async () => {
  const f = harness(); try {
    await f.drain(); const original = f.enqueue('duplicate', 1); await f.tick();
    f.state.httpHook = ({ url }) => url.pathname === '/api/hosts/requests' ? { status: 200, body: JSON.stringify({ requests: [original], last_seq: 1 }) } : undefined;
    const unchangedReceipts = f.state.transports.filter(value => value.path === '/api/hosts/receipt').length;
    await f.tick(); assert.equal(f.state.submissions.length, 1); assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/receipt').length, unchangedReceipts);
    const changedSeq = clone(original); changedSeq.event.seq = 2;
    const changedPrompt = clone(original); changedPrompt.notice = 'conflicting prompt';
    const changedPin = clone(original); changedPin.event.host_pin.gui_session_id = target(2).guiSessionId;
    for (const conflicting of [changedSeq, changedPrompt, changedPin]) {
      f.state.httpHook = ({ url }) => url.pathname === '/api/hosts/requests' ? { status: 200, body: JSON.stringify({ requests: [conflicting], last_seq: 2 }) } : undefined;
      const before = f.state.transports.filter(value => value.path === '/api/hosts/receipt').length;
      await f.tick(); assert.equal(f.state.submissions.length, 1);
      assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/receipt').length, before);
    }
    const record = f.storage.get(f.ledgerKey).requests.find(value => value.id === 'duplicate'); assert.equal(record.eventSeq, 1); assert.equal(record.prompt, original.notice);
    // Host event target mismatch must never produce a receipt.
    const receipts = f.state.transports.filter(value => value.path === '/api/hosts/receipt').length;
    await f.emit('duplicate', 'completed', 'wrong target', { target: target(2) }); assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/receipt').length, receipts);
  } finally { f.dispose(); }
});
test('permission status is mirrored through receipts without authorizing any action', async () => {
  const f = harness(); try {
    await f.drain(); f.enqueue('permission', 1); await f.tick(); await f.emit('permission', 'awaiting_permission');
    assert.equal(f.backend.receipts.get('permission').phase, 'awaiting_permission'); await f.tick();
    assert.equal(f.state.submissions.length, 1); assert.equal(f.backend.receipts.get('permission').phase, 'awaiting_permission');
    assert.ok(f.state.transports.every(value => ['/api/hosts/register', '/api/hosts/heartbeat', '/api/hosts/requests', '/api/hosts/receipt'].includes(value.path)));
    await f.emit('permission', 'executing'); await f.emit('permission', 'completed', 'permission resolved in original GUI'); assert.equal(f.backend.receipts.get('permission').phase, 'completed');
  } finally { f.dispose(); }
});
test('poll pagination passes 64 blocked requests without starvation', async () => {
  const f = harness(); try {
    await f.drain(); for (let index = 1; index <= 70; index++) f.enqueue('page-' + index, index);
    f.state.httpHook = ({ url, body }) => url.pathname === '/api/hosts/receipt' && body.request_id === 'page-1' ? { status: 500, body: '{}' } : undefined;
    await f.tick(); await f.tick(); assert.equal(f.state.submissions.length, 70); assert.equal(f.backend.receipts.get('page-70').phase, 'executing');
    assert.ok(f.state.transports.some(value => value.path === '/api/hosts/requests' && value.query.includes('since=64')));
  } finally { f.dispose(); }
});
test('independent simultaneous tabs progress despite one lease failure; Canvas preserves attention', async () => {
  const f = harness(); try {
    await f.drain(); const first = [...f.backend.hosts.values()][0]; await f.activate(target(2)); const second = [...f.backend.hosts.values()].at(-1);
    f.enqueue('a', 1, first); f.enqueue('b', 2, second);
    f.state.httpHook = ({ url }) => url.pathname === '/api/hosts/requests' && url.searchParams.get('lease_id') === first.pin.lease_id ? { status: 500, body: '{}' } : undefined;
    await f.activate(null); await f.tick(); assert.equal(f.backend.receipts.get('b').phase, 'executing');
    assert.equal(f.storage.get(f.ledgerKey).active.nativeSessionId, target(2).nativeSessionId);
    assert.equal(f.state.submissions[0].target.guiSessionId, target(2).guiSessionId);
  } finally { f.dispose(); }
});
test('Canvas activation cannot cancel the latest in-flight real host attention', async () => {
  const f = harness(); try {
    await f.drain(); const focused = f.activate(target(2)); const canvas = f.activate(null); await Promise.all([focused, canvas]);
    assert.equal(f.storage.get(f.ledgerKey).active.nativeSessionId, target(2).nativeSessionId);
    assert.ok(f.state.transports.some(value => value.path === '/api/hosts/register' && value.body.native_session_id === target(2).nativeSessionId && value.body.active));
  } finally { f.dispose(); }
});
test('explicit activation retries null current until that exact native session loads once', async () => {
  const f = harness({ noSelection: true }), intended = target(2);
  try {
    await f.drain(); await f.signalActivation({ engine: 'claude', sessionId: intended.nativeSessionId });
    await f.tick(200); assert.equal(f.backend.hosts.size, 0);
    f.state.current = intended; f.state.open.set(targetKey(intended), intended); await f.tick(200);
    assert.equal(f.backend.hosts.size, 1); assert.equal([...f.backend.hosts.values()][0].pin.native_session_id, intended.nativeSessionId);
    assert.equal([...f.backend.hosts.values()][0].active, true);
    assert.equal(f.storage.get(f.ledgerKey).active.nativeSessionId, intended.nativeSessionId);
    await f.tick(2000);
    assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/register').length, 1);
    assert.equal(f.state.transports.filter(value => value.path === '/api/hosts/heartbeat' && value.body.active).length, 0);
  } finally { f.dispose(); }
});
test('newer valid activation cancels delayed old activation before either loaded', async () => {
  const f = harness({ noSelection: true }), delayed = target(1), newer = target(2);
  try {
    await f.drain(); await f.signalActivation({ engine: 'claude', sessionId: delayed.nativeSessionId, target: delayed });
    await f.signalActivation({ engine: 'claude', sessionId: newer.nativeSessionId });
    f.state.current = delayed; f.state.open.set(targetKey(delayed), delayed); await f.tick(200);
    assert.equal(f.backend.hosts.size, 0, 'loaded old target cannot satisfy the newer intent');
    f.state.current = newer; f.state.open.set(targetKey(newer), newer); await f.tick(200);
    assert.equal(f.backend.hosts.size, 1); assert.equal([...f.backend.hosts.values()][0].pin.native_session_id, newer.nativeSessionId);
    assert.ok(f.state.transports.filter(value => value.path === '/api/hosts/register').every(value => value.body.native_session_id !== delayed.nativeSessionId));
  } finally { f.dispose(); }
});
test('activation freezes SDK or supplied exact descriptor through inspect-null and Canvas focus', async () => {
  for (const supplied of [false, true]) {
    const f = harness({ noSelection: true }), intended = target(2);
    try {
      await f.drain(); f.state.current = intended;
      await f.signalActivation({ engine: 'claude', sessionId: intended.nativeSessionId, ...(supplied ? { target: intended } : {}) });
      await f.tick(200); assert.equal(f.backend.hosts.size, 0);
      await f.activate(null); f.state.open.set(targetKey(intended), intended); await f.tick(200);
      assert.equal(f.backend.hosts.size, 1); assert.equal([...f.backend.hosts.values()][0].pin.native_session_id, intended.nativeSessionId);
      assert.equal([...f.backend.hosts.values()][0].active, true);
    } finally { f.dispose(); }
  }
});
test('wrong current UUID never substitutes for explicit intent, retries stop at ten seconds', async () => {
  const f = harness({ noSelection: true }), intended = target(2), wrong = target(3);
  try {
    await f.drain(); f.state.current = wrong; f.state.open.set(targetKey(wrong), wrong);
    await f.signalActivation({ engine: 'claude', sessionId: intended.nativeSessionId });
    for (let index = 0; index < 50; index++) await f.tick(200);
    assert.equal(f.backend.hosts.size, 0); assert.ok(f.render().children.find(node => node.props?.role === 'status').children[0].includes('仍未加载'));
    f.state.current = intended; f.state.open.set(targetKey(intended), intended); await f.tick(1000);
    assert.equal(f.backend.hosts.size, 0, 'expired activation must not become permanent discovery');
    await f.signalActivation({ engine: 'claude', sessionId: intended.nativeSessionId });
    assert.equal(f.backend.hosts.size, 1); assert.ok(!f.render().children.find(node => node.props?.role === 'status').children[0].includes('仍未加载'));
  } finally { f.dispose(); }
});
test('unload cancels bounded activation retry timers and prevents late registration', async () => {
  const f = harness({ noSelection: true }), intended = target(2);
  try {
    await f.drain(); await f.signalActivation({ engine: 'claude', sessionId: intended.nativeSessionId });
    assert.ok([...f.state.timers.values()].some(timer => timer.due === f.state.now + 200));
    f.dispose(); assert.equal(f.state.timers.size, 0); const before = f.state.transports.length;
    f.state.current = intended; f.state.open.set(targetKey(intended), intended); await f.tick(5000);
    assert.equal(f.state.transports.length, before); assert.equal(f.backend.hosts.size, 0);
  } finally { f.dispose(); }
});
test('expiry registers new exact lease for new sends and never migrates old pin', async () => {
  const f = harness(); try {
    await f.drain(); const old = [...f.backend.hosts.values()][0]; f.enqueue('old', 1, old); await f.tick();
    await f.tick(31000); const replacement = [...f.backend.hosts.values()].at(-1); assert.notEqual(replacement.pin.lease_id, old.pin.lease_id); assert.equal(replacement.active, false);
    assert.equal(f.storage.get(f.ledgerKey).requests.find(value => value.id === 'old').phase, 'unknown');
    f.enqueue('new', 2, replacement); await f.tick(); assert.equal(f.backend.receipts.get('new').phase, 'executing');
    await f.emit('old', 'completed', 'late old result'); assert.notEqual(f.backend.receipts.get('old').phase, 'completed');
    assert.equal(f.storage.get(f.ledgerKey).requests.find(value => value.id === 'old').leaseId, old.pin.lease_id);
  } finally { f.dispose(); }
});
test('closed target is not guessed; reopening exact descriptor restores new-send reachability', async () => {
  const f = harness(); try {
    await f.drain(); const original = [...f.backend.hosts.values()][0]; f.enqueue('closed', 1, original); f.state.open.clear(); f.state.current = null;
    await f.tick(); assert.equal(f.state.submissions.length, 0); await f.activate(target(2)); await f.tick(); assert.equal(f.state.submissions.length, 0);
    await f.activate(target()); await f.tick(); assert.equal(f.state.submissions[0].target.guiSessionId, target().guiSessionId);
  } finally { f.dispose(); }
});
test('new document startup leaves old ledger untouched, never replays and registers inactive', async () => {
  const f = harness(); let next;
  try {
    await f.drain(); f.enqueue('restart', 1); await f.tick(); f.dispose();
    const oldSnapshot = clone(f.storage.get(f.ledgerKey));
    next = harness({ storage: f.storage, sdkLedger: f.sdkLedger, backend: f.backend, target: target(1, 'doc-2'), now: f.state.now }); await next.drain();
    assert.deepEqual(next.storage.get(f.ledgerKey), oldSnapshot); assert.equal(next.storage.get(next.ledgerKey).requests.length, 0);
    assert.ok(!next.state.storageReads.includes(f.ledgerKey));
    assert.equal(next.state.submissions.length, 0); assert.equal([...next.backend.hosts.values()].at(-1).active, false);
    assert.equal([...next.backend.hosts.values()].at(-1).pin.client_instance_id, 'doc-2');
  } finally { f.dispose(); next?.dispose(); }
});
test('unscoped legacy live ledger is left untouched and never copied or replayed', async () => {
  const f = harness(); let next;
  try {
    await f.drain(); f.enqueue('legacy-live', 1); await f.tick(); f.dispose();
    const legacy = clone(f.storage.get(f.ledgerKey)); f.storage.set(legacyLedgerKey, legacy); f.storage.delete(f.ledgerKey);
    next = harness({ storage: f.storage, sdkLedger: f.sdkLedger, backend: f.backend, now: f.state.now }); await next.drain();
    assert.deepEqual(next.storage.get(legacyLedgerKey), legacy); assert.equal(next.storage.get(next.ledgerKey).requests.length, 0);
    assert.equal(next.state.submissions.length, 0); assert.ok(!next.state.storageReads.includes(legacyLedgerKey));
  } finally { f.dispose(); next?.dispose(); }
});
test('unload cancels subscriptions/timers and blocks late async transport', async () => {
  const f = harness(); let resolve;
  try {
    await f.drain(); f.state.submitHook = () => new Promise(done => { resolve = done; }); f.enqueue('unload', 1); await f.tick();
    assert.ok(resolve); f.dispose(); const before = f.state.transports.length; resolve(clone(f.sdkLedger.get('unload'))); await f.drain();
    assert.equal(f.state.transports.length, before); assert.equal(f.state.timers.size, 0); assert.equal(f.state.eventListeners.size, 0); assert.equal(f.state.chatListeners.size, 0);
  } finally { f.dispose(); }
});
test('actual SDK composition: busy acceptance commit-then-throw and same-document reload never start native execution', async () => {
  const sdk = await loadActualSdk(); let originalControl, restoredControl, restored;
  const original = harness({ target: composedTarget(), chatFactory: actualChatFactory(sdk, { status: 'busy', commitThenThrow: true }, control => { originalControl = control; }) });
  try {
    await original.drain(); original.enqueue('composed-commit', 1); await original.tick();
    assert.equal(originalControl.actualStarts, 0); assert.equal(originalControl.calls.length, 0);
    assert.equal(original.storage.get(originalControl.hostKey).entries[0].receipt.status, 'queued');
    original.dispose(); originalControl.bridge.dispose();
    restored = harness({ target: composedTarget(), storage: original.storage, backend: original.backend, now: original.state.now,
      chatFactory: actualChatFactory(sdk, { status: 'idle' }, control => { restoredControl = control; }) });
    await restored.drain(); assert.equal((await restored.ctx.chat.receipt('composed-commit')).status, 'unknown');
    assert.equal(restoredControl.calls.length, 0); assert.equal(restoredControl.actualStarts, 0);
    assert.equal(restored.backend.receipts.get('composed-commit').phase, 'unknown');
    assert.ok([...original.state.transports, ...restored.state.transports].filter(value => value.path === '/api/hosts/receipt').every(value => value.body.phase !== 'executing'));
  } finally { original.dispose(); originalControl?.bridge.dispose(); restored?.dispose(); restoredControl?.bridge.dispose(); }
});
test('actual SDK composition: done before mismatched spawn ACK never publishes completed', async () => {
  const sdk = await loadActualSdk(); let control;
  const f = harness({ target: composedTarget(), chatFactory: actualChatFactory(sdk, { deferAck: true }, value => { control = value; }) });
  try {
    await f.drain(); f.enqueue('composed-done', 1); await f.tick(); assert.equal(control.actualStarts, 1); assert.ok(control.resolveAck);
    const runId = control.calls[0].runId, session = composedTarget();
    control.engineCallback([{ engine: 'claude', sessionId: session.nativeSessionId, runId, seq: 1, kind: 'delta', data: 'original result' },
      { engine: 'claude', sessionId: session.nativeSessionId, runId, seq: 2, kind: 'done', data: null }]);
    await f.drain(); assert.ok(!control.publicStatuses.includes('completed')); assert.notEqual(f.backend.receipts.get('composed-done').phase, 'completed');
    control.resolveAck({ runId: 'wrong-run', sessionId: session.nativeSessionId }); await f.drain();
    assert.equal((await f.ctx.chat.receipt('composed-done')).status, 'unknown'); assert.equal(f.backend.receipts.get('composed-done').phase, 'unknown');
    assert.ok(f.state.transports.filter(value => value.path === '/api/hosts/receipt').every(value => value.body.phase !== 'completed'));
  } finally { control?.resolveAck?.({ runId: 'cleanup', sessionId: null }); f.dispose(); control?.bridge.dispose(); await f.drain(); }
});
test('actual SDK composition: typed pre-spawn busy race exposes no executing with zero starts', async () => {
  const sdk = await loadActualSdk(); let control;
  const f = harness({ target: composedTarget(), chatFactory: actualChatFactory(sdk, { busyBeforeSpawn: true }, value => { control = value; }) });
  try {
    await f.drain(); f.enqueue('composed-busy', 1); await f.tick(); await f.tick();
    assert.equal(control.calls.length, 1); assert.equal(control.actualStarts, 0); assert.equal((await f.ctx.chat.receipt('composed-busy')).status, 'queued');
    assert.ok(!control.publicStatuses.includes('executing')); assert.ok(['queued', 'received'].includes(f.backend.receipts.get('composed-busy').phase));
    assert.ok(f.state.transports.filter(value => value.path === '/api/hosts/receipt').every(value => value.body.phase !== 'executing'));
  } finally { f.dispose(); control?.bridge.dispose(); }
});
test('actual SDK composition: explicit delayed activation survives null current/inspect and registers exact loaded B', async () => {
  const sdk = await loadActualSdk(); let control;
  const f = harness({ target: composedTarget(1), chatFactory: actualChatFactory(sdk, {}, value => { control = value; }) });
  try {
    await f.drain(); const intended = composedTarget(2); f.state.current = null;
    await f.signalActivation({ engine: 'claude', sessionId: intended.nativeSessionId }); await f.tick(200);
    assert.equal([...f.backend.hosts.values()].filter(host => host.pin.native_session_id === intended.nativeSessionId).length, 0);
    f.state.current = intended; f.state.open.set(targetKey(intended), intended); await f.tick(200);
    const leases = [...f.backend.hosts.values()].filter(host => host.pin.native_session_id === intended.nativeSessionId);
    assert.equal(leases.length, 1); assert.equal(leases[0].active, true);
    assert.equal((await f.ctx.chat.current()).nativeSessionId, intended.nativeSessionId);
    assert.equal((await f.ctx.chat.inspect(intended)).guiSessionId, intended.guiSessionId); assert.equal(control.calls.length, 0);
  } finally { f.dispose(); control?.bridge.dispose(); }
});
test('actual SDK composition: cold identity/current loading registers only the ready source with inactive attention', async () => {
  const sdk = await loadActualSdk(); let control;
  const f = harness({ target: composedTarget(2), noSelection: true, chatFactory: actualChatFactory(sdk, {}, value => { control = value; }) });
  try {
    await f.drain(); assert.equal(await f.ctx.chat.current(), null); assert.equal(f.backend.hosts.size, 0);
    const loaded = composedTarget(2); f.state.current = loaded; f.state.open.set(targetKey(loaded), loaded); await f.tick(200);
    assert.equal(f.backend.hosts.size, 1); assert.equal([...f.backend.hosts.values()][0].pin.native_session_id, loaded.nativeSessionId);
    assert.equal([...f.backend.hosts.values()][0].active, false); assert.equal(f.storage.get(f.diagnosisKey).stage, 'registered');
    assert.equal(control.calls.length, 0); assert.equal(f.storage.get(f.ledgerKey).active, null);
  } finally { f.dispose(); control?.bridge.dispose(); }
});

let passed = 0;
for (const { name, run } of tests) {
  try { await run(); passed++; }
  catch (cause) { console.error('FAIL: ' + name + '\n' + cause.stack); process.exitCode = 1; break; }
}
if (passed === tests.length) console.log(`PASS ${passed}/${tests.length}: cold inactive discovery; bounded first-registration recovery; auth stop; secret-free diagnosis; document-scoped KV; identity fail-closed; busy queued; SDK boundary; attention/loading cancellation; frozen routing/pins; Unicode; storage fencing; reload/sequence; duplicates; terminal/unknown; pagination; independent tabs; expiry; close/reopen; restart; unload; actual SDK composition (commit-then-throw, done-before-ACK mismatch, pre-spawn busy, delayed activation, cold startup).`);
