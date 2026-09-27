import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 48373;
const origin = `http://127.0.0.1:${port}`;
const preview = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "pipe", windowsHide: true });
let browser;
let provider = "codex";
let providerWrites = 0;
const observer = () => ({ enabled: true, provider, paused: false, allowed: true, reason: "ok", policy_revision: 2 + providerWrites, locale: "zh-CN" });

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(origin)).ok; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Vite preview unavailable");
  for (const channel of ["chrome", "msedge", null]) {
    try { browser = await playwright.chromium.launch(channel ? { channel, headless: true } : { headless: true }); break; }
    catch {}
  }
  if (!browser) throw new Error("No browser available");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("http://127.0.0.1:47194/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.method() === "POST" && url.pathname === "/api/observer/provider") {
      provider = request.postDataJSON().provider;
      providerWrites++;
      return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(observer()) });
    }
    let body = {};
    if (url.pathname === "/api/health") body = { surface: "ambient", port: 47194, last_call_ms: 0, calls: 0, paused: false, observer_enabled: true, observer_provider: provider, observer_policy_revision: 2 + providerWrites };
    else if (url.pathname === "/api/observer/status") body = observer();
    else if (url.pathname === "/api/board") body = { topic: "", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [], replies: [], canvas: { revision: 1, objects: [], items: [] } };
    else if (url.pathname === "/api/events") body = { events: [], last_seq: 0 };
    else if (url.pathname === "/api/forms") body = { forms: [] };
    return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("#settings-open").click();
  const selector = page.locator("#settings-observer-provider");
  assert.equal(await selector.isVisible(), true);
  assert.equal(await selector.inputValue(), "codex");
  const saved = page.waitForResponse(response => response.url().endsWith("/api/observer/provider") && response.status() === 200);
  await selector.selectOption("claude");
  await saved;
  assert.equal(await selector.inputValue(), "claude");
  assert.equal(providerWrites, 1);
  assert.equal(provider, "claude");
  console.log(JSON.stringify({ ok: true, visible: true, savedProvider: provider }));
} finally {
  await browser?.close();
  preview.kill();
}
