import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, writeFile, readdir, stat, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch {
  playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const art = path.resolve(root, process.env.SPELLCAST_ACCEPTANCE_ARTIFACT_DIR ?? "artifacts/spellcast-canvas-feedback-20260914");
const out = path.join(art, "ui-round2");
await mkdir(out, { recursive: true });
const port = Number(process.env.SPELLCAST_PREVIEW_PORT ?? 47297);
assert.notEqual(port, 47194);
const viteOrigin = `http://127.0.0.1:${port}`;
const productionOrigin = "http://127.0.0.1:47194";

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
async function fileInfo(filePath) {
  const buf = await readFile(filePath);
  const st = await stat(filePath);
  return { path: filePath, sha256: sha256(buf), mtime: st.mtime.toISOString(), bytes: st.size };
}
function run(command, args, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.VITE_API_URL;
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr, cwd, argv: [command, ...args] }));
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(fn, ms, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}

const captured = { project: "日历", goal: "一周", change: "午餐已定", source_id: "task-1", captured_at_ms: 1 };
const node = (id, title, body, extra = {}) => ({ id, revision: 1, title, body, kind: "idea", weight: "note", x: 0, y: 0, z: 0, ...extra });
const obj = (id, type, contentId) => ({ id, content: { type, id: contentId }, content_revision: 1 });
const place = (id, x, y, extra = {}) => ({ item_id: id, revision: 1, z: 0, removed: false, appearance: "plain", x, y, width: 380, height: 300, ...extra });
const say = (seq, extra) => ({ seq, at_ms: 1_700_000_000_000 + seq, kind: "say", ...extra });

