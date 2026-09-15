import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles: [{ text }] } = await build({
  entryPoints: ["src/canvas-dataflow.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { CanvasDataflow } = await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);

const artifact = (id, block, io) => ({
  id, io, source_id: "agent", reply_id: "r" + block, block_id: block,
  entry: "index.html", files: [], created_at_ms: 0,
});
const reply = (id, block, bundle, state_revision = 0) => ({
  id, source_id: "agent", source_label: "Agent", title: id, revision: 0, created_at_ms: 0, updated_at_ms: 0,
  blocks: [{ id: block, type: "artifact", description: "", bundle_id: bundle, state: {}, state_revision }],
});
const binding = (fromObject, fromBlock, fromPort, toBlock, toPort) => ({
  from: { object_id: fromObject, block_id: fromBlock, port: fromPort },
  to: { block_id: toBlock, port: toPort },
});
const makeBoard = () => ({
  topic: "", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [],
  replies: [reply("ra", "a", "ba"), reply("rb", "b", "bb")],
  canvas: {
    revision: 1,
    objects: [
      { id: "oa", content: { type: "reply", id: "ra" }, content_revision: 1 },
      { id: "ob", content: { type: "reply", id: "rb" }, content_revision: 1,
        bindings: [binding("oa", "a", "number", "b", "input")] },
      { id: "text", content: { type: "text", title: "", text: "" }, content_revision: 1,
        bindings: [binding("ob", "b", "label", null, "text")] },
    ],
    items: ["oa", "ob", "text"].map((item_id, z) => ({ item_id, revision: 1, z, removed: false, appearance: "plain", x: 0, y: 0, width: 100, height: 100 })),
  },
});

const board = makeBoard(), flow = new CanvasDataflow();
flow.update(board);
const a1 = flow.register("oa", "a", artifact("ba", "a", { inputs: {}, outputs: { number: "number" } }), 0);
const b = flow.register("ob", "b", artifact("bb", "b", { inputs: { input: "number" }, outputs: { label: "string" } }), 0);
flow.ready(a1); flow.ready(b);
assert.equal(flow.snapshot("ob", "b").ports.input.status, "unavailable");
assert(flow.publish(a1, flow.snapshot("oa", "a").revision, { number: 7 }));
assert.equal(flow.snapshot("ob", "b").ports.input.value, 7);
assert(flow.publish(b, flow.snapshot("ob", "b").revision, { label: "seven" }));
let native = flow.snapshot("text");
assert.equal(native.ports.text.value, "seven");
assert.deepEqual(native.ports.text.sources.map(source => source.object_id), ["ob", "oa"]);

board.canvas.objects[0].content_revision++;
flow.update(board);
assert.equal(flow.snapshot("ob", "b").ports.input.value, 7);
assert.equal(flow.snapshot("text").ports.text.status, "unavailable");
assert(flow.publish(b, flow.snapshot("ob", "b").revision, { label: "still seven" }));

const oldRevision = flow.snapshot("oa", "a").revision;
flow.invalidate(a1);
assert(!flow.publish(a1, oldRevision, { number: 8 }));
assert(flow.publish(a1, flow.snapshot("oa", "a").revision, { number: 8 }));
assert(!flow.publish(a1, flow.snapshot("oa", "a").revision, { number: Infinity }));
flow.ready(a1);
assert.equal(flow.snapshot("ob", "b").ports.input.status, "unavailable");

const a2 = flow.register("oa", "a", artifact("ba", "a", { inputs: {}, outputs: { number: "number" } }), 0);
flow.ready(a2);
flow.unregister(a1);
assert(flow.publish(a2, flow.snapshot("oa", "a").revision, { number: 9 }));
assert.equal(flow.snapshot("ob", "b").ports.input.value, 9);
const clone = flow.snapshot("ob", "b"); clone.ports.input.value = 999;
assert.equal(flow.snapshot("ob", "b").ports.input.value, 9);
flow.destroy();

const count = 40;
const stress = {
  topic: "", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [],
  replies: Array.from({ length: count }, (_, i) => reply(`rp${i}`, `p${i}`, `bp${i}`)),
  canvas: {
    revision: 1,
    objects: Array.from({ length: count }, (_, i) => ({
      id: `op${i}`, content: { type: "reply", id: `rp${i}` }, content_revision: 1,
      ...(i < 2 ? {} : { bindings: [
        binding(`op${i - 1}`, `p${i - 1}`, "v", `p${i}`, "a"),
        binding(`op${i - 2}`, `p${i - 2}`, "v", `p${i}`, "b"),
      ] }),
    })),
    items: Array.from({ length: count }, (_, item_id) => ({
      item_id: `op${item_id}`, revision: 1, z: item_id, removed: false, appearance: "plain", x: 0, y: 0, width: 100, height: 100,
    })),
  },
};
const bounded = new CanvasDataflow(); bounded.update(stress);
for (let i = 0; i < count; i++) {
  const token = bounded.register(`op${i}`, `p${i}`, artifact(`bp${i}`, `p${i}`,
    { inputs: i < 2 ? {} : { a: "number", b: "number" }, outputs: { v: "number" } }), 0);
  bounded.ready(token);
}
assert.equal(bounded.snapshot(`op${count - 1}`, `p${count - 1}`).ports.a.status, "unavailable");
bounded.destroy();
console.log("canvas dataflow check passed");
