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
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "artifacts/spellcast-canvas-cleanup");
await mkdir(out, { recursive: true });
const port = Number(process.env.SPELLCAST_PREVIEW_PORT ?? 47299);
assert.notEqual(port, 47194);
const origin = `http://127.0.0.1:${port}`;
const sourceOrigin = { cwd: "G:/isolated/cleanup", source_id: "fixture-task", thread_id: "11111111-1111-4111-8111-111111111111", label: "隔离整理任务" };
const duplicate = "完整重复正文第一段。\n" + "保持完整正文并验证合并预览。".repeat(22) + "\n重复正文末尾标记 DUPLICATE-END";
const manualA = "手动合并第一份原文\n" + "第一份独立文字内容。".repeat(20) + "\nMANUAL-A-END";
const manualB = "手动合并第二份原文\n" + "第二份不同原文，保留每一段。".repeat(20) + "\nMANUAL-B-END";
const specs = [
  ["handled", "已处理卡片", "已经处理的原文"], ["responded", "已回复卡片", "回复完成但尚未确认"],
  ["locked", "锁定卡片", "锁定原文"], ["pending", "待办卡片", "待办原文"],
  ["duplicate-a", "重复甲", duplicate], ["duplicate-b", "重复乙", duplicate],
  ["manual-a", "手动甲", manualA], ["manual-b", "手动乙", manualB],
  ["other", "其他工作区", duplicate],
];
function initialBoard() {
  return { topic: "cleanup-fixture", form: "spatial", form_reason: "", nodes: [], replies: [], edges: [], messages: [], canvas: {
    revision: 10, objects: specs.map(([id, title, text]) => ({ id, content_revision: 1, content: { type: "text", title, text },
      origin: id === "other" ? { ...sourceOrigin, cwd: "G:/isolated/other", source_id: "other-task", thread_id: "22222222-2222-4222-8222-222222222222" } : sourceOrigin })),
    items: specs.map(([id], i) => ({ item_id: id, revision: 1, x: 40 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 200, width: 230, height: 160, z: i, appearance: "card", removed: false, delete_locked: id === "locked" })),
    annotations: [], compositions: [], proposals: [],
  } };
}
const event = (seq, id) => ({ seq, at_ms: 1700000000000 + seq, kind: "say", text: `fixture ${id}`, object_id: id, object_revision: 1, source_id: "fixture-task" });
const feedback = { pending: [event(4, "pending")], deliveries: [
  { event: event(1, "handled"), phase: "handled" }, { event: event(2, "responded"), phase: "responded" },
  { event: event(3, "locked"), phase: "handled" }, { event: event(4, "pending"), phase: "waiting" },
], bindings: [ { ...sourceOrigin, bound_at_ms: 1, protocol_agent: "codex" } ] };
const health = { surface: "focus", port, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
const expectedFeedback = { pending: [4], deliveries: [{ sequence: 1, phase: "handled" }, { sequence: 2, phase: "responded" }, { sequence: 3, phase: "handled" }, { sequence: 4, phase: "waiting" }] };
const report = { fixtureBoundary: "Every /api/ request and every port-47194 request is intercepted. Only local Vite assets pass through. Organize is an in-memory version/guard checked fixture, not the Rust server.", screenshots: [], checks: [], errors: [], network: [], mutations: [], layout: [] };
let board = initialBoard(), loseNextResponse = false;
const requests = new Map();
const clone = value => structuredClone(value);

function organize(body) {
  assert.equal(typeof body.batch?.request_id, "string");
  const existing = requests.get(body.batch.request_id);
  if (existing) { assert.deepEqual(body, existing.request, "retry changed its payload"); return { ...clone(existing.response), board: clone(board) }; }
  assert.equal(body.expected_canvas_revision, board.canvas.revision, "canvas guard");
  assert.deepEqual(body.expected_feedback, expectedFeedback, "feedback guard");
  const reads = new Map();
  for (const read of body.batch.reads) {
    const current = read.kind === "content" ? board.canvas.objects.find(object => object.id === read.id)?.content_revision
      : read.kind === "presentation" ? board.canvas.items.find(item => item.item_id === read.id)?.revision
        : board.canvas.annotations.find(annotation => annotation.id === read.id)?.revision;
    assert.equal(read.revision, current, `read revision ${read.kind}:${read.id}`);
    reads.set(`${read.kind}:${read.id}`, read);
  }
  const next = clone(board);
  for (const operation of body.batch.operations) {
    if (operation.op === "place") {
      const item = next.canvas.items.find(item => item.item_id === operation.id);
      assert.ok(item, `place target ${operation.id}`);
      assert.equal(operation.expected_revision, item.revision);
      assert.ok(reads.has(`content:${operation.id}`)); assert.ok(reads.has(`presentation:${operation.id}`));
      assert.deepEqual(Object.keys(operation.fields), ["removed"]);
      assert.equal(typeof operation.fields.removed, "boolean");
      assert.equal(item.delete_locked, false);
      assert.notEqual(operation.id, "pending");
      Object.assign(item, operation.fields); item.revision++;
    } else {
      assert.equal(operation.op, "create"); assert.equal(operation.content.type, "text");
      assert.deepEqual(operation.origin, sourceOrigin);
      assert.equal(next.canvas.objects.some(object => object.id === operation.id), false);
      next.canvas.objects.push({ id: operation.id, content_revision: 1, content: operation.content, origin: operation.origin });
      next.canvas.items.push({ item_id: operation.id, revision: 1, delete_locked: false, ...operation.placement });
    }
  }
  next.canvas.revision++;
  board = next;
  const response = { board: clone(board), result: { status: "applied", request_id: body.batch.request_id, targets: [] } };
  requests.set(body.batch.request_id, { request: clone(body), response: clone(response) });
  return response;
}

async function attachIsolation(context) {
  await context.route("**/*", async (route, request) => {
    const url = new URL(request.url()), method = request.method();
    if (url.pathname.startsWith("/api/") || url.port === "47194") {
      report.network.push({ method, url: request.url(), target: "fixture" });
      const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type" };
      const fulfill = body => route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
      try {
        if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (method === "GET") {
          const values = { "/api/board": board, "/api/feedback": feedback, "/api/health": health, "/api/events": { events: [], last_seq: 0 },
            "/api/forms": { forms: [{ id: "spatial", label: "空间", blurb: "" }] }, "/api/memories": { memories: [] },
            "/api/observer/status": { enabled: false, paused: false, allowed: true, reason: "fixture", policy_revision: 1 } };
          assert.ok(Object.hasOwn(values, url.pathname), `unhandled GET ${url.pathname}`);
          return fulfill(values[url.pathname]);
        }
        const body = request.postDataJSON();
        report.mutations.push({ path: url.pathname, body, target: "fixture" });
        assert.equal(method, "POST");
        if (url.pathname === "/api/surface") return fulfill({ ...health, surface: body.surface });
        if (url.pathname === "/api/task-target") {
          assert.deepEqual(body, { source_id: sourceOrigin.source_id, thread_id: sourceOrigin.thread_id, cwd: sourceOrigin.cwd });
          return fulfill({ source_id: sourceOrigin.source_id, thread_id: sourceOrigin.thread_id, label: sourceOrigin.label,
            status: "available", message: "isolated fixture", checked_at_ms: 1700000000000 });
        }
        assert.equal(url.pathname, "/api/canvas/organize", `unexpected mutation ${url.pathname}`);
        const response = organize(body);
        if (loseNextResponse) { loseNextResponse = false; return route.abort("failed"); }
        return fulfill(response);
      } catch (error) {
        report.errors.push(`fixture: ${error.stack}`);
        return route.fulfill({ status: 500, headers, contentType: "application/json", body: JSON.stringify({ error: String(error) }) });
      }
    }
    if (url.origin === origin) { report.network.push({ method, url: request.url(), target: "vite" }); return route.continue(); }
    report.errors.push(`unexpected network ${method} ${request.url()}`);
    return route.abort("blockedbyclient");
  });
}
async function waitHttp() {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(800) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Vite did not start");
}
async function launch() {
  for (const channel of ["chrome", "msedge"]) { try { return await playwright.chromium.launch({ channel, headless: true }); } catch {} }
  return playwright.chromium.launch({ headless: true });
}
const preview = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "pipe", windowsHide: true });
let previewLog = "", browser;
preview.stdout.on("data", data => { previewLog += data; }); preview.stderr.on("data", data => { previewLog += data; });
try {
  await waitHttp(); browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("spellcast.locale", "zh-CN"); localStorage.setItem("spellcast.mode", "focus"); localStorage.setItem("spellcast.theme", "dark");
    localStorage.setItem("spellcast.canvas-scope", JSON.stringify({ workspace: "workspace:g:/isolated/cleanup", task: "all" }));
  });
  await attachIsolation(context);
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(`page: ${error.stack}`));
  const dialog = page.locator("#canvas-cleanup-dialog");
  const button = name => dialog.getByRole("button", { name, exact: true });
  const row = id => dialog.locator(`[data-cleanup-item="${id}"]`);
  const checkbox = id => row(id).locator('input[type="checkbox"]');
  const open = async () => { await page.locator(".canvas-cleanup-open").click(); await dialog.waitFor({ state: "visible" }); await button("重新分析").waitFor({ state: "visible" }); await page.waitForFunction(() => !document.querySelector('#canvas-cleanup-dialog .cleanup-icon[aria-label="重新分析"]')?.disabled); };
  const close = async () => { await button("关闭").click(); };
  async function focusCard(id) {
    await page.getByRole("button", { name: "内容总览", exact: true }).click();
    await page.locator(`.canvas-overview-card[data-item-id="${id}"]`).getByRole("button", { name: "定位", exact: true }).click();
  }
  async function editNativeDraft(id, text) {
    await focusCard(id);
    const frame = page.locator(`.canvas-frame[data-item-id="${id}"]`);
    await frame.locator(".canvas-frame-head button").first().click();
    await frame.locator(".canvas-native-actions button").click();
    const editor = page.locator(".canvas-native-editor[open]");
    await editor.locator("textarea.canvas-native-text").fill(text);
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "hidden" });
  }
  async function screenshot(name, width, height, theme) {
    await page.setViewportSize({ width, height });
    await page.evaluate(value => {
      const select = document.querySelector("[data-theme-select]");
      if (!(select instanceof HTMLSelectElement)) throw new Error("theme control missing");
      select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
    }, theme);
    assert.equal(await page.locator("body").getAttribute("data-theme"), theme);
    const layout = await dialog.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const buttons = [...node.querySelectorAll("button")].filter(button => button.getClientRects().length).map(button => {
        const bounds = button.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(button); const text = range.getBoundingClientRect();
        return { label: button.getAttribute("aria-label") || button.textContent, overflow: button.scrollWidth > button.clientWidth + 1 || text.right > bounds.right + 1 || text.left < bounds.left - 1 };
      });
      return { dialog: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, horizontalOverflow: node.scrollWidth > node.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1, buttons };
    });
    report.layout.push({ name, width, height, theme, ...layout });
    assert.equal(layout.horizontalOverflow, false, `horizontal overflow ${name}`);
    assert.deepEqual(layout.buttons.filter(button => button.overflow), [], `button text overflow ${name}`);
    assert.ok(layout.dialog.left >= 0 && layout.dialog.right <= width + 1 && layout.dialog.top >= 0 && layout.dialog.bottom <= height + 1);
    const filename = path.join(out, name + ".png"); await page.screenshot({ path: filename, animations: "disabled" }); report.screenshots.push(filename);
  }
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(".canvas-cleanup-open").waitFor({ state: "visible" });
  assert.equal(await page.locator(".canvas-frame").count(), 9, "actual main canvas mounted");
  await open();
  assert.equal(await checkbox("handled").isChecked(), true);
  assert.equal(await checkbox("responded").isChecked(), false);
  assert.equal(await checkbox("locked").isDisabled(), true);
  await dialog.locator('[data-cleanup-tab="all"]').click();
  assert.equal(await checkbox("pending").isDisabled(), true);
  assert.equal(await row("other").count(), 0, "current workspace scope isolation");
  await dialog.locator('[data-cleanup-tab="suggestions"]').click();
  const duplicateGroup = dialog.locator('[data-cleanup-group="cleanup:duplicate-a,duplicate-b"]');
  assert.equal(await duplicateGroup.count(), 1);
  await duplicateGroup.locator("details[data-merge-preview] > summary").click();
  assert.ok((await duplicateGroup.locator(".cleanup-merged").innerText()).includes(duplicate));
  assert.equal((await duplicateGroup.locator(".cleanup-merged").innerText()).split("DUPLICATE-END").length - 1, 1);
  report.checks.push("main canvas mounts; handled preselected; responded not preselected; locked/pending blocked; same-context exact candidate and full preview; current view isolation");
  await screenshot("suggestions-dark-1280", 1280, 900, "dark");
  await close();
  await editNativeDraft("manual-a", manualA + "\nUNSAVED-DRAFT");
  await focusCard("responded");
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem("spellcast.canvas-native-drafts.v1") || "{}")["manual-a"]), "draft safely persisted locally");
  await open(); await dialog.locator('[data-cleanup-tab="all"]').click();
  assert.equal(await checkbox("manual-a").isDisabled(), true);
  assert.match(await row("manual-a").innerText(), /草稿/);
  await close(); await editNativeDraft("manual-a", manualA);
  await focusCard("responded");
  assert.equal(await page.evaluate(() => Object.hasOwn(JSON.parse(localStorage.getItem("spellcast.canvas-native-drafts.v1") || "{}"), "manual-a")), false);
  await open();
  report.checks.push("persisted native text draft remains protected after selecting another card; restoring original text clears the draft without server mutation");
  await button("清空选择").click(); await dialog.locator('[data-cleanup-tab="all"]').click();
  await checkbox("manual-a").check(); await checkbox("manual-b").check(); await button("合并勾选内容").click();
  assert.equal(await dialog.locator('[data-cleanup-tab="suggestions"]').getAttribute("aria-selected"), "true");
  const manualGroup = dialog.locator('[data-cleanup-group="cleanup:manual-a,manual-b"]');
  const mergedText = await manualGroup.locator(".cleanup-merged").innerText();
  assert.ok(mergedText.includes(manualA)); assert.ok(mergedText.includes(manualB));
  assert.equal(await manualGroup.locator("details[data-merge-preview]").getAttribute("open"), "");
  await screenshot("manual-merge-light-390", 390, 844, "light");
  await screenshot("manual-merge-dark-880", 880, 640, "dark");
  await page.setViewportSize({ width: 1280, height: 900 });
  await button("应用整理").click(); await page.waitForFunction(() => document.querySelector(".cleanup-notice")?.textContent?.includes("已整理 2"));
  const created = board.canvas.objects.find(object => object.id.startsWith("text-"));
  assert.ok(created); assert.equal(created.content.text, mergedText);
  for (const id of ["manual-a", "manual-b"]) assert.equal(board.canvas.items.find(item => item.item_id === id).removed, true);
  assert.equal(await page.locator(`.canvas-frame[data-item-id="${created.id}"]`).count(), 1);
  await close(); await editNativeDraft(created.id, mergedText + "\nUNSAVED-MERGED-DRAFT");
  await focusCard("responded");
  await open();
  const requestsBeforeBlockedUndo = report.mutations.filter(entry => entry.path === "/api/canvas/organize").length;
  await button("撤销本次整理").click();
  await page.waitForFunction(() => document.querySelector(".cleanup-notice")?.textContent?.includes("无法直接撤销"));
  assert.equal(report.mutations.filter(entry => entry.path === "/api/canvas/organize").length, requestsBeforeBlockedUndo);
  assert.equal(board.canvas.items.find(item => item.item_id === created.id).removed, false);
  await close(); await editNativeDraft(created.id, mergedText);
  await focusCard("responded"); await open();
  await button("撤销本次整理").click(); await page.waitForFunction(() => document.querySelector(".cleanup-notice")?.textContent?.includes("已恢复"));
  for (const id of ["manual-a", "manual-b"]) assert.equal(board.canvas.items.find(item => item.item_id === id).removed, false);
  assert.equal(board.canvas.items.find(item => item.item_id === created.id).removed, true);
  assert.equal(await page.locator(`.canvas-frame[data-item-id="${created.id}"]`).count(), 0);
  report.checks.push("manual merge returns to suggestions with complete distinct originals; guarded organize soft-removes sources and shows merged card; merged-card draft blocks undo before POST; clearing draft permits undo to restore sources and hide merged card");
  await button("重新分析").click(); await checkbox("handled").waitFor();
  board.canvas.revision++;
  await page.waitForFunction(() => document.querySelector(".cleanup-notice")?.textContent?.includes("请重新分析"), null, { timeout: 7000 });
  assert.equal(await button("应用整理").isDisabled(), true);
  await button("重新分析").click(); await page.waitForFunction(() => !document.querySelector(".canvas-cleanup footer .primary")?.disabled);
  report.checks.push("live canvas revision change disables apply; Analyze again restores valid selection");
  await button("清空选择").click();
  await duplicateGroup.locator('input[type="checkbox"]').check();
  loseNextResponse = true;
  await button("应用整理").click(); await button("重试保存").waitFor();
  const firstAttempt = report.mutations.filter(entry => entry.path === "/api/canvas/organize").at(-1).body;
  await button("重试保存").click(); await page.waitForFunction(() => document.querySelector(".cleanup-notice")?.textContent?.includes("已整理 2"));
  const retry = report.mutations.filter(entry => entry.path === "/api/canvas/organize").at(-1).body;
  assert.deepEqual(retry, firstAttempt);
  assert.equal(board.canvas.objects.filter(object => object.id === firstAttempt.batch.operations.find(operation => operation.op === "create").id).length, 1);
  report.checks.push("lost successful response retries the exact request ID/payload and creates only one card");
  await close();
  await page.getByRole("button", { name: "层级", exact: true }).click();
  const layers = page.locator(".canvas-layers[open]");
  await layers.locator('[data-item-id="manual-a"] button').click();
  await layers.locator('[data-item-id="manual-b"] button').click({ modifiers: ["Shift"] });
  assert.equal(await layers.locator('[data-item-id="manual-a"] button').getAttribute("aria-pressed"), "true");
  assert.equal(await layers.locator('[data-item-id="manual-b"] button').getAttribute("aria-pressed"), "true");
  await layers.getByRole("button", { name: "关闭", exact: true }).click();
  await open();
  assert.equal(await dialog.locator("#cleanup-scope").inputValue(), "selection");
  await dialog.locator('[data-cleanup-tab="all"]').click();
  assert.deepEqual((await dialog.locator("[data-cleanup-item]").evaluateAll(nodes => nodes.map(node => node.dataset.cleanupItem))).sort(), ["manual-a", "manual-b"]);
  report.checks.push("selected-content scope includes only the two actual canvas selections");
  await screenshot("selection-light-1280", 1280, 900, "light");
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  console.log(JSON.stringify({ status: report.status, checks: report.checks, screenshots: report.screenshots }, null, 2));
} catch (error) {
  report.status = "failed"; report.failure = error.stack; console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (preview.exitCode === null && preview.signalCode === null) {
    const stopped = new Promise(resolve => preview.once("exit", resolve));
    preview.kill();
    await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error("Vite process did not exit after cleanup")), 5000))]);
  }
  await writeFile(path.join(out, "results.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, "vite.log"), previewLog);
}
