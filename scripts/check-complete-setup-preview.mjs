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
const out = path.resolve(root, "artifacts/spellcast-complete-setup-20260913/ui");
const art = path.resolve(root, "artifacts/spellcast-complete-setup-20260913");
await mkdir(out, { recursive: true });
const port = Number(process.env.SPELLCAST_PREVIEW_PORT ?? 47293);
assert.notEqual(port, 47194);
assert.notEqual(port, 47193);
const viteOrigin = `http://127.0.0.1:${port}`;
const productionOrigin = "http://127.0.0.1:47194";

const health = {
  surface: "ambient",
  port: 47294,
  last_call_ms: 0,
  calls: 0,
  paused: false,
  observer_enabled: false,
  observer_policy_revision: 1,
  observer_allowed: true,
  observer_reason: "fixture",
};
const observerStatus = {
  enabled: false,
  paused: false,
  allowed: true,
  reason: "ok",
  policy_revision: 1,
};
const fixtures = {
  GET: {
    "/api/board": {
      topic: "",
      form: "spatial",
      form_reason: "",
      nodes: [],
      edges: [],
      messages: [],
      replies: [],
      canvas: { revision: 1, objects: [], items: [] },
    },
    "/api/forms": {
      forms: [
        { id: "constellation", label: "星座", blurb: "" },
        { id: "spatial", label: "空间", blurb: "" },
        { id: "timeline", label: "时间", blurb: "" },
        { id: "stack", label: "叠放", blurb: "" },
      ],
    },
    "/api/health": health,
    "/api/events": { events: [], last_seq: 0 },
    "/api/feedback": { pending: [], deliveries: [], bindings: [] },
    "/api/observer/status": observerStatus,
  },
};

function waitHttp(url, ms = 20000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < ms) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(800) });
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`preview not up: ${url}`);
  })();
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

function attachIsolation(context) {
  const log = {
    vite: [],
    fulfilled: [],
    aborted: [],
    mutations: [],
    passthrough: [],
  };

  const fulfillApi = async (route, request, parsed) => {
    const method = request.method();
    const pathname = parsed.pathname;
    if (method === "OPTIONS") {
      log.fulfilled.push({ method, path: pathname, origin: parsed.origin, action: "preflight-fixture" });
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": viteOrigin,
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
        },
      });
    }
    if (method === "GET" && fixtures.GET[pathname]) {
      log.fulfilled.push({ method, path: pathname, origin: parsed.origin, action: "get-fixture" });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixtures.GET[pathname]),
      });
    }
    if (method === "POST" && pathname === "/api/surface") {
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData();
      }
      log.mutations.push({ method, path: pathname, origin: parsed.origin, body, target: "fixture" });
      log.fulfilled.push({ method, path: pathname, origin: parsed.origin, action: "post-fixture" });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...health, surface: body?.surface ?? "ambient" }),
      });
    }
    if (method === "POST" && pathname === "/api/observer/settings") {
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData();
      }
      observerStatus.enabled = Boolean(body?.enabled);
      observerStatus.policy_revision += 1;
      observerStatus.reason = observerStatus.enabled ? "ok" : "disabled";
      observerStatus.allowed = observerStatus.enabled && !observerStatus.paused;
      health.observer_enabled = observerStatus.enabled;
      health.observer_policy_revision = observerStatus.policy_revision;
      log.mutations.push({ method, path: pathname, origin: parsed.origin, body, target: "fixture" });
      log.fulfilled.push({ method, path: pathname, origin: parsed.origin, action: "post-fixture" });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(observerStatus),
      });
    }
    log.aborted.push({ method, path: pathname, origin: parsed.origin, reason: "unexpected-api" });
    return route.abort("blockedbyclient");
  };

  const onRoute = async (route, request) => {
    const url = request.url();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      log.aborted.push({ method: request.method(), url, reason: "unparseable" });
      return route.abort("blockedbyclient");
    }
    const isProductionApi = parsed.origin === productionOrigin || parsed.port === "47194";
    if (isProductionApi) {
      return fulfillApi(route, request, parsed);
    }
    if (parsed.origin === viteOrigin) {
      log.vite.push({ method: request.method(), path: parsed.pathname });
      return route.continue();
    }
    log.aborted.push({
      method: request.method(),
      path: parsed.pathname,
      origin: parsed.origin,
      reason: "unexpected-network",
    });
    return route.abort("blockedbyclient");
  };

  return context.route("**/*", onRoute).then(() =>
    context.route("http://127.0.0.1:47194/**", async (route, request) => {
      const parsed = new URL(request.url());
      return fulfillApi(route, request, parsed);
    }),
  ).then(() => log);
}

