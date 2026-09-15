// Standalone DOM check for src/canvas-insert.ts. Runs in an isolated headless browser page with all
// network blocked; it never touches the user's Spellcast runtime on 47194 or any user configuration.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { outputFiles } = await build({
  entryPoints: [path.join(root, "src/canvas-insert.ts")],
  bundle: true,
  format: "iife",
  globalName: "CanvasInsert",
  platform: "browser",
  write: false,
  outdir: "out",
});
const js = outputFiles.find((file) => file.path.endsWith(".js"))?.text;
const css = outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
assert.ok(js, "esbuild produced no JS bundle");
assert.ok(css.includes(".canvas-insert"), "module must import its own scoped stylesheet");
assert.ok(!/^\s*(body|html|:root|\*)\s*[{,]/m.test(css), "stylesheet must not add global rules");

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

const browser = await launchBrowser();
const context = await browser.newContext({ locale: "zh-CN" });
// The fixture is served from an intercepted loopback URL so `crypto.randomUUID` has a secure
// context, exactly like the real app on localhost / Tauri. Nothing is ever actually fetched.
const FIXTURE = "http://localhost/__canvas-insert-check__/";
const fixtureHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}</style></head>
<body class="mode-focus view-replies"><button id="plus" type="button">+</button></body></html>`;
const isolation = { aborted: [], leaked: [] };
await context.route("**/*", async (route, request) => {
  const url = request.url();
  if (url === FIXTURE) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixtureHtml });
  if (url === "about:blank" || url.startsWith("data:")) return route.continue();
  isolation.aborted.push(url);
  if (url.includes("47194")) isolation.leaked.push(url);
  return route.abort("blockedbyclient");
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
await page.goto(FIXTURE);
await page.addScriptTag({ content: js });
assert.equal(await page.evaluate(() => window.isSecureContext && typeof crypto.randomUUID === "function"), true);

// ---- Pure payload construction -------------------------------------------------------------
const payloads = await page.evaluate(() => {
  const { buildInsertContent } = window.CanvasInsert;
  const base = { title: "", text: "", src: "", alt: "", fill: "#d8ebe4" };
  const run = (over, locale) => buildInsertContent({ ...base, ...over }, locale);
  return {
    text: run({ kind: "text", title: " 标题 ", text: " 正文 " }, "zh-CN"),
    textNoBody: run({ kind: "text", title: "t" }, "zh-CN"),
    textNoBodyEn: run({ kind: "text", title: "t" }, "en"),
    textNoBodyJa: run({ kind: "text", title: "t" }, "ja"),
    imageHttp: run({ kind: "image", src: "https://example.com/a.png", alt: "说明" }, "zh-CN"),
    imageLocal: run({ kind: "image", src: "/artifacts/bundle-1/img/cover.webp" }, "zh-CN"),
    imageData: run({ kind: "image", src: "data:image/png;base64,iVBORw0KGgo=" }, "zh-CN"),
    imageMissing: run({ kind: "image" }, "zh-CN"),
    imageBad: run({ kind: "image", src: "ftp://x/y.png" }, "en"),
    imageSpace: run({ kind: "image", src: "https://example.com/a b.png" }, "ja"),
    rect: run({ kind: "rect", title: "框", text: "内文", fill: "#abc" }, "zh-CN"),
    ellipse: run({ kind: "ellipse", fill: "#AABBCC" }, "zh-CN"),
    badFill: run({ kind: "rect", fill: "red" }, "zh-CN"),
    comparisonZh: run({ kind: "comparison", title: "比较" }, "zh-CN"),
    comparisonEn: run({ kind: "comparison", title: "Compare" }, "en"),
    comparisonJa: run({ kind: "comparison", title: "比較" }, "ja"),
    comparisonNoTitle: run({ kind: "comparison" }, "zh-CN"),
    graph: run({ kind: "graph", title: "关系", text: "起点说明" }, "zh-CN"),
    graphNoTitle: run({ kind: "graph" }, "en"),
    sequenceZh: run({ kind: "sequence", title: "步骤" }, "zh-CN"),
    sequenceEn: run({ kind: "sequence", title: "Steps", text: "Do this first" }, "en"),
    sequenceJa: run({ kind: "sequence", title: "手順" }, "ja"),
    longTitle: run({ kind: "text", title: "字".repeat(161), text: "x" }, "zh-CN"),
    limitTitle: run({ kind: "text", title: "字".repeat(160), text: "x" }, "zh-CN"),
  };
});

const ID = /^[A-Za-z0-9\-_:.]{1,160}$/;
assert.deepEqual(payloads.text, { content: { type: "text", title: "标题", text: "正文" } });
assert.equal(payloads.textNoBody.error, "文字组件需要正文。");
assert.equal(payloads.textNoBodyEn.error, "A text component needs a body.");
assert.equal(payloads.textNoBodyJa.error, "テキストには本文が必要です。");
assert.deepEqual(payloads.imageHttp, { content: { type: "image", title: "", src: "https://example.com/a.png", alt: "说明" } });
assert.equal(payloads.imageLocal.content.src, "/artifacts/bundle-1/img/cover.webp");
assert.equal(payloads.imageData.content.type, "image");
assert.equal(payloads.imageMissing.error, "请填写图片地址。");
assert.match(payloads.imageBad.error, /http\(s\)/);
assert.match(payloads.imageSpace.error, /http\(s\)/);
assert.deepEqual(payloads.rect, { content: { type: "shape", title: "框", shape: "rect", fill: "#abc", text: "内文" } });
assert.deepEqual(payloads.ellipse, { content: { type: "shape", title: "", shape: "ellipse", fill: "#AABBCC", text: "" } });
assert.equal(payloads.badFill.error, "填充色只支持 #RGB 或 #RRGGBB。");
assert.equal(payloads.comparisonNoTitle.error, "请填写标题。");
assert.equal(payloads.graphNoTitle.error, "Please enter a title.");
assert.equal(payloads.longTitle.error, "标题最多 160 字。");
assert.equal(payloads.limitTitle.content.type, "text");

// Block payloads must satisfy the core's minimal validation (spellcast-core/src/reply.rs).
for (const [name, expectCriterion, expectPending] of [["comparisonZh", "维度", "待填写"], ["comparisonEn", "Criterion", "To be filled in"], ["comparisonJa", "観点", "未記入"]]) {
  const { block } = payloads[name].content;
  assert.equal(payloads[name].content.type, "block");
  assert.equal(block.type, "comparison");
  assert.match(block.id, ID);
  assert.deepEqual(block.criteria, [expectCriterion]);
  assert.equal(block.options.length, 2);
  const ids = new Set(block.options.map((option) => option.id));
  assert.equal(ids.size, 2);
  for (const option of block.options) {
    assert.match(option.id, ID);
    assert.ok(option.title.trim());
    assert.deepEqual(option.values, [expectPending]);
    assert.equal(option.values.length, block.criteria.length);
  }
}
{
  const { block } = payloads.graph.content;
  assert.equal(block.type, "graph");
  assert.equal(block.title, "关系");
  assert.equal(block.nodes.length, 1, "graph starts from exactly one node");
  assert.deepEqual(block.edges, [], "graph starts with zero edges");
  assert.equal(block.nodes[0].title, "关系");
  assert.equal(block.nodes[0].detail, "起点说明");
  assert.match(block.nodes[0].id, ID);
  assert.equal(block.nodes[0].x, undefined);
}
for (const [name, stepTitle, action] of [["sequenceZh", "第一步", "待填写"], ["sequenceEn", "Step 1", "Do this first"], ["sequenceJa", "ステップ 1", "未記入"]]) {
  const { block } = payloads[name].content;
  assert.equal(block.type, "sequence");
  assert.equal(block.steps.length, 1);
  assert.equal(block.steps[0].title, stepTitle);
  assert.equal(block.steps[0].action, action);
  assert.match(block.steps[0].id, ID);
}

// ---- Dialog behaviour ----------------------------------------------------------------------
await page.evaluate(() => {
  const state = { calls: [], mode: "pending", resolvers: [] };
  window.__insertState = state;
  window.__dialog = window.CanvasInsert.canvasInsert((content) => {
    state.calls.push(JSON.parse(JSON.stringify(content)));
    if (state.mode === "reject") return Promise.reject(new Error("后端拒绝：标题不能为空。"));
    if (state.mode === "resolve") return Promise.resolve();
    return new Promise((resolve, reject) => state.resolvers.push({ resolve, reject }));
  });
  document.querySelector("#plus").addEventListener("click", () => window.__dialog.show());
});

const dlg = page.locator("dialog.canvas-insert");
const title = dlg.locator("input[name=title]");
const text = dlg.locator("textarea[name=text]");
const src = dlg.locator("input[name=src]");
const submit = dlg.locator("button.canvas-insert-submit");
const cancel = dlg.locator("button.canvas-insert-cancel");
const error = dlg.locator(".canvas-insert-error");
const kindRadio = (kind) => dlg.locator(`input[type=radio][value=${kind}]`);
// Pointer users click the visible chip (the label); the visually hidden radio receives the state.
const pickKind = (kind) => dlg.locator(`label.canvas-insert-kind[data-kind=${kind}]`).click();
const isOpen = () => dlg.evaluate((node) => node.open);
const calls = () => page.evaluate(() => window.__insertState.calls.length);
const setMode = (mode) => page.evaluate((m) => { window.__insertState.mode = m; }, mode);

assert.equal(await page.locator("dialog.canvas-insert").count(), 1, "dialog is created and attached to body at construction");
assert.equal(await dlg.evaluate((node) => node.parentElement === document.body), true);
assert.equal(await isOpen(), false);

// Open via the host button; Chinese strings from currentLocale(); focus lands on the title field.
await page.click("#plus");
assert.equal(await isOpen(), true);
assert.equal(await dlg.locator("h2").textContent(), "添加组件");
assert.equal(await dlg.evaluate((node) => node.getAttribute("aria-labelledby") === node.querySelector("h2").id), true);
assert.equal(await page.evaluate(() => document.activeElement?.name), "title");
assert.deepEqual(await dlg.locator(".canvas-insert-kind").allTextContents(), ["文字", "图片", "矩形", "椭圆", "比较", "关系图", "步骤"]);
assert.equal(await kindRadio("text").isChecked(), true);
assert.equal(await src.isVisible(), false);
assert.equal(await text.isVisible(), true);

// Type changes keep the title / body / address the user already typed.
await title.fill("我的标题");
await text.fill("我的正文");
await pickKind("image");
assert.equal(await src.isVisible(), true);
assert.equal(await text.isVisible(), false);
await src.fill("https://example.com/pic.png");
await pickKind("graph");
assert.equal(await title.inputValue(), "我的标题");
assert.equal(await text.inputValue(), "我的正文");
assert.equal(await text.isVisible(), true);
await pickKind("image");
assert.equal(await src.inputValue(), "https://example.com/pic.png");
assert.equal(await dlg.locator("label[for$='-title']").textContent(), "标题（可选）");
await pickKind("comparison");
assert.equal(await dlg.locator("label[for$='-title']").textContent(), "标题");
assert.equal(await text.isVisible(), false);
await pickKind("rect");
assert.equal(await dlg.locator("input[name=fill]").isVisible(), true);
assert.equal(await dlg.locator("input[name=fill]").inputValue(), "#d8ebe4");

// Keyboard: arrow keys move between kinds through the radio group.
await kindRadio("rect").focus();
await page.keyboard.press("ArrowRight");
assert.equal(await kindRadio("ellipse").isChecked(), true);
assert.equal(await dlg.getAttribute("data-kind"), "ellipse");
await page.keyboard.press("ArrowLeft");
assert.equal(await kindRadio("rect").isChecked(), true);

// Cancel never submits, and the draft survives reopening.
await cancel.click();
assert.equal(await isOpen(), false);
assert.equal(await calls(), 0, "cancel must not call onInsert");
await page.click("#plus");
assert.equal(await isOpen(), true);
assert.equal(await title.inputValue(), "我的标题");
assert.equal(await text.inputValue(), "我的正文");
await page.keyboard.press("Escape");
assert.equal(await isOpen(), false);
assert.equal(await calls(), 0, "escape must not call onInsert");

// Client-side validation blocks the call and points focus at the offending field.
await page.click("#plus");
await pickKind("image");
await src.fill("not a url");
await submit.click();
assert.equal(await calls(), 0);
assert.equal(await error.isVisible(), true);
assert.match(await error.textContent(), /http\(s\)/);
assert.equal(await page.evaluate(() => document.activeElement?.name), "src");
await pickKind("text");
assert.equal(await error.isVisible(), false, "kind change clears a stale validation error");
await text.fill("");
await title.press("Enter");
assert.equal(await calls(), 0);
assert.equal(await error.textContent(), "文字组件需要正文。");
assert.equal(await page.evaluate(() => document.activeElement?.name), "text");

// Failure keeps the dialog open, keeps every input, shows the backend message, and re-enables submit.
await setMode("reject");
await text.fill("正文一");
await submit.click();
await error.waitFor({ state: "visible" });
assert.equal(await calls(), 1);
assert.equal(await isOpen(), true, "failure must keep the dialog open");
assert.equal(await error.textContent(), "后端拒绝：标题不能为空。");
assert.equal(await title.inputValue(), "我的标题");
assert.equal(await text.inputValue(), "正文一");
assert.equal(await submit.isDisabled(), false, "submit must be usable again after a failure");
assert.equal(await dlg.getAttribute("aria-busy"), "false");
assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("canvas-insert-submit")), true);

// Repeated clicks and Enter during a pending submission call onInsert exactly once; Escape is refused.
await setMode("pending");
await submit.click();
await submit.click({ force: true });
await submit.click({ force: true });
await title.press("Enter");
await text.press("Control+Enter");
await page.keyboard.press("Escape");
await page.waitForTimeout(50);
assert.equal(await calls(), 2, "one pending submission must produce exactly one onInsert call");
assert.equal(await isOpen(), true, "escape must not close while a submission is pending");
assert.equal(await submit.isDisabled(), true);
assert.equal(await cancel.isDisabled(), true);
assert.equal(await dlg.getAttribute("aria-busy"), "true");
assert.equal(await submit.textContent(), "正在添加…");
assert.equal(await title.evaluate((node) => node.readOnly), true);
await page.evaluate(() => window.__insertState.resolvers.shift().resolve());
await page.waitForFunction(() => !document.querySelector("dialog.canvas-insert").open);
assert.equal(await isOpen(), false, "success closes the dialog");
assert.equal(await dlg.evaluate((node) => node.returnValue), "inserted");
assert.equal(await submit.isDisabled(), false);
const submitted = await page.evaluate(() => window.__insertState.calls.at(-1));
assert.deepEqual(submitted, { type: "text", title: "我的标题", text: "正文一" });

// After success the draft is cleared for the next component.
await page.click("#plus");
assert.equal(await title.inputValue(), "");
assert.equal(await text.inputValue(), "");
assert.equal(await kindRadio("text").isChecked(), true);

// Submitting a block kind from the dialog produces a core-valid block through the same path.
await setMode("resolve");
await pickKind("sequence");
await title.fill("上线步骤");
await text.fill("先备份数据");
await text.press("Control+Enter");
await page.waitForFunction(() => !document.querySelector("dialog.canvas-insert").open);
const sequence = await page.evaluate(() => window.__insertState.calls.at(-1));
assert.equal(sequence.type, "block");
assert.equal(sequence.block.type, "sequence");
assert.equal(sequence.block.title, "上线步骤");
assert.deepEqual(sequence.block.steps.map((step) => [step.title, step.action]), [["第一步", "先备份数据"]]);

await page.click("#plus");
await pickKind("graph");
await title.fill("依赖图");
await submit.click();
await page.waitForFunction(() => !document.querySelector("dialog.canvas-insert").open);
const graph = await page.evaluate(() => window.__insertState.calls.at(-1));
assert.equal(graph.block.type, "graph");
assert.equal(graph.block.nodes.length, 1);
assert.deepEqual(graph.block.edges, []);

// Tab order reaches the visible controls only.
await page.click("#plus");
await pickKind("image");
await title.focus();
const tabbed = [];
for (let i = 0; i < 6; i++) {
  await page.keyboard.press("Tab");
  tabbed.push(await page.evaluate(() => {
    const node = document.activeElement;
    return node?.name || node?.className || node?.tagName;
  }));
}
assert.deepEqual(tabbed.slice(0, 4), ["src", "alt", "canvas-insert-cancel", "primary canvas-insert-submit"]);
await page.keyboard.press("Escape");

// destroy() removes the dialog and makes show() a no-op.
await page.evaluate(() => window.__dialog.destroy());
assert.equal(await page.locator("dialog.canvas-insert").count(), 0);
await page.evaluate(() => window.__dialog.show());
assert.equal(await page.locator("dialog[open]").count(), 0);

assert.deepEqual(pageErrors, [], "no uncaught page errors");
assert.deepEqual(isolation.leaked, [], "the check must never reach the user runtime on 47194");

await browser.close();
console.log(`canvas insert check passed (blocked ${isolation.aborted.length} outbound requests, leaked 0)`);
