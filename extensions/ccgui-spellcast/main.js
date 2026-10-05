export default function activate(ctx) {
  const h = ctx.react.createElement, leases = new Map(), requests = new Map(), registrations = new Map(), listeners = new Set(), timers = new Map(), attentionTimers = new Set();
  const base = 'http://127.0.0.1:47194';
  const fields = ['client', 'engine', 'nativeSessionId', 'guiSessionId', 'workspacePath', 'clientInstanceId', 'windowId'];
  const pinFields = ['source_id', 'client', 'engine', 'native_session_id', 'gui_session_id', 'cwd', 'client_instance_id', 'window_id', 'lease_id', 'generation'];
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  const terminal = phase => ['completed', 'failed', 'unknown'].includes(phase);
  const statuses = ['queued', 'received', 'executing', 'awaiting_permission', 'completed', 'failed', 'unknown'];
  const stageLabels = { initializing: '初始化', identity_error: '窗口身份不可用', ready: '等待发现聊天', paused: '已暂停',
    waiting_for_session: '等待聊天加载', registering: '正在登记', registered: '已登记', pairing_error: '密钥配对失败',
    registration_retry: '等待重试登记', registration_stopped: '登记已停止', registration_timeout: '登记超时', loading_timeout: '聊天加载超时' };
  const key = target => JSON.stringify(fields.map(field => target?.[field]));
  const same = (a, b) => Boolean(a && b && key(a) === key(b));
  const pinKey = pin => JSON.stringify(pinFields.map(field => pin?.[field]));
  const valid = target => target?.client === 'ccgui' && target.engine === 'claude' && uuid.test(target.nativeSessionId) && uuid.test(target.guiSessionId)
    && fields.every(field => typeof target[field] === 'string' && target[field].length > 0);
  const belongs = target => valid(target) && target.clientInstanceId === documentIdentity?.clientInstanceId && target.windowId === documentIdentity?.windowId;
  const targetPin = target => ({ source_id: 'claude:' + target.nativeSessionId, client: target.client, engine: target.engine,
    native_session_id: target.nativeSessionId, gui_session_id: target.guiSessionId, cwd: target.workspacePath,
    client_instance_id: target.clientInstanceId, window_id: target.windowId });
  let alive = true, enabled = false, bootstrap = '', active = null, error = '', identityError = '', documentIdentity = null, ledgerKey = null,
    attention = 0, running = false, pairingBlocked = false, diagnosisKey = null, saveTail = Promise.resolve(), focusTail = Promise.resolve(), diagnosisTail = Promise.resolve();
  let diagnosis = { enabled: false, hasCredential: false, currentReady: false, stage: 'initializing', httpStatus: null };
  const notify = () => { if (alive) for (const listener of listeners) listener(); };
  // Error text from transport/storage can contain credentials; expose only local diagnostics.
  const report = () => { error = identityError || (pairingBlocked ? '本机连接密钥无效；请重新填写密钥并点击连接。' : '连接或持久化失败；请求仍保留，请检查本机连接。'); notify(); };
  function diagnose(stage, patch = {}) {
    diagnosis = { enabled, hasCredential: Boolean(bootstrap), currentReady: patch.currentReady ?? diagnosis.currentReady,
      stage, httpStatus: Number.isInteger(patch.httpStatus) && patch.httpStatus >= 100 && patch.httpStatus <= 599 ? patch.httpStatus : null };
    notify();
    const value = { ...diagnosis };
    const task = diagnosisTail.catch(() => {}).then(async () => { if (alive && diagnosisKey) await ctx.storage.set(diagnosisKey, value); });
    diagnosisTail = task; return task;
  }
  const sleep = (ms, activation = false) => new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); attentionTimers.delete(timer); resolve(); }, ms);
    timers.set(timer, resolve); if (activation) attentionTimers.add(timer);
  });
  const cancelAttentionWait = () => {
    for (const timer of attentionTimers) { clearTimeout(timer); const resolve = timers.get(timer); timers.delete(timer); resolve?.(); }
    attentionTimers.clear();
  };
  const snapshot = () => ({ version: 1, active,
    leases: [...new Set([...leases.values(), ...[...requests.values()].map(record => record.lease)])]
      .map(({ target, pin, token, since, expiresAt, dead }) => ({ target, pin, token, since, expiresAt, dead })),
    requests: [...requests.values()].map(({ tail, lease, ...record }) => ({ ...record, leaseId: lease.pin.lease_id })) });
  function persist() {
    const task = saveTail.catch(() => {}).then(async () => { if (!alive || !documentIdentity || !ledgerKey) throw new Error('stopped'); await ctx.storage.set(ledgerKey, snapshot()); });
    saveTail = task; return task;
  }
  async function http(path, body, token, method = 'POST') {
    if (!alive || !enabled) throw new Error('stopped');
    const response = await ctx.bridge.invoke('plugin_http_request', { method, url: base + path,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!alive || !enabled) throw new Error('stopped');
    if (response.status < 200 || response.status >= 300) { const cause = new Error('transport'); cause.status = response.status; throw cause; }
    return JSON.parse(response.body || '{}');
  }
  async function retire(lease) {
    lease.dead = true;
    for (const record of requests.values()) if (record.lease === lease && !terminal(record.phase)) { record.phase = 'unknown'; record.pending = null; }
    await persist(); notify();
  }
  async function leaseFailure(lease, cause) {
    if ([401, 403, 404].includes(cause.status) || Date.now() >= lease.expiresAt) await retire(lease);
    report();
  }
  async function ensureLease(target, focused = false) {
    if (!belongs(target) || pairingBlocked) return null;
    const id = key(target);
    if (registrations.has(id)) {
      await registrations.get(id);
      return ensureLease(target, focused);
    }
    const known = leases.get(id);
    if (known && !known.dead && Date.now() < known.expiresAt) {
      if (focused) {
        try {
          const status = await http('/api/hosts/heartbeat', { host_pin: known.pin, active: true }, known.token);
          known.expiresAt = status.expires_at_ms; known.lastHeartbeat = Date.now(); await persist();
          return known;
        } catch (cause) { await leaseFailure(known, cause); if (!known.dead) throw cause; }
      } else return known;
    }
    const registering = (async () => {
      if (known && !known.dead) await retire(known);
      if (!same(await ctx.chat.inspect(target), target) || !alive || !enabled) return null;
      let response;
      try {
        response = await http('/api/hosts/register', { ...targetPin(target), capabilities: ['canvas_requests', 'durable_receipts'],
          active: Boolean(focused), label: 'CC GUI · ' + target.nativeSessionId.slice(0, 8) }, bootstrap);
      } catch (cause) {
        const failure = new Error('registration'); failure.registration = true; failure.status = cause?.status;
        if ([401, 403].includes(failure.status)) {
          pairingBlocked = true; report(); await diagnose('pairing_error', { currentReady: true, httpStatus: failure.status });
        }
        throw failure;
      }
      const expected = { ...targetPin(target), lease_id: response.host_pin?.lease_id, generation: response.host_pin?.generation };
      if (pinKey(expected) !== pinKey(response.host_pin) || !response.lease_token || !Number.isSafeInteger(expected.generation)) throw new Error('identity');
      const lease = { target: { ...target }, pin: response.host_pin, token: response.lease_token, since: 0,
        expiresAt: response.expires_at_ms, lastHeartbeat: Date.now(), dead: false };
      // Historical records keep their old lease objects and never migrate to this replacement.
      leases.set(id, lease); await persist(); return lease;
    })();
    registrations.set(id, registering);
    try { return await registering; } finally { registrations.delete(id); }
  }
  async function discover(focused, event) {
    // Canvas/empty selection does not cancel an in-flight real host attention event.
    if (event && (event.engine !== 'claude' || !uuid.test(event.sessionId) || event.target && (!valid(event.target)
      || event.target.engine !== event.engine || event.target.nativeSessionId !== event.sessionId))) return;
    if (focused) cancelAttentionWait();
    const generation = focused ? ++attention : attention;
    // Keep the explicit IDs, and freeze the complete SDK descriptor as soon as it is available.
    const intent = event ? { engine: event.engine, sessionId: event.sessionId, target: event.target ? { ...event.target } : null } : null;
    await ready;
    if (!alive || !enabled || !ctx.chat || ctx.host.isWeb || pairingBlocked) return;
    if (intent?.target && !belongs(intent.target)) return;
    const deadline = Date.now() + 10000;
    let frozen = intent?.target || null, failures = 0, lastStatus = null;
    await diagnose('waiting_for_session', { currentReady: false });
    while (alive && enabled && generation === attention) {
      const candidate = frozen || await ctx.chat.current();
      if (!alive || !enabled || generation !== attention) return;
      if (belongs(candidate) && (!intent || intent.engine === candidate.engine && intent.sessionId === candidate.nativeSessionId)) {
        frozen ||= { ...candidate };
        const inspected = await ctx.chat.inspect(frozen);
        if (!alive || !enabled || generation !== attention) return;
        if (same(inspected, frozen)) {
          await diagnose('registering', { currentReady: true });
          if (!alive || !enabled || generation !== attention) return;
          try {
            if (!focused) {
              if (await ensureLease(frozen, false)) {
                if (!alive || !enabled || generation !== attention) return;
                await diagnose('registered', { currentReady: true, httpStatus: 200 }); notify(); return;
              }
            } else {
              const target = frozen;
              const task = focusTail.catch(() => {}).then(async () => {
                if (!alive || !enabled || generation !== attention) return false;
                const lease = await ensureLease(target, true);
                if (!lease || !alive || !enabled || generation !== attention) return false;
                active = { ...target }; await persist();
                if (['原会话仍未加载；请重新激活该聊天或点击连接。', '本机连接暂未成功；请检查连接后点击连接。'].includes(error)) error = '';
                notify(); return true;
              });
              focusTail = task;
              if (await task) { await diagnose('registered', { currentReady: true, httpStatus: 200 }); return; }
            }
          } catch (cause) {
            if (!alive || !enabled || generation !== attention) return;
            if (pairingBlocked) return;
            if (!cause.registration || cause.status && cause.status < 500 && ![408, 429].includes(cause.status)) {
              await diagnose('registration_stopped', { currentReady: true, httpStatus: cause.status }); report(); return;
            }
            failures++; lastStatus = cause.status;
            await diagnose('registration_retry', { currentReady: true, httpStatus: lastStatus });
          }
        }
      }
      if (!alive || !enabled || generation !== attention) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        error = failures ? '本机连接暂未成功；请检查连接后点击连接。' : '原会话仍未加载；请重新激活该聊天或点击连接。';
        await diagnose(failures ? 'registration_timeout' : 'loading_timeout', { currentReady: failures > 0, httpStatus: lastStatus }); notify();
        return;
      }
      await sleep(Math.min(failures ? Math.min(250 * 2 ** (failures - 1), 2000) : 200, remaining), true);
    }
  }
  async function flush(record) {
    if (!record.pending || record.lease.dead || !alive || !enabled) return;
    // Every transport, including a retry after a failed storage write, requires a successful durable write.
    await persist();
    const pending = record.pending;
    await http('/api/hosts/receipt', pending, record.lease.token);
    if (record.lease.dead) return;
    record.phase = pending.phase; record.lastFingerprint = record.pendingFingerprint; record.pending = null;
    await persist(); notify();
  }
  async function sendPhase(record, phase, value) {
    await flush(record);
    if (terminal(record.phase) || record.lease.dead || !alive || !enabled) return;
    if (record.phase !== 'queued' && ['queued', 'received'].includes(phase)) return;
    const chars = phase === 'completed' ? Array.from(value?.text || '') : [];
    const text = chars.slice(0, 16000).join('');
    const body = { request_id: record.id, event_seq: record.eventSeq, host_pin: record.lease.pin, phase,
      ...(text.trim() ? { text, truncated: Boolean(value?.truncated || chars.length > 16000) } : {}) };
    const fingerprint = JSON.stringify(body);
    if (record.lastFingerprint === fingerprint) return;
    if (!Number.isSafeInteger(record.seq + 1)) throw new Error('sequence');
    record.seq++; record.pending = { ...body, receipt_seq: record.seq }; record.pendingFingerprint = fingerprint;
    await flush(record);
  }
  async function deliver(record, value) {
    if (!same(record.target, value?.target) || !statuses.includes(value.status)) throw new Error('identity');
    await flush(record);
    if (terminal(record.phase) || record.lease.dead) return;
    // The backend requires durable acceptance before any executing/completed transition.
    if (record.phase === 'queued' && !['queued', 'unknown', 'failed'].includes(value.status)) await sendPhase(record, 'received');
    await sendPhase(record, value.status, value);
  }
  function serial(record, operation) {
    const task = record.tail.catch(() => {}).then(async () => { await ready; if (alive && enabled) await operation(); });
    record.tail = task; return task;
  }
  async function process(record) {
    await flush(record);
    if (terminal(record.phase) || record.lease.dead || !alive || !enabled) return;
    const value = await ctx.chat.receipt(record.id);
    if (!alive || !enabled) return;
    if (value) { await deliver(record, value); return; }
    // Null after a persisted intent is ambiguous, including a new document: never replay.
    if (record.attempted) { await sendPhase(record, 'unknown'); return; }
    if (!same(await ctx.chat.inspect(record.target), record.target) || !alive || !enabled) return;
    record.attempted = true; await persist();
    if (!alive || !enabled) return;
    try {
      const accepted = await ctx.chat.submit({ requestId: record.id, target: { ...record.target }, prompt: record.prompt });
      if (alive && enabled) await deliver(record, accepted);
    } catch (cause) {
      // Submission may already have started. Subsequent processing reads its receipt, never submits again.
      throw cause;
    }
  }
  async function accept(lease, item) {
    const event = item?.event, id = event?.request_id, prompt = item?.notice || event?.text || '';
    if (!id || !Number.isSafeInteger(event.seq) || event.seq < 1 || pinKey(event.host_pin) !== pinKey(lease.pin) || typeof prompt !== 'string') throw new Error('identity');
    const identity = JSON.stringify([event.seq, pinKey(event.host_pin), key(lease.target), prompt]);
    let record = requests.get(id);
    if (record && record.identity !== identity) throw new Error('conflicting duplicate');
    if (!record) {
      record = { id, identity, eventSeq: event.seq, lease, target: { ...lease.target }, prompt, attempted: false,
        seq: 0, phase: 'queued', lastFingerprint: '', pendingFingerprint: '', pending: null, tail: Promise.resolve() };
      requests.set(id, record); await persist();
    }
    await serial(record, () => process(record));
  }
  async function poll(lease) {
    if (lease.dead) return;
    if (!same(await ctx.chat.inspect(lease.target), lease.target)) return;
    if (Date.now() >= lease.expiresAt) { await retire(lease); await ensureLease(lease.target, false); return; }
    if (Date.now() - lease.lastHeartbeat >= 5000) {
      const status = await http('/api/hosts/heartbeat', { host_pin: lease.pin, active: false }, lease.token);
      lease.expiresAt = status.expires_at_ms; lease.lastHeartbeat = Date.now();
    }
    const page = await http('/api/hosts/requests?lease_id=' + encodeURIComponent(lease.pin.lease_id) + '&since=' + lease.since + '&wait_ms=0', undefined, lease.token, 'GET');
    for (const item of page.requests || []) {
      try { await accept(lease, item); } catch (cause) { await leaseFailure(lease, cause); }
      if (!alive || !enabled || lease.dead) return;
    }
    // A completion card was double-clicked in Spellcast: bring this chat forward. The request stays in the poll
    // until the chat reports attention, so it is acted on once per id; selecting the chat reports it through
    // the activation event and the explicit heartbeat covers a chat that was already selected.
    if (page.focus?.id && page.focus.id !== lease.lastFocus) {
      lease.lastFocus = page.focus.id;
      try { await openOriginal(lease.target); await ensureLease(lease.target, true); }
      catch { /* Spellcast times the click out and keeps the card; nothing here may stop the poll. */ }
      if (!alive || !enabled || lease.dead) return;
    }
    // Retries are owned by the ledger; advancing even past one failed item lets the next page progress.
    if (Number.isSafeInteger(page.last_seq)) lease.since = Math.max(lease.since, page.last_seq);
    await persist();
  }
  async function loop() {
    if (running) return;
    running = true;
    try {
      while (alive && enabled) {
        for (const record of [...requests.values()]) {
          if (!alive || !enabled) break;
          if (!terminal(record.phase) && !record.lease.dead) {
            try { await serial(record, () => process(record)); } catch (cause) { await leaseFailure(record.lease, cause).catch(report); }
          }
        }
        for (const lease of [...leases.values()]) {
          if (!alive || !enabled) break;
          try {
            if (lease.dead) await ensureLease(lease.target, false); else await poll(lease);
          } catch (cause) { await leaseFailure(lease, cause).catch(report); }
        }
        if (alive && enabled) await sleep(350);
      }
    } finally { running = false; }
  }
  async function connect(value) {
    await ready;
    if (!documentIdentity) { report(); return; }
    if (!ctx.chat || ctx.host.isWeb) throw new Error('desktop required');
    if (!/^[0-9a-f]{64}$/i.test(value)) { error = '请填写本机 Spellcast 的连接密钥。'; notify(); return; }
    await ctx.storage.set('bootstrap-key', value); await ctx.storage.set('enabled', true);
    if (!alive) return;
    bootstrap = value; enabled = true; pairingBlocked = false; error = '';
    void loop().catch(report); await discover(true); notify();
  }
  async function openOriginal(target) {
    await ready;
    if (!alive || !belongs(target)) return;
    await ctx.sessions.selectSession(target.engine, target.guiSessionId, target.workspacePath);
  }
  function Settings() {
    const [, redraw] = ctx.react.useState(0), [value, setValue] = ctx.react.useState('');
    ctx.react.useEffect(() => { const fn = () => redraw(n => n + 1); listeners.add(fn); return () => listeners.delete(fn); }, []);
    return h('section', { style: { padding: 16 } },
      h('h3', null, 'Spellcast 原会话回发'), h('p', null, enabled ? '已启用。Canvas 请求会回到它所属的原聊天。' : '连接本机 Spellcast 后，可从 Canvas 继续当前聊天。'),
      h('input', { type: 'password', value, onChange: event => setValue(event.target.value), placeholder: '本机连接密钥', 'aria-label': '本机连接密钥' }),
      h('button', { disabled: !documentIdentity, onClick: () => void connect(value).catch(report) }, '连接'),
      h('button', { disabled: !documentIdentity, onClick: () => { enabled = false; cancelAttentionWait(); void ctx.storage.set('enabled', false).catch(report); void diagnose('paused').catch(report); notify(); } }, '暂停'),
      h('p', { role: 'status' }, error || (active ? '原会话：' + active.nativeSessionId.slice(0, 8) : '等待明确的 Claude 会话')),
      h('p', null, '连接诊断：' + (stageLabels[diagnosis.stage] || diagnosis.stage) + '；会话已加载：' + (diagnosis.currentReady ? '是' : '否') + (diagnosis.httpStatus ? '；HTTP ' + diagnosis.httpStatus : '')),
      ...[...requests.values()].map(record => h('p', { key: record.id }, '请求 ' + record.id + '：' + record.phase + ' ',
        h('button', { onClick: () => void openOriginal(record.target).catch(report) }, '打开原聊天'))),
      h('p', null, '失联或未知请求不会自动重放。完整回复保留在原聊天；画布最多显示 16,000 个字符。'));
  }
  const ready = (async () => {
    try {
      if (!ctx.chat || ctx.host.isWeb || typeof ctx.chat.identity !== 'function') throw new Error('desktop identity unavailable');
      const identity = await ctx.chat.identity();
      if (!identity || !['clientInstanceId', 'windowId'].every(field => typeof identity[field] === 'string' && identity[field].trim().length > 0
        && identity[field].length <= 160 && !/[\u0000-\u001f\u007f]/.test(identity[field]))) throw new Error('invalid desktop identity');
      if (!alive) return;
      documentIdentity = { clientInstanceId: identity.clientInstanceId, windowId: identity.windowId };
      ledgerKey = 'delivery-ledger-v2:' + JSON.stringify([documentIdentity.clientInstanceId, documentIdentity.windowId]);
      diagnosisKey = 'diagnosis-v1:' + JSON.stringify([documentIdentity.clientInstanceId, documentIdentity.windowId]);
    } catch {
      identityError = '需要支持 chat.identity() 的 CC GUI 桌面版本，当前无法确认窗口身份；连接已停止。';
      report(); await diagnose('identity_error'); return;
    }
    bootstrap = await ctx.storage.get('bootstrap-key') || '';
    const storedEnabled = Boolean(await ctx.storage.get('enabled'));
    const saved = await ctx.storage.get(ledgerKey);
    const savedDiagnosis = await ctx.storage.get(diagnosisKey);
    if (!alive) return;
    if (saved?.version === 1) {
      const byId = new Map();
      for (const data of saved.leases || []) if (belongs(data.target)) {
        const lease = { ...data, lastHeartbeat: 0 }, previous = leases.get(key(data.target));
        if (!previous || previous.pin.generation < lease.pin.generation) leases.set(key(data.target), lease);
        byId.set(data.pin.lease_id, lease);
      }
      for (const data of saved.requests || []) {
        let lease = byId.get(data.leaseId);
        // Replacement leases cannot erase a historical frozen route needed by a terminal ledger record.
        if (!lease && data.pending?.host_pin) lease = { target: data.target, pin: data.pending.host_pin, token: '', dead: true };
        if (lease && belongs(data.target) && same(lease.target, data.target)) requests.set(data.id, { ...data, lease, tail: Promise.resolve() });
      }
      active = belongs(saved.active) ? saved.active : null;
    }
    enabled = storedEnabled && Boolean(bootstrap) && Boolean(ctx.chat) && !ctx.host.isWeb;
    pairingBlocked = savedDiagnosis?.stage === 'pairing_error';
    if (enabled && pairingBlocked) {
      report(); await diagnose('pairing_error', { currentReady: savedDiagnosis.currentReady === true, httpStatus: savedDiagnosis.httpStatus });
    } else await diagnose(enabled ? 'ready' : 'paused');
  })();
  const disposers = [ctx.ui.registerSettingsSection({ key: 'bridge', label: () => 'Spellcast 回发', component: Settings })];
  // The retained subscription replay is startup discovery, not a fresh attention event.
  let subscribing = true;
  disposers.push(ctx.events.on('session://activated', event => {
    if (subscribing) return;
    void discover(true, event).then(() => { if (enabled) void loop().catch(report); }).catch(report);
  }));
  subscribing = false;
  if (ctx.chat) disposers.push(ctx.chat.onEvent(value => {
    const record = requests.get(value.requestId);
    if (record) void serial(record, () => deliver(record, value)).catch(cause => { void leaseFailure(record.lease, cause).catch(report); });
  }));
  void ready.then(async () => {
    if (!alive || !enabled) return;
    // New document identities cannot inherit old receipts or lease credentials.
    for (const lease of leases.values()) if (!same(await ctx.chat.inspect(lease.target), lease.target)) await retire(lease);
    void loop().catch(report); await discover(false); notify();
  }).catch(report);
  return () => {
    alive = false; enabled = false; attention++;
    for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); }
    timers.clear(); attentionTimers.clear(); for (const dispose of disposers.reverse()) dispose(); listeners.clear();
  };
}
