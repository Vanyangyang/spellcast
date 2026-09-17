import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";

const result = await build({ entryPoints: [path.resolve(import.meta.dirname, "../src/canvas-scale.ts")], bundle: true, write: false, format: "esm", platform: "node" });
const { scaledPresentation } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const original = { width: 600, height: 480, content_scale: 1 };
const large = { width: 900, height: 720 };
const enlarged = scaledPresentation(large, original);
assert.deepEqual(enlarged, { width: 600, height: 480, scale: 1.5 });
const saved = { ...large, content_scale: enlarged.scale };
assert.deepEqual(scaledPresentation(large, saved), enlarged, "Reload must preserve the logical layout and scale");
assert.deepEqual(scaledPresentation(original, saved), { width: 600, height: 480, scale: 1 }, "Undo after a saved drag must restore content scale");
assert.deepEqual(scaledPresentation(large, original), enlarged, "Redo must restore the same scale");
assert.deepEqual(scaledPresentation(original, { width: 600 }), { width: 600, height: 480, scale: 1 }, "Older presentations start at 1");
let base = original;
for (let index = 1; index <= 200; index++) {
  const size = { width: 600 + index * .72, height: (600 + index * .72) * .8 };
  const next = scaledPresentation(size, base);
  close(next.width, 600); close(next.height, 480);
  base = { ...size, content_scale: next.scale };
}
const restored = scaledPresentation(original, base);
close(restored.scale, 1); close(restored.width, 600); close(restored.height, 480);
console.log("Canvas scale: proportional layout, saved reload, undo/redo, default and repeated drag checks passed.");