function luminance(color) {
  const rgb = color.match(/\d+/g)?.map(Number) ?? [];
  if (rgb.length < 3) return 1;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

async function assertSettingsOpen(page, { chrome = false } = {}) {
  const state = await page.evaluate(() => {
    const settings = document.querySelector("#settings");
    if (!(settings instanceof HTMLDialogElement)) {
      return { open: false, visible: false, titleVisible: false, closeVisible: false, title: "", close: "" };
    }
    const style = getComputedStyle(settings);
    const rect = settings.getBoundingClientRect();
    const visible = settings.open
      && !settings.hidden
      && style.visibility !== "hidden"
      && style.display !== "none"
      && rect.width > 0
      && rect.height > 0;
    const vis = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    };
    const title = document.querySelector("#settings-title");
    const close = document.querySelector("#settings-close");
    return {
      open: settings.open === true,
      visible,
      title: title?.textContent ?? "",
      close: close?.textContent ?? "",
      titleVisible: vis(title),
      closeVisible: vis(close),
    };
  });
  assert.equal(state.open, true, "settings.open must be true");
  assert.equal(state.visible, true, "#settings itself must be visible");
  if (chrome) {
    assert.equal(state.titleVisible, true, `settings title not in view: ${state.title}`);
    assert.equal(state.closeVisible, true, `settings close not in view: ${state.close}`);
    assert.match(state.title, /设置|Settings/);
    assert.match(state.close, /关闭|Close/);
  }
}

async function openSettings(page) {
  await page.evaluate(() => {
    const more = document.querySelector(".top-more");
    const compact = document.body.classList.contains("mode-focus")
      && document.body.classList.contains("view-replies")
      && window.matchMedia("(max-width: 1100px)").matches;
    if (more instanceof HTMLDetailsElement && compact) {
      more.classList.add("is-compact");
      more.open = true;
    }
    document.querySelector("#settings-open")?.click();
  });
  await page.waitForFunction(() => {
    const settings = document.querySelector("#settings");
    return settings instanceof HTMLDialogElement && settings.open === true;
  });
  await page.evaluate(() => {
    const settings = document.querySelector("#settings");
    if (settings) settings.scrollTop = 0;
    const sheet = document.querySelector(".settings-sheet");
    if (sheet) sheet.scrollTop = 0;
  });
  await assertSettingsOpen(page);
}

function noRawKind(text) {
  return !/\b(unsupported|not_installed|installing|installed_pending_trust|pending_reload|verified|conflict_custom|conflict_endpoint|failed|missing_cli|missing_resources)\b/.test(
    text,
  );
}

