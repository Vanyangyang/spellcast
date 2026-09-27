/**
 * Isolated native layout check for the debug app at 1600x900, 1320x860 and 880x640: the home
 * card, Settings (connection and display) and the Canvas opening view plus "Fit all". The app gets
 * its own identifier, port, database, completion inbox, Codex/Grok homes and WebView profile; it
 * never touches :47194 or the user's Spellcast data. Setup status reads the real USERPROFILE only.
 *
 *   npx tauri build --debug --no-bundle --features tauri/devtools --config '{"identifier":"com.spellcast.board.verify","build":{"beforeBuildCommand":"npm run build"}}'
 *   node scripts/check-ui-layout-native.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
// SPELLCAST_NATIVE_THEME=dark|light|system saves that preference in the sandboxed WebView before
// measuring ("system" follows this machine's OS scheme); screenshots then go to a per-theme folder.
const theme = process.env.SPELLCAST_NATIVE_THEME;
assert(!theme || ["dark", "light", "system"].includes(theme), "SPELLCAST_NATIVE_THEME must be dark, light or system");
const out = path.join(repo, "artifacts/ui-layout-native", theme ?? "");
await mkdir(out, { recursive: true });
const exe = path.resolve(repo, process.env.SPELLCAST_NATIVE_EXE ?? "src-tauri/target/debug/spellcast.exe");
const marked = execFileSync("powershell", ["-NoProfile", "-Command", `(Select-String -Path '${exe}' -Pattern 'com.spellcast.board.verify' -SimpleMatch -Quiet)`]).toString().trim();
assert.equal(marked, "True", "Build the debug app with the com.spellcast.board.verify identifier so it cannot reach an installed Spellcast");
const port = Number(process.env.SPELLCAST_NATIVE_PORT ?? 47332);
const cdp = Number(process.env.SPELLCAST_NATIVE_CDP ?? 9392);
assert(![47193, 47194].includes(port));
const sandbox = await mkdtemp(path.join(tmpdir(), "spellcast-layout-native-"));
const env = {
  ...process.env,
  SPELLCAST_PORT: String(port),
  SPELLCAST_STATE_FILE: path.join(sandbox, "board.sqlite3"),
  SPELLCAST_COMPLETIONS_DIR: path.join(sandbox, "completions"),
  CODEX_HOME: path.join(sandbox, "codex"),
  GROK_HOME: path.join(sandbox, "grok"),
};
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[name];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    try { const value = await read(); if (value) return value; } catch {}
    if (Date.now() - start > timeout) throw new Error(message);
    await sleep(150);
  }
}
let session, rpcId = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++rpcId }), method, params }),
  });
  session ??= response.headers.get("Mcp-Session-Id");
  const text = await response.text();
  assert(response.ok, text);
  if (!text.trim()) return undefined;
  const payload = JSON.parse(/^(event|data):/.test(text) ? text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n") : text);
  assert(!payload.error, JSON.stringify(payload));
  return payload.result;
}
const text = (id, title, body, x, y, width = 320, height = 200) => ({ op: "create", id, content: { type: "text", title, text: body }, placement: { x, y, width, height } });
const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const report = { evidence: "isolated debug build, native WebView2 window on this machine; synthetic Canvas fixture", sizes: {}, problems: [] };
let native, browser, main, invoke, launches = 0;
/** Each size gets a fresh app and WebView profile, so the Canvas opens without a carried-over camera. */
async function launch() {
  await stop();
  const debug = cdp + launches++;
  native = spawn(exe, [], { env: { ...env, WEBVIEW2_USER_DATA_FOLDER: path.join(sandbox, `webview-${launches}`), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debug}` }, stdio: "ignore" });
  await until(async () => (await fetch(`http://127.0.0.1:${debug}/json/version`)).ok, "native CDP did not start", 60000);
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
  main = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => new URL(p.url()).pathname === "/"), "main window did not load");
  await until(() => main.evaluate(() => Boolean(document.querySelector("#settings-open")?.textContent.trim())), "main window did not finish starting", 30000);
  if (theme) {
    await main.evaluate(t => localStorage.setItem("spellcast.theme", t), theme);
    await main.reload();
    await until(() => main.evaluate(() => Boolean(document.querySelector("#settings-open")?.textContent.trim())), "main window did not restart with the theme", 30000);
    report.theme = await main.evaluate(() => ({ preference: localStorage.getItem("spellcast.theme"), effective: document.body.dataset.theme, osDark: matchMedia("(prefers-color-scheme: dark)").matches }));
  }
  invoke = (command, args) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
  assert.equal((await invoke("bridge_status")).port, port, "The app must use the isolated port");
}
async function stop() {
  try { await browser?.close(); } catch {}
  if (native && native.exitCode === null) execFileSync("taskkill", ["/PID", String(native.pid), "/T", "/F"], { stdio: "ignore" });
  browser = undefined; native = undefined;
  await sleep(800);
}
try {
  await launch();
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ui-layout-native", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  const seeded = await rpc("tools/call", { name: "spellcast_canvas_batch", arguments: { source_id: "ui-layout-native", request_id: "seed", operations: [
    text("plan", "迁移计划 · 第一阶段", "先把显示器目标设置接到桌面气泡与完成通知；固定屏断开时回退活动屏。", 40, 40, 360, 220),
    text("risk", "Risks and open questions", "Mixed DPI layouts, portrait panels and a display that disconnects while a card is showing.", 440, 40, 340, 220),
    text("notes", "设计笔记", "深色画布、薄荷主色、淡紫强调。工具浮在内容之上，但不应压住卡片标题。", 40, 300, 360, 200),
    text("check", "验收清单", "1280 / 880 / 窄屏；主窗口、Canvas、气泡、完成弹窗。", 440, 300, 340, 200),
  ] } });
  assert(!seeded.isError, JSON.stringify(seeded));

  for (const [width, height] of [[1600, 900], [1320, 860], [880, 640]]) {
    if (Object.keys(report.sizes).length) await launch();
    const size = {};
    report.sizes[`${width}x${height}`] = size;
    await invoke("plugin:window|set_size", { label: "main", value: { Logical: { width, height } } });
    await until(() => main.evaluate(([w, h]) => innerWidth === w && innerHeight === h, [width, height]), `window did not reach ${width}x${height}`);
    await sleep(500);

    // Home card.
    size.savedCanvasViews = await main.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("spellcast.canvas-view")).length);
    await main.screenshot({ path: path.join(out, `home-${width}.png`) });
    size.home = await main.evaluate(() => {
      const card = document.querySelector("#agent"), r = card.getBoundingClientRect(), h1 = card.querySelector("h1");
      const bar = [...document.querySelectorAll(".top button, .top select")].map(n => n.getBoundingClientRect()).filter(b => b.width);
      return {
        cardWidth: Math.round(r.width),
        titleLines: Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight)),
        hiddenBelow: card.scrollHeight - card.clientHeight,
        underBar: bar.some(b => b.bottom > r.top && b.top < r.bottom && b.right > r.left && b.left < r.right),
        spill: [...card.querySelectorAll("*")].filter(n => n.getBoundingClientRect().right > r.right + 1).length,
      };
    });
    if (size.home.underBar) report.problems.push(`${width}: home card covers top bar controls`);
    if (size.home.spill) report.problems.push(`${width}: ${size.home.spill} home elements spill past the card`);

    // Settings panels.
    await main.evaluate(() => document.querySelector("#settings-open").click());
    size.settings = {};
    for (const tab of ["connection", "display"]) {
      await main.locator(`[data-settings-tab="${tab}"]`).click();
      await sleep(400);
      size.settings[tab] = await main.evaluate(t => {
        const sheet = document.querySelector(`#settings-panel-${t}`), edge = sheet.getBoundingClientRect().right + 1;
        return [...sheet.querySelectorAll("*")].filter(n => n.getBoundingClientRect().right > edge).length;
      }, tab);
      if (size.settings[tab]) report.problems.push(`${width}: ${size.settings[tab]} elements spill past settings/${tab}`);
      await main.screenshot({ path: path.join(out, `settings-${tab}-${width}.png`) });
    }
    await main.locator("#settings-close").click();

    // Canvas opening view (no saved camera), then Fit all.
    await main.locator("#mode-focus").click();
    await main.locator(".canvas-frame").first().waitFor({ timeout: 15000 });
    await sleep(700);
    const measure = all => main.evaluate(all => {
      const box = el => { const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
      const tools = [...document.querySelectorAll(".canvas-tool-rail, .canvas-tool-selection, .canvas-tool-camera, .canvas-scope, .top")].map(el => ({ name: el.className.replace("canvas-tool-group ", ""), box: box(el) })).filter(t => t.box);
      const heads = [...document.querySelectorAll(".canvas-frame-head, .canvas-native-heading")].filter(el => all || el.closest(".canvas-frame.is-selected")).map(el => ({ id: el.closest(".canvas-frame")?.getAttribute("data-item-id"), box: box(el) })).filter(h => h.box);
      return { tools, heads, composer: Math.round(document.querySelector(".composer").getBoundingClientRect().height), stage: Math.round(document.querySelector(".canvas-workspace").getBoundingClientRect().height) };
    }, all);
    const covered = geometry => geometry.heads.flatMap(head => geometry.tools.filter(tool => overlaps(head.box, tool.box)).map(tool => `${tool.name} × ${head.id}`));
    const opening = await measure(false);
    await main.screenshot({ path: path.join(out, `canvas-${width}.png`) });
    // The selected card's head carries its title and "Work inside": the dock must not repeat them while
    // that head is usable, and must offer them again once it is not (zoomed far out). Polls rather than
    // waiting on animation frames, which a covered window may not get.
    const dockState = () => main.evaluate(() => {
      const shown = selector => [...document.querySelectorAll(selector)].some(n => n.getClientRects().length > 0);
      return { head: shown(".canvas-frame.is-selected > .canvas-frame-head button"), title: shown(".canvas-tool-selection-title"), work: shown(".canvas-tool-selection > .canvas-selection-work") };
    });
    const settleDock = async want => { const start = Date.now(); let state; do { state = await dockState(); if (want(state)) break; await sleep(100); } while (Date.now() - start < 3000); return state; };
    const dockOpening = await settleDock(state => state.head && !state.title && !state.work);
    for (let i = 0; i < 6; i++) await main.locator(".canvas-tool-camera button").nth(1).click();
    const dockFar = await settleDock(state => state.title && state.work);
    await main.screenshot({ path: path.join(out, `canvas-far-${width}.png`) });
    if (!dockOpening.head) report.problems.push(`${width}: the selected card shows no head`);
    if (dockOpening.title || dockOpening.work) report.problems.push(`${width}: the dock repeats the selected card's title or Work inside`);
    if (!dockFar.title || !dockFar.work) report.problems.push(`${width}: zoomed far out, the dock does not offer the card's title and Work inside`);
    await main.locator(".canvas-tool-camera button").first().click();
    await sleep(400);
    const fit = await measure(true);
    await main.screenshot({ path: path.join(out, `canvas-fit-${width}.png`) });
    size.canvas = { stage: opening.stage, composer: opening.composer, openingCovered: covered(opening), fitCovered: covered(fit), dock: { opening: dockOpening, far: dockFar } };
    for (const hit of [...size.canvas.openingCovered, ...size.canvas.fitCovered]) report.problems.push(`${width}: tool covers card title ${hit}`);
    await main.locator("#mode-desktop").click();
    await main.locator("#agent").waitFor();
    console.log(`${width}x${height}: home ${size.home.cardWidth}px, title ${size.home.titleLines} line(s), ${size.home.hiddenBelow}px below the fold; canvas ${size.canvas.stage}px tall, composer ${size.canvas.composer}px`);
  }
  console.log(report.problems.length ? `Problems:\n- ${report.problems.join("\n- ")}` : "No overlap or spill problems in the native window.");
  if (report.problems.length) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  await stop();
  console.log(`screenshots and report: ${path.relative(repo, out)}; sandbox: ${sandbox}`);
}