let board = {
  topic: "fixture-canvas",
  form: "spatial",
  form_reason: "",
  nodes: [
    node("idea-a", "同名点子", "A 的正文", { captured_context: captured, source_id: "task-1" }),
    node("idea-title", "这是一条只有标题没有正文的想法节点标题文字足够长", ""),
    node("idea-old", "旧点子", "旧正文"),
    node("idea-child", "明确子点子", "子正文", { parent_id: "idea-a" }),
    node("idea-hidden", "隐藏点子", "隐藏正文"),
  ],
  edges: [
    { id: "legacy-1", from: "idea-a", to: "idea-old" },
    { id: "parent-1", from: "idea-a", to: "idea-child", relation: "parent" },
  ],
  messages: [],
  replies: [
    { id: "reply-1", source_id: "task-1", source_label: "", origin_node_id: "idea-a", title: "回复一", revision: 1, created_at_ms: 1, updated_at_ms: 1, blocks: [{ id: "t", type: "text", text: "回复一正文" }] },
  ],
  canvas: {
    revision: 1,
    objects: [
      obj("obj-a", "node", "idea-a"), obj("obj-title", "node", "idea-title"), obj("obj-old", "node", "idea-old"),
      obj("obj-child", "node", "idea-child"), obj("obj-r1", "reply", "reply-1"), obj("obj-hidden", "node", "idea-hidden"),
    ],
    items: [
      place("obj-a", 40, 40), place("obj-title", 460, 40), place("obj-old", 40, 380),
      place("obj-child", 460, 380), place("obj-r1", 40, 720, { width: 640, height: 560 }),
      place("obj-hidden", 900, 40, { removed: true, user_modified: true, width: 200, height: 120 }),
    ],
  },
};
const failed8 = { event: say(8, { text: "失败可重试", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "failed", error: "timeout", client_message_id: "c8" };
let feedback = {
  pending: [
    say(1, { text: "请展开这个想法", source_id: "task-1", node_id: "idea-a", object_id: "obj-a", title: "同名点子" }),
    say(21, { text: "同一点子另一任务", source_id: "task-2", node_id: "idea-a", object_id: "obj-a" }),
    { seq: 2, at_ms: 1_700_000_000_002, kind: "kept", text: "采纳了气泡", node_id: "idea-old", title: "旧点子" },
    { seq: 5, at_ms: 1_700_000_000_005, kind: "kept", node_id: "ghost-node" },
  ],
  deliveries: [
    { event: say(1, { text: "请展开这个想法", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "waiting", client_message_id: "c1" },
    { event: say(4, { text: "已得到回复", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "responded", response_reply_id: "reply-1", response_object_ids: ["gone", "obj-r1"], client_message_id: "c4" },
    { event: say(11, { text: "缺失回复", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "responded", response_reply_id: "missing-reply", response_object_ids: ["missing-obj"], client_message_id: "c11" },
    { ...failed8 },
    { event: say(21, { text: "同一点子另一任务", source_id: "task-2", node_id: "idea-a", object_id: "obj-a" }), phase: "waiting", client_message_id: "c21" },
  ],
  bindings: [
    { source_id: "task-1", thread_id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/isolated", label: "周五排期", protocol_agent: "codex", bound_at_ms: 1 },
    { source_id: "task-2", thread_id: "22222222-2222-4222-8222-222222222222", cwd: "/tmp/other", label: "其他任务", protocol_agent: "codex", bound_at_ms: 2 },
  ],
};
const health = { surface: "ambient", port: 47294, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
let observerEnabled = false;
let retryMode = "waiting";
let delayFeedbackGet = false;
const delayedGets = [];
let refreshFailOnce = false;
let feedbackGetCount = 0;
const nodePatches = [];
const isolation = {
  fulfilled: [],
  aborted: [],
  unexpectedApi: [],
  abortedThirdParty: [],
  continueAllowed: [],
  mutations: [],
  fixtureHits: [],
};

function knownApi(method, pathname) {
  if (method === "OPTIONS") return true;
  if (method === "PATCH" && pathname.startsWith("/api/nodes/")) return true;
  if (method === "POST" && pathname === "/api/feedback/8/retry") return true;
  const key = `${method} ${pathname}`;
  return new Set([
    "GET /api/board",
    "GET /api/forms",
    "GET /api/health",
    "GET /api/events",
    "GET /api/feedback",
    "GET /api/observer/status",
    "GET /api/memories",
    "POST /api/surface",
    "POST /api/observer/settings",
    "POST /api/canvas",
  ]).has(key);
}

function waitHttp(url, ms = 20000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < ms) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {}
      await sleep(200);
    }
    throw new Error(`preview not up: ${url}`);
  })();
}
async function launchBrowser() {
  for (const channel of ["chrome", "msedge"]) {
    try { return await playwright.chromium.launch({ channel, headless: true }); } catch {}
  }
  return playwright.chromium.launch({ headless: true });
}
function attachIsolation(context) {
  const fulfillApi = async (route, request, parsed) => {
    const method = request.method();
    const pathname = parsed.pathname;
    if (!knownApi(method, pathname)) {
      isolation.unexpectedApi.push({ method, path: pathname, origin: parsed.origin, url: request.url() });
      isolation.aborted.push({ method, path: pathname, origin: parsed.origin, reason: "unexpected-api" });
      return route.abort("blockedbyclient");
    }
    isolation.fulfilled.push({ method, path: pathname, origin: parsed.origin });
    isolation.fixtureHits.push({ method, path: pathname, origin: parsed.origin, expected: "fixture-fulfill" });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": viteOrigin, "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type" } });
    }
    if (method === "GET" && pathname === "/api/feedback") {
      if (refreshFailOnce) {
        refreshFailOnce = false;
        isolation.fixtureHits.push({ method, path: pathname, status: 500, body: { error: "refresh-failed" } });
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "refresh-failed" }) });
      }
      const snapshot = structuredClone(feedback);
      if (delayFeedbackGet) await new Promise((resolve) => delayedGets.push(resolve));
      feedbackGetCount += 1;
      isolation.fixtureHits.push({ method, path: pathname, status: 200, getCount: feedbackGetCount, phases: snapshot.deliveries.map((d) => [d.event.seq, d.phase]) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    }
    if (method === "GET" && pathname === "/api/board") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board) });
    if (method === "GET" && pathname === "/api/health") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...health, observer_enabled: observerEnabled }) });
    if (method === "GET" && pathname === "/api/forms") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ forms: [{ id: "spatial", label: "空间", blurb: "" }] }) });
    if (method === "GET" && pathname === "/api/events") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [], last_seq: 0 }) });
    if (method === "GET" && pathname === "/api/observer/status") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: observerEnabled, paused: false, allowed: true, reason: "ok", policy_revision: 1 }) });
    if (method === "GET" && pathname === "/api/memories") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ memories: [] }) });
    if (method === "POST" && pathname === "/api/surface") {
      const body = request.postDataJSON();
      isolation.mutations.push({ method, path: pathname, body });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...health, surface: body?.surface ?? "ambient", observer_enabled: observerEnabled }) });
    }
    if (method === "POST" && pathname === "/api/observer/settings") {
      const body = request.postDataJSON();
      observerEnabled = Boolean(body?.enabled);
      isolation.mutations.push({ method, path: pathname, body });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: observerEnabled, paused: false, allowed: true, reason: "ok", policy_revision: 2 }) });
    }
    if (method === "POST" && pathname === "/api/feedback/8/retry") {
      isolation.mutations.push({ method, path: pathname, retryMode });
      if (retryMode === "fail") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture-retry-failed" }) });
      const waiting = { ...failed8, phase: "waiting", error: null };
      feedback = { ...feedback, deliveries: feedback.deliveries.map((item) => item.event.seq === 8 ? waiting : item) };
      isolation.fixtureHits.push({ method, path: pathname, status: 200, response: { phase: "waiting", error: null, seq: 8 } });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(waiting) });
    }
    if (method === "PATCH" && pathname.startsWith("/api/nodes/")) {
      const id = decodeURIComponent(pathname.slice("/api/nodes/".length));
      const body = request.postDataJSON() ?? {};
      nodePatches.push({ id, body });
      isolation.mutations.push({ method, path: pathname, body });
      isolation.fixtureHits.push({ method, path: pathname, request: body });
      board = { ...board, nodes: board.nodes.map((item) => item.id === id ? { ...item, title: body.title ?? item.title, body: body.body ?? item.body, revision: (item.revision ?? 1) + 1 } : item) };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board.nodes.find((item) => item.id === id)) });
    }
    if (method === "POST" && pathname === "/api/canvas") {
      const body = request.postDataJSON() ?? {};
      isolation.mutations.push({ method, path: pathname, body });
      isolation.fixtureHits.push({ method, path: pathname, itemIds: (body.items ?? []).map((item) => item.item_id) });
      const items = body.items ?? [];
      const nextItems = board.canvas.items.map((cur) => {
        const patch = items.find((item) => item.item_id === cur.item_id);
        return patch ? { ...cur, ...patch, revision: (cur.revision ?? 1) + 1 } : cur;
      });
      board = { ...board, canvas: { ...board.canvas, revision: board.canvas.revision + 1, items: nextItems } };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board.canvas) });
    }
    isolation.unexpectedApi.push({ method, path: pathname, origin: parsed.origin, reason: "known-unhandled" });
    isolation.aborted.push({ method, path: pathname, origin: parsed.origin, reason: "unexpected-api" });
    return route.abort("blockedbyclient");
  };
  return context.route("**/*", async (route, request) => {
    const parsed = new URL(request.url());
    if (parsed.origin === productionOrigin || parsed.port === "47194") return fulfillApi(route, request, parsed);
    if (parsed.origin === viteOrigin) {
      if (parsed.pathname.startsWith("/api/")) {
        isolation.unexpectedApi.push({ method: request.method(), path: parsed.pathname, origin: parsed.origin, reason: "api-on-preview-origin" });
        isolation.aborted.push({ method: request.method(), path: parsed.pathname, origin: parsed.origin, reason: "unexpected-api" });
        return route.abort("blockedbyclient");
      }
      isolation.continueAllowed.push({ method: request.method(), url: request.url() });
      return route.continue();
    }
    isolation.abortedThirdParty.push({ method: request.method(), path: parsed.pathname, origin: parsed.origin });
    isolation.aborted.push({ method: request.method(), path: parsed.pathname, origin: parsed.origin, reason: "third-party" });
    return route.abort("blockedbyclient");
  }).then(() => context.route("http://127.0.0.1:47194/**", (route, request) => fulfillApi(route, request, new URL(request.url()))));
}

