import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/bubble-flight.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
const { remainingRiseMs, riseSpeed } = await import(`data:text/javascript;base64,${source}`);

const life = 16_000;
const speed = riseSpeed(900, 100, life);
assert.equal(speed, 0.05);
assert.equal(remainingRiseMs(900, 100, speed, life), life);
assert.equal(remainingRiseMs(500, 100, speed, life), 8_000);
assert.equal(remainingRiseMs(300, 100, speed, life), 4_000);
assert.equal(remainingRiseMs(100, 100, speed, life), 0);

// Repeated keep/unkeep cycles do not change timing: only the latest drop position does.
for (let cycle = 0; cycle < 5; cycle += 1) {
  assert.equal(remainingRiseMs(500, 100, speed, life), 8_000);
}

assert.equal(remainingRiseMs(500, 100, 0, life), life);
console.log("bubble flight timing keeps the original rise speed after repeated drag/favorite changes");
