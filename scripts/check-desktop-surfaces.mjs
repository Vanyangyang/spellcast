/**
 * Desktop surfaces: the six bubble shapes and the completion card over light, dark and photo wallpapers.
 * Each text line's contrast is sampled against what is actually painted behind it (text hidden, pixels
 * averaged), the completion window is also rendered 220px wide, and card heights are compared with the
 * native window estimate (140px per card, see completions.rs). Serves a temporary production build with
 * mocked Tauri internals; never contacts :47194. Browser evidence only: native placement, click-through,
 * topmost and focus behaviour are covered by check-display-target-native.mjs.
 *
 *   node scripts/check-desktop-surfaces.mjs [label]
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
const out = path.join(root, "artifacts/desktop-surfaces", label);
await mkdir(out, { recursive: true });
const webPort = Number(process.env.SPELLCAST_SURFACES_PORT ?? 47358);
assert(![47193, 47194].includes(webPort));
const origin = `http://127.0.0.1:${webPort}`;
const dist = await mkdtemp(path.join(tmpdir(), "spellcast-surfaces-dist-"));
const vite = path.join(root, "node_modules/vite/bin/vite.js");
const walls = { light: "linear-gradient(135deg,#f4f6f8,#dfe6ee)", dark: "linear-gradient(135deg,#1b2233,#2c3446)", photo: "linear-gradient(135deg,#6f8fb8,#c9b48a)" };
const report = { label, evidence: "production build via vite preview, headless Edge, mocked Tauri internals", completions: {}, bubbles: {}, heights: {}, problems: [] };
let preview;

/** Sample each visible text node: hide all text, screenshot, average the pixels under the node, blend the text colour. */
async function contrast(page, selectors) {
  const boxes = await page.evaluate(sel => sel.flatMap(s => [...document.querySelectorAll(s)].filter(n => n.getClientRects().length && n.textContent.trim()).map(n => {
    const r = n.getBoundingClientRect(), c = getComputedStyle(n);
    // color-mix() computes to color(srgb r g b / a) with 0–1 channels; rgb() uses 0–255.
    const channels = c.color.match(/[\d.]+/g).map(Number);
    const unit = c.color.startsWith("color(");
    const [cr, cg, cb] = channels.slice(0, 3).map(v => (unit ? v * 255 : v));
    const ca = channels[3] ?? 1;
    let alpha = ca; for (let e = n; e; e = e.parentElement) alpha *= +getComputedStyle(e).opacity;
    return { selector: s, text: n.textContent.trim().slice(0, 20), x: r.x, y: r.y, w: r.width, h: r.height, color: [cr, cg, cb], alpha, size: parseFloat(c.fontSize), weight: +c.fontWeight };
  })), selectors);
  const style = await page.addStyleTag({ content: "* { color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } svg { visibility: hidden !important; }" });
  const png = (await page.screenshot()).toString("base64");
  await style.evaluate(node => node.remove());
  return page.evaluate(async ([boxes, png]) => {
    const img = new Image(); img.src = "data:image/png;base64," + png; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
    const cx = canvas.getContext("2d"); cx.drawImage(img, 0, 0);
    const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const scale = img.width / innerWidth;
    return boxes.map(b => {
      const d = cx.getImageData(Math.round(b.x * scale), Math.round(b.y * scale), Math.max(1, Math.round(b.w * scale)), Math.max(1, Math.round(b.h * scale))).data;
      let r = 0, g = 0, bl = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bl += d[i + 2]; n++; }
      const bg = [r / n, g / n, bl / n], fg = b.color.map((c, i) => c * b.alpha + bg[i] * (1 - b.alpha));
      // The × close glyph is an icon control (WCAG 1.4.11: 3:1); everything else is text.
      const large = b.size >= 24 || (b.size >= 18.66 && b.weight >= 700) || b.selector === ".dismiss";
      return { selector: b.selector, text: b.text, size: b.size, weight: b.weight, ratio: +ratio(fg, bg).toFixed(2), needs: large ? 3 : 4.5 };
    });
  }, [boxes, png]);
}