const probeJs = () => ({
  zoom: document.querySelector(".canvas-zoom-value")?.textContent ?? "",
  host: { w: document.querySelector(".canvas-graph")?.clientWidth ?? 0, h: document.querySelector(".canvas-graph")?.clientHeight ?? 0 },
  hostRect: (() => { const r = document.querySelector(".canvas-graph")?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })(),
  viewport: { w: document.querySelector(".canvas-viewport")?.clientWidth ?? 0, h: document.querySelector(".canvas-viewport")?.clientHeight ?? 0 },
  svg: document.querySelector(".x6-graph-svg-viewport, .x6-graph-svg-stage")?.getAttribute("transform")
    ?? document.querySelector(".x6-graph-svg-viewport, .x6-graph-svg-stage")?.style?.transform
    ?? null,
  view: (() => { try { return JSON.parse(localStorage.getItem("spellcast.canvas-view") || "null"); } catch { return null; } })(),
  frames: [...document.querySelectorAll(".canvas-frame")].map((el) => {
    const r = el.getBoundingClientRect();
    const host = document.querySelector(".canvas-graph")?.getBoundingClientRect();
    const title = el.querySelector(".rb-block-title");
    const ts = title ? getComputedStyle(title) : null;
    const tr = title?.getBoundingClientRect();
    return {
      id: el.dataset.itemId,
      x: r.x, y: r.y, w: r.width, h: r.height,
      selected: el.classList.contains("is-selected"),
      active: el.classList.contains("is-active"),
      intersectsHost: Boolean(host && r.width > 8 && r.height > 8 && r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom),
      title: title?.textContent ?? "",
      titleHidden: Boolean(title?.hidden),
      titleDisplay: ts?.display ?? null,
      titleVisibility: ts?.visibility ?? null,
      titleOpacity: ts?.opacity ?? null,
      titleRect: tr ? { x: tr.x, y: tr.y, w: tr.width, h: tr.height } : null,
    };
  }),
});

function titleUserVisible(frame, host, minH = 4) {
  if (!frame || !host) return false;
  if (frame.titleHidden) return false;
  if (frame.titleDisplay === "none" || frame.titleVisibility === "hidden") return false;
  if (Number(frame.titleOpacity) === 0) return false;
  const r = frame.titleRect;
  if (!r || r.w < 8 || r.h < minH) return false;
  return r.x + r.w > host.x && r.x < host.x + host.w && r.y + r.h > host.y && r.y < host.y + host.h;
}

const sourceFiles = [
  "src/canvas.ts", "src/canvas-view.ts", "src/board-tools.ts", "src/content-organization.ts",
  "src/api.ts", "src/main.ts", "scripts/check-canvas-feedback-20260914.mjs",
];
const sourceHashes = {};
for (const rel of sourceFiles) sourceHashes[rel] = await fileInfo(path.join(root, rel));
await writeFile(path.join(art, "source-hashes-round2.json"), JSON.stringify(sourceHashes, null, 2));

const build = await run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"], root);
await writeFile(path.join(art, "vite-build-before-preview.stdout.txt"), build.stdout);
await writeFile(path.join(art, "vite-build-before-preview.stderr.txt"), build.stderr);
await writeFile(path.join(art, "vite-build-before-preview.json"), JSON.stringify({ cwd: build.cwd, argv: build.argv, exit: build.code }, null, 2));
assert.equal(build.code, 0, build.stderr);
const distAssets = path.join(root, "dist/assets");
const distFiles = (await readdir(distAssets)).filter((name) => name.startsWith("main-") && name.endsWith(".js"));
assert.ok(distFiles.length, "dist main bundle missing");
const distMain = path.join(distAssets, distFiles[0]);
const distInfo = await fileInfo(distMain);
const served = { url: null, hash: null, bytes: 0 };

