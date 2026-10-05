/** Headless per-client completion card regression. Never opens a native window or moves the system cursor.
 *  Serves the real completions page (own Vite server unless SPELLCAST_TEST_URL is set) with the Tauri bridge mocked. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

let vite;
let url = process.env.SPELLCAST_TEST_URL;
if (!url) {
  const { createServer } = await import("vite");
  const port = await freePort();
  vite = await createServer({
    root: repo, configFile: path.join(repo, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port, strictPort: true, warmup: { clientFiles: [] } },
  });
  await vite.listen();
  url = `http://127.0.0.1:${port}/completions.html`;
}

const LONG_TITLE = "给不同客户端的完成提示换不同的 UI 风格并保证同时出现时能分清，同时检查标题超长时是否仍只占一行";
// A real final reply, longer than three lines at the card's width: the card clamps it instead of cutting at a fixed length.
const LONG_REPLY = "两个问题都修了，测试全部通过。先回答“是不是同一个问题”：不是。一个是插件没启动，另一个是旧版本根本不处理卡片跳转请求，所以双击后一直报错。新版要重新打包、重启 CC GUI 之后才生效，现在还都没提交。";
// Newest first, interleaved: the order a real stack arrives in. `windsurf` stands for any client without its own look.
const fixtures = [
  ["claude", "claude-1", LONG_TITLE], ["codex", "codex-1", LONG_TITLE],
  ["grok", "grok-1", LONG_TITLE], ["windsurf", "other-1", "Unknown client"],
  // A Claude task whose CC GUI window is connected (completions.rs marks it): the card can go back to the chat.
  ["claude", "claude-host", LONG_TITLE, { host: "ccgui" }],
  // No session name yet (a Claude task before the auto-title plugin ran) and a name that only repeats the project:
  // neither shows a context line.
  ["claude", "claude-unnamed", ""], ["grok", "grok-same", "Spellcast"],
].map(([client, id, title, extra], index) => ({
  thread_id: id, turn_id: `turn-${index}`, title, summary: LONG_REPLY, project: "Spellcast",
  completed_at_ms: Date.now() - index, client, ...extra,
}));

const channel = process.env.SPELLCAST_TEST_BROWSER_CHANNEL ?? "chrome";
const browser = await playwright.chromium.launch({ headless: true, channel, args: ["--no-proxy-server"] });
try {
  const page = await browser.newPage({ viewport: { width: 340, height: 900 } });
  await page.addInitScript(items => {
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "completions" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args = {}) => {
        if (command === "get_completions") return items;
        if (command === "open_completed_task") { await new Promise(resolve => setTimeout(resolve, 400)); return null; }
        if (command === "get_completion_voice") return { enabled: false, supported: true, volume: 15, cooldown_seconds: 90, quiet_hours: "23:00-08:00" };
        if (command === "set_ui_locale") return "zh-CN";
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:window|inner_position") return { x: 0, y: 0 };
        if (command === "plugin:window|scale_factor") return 1;
        if (command === "plugin:window|cursor_position") return { x: -100, y: -100 };
        if (command === "plugin:window|set_ignore_cursor_events") return null;
        throw new Error(`Unexpected mocked command: ${command}`);
      },
    };
  }, fixtures);
  const problems = [];
  page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
  const started = Date.now();
  await page.goto(url, { waitUntil: "commit", timeout: 240000 });
  // A cold Vite server pre-bundles dependencies on the first visit (about 90s here); later runs reuse the cache.
  await page.locator(".completion-bubble").nth(fixtures.length - 1).waitFor({ timeout: 240000 })
    .catch(async error => {
      const state = await page.evaluate(() => [...document.querySelectorAll(".completion-bubble")].map(card => {
        const box = card.getBoundingClientRect(), style = getComputedStyle(card);
        return `${card.dataset.client} ${Math.round(box.width)}x${Math.round(box.height)} display=${style.display} visibility=${style.visibility}`;
      })).catch(() => ["(unreadable)"]);
      throw new Error(`${error.message}\n${problems.join("\n") || "(no page errors)"}\ncards: ${state.join(" | ")}`);
    });
  console.log(`cards rendered after ${Date.now() - started}ms`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  // SPELLCAST_CARD_SHOT=<file.png> keeps a picture of the stack for looking at, not for asserting.
  if (process.env.SPELLCAST_CARD_SHOT) await page.screenshot({ path: process.env.SPELLCAST_CARD_SHOT, fullPage: true });

  const cards = await page.evaluate(() => {
    // color-mix() computes to `color(srgb 0.5 0.9 0.8 / 0.6)` (0..1); plain colours compute to rgba() (0..255).
    const rgba = value => {
      const numbers = value.replace(/^[a-z-]+\(\s*(srgb)?/i, "").match(/[\d.]+/g).map(Number);
      return value.startsWith("color(") ? numbers.map((n, i) => (i < 3 ? n * 255 : n)) : numbers;
    };
    return [...document.querySelectorAll(".completion-bubble")].map(card => {
      const style = getComputedStyle(card);
      const colorOf = selector => getComputedStyle(card.querySelector(selector)).color;
      const px = (selector, property) => parseFloat(getComputedStyle(card.querySelector(selector))[property]);
      return {
        client: card.dataset.client,
        titleHidden: card.querySelector(".title").hidden,
        titleText: card.querySelector(".title").textContent,
        titleSize: px(".title", "fontSize"), summarySize: px(".summary", "fontSize"),
        titleHeight: card.querySelector(".title").getBoundingClientRect().height,
        summaryHeight: card.querySelector(".summary").getBoundingClientRect().height,
        summaryLine: px(".summary", "lineHeight"),
        summaryText: card.querySelector(".summary").textContent,
        origin: card.querySelector(".origin").textContent,
        hint: card.querySelector(".hint").textContent,
        aria: card.querySelector(".task").getAttribute("aria-label"),
        height: card.getBoundingClientRect().height,
        corners: [style.borderTopLeftRadius, style.borderBottomRightRadius],
        background: rgba(style.backgroundColor),
        image: style.backgroundImage,
        colors: Object.fromEntries([".title", ".summary", ".project", ".done", ".hint", ".origin", ".error"].map(s => [s, rgba(colorOf(s))])),
        statusOverflow: card.querySelector(".status").scrollWidth - card.querySelector(".status").clientWidth,
      };
    });
  });
  const [claude, codex, grok, other, hosted, unnamed, sameAsProject] = cards;

  assert.deepEqual(cards.map(c => c.client), ["claude", "codex", "grok", "codex", "claude", "claude", "grok"], "Each client keeps its own card; unknown clients fall back to Codex");
  assert.deepEqual(cards.map(c => c.origin), ["Claude", "Codex", "Grok", "Codex", "Claude", "Claude", "Grok"]);

  // The reply is the card's subject; the task's name is one small, quiet line above it, or absent.
  for (const card of [claude, codex, grok, other, hosted]) {
    assert(!card.titleHidden && card.titleText, `${card.client}: a named task shows its name`);
    assert(card.summarySize > card.titleSize, `${card.client}: reply ${card.summarySize}px must outrank the name ${card.titleSize}px`);
    assert(card.titleHeight < card.titleSize * 1.5, `${card.client}: the name is one line, not ${card.titleHeight}px tall`);
    assert(card.summaryHeight > card.summaryLine * 2.5 && card.summaryHeight < card.summaryLine * 3.5, `${card.client}: a long reply fills exactly three lines, got ${card.summaryHeight}px at ${card.summaryLine}px`);
    assert.equal(card.summaryText, LONG_REPLY, `${card.client}: the whole reply is in the page; the clamp only hides the overflow`);
  }
  for (const card of [unnamed, sameAsProject]) assert(card.titleHidden && !card.titleText, `${card.client}: no context line without a distinct name (${card.titleText})`);
  // A card that can go back to CC GUI says so, in the hint and the accessible name; one that cannot still only closes.
  assert(/CC GUI/.test(hosted.hint) && !/关闭|dismiss/i.test(hosted.hint), `hosted hint: ${hosted.hint}`);
  assert(/CC GUI/.test(hosted.aria) && !/Codex/.test(hosted.aria), `hosted aria: ${hosted.aria}`);
  assert(/关闭|dismiss/i.test(claude.hint) && !/CC GUI/.test(claude.hint), `plain Claude hint: ${claude.hint}`);
  assert.deepEqual(hosted.corners, claude.corners, "Opening in CC GUI does not change the Claude look");
  assert(claude.hint.includes("Claude") && !claude.hint.includes("Codex"), `Claude hint names Claude: ${claude.hint}`);
  assert(grok.hint.includes("Grok Build"), `Grok hint names Grok Build: ${grok.hint}`);
  assert(codex.hint.includes("Codex"), `Codex hint names Codex: ${codex.hint}`);
  assert(claude.aria.includes("Claude") && grok.aria.includes("Grok Build") && codex.aria.includes("Codex"), "Accessible names name the client");

  // The three looks must differ in shape and in material, not only in hue.
  const BUDGET = 148.6; // px per card: window sizing allows 148 (160 with the gap), completions.rs
  assert.deepEqual(claude.corners, ["14px", "14px"], "Claude: soft rounded card");
  assert.deepEqual(grok.corners, ["4px", "4px"], "Grok: square console slab");
  assert.deepEqual(codex.corners, ["20px", "20px"], "Codex: round aurora-glass card");
  assert.equal(new Set([claude.corners[0], codex.corners[0], grok.corners[0]]).size, 3, "Every client has its own corner radius");
  assert.deepEqual(other.corners, codex.corners, "Unknown clients share the Codex shape");
  const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const lin = channel => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  assert(luminance(claude.background) > 0.6, "Claude is the light card");
  assert(luminance(codex.background) < 0.05 && luminance(grok.background) < 0.05, "Codex and Grok stay dark");
  assert.notDeepEqual(codex.background, grok.background);
  // The two dark cards still differ in material: Codex glass leans indigo, Grok is neutral black.
  assert(codex.background[2] - codex.background[0] >= 15, `Codex glass is indigo: ${codex.background}`);
  assert(grok.background[2] - grok.background[0] <= 6, `Grok slab is neutral black: ${grok.background}`);
  assert.equal((codex.image.match(/linear-gradient/g) ?? []).length, 2, `Codex card has a glass layer and a gradient rim: ${codex.image}`);
  assert.notDeepEqual(codex.colors[".origin"], grok.colors[".origin"]);
  assert.notDeepEqual(claude.colors[".origin"], codex.colors[".origin"]);

  // Every text colour stays readable on its own card (alpha composited over the card's colour).
  const over = ([r, g, b, a = 1], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
  const contrast = (fg, bg) => {
    const [hi, lo] = [luminance(over(fg, bg)), luminance(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const card of [claude, codex, grok, hosted]) {
    for (const [selector, color] of Object.entries(card.colors)) {
      assert(contrast(color, card.background) >= 4.5, `${card.client} ${selector} contrast ${contrast(color, card.background).toFixed(2)}:1`);
    }
    // The reply reads stronger than the name above it, not only larger.
    assert(contrast(card.colors[".summary"], card.background) > contrast(card.colors[".title"], card.background), `${card.client}: reply must be the highest-contrast text`);
  }

  // Window height is budgeted per card (completions.rs); no look may be taller than that budget.
  for (const card of [claude, codex, grok, hosted]) assert(card.height <= BUDGET, `${card.client} card is ${card.height}px, budget ${BUDGET}px`);
  for (const card of cards) assert.equal(card.statusOverflow, 0, `${card.client} status row overflows by ${card.statusOverflow}px`);

  // While a double-click works, the card names what it is doing: returning to CC GUI, or just closing.
  const hostedCard = page.locator('.completion-bubble[data-thread="claude-host"]');
  await hostedCard.locator(".task").dblclick();
  const opening = await hostedCard.locator(".hint").textContent();
  assert(/CC GUI/.test(opening) && !/Codex/.test(opening), `opening hint: ${opening}`);
  await page.waitForFunction(() => document.querySelector('.completion-bubble[data-thread="claude-host"]')?.classList.contains("dismissing"));
  const plainCard = page.locator('.completion-bubble[data-thread="claude-1"]');
  await plainCard.locator(".task").dblclick();
  const closing = await plainCard.locator(".hint").textContent();
  assert(/关闭|Closing/.test(closing) && !/CC GUI|Codex/.test(closing), `closing hint: ${closing}`);

  console.log(`completion clients: claude ${claude.height.toFixed(1)}px, codex ${codex.height.toFixed(1)}px, grok ${grok.height.toFixed(1)}px; three looks differ in shape, material and tag, text stays readable`);
} finally {
  await browser.close();
  await vite?.close();
}
