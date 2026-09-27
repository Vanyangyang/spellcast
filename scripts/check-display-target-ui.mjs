/**
 * Browser check for the settings "Bubbles & notices" display target panel.
 * Runs its own Vite dev server, answers every API call from fixtures, and injects a
 * simulated native display report. It never contacts :47194 or reads real state, so it
 * proves the panel's behavior, not native window placement.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(
    process.env.SPELLCAST_PLAYWRIGHT ??
      path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"),
  );
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "artifacts/display-target-ui");
await mkdir(out, { recursive: true });
const port = Number(process.env.SPELLCAST_PREVIEW_PORT ?? 47295);
assert.notEqual(port, 47193);
assert.notEqual(port, 47194);
const origin = `http://127.0.0.1:${port}`;

const board = { topic: "", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [], replies: [], canvas: { revision: 1, objects: [], items: [] } };
const health = { surface: "ambient", port: 47194, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
const fixtures = {
  "/api/board": board,
  "/api/forms": { forms: [] },
  "/api/health": health,
  "/api/events": { events: [], last_seq: 0 },
  "/api/feedback": { pending: [], deliveries: [], bindings: [] },
  "/api/observer/status": { enabled: false, paused: false, allowed: true, reason: "ok", policy_revision: 1 },
  "/api/memories": { memories: [] },
};

/** Mirrors display_target.rs: a missing fixed display falls back to the active one. */
function nativeDisplays() {
  const all = [
    { index: 0, id: "path:AOC", number: 1, name: "\\\\.\\DISPLAY1", label: "AG273QG3R3B", x: 0, y: 0, width: 2560, height: 1440, scale: 1, workX: 0, workY: 0, workW: 2560, workH: 1392, isPrimary: true, isActive: true },
    { index: 1, id: "path:27M2U", number: 2, name: "\\\\.\\DISPLAY2", label: "27M2U", x: 2560, y: -200, width: 3840, height: 2160, scale: 1.5, workX: 1706, workY: -133, workW: 2560, workH: 1413, isPrimary: false, isActive: false },
    { index: 2, id: "path:THIRD", number: 3, name: "\\\\.\\DISPLAY3", label: "Third monitor", x: 6400, y: 180, width: 1920, height: 1080, scale: 1, workX: 6400, workY: 180, workW: 1920, workH: 1040, isPrimary: false, isActive: false },
  ];
  const state = { target: { mode: "active" }, connected: new Set(all.slice(0, 2).map(s => s.id)), window: "path:27M2U", calls: [] };
  const report = () => {
    const screens = all.filter(s => state.connected.has(s.id));
    const active = screens.find(s => s.isActive) ?? screens[0];
    const fixed = state.target.mode === "fixed" ? screens.find(s => s.id === state.target.id) : undefined;
    return {
      target: state.target,
      screens,
      windowScreen: screens.some(s => s.id === state.window) ? state.window : null,
      noticeScreen: (fixed ?? active).id,
      fixedConnected: state.target.mode === "fixed" ? Boolean(fixed) : null,
    };
  };
  window.__displayFixture = state;
  window.__SPELLCAST_DISPLAY_FIXTURE__ = async (command, args) => {
    state.calls.push({ command, args });
    if (command === "display_target_report") return report();
    if (command === "set_display_target") {
      const next = args.target;
      if (next.mode === "fixed") {
        const screen = all.find(s => s.id === next.id && state.connected.has(s.id));
        if (!screen) throw "That display is no longer connected.";
        state.target = { mode: "fixed", id: screen.id, number: screen.number, label: screen.label, width: screen.width, height: screen.height };
      } else state.target = { mode: next.mode };
      return report();
    }
    throw `unexpected ${command}`;
  };
}