// Only data crosses into the page; each init script adds its own transformCallback.
const tauri = label => ({ metadata: { currentWindow: { label }, currentWebview: { label } } });
const completions = [
  { thread_id: "t1", turn_id: "a", title: "重构登录流程并补充完整的单元测试与集成测试说明", summary: "已合并注册和登录，新增 12 个单元测试，全部通过。", project: "spellcast", completed_at_ms: 1, client: "codex" },
  { thread_id: "t2", turn_id: "b", title: "Codex 任务", summary: "修复 Windows 通知在副屏上的位置。", project: "notify-lab", completed_at_ms: 2, client: "codex" },
  { thread_id: "t3", turn_id: "c", title: "整理发布说明", summary: "0.4.13 草稿已写好，等待确认。", project: "release", completed_at_ms: 3, client: "grok" },
];
const base = { id: "b1", source_id: "surfaces", size: "note", screen: "active", delay_ms: 0, linger_ms: 600000 };
const bubbles = [
  { ...base, shape: "pill", kind: "risk", tease: "这个接口可能被重复调用", title: "这个接口可能被重复调用", body: "这个接口可能被重复调用" },
  { ...base, shape: "card", kind: "idea", tease: "要不要先把验证码换成魔法链接？", title: "换个思路", body: "少一步输入，企业邮箱延迟也不怕。" },
  { ...base, shape: "sticky", kind: "action", tease: "别忘了回滚开关", title: "Rollback switch", body: "上线前确认 feature flag 默认关闭。" },
  { ...base, shape: "speech", kind: "question", tease: "这段命名我有点在意", title: "命名", body: "handleThing 看不出它处理什么。" },
  { ...base, shape: "orb", kind: "insight", tease: "嗯？", title: "嗯？", body: "嗯？" },
  { ...base, shape: "code", kind: "risk", tease: "retry 没有上限", title: "retry", body: "while (!ok) await send();" },
];
const note = (key, lines) => {
  for (const line of lines) if (line.ratio < line.needs) report.problems.push(`${key}: "${line.text}" ${line.size}px is ${line.ratio}:1, needs ${line.needs}:1`);
  return { min: Math.min(...lines.map(l => l.ratio)), lines };
};

