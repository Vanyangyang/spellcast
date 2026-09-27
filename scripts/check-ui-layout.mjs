/**
 * Isolated browser layout check for the main window, Canvas and settings at 1600/1320/880 and
 * narrow widths, including the Canvas selection dock (no repeated card title or "Work inside"), the
 * whole home card at the 880x640 desktop minimum (Chinese and English, dark and light) and the aside
 * explanation that folds on narrow windows (keyboard, width changes). It starts its own preview API on a temporary database and its own Vite
 * server, seeds the Canvas through MCP, and never contacts :47194 or the user's data.
 * Browser evidence only: native window placement is covered by the Tauri checks.
 *
 *   SPELLCAST_SERVER_EXE=target/debug/spellcast-server.exe node scripts/check-ui-layout.mjs [label]
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
const out = path.join(root, "artifacts/ui-layout", label);
await mkdir(out, { recursive: true });
const apiPort = Number(process.env.SPELLCAST_LAYOUT_API_PORT ?? 47296);
const webPort = Number(process.env.SPELLCAST_LAYOUT_WEB_PORT ?? 47297);
for (const port of [apiPort, webPort]) assert(![47193, 47194].includes(port), "Never use the user's ports");
const api = `http://127.0.0.1:${apiPort}`;
const origin = `http://127.0.0.1:${webPort}`;
const state = await mkdtemp(path.join(tmpdir(), "spellcast-layout-"));
const serverExe = path.resolve(root, process.env.SPELLCAST_SERVER_EXE ?? "target/debug/spellcast-server.exe");

const children = [];
const kill = child => { if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else child.kill(); };
children.push(spawn(serverExe, [], { env: { ...process.env, SPELLCAST_PORT: String(apiPort), SPELLCAST_STATE_FILE: path.join(state, "board.sqlite3") }, stdio: "ignore" }));
children.push(spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: root, shell: true, stdio: "ignore", env: { ...process.env, VITE_API_URL: api } }));

const until = async (read, what, timeout = 30000) => {
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
const call = async (name, args) => {
  const result = await rpc("tools/call", { name, arguments: args });
  assert(!result.isError, JSON.stringify(result));
  return result;
};

const text = (id, title, body, x, y, width = 320, height = 200) => ({ op: "create", id, content: { type: "text", title, text: body }, placement: { x, y, width, height } });

const shots = [];
const findings = {};
try {
  await until(async () => (await fetch(`${api}/api/health`)).ok, "Preview API");
  await until(async () => (await fetch(origin)).ok, "Vite");
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ui-layout-check", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  await call("spellcast_canvas_batch", {
    source_id: "ui-layout-fixture",
    request_id: "ui-layout-seed",
    operations: [
      text("plan", "迁移计划 · 第一阶段", "先把显示器目标设置接到桌面气泡与完成通知；固定屏断开时回退活动屏。", 40, 40, 360, 220),
      text("risk", "Risks and open questions", "Mixed DPI layouts, portrait panels and a display that disconnects while a card is showing.", 440, 40, 340, 220),
      text("notes", "设计笔记", "深色画布、薄荷主色、淡紫强调。工具浮在内容之上，但不应压住卡片标题。", 40, 300, 360, 200),
      text("check", "验收清单", "1280 / 880 / 窄屏；主窗口、Canvas、气泡、完成弹窗。", 440, 300, 340, 200),
    ],
  });

  const browser = await playwright.chromium.launch({ channel: "msedge", headless: true }).catch(() => playwright.chromium.launch({ headless: true }));
  // A cold Vite dev server transforms the whole module graph on the first visit, which can take
  // minutes on a busy machine. That is fixture start-up, not product load time: warm it once.
  {
    const context = await browser.newContext();
    await context.route("**/*", (route, request) => new URL(request.url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));
    await (await context.newPage()).goto(origin, { timeout: 300000 });
    await context.close();
  }
  const open = async ({ width, height, locale = "zh-CN", theme = "dark" }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route("**/*", async (route, request) => {
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin === api) {
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "*" } });
        // Node-side fetch keeps the isolated API's origin rules unchanged.
        const headers = { ...request.headers() };
        delete headers.origin; delete headers["sec-fetch-site"];
        const response = await route.fetch({ headers });
        return route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": origin } });
      }
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(([l, t]) => { localStorage.setItem("spellcast.locale", l); localStorage.setItem("spellcast.theme", t); }, [locale, theme]);
    const page = await context.newPage();
    await page.goto(origin, { timeout: 120000 });
    return page;
  };
  const shot = async (page, name) => { await page.screenshot({ path: path.join(out, name) }); shots.push(name); };
  const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  // The aside explanation after its first line: folded (a native <details>) on narrow windows, shown
  // without its toggle on wide ones. Content that is folded still counts as present.
  const observerState = page => page.evaluate(() => {
    const details = document.querySelector("#agent-observer-details"), summary = details.querySelector("summary");
    const content = [...details.querySelectorAll(":scope > :not(summary)")];
    const small = [...details.querySelectorAll("summary, li, p")].filter(n => n.checkVisibility() && parseFloat(getComputedStyle(n).fontSize) < 12).length;
    return {
      open: details.open,
      toggle: summary.checkVisibility(),
      shown: content.every(n => n.checkVisibility({ contentVisibilityAuto: true })),
      complete: content.length === 2 && content.every(n => n.textContent.trim().length > 20),
      small,
      focus: document.activeElement?.id || document.activeElement?.tagName,
    };
  });

  // Home card: how much of the window it uses, headline lines, and content left behind its own scroll.
  // The desktop minimum (880x640) must show the whole card in both languages and both themes.
  for (const [width, height, locale = "zh-CN", theme = "dark"] of [[1600, 900], [1320, 860], [880, 640], [880, 640, "zh-CN", "light"], [600, 760], [1320, 860, "en"], [880, 640, "en"], [880, 640, "en", "light"]]) {
    const variant = `${locale === "zh-CN" ? "" : `-${locale}`}${theme === "dark" ? "" : `-${theme}`}`;
    const page = await open({ width, height, locale, theme });
    await page.waitForFunction(() => document.querySelector("#agent h1")?.textContent.trim() && document.querySelector("#agent-setup-status")?.textContent.trim());
    await page.waitForTimeout(400);
    await shot(page, `home-${width}x${height}${variant}.png`);
    findings[`home-${width}${variant}`] = await page.evaluate(() => {
      const card = document.querySelector("#agent"), h1 = card.querySelector("h1"), r = card.getBoundingClientRect();
      const bar = [...document.querySelectorAll(".top button, .top select")].map(n => n.getBoundingClientRect()).filter(b => b.width);
      return {
        cardWidth: Math.round(r.width),
        share: +(r.width / innerWidth).toFixed(2),
        titleLines: Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight)),
        hiddenBelow: card.scrollHeight - card.clientHeight,
        visible: card.clientHeight,
        underBar: bar.some(b => b.bottom > r.top && b.top < r.bottom && b.right > r.left && b.left < r.right),
        spill: [...card.querySelectorAll("*")].filter(n => n.getBoundingClientRect().right > r.right + 1).map(n => n.id || n.className).slice(0, 5),
        smallText: [...card.querySelectorAll("*")].filter(n => n.checkVisibility() && [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 12).map(n => n.className || n.tagName).slice(0, 5),
      };
    });
    const observer = await observerState(page);
    findings[`home-${width}${variant}`].observer = observer;
    const narrow = width <= 1100;
    findings[`home-${width}${variant}`].observerProblems = [
      ...(narrow && (observer.open || !observer.toggle || observer.shown) ? ["the aside explanation is not folded by default"] : []),
      ...(!narrow && (observer.toggle || !observer.shown) ? ["the aside explanation is folded on a wide window"] : []),
      ...(!observer.complete ? ["the aside explanation lost content"] : []),
      ...(width === 880 && height === 640 && findings[`home-${width}${variant}`].hiddenBelow > 0 ? [`${findings[`home-${width}${variant}`].hiddenBelow}px of the card is hidden at the desktop minimum`] : []),
    ];
    await page.context().close();
  }

  // Keyboard and width changes: the switch is followed by the fold's toggle; Enter and Space work it;
  // widening shows everything and hands a focused toggle's focus to the switch; narrowing again
  // brings the toggle back with the reader's last choice.
  for (const locale of ["en", "zh-CN"]) {
    const page = await open({ width: 880, height: 640, locale });
    await page.waitForFunction(() => document.querySelector("#agent-setup-status")?.textContent.trim());
    await page.focus("#agent-observer-enabled");
    await page.keyboard.press("Tab");
    const steps = { tabbed: await observerState(page) };
    await page.keyboard.press("Enter");
    steps.enter = await observerState(page);
    steps.enterHidden = await page.evaluate(() => { const c = document.querySelector("#agent"); return c.scrollHeight - c.clientHeight; });
    await shot(page, `home-880x640${locale === "zh-CN" ? "" : `-${locale}`}-details-open.png`);
    await page.keyboard.press("Space");
    steps.space = await observerState(page);
    await page.keyboard.press("Space");
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.waitForTimeout(300);
    steps.wide = await observerState(page);
    await page.setViewportSize({ width: 880, height: 640 });
    await page.waitForTimeout(300);
    steps.narrowAgain = await observerState(page);
    const problems = [
      ...(steps.tabbed.focus !== "SUMMARY" || steps.tabbed.open ? ["Tab from the switch does not reach the folded explanation"] : []),
      ...(!steps.enter.open || !steps.enter.shown || steps.enter.small ? ["Enter does not unfold the whole explanation at 12px or more"] : []),
      ...(steps.space.open || steps.space.shown ? ["Space does not fold it again"] : []),
      ...(steps.wide.toggle || !steps.wide.open || !steps.wide.shown || steps.wide.focus !== "agent-observer-enabled" ? ["widening loses the explanation, its expanded state or the keyboard focus"] : []),
      ...(!steps.narrowAgain.toggle || !steps.narrowAgain.open || !steps.narrowAgain.shown ? ["narrowing again does not keep the reader's choice"] : []),
    ];
    findings[`home-observer-keys-${locale}`] = { steps, observerProblems: problems };
    await page.context().close();
  }

  for (const [width, height, theme, locale = "zh-CN"] of [[1600, 900, "dark"], [1320, 860, "dark"], [880, 640, "dark"], [880, 640, "light"], [880, 640, "dark", "en"]]) {
    const variant = `${theme === "dark" ? "" : `-${theme}`}${locale === "zh-CN" ? "" : `-${locale}`}`;
    const key = `${width}${variant}`;
    const page = await open({ width, height, theme, locale });
    // A fresh profile has no saved Canvas camera, so the opening view is the focus on the newest card.
    const savedViews = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("spellcast.canvas-view")));
    await page.locator("#mode-focus").click();
    await page.locator(".canvas-frame").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    await shot(page, `canvas-${width}x${height}${variant}.png`);
    const measure = () => page.evaluate(() => {
      const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
      const tools = [...document.querySelectorAll(".canvas-tool-rail, .canvas-tool-selection, .canvas-tool-camera, .canvas-scope, .top")].map(el => ({ name: el.className.replace("canvas-tool-group ", ""), box: box(el) })).filter(t => t.box);
      const heads = [...document.querySelectorAll(".canvas-frame-head, .canvas-native-heading")].map(el => ({ id: el.closest(".canvas-frame")?.getAttribute("data-item-id"), selected: Boolean(el.closest(".canvas-frame.is-selected")), box: box(el) })).filter(h => h.box);
      const composer = box(document.querySelector(".composer"));
      const stage = box(document.querySelector(".canvas-workspace"));
      const dim = [...document.querySelectorAll(".canvas-native-heading")].filter(h => {
        const [r, g, b] = getComputedStyle(h).color.match(/\d+/g).map(Number);
        return (r + g + b) / 3 > 128 !== (document.body.dataset.theme !== "light");
      }).length;
      return { tools, heads, composer, stage, dim, viewport: { width: innerWidth, height: innerHeight } };
    });
    const covered = (geometry, all) => geometry.heads.filter(h => all || h.selected).flatMap(head => geometry.tools.filter(tool => overlaps(head.box, tool.box)).map(tool => `${tool.name} × ${head.id}`));
    // The opening view focuses the newest card: its title must be clear. "Fit all" must clear every title.
    const geometry = await measure();
    const hits = covered(geometry, false);
    // The selected card's head carries its title and "Work inside": the dock must not repeat them while
    // that head is usable, and must offer them again once it is not (zoomed far out).
    const dock = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const shown = selector => [...document.querySelectorAll(selector)].some(n => n.getClientRects().length > 0);
      resolve({ head: shown(".canvas-frame.is-selected > .canvas-frame-head button"), title: shown(".canvas-tool-selection-title"), work: shown(".canvas-tool-selection > .canvas-selection-work") });
    }))));
    const dockOpening = await dock();
    for (let i = 0; i < 6; i++) await page.locator(".canvas-tool-camera button").nth(1).click();
    const dockFar = await dock();
    const dockProblems = [
      ...(!dockOpening.head ? ["the selected card shows no head"] : []),
      ...(dockOpening.title || dockOpening.work ? ["the dock repeats the selected card's title or Work inside"] : []),
      ...(!dockFar.title || !dockFar.work ? ["zoomed far out, the dock does not offer the card's title and Work inside"] : []),
    ];
    await page.locator(".canvas-tool-camera button").first().click();
    await page.waitForTimeout(300);
    await shot(page, `canvas-fit-${width}x${height}${variant}.png`);
    hits.push(...covered(await measure(), true).map(hit => `fit all: ${hit}`));
    findings[`canvas-${key}`] = { hits, dock: { opening: dockOpening, far: dockFar }, dockProblems, savedViews, headingsAgainstTheme: geometry.dim, composerShare: geometry.composer ? +(geometry.composer.height / geometry.viewport.height).toFixed(3) : 0, composer: geometry.composer, stage: geometry.stage, tools: geometry.tools };
    await page.context().close();
  }

  for (const [width, height, locale] of [[1600, 900, "zh-CN"], [1280, 860, "zh-CN"], [880, 640, "en"], [600, 760, "zh-CN"]]) {
    const page = await open({ width, height, locale });
    await page.evaluate(() => document.querySelector("#settings-open").click());
    for (const tab of ["connection", "display", "appearance", "shortcuts"]) {
      await page.locator(`[data-settings-tab="${tab}"]`).click();
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(t => {
        const sheet = document.querySelector(`#settings-panel-${t}`);
        const edge = sheet.getBoundingClientRect().right + 1;
        return [...sheet.querySelectorAll("*")].filter(n => n.getBoundingClientRect().right > edge).map(n => n.id || n.className).slice(0, 5);
      }, tab);
      findings[`settings-${width}-${tab}`] = { overflow };
      await shot(page, `settings-${tab}-${width}.png`);
    }
    await page.context().close();
  }
  await browser.close();
  const problems = Object.entries(findings).flatMap(([name, f]) => [
    ...(f.hits ?? []).map(hit => `${name}: tool covers card title ${hit}`),
    ...(f.dockProblems ?? []).map(problem => `${name}: ${problem}`),
    ...(f.headingsAgainstTheme ? [`${name}: ${f.headingsAgainstTheme} card headings do not contrast with the theme`] : []),
    ...(f.overflow ?? []).map(node => `${name}: ${node} spills past the panel`),
    ...(f.spill ?? []).map(node => `${name}: ${node} spills past the home card`),
    ...(f.underBar ? [`${name}: the home card covers top bar controls`] : []),
    ...(f.observerProblems ?? []).map(problem => `${name}: ${problem}`),
    ...(f.smallText?.length ? [`${name}: text below 12px (${f.smallText.join(", ")})`] : []),
  ]);
  await writeFile(path.join(out, "report.json"), JSON.stringify({ label, shots, findings, problems }, null, 2));
  for (const [name, f] of Object.entries(findings)) if ("hiddenBelow" in f) console.log(`${name}: card ${f.cardWidth}px (${Math.round(f.share * 100)}% of width), title ${f.titleLines} line(s), ${f.hiddenBelow}px below the fold of ${f.visible}px; aside explanation ${f.observer.toggle ? (f.observer.open ? "unfolded" : "folded") : "shown in full"}`);
  for (const [name, f] of Object.entries(findings)) if (f.steps) console.log(`${name}: Tab → ${f.steps.tabbed.focus}, Enter → ${f.steps.enter.open ? "open" : "closed"} (${f.steps.enterHidden}px then scrolls), Space → ${f.steps.space.open ? "open" : "closed"}, wide → ${f.steps.wide.shown ? "shown" : "hidden"} with focus on ${f.steps.wide.focus}, narrow again → ${f.steps.narrowAgain.open ? "open" : "closed"}`);
  for (const [name, f] of Object.entries(findings)) if (f.stage) console.log(`${name}: canvas ${Math.round(f.stage.height)}px tall, composer ${Math.round(f.composer.height)}px (${(f.composerShare * 100).toFixed(1)}% of window)`);
  console.log(problems.length ? `\nProblems:\n- ${problems.join("\n- ")}` : "\nNo overlap, contrast or overflow problems found.");
  console.log(`${shots.length} screenshots in ${path.relative(root, out)}`);
  if (problems.length && !process.env.SPELLCAST_LAYOUT_REPORT_ONLY) process.exitCode = 1;
} finally {
  children.forEach(kill);
}
