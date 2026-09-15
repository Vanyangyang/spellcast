import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch {
  playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const art = path.resolve(root, "artifacts/spellcast-content-organization-20260913");
const out = path.join(art, "ui");
await mkdir(out, { recursive: true });
const port = Number(process.env.SPELLCAST_PREVIEW_PORT ?? 47295);
assert.notEqual(port, 47194);
const viteOrigin = `http://127.0.0.1:${port}`;
const productionOrigin = "http://127.0.0.1:47194";

const captured = { project: "日历", goal: "一周", change: "午餐已定", source_id: "task-1", captured_at_ms: 1 };
const node = (id, title, body, extra = {}) => ({ id, revision: 1, title, body, kind: "idea", weight: "note", x: 0, y: 0, z: 0, ...extra });
const reply = (id, title, origin, source) => ({
  id, source_id: source, source_label: "", origin_node_id: origin, title, revision: 1, created_at_ms: 1, updated_at_ms: 1,
  blocks: [{ id: "t", type: "text", text: `${title}正文` }],
});
const obj = (id, type, contentId) => ({ id, content: { type, id: contentId }, content_revision: 1 });
const place = (id, x, y) => ({ item_id: id, revision: 1, z: 0, removed: false, appearance: "plain", x, y, width: 220, height: 140 });
const say = (seq, extra) => ({ seq, at_ms: 1_700_000_000_000 + seq, kind: "say", ...extra });

const board = {
  topic: "fixture-org",
  form: "spatial",
  form_reason: "",
  nodes: [
    node("idea-a", "同名点子", "A 的正文", { captured_context: captured, source_id: "task-1" }),
    node("idea-b", "同名点子", "B 的正文"),
    node("idea-c", "空正文点子", "", { captured_context: { ...captured, change: "空档" }, source_id: "task-1" }),
  ],
  edges: [],
  messages: [],
  replies: [
    reply("reply-1", "回复一", "idea-a", "task-1"),
    reply("reply-2", "回复二", "idea-a", "task-2"),
    reply("reply-orphan", "独立回复", null, "task-1"),
  ],
  canvas: {
    revision: 1,
    objects: [
      obj("obj-a", "node", "idea-a"), obj("obj-b", "node", "idea-b"), obj("obj-c", "node", "idea-c"),
      obj("obj-r1", "reply", "reply-1"), obj("obj-r2", "reply", "reply-2"), obj("obj-ro", "reply", "reply-orphan"),
    ],
    items: [
      place("obj-a", 40, 40), place("obj-b", 300, 40), place("obj-c", 560, 40),
      place("obj-r1", 40, 220), place("obj-r2", 300, 220), place("obj-ro", 560, 220),
    ],
  },
};
const feedback = {
  pending: [
    say(1, { text: "请展开这个想法", source_id: "task-1", node_id: "idea-a", object_id: "obj-a", title: "同名点子" }),
    { seq: 2, at_ms: 1_700_000_000_002, kind: "kept", text: "采纳了气泡", node_id: "idea-b", title: "同名点子" },
    say(3, { text: "跨源问题", source_id: "task-1", anchors: [{ object_id: "obj-a", content_revision: 1 }, { object_id: "obj-ro", content_revision: 1 }] }),
    say(7, { text: "没有收据的老留言", source_id: "task-1", node_id: "idea-a" }),
  ],
  deliveries: [
    { event: say(1, { text: "请展开这个想法", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "waiting", client_message_id: "c1" },
    { event: say(4, { text: "已得到回复", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "responded", response_reply_id: "reply-1", response_object_ids: ["obj-r1"], client_message_id: "c4" },
    { event: say(6, { text: "失败且未绑定", source_id: "task-missing", node_id: "idea-b" }), phase: "failed", error: "unbound", client_message_id: "c6" },
    { event: say(8, { text: "失败可重试", source_id: "task-1", node_id: "idea-a" }), phase: "failed", error: "timeout", client_message_id: "c8" },
  ],
  bindings: [{ source_id: "task-1", thread_id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/isolated", label: "周五排期", protocol_agent: "codex", bound_at_ms: 1 }],
};
const health = { surface: "ambient", port: 47294, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
const fixtures = {
  GET: {
    "/api/board": board,
    "/api/forms": { forms: [{ id: "spatial", label: "空间", blurb: "" }, { id: "constellation", label: "星座", blurb: "" }, { id: "timeline", label: "时间", blurb: "" }, { id: "stack", label: "叠放", blurb: "" }] },
    "/api/health": health,
    "/api/events": { events: [], last_seq: 0 },
    "/api/feedback": feedback,
    "/api/observer/status": { enabled: false, paused: false, allowed: true, reason: "ok", policy_revision: 1 },
    "/api/memories": { memories: [] },
  },
};

function waitHttp(url, ms = 20000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < ms) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`preview not up: ${url}`);
  })();
}

async function openFeedback(page) {
  await page.evaluate(() => {
    const more = document.querySelector(".top-more");
    const compact = document.body.classList.contains("mode-focus")
      && document.body.classList.contains("view-replies")
      && window.matchMedia("(max-width: 1100px)").matches;
    if (more instanceof HTMLDetailsElement && compact) {
      more.classList.add("is-compact");
      more.open = true;
    }
    document.querySelector("#feedback-open")?.click();
  });
  await page.waitForSelector("#feedback-dialog[open]");
}

async function launchBrowser() {
  for (const channel of ["chrome", "msedge"]) {
    try { return await playwright.chromium.launch({ channel, headless: true }); } catch {}
  }
  return playwright.chromium.launch({ headless: true });
}

function attachIsolation(context) {
  const log = { fulfilled: [], aborted: [], mutations: [], passthrough: [], vite: 0 };
  const fulfillApi = async (route, request, parsed) => {
    const method = request.method();
    const pathname = parsed.pathname;
    if (method === "OPTIONS") {
      log.fulfilled.push({ method, path: pathname, action: "preflight-fixture" });
      return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": viteOrigin, "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type" } });
    }
    if (method === "GET" && (fixtures.GET[pathname] || pathname === "/api/memories")) {
      log.fulfilled.push({ method, path: pathname, origin: parsed.origin, action: "get-fixture" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pathname === "/api/memories" ? { memories: [] } : fixtures.GET[pathname]) });
    }
    if (method === "POST" && pathname === "/api/surface") {
      const body = request.postDataJSON();
      log.mutations.push({ method, path: pathname, body, target: "fixture" });
      log.fulfilled.push({ method, path: pathname, action: "post-fixture" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...health, surface: body?.surface ?? "ambient" }) });
    }
    log.aborted.push({ method, path: pathname, origin: parsed.origin, reason: "unexpected-api" });
    return route.abort("blockedbyclient");
  };
  return context.route("**/*", async (route, request) => {
    const parsed = new URL(request.url());
    if (parsed.origin === productionOrigin || parsed.port === "47194") return fulfillApi(route, request, parsed);
    if (parsed.origin === viteOrigin) { log.vite += 1; return route.continue(); }
    log.aborted.push({ method: request.method(), path: parsed.pathname, origin: parsed.origin, reason: "unexpected-network" });
    return route.abort("blockedbyclient");
  }).then(() => context.route("http://127.0.0.1:47194/**", (route, request) => fulfillApi(route, request, new URL(request.url())))).then(() => log);
}

const preview = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "pipe", windowsHide: true });
let previewOut = "";
preview.stdout.on("data", (d) => { previewOut += d.toString(); });
preview.stderr.on("data", (d) => { previewOut += d.toString(); });
try {
  await waitHttp(`${viteOrigin}/`);
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => { try { localStorage.setItem("spellcast.locale", "zh-CN"); localStorage.setItem("spellcast.mode", "ambient"); } catch {} });
  const isolation = await attachIsolation(context);
  const page = await context.newPage();
  await page.goto(`${viteOrigin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#feedback-open");
  const badge = await page.locator("#feedback-count").innerText();
  assert.match(badge, /5/);
  assert.equal(/采纳|kept/i.test(badge), false);

  await page.click("#feedback-open");
  await page.waitForSelector("#feedback-dialog[open]");
  const followText = await page.locator("#feedback-list").innerText();
  assert.match(followText, /你的留言/);
  assert.match(followText, /接收任务：周五排期/);
  assert.match(followText, /状态未知/);
  assert.match(followText, /原任务未关联|不能重试/);
  assert.equal(followText.includes("采纳了气泡"), false);
  assert.equal(await page.locator("#feedback-list button", { hasText: "重试" }).count(), 1);
  await page.locator(".feedback-note details").first().evaluate((el) => { el.open = true; el.dispatchEvent(new Event("toggle")); });
  await page.screenshot({ path: path.join(out, "feedback-followup-dark-1280.png") });
  await page.setViewportSize({ width: 880, height: 640 });
  await page.screenshot({ path: path.join(out, "feedback-followup-dark-880.png") });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.fill("#feedback-search", "跨源");
  await page.waitForFunction(() => (document.querySelector("#feedback-list")?.textContent ?? "").includes("跨源问题"));
  assert.equal((await page.locator("#feedback-list").innerText()).includes("请展开这个想法"), false);
  await page.fill("#feedback-search", "");
  await page.waitForFunction(() => (document.querySelector("#feedback-list")?.textContent ?? "").includes("请展开这个想法"));
  assert.equal(await page.locator("#feedback-search").inputValue(), "");
  assert.equal(await page.locator(".feedback-note details[open]").count() > 0, true);
  await page.click('[data-feedback-view="replied"]');
  await page.waitForFunction(() => (document.querySelector("#feedback-list")?.textContent ?? "").includes("已得到回复"));
  assert.equal((await page.locator("#feedback-list").innerText()).includes("请展开这个想法"), false);
  await page.screenshot({ path: path.join(out, "feedback-replied-dark-1280.png") });
  await page.click("text=查看回复");
  await page.waitForFunction(() => document.body.classList.contains("mode-focus"));
  await page.waitForSelector(".canvas-frame");
  const selected = await page.evaluate(() => document.querySelector(".canvas-frame.is-selected")?.getAttribute("data-item-id"));
  assert.equal(selected, "obj-r1");

  await page.click("#feedback-open");
  await page.click('[data-feedback-view="activity"]');
  await page.waitForFunction(() => (document.querySelector("#feedback-list")?.textContent ?? "").includes("已采纳"));
  const activityText = await page.locator("#feedback-list").innerText();
  assert.match(activityText, /已采纳/);
  assert.equal(activityText.includes("你的留言"), false);
  assert.equal(activityText.includes("接收任务"), false);
  assert.equal(activityText.includes("状态未知"), false);
  assert.equal(/\bkept\b/.test(activityText), false);
  assert.equal(activityText.includes("采纳了气泡"), false);
  await page.keyboard.press("Escape");

  const before = await page.evaluate(() => [...document.querySelectorAll(".canvas-frame")].map((el) => {
    const box = el.getBoundingClientRect();
    return { id: el.getAttribute("data-item-id"), x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
  }));
  assert.equal(before.length, 6);
  await page.getByRole("button", { name: "内容总览" }).click();
  await page.waitForSelector(".canvas-overview[open], dialog.canvas-overview");
  await page.fill("#canvas-overview-search", "同名点子");
  const names = await page.locator(".canvas-overview-card .canvas-overview-open").allInnerTexts();
  assert.equal(names.filter((name) => name === "同名点子").length, 2);
  await page.fill("#canvas-overview-search", "");
  await page.selectOption("#canvas-overview-project", "unsorted");
  const unsorted = await page.locator(".canvas-overview-card .canvas-overview-open").allInnerTexts();
  assert.ok(unsorted.includes("同名点子"));
  assert.equal(unsorted.includes("空正文点子"), false);
  const after = await page.evaluate(() => [...document.querySelectorAll(".canvas-frame")].map((el) => {
    const box = el.getBoundingClientRect();
    return { id: el.getAttribute("data-item-id"), x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
  }));
  assert.deepEqual(after, before);
  await page.screenshot({ path: path.join(out, "overview-filter-dark-1280.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "内容总览" }).click();
  await page.fill("#canvas-overview-search", "");
  await page.selectOption("#canvas-overview-project", "all");
  await page.locator('.canvas-overview-card[data-item-id="obj-a"]').getByRole("button", { name: "定位" }).click();
  const frame = page.locator('.canvas-frame[data-item-id="obj-a"]');
  assert.equal(await frame.count(), 1);
  const html = await frame.innerHTML();
  assert.match(html, /textarea|contenteditable|rb-|canvas-native|ins-body/i, html.slice(0, 400));

  await page.setViewportSize({ width: 1280, height: 860 });
  await openFeedback(page);
  await page.click('[data-feedback-view="followup"]');
  await page.screenshot({ path: path.join(out, "feedback-followup-light-1280.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "内容总览" }).click();
  await page.screenshot({ path: path.join(out, "overview-light-1280.png") });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 880, height: 640 });
  await page.getByRole("button", { name: "内容总览" }).click();
  await page.screenshot({ path: path.join(out, "overview-light-880.png") });
  await page.keyboard.press("Escape");
  await openFeedback(page);
  await page.click('[data-feedback-view="followup"]');
  const chrome = await page.evaluate(() => {
    const title = document.querySelector("#feedback-heading");
    const close = document.querySelector("#feedback-dialog [data-close]");
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < window.innerHeight; };
    return { title: title?.textContent, titleVis: vis(title), closeVis: vis(close) };
  });
  assert.match(chrome.title, /回复/);
  assert.equal(chrome.titleVis && chrome.closeVis, true);
  await page.screenshot({ path: path.join(out, "feedback-followup-light-880.png") });

  assert.equal(isolation.passthrough.length, 0, JSON.stringify(isolation.passthrough));
  assert.equal(isolation.mutations.every((item) => item.target === "fixture"), true);
  await writeFile(path.join(art, "isolation.json"), JSON.stringify({ viteOrigin, productionOrigin, mutations: isolation.mutations, fulfilled: isolation.fulfilled, aborted: isolation.aborted, passthrough: isolation.passthrough }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ url: `${viteOrigin}/`, passthrough: isolation.passthrough, mutations: isolation.mutations, shots: ["feedback-replied-dark-1280", "overview-filter-dark-1280", "feedback-followup-dark-880", "overview-light-1280", "overview-light-880", "feedback-followup-light-880"] }, null, 2));
} finally {
  preview.kill();
  await writeFile(path.join(art, "preview-vite.log"), previewOut);
}
