/**
 * Native sigil (法阵) check against a fresh isolated debug app (run through
 * scripts/run-native-check.mjs). An agent drafts and executes a plan over the app's own MCP
 * endpoint on a temporary repository. The window freezes and starts it, decides a manual check
 * and watches the card change through the real `spellcast-sigil` event, so every user action
 * uses the real window credential. The repository and the app's data are temporary; nothing
 * reaches the user's Spellcast, repositories or tasks.
 *
 *   node scripts/run-native-check.mjs check-sigil-native --cdp 9356 --port 47218
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT ?? "artifacts/native-checks/check-sigil-native");
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP ?? "http://127.0.0.1:9356");
const page = browser.contexts()[0].pages().find(item => item.url() === "http://tauri.localhost/");
assert(page, "main window");
page.setDefaultTimeout(30000);
const port = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("bridge_status").then(status => status.port));
assert(![47193, 47194].includes(port), "Never the user's bridge");

const report = { scope: "isolated native app (own identifier, port, database, WebView profile); temporary repository; no task bound", port, checks: [], screenshots: [], errors: [] };
const ok = name => { report.checks.push(name); console.log(`ok - ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    try { const value = await read(); if (value) return value; } catch {}
    if (Date.now() - start > timeout) throw new Error(message);
    await sleep(200);
  }
}
const shot = async name => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file); };

/** The Canvas workspace key, as src/content-origin.ts computes it. */
function workspaceKey(cwd) {
  const slashes = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return `workspace:${/^[a-z]:\//i.test(slashes) ? slashes.toLowerCase() : slashes}`;
}

