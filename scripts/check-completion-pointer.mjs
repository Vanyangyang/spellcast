/** Headless completion-pointer routing regression. Never moves the system cursor or opens a native window. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const url = process.env.SPELLCAST_TEST_URL ?? "http://127.0.0.1:47198/completions.html";
const browser = await playwright.chromium.launch({ headless: true, channel: "chrome", args: ["--no-proxy-server"] });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const fixture = {
      thread_id: "pointer-routing",
      turn_id: "one",
      title: "Pointer routing",
      summary: "Transparent pixels pass through without making the card inert.",
      project: "Spellcast",
      completed_at_ms: Date.now(),
      client: "codex",
    };
    const state = { cursor: { x: 0, y: 0 }, ignored: false, calls: [] };
    window.__SPELLCAST_POINTER_TEST__ = state;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "completions" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args = {}) => {
        state.calls.push(command);
        if (command === "get_completions") return [fixture];
        if (command === "get_completion_voice") return { enabled: false, supported: true, volume: 15, cooldown_seconds: 90, quiet_hours: "23:00-08:00" };
        if (command === "set_ui_locale") return "zh-CN";
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:window|inner_position") return { x: 100, y: 200 };
        if (command === "plugin:window|scale_factor") return 1.25;
        if (command === "plugin:window|cursor_position") return state.cursor;
        if (command === "plugin:window|set_ignore_cursor_events") { state.ignored = args.value; return null; }
        throw new Error(`Unexpected mocked command: ${command}`);
      },
    };
  });
  await page.goto(url, { waitUntil: "commit", timeout: 15000 });
  const card = page.locator(".completion-bubble");
  await card.waitFor();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.evaluate(({ x, y }) => { window.__SPELLCAST_POINTER_TEST__.cursor = { x, y }; }, {
    x: 100 + 2 * 1.25,
    y: 200 + (viewport.height - 2) * 1.25,
  });
  await page.waitForFunction(() => document.documentElement.dataset.cursorRouting === "passthrough");
  assert.equal(await page.evaluate(() => window.__SPELLCAST_POINTER_TEST__.ignored), true);

  const box = await card.boundingBox();
  assert(box);
  await page.evaluate(({ x, y }) => { window.__SPELLCAST_POINTER_TEST__.cursor = { x, y }; }, {
    x: 100 + (box.x + box.width / 2) * 1.25,
    y: 200 + (box.y + box.height / 2) * 1.25,
  });
  await page.waitForFunction(() => document.documentElement.dataset.cursorRouting === "capture");
  assert.equal(await page.evaluate(() => window.__SPELLCAST_POINTER_TEST__.ignored), false);
  assert.equal(await page.evaluate(() => window.__SPELLCAST_POINTER_TEST__.calls.includes("plugin:window|set_focus")), false);
  console.log("completion pointer routing keeps transparent pixels click-through without moving or focusing the system cursor");
} finally {
  await browser.close();
}
