import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const runtime = readFileSync(new URL("../spellcast-bridge/src/artifact-runtime.js", import.meta.url), "utf8");

class FakePort {
  sent = [];
  onmessage = null;
  closed = false;
  postMessage(message) { this.sent.push(message); }
  start() {}
  close() { this.closed = true; }
  receive(data) { this.onmessage?.({ data }); }
}

function boot({ readOnly = false, state = { count: 1 } } = {}) {
  const listeners = new Map();
  const host = { sent: [], postMessage(message) { this.sent.push(message); } };
  const window = {};
  const addEventListener = (type, listener) => {
    const entries = listeners.get(type) ?? [];
    entries.push(listener);
    listeners.set(type, entries);
  };
  const context = vm.createContext({
    window,
    parent: host,
    location: { pathname: "/artifact-test" },
    document: { body: null },
    addEventListener,
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
  });
  vm.runInContext(runtime, context, { filename: "artifact-runtime.js" });
  const port = new FakePort();
  for (const listener of listeners.get("message") ?? []) {
    listener({ source: host, data: { type: "spellcast:init", state, inputs: { revision: 0, ports: {} }, readOnly }, ports: [port] });
  }
  return { api: window.spellcast, port };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}
const plain = value => JSON.parse(JSON.stringify(value));

{
  const { port } = boot();
  port.receive({ type: "snapshot", request_id: "no-handler" });
  assert.deepEqual(plain(port.sent.at(-1)), { type: "snapshot", value: { request_id: "no-handler", state: { count: 1 }, preview: null } });
}

{
  const { api, port } = boot();
  api.onSnapshot(() => ({ src: "data:image/png;base64,AA==", alt: "Saved canvas" }));
  port.receive({ type: "snapshot", request_id: "preview" });
  await settle();
  assert.deepEqual(plain(port.sent.at(-1)), { type: "snapshot", value: {
    request_id: "preview", state: { count: 1 }, preview: { src: "data:image/png;base64,AA==", alt: "Saved canvas" },
  } });
}

{
  const { api, port } = boot();
  let finish;
  api.onSnapshot(() => new Promise(resolve => { finish = resolve; }));
  port.receive({ type: "snapshot", request_id: "stale" });
  await settle();
  api.setState({ count: 2 });
  finish({ src: "data:image/png;base64,AA==", alt: "Old canvas" });
  await settle();
  assert.equal(port.sent.some(message => message.type === "snapshot" && message.value.request_id === "stale"), false);
  assert.equal(port.sent.some(message => message.type === "error" && message.value.request_id === "stale" && /State changed/.test(message.value.message)), true);
}

{
  const { api, port } = boot({ readOnly: true });
  const before = port.sent.length;
  api.setState({ count: 2 });
  api.select({ label: "ignored" });
  api.publishOutputs({ result: 1 }, 0);
  assert.deepEqual(port.sent.slice(before).filter(message => message.type === "state" || message.type === "outputs"), []);
}

console.log("artifact capture protocol checks passed");
