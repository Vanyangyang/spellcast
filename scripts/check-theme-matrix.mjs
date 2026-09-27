/**
 * Theme matrix for the main window: dark, light and system (with the OS scheme emulated as dark and as
 * light) × 1600x900, 1320x860, 880x640 × home, settings (connection, display, opened from home and from
 * the Canvas) and the Canvas. Builds the app into a temporary folder with its own API URL, serves it
 * with `vite preview`, runs a preview API on a temporary database and never contacts :47193/:47194 or
 * the user's data. Records screenshots, horizontal spill and computed-style probes that show whether
 * actions, choices and status use one visual language across views. Browser evidence only.
 *
 *   SPELLCAST_SERVER_EXE=target/debug/spellcast-server.exe node scripts/check-theme-matrix.mjs [label]
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.argv[2] ?? "current";
const out = path.join(root, "artifacts/theme-matrix", label);
await mkdir(out, { recursive: true });
const apiPort = Number(process.env.SPELLCAST_MATRIX_API_PORT ?? 47356);
const webPort = Number(process.env.SPELLCAST_MATRIX_WEB_PORT ?? 47357);
for (const port of [apiPort, webPort]) assert(![47193, 47194].includes(port), "Never use the user's ports");
const api = `http://127.0.0.1:${apiPort}`;
const origin = `http://127.0.0.1:${webPort}`;
const state = await mkdtemp(path.join(tmpdir(), "spellcast-matrix-"));
const dist = await mkdtemp(path.join(tmpdir(), "spellcast-matrix-dist-"));
const serverExe = path.resolve(root, process.env.SPELLCAST_SERVER_EXE ?? "target/debug/spellcast-server.exe");
const vite = path.join(root, "node_modules/vite/bin/vite.js");

const children = [];
const kill = child => { if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else child.kill(); };
const until = async (read, what, timeout = 60000) => {
  const start = Date.now();
  for (;;) {
    try { const value = await read(); if (value) return value; } catch {}
    if (Date.now() - start > timeout) throw new Error(`${what} did not start`);
    await new Promise(r => setTimeout(r, 200));
  }
};

let session, rpcId = 0;
async function rpc(method, params, notification = false) {
  const response = await fetch(`${api}/mcp`, {
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
const card = (id, title, body, x, y, width = 340, height = 200) => ({ op: "create", id, content: { type: "text", title, text: body }, placement: { x, y, width, height } });

const report = { label, evidence: "production build via vite preview, isolated preview API, headless Edge; OS scheme emulated for system mode", modes: {}, problems: [] };
try {
  children.push(spawn(serverExe, [], { env: { ...process.env, SPELLCAST_PORT: String(apiPort), SPELLCAST_STATE_FILE: path.join(state, "board.sqlite3") }, stdio: "ignore" }));
  const built = spawn(process.execPath, [vite, "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: root, stdio: "inherit", env: { ...process.env, VITE_API_URL: api } });
  const code = await new Promise(resolve => built.on("exit", resolve));
  assert.equal(code, 0, "vite build failed");
  children.push(spawn(process.execPath, [vite, "preview", "--outDir", dist, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: root, stdio: "ignore" }));
  await until(async () => (await fetch(`${api}/api/health`)).ok, "Preview API");
  await until(async () => (await fetch(origin)).ok, "vite preview");
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "theme-matrix", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  await rpc("tools/call", { name: "spellcast_canvas_batch", arguments: { source_id: "theme-matrix", request_id: "seed", operations: [
    card("plan", "迁移计划 · 第一阶段", "先把显示器目标设置接到桌面气泡与完成通知；固定屏断开时回退活动屏。", 40, 40, 360, 220),
    card("risk", "Risks and open questions", "Mixed DPI layouts, portrait panels and a display that disconnects while a card is showing.", 440, 40, 340, 220),
    card("notes", "设计笔记", "深色画布、薄荷主色、淡紫强调。工具浮在内容之上，但不应压住卡片标题。", 40, 300, 360, 200),
    card("check", "验收清单", "1600 / 1320 / 880；深色、浅色与跟随系统。", 440, 300, 340, 200),
  ] } });

  const browser = await playwright.chromium.launch({ channel: "msedge", headless: true }).catch(() => playwright.chromium.launch({ headless: true }));
  const open = async ({ width, height, theme, scheme, locale = "zh-CN" }) => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    await context.route("**/*", async (route, request) => {
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin === api) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "*" } });
        const headers = { ...request.headers() };
        delete headers.origin; delete headers["sec-fetch-site"];
        const response = await route.fetch({ headers });
        return route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": origin } });
      }
      report.blocked ??= new Set(); report.blocked.add(url.origin);
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(([t, l]) => { localStorage.setItem("spellcast.locale", l); localStorage.setItem("spellcast.theme", t); }, [theme, locale]);
    const page = await context.newPage();
    await page.goto(origin, { timeout: 120000 });
    return page;
  };
  // Read-only probes: what a user would compare when moving between views.
  const probe = page => page.evaluate(() => {
    const look = selector => {
      const node = [...document.querySelectorAll(selector)].find(n => n.getClientRects().length);
      if (!node) return null;
      const s = getComputedStyle(node);
      return { background: s.backgroundColor, color: s.color, border: s.borderTopColor, radius: s.borderTopLeftRadius, font: `${s.fontWeight} ${s.fontSize} ${s.fontFamily.split(",")[0]}` };
    };
    return {
      theme: document.body.dataset.theme,
      primary: look("#mode-focus") ?? look("#send"),
      setupPrimary: look("#agent-complete-setup") ?? look("#settings-complete-setup"),
      topGhost: look(".top-tools button.ghost:not(.primary)"),
      chosenChip: look(".agent-clients button.is-on"),
      statusDot: look("#agent-dot"),
      caption: look(".agent-setup-checks-note") ?? look("#settings .hint"),
    };
  });
  const spill = (page, selector) => page.evaluate(sel => {
    const box = document.querySelector(sel)?.getBoundingClientRect();
    if (!box) return [];
    return [...document.querySelectorAll(`${sel} *`)].filter(n => n.getClientRects().length && n.getBoundingClientRect().right > box.right + 1).map(n => n.id || n.className || n.tagName).slice(0, 5);
  }, selector);
  const overflowX = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

  const modes = [["dark", "dark", "dark"], ["light", "light", "light"], ["system-dark", "system", "dark"], ["system-light", "system", "light"]];
  for (const [mode, theme, scheme] of modes) {
    report.modes[mode] = {};
    for (const [width, height] of [[1600, 900], [1320, 860], [880, 640]]) {
      const size = {}; report.modes[mode][`${width}x${height}`] = size;
      const page = await open({ width, height, theme, scheme });
      const shot = name => page.screenshot({ path: path.join(out, `${name}-${mode}-${width}.png`) });
      await page.waitForFunction(() => document.querySelector("#agent h1")?.textContent.trim() && document.querySelector("#agent-setup-status")?.textContent.trim());
      await page.waitForTimeout(500);
      await shot("home");
      size.home = { ...(await probe(page)), spill: await spill(page, "#agent"), overflowX: await overflowX(page),
        hiddenBelow: await page.evaluate(() => { const c = document.querySelector("#agent"); return c.scrollHeight - c.clientHeight; }) };
      if (size.home.theme !== scheme) report.problems.push(`${mode} ${width}: body theme is ${size.home.theme}, expected ${scheme}`);

      const settingsPass = async where => {
        await page.evaluate(() => document.querySelector("#settings-open").click());
        await page.locator("#settings[open]").waitFor();
        const result = {};
        for (const tab of ["connection", "display"]) {
          await page.locator(`[data-settings-tab="${tab}"]`).click();
          await page.waitForTimeout(250);
          result[tab] = { spill: await spill(page, `#settings-panel-${tab}`) };
          await shot(`settings-${where}-${tab}`);
        }
        result.probe = await page.evaluate(() => {
          const node = document.querySelector("#settings-complete-setup"), s = getComputedStyle(node);
          const close = getComputedStyle(document.querySelector("#settings-close"));
          const sheet = getComputedStyle(document.querySelector("#settings .settings-sheet"));
          return { primary: s.backgroundColor, primaryText: s.color, closeRadius: close.borderTopLeftRadius, sheet: sheet.backgroundColor };
        });
        await page.locator("#settings-close").click();
        return result;
      };
      size.settingsFromHome = await settingsPass("home");

      await page.locator("#mode-focus").click();
      await page.locator(".canvas-frame").first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(700);
      await shot("canvas");
      size.canvas = { ...(await probe(page)), overflowX: await overflowX(page),
        topGhost: await page.evaluate(() => { const s = getComputedStyle(document.querySelector("#mode-desktop")); return { radius: s.borderTopLeftRadius, color: s.color, border: s.borderTopColor }; }),
        selection: await page.evaluate(() => getComputedStyle(document.querySelector(".canvas-frame.is-selected") ?? document.body).outlineColor) };
      if (!(await page.locator("#settings-open").isVisible())) await page.locator(".top-more > summary").click();
      size.settingsFromCanvas = await settingsPass("canvas");
      for (const [where, pass] of [["home", size.settingsFromHome], ["canvas", size.settingsFromCanvas]])
        for (const tab of ["connection", "display"]) for (const node of pass[tab].spill) report.problems.push(`${mode} ${width}: ${node} spills past settings/${tab} (${where})`);
      for (const node of size.home.spill) report.problems.push(`${mode} ${width}: ${node} spills past the home card`);
      if (size.home.overflowX || size.canvas.overflowX) report.problems.push(`${mode} ${width}: the page scrolls sideways`);
      await page.context().close();
    }
  }
  // English at the desktop minimum and just below it: the top bar should stay on one row (its secondary
  // actions fold into an accessible "More" menu), and the settings tabs should not wrap at 820px.
  report.english = {};
  const barRows = page => page.evaluate(() => {
    const items = [...document.querySelectorAll(".top button, .top select, .top summary, .top .brand")].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden");
    const bands = [];
    for (const top of items.map(n => n.getBoundingClientRect().top).sort((a, b) => a - b)) if (!bands.length || top - bands.at(-1) > 12) bands.push(top);
    return { rows: bands.length, compact: Boolean(document.querySelector(".top-more.is-compact")) };
  });
  for (const [mode, theme, scheme] of modes) {
    const entry = report.english[mode] = {};
    const page = await open({ width: 880, height: 640, theme, scheme, locale: "en" });
    await page.waitForFunction(() => document.documentElement.lang === "en" && document.querySelector("#agent-setup-status")?.textContent.trim());
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `home-en-${mode}-880.png`) });
    entry.home = { ...(await barRows(page)), spill: await spill(page, "#agent"), overflowX: await overflowX(page),
      hiddenBelow: await page.evaluate(() => { const c = document.querySelector("#agent"); return c.scrollHeight - c.clientHeight; }) };
    if (entry.home.rows > 1) report.problems.push(`en ${mode} 880: the top bar wraps onto ${entry.home.rows} rows`);
    if (entry.home.compact) {
      // The folded actions must stay reachable by pointer and keyboard.
      const summary = page.locator(".top-more > summary");
      entry.menuLabel = await summary.getAttribute("aria-label");
      await summary.click();
      entry.menuOpens = await page.locator("#settings-open").isVisible() && await page.locator("#memory-open").isVisible() && await page.locator("#feedback-open").isVisible();
      await page.screenshot({ path: path.join(out, `home-en-${mode}-880-menu.png`) });
      await page.keyboard.press("Escape");
      entry.menuClosesOnEscape = !(await page.locator("#settings-open").isVisible());
      if (!entry.menuLabel || !entry.menuOpens || !entry.menuClosesOnEscape) report.problems.push(`en ${mode} 880: the More menu is not usable (${JSON.stringify({ label: entry.menuLabel, opens: entry.menuOpens, escape: entry.menuClosesOnEscape })})`);
    }
    for (const node of entry.home.spill) report.problems.push(`en ${mode} 880: ${node} spills past the home card`);
    await page.setViewportSize({ width: 820, height: 760 });
    await page.evaluate(() => document.querySelector("#settings-open").click());
    await page.locator("#settings[open]").waitFor();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.waitForTimeout(250);
    // Count the text's own line boxes: grid rows stretch every tab to the tallest one.
    entry.tabs = await page.evaluate(() => [...document.querySelectorAll("#settings [role=tab]")].map(tab => {
      const range = document.createRange(); range.selectNodeContents(tab);
      return { text: tab.textContent.trim(), lines: new Set([...range.getClientRects()].map(r => Math.round(r.top))).size };
    }));
    for (const tab of entry.tabs) if (tab.lines > 1) report.problems.push(`en ${mode} 820: settings tab "${tab.text}" wraps onto ${tab.lines} lines`);
    await page.screenshot({ path: path.join(out, `settings-en-${mode}-820.png`) });
    await page.context().close();
  }
  await browser.close();
  if (report.blocked) report.blocked = [...report.blocked];
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  for (const [mode, sizes] of Object.entries(report.modes)) {
    const s = sizes["1320x860"];
    console.log(`${mode}: home primary ${s.home.primary?.background} r${s.home.primary?.radius} · setup ${s.home.setupPrimary?.background} · canvas send ${s.canvas.primary?.background} · settings(home) ${s.settingsFromHome.probe.primary} · settings(canvas) ${s.settingsFromCanvas.probe.primary}`);
    console.log(`${"".padEnd(mode.length)}  top bar radius home ${s.home.topGhost?.radius} / canvas ${s.canvas.topGhost.radius} · chosen chip ${s.home.chosenChip?.background} · dot ${s.home.statusDot?.background} · caption ${s.home.caption?.font}`);
    console.log(`${"".padEnd(mode.length)}  home below the fold: ${Object.entries(sizes).map(([k, v]) => `${k} ${v.home.hiddenBelow}px`).join(", ")}`);
  }
  for (const [mode, entry] of Object.entries(report.english)) console.log(`en ${mode}: 880 top bar ${entry.home.rows} row(s)${entry.home.compact ? " (More menu)" : ""}, home ${entry.home.hiddenBelow}px below the fold; 820 tabs ${entry.tabs.map(t => `${t.text}:${t.lines}`).join(", ")}`);
  console.log(report.problems.length ? `\nProblems:\n- ${report.problems.join("\n- ")}` : "\nNo spill, sideways scroll or theme mismatch.");
  console.log(`screenshots and report: ${path.relative(root, out)}`);
  if (report.problems.length && !process.env.SPELLCAST_MATRIX_REPORT_ONLY) process.exitCode = 1;
} finally {
  children.forEach(kill);
}
