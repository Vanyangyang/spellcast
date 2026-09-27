/**
 * Isolated native check for the display target setting on a real multi-monitor Windows desktop.
 * The debug app gets its own identifier (so it never talks to an installed Spellcast through the
 * single-instance lock), its own port, database, completion inbox, Codex/Grok homes and WebView
 * profile. It never touches :47194 or the user's Spellcast data. USERPROFILE stays real because
 * WebView2 will not open its debugging port without it; the setup status panel only reads there. Disconnecting a display is not
 * exercised here; that fallback is covered by display_target.rs tests and check-display-target-ui.
 *
 *   npx tauri build --debug --no-bundle --config '{"identifier":"com.spellcast.board.verify","build":{"beforeBuildCommand":"npm run build"}}'
 *   node scripts/check-display-target-native.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "artifacts/display-target-native");
await mkdir(out, { recursive: true });
const exe = path.resolve(repo, process.env.SPELLCAST_NATIVE_EXE ?? "src-tauri/target/debug/spellcast.exe");
const strings = execFileSync("powershell", ["-NoProfile", "-Command", `(Select-String -Path '${exe}' -Pattern 'com.spellcast.board.verify' -SimpleMatch -Quiet)`]).toString().trim();
assert.equal(strings, "True", "Build the debug app with the com.spellcast.board.verify identifier so it cannot reach an installed Spellcast");
const port = Number(process.env.SPELLCAST_NATIVE_PORT ?? 47312);
const cdp = Number(process.env.SPELLCAST_NATIVE_CDP ?? 9372);
assert(![47193, 47194].includes(port));
const sandbox = await mkdtemp(path.join(tmpdir(), "spellcast-display-native-"));
const codex = path.join(sandbox, "codex");
const inbox = path.join(codex, "spellcast/completions");
await mkdir(inbox, { recursive: true });
const env = {
  ...process.env,
  SPELLCAST_PORT: String(port),
  SPELLCAST_STATE_FILE: path.join(sandbox, "board.sqlite3"),
  SPELLCAST_COMPLETIONS_DIR: inbox,
  CODEX_HOME: codex,
  GROK_HOME: path.join(sandbox, "grok"),
  WEBVIEW2_USER_DATA_FOLDER: path.join(sandbox, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdp}`,
};
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[name];
// Completion cards only show threads the (sandboxed) Codex state knows about.
const thread = "11111111-2222-4333-8444-555555555555";
const threads = new DatabaseSync(path.join(codex, "state_5.sqlite"));
threads.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, source TEXT)");
threads.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(thread, "显示器目标 · 原生验证", "vscode");
threads.close();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    try { const value = await read(); if (value) return value; } catch {}
    if (Date.now() - start > timeout) throw new Error(message);
    await sleep(150);
  }
}
/** Foreground window as "handle|process id|title", read-only. The user may switch apps meanwhile. */
const foreground = () => execFileSync("powershell", ["-NoProfile", "-Command", `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);'; $h=[W.U]::GetForegroundWindow(); $p=[uint32]0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$p); $s=New-Object System.Text.StringBuilder 256; [void][W.U]::GetWindowText($h,$s,256); "$h|$p|$s"`]).toString().trim();
/** Spellcast never takes the foreground: it stays with whatever app the user has in front. */
const notOurs = (line, what) => assert.notEqual(Number(line.split("|")[1]), native.pid, `${what}: the test app took the foreground (${line})`);

