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
const art = path.resolve(root, "artifacts/spellcast-ui-trust-20260913");
const out = path.join(art, "ui");
await mkdir(out, { recursive: true });
const port = Number(process.env.SPELLCAST_PREVIEW_PORT ?? 47296);
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
  topic: "fixture-trust",
  form: "spatial",
  form_reason: "",
  nodes: [
    node("idea-a", "同名点子", "A 的正文", { captured_context: captured, source_id: "task-1" }),
    node("idea-b", "同名点子", "B 的正文"),
    node("idea-c", "空正文点子", "", { captured_context: { ...captured, change: "空档" }, source_id: "task-1" }),
    node("idea-d", "关联点子", "D 的正文", { source_id: "task-1" }),
  ],
  edges: [],
  messages: [],
  replies: [
    reply("reply-1", "回复一", "idea-a", "task-1"),
    reply("reply-orphan", "独立回复", null, "task-1"),
  ],
  canvas: {
    revision: 1,
    objects: [
      obj("obj-a", "node", "idea-a"), obj("obj-b", "node", "idea-b"), obj("obj-c", "node", "idea-c"),
      obj("obj-d", "node", "idea-d"), obj("obj-r1", "reply", "reply-1"), obj("obj-ro", "reply", "reply-orphan"),
    ],
    items: [
      place("obj-a", 40, 40), place("obj-b", 300, 40), place("obj-c", 560, 40),
      place("obj-d", 40, 400), place("obj-r1", 40, 220), place("obj-ro", 560, 220),
    ],
  },
};
const bindings = [
  { source_id: "task-1", thread_id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/isolated", label: "周五排期", protocol_agent: "codex", bound_at_ms: 1 },
  { source_id: "task-2", thread_id: "22222222-2222-4222-8222-222222222222", cwd: "/tmp/other", label: "其他任务", protocol_agent: "codex", bound_at_ms: 2 },
];
const failed8 = { event: say(8, { text: "失败可重试", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "failed", error: "timeout", client_message_id: "c8" };
let feedback = {
  pending: [
    say(1, { text: "请展开这个想法", source_id: "task-1", node_id: "idea-a", object_id: "obj-a", title: "同名点子" }),
    { seq: 2, at_ms: 1_700_000_000_002, kind: "kept", text: "采纳了气泡", node_id: "idea-b", title: "同名点子" },
    { seq: 5, at_ms: 1_700_000_000_005, kind: "kept", node_id: "ghost-node" },
    { seq: 12, at_ms: 1_700_000_000_012, kind: "mystery", node_id: "idea-c", title: "空正文点子" },
    say(20, { text: "给其他任务的留言", source_id: "task-2", node_id: "idea-d", object_id: "obj-d" }),
    say(21, { text: "同一点子另一任务", source_id: "task-2", node_id: "idea-a", object_id: "obj-a" }),
  ],
  deliveries: [
    { event: say(1, { text: "请展开这个想法", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "waiting", client_message_id: "c1" },
    { event: say(4, { text: "已得到回复", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "responded", response_reply_id: "reply-1", response_object_ids: ["gone", "obj-r1"], client_message_id: "c4" },
    { event: say(6, { text: "失败且未绑定", source_id: "task-missing", node_id: "idea-b" }), phase: "failed", error: "unbound", client_message_id: "c6" },
    { ...failed8 },
    { event: say(20, { text: "给其他任务的留言", source_id: "task-2", node_id: "idea-d", object_id: "obj-d" }), phase: "waiting", client_message_id: "c20" },
    { event: say(21, { text: "同一点子另一任务", source_id: "task-2", node_id: "idea-a", object_id: "obj-a" }), phase: "waiting", client_message_id: "c21" },
  ],
  bindings,
};
const health = { surface: "ambient", port: 47294, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
let retryMode = "fail";
let queuedReceipt = null;

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
    if (method === "GET" && pathname === "/api/feedback") {
      log.fulfilled.push({ method, path: pathname, action: "get-feedback-fixture" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feedback) });
    }
    if (method === "GET" && pathname === "/api/board") {
      log.fulfilled.push({ method, path: pathname, action: "get-board-fixture" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board) });
    }
    if (method === "GET" && pathname === "/api/health") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(health) });
    }
    if (method === "GET" && pathname === "/api/forms") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ forms: [{ id: "spatial", label: "空间", blurb: "" }] }) });
    }
    if (method === "GET" && pathname === "/api/events") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [], last_seq: 0 }) });
    }
    if (method === "GET" && pathname === "/api/observer/status") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, paused: false, allowed: true, reason: "ok", policy_revision: 1 }) });
    }
    if (method === "GET" && pathname === "/api/memories") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ memories: [] }) });
    }
    if (method === "POST" && pathname === "/api/surface") {
      const body = request.postDataJSON();
      log.mutations.push({ method, path: pathname, body, target: "fixture" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...health, surface: body?.surface ?? "ambient" }) });
    }
    if (method === "POST" && pathname === "/api/feedback/8/retry") {
      log.mutations.push({ method, path: pathname, retryMode, target: "fixture" });
      if (retryMode === "fail") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture-retry-failed" }) });
      }
      queuedReceipt = { ...failed8, phase: "queued", queued_at_ms: 1_700_000_000_108, error: null };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(queuedReceipt) });
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
const result = { port, viteOrigin, assertions: [] };
try {
  await waitHttp(`${viteOrigin}/`);
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => { try { localStorage.setItem("spellcast.locale", "zh-CN"); localStorage.setItem("spellcast.mode", "ambient"); } catch {} });
  const isolation = await attachIsolation(context);
  const page = await context.newPage();
  await page.goto(`${viteOrigin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#feedback-open");
  await openFeedback(page);

  const followText = await page.locator("#feedback-list").innerText();
  assert.match(followText, /待整理/);
  assert.match(followText, /来源未记录/);
  assert.match(followText, /关联任务：周五排期/);
  assert.match(followText, /接收任务：其他任务/);
  assert.equal(followText.includes("关联任务：其他任务"), false);
  const ideaACards = await page.evaluate(() => [...document.querySelectorAll(".feedback-card")].filter((card) => card.querySelector("strong")?.textContent === "同名点子" && card.innerText.includes("请展开这个想法")).length);
  assert.equal(ideaACards, 1);
  assert.match(followText, /同一点子另一任务/);
  result.assertions.push("followup-unsorted-associated-one-card");

  await page.click('[data-feedback-view="activity"]');
  await page.waitForFunction(() => (document.querySelector("#feedback-list")?.textContent ?? "").includes("已采纳"));
  const activityText = await page.locator("#feedback-list").innerText();
  assert.match(activityText, /已采纳/);
  assert.match(activityText, /活动记录/);
  assert.match(activityText, /原内容暂不可用/);
  assert.equal(activityText.includes("你的留言"), false);
  assert.equal(activityText.includes("接收任务"), false);
  assert.equal(activityText.includes("状态未知"), false);
  assert.equal(activityText.includes("重试"), false);
  assert.equal(/\bkept\b/.test(activityText), false);
  assert.equal(activityText.includes("node:ghost"), false);
  await page.screenshot({ path: path.join(out, "activity-zh-1280.png") });
  result.assertions.push("activity-copy");

  await page.click('[data-feedback-view="followup"]');
  await page.waitForFunction(() => (document.querySelector("#feedback-list")?.textContent ?? "").includes("失败可重试"));
  const retry = page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" });
  assert.equal(await retry.count(), 1);
  retryMode = "fail";
  await retry.click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" }).count(), 1);
  assert.equal(await page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" }).isDisabled(), false);
  result.assertions.push("retry-fail-releases");

  retryMode = "success-stale";
  await page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" }).click();
  await page.waitForFunction(() => (document.querySelector(".feedback-note[data-seq='8']")?.innerText ?? "").includes("已排队"));
  assert.equal(await page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" }).count(), 0);
  assert.match(await page.locator(".feedback-note[data-seq='8']").innerText(), /已排队/);
  await page.waitForTimeout(3500);
  assert.equal(await page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" }).count(), 0);
  assert.match(await page.locator(".feedback-note[data-seq='8']").innerText(), /已排队/);
  result.assertions.push("retry-success-stale-poll");

  await page.click('[data-feedback-view="replied"]');
  await page.waitForFunction(() => (document.querySelector("#feedback-list")?.textContent ?? "").includes("已得到回复"));
  await page.click("text=查看回复");
  await page.waitForFunction(() => document.body.classList.contains("mode-focus"));
  await page.waitForSelector(".canvas-frame");
  const selected = await page.evaluate(() => document.querySelector(".canvas-frame.is-selected")?.getAttribute("data-item-id"));
  assert.equal(selected, "obj-r1");
  assert.notEqual(selected, "obj-a");
  result.assertions.push("response-nav-multi-object-ids");

  await page.screenshot({ path: path.join(out, "response-nav-1280.png") });
  await writeFile(path.join(art, "isolation.json"), JSON.stringify(isolation, null, 2));
  await writeFile(path.join(art, "ui-trust-run.json"), JSON.stringify({ ...result, isolation, previewOut: previewOut.slice(-2000) }, null, 2));
  await browser.close();
} finally {
  preview.kill();
}
console.log("ui-trust checks ok", result.assertions.join(","));
