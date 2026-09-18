/** Catalog + UI locale check: Chinese and English only. Isolated preview; never hits :47194. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "artifacts/i18n-check");
await mkdir(out, { recursive: true });

const catalogBuild = await build({
  entryPoints: [path.join(root, "src/i18n/messages.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const catalogFile = path.join(out, "catalogs.mjs");
await writeFile(catalogFile, catalogBuild.outputFiles[0].text);
const { catalogs, LOCALES, zhCN, en, ja } = await import(pathToFileURL(catalogFile).href);

const zhKeys = Object.keys(zhCN).sort();
const enKeys = Object.keys(en).sort();
const jaKeys = Object.keys(ja).sort();
assert.deepEqual(LOCALES.map((item) => item.id), ["zh-CN", "en"]);
assert.deepEqual(Object.keys(catalogs).sort(), ["en", "zh-CN"]);
assert.equal("ja" in catalogs, false, "Japanese must not be a live catalog");
assert.deepEqual(zhKeys, enKeys, "zh-CN and en must expose the same message keys");
assert.deepEqual(zhKeys, jaKeys, "parked Japanese catalog must stay key-complete for a later restore");
assert.equal(catalogs["zh-CN"]["setup.notInstalled"], "尚未安装完整 Spellcast 接入。");
assert.equal(catalogs.en["setup.notInstalled"], "Complete Spellcast integration is not installed.");
assert.equal(catalogs["zh-CN"]["completion.speech"], "有任务完成了。");
assert.equal(catalogs.en["completion.speech"], "A task is ready.");
assert.equal(catalogs["zh-CN"]["completion.voice"], "轻声提醒");
assert.equal(catalogs.en["completion.voice"], "Quiet reminder");
assert.notEqual(catalogs["zh-CN"]["settings.title"], catalogs.en["settings.title"]);
assert.notEqual(catalogs["zh-CN"]["completion.hint"], catalogs.en["completion.hint"]);
assert.equal(zhKeys.some((key) => catalogs["zh-CN"][key] === "" || catalogs.en[key] === ""), false);

const speechSource = await readFile(path.join(root, "src-tauri/src/completion_speech.rs"), "utf8");
assert.match(speechSource, /有任务完成了。/);
assert.match(speechSource, /A task is ready\./);
assert.equal(speechSource.includes("Codex 有任务完成了"), false);
assert.match(speechSource, /Culture\.Name -like 'zh-\*'/);
assert.match(speechSource, /Culture\.Name -like 'en-\*'/);

const { outputFiles: boardFiles } = await build({
  stdin: {
    contents: `
      export { bt } from "./src/i18n/board.ts";
      export { ct } from "./src/i18n/canvas.ts";
      export { currentLocale, setLocale, LOCALES } from "./src/i18n/index.ts";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  globalName: "I18nCheck",
  platform: "browser",
  write: false,
});

let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(
    process.env.SPELLCAST_PLAYWRIGHT ??
      path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"),
  );
}

async function launchBrowser() {
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await playwright.chromium.launch({ channel, headless: true });
    } catch {
      /* try next */
    }
  }
  return playwright.chromium.launch({ headless: true });
}

const boardJs = boardFiles.find((file) => file.path.endsWith(".js")) ?? boardFiles[0];
assert.ok(boardJs?.text, "esbuild produced no i18n check bundle");

const browser = await launchBrowser();
const context = await browser.newContext({ locale: "ja-JP" });
await context.addInitScript(() => {
  try {
    localStorage.setItem("spellcast.locale", "ja");
  } catch {}
});
const blank = path.join(out, "blank.html");
await writeFile(blank, "<!doctype html><html><body><select id='locale'></select></body></html>");
const page = await context.newPage();
await page.goto(pathToFileURL(blank).href);
await page.addScriptTag({ content: boardJs.text });
const migrated = await page.evaluate(() => {
  const api = window.I18nCheck;
  return {
    locale: api.currentLocale(),
    stored: localStorage.getItem("spellcast.locale"),
    settings: { zh: null, en: null },
    locales: api.LOCALES.map((item) => item.id),
  };
});
assert.equal(migrated.locale, "en", "stored ja must migrate to English");
assert.equal(migrated.stored, "en");
assert.deepEqual(migrated.locales, ["zh-CN", "en"]);

