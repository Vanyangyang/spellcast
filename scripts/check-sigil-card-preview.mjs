/** Isolated browser check for sigil (法阵) Canvas cards. Every /api/ and port-47194 request is
 * answered by an in-memory fixture; only the built Vite assets are served. Never reaches the
 * real Spellcast, its database or any repository. Run `npm run build` first. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "artifacts/spellcast-sigil-card");
await mkdir(out, { recursive: true });
const port = Number(process.env.SPELLCAST_PREVIEW_PORT ?? 47298);
assert.notEqual(port, 47194);
const origin = `http://127.0.0.1:${port}`;
// Route local production assets from memory when the host disallows loopback connections.
const offline = process.env.SPELLCAST_PREVIEW_OFFLINE === "1";
const distRoot = path.join(root, "dist");
async function fulfillProductionAsset(route, url) {
  const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^\/+/, "");
  const filePath = path.resolve(distRoot, relative);
  assert.ok(filePath.startsWith(distRoot + path.sep), "production asset stays in dist");
  const extension = path.extname(filePath);
  const contentType = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" })[extension] ?? "application/octet-stream";
  try { return await route.fulfill({ status: 200, contentType, body: await readFile(filePath) }); }
  catch (error) { if (error.code === "ENOENT") return route.fulfill({ status: 404, body: "Missing local fixture asset" }); throw error; }
}
const workspace = "G:/isolated/sigil";
const sourceOrigin = { cwd: workspace, source_id: "claude:fixture-author", label: "法阵" };

const step = (id, title, extra = {}) => ({ id, title, instructions: `Do ${id}.`, inputs: [], scope: ["src/**"], depends_on: [], stop_when: [],
  checks: [{ kind: "command", label: "build", argv: ["npm", "run", "build"], timeout_s: 600 }], ...extra });
const base = (id, title, state, steps, extra = {}) => ({ id, title, goal: "Show live progress for one plan.", repository: "G:/isolated/sigil/repo",
  base_ref: "", location: "worktree", worktree_path: "", materials: [], open_questions: [], steps, state, revision: 2,
  owner_source: "claude:fixture-author", created_at_ms: 1, updated_at_ms: 2, updated_by: { kind: "agent", source_id: "claude:fixture-author", label: "Claude" }, ...extra });
const review = (canFreeze, issues = []) => ({ can_freeze: canFreeze, issues, location: "worktree", execution_directory: "G:/isolated/sigil/repo.sigils/x",
  commands: [{ step_id: "build", label: "build", argv: ["npm", "run", "build"], timeout_s: 600 }] });
const lights = (sigil, values) => Object.fromEntries(sigil.steps.map(item => [item.id, values[item.id] ?? "pending"]));
const file = (filePath, status, extra = {}) => ({ path: filePath, status, ...extra });
const views = {
  blocked: (() => { const sigil = base("blocked", "依赖成环的草稿", "draft", [step("a", "第一步", { depends_on: ["b"] }), step("b", "第二步", { depends_on: ["a"] })]);
    return { sigil, review: review(false, [{ level: "error", step_id: "a", code: "dependency_cycle", message: "步骤依赖形成了环。" },
      { level: "warning", code: "goal_empty", message: "没有写目标。" }]), lights: lights(sigil, {}), next: null, card_id: "sigil-blocked" }; })(),
  ready: (() => { const sigil = base("ready", "可以冻结的草稿", "draft", [step("build", "构建"), step("docs", "补文档", { checks: [], scope: [] })]);
    return { sigil, review: review(true, [{ level: "warning", step_id: "docs", code: "no_checks", message: "没有验证；报告完成后会显示为“已完成（未验证）”。" }]),
      lights: lights(sigil, { build: "ready", docs: "ready" }), next: null, card_id: "sigil-ready" }; })(),
  frozen: (() => { const sigil = base("frozen", "已冻结待开始", "frozen", [step("build", "构建")], { revision: 3,
      freeze: { at_ms: 3, revision: 3, commands: [], execution_directory: "G:/isolated/sigil/repo.sigils/frozen" } });
    return { sigil, review: review(true), lights: lights(sigil, { build: "ready" }), next: null, card_id: "sigil-frozen" }; })(),
  running: (() => {
    const steps = [step("a", "整理接口"), step("b", "写存储层", { depends_on: ["a"] }), step("c", "接上界面", { depends_on: ["b"] }),
      step("d", "确认 API 选型"), step("e", "补文档", { checks: [] }),
      step("f", "发布前检查", { checks: [{ kind: "command", label: "lint", argv: ["npm", "run", "lint"], timeout_s: 600 },
        { kind: "manual", label: "看一下页面", description: "打开预览，确认按钮可以点。" }] }),
      step("g", "跑测试", { checks: [{ kind: "command", label: "test", argv: ["npm", "test"], timeout_s: 600 }, { kind: "manual", label: "确认文案", description: "" }] }),
      step("h", "发布前打包", { checks: [{ kind: "command", label: "package", argv: ["npm", "run", "package"], timeout_s: 900 }] })];
    const sigil = base("running", "执行中的法阵", "running", steps, { revision: 4, run: { automation: "supervised", started_at_ms: 4, execution_directory: "G:/isolated/sigil/repo.sigils/running",
      location: "worktree", branch: "sigil/running", base_ref: "main", base_commit: "0".repeat(40),
      executor: { source_id: "claude:fixture-executor", label: "Claude Code · 法阵执行", since_ms: 5 },
      pending_claims: [{ source_id: "codex:other-task", label: "Codex 另一个任务", at_ms: 6 }], revoked: [], replaced: [],
      steps: {
        a: { status: "reported", attempt: 1, changed_files: 3, outside_scope: ["docs/guide.md"],
          markers: [{ kind: "reported_automatically", at_ms: 7, detail: "开始 b 时自动结束" }, { kind: "out_of_scope", at_ms: 8, detail: "docs/guide.md" }],
          changes: [file("assets/intro.mp4", "A", { size: 1_468_006 }), file("docs/guide.md", "A", { added: 3, deleted: 0, out_of_scope: true }),
            file("src/api.ts", "M", { added: 12, deleted: 4 })],
          checks: [{ index: 0, kind: "command", label: "build", attempt: 1, status: "running", run: 3, started_at_ms: Date.now() - 12_000 }] },
        b: { status: "active", attempt: 1, changed_files: 1, changes: [file("src/store.ts", "A", { added: 40, deleted: 0 })] },
        c: { status: "skipped", attempt: 0, markers: [{ kind: "amended", at_ms: 11, detail: "#6 这一步不需要了" }] },
        h: { status: "pending", attempt: 0, markers: [{ kind: "amended", at_ms: 10, detail: "#5 补一步发布前打包" }] },
        d: { status: "blocked", attempt: 1, block_reason: "用新接口还是旧接口？" }, e: { status: "reported", attempt: 1 },
        f: { status: "reported", attempt: 1, markers: [{ kind: "check_disturbed", at_ms: 9, detail: "lint：src/api.ts" }],
          checks: [{ index: 0, kind: "command", label: "lint", attempt: 1, status: "passed", run: 1, started_at_ms: 1_000, finished_at_ms: 3_300, exit_code: 0,
            output_bytes: 900, disturbed: ["src/api.ts"], disturbed_files: 1 },
            { index: 1, kind: "manual", label: "看一下页面", attempt: 1, status: "waiting" }] },
        g: { status: "reported", attempt: 1,
          checks: [{ index: 0, kind: "command", label: "test", attempt: 1, status: "failed", run: 2, started_at_ms: 1_000, finished_at_ms: 5_200, exit_code: 1,
            output_bytes: 70_000, tail: "FAIL src/api.test.ts\n  expected <b>2</b>, received 3\nTests: 1 failed, 11 passed" },
            { index: 1, kind: "manual", label: "确认文案", attempt: 1, status: "passed", note: "文案没问题", finished_at_ms: 5_000 }] } },
      amendments: [
        { revision: 4, at_ms: 9, source_id: "claude:fixture-executor", reason: "先试一个新标题", changes: [{ kind: "update_step", step_id: "b", fields: ["title"] }], reverted_at_ms: 10 },
        { revision: 5, at_ms: 10, source_id: "claude:fixture-executor", reason: "补一步发布前打包 <b>重要</b>",
          changes: [{ kind: "add_step", step_id: "h" }, { kind: "update_step", step_id: "b", fields: ["instructions", "scope"] }] },
        { revision: 6, at_ms: 11, source_id: "claude:fixture-executor", reason: "这一步不需要了", changes: [{ kind: "skip_step", step_id: "c" }] }],
      observation: { baseline_tree: "t0", tree: "t3", observed_at_ms: 9, boundary_tree: "t2", private_bytes: 12_345, partial: ["src/locked.db"],
        inputs_differ_at_start: ["docs/spec.md"],
        outside: [{ from_tree: "t1", to_tree: "t2", first_at_ms: 8, last_at_ms: 8, changed_files: 1, files: [file("README.md", "M", { added: 1, deleted: 1 })] }] } } });
    return { sigil, review: review(true), lights: lights(sigil, { a: "verifying", b: "running", c: "skipped", d: "needs_you", e: "done_unverified",
      f: "needs_you", g: "failed", h: "ready" }), next: "b",
      pending_commands: [{ step_id: "h", index: 0, label: "package", argv: ["npm", "run", "package"], timeout_s: 900 }], card_id: "sigil-running", observation_live: { last_at_ms: 10, duration_ms: 3400, interval_ms: 2000, error: "" },
      check_live: { step_id: "a", index: 0, run: 3, label: "build", started_at_ms: Date.now() - 12_000, output_bytes: 120,
        output_tail: "vite v5 building for production...\n<i>transforming</i> (12) src/main.ts" } };
  })(),
};
/** Command output is data too: markup in it must render as text. */
const testOutput = ["> spellcast@0.4 test", "<script>alert('out')</script>", "FAIL src/api.test.ts", "  expected <b>2</b>, received 3", "Tests: 1 failed, 11 passed"].join("\n");
/** Agent text is data: the patch carries markup that must render as text. */
const patch = ["diff --git a/src/api.ts b/src/api.ts", "index 1111111..2222222 100644", "--- a/src/api.ts", "+++ b/src/api.ts", "@@ -1,2 +1,3 @@",
  " export const api = 1;", "-const old = \"<b>bold</b>\";", "+const html = \"<script>alert('x')</script>\";", "+export const added = true;", ""].join("\n");
const ids = Object.keys(views);
// The workspace list is independent from Canvas placement: finished and paused plans need no card.
const listOnly = [
  { id: "paused-list", title: "已暂停的法阵", state: "paused" },
  { id: "completed-list", title: "已完成的法阵", state: "completed" },
  { id: "aborted-list", title: "已中止的法阵", state: "aborted" },
  { id: "archived-list", title: "已归档的法阵", state: "archived" },
];
for (const item of listOnly) {
  const sigil = base(item.id, item.title, item.state, [step("build", "构建")]);
  views[item.id] = { sigil, review: review(true), lights: lights(sigil, { build: "ready" }), next: null, card_id: `sigil-${item.id}` };
}
let listEmpty = false, listError = false, listReads = 0;
const summaries = () => listEmpty ? [] : Object.values(views).map(({ sigil }) => ({
  id: sigil.id, title: sigil.title, state: sigil.state, revision: sigil.revision,
  owner_source: sigil.owner_source, updated_at_ms: sigil.updated_at_ms, steps: sigil.steps.length,
}));
const board = { topic: "sigil-fixture", form: "spatial", form_reason: "", nodes: [], replies: [], edges: [], messages: [], canvas: {
  revision: 5, objects: ids.map(id => ({ id: `sigil-${id}`, content_revision: 1, content: { type: "sigil", sigil_id: id }, origin: sourceOrigin })),
  items: ids.map((id, i) => ({ item_id: `sigil-${id}`, revision: 1, x: 40 + (i % 2) * 520, y: 40 + Math.floor(i / 2) * 460, width: 480, height: 420, z: i, appearance: "card", removed: false, delete_locked: false })),
  annotations: [], compositions: [], proposals: [] } };
