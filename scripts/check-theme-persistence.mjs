/**
 * Browser contract test for theme persistence. Tauri IPC is simulated in the page;
 * this does not exercise a native process, database, or real application restart.
 * Run with: node scripts/check-theme-persistence.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const bundled = await build({
  entryPoints: [path.join(root, "src/theme.ts")],
  bundle: true,
  format: "iife",
  globalName: "SpellcastTheme",
  platform: "browser",
  write: false,
});
const script = `${bundled.outputFiles[0].text}\nSpellcastTheme.mountTheme();`;
const origin = "http://theme-contract.test";
const html = `<!doctype html><html lang="zh-CN"><body>
  <select id="theme-preference" data-theme-select>
    <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
  </select>
  <span id="theme-status" role="status"></span><button id="theme-retry" hidden>Retry</button>
  <script src="/theme.js"></script>
</body></html>`;

async function launchBrowser() {
  for (const channel of ["chrome", "msedge"]) {
    try { return await playwright.chromium.launch({ channel, headless: true }); } catch {}
  }
  return playwright.chromium.launch({ headless: true });
}

const browser = await launchBrowser();
let checks = 0;
async function fixture({ native = false, cache = null, scheme = "dark", storageUnavailable = false,
  getPreference = null, delayedGet = false, failSetOnce = false, holdSets = false } = {}) {
  const context = await browser.newContext({ colorScheme: scheme });
  await context.route(`${origin}/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/theme.js") return route.fulfill({ contentType: "application/javascript", body: script });
    return route.fulfill({ contentType: "text/html", body: html });
  });
  await context.addInitScript(config => {
    if (config.cache !== null) localStorage.setItem("spellcast.theme", config.cache);
    if (config.storageUnavailable) {
      Storage.prototype.getItem = function () { throw new Error("storage disabled"); };
      Storage.prototype.setItem = function () { throw new Error("storage disabled"); };
    }
    const pendingSets = [];
    const harness = { calls: [], releases: 0, releaseSet: () => pendingSets.shift()?.() };
    window.__themeHarness = harness;
    if (config.native) {
      window.isTauri = true;
      let pendingGet;
      if (config.delayedGet) pendingGet = new Promise(resolve => { harness.releaseGet = () => { harness.releases++; resolve(config.getPreference); }; });
      let failSet = config.failSetOnce;
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          harness.calls.push({ command, args });
          if (command === "get_theme_preference") return pendingGet ?? config.getPreference;
          if (command === "set_theme_preference") {
            if (failSet) { failSet = false; throw new Error("simulated native save failure"); }
            if (config.holdSets) await new Promise(resolve => pendingSets.push(resolve));
            return args?.preference;
          }
          throw new Error(`unexpected native command: ${command}`);
        },
      };
    }
  }, { native, cache, storageUnavailable, getPreference, delayedGet, failSetOnce, holdSets });
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "load" });
  return { context, page };
}

async function expectTheme(page, preference, effective = preference) {
  await page.waitForFunction(([p, e]) => document.querySelector("#theme-preference")?.value === p && document.body.dataset.theme === e, [preference, effective]);
  assert.equal(await page.locator("#theme-preference").inputValue(), preference);
  assert.equal(await page.locator("body").getAttribute("data-theme"), effective);
}
const calls = page => page.evaluate(() => window.__themeHarness.calls);
const setCalls = async page => (await calls(page)).filter(call => call.command === "set_theme_preference").map(call => call.args?.preference);
async function run(name, options, check) {
  const { context, page } = await fixture(options);
  try { await check(page, context); checks++; console.log(`ok ${checks} - ${name}`); }
  finally { await context.close(); }
}

try {
  await run("empty browser preference defaults to light with dark OS, without writing a default", {}, async page => {
    await expectTheme(page, "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("spellcast.theme")), null);
  });

  await run("saved dark and selected light/system preferences apply; system tracks OS changes", { cache: "dark" }, async page => {
    await expectTheme(page, "dark");
    await page.locator("#theme-preference").selectOption("light");
    await expectTheme(page, "light");
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "saved");
    await page.locator("#theme-preference").selectOption("system");
    await expectTheme(page, "system", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme(page, "system", "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("spellcast.theme")), "system");
  });

  await run("native preference overrides stale cache and refreshes it", { native: true, cache: "dark", getPreference: "light" }, async page => {
    await expectTheme(page, "light");
    await page.waitForFunction(() => localStorage.getItem("spellcast.theme") === "light");
    assert.deepEqual(await setCalls(page), []);
  });

  await run("native preference restores with unavailable browser storage", { native: true, storageUnavailable: true, getPreference: "dark" }, async page => {
    await expectTheme(page, "dark");
    await page.locator("#theme-preference").selectOption("light");
    await expectTheme(page, "light");
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "saved");
    assert.deepEqual(await setCalls(page), ["light"]);
  });

  await run("null native preference migrates a valid legacy cache once", { native: true, cache: "system", getPreference: null }, async page => {
    await expectTheme(page, "system", "dark");
    await page.waitForFunction(() => window.__themeHarness.calls.some(call => call.command === "set_theme_preference"));
    assert.deepEqual(await setCalls(page), ["system"]);
  });

  await run("null native preference and empty cache use light without persisting a default", { native: true, getPreference: null }, async page => {
    await expectTheme(page, "light");
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "ready");
    assert.deepEqual(await setCalls(page), []);
    assert.equal(await page.evaluate(() => localStorage.getItem("spellcast.theme")), null);
  });

  await run("late native read cannot overwrite a newer user selection", { native: true, cache: "dark", getPreference: "dark", delayedGet: true }, async page => {
    await page.waitForFunction(() => window.__themeHarness.calls.some(call => call.command === "get_theme_preference"));
    await page.locator("#theme-preference").selectOption("light");
    await expectTheme(page, "light");
    await page.evaluate(() => window.__themeHarness.releaseGet());
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "saved");
    await expectTheme(page, "light");
    assert.deepEqual(await setCalls(page), ["light"]);
  });

  await run("rapid native changes wait for earlier saves before writing in selection order", { native: true, getPreference: "light", holdSets: true }, async page => {
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "ready");
    await page.evaluate(() => {
      const select = document.querySelector("#theme-preference");
      for (const value of ["dark", "system", "light"]) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await page.waitForFunction(() => window.__themeHarness.calls.filter(call => call.command === "set_theme_preference").length === 1);
    assert.deepEqual(await setCalls(page), ["dark"], "second save must wait for first response");
    await page.evaluate(() => window.__themeHarness.releaseSet());
    await page.waitForFunction(() => window.__themeHarness.calls.filter(call => call.command === "set_theme_preference").length === 2);
    assert.deepEqual(await setCalls(page), ["dark", "system"], "third save must wait for second response");
    await page.evaluate(() => window.__themeHarness.releaseSet());
    await page.waitForFunction(() => window.__themeHarness.calls.filter(call => call.command === "set_theme_preference").length === 3);
    await page.evaluate(() => window.__themeHarness.releaseSet());
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "saved");
    await expectTheme(page, "light");
    assert.deepEqual(await setCalls(page), ["dark", "system", "light"]);
  });

  await run("native save failure is visible and retry saves selection", { native: true, getPreference: "light", failSetOnce: true }, async page => {
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "ready");
    await page.locator("#theme-preference").selectOption("dark");
    await expectTheme(page, "dark");
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "error");
    assert.equal(await page.locator("#theme-status").getAttribute("role"), "alert");
    assert.ok((await page.locator("#theme-status").textContent())?.trim());
    assert.equal(await page.locator("#theme-retry").isVisible(), true);
    await page.locator("#theme-retry").click();
    await page.waitForFunction(() => document.querySelector("#theme-preference")?.dataset.themeSaveState === "saved");
    assert.deepEqual(await setCalls(page), ["dark", "dark"]);
  });

  await run("browser storage event synchronizes another same-origin tab", {}, async (page, context) => {
    const second = await context.newPage();
    await second.goto(`${origin}/`);
    await expectTheme(second, "light");
    await page.locator("#theme-preference").selectOption("dark");
    await expectTheme(second, "dark");
    await second.locator("#theme-preference").selectOption("system");
    await expectTheme(page, "system", "dark");
  });

  console.log(`${checks} theme persistence browser checks passed (native IPC simulated).`);
} finally {
  await browser.close();
}