const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), "spellcast-sigil-native-"));
const repo = path.join(root, "repo");
const git = (...args) => execFileSync("git", ["-c", "user.name=Sigil Check", "-c", "user.email=sigil@check.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
const sigilId = "native-check";
const source = "claude:sigil-native-check";
let rpc = 0;
async function mcp(name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.json();
  assert(response.ok && !body.error && !body.result?.isError, `${name} ${args.op ?? args.view}: ${JSON.stringify(body)}`);
  return body.result.structuredContent;
}
const update = (op, extra = {}) => mcp("spellcast_sigil_update", { request_id: crypto.randomUUID(), sigil_id: sigilId, source_id: source, label: "原生检查 agent", op, ...extra });
const query = (view, extra = {}) => mcp("spellcast_sigil_query", { view, sigil_id: sigilId, ...extra });

const frame = page.locator(`.canvas-frame[data-item-id="sigil-${sigilId}"]`);
const card = frame.locator(".sigil-card");
const stepRow = index => card.locator(".sigil-card-step").nth(index);
async function workInside() {
  await page.getByRole("button", { name: "内容总览", exact: true }).click();
  await page.locator(`.canvas-overview-card[data-item-id="sigil-${sigilId}"]`).getByRole("button", { name: "定位", exact: true }).click();
  await frame.locator(".canvas-frame-head button").first().click();
}
async function confirmIn(button) {
  await card.getByRole("button", { name: button, exact: true }).click();
  const dialog = page.locator("dialog.sigil-dialog[open]");
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

try {
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "app.txt"), "hello\n");
  git("init", "-q", "-b", "main");
  // The user's global autocrlf would rewrite line endings in the worktree checkout.
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  await page.evaluate(scope => {
    localStorage.setItem("spellcast.locale", "zh-CN");
    localStorage.setItem("spellcast.mode", "focus");
    localStorage.setItem("spellcast.canvas-scope", JSON.stringify({ workspace: scope, task: "all" }));
  }, workspaceKey(repo));
  await page.reload();
  await until(() => page.evaluate(() => Boolean(document.querySelector("#settings-open")?.textContent.trim())), "main window did not restart");
  if (await page.locator("#mode-focus").isVisible()) await page.locator("#mode-focus").click();
  await page.locator("#view-replies").click();

  // An agent drafts the plan over MCP; its card appears on the Canvas.
  const plan = { title: "原生检查法阵", goal: "在真实应用里走完一遍执行和验证。", repository: repo, location: "worktree",
    steps: [
      { id: "edit", title: "改一个文件", instructions: "Change src/app.txt.", scope: ["src/**"],
        checks: [{ kind: "command", label: "git version", argv: ["git", "--version"], timeout_s: 60 }] },
      { id: "look", title: "人工确认", instructions: "Ask the user to look.", scope: ["src/**"], depends_on: ["edit"],
        checks: [{ kind: "manual", label: "看一下改动", description: "确认 src/app.txt 已经改成新内容。" }] },
    ] };
  const created = await update("put_plan", { expected_revision: 0, plan });
  assert.equal(created.created, true);
  assert.equal(created.review.can_freeze, true, JSON.stringify(created.review));
  await card.locator(".sigil-card-step").first().waitFor({ state: "visible" });
  assert.equal(await card.locator(".sigil-card-state").innerText(), "草稿");
  ok("an agent's MCP draft pins a live card on the native Canvas");

  // Freeze and start through the card: the real window credential.
  await workInside();
  let dialog = await confirmIn("冻结…");
  assert.match(await dialog.innerText(), /git --version/);
  await dialog.getByRole("button", { name: "冻结", exact: true }).click();
  await until(async () => (await card.locator(".sigil-card-state").innerText()) === "已冻结", "freezing did not reach the card");
  dialog = await confirmIn("开始执行…");
  await dialog.getByRole("button", { name: "开始执行", exact: true }).click();
  await until(async () => (await card.locator(".sigil-card-state").innerText()) === "执行中", "starting did not reach the card");
  const view = await query("sigil");
  const worktree = view.sigil.run.execution_directory;
  assert.equal(view.sigil.run.branch, `sigil/${sigilId}`);
  assert.match(git("worktree", "list", "--porcelain"), new RegExp(`locked sigil:${sigilId}`));
  assert.equal(await readFile(path.join(worktree, "src", "app.txt"), "utf8"), "hello\n");
  await shot("started");
  ok("freeze and start from the card create a locked worktree on its own branch");

  // The agent executes; the card follows through the desktop event.
  const claimed = await update("claim");
  assert.equal(claimed.status, "accepted");
  assert.equal(claimed.next.id, "edit");
  await until(async () => (await card.locator(".sigil-card-executor").innerText({ timeout: 1000 })).includes("原生检查 agent"), "the executor did not appear");
  await update("start_step", { step_id: "edit" });
  await until(async () => (await stepRow(0).locator(".sigil-light").getAttribute("data-light")) === "running", "the step did not light up");
  await writeFile(path.join(worktree, "src", "app.txt"), "hello, sigil\n");
  await until(async () => (await stepRow(0).locator(".sigil-card-toggle").innerText({ timeout: 1000 })).startsWith("1 个文件 +1 −1"), "the interval snapshot did not reach the card", 30000);
  ok("an edit during the step reaches the card through interval snapshots and the spellcast-sigil event");

  const reported = await update("report_step", { step_id: "edit", summary: "Changed src/app.txt", evidence: [] });
  assert.equal(reported.step.check_results[0].kind, "command");
  await until(async () => (await stepRow(0).locator(".sigil-light").getAttribute("data-light")) === "passed", "the command check did not pass on the card", 60000);
  assert.match(await stepRow(0).locator(".sigil-card-toggle").innerText(), /验证 1\/1/);
  const outputs = await (await fetch(`http://127.0.0.1:${port}/api/sigils/${sigilId}/step?step_id=edit`)).json();
  const run = outputs.progress.checks[0].run;
  assert.match(outputs.outputs[String(run)], /git version/);
  await shot("command-passed");
  ok("Spellcast runs the reported step's command in the native app and the light turns green");

  // The agent amends the plan: a new command waits until the user approves it on the card.
  const amended = await update("amend", { reason: "加一步确认仓库根目录", changes: [{ kind: "add_step", after: "edit",
    step: { id: "root", title: "确认仓库根目录", instructions: "Check the work tree root.", scope: ["src/**"], depends_on: ["edit"],
      checks: [{ kind: "command", label: "toplevel", argv: ["git", "rev-parse", "--show-toplevel"], timeout_s: 60 }] } }] });
  assert.equal(amended.commands_waiting_approval[0].label, "toplevel");
  const approvals = card.locator(".sigil-card-approvals");
  await approvals.waitFor({ state: "visible" });
  await approvals.getByRole("button", { name: "批准…", exact: true }).click();
  dialog = page.locator("dialog.sigil-dialog[open]");
  await dialog.waitFor({ state: "visible" });
  assert.match(await dialog.innerText(), /git rev-parse --show-toplevel/);
  await dialog.getByRole("button", { name: "批准", exact: true }).click();
  await approvals.waitFor({ state: "hidden" });
  assert.deepEqual((await query("sigil")).pending_commands, []);
  ok("an amendment's new command waits until the user approves it on the card");

  // A second amendment is reverted from the card; the plan returns to its earlier fields.
  const second = await update("amend", { reason: "改一下人工确认的说明", changes: [{ kind: "update_step", step_id: "look", instructions: "Look twice." }] });
  assert.equal(second.notices.filter(event => event.kind === "command_approved").length, 1, "the agent hears the approval");
  const revision = (await query("sigil")).sigil.revision;
  const amendmentList = card.locator(".sigil-card-amendments");
  await amendmentList.locator(".sigil-card-toggle").click();
  await amendmentList.locator(".sigil-card-amendment").first().getByRole("button", { name: "撤销…", exact: true }).click();
  dialog = page.locator("dialog.sigil-dialog[open]");
  await dialog.waitFor({ state: "visible" });
  assert.match(await dialog.locator(".sigil-dialog-title").innerText(), new RegExp(`#${revision}`));
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await until(async () => (await amendmentList.locator(".sigil-card-amendment-reverted").count()) === 1, "the revert did not reach the card");
  assert.equal((await query("sigil")).sigil.steps.find(step => step.id === "look").instructions, "Ask the user to look.");
  ok("the user reverts an amendment from the card and the earlier plan fields return");

  await update("start_step", { step_id: "root" });
  await update("report_step", { step_id: "root", summary: "Checked the root", evidence: [] });
  await until(async () => (await stepRow(1).locator(".sigil-light").getAttribute("data-light")) === "passed", "the approved command did not pass", 60000);
  ok("the approved command runs after the step's report");

  // A manual check waits for the user, who passes it on the card.
  const nextUp = await update("start_step", { step_id: "look" });
  assert(nextUp.notices.some(event => event.kind === "check_finished" && event.value.step_id === "root" && event.value.status === "passed"),
    `the agent hears the command result: ${JSON.stringify(nextUp.notices)}`);
  const looked = await update("report_step", { step_id: "look", summary: "Ready to look", evidence: [] });
  assert.equal(looked.step.light, "needs_you");
  await until(async () => (await stepRow(2).locator(".sigil-light").getAttribute("data-light")) === "needs_you", "the manual check did not ask the user");
  await stepRow(2).locator(".sigil-card-toggle").click();
  await stepRow(2).getByRole("button", { name: "通过…", exact: true }).click();
  dialog = page.locator("dialog.sigil-dialog[open]");
  await dialog.waitFor({ state: "visible" });
  assert.match(await dialog.innerText(), /确认 src\/app\.txt 已经改成新内容。/);
  await dialog.locator("textarea").fill("看过了，没问题");
  await shot("manual-decision");
  await dialog.getByRole("button", { name: "记为通过", exact: true }).click();
  await until(async () => (await card.locator(".sigil-card-state").innerText()) === "已完成", "the run did not complete", 30000);
  const ended = await query("wait", { source_id: source, since: looked.cursor, wait: 5 });
  const kinds = ended.events.map(event => event.kind);
  assert(kinds.includes("check_decided") && kinds.includes("step_verified") && kinds.includes("completed"), JSON.stringify(kinds));
  assert.equal(ended.state, "completed");
  await shot("completed");
  ok("the user's decision on the card completes the run and the agent's wait reports it");
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.errors.push(String(error?.stack ?? error));
  await shot("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(error => console.warn(`could not remove ${root}: ${error.message}`));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, errors: report.errors }, null, 2));
}
