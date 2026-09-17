// Spellcast artifact protocol v1. This script runs only inside the sandboxed work.
(() => {
  if (Object.prototype.hasOwnProperty.call(window, 'spellcast')) return;
  let port, state = {}, inputs = { revision: 0, ports: {} }, resolveReady, inputReady = false, readOnly = false, stateGeneration = 0;
  let snapshotHandler = null;
  const standalone = parent === window;
  const storageKey = 'spellcast.export.state.' + (window.__SPELLCAST_ARTIFACT_ID__ ?? location.pathname);
  const listeners = new Set();
  const inputListeners = new Set();
  const earlyErrors = [];
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const copy = value => JSON.parse(JSON.stringify(value, (_key, item) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw new Error('State must contain JSON values.');
    return item;
  }));
  const send = (type, value) => port?.postMessage({ type, value });
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const portName = name => /^[A-Za-z0-9_:.-]{1,160}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
  const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && new TextEncoder().encode(value).length <= 16000);
  const changeState = next => { state = next; stateGeneration++; };
  const snapshotError = (request_id, error) => send('error', { request_id, message: String(error?.message ?? error).slice(0, 2000) });
  const captureSnapshot = request_id => {
    const capturedGeneration = stateGeneration;
    const capturedState = copy(state);
    if (!snapshotHandler) { send('snapshot', { request_id, state: capturedState, preview: null }); return; }
    Promise.resolve().then(() => snapshotHandler()).then(preview => {
      if (stateGeneration !== capturedGeneration) {
        snapshotError(request_id, 'State changed before the snapshot completed.');
        return;
      }
      send('snapshot', { request_id, state: capturedState, preview: preview == null ? null : copy(preview) });
    }).catch(error => snapshotError(request_id, error));
  };
  const api = {
    ready,
    get state() { return copy(state); },
    get inputs() { return copy(inputs); },
    setState(patch) {
      if (!port && !standalone) throw new Error('Await spellcast.ready before saving state.');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('State patch must be a JSON object.');
      if (readOnly) return;
      const next = { ...state, ...copy(patch) };
      if (new TextEncoder().encode(JSON.stringify(next)).length > 64000) throw new Error('Keep state under 64 KB; use asset files for large data.');
      changeState(next);
      send('state', state);
      if (standalone) { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {} }
    },
    select(selection) { api.setState({ selection }); },
    onRestore(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onInputs(fn) {
      if (typeof fn !== 'function') throw new Error('Input listener must be a function.');
      inputListeners.add(fn);
      if (inputReady) fn(api.inputs);
      return () => inputListeners.delete(fn);
    },
    /** Register one capture callback. Its result must be { src, alt }; the host validates preview bytes and type. */
    onSnapshot(fn) {
      if (typeof fn !== 'function') throw new Error('Snapshot handler must be a function.');
      snapshotHandler = fn;
      return () => { if (snapshotHandler === fn) snapshotHandler = null; };
    },
    publishOutputs(values, expectedInputRevision) {
      if (!port && !standalone) throw new Error('Await spellcast.ready before publishing outputs.');
      if (readOnly) return;
      if (!Number.isSafeInteger(expectedInputRevision) || expectedInputRevision < 0) throw new Error('Expected input revision is required.');
      if (expectedInputRevision !== inputs.revision) throw new Error('Inputs changed before outputs were published.');
      if (!plain(values)) throw new Error('Outputs must be a plain object.');
      for (const [name, value] of Object.entries(values)) {
        if (!portName(name) || !scalar(value)) throw new Error('Outputs must use valid port names and finite scalar values.');
      }
      const next = copy(values);
      if (new TextEncoder().encode(JSON.stringify(next)).length > 64000) throw new Error('Keep outputs under 64 KB.');
      send('outputs', { revision: expectedInputRevision, values: next });
    },
    reportError(error) {
      const message = String(error?.message ?? error).slice(0, 2000);
      if (port) send('error', message); else if (earlyErrors.length < 10) earlyErrors.push(message);
    },
  };
  Object.defineProperty(window, 'spellcast', { value: Object.freeze(api), configurable: false });
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'spellcast:init' || !event.ports[0] || port) return;
    port = event.ports[0];
    readOnly = event.data.readOnly === true;
    changeState(event.data.state && typeof event.data.state === 'object' ? copy(event.data.state) : {});
    inputs = event.data.inputs && typeof event.data.inputs === 'object' ? copy(event.data.inputs) : { revision: 0, ports: {} };
    port.onmessage = event => {
      if (event.data?.type === 'restore') {
        changeState(copy(event.data.value ?? {}));
        listeners.forEach(fn => fn(api.state));
      } else if (event.data?.type === 'inputs') {
        inputs = copy(event.data.value ?? { revision: 0, ports: {} });
        inputListeners.forEach(fn => fn(api.inputs));
      } else if (event.data?.type === 'snapshot' && typeof event.data.request_id === 'string' && event.data.request_id.length <= 160) {
        captureSnapshot(event.data.request_id);
      }
    };
    port.start();
    send('ready', { protocol: 1 });
    earlyErrors.splice(0).forEach(message => send('error', message));
    inputReady = true; resolveReady(api.state); inputListeners.forEach(fn => fn(api.inputs));
    if (document.body) watchSize(); else addEventListener('DOMContentLoaded', watchSize, { once: true });
  });
  function watchSize() {
    let last = 0;
    const measure = () => {
      const style = getComputedStyle(document.body);
      const height = Math.ceil(document.body.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
      if (height !== last) { last = height; send('size', height); }
    };
    new ResizeObserver(measure).observe(document.body); measure();
  }
  addEventListener('error', event => api.reportError(event.error ?? event.message ?? ('Could not load ' + (event.target?.src || event.target?.href || 'a work resource'))), true);
  addEventListener('unhandledrejection', event => api.reportError(event.reason));
  if (standalone) {
    state = window.__SPELLCAST_STATE__ ?? {};
    try { state = JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? state; } catch {}
    inputReady = true; resolveReady(api.state);
  } else parent.postMessage({ type: 'spellcast:ready' }, '*');
})();