try {
  const built = spawn(process.execPath, [vite, "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: root, stdio: "inherit" });
  assert.equal(await new Promise(resolve => built.on("exit", resolve)), 0, "vite build failed");
  preview = spawn(process.execPath, [vite, "preview", "--outDir", dist, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: root, stdio: "ignore" });
  for (let i = 0; ; i++) { try { if ((await fetch(origin)).ok) break; } catch {} assert(i < 150, "vite preview did not start"); await new Promise(r => setTimeout(r, 200)); }
  const browser = await playwright.chromium.launch({ channel: "msedge", headless: true }).catch(() => playwright.chromium.launch({ headless: true }));
  const isolate = async page => page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));

  for (const [width, walled] of [[340, Object.entries(walls)], [220, [["light", walls.light]]]]) for (const [wall, background] of walled) {
    const page = await browser.newPage({ viewport: { width, height: 520 } });
    await isolate(page);
    await page.addInitScript(([items, internals]) => {
      localStorage.setItem("spellcast.locale", "zh-CN");
      window.__TAURI_INTERNALS__ = { ...internals, invoke: async cmd => cmd === "get_completions" ? items
        : cmd === "get_completion_voice" ? { enabled: true, supported: true, volume: 25, cooldown_seconds: 90, quiet_hours: "22:00–08:00" }
        : cmd === "plugin:event|listen" ? 1 : null };
      window.__TAURI_INTERNALS__.transformCallback = () => Math.random();
    }, [completions, tauri("completions")]);
    await page.goto(`${origin}/completions.html`);
    await page.locator(".completion-bubble").first().waitFor();
    await page.addStyleTag({ content: `html { background: ${background} !important; }` });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    const key = `${wall}-${width}`;
    await page.screenshot({ path: path.join(out, `completions-${key}.png`) });
    report.completions[key] = note(`completions ${key}`, await contrast(page, [".completion-toolbar > span", "#completion-voice", ".done", ".project", ".title", ".summary", ".hint", ".dismiss"]));
    const rows = await page.evaluate(() => [...document.querySelectorAll(".completion-bubble")].map(n => ({ height: Math.round(n.getBoundingClientRect().height), statusLines: Math.round(n.querySelector(".status").getBoundingClientRect().height / 16) })));
    report.heights[key] = rows;
    // completions.rs sizes the window as 140px per card; with a 12px gap a card must stay within 128px.
    for (const row of rows) if (row.height > 128) report.problems.push(`completions ${key}: a card is ${row.height}px, over the 128px the window estimate allows`);
    if (width === 220 && rows.some(row => row.statusLines > 1)) report.problems.push("completions 220: the status line wraps");
    await page.close();
  }

  for (const [wall, background] of Object.entries(walls)) for (const item of bubbles) {
    const page = await browser.newPage({ viewport: { width: 540, height: 280 } });
    await isolate(page);
    await page.addInitScript(([item, internals]) => {
      localStorage.setItem("spellcast.locale", "zh-CN");
      window.__TAURI_INTERNALS__ = { ...internals, invoke: async cmd => (cmd.includes("scale_factor") ? 1 : null) };
      window.__TAURI_INTERNALS__.transformCallback = () => Math.random();
      window.__SPELLCAST_FLIGHT__ = { item, scale: 1, x: 0, startY: 0, endY: 0, work: { x: 0, y: 0, w: 1920, h: 1040 }, margin: 18, pad: 20 };
    }, [item, tauri("bubble-x")]);
    await page.goto(`${origin}/bubble.html`);
    await page.locator(".bubble.is-in").waitFor({ timeout: 10000 }).catch(() => {});
    await page.addStyleTag({ content: `html.bubble-page.bubble-page, body.bubble-page.bubble-page { background: ${background} !important; }` });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    const key = `${item.shape}-${wall}`;
    await page.screenshot({ path: path.join(out, `bubble-${key}.png`) });
    report.bubbles[key] = note(`bubble ${key}`, await contrast(page, [".bubble .kind", ".bubble .title", ".bubble .tease", ".bubble .body"]));
    report.bubbles[key].font = await page.evaluate(() => {
      const title = document.querySelector(".bubble .title"), tease = document.querySelector(".bubble .tease");
      const font = n => n ? `${getComputedStyle(n).fontStyle} ${getComputedStyle(n).fontWeight} ${getComputedStyle(n).fontFamily.split(",")[0]}` : null;
      return { title: font(title), tease: font(tease), loaded: [...document.fonts].filter(f => f.status === "loaded").map(f => `${f.family} ${f.style} ${f.weight}`) };
    });
    await page.close();
  }
  await browser.close();
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  for (const [key, value] of Object.entries(report.completions)) console.log(`completions ${key}: min ${value.min.toFixed(2)}:1, cards ${report.heights[key].map(r => r.height).join("/")}px`);
  for (const [key, value] of Object.entries(report.bubbles)) console.log(`bubble ${key}: min ${value.min.toFixed(2)}:1 · title ${value.font.title}`);
  console.log(report.problems.length ? `\nProblems:\n- ${report.problems.join("\n- ")}` : "\nAll sampled text meets its contrast floor; cards fit the window estimate.");
  console.log(`screenshots and report: ${path.relative(root, out)}`);
  if (report.problems.length && !process.env.SPELLCAST_SURFACES_REPORT_ONLY) process.exitCode = 1;
} finally {
  if (preview) { if (process.platform === "win32") spawn("taskkill", ["/PID", String(preview.pid), "/T", "/F"], { stdio: "ignore" }); else preview.kill(); }
}