const report = { evidence: "isolated debug build on this machine's physical displays; synthetic bubble/notify input, no live host events", checks: [], skipped: [] };
const pass = name => { report.checks.push(name); console.log(`ok - ${name}`); };
let native, browser;
try {
  native = spawn(exe, [], { env, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  native.stderr.on("data", chunk => { errors += chunk; });
  await until(async () => {
    if (native.exitCode !== null) throw new Error(`app exited ${native.exitCode}: ${errors}`);
    return (await fetch(`http://127.0.0.1:${cdp}/json/version`)).ok;
  }, "native CDP did not start", 60000);
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
  const pages = () => browser.contexts().flatMap(context => context.pages());
  const main = await until(() => pages().find(page => new URL(page.url()).pathname === "/"), "main window did not load");
  await until(() => main.evaluate(() => Boolean(document.querySelector("#settings-open")?.textContent.trim())), "main window did not finish starting", 30000);
  const invoke = (command, args) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
  assert.equal((await invoke("bridge_status")).port, port, "The app must use the isolated port");

  const first = await invoke("display_target_report");
  report.screens = first.screens.map(({ id, number, label, x, y, width, height, scale, isPrimary }) => ({ id, number, label, x, y, width, height, scale, isPrimary }));
  assert.equal(first.target.mode, "active", "A fresh profile follows the active display");
  assert(first.windowScreen, "The main window's display is identified");
  pass(`native report lists ${first.screens.length} physical display(s) and the main window's display`);
  if (first.screens.length < 2) throw new Error("Only one display: multi-display placement cannot be verified here");

  const inside = (point, s) => point.x >= s.x && point.x < s.x + s.width && point.y >= s.y && point.y < s.y + s.height;
  const screenOf = point => first.screens.find(s => inside(point, s))?.id ?? null;
  const other = first.screens.find(s => s.id !== first.windowScreen);
  const home = first.screens.find(s => s.id === first.windowScreen);

  // Identify: move the main window to the other display without focusing it, then use the button.
  await invoke("plugin:window|set_position", { label: "main", value: { Physical: { x: other.x + 80, y: other.y + 80 } } });
  await until(async () => (await invoke("display_target_report")).windowScreen === other.id, "window display did not follow the move");
  await until(async () => {
    await main.evaluate(() => { if (!document.querySelector("#settings")?.open) document.querySelector("#settings-open").click(); });
    return main.locator('[data-settings-tab="display"]').isVisible();
  }, "settings did not open");
  await main.locator('[data-settings-tab="display"]').click();
  assert.equal(await main.locator('input[name="display-mode"]').count(), 2, "Only follow-active and fixed-display choices are shown");
  await main.locator(".display-tile").first().waitFor();
  await main.locator("#display-identify").click();
  await main.locator("#display-identified:not([hidden])").waitFor();
  assert.equal(await main.locator(".display-tile.is-identified").getAttribute("data-screen"), other.id);
  await main.screenshot({ path: path.join(out, "settings-identified.png") });
  await main.locator("#display-use-current").click();
  await main.locator('input[value="fixed"]:checked').waitFor();
  const fixed = await invoke("display_target_report");
  assert.equal(fixed.target.mode, "fixed");
  assert.equal(fixed.target.id, other.id);
  assert.equal(fixed.noticeScreen, other.id);
  await main.screenshot({ path: path.join(out, "settings-fixed.png") });
  pass(`identify names display ${other.number} holding the window, and one click fixes notices to it`);

  // Bring the window back so the fixed display differs from both the window and (usually) the foreground.
  await invoke("plugin:window|set_position", { label: "main", value: { Physical: { x: home.x + 80, y: home.y + 80 } } });
  await main.evaluate(() => document.querySelector("#settings .settings-head button, #settings-close")?.click());

  const position = label => invoke("plugin:window|outer_position", { label });
  const windowsNamed = prefix => pages().filter(page => page.url().includes(prefix));

  // A bubble lands on the fixed display.
  const bubbleResponse = await fetch(`http://127.0.0.1:${port}/api/bubble`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tease: "显示器目标验证", title: "Fixed display check", body: "Isolated synthetic bubble", screen: "primary", linger: 20 }),
  });
  assert(bubbleResponse.ok, await bubbleResponse.text());
  const bubblePage = await until(() => windowsNamed("bubble").at(-1), "bubble window did not appear");
  const bubbleLabel = await bubblePage.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  const bubbleAt = await position(bubbleLabel);
  report.bubble = { label: bubbleLabel, position: bubbleAt, screen: screenOf(bubbleAt) };
  assert.equal(report.bubble.screen, other.id, "A fixed display overrides the bubble's own primary aim");
  await sleep(1500);
  await bubblePage.screenshot({ path: path.join(out, "bubble-fixed.png") });
  pass(`bubble aimed at "primary" appears on fixed display ${other.number}`);

  // A completion card lands on the fixed display, stays on top and does not take focus.
  const before = foreground();
  const payload = JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "turn-id": "display-check", cwd: repo, "input-messages": ["显示器目标"], "last-assistant-message": "隔离的完成通知：应出现在固定显示器上，且不抢焦点。" });
  execFileSync(exe, ["--codex-notify", inbox, payload], { env, windowsHide: true });
  const card = await until(() => windowsNamed("completions.html")[0], "completion window did not appear");
  await card.locator(".completion-bubble").waitFor();
  await sleep(800);
  const after = foreground();
  const cardAt = await position("completions");
  report.completion = {
    position: cardAt, screen: screenOf(cardAt),
    alwaysOnTop: await invoke("plugin:window|is_always_on_top", { label: "completions" }),
    focused: await invoke("plugin:window|is_focused", { label: "completions" }),
    foregroundBefore: before, foregroundAfter: after,
  };
  assert.equal(report.completion.screen, other.id, "The completion card follows the fixed display");
  assert.equal(report.completion.alwaysOnTop, true);
  assert.equal(report.completion.focused, false, "The completion card must not take focus");
  notOurs(before, "before the card"); notOurs(after, "after the card");
  await card.screenshot({ path: path.join(out, "completion-fixed.png"), omitBackground: true });
  pass(`completion card appears on fixed display ${other.number}, always on top, without taking focus`);

  // Switching modes moves a visible card: follow-active uses the foreground window's display.
  const activeReport = await invoke("set_display_target", { target: { mode: "active" } });
  const active = activeReport.screens.find(s => s.isActive) ?? activeReport.screens[0];
  await until(async () => screenOf(await position("completions")) === active.id, "visible card did not move to the active display");
  assert.equal(activeReport.noticeScreen, active.id);
  pass(`follow-active moves the visible card to the active display ${active.number}`);

  const activeAgain = await invoke("set_display_target", { target: { mode: "active" } });
  assert.equal(activeAgain.target.mode, "active");
  report.foregroundAtEnd = foreground();
  notOurs(report.foregroundAtEnd, "after mode changes");
  pass("active rule remains selected and no step gave the foreground to Spellcast");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  try { await browser?.close(); } catch {}
  if (native && native.exitCode === null) execFileSync("taskkill", ["/PID", String(native.pid), "/T", "/F"], { stdio: "ignore" });
  console.log(`report: ${path.relative(repo, path.join(out, "report.json"))}; sandbox: ${sandbox}`);
}
