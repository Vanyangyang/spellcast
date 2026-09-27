import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runPlanningChecks } from "./check-project-planning.mjs";
import { runFlowChecks } from "./check-game-flow-workspace.mjs";
import { runWorkbenchChecks } from "./check-game-workbench-trials.mjs";
import { createEvidenceFixture } from "./check-workbench-fixture.mjs";
import { runContentChecks } from "./check-game-content-workspace.mjs";
import { openView } from "./check-workspace-nav.mjs";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = path.join(root, "artifacts", "project-record-workspace", "ui");
const port = Number(process.env.SPELLCAST_PROJECT_TEST_PORT ?? 47307);
const origin = `http://127.0.0.1:${port}`;
const apiOrigin = "http://127.0.0.1:47194";

const board = {
  topic: "project-record-fixture", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [], replies: [],
  canvas: { revision: 1, objects: [], items: [] },
};
const health = { surface: "ambient", port: 47194, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
const projects = new Map();
const objects = new Map();
const records = new Map();
const history = new Map();
const access = new Map();
let now = 1_700_000_000_000;

const values = (map, projectId) => [...map.values()].filter((item) => item.project_id === projectId);
const recordKey = (projectId, id) => `${projectId}:${id}`;
const json = (route, value, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  headers: { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" },
  body: JSON.stringify(value),
});
const actor = { kind: "user", label: "Fixture user" };
// Candidates, immutable trials and adoptions for the linked-trial workbench (isolated fixture data).
const evidence = createEvidenceFixture({ objects, history, recordKey, writeHistory, actor, tick: () => now++ });

function writeHistory(record, operation, requestId, kind = "record") {
  const key = recordKey(record.project_id, record.id);
  const rows = history.get(key) ?? [];
  rows.unshift({ project_id: record.project_id, kind, id: record.id, revision: record.revision, at_ms: record.updated_at_ms ?? now++, actor, operation, request_id: requestId, snapshot: structuredClone(record) });
  history.set(key, rows);
}

function putRecord(command) {
  const key = recordKey(command.project_id, command.id);
  const current = records.get(key);
  assert.equal(command.expected_revision, current?.revision ?? 0);
  const record = {
    ...(current ?? { id: command.id, project_id: command.project_id, created_at_ms: now++ }),
    ...command.fields,
    revision: (current?.revision ?? 0) + 1,
    archived: current?.archived ?? false,
    updated_at_ms: now++,
    updated_by: actor,
  };
  records.set(key, record);
  writeHistory(record, current ? "put_record" : "create_record", command.request_id);
  return record;
}

function mutate(command) {
  if (command.op === "create_project") {
    const project = { id: command.project_id, name: command.name, aliases: command.aliases, revision: 1, archived: false, created_at_ms: now++, updated_at_ms: now++ };
    projects.set(project.id, project);
    access.set(project.id, [{ id: `access-${project.id}`, project_id: project.id, source_id: "verified-source", thread_id: "11111111-1111-4111-8111-111111111111", cwd: "G:/fixture", label: "Verified fixture task", state: "pending", revision: 1, created_at_ms: now++, expires_at_ms: now + 86_400_000 }]);
    return { project, replayed: false };
  }
  if (command.op === "update_project") {
    const current = projects.get(command.project_id); assert.equal(command.expected_revision, current.revision);
    const project = { ...current, name: command.name, aliases: command.aliases, archived: command.archived, revision: current.revision + 1, updated_at_ms: now++ };
    projects.set(project.id, project); return { project, replayed: false };
  }
  if (command.op === "put_object") {
    const current = objects.get(command.id); assert.equal(command.expected_revision, current?.revision ?? 0);
    assert.ok(!current?.planning?.locked, "object is locked");
    const object = { id: command.id, project_id: command.project_id, name: command.name, kind: command.kind, archived: command.archived, revision: (current?.revision ?? 0) + 1, ...(command.planning || current?.planning ? {planning:command.planning || current.planning}: {}) };
    objects.set(object.id, object); writeHistory(object, "put_object", command.request_id, "object"); return { object, replayed: false };
  }
  if (command.op === "restore_object") {
    const current = objects.get(command.id); assert.equal(command.expected_revision, current.revision);
    assert.ok(!current.planning?.locked, "object is locked");
    const prior = history.get(recordKey(command.project_id,command.id)).find(row=>row.revision===command.restore_revision);
    const object = {...structuredClone(prior.snapshot),revision:current.revision+1}; objects.set(object.id,object);
    writeHistory(object,"restore_object",command.request_id,"object");return {object,replayed:false};
  }
  if (command.op === "set_object_lock") {
    const current=objects.get(command.id);assert.equal(command.expected_revision,current.revision);assert.ok(current.planning);
    const object={...current,revision:current.revision+1,planning:{...current.planning,locked:command.locked}};
    objects.set(object.id,object);writeHistory(object,"set_object_lock",command.request_id,"object");return {object,replayed:false};
  }
  if (command.op === "put_record") return { record: putRecord(command), replayed: false };
  if (command.op === "archive_record") {
    const current = records.get(recordKey(command.project_id, command.id)); assert.equal(command.expected_revision, current.revision);
    const record = { ...current, archived: command.archived, revision: current.revision + 1, updated_at_ms: now++, updated_by: actor };
    records.set(recordKey(command.project_id, command.id), record); writeHistory(record, "archive_record", command.request_id); return { record, replayed: false };
  }
  if (command.op === "restore_record") {
    const current = records.get(recordKey(command.project_id, command.id)); assert.equal(command.expected_revision, current.revision);
    const prior = (history.get(recordKey(command.project_id, command.id)) ?? []).find((item) => item.revision === command.restore_revision);
    assert.ok(prior);
    const record = { ...prior.snapshot, revision: current.revision + 1, updated_at_ms: now++, updated_by: actor };
    records.set(recordKey(command.project_id, command.id), record); writeHistory(record, "restore_record", command.request_id); return { record, replayed: false };
  }
  if (command.op === "import_project") return { project: projects.get(command.project_id), replayed: false };
  const handled = evidence.mutate(command);
  if (handled) return handled;
  throw new Error(`unexpected command ${command.op}`);
}

function fixtureExport(projectId) {
  const project = projects.get(projectId);
  const bundle = { format: "spellcast.project", version: 1, exported_at_ms: now++, project, objects: values(objects, projectId), records: values(records, projectId), history: values(records, projectId).flatMap((record) => history.get(recordKey(projectId, record.id)) ?? []), external_files: [] };
  const candidates = values(evidence.candidates, projectId), trials = values(evidence.trials, projectId), adoptions = values(evidence.adoptions, projectId);
  const withEvidence = candidates.length || trials.length || adoptions.length ? { ...bundle, version: 3, candidates, trials, adoptions } : bundle;
  return bundle.objects.some(o => o.planning?.sections !== undefined) ? { ...withEvidence, version: 4 } : withEvidence;
}

async function launch() {
  for (const channel of ["chrome", "msedge"]) {
    try { return await playwright.chromium.launch({ channel, headless: true }); } catch {}
  }
  return playwright.chromium.launch({ headless: true });
}

async function waitHttp(url, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  throw new Error(`preview not ready: ${url}`);
}

async function routeApi(route, request) {
  const parsed = new URL(request.url());
  const method = request.method();
  const pathName = parsed.pathname;
  if (method === "OPTIONS") return json(route, {}, 204);
  if (method === "POST" && pathName.startsWith("/api/projects") && request.headers()["x-spellcast-window"] !== "fixture-key") return json(route, { error: "missing fixture window key" }, 403);
  if (method === "GET" && pathName === "/api/board") return json(route, board);
  if (method === "GET" && pathName === "/api/forms") return json(route, { forms: [{ id: "spatial", label: "Spatial", blurb: "" }] });
  if (method === "GET" && pathName === "/api/health") return json(route, health);
  if (method === "GET" && pathName === "/api/events") return json(route, { events: [], last_seq: 0 });
  if (method === "GET" && pathName === "/api/feedback") return json(route, { pending: [], deliveries: [], bindings: [] });
  if (method === "GET" && pathName === "/api/memories") return json(route, { memories: [] });
  if (method === "GET" && pathName === "/api/observer/status") return json(route, { enabled: false, paused: false, allowed: true, reason: "fixture", policy_revision: 1 });
  if (method === "POST" && pathName === "/api/surface") return json(route, health);
  if (method === "GET" && pathName === "/api/projects") return json(route, [...projects.values()]);
  if (method === "POST" && pathName === "/api/projects/command") {
    try { return json(route, mutate(request.postDataJSON())); }
    catch (error) { return json(route, { error: String(error) }, 400); }
  }
  const parts = pathName.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "projects") {
    const projectId = decodeURIComponent(parts[2] || "");
    // The game home may ask whether a repository is connected; planning must never read game configuration.
    if (parts[3] === "game" && method === "GET" && parts[4] === "connection") return json(route, { connection: null });
    if (parts[3] === "game") throw new Error("Planning must not request old game configuration");
    if (method === "GET" && (parts[3] === "goals" || parts[3] === "proposals")) return json(route, []);
    const evidenceResponse = evidence.route(method, parts, parsed);
    if (evidenceResponse !== undefined) return json(route, evidenceResponse);
    if (method === "GET" && parts[3] === "objects") return json(route, values(objects, projectId));
    if (method === "GET" && parts[3] === "records" && !parts[4]) {
      let rows = values(records, projectId);
      if (parsed.searchParams.get("archived") !== "true") rows = rows.filter((record) => !record.archived);
      const status = parsed.searchParams.get("status"); if (status) rows = rows.filter((record) => record.status === status);
      const query = parsed.searchParams.get("query")?.toLowerCase(); if (query) rows = rows.filter((record) => [record.title, record.goal, record.result, record.boundaries, record.next_step].some((value) => String(value || "").toLowerCase().includes(query)));
      return json(route, rows);
    }
    if (method === "GET" && parts[3] === "records" && parts[4]) return json(route, records.get(recordKey(projectId, decodeURIComponent(parts[4]))));
    if (method === "GET" && parts[3] === "history") return json(route, history.get(recordKey(projectId, decodeURIComponent(parts[5]))) ?? []);
    if (method === "GET" && parts[3] === "export") return json(route, fixtureExport(projectId));
    if (method === "GET" && parts[3] === "markdown") return json(route, { markdown: `# ${projects.get(projectId)?.name || "Project"}\n\nExternal originals are not included.` });
    if (method === "POST" && parts[3] === "pin") {
      const body = request.postDataJSON();
      const id = `work-${projectId}-${body.record_id}`;
      if (!board.canvas.objects.some((item) => item.id === id)) {
        board.canvas.objects.push({ id, content: { type: "work_record", project_id: projectId, record_id: body.record_id }, content_revision: 1 });
        board.canvas.items.push({ item_id: id, revision: 1, z: 0, removed: false, appearance: "plain", x: 10, y: 10, width: 320, height: 220 });
      }
      return json(route, board);
    }
    if (method === "GET" && parts[3] === "access") return json(route, access.get(projectId) ?? []);
    if (method === "POST" && parts[3] === "access" && parts[4]) {
      const body = request.postDataJSON();
      const rows = access.get(projectId) ?? [];
      const index = rows.findIndex((item) => item.id === decodeURIComponent(parts[4]));
      const current = rows[index]; assert.equal(body.expected_revision, current.revision);
      const updated = { ...current, state: body.decision, revision: current.revision + 1 };
      rows[index] = updated; return json(route, updated);
    }
  }
  return json(route, { error: `unexpected fixture request ${method} ${pathName}` }, 404);
}