const health = { surface: "focus", port, last_call_ms: 0, calls: 0, paused: false, observer_enabled: false, observer_policy_revision: 1, observer_allowed: true, observer_reason: "fixture" };
const report = { fixtureBoundary: "Every /api/ and port-47194 request is answered by an in-memory fixture; only built Vite assets pass through.", checks: [], errors: [], mutations: [], isolatedFixtureMutations: [], diffs: [], outputs: [], layout: [], screenshots: [] };
const fixtureStartedAt = 91_000;
let fixtureDispatchPhase = "failed", fixtureStartGate = null, fixtureDispatchHttpError = null;
let fixtureUpgradeError = false;

async function attachIsolation(context, { sigilMutations = false, assets = null } = {}) {
  await context.route("**/*", async (route, request) => {
    const url = new URL(request.url()), method = request.method();
    if (assets && url.origin === origin && assets.has(url.pathname)) {
      const type = url.pathname.endsWith(".css") ? "text/css" : url.pathname.endsWith(".js") ? "text/javascript" : "text/html";
      return route.fulfill({ status: 200, contentType: type, body: assets.get(url.pathname) });
    }
    if (url.pathname.startsWith("/api/") || url.port === "47194") {
      const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type,x-spellcast-window" };
      const fulfill = body => route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
      try {
        if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (method === "GET") {
          if (url.pathname === "/api/sigils") {
            listReads++;
            if (listError) return route.fulfill({ status: 503, headers, contentType: "application/json", body: JSON.stringify({ error: "fixture list unavailable" }) });
            return fulfill(summaries());
          }
          const sigil = url.pathname.match(/^\/api\/sigils\/([a-z0-9-]+)$/);
          if (sigil) { assert.ok(views[sigil[1]], `unknown sigil ${sigil[1]}`); return fulfill(views[sigil[1]]); }
          const stepView = url.pathname.match(/^\/api\/sigils\/([a-z0-9-]+)\/step$/);
          if (stepView) {
            const view = views[stepView[1]], stepId = url.searchParams.get("step_id");
            report.outputs.push({ sigil: stepView[1], step_id: stepId });
            return fulfill({ sigil_id: stepView[1], step: view.sigil.steps.find(item => item.id === stepId), light: view.lights[stepId],
              progress: view.sigil.run.steps[stepId], outputs: { 1: "lint ok\n", 2: testOutput }, max_output_bytes: 65536 });
          }
          const diff = url.pathname.match(/^\/api\/sigils\/([a-z0-9-]+)\/diff$/);
          if (diff) {
            const target = Object.fromEntries(url.searchParams);
            report.diffs.push({ sigil: diff[1], ...target });
            return fulfill({ sigil_id: diff[1], step_id: target.step_id ?? "", outside: target.outside ? Number(target.outside) : null, path: target.path ?? "",
              patch: target.outside ? "" : patch, truncated: false, max_bytes: 262144 });
          }
          const values = { "/api/board": board, "/api/feedback": { pending: [], deliveries: [], bindings: [] }, "/api/health": health, "/api/events": { events: [], last_seq: 0 },
            "/api/forms": { forms: [{ id: "spatial", label: "空间", blurb: "" }] }, "/api/memories": { memories: [] },
            "/api/observer/status": { enabled: false, paused: false, allowed: true, reason: "fixture", policy_revision: 1 } };
          assert.ok(Object.hasOwn(values, url.pathname), `unhandled GET ${url.pathname}`);
          return fulfill(values[url.pathname]);
        }
        const body = request.postDataJSON();
        if (sigilMutations && method === "POST" && url.pathname === "/api/sigils/mode-fixture/automation") {
          assert.equal(request.headers()["x-spellcast-window"], "isolatedfixture-window-key");
          const current = views["mode-fixture"];
          assert.deepEqual(Object.keys(body).sort(), ["automation", "expected_revision", "request_id"]);
          assert.equal(body.expected_revision, current.sigil.revision);
          assert.equal(body.automation, "autonomous");
          assert.ok(body.request_id.length > 0);
          report.isolatedFixtureMutations.push({ isolatedfixture: true, path: url.pathname, body });
          if (fixtureUpgradeError) return route.fulfill({ status: 409, headers, contentType: "application/json", body: JSON.stringify({ error: "法阵已更新，请刷新后再切换。" }) });
          current.sigil.run.automation = "autonomous";
          current.sigil.revision++;
          for (const [id, progress] of Object.entries(current.sigil.run.steps)) {
            if (progress.status !== "reported") continue;
            const plan = current.sigil.steps.find(item => item.id === id);
            for (const check of progress.checks ?? []) {
              if (check.attempt !== progress.attempt) continue;
              if (check.kind === "command" && check.status === "needs_approval") check.status = "queued";
              if (check.kind === "manual" && check.status === "waiting" && !plan.checks[check.index].blocking) check.status = "deferred";
            }
          }
          current.pending_commands = [];
          current.lights.verify = "verifying";
          return fulfill({ sigil_id: "mode-fixture", sigil: current.sigil, replayed: false });
        }
        const reviewAction = url.pathname.match(/^\/api\/sigils\/review-fixture\/checks\/decide$/);
        if (sigilMutations && method === "POST" && reviewAction) {
          assert.equal(request.headers()["x-spellcast-window"], "isolatedfixture-window-key");
          const current = views["review-fixture"];
          assert.deepEqual(Object.keys(body).sort(), ["index", "note", "passed", "request_id", "step_id"]);
          assert.equal(typeof body.request_id, "string");
          assert.ok(body.request_id.length > 0);
          assert.equal(body.step_id, "review");
          assert.equal(body.index, 1);
          assert.equal(current.sigil.run.automation, "autonomous");
          report.isolatedFixtureMutations.push({ isolatedfixture: true, path: url.pathname, body });
          const result = current.sigil.run.steps.review.checks[1];
          result.status = body.passed ? "passed" : "failed";
          result.note = body.note;
          current.lights.review = body.passed ? "passed" : "failed";
          return fulfill({ sigil_id: "review-fixture", sigil: current.sigil, review: current.review, replayed: false, created: false, deleted: false, card_id: current.card_id });
        }
        const isolatedAction = url.pathname.match(/^\/api\/sigils\/(dispatch-fixture|fallback-fixture|draft-fixture)\/(start|execute|dispatch)$/);
        if (sigilMutations && method === "POST" && isolatedAction) {
          assert.equal(request.headers()["x-spellcast-window"], "isolatedfixture-window-key");
          const [, id, action] = isolatedAction;
          const current = views[id];
          report.isolatedFixtureMutations.push({ isolatedfixture: true, path: url.pathname, body, target: {
            source_id: current.delivery?.source_id, thread_id: current.delivery?.thread_id, cwd: current.delivery?.cwd,
          } });
          assert.equal(typeof body.request_id, "string");
          assert.ok(body.request_id.length > 0);
          if (action === "start" || action === "execute") {
            assert.deepEqual(Object.keys(body).sort(), ["automation", "expected_revision", "request_id"]);
            assert.equal(body.automation, "autonomous");
            assert.equal(body.expected_revision, current.sigil.revision);
            if (fixtureStartGate) await fixtureStartGate;
            if (action === "execute") {
              assert.equal(current.sigil.state, "draft");
              current.sigil.freeze = { at_ms: 3, revision: 3, commands: current.review.commands, execution_directory: current.review.execution_directory };
              current.sigil.revision = 3;
            }
            current.sigil.state = "running";
            current.sigil.run = { automation: "autonomous", started_at_ms: fixtureStartedAt, execution_directory: current.sigil.freeze.execution_directory,
              location: "worktree", branch: "fixture", base_ref: "main", base_commit: "0".repeat(40),
              pending_claims: [], revoked: [], replaced: [], steps: {} };
            current.delivery.can_dispatch = Boolean(current.delivery.thread_id);
            current.delivery.started_at_ms = fixtureStartedAt;
            return fulfill({ sigil_id: id, sigil: current.sigil, review: current.review, replayed: false, created: false, deleted: false, card_id: current.card_id });
          }
          assert.deepEqual(Object.keys(body).sort(), body.retry ? ["request_id", "retry", "started_at_ms"] : ["request_id", "started_at_ms"]);
          assert.equal(body.started_at_ms, fixtureStartedAt);
          assert.equal(current.sigil.run.started_at_ms, fixtureStartedAt);
          assert.equal(current.sigil.run.executor, undefined);
          assert.equal(current.delivery.source_id, current.sigil.owner_source);
          assert.equal(current.delivery.thread_id, "isolated-original-task");
          assert.equal(current.delivery.cwd, "G:/isolated/original-chat");
          if (fixtureDispatchHttpError) {
            return route.fulfill({ status: 503, headers, contentType: "application/json", body: JSON.stringify({ error: fixtureDispatchHttpError }) });
          }
          current.delivery = { ...current.delivery, phase: fixtureDispatchPhase, request_id: "isolatedfixture-reused-receipt", sequence: 42,
            can_dispatch: false, can_retry: fixtureDispatchPhase === "failed" || fixtureDispatchPhase === "unknown" || fixtureDispatchPhase === "unanswered",
            error: fixtureDispatchPhase === "failed" ? "isolated fixture dispatch unavailable <b>literal</b>" : null };
          return fulfill({ ...current, replayed: Boolean(body.retry) });
        }
        report.mutations.push({ path: url.pathname, body });
        if (url.pathname === "/api/surface") return fulfill({ ...health, surface: body.surface });
        throw new Error(`unexpected mutation ${url.pathname}`);
      } catch (error) {
        report.errors.push(`fixture: ${error.stack}`);
        return route.fulfill({ status: 500, headers, contentType: "application/json", body: JSON.stringify({ error: String(error) }) });
      }
    }
    if (url.origin === origin) return offline ? fulfillProductionAsset(route, url) : route.continue();
    report.errors.push(`unexpected network ${method} ${request.url()}`);
    return route.abort("blockedbyclient");
  });
}

