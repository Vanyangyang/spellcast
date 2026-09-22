/** Isolated native visibility regression. Build with TAURI_CONFIG identifier=com.spellcast.visibility-test first. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repo, "output/completion-visibility", `check-${Date.now()}`);
const home = path.join(output, "codex");
const inbox = path.join(home, "spellcast/completions");
const executable = process.env.SPELLCAST_COMPLETION_TEST_EXE || path.join(repo, "src-tauri/target/debug/spellcast.exe");
// An isolated data directory alone does not isolate Tauri's single-instance mutex.
assert((await readFile(executable)).includes(Buffer.from("com.spellcast.visibility-test")),
  "Build the test executable with TAURI_CONFIG identifier=com.spellcast.visibility-test; never launch the installed app here");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(read, message) {
  const deadline = Date.now() + 15000;
  do { if (await read()) return; await sleep(100); } while (Date.now() < deadline);
  throw new Error(message);
}
await mkdir(home, { recursive: true });
const port = await freePort();
const debugPort = await freePort();
const env = {
  ...process.env, CODEX_HOME: home, SPELLCAST_COMPLETIONS_DIR: inbox,
  SPELLCAST_STATE_FILE: path.join(output, "board.sqlite3"), SPELLCAST_PORT: String(port),
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
};
const thread = "12345678-1234-4234-9234-123456789abc";
const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,source TEXT)");
db.prepare("INSERT INTO threads VALUES (?,?,?)").run(thread, "Isolated completion visibility check", "vscode");
db.close();
async function notify(turn) {
  const payload = JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "turn-id": turn,
    cwd: repo, "input-messages": ["Isolated visibility regression"], "last-assistant-message": "Synthetic test notification" });
  const child = spawn(executable, ["--codex-notify", inbox, payload], { env, windowsHide: true, stdio: "ignore" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "Synthetic notification hook failed");
}
let native, browser, page;
const report = { executable, evidence: "isolated synthetic notification + real native cursor-pass-through commands and visibility/focus; system pointer is not moved", checks: [] };
try {
  native = spawn(executable, [], { env, windowsHide: true, stdio: "ignore" });
  let launchError;
  native.once("error", error => { launchError = error; });
  await until(async () => {
    if (launchError) throw launchError;
    if (native.exitCode !== null) throw new Error(`App exited: ${native.exitCode}`);
    try { return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { return false; }
  }, "Isolated WebView did not start");
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  await until(async () => {
    page = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes("completions.html"));
    return Boolean(page);
  }, "Completion WebView did not start");
  const nativeState = () => page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    return {
      visible: await invoke("plugin:window|is_visible", { label: "completions" }),
      focused: await invoke("plugin:window|is_focused", { label: "completions" }),
      cards: document.querySelectorAll(".completion-bubble").length,
      routing: document.documentElement.dataset.cursorRouting,
    };
  });
  async function check(label) {
    const state = await nativeState();
    report.checks.push({ label, ...state });
    assert.equal(state.visible, true, `${label}: native window disappeared while ${state.cards} card(s) remain`);
    assert.equal(state.focused, false, `${label}: completion window stole focus`);
  }
  async function route(onCard) {
    // This is the exact native command sent by the hover router. Browser hit-testing
    // is covered separately by check-completion-pointer.mjs; no OS input is injected.
    await page.evaluate(onCard => window.__TAURI_INTERNALS__.invoke(
      "plugin:window|set_ignore_cursor_events", { label: "completions", value: !onCard }), onCard);
    await check(onCard ? "capture" : "passthrough");
  }
  for (const turn of ["first", "after-empty"]) {
    await notify(turn);
    await until(() => page.locator(".completion-bubble").count().then(count => count === 1), "Notification did not render");
    await check(`${turn}: shown`);
    for (let repeat = 0; repeat < 3; repeat++) { await route(true); await route(false); }
    await page.evaluate(({ thread, turn }) => window.__TAURI_INTERNALS__.invoke("dismiss_completion", { threadId: thread, turnId: turn }), { thread, turn });
    await until(async () => !(await nativeState()).visible, "Empty completion window stayed visible");
    report.checks.push({ label: `${turn}: dismissed`, ...(await nativeState()) });
  }
  const readStatePath = path.join(home, ".codex-global-state.json");
  const publishReadState = unread => writeFile(readStatePath, JSON.stringify({
    "electron-thread-read-state-v1": { version: 1, unreadByIdentity: { account: { "local:isolated": unread } } },
  }));
  await publishReadState([]);
  await notify("missed-read-transition");
  await until(() => page.locator(".completion-bubble").count().then(count => count === 1), "Read-sync fixture did not render");
  await sleep(3500);
  await check("old read snapshot preserves new completion");
  // No unread observation is published: simulate opening the task before the poll.
  await publishReadState([]);
  await until(async () => !(await nativeState()).visible, "Fresh read snapshot did not clear the missed-transition notification");
  report.checks.push({ label: "missed unread transition reconciled", ...(await nativeState()) });

  await notify("new-turn-after-read");
  await until(() => page.locator(".completion-bubble").count().then(count => count === 1), "New-turn fixture did not render");
  await sleep(3500);
  await check("previous turn read snapshot preserves following turn");
  await route(true); await route(false);
  await publishReadState([thread]);
  const receipts = new DatabaseSync(path.join(inbox, "inbox.sqlite3"), { readOnly: true });
  try {
    await until(() => receipts.prepare("SELECT seen_unread FROM completion_unread_observations WHERE thread_id=? AND turn_id=?")
      .get(thread, "new-turn-after-read")?.seen_unread === 1, "Unread observation was not recorded");
    await publishReadState([]);
    await until(async () => !(await nativeState()).visible, "Observed read transition did not clear its completion");
    assert.equal(receipts.prepare("SELECT dismissed FROM completions WHERE thread_id=? AND turn_id=?")
      .get(thread, "missed-read-transition").dismissed, 1);
  } finally { receipts.close(); }
  report.checks.push({ label: "observed read transition reconciled", ...(await nativeState()) });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  if (page && !page.isClosed()) report.diagnostics = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
    card: document.querySelector(".completion-bubble")?.getBoundingClientRect().toJSON(),
  })).catch(() => null);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (native && native.exitCode === null) {
    const ended = new Promise(resolve => native.once("exit", resolve));
    native.kill();
    await ended;
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, checks: report.checks, diagnostics: report.diagnostics, report: path.join(output, "report.json") }));
}