const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, shell: true, stdio: "ignore" });
const stop = () => { if (process.platform === "win32") spawn("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore" }); else vite.kill(); };
const results = [];
const pass = name => { results.push(name); console.log(`ok - ${name}`); };

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(800) })).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  const browser = await playwright.chromium.launch({ channel: "msedge", headless: true }).catch(() => playwright.chromium.launch({ headless: true }));
  // A cold Vite dev server transforms the whole module graph on the first visit, which can take
  // minutes on a busy machine. That is fixture start-up, not product load time: warm it once.
  {
    const context = await browser.newContext();
    await context.route("**/*", (route, request) => new URL(request.url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));
    await (await context.newPage()).goto(origin, { timeout: 300000 });
    await context.close();
  }
  const blocked = [];
  const open = async ({ width = 1280, height = 860, locale = "zh-CN", native = true } = {}) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route("**/*", (route, request) => {
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.port === "47194" && url.pathname.startsWith("/api/")) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type" } });
        const body = fixtures[url.pathname];
        if (request.method() === "POST" && url.pathname === "/api/surface") return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": origin }, body: JSON.stringify(health) });
        if (request.method() === "GET" && body) return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": origin }, body: JSON.stringify(body) });
      }
      blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(l => localStorage.setItem("spellcast.locale", l), locale);
    if (native) await context.addInitScript(nativeDisplays);
    const page = await context.newPage();
    await page.goto(origin, { timeout: 120000 });
    await page.evaluate(() => document.querySelector("#settings-open").click());
    await page.locator('[data-settings-tab="display"]').click();
    return page;
  };
  const panel = page => page.locator("#settings-panel-display");
  const checked = page => panel(page).locator('input[name="display-mode"]:checked').getAttribute("value");

  let page = await open();
  await page.locator(".display-tile").first().waitFor();
  assert.equal(await page.locator('input[name="display-mode"]').count(), 2);
  assert.equal(await checked(page), "active");
  assert(await page.locator("#display-fixed-screen").isDisabled(), "Fixed display list stays inactive until fixed mode is chosen");
  assert.equal(await page.locator(".display-tile").count(), 2);
  assert.equal(await page.locator(".display-tile.is-target").getAttribute("data-screen"), "path:AOC");
  assert.equal(await page.locator('.display-option:has(input[value="fixed"]) #display-fixed-screen').count(), 1, "The display list belongs to the fixed choice");
  const clipped = await page.evaluate(() => [...document.querySelectorAll(".display-tile-label, .display-tile-tags")].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent));
  assert.deepEqual(clipped, [], "Map tiles show their text without truncation");
  await page.screenshot({ path: path.join(out, "wide-active.png") });
  pass("two choices are shown and the active display is the default notice target");

  await page.locator("#display-identify").click();
  await page.locator("#display-identified-text").filter({ hasText: "显示器 2" }).waitFor();
  assert.equal(await page.locator(".display-tile.is-identified").getAttribute("data-screen"), "path:27M2U");
  await page.screenshot({ path: path.join(out, "wide-identified.png") });
  await page.locator("#display-use-current").click();
  await page.locator('input[value="fixed"]:checked').waitFor();
  assert.equal(await page.locator("#display-fixed-screen").inputValue(), "path:27M2U");
  assert(!(await page.locator("#display-fixed-screen").isDisabled()));
  assert(await page.locator("#display-use-current").isHidden(), "An identified display that is already fixed needs no second button");
  assert.equal(await page.locator(".display-tile.is-target").getAttribute("data-screen"), "path:27M2U");
  assert.deepEqual((await page.evaluate(() => window.__displayFixture.calls)).filter(c => c.command === "set_display_target").at(-1).args, { target: { mode: "fixed", id: "path:27M2U" } });
  pass("identify names the window's display and one click makes it the fixed target");

  // Unplug the fixed display. One display is left, so there is nothing to choose: the choices, list,
  // identify button and map give way to a statement of where notices go, naming the stale choice.
  const onlyOne = async () => {
    await page.locator("#display-single:not([hidden])").waitFor({ timeout: 6000 });
    for (const part of [".display-modes", "#display-fixed-screen", "#display-identify", "#display-map"]) assert(await page.locator(part).isHidden(), `${part} is hidden with one display`);
    assert.match(await page.locator("#display-single-name").textContent(), /AG273QG3R3B/);
  };
  await page.evaluate(() => window.__displayFixture.connected.delete("path:27M2U"));
  await onlyOne();
  assert.match(await page.locator("#display-single-missing-text").textContent(), /27M2U/);
  assert(await page.locator("#display-follow-active").isVisible(), "A stale fixed choice gets one action to clear it");
  assert.equal(await checked(page), "fixed", "The saved fixed choice is kept underneath while its display is away");
  await page.screenshot({ path: path.join(out, "single-stale-fixed.png") });
  // Plug it back in: the full controls return with the saved choice intact.
  await page.evaluate(() => window.__displayFixture.connected.add("path:27M2U"));
  await page.locator("#display-multi:not([hidden])").waitFor({ timeout: 6000 });
  assert(await page.locator("#display-single").isHidden());
  assert.equal(await checked(page), "fixed");
  assert.equal(await page.locator("#display-fixed-screen").inputValue(), "path:27M2U");
  assert(await page.locator("#display-missing").isHidden());
  assert.equal(await page.locator(".display-tile.is-target").getAttribute("data-screen"), "path:27M2U");
  pass("with one display the choices give way to a statement naming the stale fixed display; reconnecting restores them and the saved choice");

  await page.locator('label.display-mode:has(input[value="active"])').click();
  await page.locator('input[value="active"]:checked').waitFor();
  assert.equal((await page.evaluate(() => window.__displayFixture.calls)).at(-1).args.target.mode, "active");
  assert(await page.locator("#display-fixed-screen").isDisabled());
  pass("follow-active mode is saved through the native command");

  // Fix the display again, unplug it and take the one offered action: the stale choice is cleared.
  await page.locator('label.display-mode:has(input[value="fixed"])').click();
  await page.locator('input[value="fixed"]:checked').waitFor();
  await page.evaluate(() => window.__displayFixture.connected.delete("path:27M2U"));
  await onlyOne();
  await page.locator("#display-follow-active").click();
  await page.locator("#display-single-missing").waitFor({ state: "hidden" });
  assert.deepEqual((await page.evaluate(() => window.__displayFixture.calls)).filter(c => c.command === "set_display_target").at(-1).args, { target: { mode: "active" } });
  assert(await page.locator("#display-single").isVisible(), "One display still shows the plain statement, now without a warning");
  await page.screenshot({ path: path.join(out, "single-active.png") });
  await page.evaluate(() => window.__displayFixture.connected.add("path:27M2U"));
  await page.locator("#display-multi:not([hidden])").waitFor({ timeout: 6000 });
  assert.equal(await checked(page), "active", "After clearing, a second display shows follow-active");
  pass("one action clears a stale fixed choice; a second display then shows follow-active");

  await page.evaluate(() => {
    window.__displayFixture.connected.add("path:THIRD");
    window.__displayFixture.window = "path:THIRD";
  });
  await page.locator("#display-identify").click();
  assert.equal(await page.locator(".display-tile").count(), 3);
  assert.equal(await page.locator("#display-fixed-screen option").count(), 3);
  assert.equal(await page.locator(".display-tile.is-identified").getAttribute("data-screen"), "path:THIRD");
  await page.locator("#display-use-current").click();
  await page.locator('input[value="fixed"]:checked').waitFor();
  assert.equal(await page.locator("#display-fixed-screen").inputValue(), "path:THIRD");
  assert.equal(await page.locator(".display-tile.is-target").getAttribute("data-screen"), "path:THIRD");
  pass("three displays remain selectable and the identify button can fix the third display");
  await page.context().close();

  for (const [name, width, height, locale] of [["narrow-en", 820, 860, "en"], ["phone-zh", 420, 860, "zh-CN"]]) {
    page = await open({ width, height, locale });
    await page.locator(".display-tile").first().waitFor();
    await page.locator("#display-identify").click();
    await page.locator("#display-identified:not([hidden])").waitFor();
    const overflow = await page.evaluate(() => {
      const sheet = document.querySelector("#settings-panel-display");
      return [...sheet.querySelectorAll("*")].some(node => node.getBoundingClientRect().right > sheet.getBoundingClientRect().right + 1);
    });
    assert.equal(overflow, false, `${name}: nothing spills past the panel`);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
    await page.context().close();
  }
  pass("panel fits narrow and phone widths in both locales");

  // The one-display statement at narrow and phone widths, in English and Chinese.
  for (const [name, width, height, locale, words] of [["single-narrow-en", 820, 860, "en", /Only one display/], ["single-phone-zh", 420, 860, "zh-CN", /只连接了一块显示器/]]) {
    page = await open({ width, height, locale });
    await page.locator(".display-tile").first().waitFor();
    await page.evaluate(() => { window.__displayFixture.connected.delete("path:27M2U"); window.__displayFixture.target = { mode: "fixed", id: "path:27M2U", number: 2, label: "27M2U", width: 3840, height: 2160 }; });
    await page.locator('[data-settings-tab="display"]').click();
    await page.locator("#display-single-missing:not([hidden])").waitFor({ timeout: 6000 });
    assert.match(await page.locator("#display-single").innerText(), words);
    const overflow = await page.evaluate(() => {
      const sheet = document.querySelector("#settings-panel-display");
      return [...sheet.querySelectorAll("*")].some(node => node.getClientRects().length && node.getBoundingClientRect().right > sheet.getBoundingClientRect().right + 1);
    });
    assert.equal(overflow, false, `${name}: nothing spills past the panel`);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    await page.context().close();
  }
  pass("the one-display statement fits narrow and phone widths in both locales");

  page = await open({ native: false });
  assert(await page.locator("#display-unsupported").isVisible());
  assert(await page.locator('input[name="display-mode"][value="fixed"]').isDisabled());
  assert(await page.locator("#display-identify").isDisabled());
  assert(await page.locator("#display-single").isHidden(), "The browser preview never claims to have detected a display");
  pass("browser preview explains the desktop-only setting and disables it");
  await page.context().close();

  await browser.close();
  assert.deepEqual(blocked.filter(entry => entry.includes(":47194")), [], "Every API call was answered by a fixture");
  await writeFile(path.join(out, "report.json"), JSON.stringify({ passed: results, blocked }, null, 2));
  console.log(`\n${results.length} checks passed. Screenshots: ${path.relative(root, out)}`);
} finally {
  stop();
}