const preview = spawn(
  process.execPath,
  [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: root, stdio: "pipe", windowsHide: true },
);
let previewOut = "";
preview.stdout.on("data", (d) => {
  previewOut += d.toString();
});
preview.stderr.on("data", (d) => {
  previewOut += d.toString();
});
const url = `${viteOrigin}/`;
let isolation;
try {
  await waitHttp(url);
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("spellcast.locale", "zh-CN");
    } catch {}
    try {
      localStorage.setItem("spellcast.mode", "ambient");
    } catch {}
  });
  isolation = await attachIsolation(context);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#agent-complete-setup");
  assert.equal(await page.locator("body").getAttribute("data-theme"), "dark", "the home theme defaults to dark");
  const snippet = await page.$("#agent-snippet, #settings-snippet, #settings-path, #settings-skill-path, #agent-note, #settings-note");
  assert.equal(snippet, null, "manual snippet / skill path / old notes must be gone");

  await page.click('[data-client="codex"]');
  await page.waitForFunction(() => {
    const hint = document.querySelector("#agent-setup-hint")?.textContent ?? "";
    return hint.includes("桌面");
  });
  const home = await page.evaluate(() => ({
    status: document.querySelector("#agent-setup-status")?.textContent ?? "",
    hint: document.querySelector("#agent-setup-hint")?.textContent ?? "",
    details: document.querySelector("#agent-setup-details-body")?.textContent ?? "",
    detailsOpen: [...document.querySelectorAll(".setup-details")].some((el) => el.open),
    button: document.querySelector("#agent-complete-setup")?.textContent ?? "",
  }));
  assert.equal(noRawKind(home.status + home.hint), true, `raw kind: ${home.status} ${home.hint}`);
  assert.match(home.status, /未安装/);
  assert.match(home.hint, /桌面应用/);
  assert.equal(home.detailsOpen, false, "install details must start collapsed");
  assert.equal(/插件源|Install cache|Skill|C:\\\\Users/.test(home.status + home.hint), false);
  assert.match(home.button, /安装 Hooks \+ Skill/);
  assert.equal(await page.locator("#agent-result [data-setup-component]").count(), 3, "home shows MCP, Skill and Hooks checks");

  const cursorDisabled = await page.evaluate(() => ({
    button: document.querySelector('[data-client="cursor"]')?.disabled ?? false,
  }));
  assert.equal(cursorDisabled.button, true, "Cursor client stays unavailable");

  const grokHome = await page.evaluate(() => ({
    grokDisabled: document.querySelector('[data-client="grok"]')?.disabled ?? true,
    windsurfDisabled: document.querySelector('[data-client="windsurf"]')?.disabled ?? false,
    claudeDisabled: document.querySelector('[data-client="claude-code"]')?.disabled ?? false,
    genericDisabled: document.querySelector('[data-client="generic"]')?.disabled ?? false,
  }));
  assert.equal(grokHome.grokDisabled, true, "Grok Build install is deferred");
  assert.equal(grokHome.windsurfDisabled, true, "Windsurf stays unavailable");
  assert.equal(grokHome.claudeDisabled, true, "Claude Code stays unavailable");
  assert.equal(grokHome.genericDisabled, true, "generic stays unavailable");
  const grokLabel = await page.evaluate(() => document.querySelector('[data-client="grok"]')?.textContent ?? "");
  assert.match(grokLabel, /即将推出|coming later/i);
  const grokTitle = await page.evaluate(() => document.querySelector('[data-client="grok"]')?.getAttribute("title") ?? "");
  assert.match(grokTitle, /未来版本|future version/i);

  const localeOptions = await page.locator("#locale option").evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, text: node.textContent ?? "" })),
  );
  assert.deepEqual(
    localeOptions.map((item) => item.value),
    ["zh-CN", "en"],
    `locale picker must be Chinese and English only: ${JSON.stringify(localeOptions)}`,
  );
  assert.equal(localeOptions.some((item) => item.value === "ja" || /日本語/.test(item.text)), false);
  await page.selectOption("#locale", "en");
  await page.waitForFunction(() => (document.querySelector("#agent-setup-hint")?.textContent ?? "").includes("desktop app"));
  const enHint = await page.locator("#agent-setup-hint").innerText();
  assert.match(enHint, /desktop app/i);
  assert.match(await page.locator("#agent-setup-status").innerText(), /Not installed/);
  assert.match(await page.locator("#settings-title").innerText(), /Settings/);
  assert.match(await page.locator("#settings-close").innerText(), /Close/);
  await openSettings(page);
  const enIntro = await page.locator("#settings [data-setup-body]").innerText();
  assert.match(enIntro, /Choose the app you are using/);
  assert.equal(/使っているソフト|先选你正在用的软件/.test(enIntro), false);
  const enComponents = await page.evaluate(() => ({
    names: [...document.querySelectorAll("#settings .setup-component-name")].map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    observer: document.querySelector(".settings-observer")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  assert.match(enComponents.names.join(" | "), /Aside trigger.*Hooks/);
  assert.match(enComponents.names.join(" | "), /Canvas guide.*Skill/);
  assert.match(enComponents.names.join(" | "), /Local connection.*MCP/);
  assert.match(enComponents.observer, /Outside the main chat/);
  assert.match(enComponents.observer, /On:/);
  assert.match(enComponents.observer, /Off:/);
  assert.equal(/主对话之外|主会話|オン：|オフ：/.test(enComponents.observer), false);
  await page.keyboard.press("Escape");
  await page.selectOption("#locale", "zh-CN");
  await page.click('[data-client="codex"]');
  await page.waitForFunction(() => (document.querySelector("#agent-setup-hint")?.textContent ?? "").includes("桌面"));
  assert.match(await page.locator("#agent-setup-hint").innerText(), /桌面应用/);
  assert.match(await page.locator("#agent-setup-status").innerText(), /未安装/);
  assert.match(await page.locator("#settings-title").innerText(), /设置/);
  assert.match(await page.locator("#settings-close").innerText(), /关闭/);

  await page.locator("#agent-complete-setup").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "home-dark-1280.png") });

  await page.click("#agent-complete-setup");
  await page.waitForFunction(() => (document.querySelector("#agent-setup-status")?.textContent ?? "").includes("未完成"));
  const failed = await page.evaluate(() => ({
    status: document.querySelector("#agent-setup-status")?.textContent ?? "",
    hint: document.querySelector("#agent-setup-hint")?.textContent ?? "",
    details: document.querySelector("#agent-setup-details-body")?.textContent ?? "",
    disabled: document.querySelector("#agent-complete-setup")?.disabled ?? true,
    detailsOpen: [...document.querySelectorAll(".setup-details")].some((el) => el.open),
  }));
  assert.match(failed.status, /未完成/);
  assert.match(failed.hint, /可重试/);
  assert.equal(failed.disabled, false, "failed install must be retryable");
  assert.equal(failed.detailsOpen, false);
  assert.match(failed.details, /桌面应用/);
  assert.equal(noRawKind(failed.status + failed.hint), true);

  await openSettings(page);
  await assertSettingsOpen(page);
  const intro = await page.locator("#settings [data-setup-body]").innerText();
  assert.equal(/半套|half-installed|途中まで/.test(intro), false, `policy copy leaked: ${intro}`);
  assert.match(intro, /先选你正在用的软件/);
  assert.equal(/Choose the app you are using|使っているソフト/.test(intro), false);
  const components = await page.evaluate(() => ({
    names: [...document.querySelectorAll("#settings .setup-component-name")].map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    desc: [...document.querySelectorAll("#settings .setup-components p")].map((el) => el.textContent ?? ""),
    observer: document.querySelector(".settings-observer")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    switchInHead: Boolean(document.querySelector(".setup-observer-head .observer-switch")),
  }));
  assert.equal(components.switchInHead, true, "aside switch must sit next to the 旁念 title");
  assert.match(components.names.join(" | "), /旁念触发.*Hooks/);
  assert.match(components.names.join(" | "), /画布用法.*Skill/);
  assert.match(components.names.join(" | "), /本机连接.*MCP/);
  assert.match(components.desc.join("\n"), /旁念开了也不会自己出现/);
  assert.match(components.observer, /主对话之外/);
  assert.match(components.observer, /开：/);
  assert.match(components.observer, /关：/);
  assert.equal(/观察者|observer with no chat history|観察者を/.test(components.observer), false, `aside copy still too technical: ${components.observer}`);
  await page.screenshot({ path: path.join(out, "settings-dark-1280.png") });
  const cursorSettings = await page.evaluate(() => ({
    title: document.querySelector("#settings [data-setup-title]")?.textContent ?? "",
    hint: document.querySelector("#settings [data-setup-clients-hint]")?.textContent ?? "",
    cursorDisabled: document.querySelector('#settings .setup-clients [data-client="cursor"]')?.disabled ?? false,
    grokDisabled: document.querySelector('#settings .setup-clients [data-client="grok"]')?.disabled ?? true,
    installDisabled: document.querySelector("#settings-complete-setup")?.disabled ?? true,
  }));
  assert.match(cursorSettings.title, /Codex/);
  assert.match(cursorSettings.hint, /未来版本|future version/);
  assert.equal(cursorSettings.cursorDisabled, true, "settings Cursor button stays unavailable");
  assert.equal(cursorSettings.grokDisabled, true, "settings Grok Build button is deferred");
  await page.locator(".settings-observer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "settings-observer-dark-1280.png") });
  await page.evaluate(() => {
    const settings = document.querySelector("#settings");
    if (settings) settings.scrollTop = 0;
    const sheet = document.querySelector(".settings-sheet");
    if (sheet) sheet.scrollTop = 0;
  });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 880, height: 640 });
  await page.locator("#agent-complete-setup").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "home-dark-880.png") });
  await openSettings(page);
  await assertSettingsOpen(page, { chrome: true });
  await page.screenshot({ path: path.join(out, "settings-dark-880.png") });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1280, height: 860 });
  await openSettings(page);
  await page.selectOption("#theme-preference", "light");
  await page.keyboard.press("Escape");
  await page.click("#mode-focus");
  await page.waitForFunction(() => document.body.classList.contains("mode-focus") && document.body.classList.contains("view-replies"));
  await openSettings(page);
  await assertSettingsOpen(page);
  const lightColor = await page.evaluate(() => {
    const title = document.querySelector(".settings-observer .observer-switch-title");
    const status = document.querySelector("#settings-setup-status");
    return {
      title: title ? getComputedStyle(title).color : "",
      status: status ? getComputedStyle(status).color : "",
      paper: document.body.classList.contains("mode-focus"),
      replies: document.body.classList.contains("view-replies"),
      setupTheme: document.documentElement.dataset.setupTheme || "",
      checked: document.querySelector("#settings-observer-enabled")?.checked ?? false,
    };
  });
  assert.equal(lightColor.setupTheme, "", "must not use test-only setupTheme");
  assert.equal(lightColor.paper && lightColor.replies, true);
  assert.ok(luminance(lightColor.title) < 0.45, `canvas light switch foreground too bright: ${lightColor.title}`);
  await page.locator(".settings-observer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "canvas-light-settings-1280.png") });

  await page.locator("#settings-observer-enabled").scrollIntoViewIfNeeded();
  await page.locator("#settings-observer-enabled").click();
  await page.waitForFunction(() => document.querySelector("#settings-observer-enabled")?.checked === true);
  await page.locator(".settings-observer").scrollIntoViewIfNeeded();
  const onColors = await page.evaluate(() => {
    const title = document.querySelector(".settings-observer .observer-switch-title");
    const state = document.querySelector(".settings-observer .observer-switch-state");
    return {
      title: title ? getComputedStyle(title).color : "",
      state: state ? getComputedStyle(state).color : "",
      onText: state?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      checked: document.querySelector("#settings-observer-enabled")?.checked ?? false,
      setupTheme: document.documentElement.dataset.setupTheme || "",
    };
  });
  assert.equal(onColors.checked, true);
  assert.equal(onColors.setupTheme, "");
  assert.match(onColors.onText, /已开启|On|オン/);
  assert.ok(luminance(onColors.title) < 0.45, `ON title too bright: ${onColors.title}`);
  assert.ok(luminance(onColors.state) < 0.45, `ON state too bright: ${onColors.state}`);
  await assertSettingsOpen(page);
  await page.screenshot({ path: path.join(out, "canvas-light-settings-on-1280.png") });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 880, height: 640 });
  await openSettings(page);
  await assertSettingsOpen(page, { chrome: true });
  await page.screenshot({ path: path.join(out, "canvas-light-settings-880.png") });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  await assertSettingsOpen(page, { chrome: true });
  await page.screenshot({ path: path.join(out, "settings-canvas-390.png") });
  await page.keyboard.press("Escape");

  assert.equal(isolation.passthrough.length, 0, JSON.stringify(isolation.passthrough));
  assert.equal(
    isolation.mutations.every((item) => item.target === "fixture" && ["/api/surface", "/api/observer/settings"].includes(item.path)),
    true,
    JSON.stringify(isolation.mutations),
  );
  assert.equal(
    isolation.mutations.some((item) => item.path === "/api/observer/settings" && item.body?.enabled === true),
    true,
    "ON toggle must POST fixture /api/observer/settings",
  );
  assert.equal(
    isolation.fulfilled.some((item) => item.origin === productionOrigin && item.action !== undefined),
    true,
    "47194 URLs must be fulfilled as fixtures, not skipped",
  );
  const isolationPath = path.join(art, "isolation.json");
  await writeFile(
    isolationPath,
    JSON.stringify(
      {
        viteOrigin,
        productionOrigin,
        note: "Requests whose URL host:port is 127.0.0.1:47194 were fulfilled or aborted in the Playwright context. None were continued to the live Bridge.",
        mutations: isolation.mutations,
        fulfilled: isolation.fulfilled,
        aborted: isolation.aborted,
        passthrough: isolation.passthrough,
        viteAssetCount: isolation.vite.length,
      },
      null,
      2,
    ),
  );

  await browser.close();
  console.log(
    JSON.stringify(
      {
        url,
        isolationPath,
        mutations: isolation.mutations,
        fulfilledApi: isolation.fulfilled,
        aborted: isolation.aborted.length,
        passthrough: isolation.passthrough,
        shots: [
          "home-dark-1280",
          "settings-dark-1280",
          "settings-observer-dark-1280",
          "home-dark-880",
          "settings-dark-880",
          "canvas-light-settings-1280",
          "canvas-light-settings-on-1280",
          "canvas-light-settings-880",
          "settings-canvas-390",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  preview.kill();
  await writeFile(path.join(art, "preview-vite.log"), previewOut);
}