const preview = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root, stdio: "pipe", windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "VITE_API_URL")),
});
let previewOut = "";
preview.stdout.on("data", (d) => { previewOut += d.toString(); });
preview.stderr.on("data", (d) => { previewOut += d.toString(); });
const result = { assertions: [], camera: [], bundle: { distMain, ...distInfo }, sourceHashes };
let browser;
try {
  await waitHttp(`${viteOrigin}/`);
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("spellcast.locale", "zh-CN");
      localStorage.setItem("spellcast.mode", "focus");
      const before = localStorage.getItem("spellcast.canvas-view");
      const seed = sessionStorage.getItem("spellcast.test-canvas-view");
      if (seed === "") localStorage.removeItem("spellcast.canvas-view");
      else if (seed) localStorage.setItem("spellcast.canvas-view", seed);
      window.__canvasViewBeforeSeedReapply = before;
      window.__canvasViewSeed = seed;
      window.__canvasViewAtDocumentStart = localStorage.getItem("spellcast.canvas-view");
    } catch {}
  });
  context.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/assets/main-") && url.endsWith(".js") && !served.hash) {
      const buf = Buffer.from(await response.body());
      served.url = url;
      served.hash = sha256(buf);
      served.bytes = buf.length;
    }
  });
  await attachIsolation(context);
  const page = await context.newPage();
  const dumpProbe = async (name) => {
    const probe = await page.evaluate(probeJs);
    result.camera.push({ phase: name, ...probe });
    await writeFile(path.join(art, `camera-probe-${name}.json`), JSON.stringify(probe, null, 2));
    return probe;
  };
  const waitVisibleContent = async (label) => {
    try {
      await page.waitForFunction(() => {
        const zoom = parseInt(document.querySelector(".canvas-zoom-value")?.textContent ?? "0", 10);
        const host = document.querySelector(".canvas-graph")?.getBoundingClientRect();
        if (!host || host.width < 32 || host.height < 32 || !(zoom > 5)) return false;
        return [...document.querySelectorAll(".canvas-frame")].some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 20 && r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom;
        });
      }, { timeout: 15000 });
    } catch (error) {
      await dumpProbe(`FAIL-${label}`);
      await page.screenshot({ path: path.join(out, `FAIL-${label}.png`) });
      throw error;
    }
  };
  const loadWithView = async (view, label) => {
    const seedJson = view ? JSON.stringify(view) : "";
    await page.evaluate((s) => {
      sessionStorage.setItem("spellcast.test-canvas-view", s);
      if (s) localStorage.setItem("spellcast.canvas-view", s);
      else localStorage.removeItem("spellcast.canvas-view");
    }, seedJson);
    const seededBeforeReload = await page.evaluate(() => localStorage.getItem("spellcast.canvas-view"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".canvas-frame");
    const started = await page.evaluate(() => ({
      documentStart: window.__canvasViewAtDocumentStart ?? null,
      seed: window.__canvasViewSeed ?? null,
      beforeSeedReapply: window.__canvasViewBeforeSeedReapply ?? null,
      afterBoot: localStorage.getItem("spellcast.canvas-view"),
    }));
    const trace = { phase: `seed-trace-${label}`, requested: view, seededBeforeReload, ...started };
    result.camera.push(trace);
    await writeFile(path.join(art, `camera-seed-${label}.json`), JSON.stringify(trace, null, 2));
    const startedView = started.documentStart ? JSON.parse(started.documentStart) : null;
    if (view) {
      assert.equal(startedView?.scale, view.scale, `document start scale != seeded (${label})`);
      assert.equal(startedView?.x, view.x, `document start x != seeded (${label})`);
      assert.equal(startedView?.y, view.y, `document start y != seeded (${label})`);
    }
    return started;
  };
  const mouseOnCard = async (id, kind = "click") => {
    const box = await page.locator(`.canvas-frame[data-item-id='${id}'] .canvas-card-drag`).boundingBox();
    assert.ok(box, `no box for ${id}`);
    const x = box.x + Math.min(40, Math.max(8, box.width / 2));
    const y = box.y + Math.min(28, Math.max(8, box.height / 2));
    if (kind === "dblclick") await page.mouse.dblclick(x, y);
    else await page.mouse.click(x, y);
  };

  await page.goto(`${viteOrigin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".canvas-frame");
  await waitVisibleContent("first-load");
  await dumpProbe("first-load");

  const beforeTiny = await dumpProbe("before-0.01-reload");
  await loadWithView({ scale: 0.01, x: 200, y: 150 }, "0.01");
  const immediately = await dumpProbe("after-0.01-before-wait");
  await waitVisibleContent("recover-0.01");
  const afterRecover = await dumpProbe("after-0.01-recover");
  const zoomAfterTiny = parseInt(afterRecover.zoom, 10);
  assert.ok(zoomAfterTiny > 5, `0.01 did not recover, zoom=${afterRecover.zoom}`);
  assert.ok(afterRecover.frames.some((f) => f.intersectsHost), "0.01 recover produced no on-screen card");
  const readable = afterRecover.frames.find((f) => f.intersectsHost && ((f.titleRect && f.titleRect.h >= 12 && f.titleRect.w >= 24) || f.id === "obj-r1"));
  assert.ok(readable, `0.01 recover has no readable content: ${JSON.stringify(afterRecover.frames.map((f) => [f.id, f.intersectsHost]))}`);
  result.assertions.push("recover-0.01-readable");
  result.camera.push({ beforeTinyZoom: beforeTiny.zoom, immediatelyZoom: immediately.zoom, recoveredZoom: afterRecover.zoom });
  await page.screenshot({ path: path.join(out, "recover-0.01-1280.png") });

  await loadWithView({ scale: 1, x: 230, y: 190 }, "keep-normal");
  await waitVisibleContent("keep-normal");
  const kept = await dumpProbe("keep-normal");
  const keptZoom = parseInt(kept.zoom, 10);
  assert.ok(keptZoom >= 85, `normal camera not kept, zoom=${kept.zoom}`);
  assert.ok(kept.frames.find((f) => f.id === "obj-a")?.intersectsHost, "kept view lost obj-a");
  result.assertions.push("normal-camera-kept");

  await loadWithView({ scale: 1, x: 20000, y: 20000 }, "offscreen");
  await waitVisibleContent("offscreen-recover");
  const off = await dumpProbe("offscreen-recover");
  assert.ok(off.frames.some((f) => f.intersectsHost), "offscreen did not recover to content");
  result.assertions.push("offscreen-recover");

  const edgeEvidenceJs = () => {
    const rawDomIds = [...document.querySelectorAll(".x6-edge")].map((el) => el.getAttribute("data-cell-id"));
    const counts = {};
    for (const id of rawDomIds) {
      if (!id) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
    const duplicateIds = Object.entries(counts)
      .filter(([, n]) => n > 1)
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => a.id.localeCompare(b.id));
    let modelIds = null;
    try {
      const host = document.querySelector(".canvas-graph");
      const raw = host && "__spellcastEdgeModelIds" in host ? host.__spellcastEdgeModelIds : null;
      modelIds = Array.isArray(raw) ? [...raw] : null;
    } catch { modelIds = null; }
    const sortedDomIds = [...rawDomIds].sort();
    const modelSorted = modelIds ? [...modelIds].sort() : null;
    return {
      rawDomIds,
      sortedDomIds,
      modelIds,
      modelSorted,
      duplicateIds,
      svgCount: rawDomIds.length,
      uniqueDomCount: Object.keys(counts).length,
      modelCount: modelIds ? modelIds.length : null,
      modelSvgMismatch: modelSorted
        ? JSON.stringify(modelSorted) !== JSON.stringify(sortedDomIds)
        : duplicateIds.length > 0,
    };
  };
  const dumpEdges = async (name) => {
    const evidence = await page.evaluate(edgeEvidenceJs);
    result.edges = result.edges || {};
    result.edges[name] = evidence;
    await writeFile(path.join(art, `edges-${name}.json`), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: path.join(out, `edges-${name}-1280.png`) });
    return evidence;
  };
  const waitExactEdges = async (expected, label) => {
    try {
      await page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll(".x6-edge")].map((el) => el.getAttribute("data-cell-id")).filter(Boolean).sort()) === want,
        JSON.stringify(expected), { timeout: 5000 });
    } catch (error) {
      await dumpEdges(`FAIL-${label}`);
      throw error;
    }
  };
  const edgeIds = async () => page.evaluate(() => [...document.querySelectorAll(".x6-edge")].map((el) => el.getAttribute("data-cell-id")).filter(Boolean).sort());
  const defaultEdges = await edgeIds();
  const beforeLegacy = await dumpEdges("before-legacy");
  assert.ok(defaultEdges.includes("edge:parent-1"), JSON.stringify(defaultEdges));
  assert.ok(defaultEdges.includes("origin:reply-1"), JSON.stringify(defaultEdges));
  assert.equal(defaultEdges.includes("edge:legacy-1"), false, JSON.stringify(defaultEdges));
  assert.deepEqual(defaultEdges, ["edge:parent-1", "origin:reply-1"], JSON.stringify(beforeLegacy));
  result.assertions.push("default-edge-ids");
  await page.screenshot({ path: path.join(out, "independent-no-legacy-default-1280.png") });

  await page.getByRole("button", { name: "查看全部" }).click();
  await page.waitForFunction(() => {
    const host = document.querySelector(".canvas-graph")?.getBoundingClientRect();
    const title = document.querySelector(".canvas-frame[data-item-id='obj-title'] .rb-block-title");
    if (!host || !title || title.hidden) return false;
    const frame = document.querySelector(".canvas-frame[data-item-id='obj-title']");
    if (frame?.classList.contains("is-active")) return false;
    const s = getComputedStyle(title);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = title.getBoundingClientRect();
    return r.width >= 16 && r.height >= 4 && r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom;
  }, { timeout: 8000 });
  const fitTitle = await dumpProbe("fit-title-visible");
  const titleFrame = fitTitle.frames.find((f) => f.id === "obj-title");
  assert.equal(titleFrame?.active, false);
  assert.equal(titleUserVisible(titleFrame, fitTitle.hostRect, 4), true, JSON.stringify({ titleFrame, hostRect: fitTitle.hostRect }));
  assert.match(titleFrame.title, /只有标题/);
  result.assertions.push("title-only-in-viewport-after-fit");
  await page.screenshot({ path: path.join(out, "title-node-visible-1280.png") });

  await mouseOnCard("obj-title");
  await page.waitForFunction(() => document.querySelector(".canvas-frame[data-item-id='obj-title']")?.classList.contains("is-selected"));
  await page.screenshot({ path: path.join(out, "selected-1280.png") });

  await page.click(".canvas-tool-more summary");
  const legacy = page.locator(".canvas-tool-menu button", { hasText: "显示旧连线" });
  assert.equal(await legacy.count(), 1);
  await legacy.click();
  await waitExactEdges(["edge:legacy-1", "edge:parent-1", "origin:reply-1"], "legacy-on");
  const onEdges = await edgeIds();
  const onEvidence = await dumpEdges("legacy-on");
  assert.deepEqual(onEdges, ["edge:legacy-1", "edge:parent-1", "origin:reply-1"], JSON.stringify(onEvidence));
  assert.equal(onEvidence.duplicateIds.length, 0, JSON.stringify(onEvidence));
  assert.equal(onEvidence.modelSvgMismatch, false, JSON.stringify(onEvidence));
  await page.screenshot({ path: path.join(out, "legacy-edges-on-1280.png") });
  await page.click(".canvas-tool-more summary");
  const hide = page.locator(".canvas-tool-menu button", { hasText: "隐藏旧连线" });
  assert.equal(await hide.count(), 1);
  await hide.click();
  await waitExactEdges(["edge:parent-1", "origin:reply-1"], "legacy-off");
  const offEdges = await edgeIds();
  const offEvidence = await dumpEdges("legacy-off");
  assert.deepEqual(offEdges, ["edge:parent-1", "origin:reply-1"], JSON.stringify(offEvidence));
  assert.equal(offEvidence.duplicateIds.length, 0, JSON.stringify(offEvidence));
  assert.equal(offEvidence.modelSvgMismatch, false, JSON.stringify(offEvidence));
  result.assertions.push("legacy-toggle-ids");
  await writeFile(path.join(art, "edges-toggle-evidence.json"), JSON.stringify({
    before: beforeLegacy,
    on: onEvidence,
    off: offEvidence,
  }, null, 2));

  await page.getByRole("button", { name: "聚焦所选" }).click();
  await page.waitForFunction(() => {
    const host = document.querySelector(".canvas-graph")?.getBoundingClientRect();
    const title = document.querySelector(".canvas-frame[data-item-id='obj-title'] .rb-block-title")?.getBoundingClientRect();
    const frame = document.querySelector(".canvas-frame[data-item-id='obj-title']");
    return Boolean(title && host && !frame?.classList.contains("is-active") && title.height >= 12 && title.width >= 24 && title.right > host.left && title.left < host.right && title.bottom > host.top && title.top < host.bottom);
  }, { timeout: 8000 });
  const located = await dumpProbe("after-locate");
  await page.getByRole("button", { name: "恢复到 100%" }).click();
  await page.waitForFunction(() => (document.querySelector(".canvas-zoom-value")?.textContent ?? "").includes("100%"));
  const at100 = await dumpProbe("after-100");
  result.assertions.push("camera-fit-100-locate");
  result.camera.push({ locatedZoom: located.zoom, at100: at100.zoom });

  await page.getByRole("button", { name: "查看全部" }).click();
  await page.waitForFunction(() => {
    const host = document.querySelector(".canvas-graph")?.getBoundingClientRect();
    const el = document.querySelector(".canvas-frame[data-item-id='obj-title']");
    if (!host || !el) return false;
    const r = el.getBoundingClientRect();
    return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom;
  }, { timeout: 8000 });
  await mouseOnCard("obj-title", "dblclick");
  await page.waitForSelector(".canvas-frame[data-item-id='obj-title'].is-active");
  const editBtn = page.locator(".canvas-frame[data-item-id='obj-title'] button", { hasText: "编辑" });
  assert.ok(await editBtn.count() >= 1);
  await editBtn.click();
  const titleInput = page.locator(".canvas-frame[data-item-id='obj-title'] input").first();
  const bodyArea = page.locator(".canvas-frame[data-item-id='obj-title'] textarea").first();
  await titleInput.waitFor();
  await titleInput.fill("改过的标题");
  await bodyArea.fill("");
  const patchesBefore = nodePatches.length;
  await page.locator(".canvas-frame[data-item-id='obj-title'] button", { hasText: "保存" }).click();
  await until(() => nodePatches.length > patchesBefore, 5000, "node PATCH");
  const patch = nodePatches.at(-1);
  assert.equal(patch.id, "idea-title");
  assert.equal(patch.body.title, "改过的标题");
  assert.equal(patch.body.body, "");
  assert.notEqual(patch.body.body, patch.body.title);
  const patchKeys = Object.keys(patch.body);
  assert.equal(patchKeys.includes("captured_context"), false);
  assert.ok(patchKeys.every((key) => ["title", "body", "object_id", "expected_revision", "request_id"].includes(key)), JSON.stringify(patchKeys));
  const afterNode = board.nodes.find((item) => item.id === "idea-title");
  assert.equal(afterNode.body, "");
  assert.equal(afterNode.kind, "idea");
  assert.equal(afterNode.weight, "note");
  assert.equal(afterNode.captured_context, undefined);
  result.assertions.push("title-body-patch");
  result.camera.push({
    patchKeys,
    backendContextPreservation: "spellcast-core session::add_node_defaults_none_and_capture_helper_keeps_patch_from_clearing_it",
  });

  await page.keyboard.press("Escape");
  const beforePos = await page.evaluate(() => {
    const r = document.querySelector(".canvas-frame[data-item-id='obj-old']").getBoundingClientRect();
    const html = document.querySelector(".canvas-frame[data-item-id='obj-old'] .rb-text")?.textContent ?? "";
    return { x: r.x, y: r.y, html };
  });
  const oldBox = await page.locator(".canvas-frame[data-item-id='obj-old'] .canvas-card-drag").boundingBox();
  assert.ok(oldBox);
  await page.mouse.move(oldBox.x + 40, oldBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(oldBox.x + 120, oldBox.y + 90, { steps: 8 });
  await page.mouse.up();
  const dragged = await until(async () => {
    const r = await page.evaluate(() => {
      const box = document.querySelector(".canvas-frame[data-item-id='obj-old']").getBoundingClientRect();
      return { x: box.x, y: box.y };
    });
    return (Math.abs(r.x - beforePos.x) > 8 || Math.abs(r.y - beforePos.y) > 8) ? r : null;
  }, 4000, "drag moved");

  await mouseOnCard("obj-a", "dblclick");
  await page.waitForSelector(".canvas-frame[data-item-id='obj-a'].is-active");
  await page.locator(".canvas-frame[data-item-id='obj-a'] button", { hasText: "编辑" }).click();
  const draftInput = page.locator(".canvas-frame[data-item-id='obj-a'] input").first();
  await draftInput.fill("未保存草稿标题XYZ");
  const draftText = await draftInput.inputValue();
  assert.equal(draftText, "未保存草稿标题XYZ");

  await page.getByRole("button", { name: "内容总览" }).click();
  await page.waitForSelector("dialog.canvas-overview[open], .canvas-overview[open]");
  await page.selectOption("#canvas-overview-project", "unsorted");
  const afterFilter = await page.evaluate(() => {
    const r = document.querySelector(".canvas-frame[data-item-id='obj-old']").getBoundingClientRect();
    const html = document.querySelector(".canvas-frame[data-item-id='obj-old'] .rb-text")?.textContent ?? "";
    const draft = document.querySelector(".canvas-frame[data-item-id='obj-a'] input")?.value ?? "";
    return { x: r.x, y: r.y, html, draft, hidden: Boolean(document.querySelector("[data-item-id='obj-hidden']")) };
  });
  assert.equal(Math.round(afterFilter.x), Math.round(dragged.x));
  assert.equal(afterFilter.html, beforePos.html);
  assert.equal(afterFilter.draft, "未保存草稿标题XYZ");
  const boardGets = isolation.fulfilled.filter((item) => item.method === "GET" && item.path === "/api/board").length;
  await until(() => isolation.fulfilled.filter((item) => item.method === "GET" && item.path === "/api/board").length > boardGets, 8000, "board refresh while draft open");
  const afterRefresh = await page.evaluate(() => document.querySelector(".canvas-frame[data-item-id='obj-a'] input")?.value ?? "");
  assert.equal(afterRefresh, "未保存草稿标题XYZ");
  await page.keyboard.press("Escape");

  await page.click(".canvas-tool-more summary");
  await page.locator(".canvas-tool-menu button", { hasText: "显示旧连线" }).click();
  const afterLegacy = await page.evaluate(() => {
    const r = document.querySelector(".canvas-frame[data-item-id='obj-old']").getBoundingClientRect();
    const draft = document.querySelector(".canvas-frame[data-item-id='obj-a'] input")?.value ?? "";
    const html = document.querySelector(".canvas-frame[data-item-id='obj-old'] .rb-text")?.textContent ?? "";
    return { x: r.x, y: r.y, draft, html };
  });
  assert.equal(Math.round(afterLegacy.x), Math.round(dragged.x));
  assert.equal(afterLegacy.draft, "未保存草稿标题XYZ");
  assert.equal(afterLegacy.html, beforePos.html);
  await page.click(".canvas-tool-more summary");
  await page.locator(".canvas-tool-menu button", { hasText: "隐藏旧连线" }).click();
  await dumpEdges("legacy-off-after-draft");

  await page.click(".canvas-tool-more summary");
  await page.locator(".canvas-tool-menu button", { hasText: "撤销布局" }).click();
  const undone = await until(async () => {
    const r = await page.evaluate(() => document.querySelector(".canvas-frame[data-item-id='obj-old']").getBoundingClientRect());
    return Math.abs(r.x - beforePos.x) < 30 ? r : null;
  }, 4000, "undo layout");
  await page.click(".canvas-tool-more summary");
  await page.locator(".canvas-tool-menu button", { hasText: "重做布局" }).click();
  await until(async () => {
    const x = await page.evaluate(() => document.querySelector(".canvas-frame[data-item-id='obj-old']").getBoundingClientRect().x);
    return Math.abs(x - dragged.x) < 30;
  }, 4000, "redo layout");
  const hiddenKept = board.canvas.items.find((item) => item.item_id === "obj-hidden");
  assert.equal(hiddenKept.removed, true);
  assert.equal(hiddenKept.user_modified, true);
  const canvasPosts = isolation.mutations.filter((m) => m.path === "/api/canvas");
  for (const post of canvasPosts) {
    const hiddenPatch = (post.body?.items ?? []).find((item) => item.item_id === "obj-hidden");
    assert.equal(hiddenPatch, undefined);
  }
  result.assertions.push("layout-filter-undo-hidden");
  result.camera.push({ beforePos, dragged, undone: { x: undone.x, y: undone.y } });

  await page.evaluate(() => document.querySelector("#feedback-open")?.click());
  await page.waitForSelector("#feedback-dialog[open]");
  const followBg = await page.locator("[data-feedback-view='followup']").evaluate((el) => getComputedStyle(el).backgroundColor);
  const repliedBg = await page.locator("[data-feedback-view='replied']").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(followBg, repliedBg);
  const ideaCards = page.locator(".feedback-card").filter({ hasText: "同名点子" });
  assert.equal(await ideaCards.count(), 1);
  const cardText = await ideaCards.first().innerText();
  assert.match(cardText, /接收任务：周五排期/);
  assert.match(cardText, /接收任务：其他任务/);
  await page.screenshot({ path: path.join(out, "feedback-selected-1280.png") });

  const details = page.locator(".feedback-note details").first();
  assert.ok(await details.count() >= 1);
  await details.locator("summary").click();
  await page.fill("#feedback-search", "请展开");
  await page.evaluate(() => document.querySelector("#feedback-search").setSelectionRange(1, 3, "forward"));
  await page.locator("#feedback-dialog").hover();
  const scroll0 = await page.evaluate(() => document.querySelector("#feedback-dialog").scrollTop);
  await page.mouse.wheel(0, 600);
  const scroll1 = await until(async () => {
    const top = await page.evaluate(() => document.querySelector("#feedback-dialog").scrollTop);
    return top > scroll0 ? top : null;
  }, 3000, "dialog wheel scroll");
  const getsBefore = feedbackGetCount;
  await until(() => feedbackGetCount > getsBefore, 8000, "timed GET increased");
  const sel = await page.evaluate(() => {
    const input = document.querySelector("#feedback-search");
    return { start: input.selectionStart, end: input.selectionEnd, dir: input.selectionDirection, focus: document.activeElement === input, open: document.querySelector(".feedback-note details")?.open, scroll: document.querySelector("#feedback-dialog").scrollTop, value: input.value };
  });
  assert.equal(sel.value, "请展开");
  assert.equal(sel.focus, true);
  assert.equal(sel.start, 1);
  assert.equal(sel.end, 3);
  assert.equal(sel.open, true);
  assert.ok(sel.scroll > 0);
  result.assertions.push("refresh-preserves-real-scroll");
  result.camera.push({ scroll0, scroll1, scrollAfterRefresh: sel.scroll, scrollDelta: sel.scroll - scroll0, scrollRefreshTolerance: Math.abs(sel.scroll - scroll1), getsBefore, getsAfter: feedbackGetCount });
  assert.ok(Math.abs(sel.scroll - scroll1) <= 8, `scroll not preserved: beforeRefresh=${scroll1} after=${sel.scroll}`);

  await page.fill("#feedback-search", "");
  delayFeedbackGet = true;
  await until(() => delayedGets.length > 0, 8000, "in-flight old GET");
  retryMode = "waiting";
  const retryBtn = page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" });
  assert.equal(await retryBtn.count(), 1);
  await retryBtn.click();
  await page.waitForFunction(() => (document.querySelector(".feedback-note[data-seq='8']")?.innerText ?? "").includes("等待接手"));
  while (delayedGets.length) delayedGets.pop()();
  delayFeedbackGet = false;
  assert.match(await page.locator(".feedback-note[data-seq='8']").innerText(), /等待接手/);
  refreshFailOnce = true;
  const getsAtRefreshFail = feedbackGetCount;
  await until(() => feedbackGetCount > getsAtRefreshFail, 8000, "refresh-fail GET");
  assert.match(await page.locator(".feedback-note[data-seq='8']").innerText(), /等待接手/);
  feedback = { ...feedback, deliveries: feedback.deliveries.map((item) => item.event.seq === 8 ? { ...failed8, error: "worker-failed" } : item) };
  const getsAtFail = feedbackGetCount;
  await until(() => feedbackGetCount > getsAtFail, 8000, "worker-failed GET");
  const failedText = await page.locator(".feedback-note[data-seq='8']").innerText();
  assert.match(failedText, /投递失败|worker-failed/);
  assert.equal(await page.locator(".feedback-note[data-seq='8'] button", { hasText: "重试" }).isDisabled(), false);
  result.assertions.push("retry-waiting-then-failed");

  await page.click('[data-feedback-view="replied"]');
  await page.locator(".feedback-note", { hasText: "已得到回复" }).locator("button", { hasText: "查看回复" }).click();
  await page.waitForSelector(".canvas-frame.is-selected");
  assert.equal(await page.evaluate(() => document.querySelector(".canvas-frame.is-selected")?.getAttribute("data-item-id")), "obj-r1");
  await page.evaluate(() => document.querySelector("#feedback-open")?.click());
  await page.waitForSelector("#feedback-dialog[open]");
  await page.click('[data-feedback-view="replied"]');
  await page.locator(".feedback-note", { hasText: "缺失回复" }).locator("button", { hasText: "查看回复" }).click();
  const flash = await page.evaluate(() => document.querySelector("#app-notice")?.textContent ?? document.body.innerText);
  assert.match(flash, /还不在画布上|暂不可用|缺失/);
  assert.equal(await page.evaluate(() => document.querySelector(".canvas-frame.is-selected")?.getAttribute("data-item-id")), "obj-r1");
  result.assertions.push("response-nav-multi-and-missing");

  await page.evaluate(() => document.querySelector("#feedback-open")?.click());
  await page.waitForSelector("#feedback-dialog[open]");
  await page.click('[data-feedback-view="activity"]');
  const activity = await page.locator("#feedback-list").innerText();
  assert.match(activity, /已采纳/);
  assert.equal(activity.includes("你的留言"), false);
  assert.equal(/\bkept\b/.test(activity), false);
  assert.match(activity, /原内容暂不可用/);
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const more = document.querySelector(".top-more");
    if (more instanceof HTMLDetailsElement) more.open = true;
    document.querySelector("#settings-open")?.click();
  });
  await page.waitForSelector("#settings[open]");
  const toggle = page.locator("#settings-observer-enabled");
  await toggle.check();
  await until(async () => page.evaluate(() => document.querySelector("#settings-observer-enabled")?.checked === true), 3000, "settings ON");
  await sleep(220);
  const onStyle = await page.evaluate(() => {
    const input = document.querySelector("#settings-observer-enabled");
    const track = input.nextElementSibling;
    return { checked: input.checked, bg: getComputedStyle(track).backgroundColor, tx: getComputedStyle(track, "::after").transform };
  });
  assert.equal(onStyle.checked, true);
  await page.screenshot({ path: path.join(out, "settings-on-1280.png") });
  await toggle.uncheck();
  await until(async () => page.evaluate(() => document.querySelector("#settings-observer-enabled")?.checked === false), 3000, "settings OFF");
  await sleep(220);
  const offStyle = await page.evaluate(() => {
    const input = document.querySelector("#settings-observer-enabled");
    const track = input.nextElementSibling;
    return { checked: input.checked, bg: getComputedStyle(track).backgroundColor, tx: getComputedStyle(track, "::after").transform };
  });
  assert.equal(offStyle.checked, false);
  assert.notEqual(onStyle.bg, offStyle.bg);
  await page.screenshot({ path: path.join(out, "settings-off-1280.png") });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 880, height: 860 });
  await page.getByRole("button", { name: "查看全部" }).click();
  await page.waitForFunction(() => {
    const host = document.querySelector(".canvas-graph")?.getBoundingClientRect();
    const title = document.querySelector(".canvas-frame[data-item-id='obj-title'] .rb-block-title");
    if (!host || !title || title.hidden) return false;
    const s = getComputedStyle(title);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = title.getBoundingClientRect();
    return r.width >= 16 && r.height >= 4 && r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom;
  }, { timeout: 8000 });
  await mouseOnCard("obj-title");
  await page.screenshot({ path: path.join(out, "title-node-visible-880.png") });
  await page.screenshot({ path: path.join(out, "selected-880.png") });
  await page.evaluate(() => {
    const more = document.querySelector(".top-more");
    if (more instanceof HTMLDetailsElement) more.open = true;
    document.querySelector("#settings-open")?.click();
  });
  await page.waitForSelector("#settings[open]");
  await page.locator("#settings-observer-enabled").check();
  await sleep(220);
  await page.screenshot({ path: path.join(out, "settings-on-880.png") });
  await page.locator("#settings-observer-enabled").uncheck();
  await sleep(220);
  await page.screenshot({ path: path.join(out, "settings-off-880.png") });

  assert.equal(isolation.unexpectedApi.length, 0, JSON.stringify(isolation.unexpectedApi));
  const productionContinue = isolation.continueAllowed.filter((item) => String(item.url).includes("47194"));
  assert.equal(productionContinue.length, 0, JSON.stringify(productionContinue));
  assert.ok(served.hash, "served bundle hash missing");
  assert.equal(served.hash, distInfo.sha256, `served ${served.hash} != dist ${distInfo.sha256} url=${served.url}`);
  assert.notEqual(served.hash, sourceHashes["src/canvas.ts"].sha256, "served bundle must not be source-hashes impersonation");
  result.bundle.served = served;
  result.isolationSummary = {
    fulfilled: isolation.fulfilled.length,
    unexpectedApi: isolation.unexpectedApi.length,
    abortedThirdParty: isolation.abortedThirdParty.length,
    continueAllowed: isolation.continueAllowed.length,
    mutations: isolation.mutations.length,
    feedbackGetCount,
  };
  await writeFile(path.join(art, "isolation-round2.json"), JSON.stringify(isolation, null, 2));
  await writeFile(path.join(art, "run-round2.json"), JSON.stringify({ result, previewOut: previewOut.slice(-4000) }, null, 2));
  await writeFile(path.join(art, "bundle-served-round2.json"), JSON.stringify({ dist: distInfo, served }, null, 2));
  await browser.close();
} finally {
  await browser?.close();
  preview.kill();
  await writeFile(path.join(art, "preview-round2.log"), previewOut);
}
console.log("canvas-feedback checks ok", result.assertions.join(","));