/** Contrast of every visible text node in `scope` against its composited background. */
function measureText(scope) {
  const parse = value => {
    const srgb = value.match(/^color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([-\d.e]+))?\)$/);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    const rgb = value.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    throw new Error(`unparsed color ${value}`);
  };
  const over = (top, bottom) => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    return [0, 1, 2].map(i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha).concat(alpha);
  };
  const backdrop = element => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    return layers.reverse().reduce((result, layer) => over(layer, result), [255, 255, 255, 1]);
  };
  const luminance = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const results = [];
  for (const element of scope.querySelectorAll("*")) {
    const own = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (!own || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") continue;
    const back = backdrop(element);
    const text = over(parse(getComputedStyle(element).color), back);
    const [a, b] = [luminance(text), luminance(back)].sort((x, y) => y - x);
    results.push({ text: element.textContent.trim().slice(0, 40), className: element.className, contrast: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
  }
  return results;
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

const preview = offline ? null : spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "pipe", windowsHide: true });
let previewLog = "", browser;
preview?.stdout.on("data", data => { previewLog += data; }); preview?.stderr.on("data", data => { previewLog += data; });
try {
  if (!offline) await waitHttp();
  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript(scope => {
    localStorage.setItem("spellcast.locale", "zh-CN"); localStorage.setItem("spellcast.mode", "focus"); localStorage.setItem("spellcast.theme", "dark");
    localStorage.setItem("spellcast.canvas-scope", JSON.stringify({ workspace: scope, task: "all" }));
  }, `workspace:${workspace.toLowerCase()}`);
  await attachIsolation(context);
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(`page: ${error.stack}`));
  const card = id => page.locator(`.canvas-frame[data-item-id="sigil-${id}"] .sigil-card`);
  const stepRow = (id, index) => card(id).locator(".sigil-card-step").nth(index);
  async function focusCard(id) {
    await page.getByRole("button", { name: "内容总览", exact: true }).click();
    await page.locator(`.canvas-overview-card[data-item-id="sigil-${id}"]`).getByRole("button", { name: "定位", exact: true }).click();
  }
  async function workInside(id) {
    await focusCard(id);
    await page.locator(`.canvas-frame[data-item-id="sigil-${id}"] .canvas-frame-head button`).first().click();
  }

  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (const id of ids) await card(id).locator(".sigil-card-step").first().waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await page.locator(".canvas-frame.is-sigil").count(), 4, "four sigil cards mounted on the real Canvas");
  assert.equal(await card("blocked").locator(".sigil-card-state").innerText(), "草稿");
  assert.equal(await card("frozen").locator(".sigil-card-state").innerText(), "已冻结");
  assert.equal(await card("running").locator(".sigil-card-state").innerText(), "执行中");
  assert.equal(await page.locator('.canvas-frame[data-item-id="sigil-running"] .canvas-frame-head strong').innerText(), "执行中的法阵");
  assert.match(await card("blocked").locator(".sigil-card-errors").innerText(), /1 处需要修正才能冻结/);
  assert.match(await card("blocked").locator(".sigil-card-explain").innerText(), /法阵：把冻结的方案交给一个 agent 执行/);
  report.checks.push("cards mount on the real Canvas with state, title, freeze errors and the one-line explanation");

  const lightsShown = await card("running").locator(".sigil-light").evaluateAll(nodes => nodes.map(node => node.dataset.light));
  assert.deepEqual(lightsShown, ["verifying", "running", "skipped", "needs_you", "done_unverified", "needs_you", "failed", "ready"]);
  const labels = await card("running").locator(".sigil-card-step > small").allInnerTexts();
  assert.deepEqual(labels, ["待验证", "进行中", "已跳过", "待你处理", "已完成（未验证）", "待你处理", "未通过", "可开始"]);
  assert.match(await card("running").locator(".sigil-card-blocked").innerText(), /停下：用新接口还是旧接口？/);
  assert.ok(await card("running").locator(".sigil-card-step.is-next").innerText().then(text => text.includes("写存储层")));
  assert.match(await card("running").locator(".sigil-card-executor").innerText(), /执行者：Claude Code · 法阵执行/);
  assert.match(await card("running").locator(".sigil-card-claim").innerText(), /Codex 另一个任务 请求接手/);
  report.checks.push("running card: one light per step with text labels, blocked reason, next step, executor and handover request");

  // Observed changes: a summary per step, the observation state and edits outside any step.
  assert.equal(await stepRow("running", 0).locator(".sigil-card-toggle").innerText(), "3 个文件 +15 −4 · 验证 0/1 · 2 个提醒");
  assert.equal(await stepRow("running", 1).locator(".sigil-card-toggle").innerText(), "1 个文件 +40 −0");
  assert.deepEqual(await card("running").locator(".sigil-card-observe").allInnerTexts(), [
    "每 2 秒检查一次文件改动 · 检查一次需要 3.4 秒", "有 1 个文件被其他程序占用，暂时读不到。", "开始执行时，这些依据文件已经和冻结时不同：docs/spec.md"]);
  assert.equal(await card("running").locator(".sigil-card-outside > .sigil-card-toggle").innerText(), "步骤之外的改动 · 1");
  await workInside("running");
  await stepRow("running", 0).locator(".sigil-card-toggle").click();
  const details = stepRow("running", 0).locator(".sigil-card-step-details");
  await details.waitFor({ state: "visible" });
  assert.deepEqual(await details.locator(".sigil-card-marker-list strong").allInnerTexts(), ["开始另一步时自动结束", "改了范围外的文件"]);
  assert.deepEqual(await details.locator(".sigil-card-file-path").allInnerTexts(), ["assets/intro.mp4", "docs/guide.md", "src/api.ts"]);
  assert.equal(await details.locator(".sigil-card-file").nth(0).locator(".sigil-card-file-meta").innerText(), "未保存 · 1.4 MB");
  assert.equal(await details.locator(".sigil-card-file").nth(0).locator("button").count(), 0, "a file that was not stored has no diff");
  assert.equal(await details.locator(".sigil-card-file").nth(1).locator(".sigil-card-file-scope").innerText(), "范围外");
  await card("running").locator(".sigil-card-outside > .sigil-card-toggle").click();
  assert.match(await card("running").locator(".sigil-card-outside").innerText(), /第 1 段 · 1 个文件[\s\S]*README\.md/);
  report.checks.push("observed changes: per-step file counts and lines, marker labels, out-of-scope and not-stored files, observation notes, edits outside any step");

  // The diff opens in a page dialog, renders the patch as text, and survives live refreshes.
  await details.getByRole("button", { name: "src/api.ts", exact: true }).click();
  const diff = page.locator("dialog.sigil-diff-dialog[open]");
  await diff.locator(".sigil-diff").waitFor({ state: "visible" });
  assert.equal(await diff.locator(".sigil-dialog-title").innerText(), "改动 · src/api.ts");
  assert.match(await diff.locator(".sigil-diff").innerText(), /\+const html = "<script>alert\('x'\)<\/script>";/);
  assert.equal(await diff.locator("script, b").count(), 0, "markup in a patch stays text");
  assert.deepEqual(await diff.locator(".sigil-diff span").evaluateAll(lines => lines.map(line => line.className)),
    ["is-meta", "is-meta", "is-meta", "is-meta", "is-hunk", "", "is-del", "is-add", "is-add"]);
  assert.deepEqual(report.diffs.at(-1), { sigil: "running", step_id: "a", path: "src/api.ts" });
  views.running.sigil.run.steps.b = { ...views.running.sigil.run.steps.b, changed_files: 2,
    changes: [...views.running.sigil.run.steps.b.changes, file("src/schema.ts", "A", { added: 5, deleted: 0 })] };
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("spellcast-sigil", { detail: { sigil_id: "running" } })));
  await page.waitForFunction(() => document.querySelector('.canvas-frame[data-item-id="sigil-running"] .sigil-card-step:nth-child(2) .sigil-card-toggle')?.textContent === "2 个文件 +45 −0");
  assert.equal(await diff.isVisible(), true, "a live refresh keeps the open diff");
  assert.equal(await details.isVisible(), true, "a live refresh keeps the open change list");
  report.layout.push({ theme: "dark", dialog: await diff.evaluate(measureText) });
  assert.deepEqual(report.layout.at(-1).dialog.filter(text => text.contrast < 4.5), [], "diff text contrast");
  const diffShot = path.join(out, "diff-dialog-dark.png");
  await diff.screenshot({ path: diffShot, animations: "disabled" });
  report.screenshots.push(diffShot);
  await page.keyboard.press("Escape");
  await diff.waitFor({ state: "detached" });
  report.checks.push("diff dialog: literal patch text with line classes, Escape closes it, and a live sigil event refreshes the card without closing it or the change list");

  // Checks: counts per step, results with timing and exit code, live output, literal output, decisions and reruns.
  assert.equal(await stepRow("running", 5).locator(".sigil-card-toggle").innerText(), "验证 1/2 · 1 个提醒");
  assert.equal(await stepRow("running", 6).locator(".sigil-card-toggle").innerText(), "验证 1/2");
  const runningCheck = details.locator(".sigil-card-check");
  assert.equal(await runningCheck.locator(".sigil-card-check-status").innerText(), "运行中");
  assert.match(await runningCheck.locator(".sigil-card-check-meta").innerText(), /^已运行 \d+ 秒$/);
  assert.equal(await runningCheck.locator(".sigil-card-check-argv").innerText(), "npm run build");
  assert.equal(await runningCheck.locator(".sigil-card-check-tail").innerText(), "vite v5 building for production...\n<i>transforming</i> (12) src/main.ts");
  assert.equal(await runningCheck.locator("i").count(), 0, "live output stays text");
  assert.equal(await details.getByRole("button", { name: "重跑验证", exact: true }).count(), 0, "a running command cannot be rerun");
  await stepRow("running", 6).locator(".sigil-card-toggle").click();
  const failedChecks = stepRow("running", 6).locator(".sigil-card-step-details");
  await failedChecks.waitFor({ state: "visible" });
  assert.deepEqual(await failedChecks.locator(".sigil-card-check-status").allInnerTexts(), ["未通过", "通过"]);
  assert.equal(await failedChecks.locator(".sigil-card-check").nth(0).locator(".sigil-card-check-meta").innerText(), "4.2 秒 · 退出码 1");
  assert.equal(await failedChecks.locator(".sigil-card-check-argv").innerText(), "npm test");
  assert.match(await failedChecks.locator(".sigil-card-check-tail").innerText(), /expected <b>2<\/b>, received 3/);
  assert.equal(await failedChecks.locator(".sigil-card-check-tail b").count(), 0, "a failure tail stays text");
  assert.equal(await failedChecks.locator(".sigil-card-check").nth(1).locator(".sigil-card-check-text").innerText(), "备注：文案没问题");
  assert.deepEqual(await failedChecks.locator(".sigil-card-check").nth(1).locator("button").allInnerTexts(), ["不通过"], "a decided check offers the other decision");
  assert.equal(await failedChecks.getByRole("button", { name: "重跑验证", exact: true }).count(), 1);
  await failedChecks.getByRole("button", { name: "查看输出", exact: true }).click();
  const output = page.locator("dialog.sigil-diff-dialog[open]");
  await output.locator(".sigil-output").waitFor({ state: "visible" });
  assert.equal(await output.locator(".sigil-dialog-title").innerText(), "输出 · test");
  assert.equal(await output.locator(".sigil-dialog-muted").innerText(), "只保留了最后 64 KiB。");
  assert.match(await output.locator(".sigil-output").innerText(), /<script>alert\('out'\)<\/script>/);
  assert.equal(await output.locator("script, b").count(), 0, "markup in command output stays text");
  assert.deepEqual(report.outputs.at(-1), { sigil: "running", step_id: "g" });
  report.layout.push({ theme: "dark", output: await output.evaluate(measureText) });
  assert.deepEqual(report.layout.at(-1).output.filter(text => text.contrast < 4.5), [], "output text contrast");
  await page.keyboard.press("Escape");
  await output.waitFor({ state: "detached" });
  await stepRow("running", 5).locator(".sigil-card-toggle").click();
  const waiting = stepRow("running", 5).locator(".sigil-card-step-details");
  await waiting.waitFor({ state: "visible" });
  assert.equal(await waiting.locator(".sigil-card-marker-list strong").innerText(), "验证运行期间文件有变化");
  assert.equal(await waiting.locator(".sigil-card-check-disturbed").innerText(), "运行期间有文件变化，结果可能对不上最新内容；命令自己写的文件也算在内。");
  assert.equal(await waiting.locator(".sigil-card-check-disturbed").getAttribute("title"), "src/api.ts");
  assert.equal(await waiting.locator(".sigil-card-check").nth(1).locator(".sigil-card-check-text").innerText(), "打开预览，确认按钮可以点。");
  assert.equal(await waiting.getByRole("button", { name: "通过", exact: true }).count(), 1);
  await waiting.locator("textarea").fill("按钮能点");
  assert.equal(await page.locator("dialog.sigil-dialog[open]").count(), 0, "manual review is recorded beside the check without a second confirmation");
  // A paused run says what happens to its checks; refreshes keep the open lists.
  const refreshRunning = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("spellcast-sigil", { detail: { sigil_id: "running" } })));
  const pausedNote = () => [...document.querySelectorAll('.canvas-frame[data-item-id="sigil-running"] .sigil-card-observe')].some(node => node.textContent.startsWith("已暂停"));
  views.running.sigil.state = "paused";
  await refreshRunning();
  await page.waitForFunction(pausedNote);
  assert.equal(await card("running").locator(".sigil-card-state").innerText(), "已暂停");
  views.running.sigil.state = "running";
  await refreshRunning();
  await page.waitForFunction(() => document.querySelector('.canvas-frame[data-item-id="sigil-running"] .sigil-card-state')?.textContent === "执行中");
  assert.equal(await page.evaluate(pausedNote), false);
  assert.equal(await waiting.isVisible(), true, "a live refresh keeps the open check list");
  assert.equal(await waiting.locator("textarea").inputValue(), "按钮能点", "a live refresh preserves the inline manual note");
  report.checks.push("supervised checks: counts per step, running output and elapsed time, failure tail with exit code, literal output dialog, disturbed result, inline manual note survives refresh, paused note");

  // Amendments: commands waiting for approval, the amendment list with revert, and reopening a skipped step.
  const approvals = card("running").locator(".sigil-card-approvals");
  assert.equal(await approvals.locator(".sigil-card-approvals-title").innerText(), "等你批准的命令 · 1");
  assert.equal(await approvals.locator(".sigil-card-approval-label").innerText(), "发布前打包 · package");
  assert.equal(await approvals.locator(".sigil-card-check-argv").innerText(), "npm run package");
  await approvals.getByRole("button", { name: "批准…", exact: true }).click();
  const approveDialog = page.locator("dialog.sigil-dialog[open]");
  await approveDialog.waitFor({ state: "visible" });
  assert.equal(await approveDialog.locator(".sigil-dialog-title").innerText(), "批准这条命令？");
  assert.ok((await approveDialog.innerText()).includes("作为步骤 发布前打包 的验证，在 G:/isolated/sigil/repo.sigils/running 里不经过 shell 运行，超时 900 秒。"));
  assert.equal(await approveDialog.locator(".sigil-dialog-command").innerText(), "npm run package");
  assert.match(await approveDialog.locator(".sigil-dialog-consent").innerText(), /只运行这一条/);
  report.layout.push({ theme: "dark", approve: await approveDialog.evaluate(measureText) });
  assert.deepEqual(report.layout.at(-1).approve.filter(text => text.contrast < 4.5), [], "approve dialog contrast");
  await page.keyboard.press("Escape");
  await approveDialog.waitFor({ state: "detached" });
  const skipped = stepRow("running", 2);
  assert.equal(await skipped.locator(".sigil-light").getAttribute("data-light"), "skipped");
  assert.equal(await skipped.getByRole("button", { name: "重新打开", exact: true }).count(), 1);
  assert.equal(await skipped.locator(".sigil-card-toggle").innerText(), "1 个提醒");
  const amendmentList = card("running").locator(".sigil-card-amendments");
  assert.equal(await amendmentList.locator(".sigil-card-toggle").innerText(), "修订 · 3");
  await amendmentList.locator(".sigil-card-toggle").click();
  const amendmentItems = amendmentList.locator(".sigil-card-amendment");
  await amendmentItems.first().waitFor({ state: "visible" });
  assert.deepEqual(await amendmentItems.locator("strong").allInnerTexts(), ["#6 · 这一步不需要了", "#5 · 补一步发布前打包 <b>重要</b>", "#4 · 先试一个新标题"]);
  assert.equal(await amendmentItems.locator("b").count(), 0, "an amendment reason stays text");
  assert.deepEqual(await amendmentItems.nth(1).locator("span").allInnerTexts(), ["新增步骤 发布前打包", "修改步骤 写存储层：说明、改动范围"]);
  assert.equal(await amendmentItems.nth(0).locator("span").innerText(), "跳过步骤 接上界面");
  assert.equal(await amendmentItems.nth(2).locator(".sigil-card-amendment-reverted").innerText(), "已撤销");
  assert.deepEqual(await amendmentItems.evaluateAll(items => items.map(item => item.querySelectorAll("button").length)), [1, 1, 0], "only open amendments can be reverted");
  await amendmentItems.nth(0).getByRole("button", { name: "撤销…", exact: true }).click();
  const revertDialog = page.locator("dialog.sigil-dialog[open]");
  await revertDialog.waitFor({ state: "visible" });
  assert.equal(await revertDialog.locator(".sigil-dialog-title").innerText(), "撤销修订 #6？");
  assert.match(await revertDialog.innerText(), /文件不会被改动。/);
  await revertDialog.getByRole("button", { name: "取消", exact: true }).click();
  await revertDialog.waitFor({ state: "detached" });
  report.checks.push("amendments: commands waiting for approval with a consent dialog, literal amendment reasons with change lines, revert only for open amendments, reopen on a skipped step; cancelling sends nothing");

  await workInside("blocked");
  assert.equal(await card("blocked").getByRole("button", { name: "冻结…", exact: true }).isDisabled(), true);
  await workInside("ready");
  await card("ready").getByRole("button", { name: "冻结…", exact: true }).click();
  const dialog = page.locator("dialog.sigil-dialog[open]");
  await dialog.waitFor({ state: "visible" });
  assert.match(await dialog.innerText(), /npm run build/);
  assert.match(await dialog.innerText(), /冻结即表示允许 Spellcast 在这个目录里运行以上命令/);
  assert.match(await dialog.innerText(), /docs · 没有验证/);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await workInside("frozen");
  await card("frozen").getByRole("button", { name: "开始执行…", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  assert.match(await dialog.innerText(), /repo\.sigils\/frozen/);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(report.mutations.filter(item => item.path.startsWith("/api/sigils")), [], "cancelled dialogs and diffs send nothing");
  report.checks.push("freeze is disabled with errors; freeze and start dialogs list commands, consent and location; cancel and Escape send nothing");

  for (const theme of ["dark", "light"]) {
    for (const width of [1600, 1320, 880]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(value => {
        const select = document.querySelector("[data-theme-select]");
        if (!(select instanceof HTMLSelectElement)) throw new Error("theme control missing");
        select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
      }, theme);
      assert.equal(await page.locator("body").getAttribute("data-theme"), theme);
      await focusCard("running");
      const layout = await card("running").evaluate(node => ({
        overflow: node.scrollWidth > node.clientWidth + 1,
        buttons: [...node.querySelectorAll("button")].filter(button => button.getClientRects().length && !button.classList.contains("sigil-card-file-path"))
          .map(button => ({ label: button.textContent, overflow: button.scrollWidth > button.clientWidth + 1 })),
      }));
      const texts = await card("running").evaluate(measureText);
      report.layout.push({ theme, width, ...layout, texts });
      assert.ok(texts.length > 30, `measured ${texts.length} text elements`);
      assert.equal(layout.overflow, false, `card overflow ${theme} ${width}`);
      assert.deepEqual(layout.buttons.filter(button => button.overflow), [], `button text overflow ${theme} ${width}`);
      assert.deepEqual(texts.filter(text => text.contrast < 4.5), [], `text contrast ${theme} ${width}`);
      const filename = path.join(out, `running-${theme}-${width}.png`);
      await page.locator('.canvas-frame[data-item-id="sigil-running"]').screenshot({ path: filename, animations: "disabled" });
      report.screenshots.push(filename);
      if (width === 1320) {
        for (const [name, index] of [["checks-running", 0], ["checks-failed", 6]]) {
          const shot = path.join(out, `${name}-${theme}.png`);
          await stepRow("running", index).locator(".sigil-card-checks").screenshot({ path: shot, animations: "disabled" });
          report.screenshots.push(shot);
        }
        for (const [name, selector] of [["approvals", ".sigil-card-approvals"], ["amendments", ".sigil-card-amendments"]]) {
          const shot = path.join(out, `${name}-${theme}.png`);
          await card("running").locator(selector).screenshot({ path: shot, animations: "disabled" });
          report.screenshots.push(shot);
        }
      }
    }
    await page.setViewportSize({ width: 1320, height: 1000 });
    await workInside("ready");
    await card("ready").getByRole("button", { name: "冻结…", exact: true }).click();
    await dialog.waitFor({ state: "visible" });
    const dialogShot = path.join(out, `freeze-dialog-${theme}.png`);
    await dialog.screenshot({ path: dialogShot, animations: "disabled" });
    report.screenshots.push(dialogShot);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    if (theme === "light") {
      await workInside("running");
      await stepRow("running", 0).getByRole("button", { name: "src/api.ts", exact: true }).click();
      await diff.locator(".sigil-diff").waitFor({ state: "visible" });
      const lightDialog = await diff.evaluate(measureText);
      report.layout.push({ theme, dialog: lightDialog });
      assert.deepEqual(lightDialog.filter(text => text.contrast < 4.5), [], "diff text contrast light");
      const lightShot = path.join(out, "diff-dialog-light.png");
      await diff.screenshot({ path: lightShot, animations: "disabled" });
      report.screenshots.push(lightShot);
      await page.keyboard.press("Escape");
      await diff.waitFor({ state: "detached" });
    }
  }
  report.checks.push("dark and light themes at 1600/1320/880: no card or button overflow, every visible text at least 4.5:1 on its composited background, dialogs captured");

  // Independent workspace: use the production navigation and detail component with read-only fixtures.
  const workspaceRoot = page.locator("#sigil-stage .sigil-workspace");
  const listItems = workspaceRoot.locator(".sigil-workspace-list button[data-sigil-id]");
  const workspaceDetail = workspaceRoot.locator(".sigil-workspace-detail .sigil-card");
  const workspaceRefresh = workspaceRoot.locator(".sigil-workspace-header [data-action=refresh]");
  async function waitList(expected) {
    await page.waitForFunction(ids => {
      const list = document.querySelector("#sigil-stage .sigil-workspace-list");
      if (!list || list.getAttribute("aria-busy") === "true") return false;
      const shown = [...list.querySelectorAll("button[data-sigil-id]")].map(button => button.dataset.sigilId).sort();
      return JSON.stringify(shown) === JSON.stringify([...ids].sort());
    }, expected);
  }
  async function waitSelected(id) {
    await page.waitForFunction(([expected, title]) => {
      const root = document.querySelector("#sigil-stage .sigil-workspace");
      return root?.dataset.selectedSigil === expected
        && root.querySelector(`button[data-sigil-id="${expected}"]`)?.getAttribute("aria-current") === "true"
        && root.querySelector(".sigil-workspace-detail .sigil-card-title")?.textContent === title
        && Boolean(root.querySelector(".sigil-workspace-detail .sigil-card-step"));
    }, [id, views[id].sigil.title]);
  }
  await page.locator("#sigils-open").click();
  await workspaceRoot.waitFor({ state: "visible" });
  await waitList(Object.keys(views));
  assert.equal(await page.locator("#sigils-open").isVisible(), true, "the independent entry remains visible in focus mode");
  const firstId = await listItems.first().getAttribute("data-sigil-id");
  await waitSelected(firstId);
  assert.equal(await workspaceDetail.count(), 1, "the first list item automatically mounts one existing detail card");
  for (const [filter, expected] of [
    ["draft", ["blocked", "ready", "frozen"]], ["active", ["running", "paused-list"]],
    ["finished", ["completed-list", "aborted-list", "archived-list"]], ["all", Object.keys(views)],
  ]) {
    const previousId = await workspaceRoot.getAttribute("data-selected-sigil");
    await workspaceRoot.locator(`[data-filter="${filter}"]`).click();
    await waitList(expected);
    assert.equal(await workspaceRoot.locator(`[data-filter="${filter}"]`).getAttribute("aria-pressed"), "true");
    await waitSelected(expected.includes(previousId) ? previousId : await listItems.first().getAttribute("data-sigil-id"));
  }
  await workspaceRoot.locator('[data-sigil-id="running"]').click();
  await waitSelected("running");
  assert.equal(await workspaceDetail.locator(".sigil-card-state").innerText(), "执行中");
  await page.keyboard.press("n");
  await page.keyboard.press("Delete");
  await waitSelected("running");
  assert.deepEqual(report.mutations.filter(item => item.path.startsWith("/api/sigils") || item.path.startsWith("/api/canvas")), [], "Canvas shortcuts do not create or delete content from the sigil workspace");
  report.checks.push("fixed sigil entry mounts the list and automatically selects its first detail; all/draft/active/finished filters include the declared states, including plans without Canvas cards");

  // Failed list reads retain both the previous list and selection, then retry recovers them.
  const beforeFailure = listReads;
  listError = true;
  await workspaceRefresh.click();
  // The detail card keeps its own (hidden) delivery alert; this is the list's status alert.
  const listAlert = workspaceRoot.locator('.sigil-workspace-status[role="alert"]');
  await listAlert.waitFor({ state: "visible" });
  assert.match(await listAlert.innerText(), /fixture list unavailable/);
  assert.ok(listReads > beforeFailure, "refresh fetched the list");
  await waitList(Object.keys(views));
  await waitSelected("running");
  listError = false;
  await listAlert.locator("[data-action=refresh]").click();
  await page.waitForFunction(() => {
    const root = document.querySelector("#sigil-stage .sigil-workspace");
    return root?.querySelector(".sigil-workspace-list")?.getAttribute("aria-busy") === "false"
      && ![...root.querySelectorAll('[role="alert"]')].some(node => node.checkVisibility());
  });
  await waitList(Object.keys(views));
  await waitSelected("running");
  report.checks.push("a failed list refresh shows role=alert while keeping previous rows and detail; retry clears the error and restores read-only loading");

  // Explicit refresh and browser events update the selected detail and summary without losing selection.
  views.running.sigil.title = "执行中的法阵 · 刷新后";
  views.running.sigil.revision++;
  await workspaceRefresh.click();
  await page.waitForFunction(title => document.querySelector('#sigil-stage button[data-sigil-id="running"]')?.textContent.includes(title), views.running.sigil.title);
  await waitSelected("running");
  views.running.sigil.state = "paused";
  views.running.sigil.revision++;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("spellcast-sigil", { detail: { sigil_id: "running" } })));
  await page.waitForFunction(() => document.querySelector('#sigil-stage button[data-sigil-id="running"]')?.dataset.state === "paused"
    && document.querySelector("#sigil-stage .sigil-workspace-detail .sigil-card-state")?.textContent === "已暂停");
  await waitSelected("running");
  // Reuse real detail actions, but close every consent dialog before any mutation can be submitted.
  await workspaceRoot.locator('[data-sigil-id="blocked"]').click();
  await waitSelected("blocked");
  assert.equal(await workspaceDetail.getByRole("button", { name: "冻结…", exact: true }).isDisabled(), true);
  await workspaceRoot.locator('[data-sigil-id="ready"]').click();
  await waitSelected("ready");
  const pickTheme = value => page.evaluate(theme => {
    const select = document.querySelector("[data-theme-select]");
    if (!(select instanceof HTMLSelectElement)) throw new Error("theme control missing");
    select.value = theme; select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  // Dialogs attach outside the workspace palette; in the sigil view they must stay readable in both themes.
  for (const theme of ["dark", "light"]) {
    await pickTheme(theme);
    await workspaceDetail.getByRole("button", { name: "冻结…", exact: true }).click();
    await dialog.waitFor({ state: "visible" });
    assert.match(await dialog.innerText(), /npm run build/);
    assert.equal(await page.locator("body").evaluate(node => node.classList.contains("view-sigils") && node.dataset.theme), theme);
    report.layout.push({ surface: "workspace-freeze-dialog", theme, texts: await dialog.evaluate(measureText) });
    const shot = path.join(out, `workspace-freeze-dialog-${theme}.png`);
    await dialog.screenshot({ path: shot, animations: "disabled" });
    report.screenshots.push(shot);
    assert.deepEqual(report.layout.at(-1).texts.filter(text => text.contrast < 4.5), [], `workspace dialog contrast ${theme}`);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
  await dialog.waitFor({ state: "detached" });
  await workspaceRoot.locator('[data-sigil-id="frozen"]').click();
  await waitSelected("frozen");
  await workspaceDetail.getByRole("button", { name: "开始执行…", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  report.checks.push("workspace refresh and sigil events update the summary and selected detail; detail freeze/start buttons reuse existing disabled and cancellable consent behavior without writing");

  listEmpty = true;
  await workspaceRefresh.click();
  await waitList([]);
  await workspaceRoot.locator(".sigil-workspace-empty").waitFor({ state: "visible" });
  assert.ok((await workspaceRoot.locator(".sigil-workspace-empty").innerText()).trim(), "the empty list explains its state");
  assert.equal(await workspaceDetail.count(), 0, "empty results unmount the stale detail");
  listEmpty = false;
  await workspaceRefresh.click();
  await waitList(Object.keys(views));
  await waitSelected(await listItems.first().getAttribute("data-sigil-id"));
  await workspaceRoot.locator('[data-action="back"]').click();
  await workspaceRoot.waitFor({ state: "detached" });
  await card("running").waitFor({ state: "visible" });
  assert.equal(await page.locator(".canvas-frame.is-sigil").count(), 4, "workspace navigation preserves all original Canvas cards");
  await refreshRunning();
  await page.waitForFunction(() => document.querySelector('.canvas-frame[data-item-id="sigil-running"] .sigil-card-state')?.textContent === "已暂停");
  assert.equal(await page.locator('.canvas-frame[data-item-id="sigil-running"] .canvas-frame-head strong').innerText(), views.running.sigil.title);
  await page.locator("#sigils-open").click();
  await workspaceRoot.waitFor({ state: "visible" });
  await waitList(Object.keys(views));
  assert.equal(await page.locator(".sigil-workspace").count(), 1, "reentering creates one fresh workspace");
  await waitSelected(await listItems.first().getAttribute("data-sigil-id"));
  await workspaceRoot.locator('[data-action="back"]').click();
  await workspaceRoot.waitFor({ state: "detached" });
  report.checks.push("empty results explain their state and clear the detail; recovery remounts it; back preserves the four Canvas cards and event updates; reentry mounts one fresh workspace");

  // Check the independent entry from ambient mode at minimum and wide desktop sizes.
  for (const [locale, theme] of [["zh-CN", "dark"], ["zh-CN", "light"], ["en", "dark"], ["en", "light"]]) {
    for (const [width, height] of [[880, 640], [1600, 900]]) {
    const layoutContext = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    try {
      await layoutContext.addInitScript(([l, t]) => {
        localStorage.setItem("spellcast.locale", l); localStorage.setItem("spellcast.theme", t); localStorage.setItem("spellcast.mode", "ambient");
      }, [locale, theme]);
      await attachIsolation(layoutContext);
      const layoutPage = await layoutContext.newPage();
      layoutPage.on("pageerror", error => report.errors.push(`workspace layout page: ${error.stack}`));
      await layoutPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
      await layoutPage.locator("#sigils-open").waitFor({ state: "visible" });
      assert.equal(await layoutPage.locator("body").evaluate(node => node.classList.contains("mode-ambient")), true, "the entry is available in ambient mode");
      assert.equal(await layoutPage.locator("body").getAttribute("data-theme"), theme);
      assert.equal(await layoutPage.locator("html").getAttribute("lang"), locale);
      await layoutPage.locator("#sigils-open").click();
      await layoutPage.locator("#sigil-stage .sigil-workspace-detail .sigil-card-step").first().waitFor({ state: "visible" });
      const geometry = await layoutPage.locator(".sigil-workspace").evaluate(root => {
        const rect = root.getBoundingClientRect();
        const panels = [root, ...root.querySelectorAll(".sigil-workspace-list, .sigil-workspace-detail, .sigil-card")];
        return { documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          outsideViewport: rect.left < -1 || rect.right > innerWidth + 1,
          panels: panels.map(node => ({ name: node.className, horizontalOverflow: node.scrollWidth > node.clientWidth + 1 })),
          buttonsOutside: [...root.querySelectorAll(".sigil-workspace-header button, .sigil-workspace-filter")]
            .filter(node => { const box = node.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1; }).map(node => node.textContent),
        };
      });
      assert.equal(geometry.documentOverflow, false, `workspace page overflow ${locale} ${theme} ${width}x${height}`);
      assert.equal(geometry.outsideViewport, false, `workspace outside viewport ${locale} ${theme} ${width}x${height}`);
      assert.deepEqual(geometry.panels.filter(panel => panel.horizontalOverflow), [], `workspace panel overflow ${locale} ${theme} ${width}x${height}`);
      assert.deepEqual(geometry.buttonsOutside, [], `workspace navigation buttons outside viewport ${locale} ${theme} ${width}x${height}`);
      const texts = await layoutPage.locator(".sigil-workspace").evaluate(measureText);
      assert.deepEqual(texts.filter(text => text.contrast < 4.5), [], `workspace contrast ${locale} ${theme} ${width}x${height}`);
      report.layout.push({ surface: "sigil-workspace", locale, theme, width, height, ...geometry, texts });
      const shot = path.join(out, `workspace-${locale}-${theme}-${width}x${height}.png`);
      await layoutPage.screenshot({ path: shot, animations: "disabled" });
      report.screenshots.push(shot);
    } finally { await layoutContext.close(); }
    }
  }
  assert.deepEqual(report.mutations.filter(item => item.path.startsWith("/api/sigils")), [], "independent workspace tests never submit a sigil mutation");
  report.listReads = listReads;
  report.checks.push("ambient entry and workspace at 880x640/1600x900 in Chinese/English and dark/light: no horizontal overflow, navigation buttons stay in view, text contrast at least 4.5:1, screenshots captured");

  // Mutation flows run the real card module in an isolated page. A fake desktop shell supplies
  // only the window key, the fixture port and the sigil event channel; every request still lands
  // in the in-memory fixture, never port 47194, a real sigil or a real Codex task.
  const ORIGINAL = { source: "codex:6b4f8c2e-0d4a-4f5e-9a51-3c2f1e0b7a90", thread: "isolated-original-task", cwd: "G:/isolated/original-chat" };
  const frozenView = (id, title, owner, delivery) => {
    const sigil = base(id, title, "frozen", [step("build", "构建")], { revision: 3, owner_source: owner,
      freeze: { at_ms: 3, revision: 3, commands: [], execution_directory: `G:/isolated/sigil/repo.sigils/${id}` } });
    return { sigil, review: review(true), lights: lights(sigil, { build: "ready" }), next: null, card_id: `sigil-${id}`,
      delivery: { source_id: owner, started_at_ms: null, request_id: null, sequence: null, phase: null, error: null,
        can_dispatch: false, can_retry: false, receipt: null, ...delivery } };
  };
  const resetDispatchFixtures = () => {
    views["dispatch-fixture"] = frozenView("dispatch-fixture", "交给原会话的法阵", ORIGINAL.source, { target_label: "原 Codex 任务 <b>标签</b>",
      thread_id: ORIGINAL.thread, cwd: ORIGINAL.cwd, handover_unavailable: null, fallback_instruction: "isolated fixture instruction" });
    views["fallback-fixture"] = frozenView("fallback-fixture", "需要复制说明的法阵", "claude:fixture-author", { target_label: "claude:fixture-author",
      thread_id: null, cwd: null, handover_unavailable: "claude_owner", fallback_instruction: "isolated fallback instruction" });
    fixtureDispatchPhase = "failed"; fixtureStartGate = null; fixtureDispatchHttpError = null;
  };
  /** The frozen dispatch fixture after a start whose handover receipt failed. */
  const runningWithFailedDelivery = () => {
    const view = views["dispatch-fixture"];
    view.sigil.state = "running";
    view.sigil.run = { started_at_ms: fixtureStartedAt, execution_directory: view.sigil.freeze.execution_directory, location: "worktree",
      branch: "fixture", base_ref: "main", base_commit: "0".repeat(40), pending_claims: [], revoked: [], replaced: [], steps: {} };
    view.delivery = { ...view.delivery, started_at_ms: fixtureStartedAt, request_id: "isolatedfixture-reused-receipt", sequence: 42,
      phase: "failed", error: "isolated fixture dispatch unavailable <b>literal</b>", can_dispatch: false, can_retry: true };
  };
  // The app entry's stylesheets in its order (sigil-card.css comes with the module); fonts load from the preview.
  const appStyles = ["styles", "board-workspace", "setup", "fonts", "canvas-studio", "theme", "night-desk", "canvas-game-tools", "composer-editor", "sigil-workspace"];
  const fixtureBuild = await build({
    stdin: { contents: [...appStyles.map(name => `import "./src/${name}.css";`), 'export { mountSigilCard } from "./src/sigil-card";'].join("\n"),
      resolveDir: root, loader: "ts" },
    bundle: true, write: false, format: "esm", outdir: path.join(out, "isolated-bundle"), entryNames: "fixture", external: ["/fonts/*"],
    define: { "import.meta.env": "{}" }, logLevel: "silent" });
  const assets = new Map(fixtureBuild.outputFiles.map(file => [`/__sigil-fixture/${path.basename(file.path)}`, file.text]));
  assert.ok(assets.has("/__sigil-fixture/fixture.js") && assets.has("/__sigil-fixture/fixture.css"), "the isolated bundle has its script and styles");
  assets.set("/__sigil-fixture/", '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/__sigil-fixture/fixture.css"></head>'
    + '<body><main class="sigil-workspace"><div class="sigil-workspace-detail" id="host"></div></main></body></html>');

  async function openIsolated({ locale = "zh-CN", theme = "dark", width = 1320, height = 900 } = {}) {
    const isolated = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await isolated.addInitScript(({ locale, port }) => {
      localStorage.setItem("spellcast.locale", locale);
      const callbacks = new Map(), listeners = new Map();
      let next = 1;
      window.__fixture = { invokes: [], copied: [], emit(event, payload) {
        for (const [id, entry] of listeners) if (entry.event === event) callbacks.get(entry.handler)?.({ event, id, payload });
      } };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__fixture.copied.push(text); } } });
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) };
      window.__TAURI_INTERNALS__ = {
        transformCallback(callback) { const id = next++; callbacks.set(id, callback); return id; },
        async invoke(command, args) {
          window.__fixture.invokes.push(command);
          if (command === "project_window_key") return "isolatedfixture-window-key";
          if (command === "bridge_status") return { port };
          if (command === "plugin:event|listen") { const id = next++; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
          if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
          throw new Error(`unexpected native command ${command}`);
        },
      };
    }, { locale, port });
    await attachIsolation(isolated, { sigilMutations: true, assets });
    const isolatedPage = await isolated.newPage();
    isolatedPage.on("pageerror", error => report.errors.push(`isolated card: ${error.stack}`));
    await isolatedPage.goto(`${origin}/__sigil-fixture/`, { waitUntil: "domcontentloaded" });
    await isolatedPage.evaluate(value => { document.body.dataset.theme = value; }, theme);
    return { context: isolated, page: isolatedPage };
  }
  async function mountIsolated(isolatedPage, id) {
    await isolatedPage.evaluate(async sigilId => {
      window.__card?.destroy();
      const module = await import("/__sigil-fixture/fixture.js");
      window.__card = module.mountSigilCard(document.querySelector("#host"), { type: "sigil", sigil_id: sigilId }, () => {});
    }, id);
    const mounted = isolatedPage.locator("#host .sigil-card");
    await mounted.locator(".sigil-card-step").first().waitFor({ state: "visible" });
    return mounted;
  }
  async function waitNode(what, ready) {
    const startedAt = Date.now();
    while (!ready()) {
      if (Date.now() - startedAt > 10000) throw new Error(`timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const since = mark => report.isolatedFixtureMutations.slice(mark);
  const statusIs = (isolatedPage, text) => isolatedPage.waitForFunction(value =>
    document.querySelector("#host .sigil-card-delivery-status")?.textContent.includes(value), text);

  resetDispatchFixtures();
  {
    const { context: isolated, page: isolatedPage } = await openIsolated();
    try {
      const handover = await mountIsolated(isolatedPage, "dispatch-fixture");
      const confirm = isolatedPage.locator("dialog.sigil-dialog[open]");
      const startHandover = handover.getByRole("button", { name: "开始并交给原会话…", exact: true });
      assert.equal(await handover.locator(".sigil-card-state").innerText(), "已冻结");
      assert.equal(await handover.locator(".sigil-card-stage").innerText(), "等待你启动。启动会准备执行位置，之后仍需要 agent 认领法阵。");
      assert.deepEqual((await handover.locator(".sigil-card-actions button").allInnerTexts()).slice(0, 2), ["开始并交给原会话…", "开始执行…"]);
      assert.equal(await startHandover.evaluate(node => node.classList.contains("is-primary")), true);
      assert.equal(await handover.locator(".sigil-card-delivery").isVisible(), false, "a frozen plan with a verified original session shows no delivery problem");
      let mark = report.isolatedFixtureMutations.length;
      await startHandover.click();
      await confirm.waitFor({ state: "visible" });
      assert.equal(await confirm.locator(".sigil-dialog-title").innerText(), "开始并交给原会话？");
      const summary = await confirm.innerText();
      for (const text of ["原会话：原 Codex 任务 <b>标签</b>", `来源：${ORIGINAL.source}`, `任务：${ORIGINAL.thread}`, ORIGINAL.cwd, "G:/isolated/sigil/repo.sigils/dispatch-fixture"]) {
        assert.ok(summary.includes(text), `the confirmation names ${text}`);
      }
      assert.equal(await confirm.locator("b").count(), 0, "a session label stays text");
      report.layout.push({ surface: "dispatch-confirm", theme: "dark", texts: await confirm.evaluate(measureText) });
      assert.deepEqual(report.layout.at(-1).texts.filter(text => text.contrast < 4.5), [], "dispatch confirmation contrast");
      await confirm.getByRole("button", { name: "取消", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.deepEqual(since(mark), [], "cancelling the handover sends nothing");
      report.checks.push("frozen plan with a verified original Codex session: stage text, primary start-and-hand-over action, confirmation names the label (as text), source, task, session and execution directories; cancel sends nothing");

      // Start, then hand over with the run's own start time. A failed receipt stays retryable.
      await startHandover.click();
      await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: "开始并交接", exact: true }).click();
      const retry = handover.getByRole("button", { name: "重试投递／核对状态…", exact: true });
      await retry.waitFor({ state: "visible" });
      assert.equal(await handover.locator(".sigil-card-state").innerText(), "执行中");
      assert.equal(await handover.locator(".sigil-card-delivery-status").innerText(), "说明投递：失败。执行和验证结果以法阵步骤为准。");
      const alert = handover.locator('.sigil-card-delivery-error[role="alert"]');
      assert.equal(await alert.innerText(), "投递问题：isolated fixture dispatch unavailable <b>literal</b>");
      assert.equal(await alert.locator("b").count(), 0, "a delivery error stays text");
      assert.deepEqual(since(mark).map(item => item.path), ["/api/sigils/dispatch-fixture/start", "/api/sigils/dispatch-fixture/dispatch"]);
      assert.equal(since(mark)[1].body.started_at_ms, fixtureStartedAt);
      assert.deepEqual(since(mark)[1].target, { source_id: ORIGINAL.source, thread_id: ORIGINAL.thread, cwd: ORIGINAL.cwd });
      // A live refresh through the desktop event channel keeps the one alert node: re-inserting it would announce it again.
      await alert.evaluate(node => { node.dataset.fixtureKept = "yes"; });
      views["dispatch-fixture"].sigil.title = "交给原会话的法阵 · 刷新后";
      await isolatedPage.evaluate(() => window.__fixture.emit("spellcast-sigil", { sigil_id: "dispatch-fixture" }));
      await isolatedPage.waitForFunction(() => document.querySelector("#host .sigil-card-title")?.textContent === "交给原会话的法阵 · 刷新后");
      assert.equal(await alert.getAttribute("data-fixture-kept"), "yes", "the persistent alert survived a live refresh");

      fixtureDispatchPhase = "unknown";
      mark = report.isolatedFixtureMutations.length;
      await retry.click();
      await confirm.waitFor({ state: "visible" });
      assert.equal(await confirm.locator(".sigil-dialog-title").innerText(), "重试投递或核对状态？");
      assert.ok((await confirm.innerText()).includes("只核对原任务，不重复发送说明"));
      await confirm.getByRole("button", { name: "重试／核对状态", exact: true }).click();
      await statusIs(isolatedPage, "投递状态不确定");
      assert.equal(await alert.isVisible(), false, "an uncertain receipt is not reported as a failure");
      assert.equal(await retry.isVisible(), true, "an uncertain receipt can be checked again");
      assert.equal(since(mark)[0].body.retry, true);
      fixtureDispatchPhase = "submitted";
      await retry.click();
      await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: "重试／核对状态", exact: true }).click();
      await statusIs(isolatedPage, "已提交，等待原会话");
      assert.equal(await handover.getByRole("button", { name: /重试投递|交给原会话/ }).count(), 0, "an accepted request is never offered again");
      views["dispatch-fixture"].sigil.run.executor = { source_id: ORIGINAL.source, label: "原 Codex 任务", since_ms: 92_000 };
      views["dispatch-fixture"].delivery.can_retry = true;
      await isolatedPage.evaluate(() => window.__fixture.emit("spellcast-sigil", { sigil_id: "dispatch-fixture" }));
      await isolatedPage.waitForFunction(() => document.querySelector("#host .sigil-card-stage")?.textContent.startsWith("原 Codex 任务 已认领"));
      assert.equal(await handover.getByRole("button", { name: /重试投递|交给原会话/ }).count(), 0, "a claimed plan is never dispatched again, even with a stale retry flag");
      const dispatches = report.isolatedFixtureMutations.filter(item => item.path.endsWith("/dispatch"));
      assert.deepEqual(dispatches.map(item => Boolean(item.body.retry)), [false, true, true]);
      report.checks.push("start then hand over: one start, one dispatch with the run's start time to the exact original task; failed receipts show a text-only alert and retry; a live refresh keeps the same alert node; unknown checks again without an alert; submitted or claimed plans offer no further dispatch");

      // A handover whose request fails after a successful start keeps the started run and offers handover again.
      resetDispatchFixtures();
      fixtureDispatchHttpError = "isolated fixture transport refused";
      const retried = await mountIsolated(isolatedPage, "dispatch-fixture");
      mark = report.isolatedFixtureMutations.length;
      await retried.getByRole("button", { name: "开始并交给原会话…", exact: true }).click();
      await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: "开始并交接", exact: true }).click();
      const handOver = retried.getByRole("button", { name: "交给原会话…", exact: true });
      await handOver.waitFor({ state: "visible" });
      assert.equal(await retried.locator(".sigil-card-state").innerText(), "执行中", "a failed handover never undoes the user's start");
      assert.equal(await retried.locator(".sigil-card-notice").innerText(), "法阵已开始，但交接没有成功：isolated fixture transport refused");
      fixtureDispatchHttpError = null; fixtureDispatchPhase = "submitted";
      await handOver.click();
      await confirm.waitFor({ state: "visible" });
      assert.equal(await confirm.locator(".sigil-dialog-title").innerText(), "交给原会话？");
      await confirm.getByRole("button", { name: "交接", exact: true }).click();
      await statusIs(isolatedPage, "已提交，等待原会话");
      assert.deepEqual(since(mark).map(item => item.path.split("/").at(-1)), ["start", "dispatch", "dispatch"]);
      assert.deepEqual(since(mark).filter(item => item.path.endsWith("/dispatch")).map(item => [item.body.started_at_ms, item.body.retry ?? false]),
        [[fixtureStartedAt, false], [fixtureStartedAt, false]]);
      report.checks.push("a transport failure after start keeps the run running, says the handover did not succeed, and the explicit retry hands over the same run");

      // Sources without a verified original Codex task explain why and keep copy-only handover.
      resetDispatchFixtures();
      const fallback = await mountIsolated(isolatedPage, "fallback-fixture");
      assert.equal(await fallback.getByRole("button", { name: "开始并交给原会话…", exact: true }).count(), 0);
      assert.deepEqual(await fallback.locator(".sigil-card-delivery-info p").allInnerTexts(),
        ["暂不能自动交给原会话。请普通启动后，把启动指令复制给一个连接了 Spellcast 的 agent。", "原因：原编写会话是 Claude 聊天；自动交接目前只支持原 Codex 任务。"]);
      assert.equal(await fallback.locator('[role="alert"]').isVisible(), false, "an unsupported source is a reason, not a delivery error");
      mark = report.isolatedFixtureMutations.length;
      await fallback.getByRole("button", { name: "开始执行…", exact: true }).click();
      await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: "开始执行", exact: true }).click();
      await isolatedPage.waitForFunction(() => document.querySelector("#host .sigil-card-state")?.textContent === "执行中");
      await fallback.getByRole("button", { name: "复制启动指令", exact: true }).waitFor({ state: "visible" });
      assert.deepEqual(await fallback.locator(".sigil-card-delivery-info p").allInnerTexts(),
        ["请把启动指令复制给一个连接了 Spellcast 的 agent。这次运行仍在等待认领。", "原因：原编写会话是 Claude 聊天；自动交接目前只支持原 Codex 任务。"]);
      assert.equal(await fallback.getByRole("button", { name: /交给原会话|重试投递/ }).count(), 0);
      await fallback.getByRole("button", { name: "复制启动指令", exact: true }).click();
      await isolatedPage.waitForFunction(() => window.__fixture.copied.length === 1);
      assert.deepEqual(await isolatedPage.evaluate(() => window.__fixture.copied), ["isolated fallback instruction"]);
      assert.deepEqual(since(mark).map(item => item.path), ["/api/sigils/fallback-fixture/start"]);
      report.checks.push("a Claude-authored plan shows the localized reason instead of an error, starts normally, and copies the server's instruction without any dispatch");

      // While start is in flight every action is busy; destroying the card drops the late result without a dispatch.
      resetDispatchFixtures();
      const gated = await mountIsolated(isolatedPage, "dispatch-fixture");
      let release;
      fixtureStartGate = new Promise(resolve => { release = resolve; });
      mark = report.isolatedFixtureMutations.length;
      await gated.getByRole("button", { name: "开始并交给原会话…", exact: true }).click();
      await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: "开始并交接", exact: true }).click();
      await waitNode("the gated start request", () => report.isolatedFixtureMutations.length > mark);
      assert.equal(await gated.locator(".sigil-card-actions button").evaluateAll(nodes => nodes.length > 0 && nodes.every(node => node.disabled)), true,
        "every action is disabled while start is pending");
      const errorsBefore = report.errors.length;
      await isolatedPage.evaluate(() => window.__card.destroy());
      assert.equal(await isolatedPage.locator("#host .sigil-card").count(), 0);
      release();
      await isolatedPage.waitForTimeout(600);
      assert.deepEqual(since(mark).map(item => item.path), ["/api/sigils/dispatch-fixture/start"], "a destroyed card never dispatches a late start");
      assert.equal(report.errors.length, errorsBefore, "a late result after destroy raises nothing");
      const commands = await isolatedPage.evaluate(() => [...new Set(window.__fixture.invokes)]);
      assert.deepEqual(commands.filter(command => !["project_window_key", "bridge_status", "plugin:event|listen", "plugin:event|unlisten"].includes(command)), [],
        "the card used only the window key, the bridge port and the sigil event channel");
      report.checks.push("pending start disables every action; destroying the card mid-start removes it and sends no dispatch; only the window key, bridge port and event channel are used natively");
    } finally { await isolated.close(); }
  }

  // A draft can freeze, start and hand over through one authorized confirmation.
  resetDispatchFixtures();
  {
    const draft = structuredClone(views["dispatch-fixture"]);
    draft.sigil.id = "draft-fixture"; draft.sigil.state = "draft"; draft.sigil.revision = 2;
    delete draft.sigil.freeze;
    draft.card_id = "sigil-draft-fixture";
    draft.review.execution_directory = "G:/isolated/sigil/repo.sigils/draft-fixture";
    views["draft-fixture"] = draft;
    fixtureDispatchPhase = "submitted";
    const { context: isolated, page: isolatedPage } = await openIsolated();
    try {
      const mounted = await mountIsolated(isolatedPage, "draft-fixture");
      const confirm = isolatedPage.locator("dialog.sigil-dialog[open]");
      const start = mounted.getByRole("button", { name: "开始并交给原会话…", exact: true });
      const mark = report.isolatedFixtureMutations.length;
      await start.click(); await confirm.waitFor({ state: "visible" });
      assert.match(await confirm.innerText(), /npm run build/);
      assert.match(await confirm.innerText(), /自动运行验证/);
      await confirm.getByRole("button", { name: "取消", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.deepEqual(since(mark), [], "cancelled combined start performs no lifecycle change");
      assert.equal(views["draft-fixture"].sigil.state, "draft");
      await start.click(); await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: "开始并交接", exact: true }).click();
      await statusIs(isolatedPage, "已提交，等待原会话");
      assert.deepEqual(since(mark).map(item => item.path), ["/api/sigils/draft-fixture/execute", "/api/sigils/draft-fixture/dispatch"]);
      assert.equal(views["draft-fixture"].sigil.run.automation, "autonomous");
      assert.equal(since(mark)[1].body.started_at_ms, fixtureStartedAt);
      assert.equal(await confirm.count(), 0, "freeze, start and dispatch require only one confirmation");
      report.checks.push("autonomous draft: one confirmation freezes, starts and dispatches the same run; cancellation performs no mutation");
    } finally { await isolated.close(); }
  }

  // Legacy runs can authorize the whole remaining verification queue in one explicit click.
  const resetModeFixture = (state = "running") => {
    const steps = [step("done", "已通过的步骤"), step("verify", "待验证的步骤", { checks: [
      { kind: "command", label: "contract", argv: ["dotnet", "build", "contract/Vesperix.Contract.csproj"], timeout_s: 600 },
      { kind: "manual", label: "查看页面", description: "核对效果" },
    ] }), step("decision", "需要决定的步骤", { checks: [{ kind: "manual", label: "确认方案", description: "选择最终方案", blocking: true }] }),
      step("failed", "验证失败的步骤")];
    const sigil = base("mode-fixture", "旧法阵继续执行", state, steps, { revision: 12, run: {
      // The old serialized run has no automation field.
      started_at_ms: 123, execution_directory: "G:/isolated/sigil/legacy", location: "worktree", branch: "sigil/legacy", base_ref: "main", base_commit: "0".repeat(40),
      executor: { source_id: "claude:legacy", label: "Claude Code · 原执行者", since_ms: 123 }, pending_claims: [], revoked: [], replaced: [],
      steps: {
        done: { status: "reported", attempt: 1, checks: [{ index: 0, kind: "command", label: "build", attempt: 1, status: "passed" }] },
        verify: { status: "reported", attempt: 2, changed_files: 3, markers: [], checks: [
          { index: 0, kind: "command", label: "contract", attempt: 1, status: "failed" },
          { index: 0, kind: "command", label: "contract", attempt: 2, status: "needs_approval" },
          { index: 1, kind: "manual", label: "查看页面", attempt: 2, status: "waiting" },
        ] },
        decision: { status: "reported", attempt: 1, checks: [{ index: 0, kind: "manual", label: "确认方案", attempt: 1, status: "waiting" }] },
        failed: { status: "reported", attempt: 1, checks: [{ index: 0, kind: "command", label: "build", attempt: 1, status: "failed" }] },
      },
    } });
    views["mode-fixture"] = { sigil, review: review(true), lights: { done: "passed", verify: "needs_you", decision: "needs_you", failed: "failed" }, next: null,
      pending_commands: [{ step_id: "verify", index: 0, label: "contract", argv: steps[1].checks[0].argv, timeout_s: 600 }], card_id: "sigil-mode-fixture" };
    fixtureUpgradeError = false;
  };
  for (const state of ["running", "paused"]) {
    resetModeFixture(state);
    const { context: isolated, page: isolatedPage } = await openIsolated();
    try {
      const mounted = await mountIsolated(isolatedPage, "mode-fixture");
      const mark = report.isolatedFixtureMutations.length;
      assert.equal(await mounted.locator(".sigil-card-automation").innerText(), "执行模式：监督执行");
      assert.match(await mounted.locator(".sigil-card-automation-upgrade").innerText(), /待批准及后续修订的验证命令都自动运行/);
      if (state === "paused") assert.match(await mounted.locator(".sigil-card-automation-upgrade").innerText(), /仍保持暂停/);
      assert.deepEqual(since(mark), [], "opening a legacy run never grants command consent");
      const original = structuredClone(views["mode-fixture"].sigil.run);
      await mounted.getByRole("button", { name: "改为自主执行", exact: true }).click();
      await isolatedPage.waitForFunction(() => document.querySelector("#host .sigil-card-automation")?.textContent === "执行模式：自主执行");
      assert.equal(await isolatedPage.locator("dialog.sigil-dialog[open]").count(), 0, "the explicit switch needs no second confirmation");
      assert.deepEqual(since(mark).map(item => item.path), ["/api/sigils/mode-fixture/automation"], "one switch, no start, dispatch or per-command approval calls");
      assert.equal(since(mark)[0].body.expected_revision, 12);
      assert.equal(await mounted.locator(".sigil-card-approval").count(), 0);
      assert.equal(await mounted.getByRole("button", { name: "改为自主执行", exact: true }).count(), 0);
      const updated = views["mode-fixture"].sigil;
      assert.equal(updated.state, state);
      assert.equal(updated.run.started_at_ms, original.started_at_ms);
      assert.deepEqual(updated.run.executor, original.executor);
      assert.deepEqual(updated.run.steps.done, original.steps.done);
      assert.deepEqual(updated.run.steps.failed, original.steps.failed);
      assert.deepEqual(updated.run.steps.decision, original.steps.decision);
      assert.equal(updated.run.steps.verify.attempt, 2);
      assert.deepEqual(updated.run.steps.verify.checks.map(item => item.status), ["failed", "queued", "deferred"]);
      report.checks.push(`legacy ${state} run: explicit single switch clears approvals without modal or restart; progress, executor, failures, past attempt and blocking manual check survive`);
    } finally { await isolated.close(); }
  }
  resetModeFixture(); fixtureUpgradeError = true;
  {
    const { context: isolated, page: isolatedPage } = await openIsolated();
    try {
      const mounted = await mountIsolated(isolatedPage, "mode-fixture");
      const mark = report.isolatedFixtureMutations.length;
      await mounted.getByRole("button", { name: "改为自主执行", exact: true }).click();
      await mounted.locator(".sigil-card-notice").filter({ hasText: "法阵已更新" }).waitFor({ state: "visible" });
      assert.equal(views["mode-fixture"].sigil.run.automation, undefined);
      assert.equal(await mounted.locator(".sigil-card-approval").count(), 1);
      assert.equal(since(mark).length, 1, "a refused upgrade never silently retries or approves individual commands");
      report.checks.push("refused legacy upgrade preserves supervised mode and approvals and shows a recoverable error without retry");
    } finally { await isolated.close(); }
  }
  resetModeFixture();
  for (const [locale, theme] of [["zh-CN", "light"], ["en", "dark"]]) {
    const { context: isolated, page: isolatedPage } = await openIsolated({ locale, theme, width: 360 });
    try {
      const mounted = await mountIsolated(isolatedPage, "mode-fixture");
      const upgrade = mounted.locator(".sigil-card-automation-upgrade");
      const texts = await upgrade.evaluate(measureText);
      assert.deepEqual(texts.filter(item => item.contrast < 4.5), []);
      assert.equal(await upgrade.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      assert.equal(await upgrade.locator("button").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      const shot = path.join(out, `legacy-automation-${locale}-${theme}-360.png`);
      await mounted.screenshot({ path: shot, animations: "disabled" }); report.screenshots.push(shot);
    } finally { await isolated.close(); }
  }
  report.checks.push("legacy mode switch: Chinese/light and English/dark narrow layout and readable text contrast");

  // Unperformed review is visible after completion and can be decided or corrected directly.
  {
    const reviewStep = step("review", "复核页面", { checks: [
      { kind: "command", label: "build", argv: ["npm", "run", "build"], timeout_s: 600 },
      { kind: "manual", label: "查看页面", description: "核对页面效果", blocking: false },
    ] });
    const sigil = base("review-fixture", "已完成待复核", "completed", [reviewStep], { run: {
      automation: "autonomous", started_at_ms: 4, execution_directory: "G:/isolated/sigil/review", location: "worktree",
      branch: "fixture", base_ref: "main", base_commit: "0".repeat(40), pending_claims: [], revoked: [], replaced: [],
      steps: { review: { status: "reported", attempt: 1, checks: [
        { index: 0, kind: "command", label: "build", attempt: 1, status: "passed" },
        { index: 1, kind: "manual", label: "查看页面", attempt: 1, status: "deferred" },
      ] } },
    } });
    views["review-fixture"] = { sigil, review: review(true), lights: { review: "review_pending" }, next: null, card_id: "sigil-review-fixture" };
    const { context: isolated, page: isolatedPage } = await openIsolated();
    try {
      const mounted = await mountIsolated(isolatedPage, "review-fixture");
      const row = mounted.locator(".sigil-card-step").first();
      assert.equal(await row.locator(".sigil-light").getAttribute("data-light"), "review_pending");
      await row.locator(".sigil-card-toggle").click();
      const check = row.locator(".sigil-card-check").nth(1);
      assert.equal(await check.locator(".sigil-card-check-status").innerText(), "待复核（不阻塞）");
      assert.equal(views["review-fixture"].sigil.run.steps.review.checks[1].status, "deferred", "completion did not invent a manual pass");
      const mark = report.isolatedFixtureMutations.length;
      await check.locator("textarea").fill("已核对");
      await check.getByRole("button", { name: "通过", exact: true }).click();
      await isolatedPage.waitForFunction(() => document.querySelectorAll("#host .sigil-card-check")[1]?.dataset.status === "passed");
      assert.equal(await isolatedPage.locator("dialog.sigil-dialog[open]").count(), 0);
      assert.equal(since(mark)[0].body.note, "已核对");
      await check.getByRole("button", { name: "不通过", exact: true }).click();
      await isolatedPage.waitForFunction(() => document.querySelectorAll("#host .sigil-card-check")[1]?.dataset.status === "failed");
      assert.equal(views["review-fixture"].sigil.state, "completed");
      assert.deepEqual(since(mark).map(item => item.body.passed), [true, false]);
      assert.equal(await check.getByRole("button", { name: "通过", exact: true }).count(), 1, "post-completion review remains correctable");
      assert.equal(await isolatedPage.locator("dialog.sigil-dialog[open]").count(), 0);
      const shot = path.join(out, "autonomous-review-dark.png");
      await mounted.screenshot({ path: shot, animations: "disabled" }); report.screenshots.push(shot);
      report.checks.push("autonomous completed review stays deferred and non-blocking; direct pass/fail decisions preserve completion and remain correctable");
    } finally { await isolated.close(); }
  }

  // Handover states at Chinese/English, dark/light, narrow and wide windows.
  for (const [locale, theme] of [["zh-CN", "dark"], ["zh-CN", "light"], ["en", "dark"], ["en", "light"]]) {
    for (const width of [360, 1320]) {
      resetDispatchFixtures();
      const { context: layoutContext, page: layoutPage } = await openIsolated({ locale, theme, width });
      try {
        for (const [name, id, prepare] of [["frozen-handover", "dispatch-fixture", null], ["running-failed", "dispatch-fixture", runningWithFailedDelivery],
          ["frozen-fallback", "fallback-fixture", null]]) {
          prepare?.();
          const mounted = await mountIsolated(layoutPage, id);
          const geometry = await mounted.evaluate(node => ({
            documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            cardOverflow: node.scrollWidth > node.clientWidth + 1,
            buttons: [...node.querySelectorAll("button")].filter(button => button.getClientRects().length)
              .map(button => ({ label: button.textContent, overflow: button.scrollWidth > button.clientWidth + 1 })),
            delivery: [...node.querySelectorAll(".sigil-card-delivery p")].filter(line => line.getClientRects().length).map(line => line.textContent),
          }));
          const texts = await mounted.evaluate(measureText);
          report.layout.push({ surface: `dispatch-${name}`, locale, theme, width, ...geometry, texts });
          assert.equal(geometry.documentOverflow, false, `dispatch page overflow ${name} ${locale} ${theme} ${width}`);
          assert.equal(geometry.cardOverflow, false, `dispatch card overflow ${name} ${locale} ${theme} ${width}`);
          assert.deepEqual(geometry.buttons.filter(button => button.overflow), [], `dispatch button overflow ${name} ${locale} ${theme} ${width}`);
          assert.deepEqual(texts.filter(text => text.contrast < 4.5), [], `dispatch text contrast ${name} ${locale} ${theme} ${width}`);
          if (name === "running-failed") assert.equal(geometry.delivery.length, 2, `status and alert are both visible ${locale}`);
          if (name === "frozen-fallback") assert.equal(geometry.delivery.length, 2, `fallback and reason are both visible ${locale}`);
          const shot = path.join(out, `dispatch-${name}-${locale}-${theme}-${width}.png`);
          await mounted.screenshot({ path: shot, animations: "disabled" });
          report.screenshots.push(shot);
          if (name === "frozen-handover") {
            await mounted.locator(".sigil-card-action.is-primary").click();
            const dialogNode = layoutPage.locator("dialog.sigil-dialog[open]");
            await dialogNode.waitFor({ state: "visible" });
            const dialogGeometry = await dialogNode.evaluate(node => {
              const box = node.getBoundingClientRect();
              return { inside: box.left >= -1 && box.right <= innerWidth + 1, overflow: node.scrollWidth > node.clientWidth + 1 };
            });
            const dialogTexts = await dialogNode.evaluate(measureText);
            assert.equal(dialogGeometry.inside && !dialogGeometry.overflow, true, `dispatch dialog fits ${locale} ${theme} ${width}`);
            assert.deepEqual(dialogTexts.filter(text => text.contrast < 4.5), [], `dispatch dialog contrast ${locale} ${theme} ${width}`);
            const dialogShot = path.join(out, `dispatch-confirm-${locale}-${theme}-${width}.png`);
            await dialogNode.screenshot({ path: dialogShot, animations: "disabled" });
            report.screenshots.push(dialogShot);
            await layoutPage.keyboard.press("Escape");
            await dialogNode.waitFor({ state: "detached" });
          }
        }
      } finally { await layoutContext.close(); }
    }
  }
  assert.deepEqual(report.isolatedFixtureMutations.filter(item => !item.isolatedfixture), [], "every handover mutation stayed in the isolated fixture");
  report.checks.push("handover offer, failed delivery and copy-only fallback at 360/1320 px in Chinese/English and dark/light: no page, card, button or dialog overflow; every visible text at least 4.5:1; screenshots captured");
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.errors.push(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  preview?.kill();
  report.previewLog = previewLog.slice(-4000);
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, errors: report.errors, screenshots: report.screenshots.length }, null, 2));
}
