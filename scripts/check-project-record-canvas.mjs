/** Real browser input against an isolated live-record Canvas fixture. Never touches the user's board. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const url = process.env.SPELLCAST_TEST_URL ?? "http://127.0.0.1:47199/project-record-canvas-fixture";
const browser = await playwright.chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
page.setDefaultTimeout(10000);
const errors = []; page.on("pageerror", error => errors.push(error.message));
let delayMs = 0, responseStatus = 200;
let record = { id: "record-1", project_id: "project-1", title: "Initial record", status: "active", result: "First result", boundaries: "First boundary", revision: 1, archived: false };

try {
  await page.route(url, route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/board-workspace.css"><style>:root{--paper:#f4f1ea;--mute:#aeb3c6;--line:#50556a;--line-strong:#8189a0;--lilac:#d4b3ff;--mint:#8bd8c5;--warn:#e1a864;--font:Arial,sans-serif}html,body,#host{width:100%;height:100%;margin:0}body{background:#0c0e14;color:#f4f1ea}</style></head><body><div id="host"></div></body></html>' }));
  await page.route("http://127.0.0.1:47194/api/projects/project-1/records/record-1", async route => {
    const body = JSON.stringify(record), status = responseStatus, wait = delayMs;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    await route.fulfill({ status, contentType: "application/json", body: status === 200 ? body : JSON.stringify({ error: "missing" }) });
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(async () => {
    const { mountCanvas } = await import("/src/canvas.ts");
    const { setLocale } = await import("/src/i18n/index.ts");
    await import("/src/fonts.css"); await import("/src/canvas-studio.css"); await import("/src/theme.css"); setLocale("zh-CN");
    document.body.classList.add("mode-focus", "view-replies"); document.body.dataset.theme = "dark";
    const snapshot = { topic: "", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [], replies: [], canvas: {
      revision: 1, compositions: [], annotations: [], proposals: [],
      objects: [{ id: "work-project-1-record-1", content_revision: 1, content: { type: "work_record", project_id: "project-1", record_id: "record-1" } }],
      items: [{ item_id: "work-project-1-record-1", revision: 1, z: 0, removed: false, appearance: "card", x: 140, y: 120, width: 480, height: 300 }],
    } };
    const unexpected = async () => { throw Error("Unexpected fixture write"); };
    const handlers = { onSelect() {}, onReload: async () => snapshot, onLayout: unexpected, onDelete: unexpected, onDeleteLock: unexpected,
      onRestore: unexpected, onBatch: unexpected, onProposal: unexpected, onAction: unexpected, onPatch: unexpected,
      onCreate: unexpected, onNodePatch: unexpected, onNodeAsk: unexpected, onBlockAction: unexpected, onRestoreComposer() {}, onError(error) { throw Error(String(error)); } };
    const canvas = mountCanvas(document.getElementById("host"), handlers); canvas.update(snapshot);
    window.recordFixture = { canvas, snapshot, opens: [] };
    window.addEventListener("spellcast:open-project-record", event => window.recordFixture.opens.push(event.detail));
  });

  const card = page.locator('.canvas-frame[data-item-id="work-project-1-record-1"]');
  try { await card.waitFor(); }
  catch (error) { throw new Error(`Canvas fixture did not mount: ${errors.join(" | ")}\n${await page.locator("body").innerText()}`, { cause: error }); }
  await page.waitForFunction(() => document.querySelector(".canvas-work-record-title")?.textContent === "Initial record");
  assert.equal(await card.locator(".canvas-work-record-status").textContent(), "进行中");
  assert.equal(await card.locator(".canvas-work-record-value").first().textContent(), "First result");
  assert.match(await card.locator(".canvas-work-record-meta").textContent(), /当前.*版本 1/);

  delayMs = 180;
  record = { ...record, title: "Second record", result: "Second result", revision: 2 };
  await page.evaluate(() => window.recordFixture.canvas.update(window.recordFixture.snapshot));
  await page.waitForTimeout(40);
  assert.equal(await card.locator(".canvas-work-record-title").textContent(), "Initial record", "A refresh must keep the last ready record visible.");
  record = { ...record, title: "Latest record", result: "Latest result", boundaries: "Latest boundary", revision: 3, archived: true };
  await page.evaluate(() => { window.recordFixture.canvas.update(window.recordFixture.snapshot); window.recordFixture.canvas.update(window.recordFixture.snapshot); });
  delayMs = 0;
  await page.waitForFunction(() => document.querySelector(".canvas-work-record-title")?.textContent === "Latest record");
  assert.equal(await page.evaluate(() => window.recordFixture.snapshot.canvas.objects[0].content_revision), 1, "Live record refresh must not mutate Canvas content revision.");
  assert.equal(await card.locator(".canvas-work-record-value").first().textContent(), "Latest result");
  assert.equal(await card.locator(".canvas-work-record-value").nth(1).textContent(), "Latest boundary");
  assert.match(await card.locator(".canvas-work-record-meta").textContent(), /已归档.*版本 3/);

  await card.dblclick({ position: { x: 220, y: 150 } });
  await page.locator(".canvas-graph").focus(); await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.recordFixture.opens), [
    { projectId: "project-1", recordId: "record-1" }, { projectId: "project-1", recordId: "record-1" },
  ]);

  responseStatus = 404; await page.evaluate(() => window.recordFixture.canvas.update(window.recordFixture.snapshot));
  await page.waitForFunction(() => document.querySelector(".canvas-work-record")?.dataset.state === "unavailable");
  assert.match(await card.locator(".canvas-work-record-title").textContent(), /不可用/);
  assert.equal(await card.locator(".canvas-work-record-value").first().textContent(), "—");
  assert.deepEqual(errors, []);
  console.log("PASS: live record refresh without Canvas revision change, queued overlap, localized current/unavailable states, archived revision, and double-click/Enter open events.");
} finally { await browser.close(); }
