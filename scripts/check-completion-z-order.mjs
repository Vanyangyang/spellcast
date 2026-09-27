/** Isolated Windows Z-order regression.
 * Build first: npx tauri build --debug --no-bundle --config '{"identifier":"com.spellcast.board.nativecheck","build":{"beforeBuildCommand":""}}'
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

assert.equal(process.platform, "win32", "This regression checks Windows native window order.");
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.argv[2] ?? process.env.SPELLCAST_COMPLETION_TEST_EXE ?? path.join(repo, "src-tauri/target/debug/spellcast.exe");
const output = await mkdtemp(path.join(tmpdir(), "spellcast-z-order-"));
const home = path.join(output, "codex");
const inbox = path.join(home, "spellcast/completions");
await mkdir(inbox, { recursive: true });
const thread = "12345678-1234-4234-9234-123456789abc";
const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,source TEXT)");
db.prepare("INSERT INTO threads VALUES (?,?,?)").run(thread, "Window order regression", "vscode");
db.close();
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const appPort = await freePort();
const cdpPort = await freePort();
const env = { ...process.env, CODEX_HOME: home, SPELLCAST_COMPLETIONS_DIR: inbox,
  SPELLCAST_STATE_FILE: path.join(output, "board.sqlite3"), SPELLCAST_PORT: String(appPort),
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` };
async function notify(turn) {
  const payload = JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "turn-id": turn,
    cwd: repo, "input-messages": ["Window order regression"], "last-assistant-message": "Completion stays above a bubble." });
  const child = spawn(executable, ["--codex-notify", inbox, payload], { env, windowsHide: true, stdio: "ignore" });
  assert.equal(await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }), 0);
}
await notify("one");

const windowOrderScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SpellcastWindowOrder {
  public class Row { public int rank {get;set;} public string title {get;set;} public bool visible {get;set;} public bool focused {get;set;} public bool topmost {get;set;} }
  delegate bool Visit(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static Row[] Snapshot(uint target) {
    var rows = new List<Row>(); var focused = GetForegroundWindow(); int rank = 0;
    EnumWindows((hwnd, data) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid == target) {
        var title = new StringBuilder(256); GetWindowTextW(hwnd, title, title.Capacity);
        rows.Add(new Row { rank = rank, title = title.ToString(), visible = IsWindowVisible(hwnd), focused = hwnd == focused, topmost = (GetWindowLongW(hwnd, -20) & 8) != 0 });
      }
      rank++; return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
[SpellcastWindowOrder]::Snapshot([uint32]__PID__) | ConvertTo-Json -Compress
`;
function windows(pid) {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + windowOrderScript.replace("__PID__", String(pid))], { encoding: "utf8" }).trim();
  const rows = raw ? [JSON.parse(raw)].flat() : [];
  if (rows.some(row => typeof row.title !== "string")) throw new Error(`Unexpected native window data: ${raw}`);
  return rows;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 15000) {
  const started = Date.now();
  do { const value = await read(); if (value) return value; await sleep(150); } while (Date.now() - started < timeout);
  throw new Error(message);
}
let native, browser, stderr = "";
try {
  native = spawn(executable, [], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  native.stderr.on("data", chunk => { stderr += chunk.toString(); });
  await until(async () => {
    if (native.exitCode !== null) throw new Error(`Isolated app exited ${native.exitCode}: ${stderr}`);
    try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; }
  }, "Isolated WebView2 did not start; build with a different Tauri identifier from the installed app.");
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = () => browser.contexts().flatMap(context => context.pages());
  const completion = await until(() => pages().find(page => page.url().includes("completions.html")), "Completion WebView did not start");
  await completion.locator(".completion-bubble").waitFor();
  await until(() => windows(native.pid).some(row => row.title.includes("已完成的任务") && row.visible), "Completion native window did not show");
  const main = await until(() => pages().find(page => page.url().endsWith("/") || page.url().includes("index.html")), "Main WebView did not start");
  await completion.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    for (let index = 0; index < 8; index++) {
      await invoke("plugin:window|set_ignore_cursor_events", { label: "completions", value: false });
      await invoke("plugin:window|set_ignore_cursor_events", { label: "completions", value: true });
    }
    // Reproduce a lost topmost state while the inbox and card remain unchanged.
    await invoke("plugin:window|set_always_on_top", { label: "completions", value: false });
  });
  await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }));
  const aboveMain = await until(() => {
    const rows = windows(native.pid).filter(row => row.visible);
    const completionRow = rows.find(row => row.title.includes("已完成的任务"));
    const mainRow = rows.find(row => row.title === "Spellcast");
    return completionRow && mainRow && completionRow.topmost && completionRow.rank < mainRow.rank && mainRow.focused
      ? { completionRow, mainRow } : null;
  }, "A focused ordinary app window covered the completion");
  await completion.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|set_ignore_cursor_events", { label: "completions", value: false }));
  const response = await fetch(`http://127.0.0.1:${appPort}/api/bubble`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ tease: "Window order regression bubble", shape: "card", linger: 60 }) });
  assert.equal(response.ok, true, await response.text());
  const bubble = await until(() => pages().find(page => page.url().includes("bubble.html")), "Bubble WebView did not start");
  const check = () => {
    const rows = windows(native.pid).filter(row => row.visible);
    const completionRow = rows.find(row => row.title.includes("已完成的任务"));
    const bubbleRow = rows.find(row => row.title === "Spellcast Bubble");
    return completionRow && bubbleRow && completionRow.rank < bubbleRow.rank ? { completionRow, bubbleRow } : null;
  };
  const afterSpawn = await until(check, "Later bubble covered the completion window");
  await bubble.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label }));
  const afterFocus = await until(() => {
    const order = check();
    return order?.bubbleRow.focused ? order : null;
  }, "Focused bubble covered the completion or completion stole focus");
  await completion.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("plugin:window|set_ignore_cursor_events", { label: "completions", value: true });
    await invoke("plugin:window|set_ignore_cursor_events", { label: "completions", value: false });
  });
  const afterPointerRouting = await until(check, "Pointer-routing style changes hid or covered the completion");
  await completion.evaluate(({ thread }) => window.__TAURI_INTERNALS__.invoke("dismiss_completion", { threadId: thread, turnId: "one" }), { thread });
  await until(() => windows(native.pid).some(row => row.title.includes("已完成的任务") && !row.visible), "Completion window did not hide");
  await notify("two");
  await completion.locator('[data-turn="two"]').waitFor();
  const afterReturn = await until(() => {
    const order = check();
    return order?.bubbleRow.focused ? order : null;
  }, "Completion returning above a focused bubble changed focus or Z order");
  console.log(JSON.stringify({ result: "passed", aboveMain, afterSpawn, afterFocus, afterPointerRouting, afterReturn, output }));
} finally {
  if (browser) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label })); } catch {}
    }
    await browser.close();
  }
  if (native?.exitCode === null) {
    const ended = new Promise(resolve => native.once("exit", resolve));
    native.kill(); await ended;
  }
}
