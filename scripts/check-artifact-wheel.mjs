import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const wheelRuntime = readFileSync(new URL('../spellcast-bridge/src/artifact-wheel.js', import.meta.url), 'utf8');

class FakePort {
  sent = [];
  onmessage = null;
  postMessage(message) { this.sent.push(message); }
  start() {}
}

class FakeElement {
  constructor(tagName, options = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.parentElement = options.parentElement ?? null;
    this.parentNode = this.parentElement;
    this.scrollHeight = options.scrollHeight ?? 0;
    this.clientHeight = options.clientHeight ?? 0;
    this.scrollTop = options.scrollTop ?? 0;
    this.style = {
      overflow: 'visible',
      overflowY: 'visible',
      overflowX: 'visible',
      ...(options.style ?? {}),
    };
  }

  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim().toLowerCase();
      if (this.tagName === 'SELECT') return value.includes('select');
      if (this.tagName !== 'INPUT' || !value.includes('input')) return false;
      if (value.includes('type=range') || value.includes('type="range"') || value.includes("type='range'")) return this.type === 'range';
      if (value.includes('type=number') || value.includes('type="number"') || value.includes("type='number'")) return this.type === 'number';
      return true;
    });
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches?.(selector)) return node;
    }
    return null;
  }
}

class FakeInput extends FakeElement {
  constructor(type, options = {}) {
    super('input', options);
    this.type = type;
  }
}

class FakeSelect extends FakeElement {
  constructor(options = {}) {
    super('select', options);
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function boot({ canvasWheel = false, readOnly = false, standalone = false, initialize = !standalone, existingApi = false, width = 200, height = 120 } = {}) {
  const listeners = new Map();
  const timers = [];
  let nextTimer = 1;
  const host = { sent: [], postMessage(message) { this.sent.push(message); } };
  const html = new FakeElement('html');
  const document = { body: null, documentElement: html, scrollingElement: html };
  const addEventListener = (type, listener) => {
    const entries = listeners.get(type) ?? [];
    entries.push(listener);
    listeners.set(type, entries);
  };
  const setTimeout = (callback, delay) => {
    const id = nextTimer++;
    timers.push({ id, callback, delay });
    return id;
  };
  const clearTimeout = id => {
    const index = timers.findIndex(timer => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  const getComputedStyle = element => element?.style ?? { overflow: 'visible', overflowY: 'visible', overflowX: 'visible' };
  const window = {
    innerWidth: width,
    innerHeight: height,
    document,
    addEventListener,
    setTimeout,
    clearTimeout,
    getComputedStyle,
  };
  const parent = standalone ? window : host;
  window.parent = parent;
  window.self = window;
  const legacyApi = existingApi ? Object.freeze({ legacy: true }) : undefined;
  if (legacyApi) window.spellcast = legacyApi;

  const context = vm.createContext({
    window,
    parent,
    self: window,
    location: { pathname: '/artifact-wheel-test' },
    document,
    addEventListener,
    setTimeout,
    clearTimeout,
    getComputedStyle,
    localStorage: { getItem() { return null; }, setItem() {} },
    TextEncoder,
    Promise,
    JSON,
    Object,
    Array,
    Set,
    Number,
    String,
    Error,
    Math,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
  });
  vm.runInContext(wheelRuntime, context, { filename: 'artifact-wheel.js' });

  const port = new FakePort();
  const sendInit = ({ source = parent, enableWheel = canvasWheel } = {}) => {
    const data = {
      type: 'spellcast:init',
      state: { count: 1 },
      inputs: { revision: 0, ports: {} },
      readOnly,
    };
    if (enableWheel) data.canvasWheel = true;
    for (const listener of listeners.get('message') ?? []) {
      listener({ source, data, ports: [port] });
    }
  };
  if (initialize) sendInit();

  return {
    document,
    host,
    html,
    legacyApi,
    port,
    sendInit,
    window,
    pendingTimers: () => timers.length,
    emitWheel(event) {
      for (const listener of listeners.get('wheel') ?? []) listener(event);
    },
    flushTimers() {
      while (timers.length) timers.shift().callback();
    },
  };
}

function wheel(target, options = {}) {
  const event = {
    isTrusted: true,
    defaultPrevented: false,
    deltaX: 0,
    deltaY: -120,
    clientX: 25,
    clientY: 90,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    ...options,
  };
  event.composedPath = () => {
    const path = [];
    for (let node = target; node; node = node.parentElement) path.push(node);
    return path;
  };
  return event;
}

const wheelMessages = port => port.sent.filter(message => message.type === 'wheel');
const assertNoShimFeedback = session => {
  assert.deepEqual(session.port.sent.filter(message => message.type === 'ready' || message.type === 'state' || message.type === 'outputs'), []);
  assert.deepEqual(session.host.sent.filter(message => message.type === 'spellcast:ready'), []);
};

{
  const session = boot();
  assert.equal(session.window.spellcast, undefined, 'The wheel shim does not create the SDK API.');
  session.emitWheel(wheel(new FakeElement('canvas', { parentElement: session.html })));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'Wheel forwarding stays disabled without canvasWheel: true.');
}

{
  const session = boot({ canvasWheel: true, existingApi: true });
  assert.equal(session.window.spellcast, session.legacyApi, 'The wheel shim operates alongside an older saved SDK API.');
  const event = wheel(new FakeElement('canvas', { parentElement: session.html }), { deltaY: -48 });
  session.emitWheel(event);
  assert.equal(wheelMessages(session.port).length, 0, 'An eligible wheel is deferred until work handlers can consume it.');
  assert.equal(session.pendingTimers(), 1, 'Forwarding uses one deferred timer.');
  session.flushTimers();
  assert.deepEqual(plain(wheelMessages(session.port)), [{ type: 'wheel', value: { x: 0.125, y: 0.75, deltaY: -1 } }]);
  assertNoShimFeedback(session);
}

{
  const session = boot({ canvasWheel: true });
  session.emitWheel(wheel(new FakeElement('canvas', { parentElement: session.html }), {
    clientX: 100,
    clientY: 60,
    deltaY: 1,
  }));
  session.flushTimers();
  assert.deepEqual(plain(wheelMessages(session.port)), [{ type: 'wheel', value: { x: 0.5, y: 0.5, deltaY: 1 } }]);
}

{
  const session = boot({ canvasWheel: true });
  session.emitWheel(wheel(new FakeElement('canvas', { parentElement: session.html }), { defaultPrevented: true }));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'Already-prevented events stay local.');
}

{
  const session = boot({ canvasWheel: true });
  const event = wheel(new FakeElement('canvas', { parentElement: session.html }));
  session.emitWheel(event);
  event.defaultPrevented = true;
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'A work handler can prevent the deferred forwarding.');
}

{
  const session = boot({ canvasWheel: true });
  const scroller = new FakeElement('div', {
    parentElement: session.html,
    scrollHeight: 400,
    clientHeight: 100,
    scrollTop: 300,
    style: { overflowY: 'auto' },
  });
  session.emitWheel(wheel(new FakeElement('span', { parentElement: scroller })));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'A scrollable ancestor keeps wheel input local even at its bottom.');
}

