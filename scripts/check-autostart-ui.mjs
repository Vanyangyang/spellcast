/**
 * Runs the actual autostart module against index.html in a local browser fixture.
 * Tauri IPC is simulated: no native process, registry, startup item, bridge, or database is used.
 * Run with: node scripts/check-autostart-ui.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const html = await readFile(path.join(root, "index.html"), "utf8");
const bundled = await build({
  stdin: {
    contents: `import { mountAutostart } from './src/autostart';
      import { applyDom, setLocale } from './src/i18n';
      const root = document.querySelector('#settings');
      root.hidden = false;
      root.showModal();
      document.querySelector('#settings-panel-appearance').hidden = false;
      applyDom();
      window.__autostartUI = { ...mountAutostart(root), setLocale };`,
    resolveDir: root,
    sourcefile: "autostart-contract-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
});
const script = bundled.outputFiles[0].text;
const origin = "http://autostart-contract.test";

async function launchBrowser() {
  for (const channel of ["chrome", "msedge"]) {
    try { return await playwright.chromium.launch({ channel, headless: true }); } catch {}
  }
  return playwright.chromium.launch({ headless: true });
}

const browser = await launchBrowser();
let checks = 0;
async function fixture({ native = true, enabled = false, reads = [], writes = [] } = {}) {
  const context = await browser.newContext({ locale: "en-US" });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    // Serve the real markup; do not execute the rest of the application in this isolated check.
    if (url.origin === origin && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (url.origin === origin && url.pathname === "/src/main.ts") return route.fulfill({ contentType: "application/javascript", body: "" });
    return route.abort();
  });
  await context.addInitScript(config => {
    localStorage.setItem("spellcast.locale", "en");
    // A stale browser value must never override or create a system startup entry.
    localStorage.setItem("spellcast.autostart", "true");
    const pendingReads = [];
    const pendingWrites = [];
    const harness = {
      enabled: config.enabled,
      calls: [],
      reads: [...config.reads],
      writes: [...config.writes],
      releaseRead: () => pendingReads.shift()?.(),
      releaseWrite: () => pendingWrites.shift()?.(),
    };
    window.__autostartHarness = harness;
    window.isTauri = config.native;
    // Install the trap even in preview: accidental native IPC is recorded and rejected.
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        harness.calls.push({ command, args });
        if (!config.native) throw new Error("Preview must not invoke native commands");
        if (command === "get_autostart_enabled") {
          const step = harness.reads.shift() ?? {};
          if (step.hold) await new Promise(resolve => pendingReads.push(resolve));
          if (step.fail) throw new Error("Simulated read failure");
          return Object.hasOwn(step, "result") ? step.result : harness.enabled;
        }
        if (command === "set_autostart_enabled") {
          const step = harness.writes.shift() ?? {};
          if (step.hold) await new Promise(resolve => pendingWrites.push(resolve));
          if (Object.hasOwn(step, "commit")) harness.enabled = step.commit;
          if (step.fail) throw new Error("Simulated write reply failure");
          if (!Object.hasOwn(step, "commit")) harness.enabled = args.enabled;
          return Object.hasOwn(step, "result") ? step.result : harness.enabled;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  }, { native, enabled, reads, writes });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.addScriptTag({ content: script });
  return { context, page, errors };
}

const calls = page => page.evaluate(() => window.__autostartHarness.calls);
const sets = async page => (await calls(page)).filter(call => call.command === "set_autostart_enabled").map(call => call.args.enabled);
const gets = async page => (await calls(page)).filter(call => call.command === "get_autostart_enabled").length;
async function phase(page, expected) {
  await page.waitForFunction(value => document.querySelector("#autostart-enabled").dataset.autostartState === value, expected);
}
async function state(page, expected, { disabled = false, currentPhase = "ready" } = {}) {
  await phase(page, currentPhase);
  assert.equal(await page.locator("#autostart-enabled").isChecked(), expected);
  assert.equal(await page.locator("#autostart-enabled").isDisabled(), disabled);
}
async function errorState(page, expected, disabled = false) {
  await state(page, expected, { disabled, currentPhase: "error" });
  assert.equal(await page.locator("#autostart-status").getAttribute("role"), "alert");
  assert.equal(await page.locator("#autostart-status").evaluate(el => el.classList.contains("has-warning")), true);
  assert.equal(await page.locator("#autostart-retry").isVisible(), true);
  assert.equal(await page.locator("#autostart-retry").isEnabled(), true);
}
async function translatedStatus(page, english, chinese) {
  assert.equal(await page.locator("#autostart-status").textContent(), english);
  await page.evaluate(() => window.__autostartUI.setLocale("zh-CN"));
  assert.equal(await page.locator("#autostart-status").textContent(), chinese);
  assert.equal(await page.locator("#autostart-retry").textContent(), "重试");
  assert.equal(await page.locator("#settings-tab-appearance").textContent(), "常规");
  await page.evaluate(() => window.__autostartUI.setLocale("en"));
  assert.equal(await page.locator("#autostart-status").textContent(), english);
  assert.equal(await page.locator("#autostart-retry").textContent(), "Retry");
  assert.equal(await page.locator("#settings-tab-appearance").textContent(), "General");
}
async function syntheticChange(page, checked) {
  await page.evaluate(value => {
    const input = document.querySelector("#autostart-enabled");
    input.checked = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, checked);
}
async function run(name, options, check) {
  const { context, page, errors } = await fixture(options);
  try {
    await check(page);
    assert.deepEqual(errors, [], "The actual UI module must not produce browser errors");
    checks++;
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  } finally { await context.close(); }
}

try {
  await run("browser preview disables startup and never invokes IPC", { native: false }, async page => {
    await state(page, false, { disabled: true, currentPhase: "unsupported" });
    assert.equal(await page.locator("#autostart-retry").isVisible(), false);
    await syntheticChange(page, true);
    await page.evaluate(async () => {
      await window.__autostartUI.refresh();
      window.dispatchEvent(new Event("focus"));
    });
    await state(page, false, { disabled: true, currentPhase: "unsupported" });
    await translatedStatus(page, "Startup settings are available in the Spellcast desktop app.", "开机启动仅在 Spellcast 桌面应用中可用。");
    assert.deepEqual(await calls(page), []);
  });

  for (const enabled of [false, true]) {
    await run(`initial system ${enabled ? "on" : "off"} is displayed without writing defaults`, { enabled }, async page => {
      await state(page, enabled);
      assert.equal(await gets(page), 1);
      assert.deepEqual(await sets(page), []);
      assert.equal(await page.locator("#autostart-retry").isVisible(), false);
      assert.equal(await page.locator("#autostart-status").getAttribute("role"), "status");
      await translatedStatus(page, enabled ? "Automatic startup is on." : "Automatic startup is off.", enabled ? "已开启开机启动。" : "未开启开机启动。");
    });
  }

  await run("pending initial read disables input and ignores changes or overlapping refresh", { enabled: true, reads: [{ hold: true }] }, async page => {
    await state(page, false, { disabled: true, currentPhase: "loading" });
    await translatedStatus(page, "Checking startup settings…", "正在读取开机启动状态…");
    await syntheticChange(page, true);
    await page.evaluate(async () => {
      await window.__autostartUI.refresh();
      window.dispatchEvent(new Event("focus"));
    });
    assert.equal(await gets(page), 1);
    assert.deepEqual(await sets(page), []);
    await page.evaluate(() => window.__autostartHarness.releaseRead());
    await state(page, true);
  });

  await run("pending save disables input and prevents reordered writes; enable then disable succeeds", { writes: [{ hold: true }] }, async page => {
    await state(page, false);
    await page.locator("#autostart-enabled").click();
    await state(page, true, { disabled: true, currentPhase: "saving" });
    await translatedStatus(page, "Updating startup settings…", "正在更新开机启动设置…");
    await syntheticChange(page, false);
    await page.evaluate(async () => {
      await window.__autostartUI.refresh();
      window.dispatchEvent(new Event("focus"));
    });
    await state(page, true, { disabled: true, currentPhase: "saving" });
    assert.deepEqual(await sets(page), [true]);
    assert.equal(await gets(page), 1);
    await page.evaluate(() => window.__autostartHarness.releaseWrite());
    await state(page, true);
    await page.locator("#autostart-enabled").uncheck();
    await state(page, false);
    assert.deepEqual(await sets(page), [true, false]);
    assert.equal(await page.evaluate(() => window.__autostartHarness.enabled), false);
  });

  await run("failed initial read disables uncertain state and retry reads the system", { enabled: true, reads: [{ fail: true }] }, async page => {
    await errorState(page, false, true);
    await translatedStatus(page, "Couldn't read the system startup entry. Please retry.", "未能读取系统启动项，请重试。");
    await page.locator("#autostart-retry").click();
    await state(page, true);
    assert.equal(await gets(page), 2);
    assert.deepEqual(await sets(page), []);
  });

  await run("invalid native read is rejected and can be retried", { reads: [{ result: "true" }] }, async page => {
    await errorState(page, false, true);
    await page.locator("#autostart-retry").click();
    await state(page, false);
    assert.deepEqual(await sets(page), []);
  });

  await run("failed write rereads and rolls back actual state while retaining retry target", { writes: [{ fail: true }] }, async page => {
    await state(page, false);
    await page.locator("#autostart-enabled").click();
    await errorState(page, false);
    assert.equal(await gets(page), 2);
    await translatedStatus(page, "Couldn't update automatic startup. Please retry.", "未能更新开机启动设置，请重试。");
    await page.locator("#autostart-retry").click();
    await state(page, true);
    assert.deepEqual(await sets(page), [true, true]);
  });

  await run("rollback reread also disables input until actual state is known", { reads: [{}, { hold: true }], writes: [{ fail: true }] }, async page => {
    await state(page, false);
    await page.locator("#autostart-enabled").click();
    await page.waitForFunction(() => window.__autostartHarness.calls.filter(call => call.command === "get_autostart_enabled").length === 2);
    await state(page, true, { disabled: true, currentPhase: "saving" });
    await syntheticChange(page, false);
    assert.deepEqual(await sets(page), [true]);
    await page.evaluate(() => window.__autostartHarness.releaseRead());
    await errorState(page, false);
    await page.locator("#autostart-retry").click();
    await state(page, true);
    assert.deepEqual(await sets(page), [true, true]);
  });

  await run("failed write and failed reread leave input disabled but retain a working save retry", { reads: [{}, { fail: true }], writes: [{ fail: true }] }, async page => {
    await state(page, false);
    await page.locator("#autostart-enabled").click();
    await errorState(page, false, true);
    await page.locator("#autostart-retry").click();
    await state(page, true);
    assert.deepEqual(await sets(page), [true, true]);
  });

  await run("backend actual value contrary to the requested value is an error, not success", { writes: [{ commit: false, result: false }] }, async page => {
    await state(page, false);
    await page.locator("#autostart-enabled").click();
    await errorState(page, false);
    assert.equal(await gets(page), 2);
    await page.locator("#autostart-retry").click();
    await state(page, true);
    assert.deepEqual(await sets(page), [true, true]);
  });

  await run("successful OS write with failed IPC reply displays reread actual state", { writes: [{ commit: true, fail: true }] }, async page => {
    await state(page, false);
    await page.locator("#autostart-enabled").click();
    await errorState(page, true);
    assert.equal(await gets(page), 2);
    await page.locator("#autostart-retry").click();
    await state(page, true);
    assert.deepEqual(await sets(page), [true, true]);
  });

  await run("explicit refresh and visible-window focus track external system changes", {}, async page => {
    await state(page, false);
    await page.evaluate(async () => {
      window.__autostartHarness.enabled = true;
      await window.__autostartUI.refresh();
    });
    await state(page, true);
    await page.evaluate(() => {
      window.__autostartHarness.enabled = false;
      window.dispatchEvent(new Event("focus"));
    });
    await state(page, false);
    assert.equal(await gets(page), 3);
    assert.deepEqual(await sets(page), []);
    await page.evaluate(() => {
      document.querySelector("#settings").hidden = true;
      window.__autostartHarness.enabled = true;
      window.dispatchEvent(new Event("focus"));
    });
    assert.equal(await gets(page), 3, "hidden settings must not refresh on focus");
    await page.evaluate(async () => {
      document.querySelector("#settings").hidden = false;
      await window.__autostartUI.refresh();
    });
    await state(page, true);
  });

  console.log(`${checks} autostart browser checks passed (actual module and index.html; native IPC simulated).`);
} finally {
  await browser.close();
}