const preview = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "pipe", windowsHide: true });
let previewOutput = "";
preview.stdout.on("data", (data) => { previewOutput += String(data); });
preview.stderr.on("data", (data) => { previewOutput += String(data); });

try {
  await waitHttp(`${origin}/`);
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === "project_window_key") return "fixture-key";
        if (command === "bridge_status") return { surface: "ambient", port: 47194, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
        if (command === "set_surface") return { surface: args?.surface || "focus", port: 47194, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
        if (command === "get_board") return { topic: "project-record-fixture", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [], replies: [], canvas: { revision: 1, objects: [], items: [] } };
        if (command === "list_forms") return { forms: [{ id: "spatial", label: "Spatial", blurb: "" }] };
        return undefined;
      },
      transformCallback: () => 1,
      unregisterCallback: () => {},
    };
    localStorage.setItem("spellcast.locale", "en"); localStorage.setItem("spellcast.mode", "ambient");
  });
  const unexpected = [];
  await context.route("**/*", async (route, request) => {
    const url = new URL(request.url());
    if (url.origin === apiOrigin) return routeApi(route, request);
    if (url.origin === origin) return route.continue();
    if (url.origin === "https://fonts.googleapis.com" && url.pathname === "/css2") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    unexpected.push(request.url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`page-error=${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") console.error(`console-error=${message.text()}`); });
  await page.goto(`${origin}/`, { waitUntil: "commit" });
  await page.waitForSelector("#projects-open", { state: "attached" });
  await page.waitForTimeout(750);
  assert.equal((await page.locator("#projects-open").innerText()).trim(), "Game development", "Project entry did not finish mounting.");
  await page.locator("#projects-open").evaluate((element) => element.click());
  await page.waitForSelector("dialog.project-workspace[open]");
  await page.locator('[data-project-action="new"]').click();
  await page.locator('[data-project-name="true"]').fill("Fixture project");
  await page.locator('[data-project-action="create"]').click();
  await page.waitForSelector('[data-project-id]', { state: "attached" });
  assert.equal(await page.locator(".project-workspace").getAttribute("data-workspace-view"), "game", "A new project opens on the AI-first game home.");
  assert.equal(await page.locator('[data-project-id]').innerText().then((text) => text.includes("Fixture project")), true);

  await openView(page, "planning");
  if (process.env.SPELLCAST_CONTENT_CHECK_ONLY !== "1") {
    await runPlanningChecks({page, objects, projects, mutate, screenshotDir});
    await runFlowChecks({page, objects, projects, mutate, screenshotDir});
    await runWorkbenchChecks({page, objects, projects, mutate, screenshotDir, evidence});
  }
  await runContentChecks({page, objects, projects, mutate, screenshotDir});

  await openView(page, 'records');
  await page.locator('[data-record-action="new"]').click();
  await page.locator('[data-record-title="true"]').fill("Title-only record");
  await page.locator('[data-record-action="save"]').click();
  await page.waitForSelector('.project-workspace-record-summary');
  await page.waitForFunction(() => document.querySelector('[data-record-action="edit"]')?.disabled === false);
  assert.equal(await page.locator('.project-workspace-record-list').innerText().then((text) => text.includes("Title-only record")), true);
  assert.equal(await page.locator('.project-workspace-record-summary').innerText().then((text) => /Result\s+Not recorded[\s\S]*Boundaries\s+Not recorded[\s\S]*Next step\s+Not recorded/.test(text)), true);
  await mkdir(screenshotDir, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.locator("body").evaluate((element, value) => { element.dataset.theme = value; }, theme);
    const contrast = await page.locator(".project-workspace").evaluate((element) => {
      const rgba = (color) => color.match(/[\d.]+/g).map(Number);
      const luminance = (color) => {
        const channels = color.slice(0, 3).map((value) => {
          const unit = value / 255;
          return unit <= .04045 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      return ["h2", ".project-workspace-summary-heading h3", ".project-workspace-summary-value p", "button.primary", "input"].map((selector) => {
        const target = element.querySelector(selector);
        const style = getComputedStyle(target);
        const layers = [];
        for (let ancestor = target; ancestor; ancestor = ancestor.parentElement) layers.unshift(rgba(getComputedStyle(ancestor).backgroundColor));
        const background = layers.reduce((under, over) => under.map((value, i) => over[i] * (over[3] ?? 1) + value * (1 - (over[3] ?? 1))), [255, 255, 255]);
        const fg = luminance(rgba(style.color)), bg = luminance(background);
        return { selector, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
      });
    });
    assert.ok(contrast.every((item) => item.ratio >= 4.5), `${theme} unreadable text: ${JSON.stringify(contrast)}`);
    await page.screenshot({ path: path.join(screenshotDir, `project-record-summary-${theme}-1280.png`) });
  }
  await page.locator("body").evaluate((element) => { element.dataset.theme = "dark"; });
  for (const [width, height] of [[1920, 1080], [820, 800], [640, 800], [1280, 860]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.locator(".project-workspace").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, overflowing: [...element.querySelectorAll(".project-workspace-projects, .project-workspace-records, .project-workspace-detail")].some((panel) => panel.scrollWidth > panel.clientWidth + 1) };
    });
    assert.ok(layout.width >= width - 34 && layout.height >= height - 34, `Workspace wastes window area at ${width}: ${JSON.stringify(layout)}`);
    assert.equal(layout.overflowing, false, `Horizontal content overflow at ${width}`);
  }
  await page.locator('[data-record-action="edit"]').click();
  await page.waitForSelector('[data-record-title="true"]');
  assert.equal(await page.locator('.project-workspace-record-editor > [data-record-object="true"]').count(), 0);
  assert.equal(await page.locator('.project-workspace-record-editor .project-workspace-optional').evaluate((element) => !(element instanceof HTMLDetailsElement) || !element.open), true);
  await page.locator('[data-record-action="save"]').click();
  await page.waitForSelector('.project-workspace-record-summary');
  await page.waitForSelector('[data-record-action="archive"]');
  await page.locator("details.project-workspace-history summary").click();
  await page.waitForFunction(() => (document.querySelector(".project-workspace-history")?.textContent || "").includes("Revision 1"));

  await page.locator('[data-record-action="archive"]').click();
  await page.waitForSelector('[data-record-action="unarchive"]');
  await page.locator('[data-record-action="unarchive"]').click();
  await page.waitForSelector('[data-record-action="archive"]');

  await page.locator("details.project-workspace-access summary").click();
  await page.locator('[data-access-action="approve"]').click();
  await page.waitForFunction(() => (document.querySelector(".project-workspace-access")?.textContent || "").includes("Approved"));

  await page.locator('[data-record-action="edit"]').click();
  await page.locator('[data-record-title="true"]').fill("Unsaved local draft");
  await page.locator('[data-project-action="close"]').click();
  await page.locator("#projects-open").evaluate((element) => element.click());
  await page.waitForSelector('dialog.project-workspace[open]');
  await page.waitForTimeout(1_500);
  assert.equal(await page.locator(".project-workspace-summary-heading h3").innerText(), "Title-only record", "Summary must show the saved title, not the local draft.");
  assert.equal(await page.locator('[data-record-action="continue-draft"]').count(), 1, "A local draft should be offered from the saved-record summary.");
  await page.locator('[data-record-action="continue-draft"]').click();
  assert.equal(await page.locator('[data-record-title="true"]').inputValue(), "Unsaved local draft");

  await page.reload({ waitUntil: "commit" });
  await page.waitForFunction(() => document.querySelector("#projects-open")?.textContent?.trim() === "Game development");
  await page.locator("#projects-open").evaluate((element) => element.click());
  await page.waitForSelector("dialog.project-workspace[open]");
  await page.waitForSelector('[data-record-action="continue-draft"]');
  assert.equal(await page.locator(".project-workspace-summary-heading h3").innerText(), "Title-only record");

  await page.evaluate(() => window.addEventListener("spellcast:locate-project-record", (event) => {
    document.body.dataset.projectRecordLocated = JSON.stringify(event.detail);
  }, { once: true }));
  await page.locator('[data-record-action="pin"]').click();
  await page.waitForFunction(() => Boolean(document.body.dataset.projectRecordLocated));
  assert.match(await page.locator("body").getAttribute("data-project-record-located"), /projectId.*recordId/);
  assert.equal(unexpected.length, 0, `unexpected network: ${unexpected.join(", ")}`);
  await browser.close();
  console.log("project record workspace fixture passed");
} finally {
  preview.kill();
  await Promise.race([
    new Promise((resolve) => preview.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (previewOutput.includes("error when starting dev server")) throw new Error(previewOutput);
}