{
  const session = boot({ canvasWheel: true });
  const overflowContainer = new FakeElement('div', {
    parentElement: session.html,
    scrollHeight: 100,
    clientHeight: 100,
    style: { overflowY: 'auto' },
  });
  session.emitWheel(wheel(new FakeElement('span', { parentElement: overflowContainer })));
  session.flushTimers();
  assert.equal(wheelMessages(session.port).length, 1, 'An overflow-styled but non-scrollable ancestor does not block canvas navigation.');
}

for (const target of [
  new FakeInput('range'),
  new FakeInput('number'),
  new FakeSelect(),
]) {
  const session = boot({ canvasWheel: true });
  target.parentElement = session.html;
  target.parentNode = session.html;
  session.emitWheel(wheel(target));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], target.tagName + ' control keeps its wheel behavior.');
}

{
  const session = boot({ canvasWheel: true });
  session.emitWheel(wheel(new FakeElement('canvas', { parentElement: session.html }), { isTrusted: false }));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'Synthetic wheel events cannot navigate the canvas.');
}

{
  const session = boot({ canvasWheel: true, readOnly: true });
  session.emitWheel(wheel(new FakeElement('canvas', { parentElement: session.html })));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'Read-only artifacts cannot send canvas wheel navigation.');
}

{
  const session = boot({ canvasWheel: true, standalone: true, initialize: true });
  session.emitWheel(wheel(new FakeElement('canvas', { parentElement: session.html })));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'Standalone exports cannot send canvas wheel navigation.');
}

{
  const session = boot({ canvasWheel: true, initialize: false });
  session.sendInit({ source: {} });
  session.emitWheel(wheel(new FakeElement('canvas', { parentElement: session.html })));
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'Only the embedding parent can enable canvas wheel forwarding.');
}

{
  const session = boot({ canvasWheel: true });
  const target = new FakeElement('canvas', { parentElement: session.html });
  session.emitWheel(wheel(target, { deltaX: 120, deltaY: 0 }));
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    session.emitWheel(wheel(target, { [modifier]: true }));
  }
  session.flushTimers();
  assert.deepEqual(wheelMessages(session.port), [], 'Horizontal and modified wheel input stay with the work.');
}

console.log('artifact wheel protocol checks passed');