const switched = await page.evaluate(() => {
  const api = window.I18nCheck;
  api.setLocale("zh-CN");
  const zhTitle = api.bt ? null : null;
  const zhSettings = document.documentElement.lang;
  const boardZh = window.I18nCheck.bt("pause");
  const canvasZh = window.I18nCheck.ct("canvas");
  api.setLocale("en");
  return {
    langZh: zhSettings,
    boardZh,
    canvasZh,
    langEn: document.documentElement.lang,
    boardEn: window.I18nCheck.bt("pause"),
    canvasEn: window.I18nCheck.ct("canvas"),
    stored: localStorage.getItem("spellcast.locale"),
  };
});
assert.equal(switched.langZh, "zh-CN");
assert.equal(switched.boardZh, "暂停气泡");
assert.equal(switched.canvasZh, "画布");
assert.equal(switched.boardEn, "Pause bubbles");
assert.equal(switched.canvasEn, "Canvas");
assert.equal(switched.langEn, "en");
assert.equal(switched.stored, "en");
await browser.close();

const port = Number(process.env.SPELLCAST_I18N_PREVIEW_PORT ?? 47294);
assert.notEqual(port, 47194);
assert.notEqual(port, 47193);
const preview = spawn(
  process.execPath,
  [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: root, stdio: "pipe", windowsHide: true },
);
const waitHttp = async (url, ms = 20000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`preview not up: ${url}`);
};
try {
  await waitHttp(`http://127.0.0.1:${port}/`);
  const uiBrowser = await launchBrowser();
  const ui = await uiBrowser.newContext();
  const uiPage = await ui.newPage();
  await uiPage.addInitScript(() => {
    try {
      localStorage.setItem("spellcast.locale", "zh-CN");
    } catch {}
  });
  await uiPage.route("http://127.0.0.1:47194/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        surface: "ambient",
        port: 47194,
        last_call_ms: 0,
        calls: 0,
        paused: false,
        observer_enabled: false,
        observer_policy_revision: 1,
        observer_allowed: true,
        observer_reason: "fixture",
      }),
    }),
  );
  await uiPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await uiPage.waitForSelector("#locale");
  const values = await uiPage.locator("#locale option").evaluateAll((nodes) => nodes.map((node) => node.value));
  assert.deepEqual(values, ["zh-CN", "en"]);
  assert.equal(await uiPage.locator("#locale").inputValue(), "zh-CN");
  await uiPage.selectOption("#locale", "en");
  await uiPage.waitForFunction(() => document.documentElement.lang === "en");
  assert.match(await uiPage.locator("#settings-open").innerText(), /Settings/);
  await uiPage.selectOption("#locale", "zh-CN");
  await uiPage.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.match(await uiPage.locator("#settings-open").innerText(), /设置/);

  const completionsZh = await ui.newPage();
  await completionsZh.addInitScript(() => {
    try { localStorage.setItem("spellcast.locale", "zh-CN"); } catch {}
  });
  await completionsZh.goto(`http://127.0.0.1:${port}/completions.html`, { waitUntil: "domcontentloaded" });
  await completionsZh.waitForSelector("#completion-voice");
  await completionsZh.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.match(await completionsZh.locator(".completion-toolbar span").innerText(), /已完成/);
  assert.match(await completionsZh.locator("#completion-voice").innerText(), /轻声提醒/);

  const completionsEn = await ui.newPage();
  await completionsEn.addInitScript(() => {
    try { localStorage.setItem("spellcast.locale", "en"); } catch {}
  });
  await completionsEn.goto(`http://127.0.0.1:${port}/completions.html`, { waitUntil: "domcontentloaded" });
  await completionsEn.waitForSelector("#completion-voice");
  await completionsEn.waitForFunction(() => document.documentElement.lang === "en");
  assert.match(await completionsEn.locator(".completion-toolbar span").innerText(), /Done/);
  assert.match(await completionsEn.locator("#completion-voice").innerText(), /Quiet reminder/);
  await uiBrowser.close();
} finally {
  preview.kill();
}

console.log(JSON.stringify({ ok: true, locales: ["zh-CN", "en"], keys: zhKeys.length }));
