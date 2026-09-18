import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const art = path.resolve(root, "artifacts/spellcast-complete-setup-20260913");
await mkdir(art, { recursive: true });

const src = path.join(root, "src/complete-setup-ui.ts");
const esmOut = path.join(art, "complete-setup-ui.mjs");
const iifeOut = path.join(art, "complete-setup-ui.iife.js");

await build({
  entryPoints: [src],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: esmOut,
  write: true,
});
await build({
  entryPoints: [src],
  bundle: true,
  format: "iife",
  globalName: "CompleteSetupUI",
  outfile: iifeOut,
  write: true,
});

const {
  SETUP_KIND_MESSAGE,
  createSetupSession,
} = await import(pathToFileURL(esmOut).href);

assert.equal(SETUP_KIND_MESSAGE.verified, "setup.status.verified");
assert.equal(SETUP_KIND_MESSAGE.installed_unverified, "setup.status.installedUnverified");
assert.equal(SETUP_KIND_MESSAGE.installed_pending_trust, "setup.status.pendingTrust");
assert.notEqual(SETUP_KIND_MESSAGE.verified, "setup.verified");

const s = createSetupSession();
const preview1 = s.beginPreview("codex", "http://127.0.0.1:47194/mcp");
assert.ok(preview1);
const preview2 = s.beginPreview("codex", "http://127.0.0.1:48001/mcp");
assert.ok(preview2);
assert.equal(s.canApplyPreview(preview1, "codex", "http://127.0.0.1:47194/mcp"), false, "stale preview must not apply");
assert.equal(s.canApplyPreview(preview2, "codex", "http://127.0.0.1:48001/mcp"), true);

const install = s.beginInstall("codex", "http://127.0.0.1:47194/mcp");
assert.ok(install);
assert.equal(s.beginPreview("windsurf", "http://127.0.0.1:47194/mcp"), null, "preview blocked while installing");
assert.equal(s.beginInstall("codex", "http://127.0.0.1:47194/mcp"), null, "second install blocked");
assert.equal(s.canApplyPreview(preview2, "codex", "http://127.0.0.1:48001/mcp"), false, "preview cannot overwrite installing");
assert.equal(s.canApplyInstall(install), true);
s.endInstall();
assert.equal(s.state().inflight, false);
assert.equal(s.canApplyInstall(install), false, "finished install token is spent");

const retry = s.beginInstall("codex", "http://127.0.0.1:47194/mcp");
assert.ok(retry, "failure/end must allow retry");
assert.equal(retry.generation > install.generation, true);
s.endInstall();

const errPreview = s.beginPreview("codex", "http://127.0.0.1:9/mcp");
assert.ok(errPreview);
const next = s.beginPreview("windsurf", "http://127.0.0.1:9/mcp");
assert.ok(next);
assert.equal(s.canApplyPreview(errPreview, "codex", "http://127.0.0.1:9/mcp"), false, "error from old client must not apply");

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
const context = await browser.newContext();
const isolation = { aborted: [], passthrough: [] };
await context.route("**/*", async (route, request) => {
  const url = request.url();
  if (url === "about:blank" || url.startsWith("data:") || url.startsWith("file:")) {
    return route.continue();
  }
  isolation.aborted.push({ method: request.method(), url });
  if (url.includes("47194")) isolation.passthrough.push({ method: request.method(), url, leaked: true });
  return route.abort("blockedbyclient");
});
const page = await context.newPage();
await page.setContent(`<!doctype html>
<html lang="zh-CN"><body>
  <button id="agent-complete-setup"></button><button id="settings-complete-setup"></button>
  <h3 data-setup-title></h3>
  <button data-setup-refresh></button><span data-setup-component="hooks"></span><span data-setup-component="skill"></span>
  <p id="agent-setup-status"></p>
  <p id="agent-setup-hint"></p>
  <details class="setup-details" hidden><summary>安装详情</summary><pre id="agent-setup-details-body"></pre></details>
  <p id="settings-setup-status"></p>
  <p id="settings-setup-hint"></p>
  <details class="setup-details" hidden><summary>安装详情</summary><pre id="settings-setup-details-body"></pre></details>
</body></html>`);
await page.addScriptTag({ path: iifeOut });

const result = await page.evaluate(async () => {
  const {
    createSetupController,
    paintSetupView,
    statusReadFailedReport,
    installingReport,
  } = window.CompleteSetupUI;
  const zh = {
    "setup.status.unsupported": "不支持完整接入",
    "setup.status.notInstalled": "未安装",
    "setup.status.installing": "正在安装",
    "setup.status.pendingTrust": "已安装，待信任",
    "setup.status.unverified": "未验证",
    "setup.status.verified": "已安装 · Hooks 已信任",
    "setup.status.hooksDisabled": "已安装 · Hooks 已停用",
    "setup.status.hooksModified": "已安装 · 需重新信任 Hooks",
    "setup.status.installedUnverified": "已安装 · 信任状态待核验",
    "setup.hint.verified": "Codex 已确认当前两项 Hook 已启用并信任。",
    "setup.hint.installedUnverified": "暂时无法核验信任状态；已信任时无需重复安装。",
    "setup.hint.modified": "Hook 已更新，请重新信任。",
    "setup.hint.disabled": "请在 Codex 启用 Hook。",
    "setup.hooks.trusted": "已信任",
    "setup.hooks.untrusted": "待信任",
    "setup.hooks.unknown": "信任未核验",
    "setup.hooks.modified": "需重新信任",
    "setup.hooks.disabled": "已停用",
    "setup.component.installed": "已安装",
    "setup.update": "更新 Hooks + Skill",
    "setup.install": "安装 Hooks + Skill（必需）",
    "setup.title": "Codex 接入",
    "settings.body": "先选宿主，再一键装好连接和用法。",
    "setup.hooksDescription": "旁念上下文",
    "setup.skillDescription": "画布用法",
    "setup.mcpDescription": "连接 Codex",
    "setup.mcpDescriptionGrok": "连接 Grok Build",
    "setup.titleGrok": "Grok Build 接入",
    "setup.installGrok": "安装 MCP + Skill",
    "setup.updateGrok": "更新 MCP + Skill",
    "setup.hint.grokNotInstalled": "可一次写入 MCP 与 Skill。",
    "setup.hint.grokVerified": "MCP 与 Skill 已写入 Grok Build 配置。",
    "setup.status.grokVerified": "已安装 · MCP + Skill",
    "setup.status.failed": "未完成",
    "setup.hint.unsupported": "此客户端不能完整接入，未执行安装。",
    "setup.hint.notInstalled": "可一次安装 MCP、hooks 与 Skill。",
    "setup.status.conflictCustom": "自定义源冲突",
    "setup.hint.conflictCustom": "现有插件源与发行包不同，未覆盖。",
    "setup.hint.desktopPreview": "浏览器为只读预览。请在 Spellcast 桌面应用中安装。",
    "setup.hint.installing": "正在安装，请稍候，不要重复点击。",
    "setup.hint.pendingTrust": "请在 Codex 的 /hooks 中信任 SessionStart 与 UserPromptSubmit。",
    "setup.hint.unverified": "尚未核验为运行时已生效。",
    "setup.hint.failed": "安装未完成，可重试。",
    "setup.hint.readFailed": "未能读取当前接入状态，已清除过期路径。",
    "setup.source": "插件源：{path}",
    "setup.cache": "安装缓存：{path}",
    "setup.marketplace": "市场条目：{path}",
  };
  const t = (key, vars) => {
    let text = zh[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const view = () => ({
    status: document.querySelector("#agent-setup-status")?.textContent ?? "",
    hint: document.querySelector("#agent-setup-hint")?.textContent ?? "",
    details: document.querySelector("#agent-setup-details-body")?.textContent ?? "",
    detailsHidden: [...document.querySelectorAll(".setup-details")].every((el) => el.hidden),
    detailsOpen: [...document.querySelectorAll(".setup-details")].some((el) => el.open),
  });
  const base = (over = {}) => ({
    client: "codex",
    kind: "not_installed",
    complete_supported: true,
    installed: false,
    note: "",
    done: [],
    not_done: [],
    conflicts: [],
    source_path: null,
    cache_path: null,
    marketplace_path: null,
    ...over,
  });
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  paintSetupView(base({
    kind: "verified",
    installed: true,
    hook_trust: "trusted",
    note: "backend report in English should not occupy the main hint",
    source_path: "C:/Users/x/plugins/spellcast",
    cache_path: "C:/Users/x/.codex/plugins/cache/personal/spellcast/0.3.0",
    marketplace_path: "C:/Users/x/.agents/plugins/marketplace.json",
  }), t);
  let snap = view();
  check(snap.status === "已安装 · Hooks 已信任", `native verified result is shown, got ${snap.status}`);
  check(snap.hint === "Codex 已确认当前两项 Hook 已启用并信任。", `main hint localized, got ${snap.hint}`);
  check(document.querySelector('[data-setup-component="hooks"]').textContent === "已信任", "trusted component");
  check(document.querySelector('#settings-complete-setup').textContent === "更新 Hooks + Skill", "installed action names Hooks and Skill");

  paintSetupView(base({
    client: "grok",
    kind: "verified",
    installed: true,
    note: "Grok files verified",
  }), t);
  snap = view();
  check(snap.status === "已安装 · MCP + Skill", `grok verified status ${snap.status}`);
  check(snap.hint === "MCP 与 Skill 已写入 Grok Build 配置。", `grok verified hint ${snap.hint}`);
  check(document.querySelector('#settings-complete-setup').textContent === "更新 MCP + Skill", "grok update names MCP and Skill");
  check([...document.querySelectorAll("[data-setup-title]")].every((el) => el.textContent === "Grok Build 接入"), "grok title");
  paintSetupView(base({ client: "grok", kind: "not_installed", mcp_url: "http://127.0.0.1:47194/mcp" }), t);
  check(view().hint.includes("可一次写入 MCP 与 Skill"), "native grok not-installed hint");
  paintSetupView(base({ client: "grok", kind: "not_installed" }), t);
  check(view().hint.includes("浏览器为只读预览"), "browser grok preview stays desktop-only");
  paintSetupView(base({
    kind: "not_installed",
    mcp_url: "http://127.0.0.1:47194/mcp",
    source_path: "C:/Users/x/.codex/hooks.json",
  }), t);
  snap = view();
  check(snap.hint === "可一次安装 MCP、hooks 与 Skill。", `desktop file check not-installed hint ${snap.hint}`);
  check(!snap.hint.includes("浏览器"), "desktop check must not look like browser preview");
  check(!snap.status.includes("CLI"), "desktop check must not demand CLI");
  paintSetupView(base({ kind: "not_installed" }), t);
  check(view().hint.includes("浏览器为只读预览"), "browser preview stays desktop-only");
  paintSetupView(base({
    kind: "installed_pending_trust",
    installed: true,
    hook_trust: "untrusted",
    mcp_url: "http://127.0.0.1:47194/mcp",
    source_path: "C:/Users/x/.codex/hooks.json",
  }), t);
  snap = view();
  check(snap.status === "已安装，待信任", `file-complete check status ${snap.status}`);
  check(snap.hint === "请在 Codex 的 /hooks 中信任 SessionStart 与 UserPromptSubmit。", `pending trust hint ${snap.hint}`);
  check(document.querySelector('[data-setup-component="hooks"]').textContent === "待信任", "pending hooks row is untrusted");
  check(!/CLI|missing_cli|未安装|信任未核验/.test(snap.status + snap.hint + document.querySelector('[data-setup-component="hooks"]').textContent), "complete files must not look missing or unverified");
  paintSetupView(base({
    kind: "verified",
    installed: true,
    hook_trust: "trusted",
    mcp_url: "http://127.0.0.1:47194/mcp",
    source_path: "C:/Users/x/.codex/hooks.json",
  }), t);
  snap = view();
  check(snap.status === "已安装 · Hooks 已信任", `file-complete trusted status ${snap.status}`);
  check(document.querySelector('[data-setup-component="hooks"]').textContent === "已信任", "file-complete trusted hooks row");
  paintSetupView(base({
    kind: "conflict_custom",
    mcp_url: "http://127.0.0.1:47194/mcp",
    source_path: "C:/Users/x/.codex/hooks.json",
    conflicts: ["hooks.json 不是有效 JSON"],
  }), t);
  snap = view();
  check(snap.status === "自定义源冲突", `protected check status ${snap.status}`);
  check(snap.hint === "现有插件源与发行包不同，未覆盖。", `protected check hint ${snap.hint}`);
  check(!snap.hint.includes("未安装"), "protected JSON is not not-installed");
  paintSetupView(base({
    kind: "verified",
    installed: true,
    hook_trust: "trusted",
    note: "backend report in English should not occupy the main hint",
    source_path: "C:/Users/x/plugins/spellcast",
    cache_path: "C:/Users/x/.codex/plugins/cache/personal/spellcast/0.3.0",
    marketplace_path: "C:/Users/x/.agents/plugins/marketplace.json",
  }), t);
  snap = view();
  check(!/verified|not_installed|C:\\\\Users|plugins\/spellcast/i.test(snap.status + snap.hint), "raw kind or paths on main");
  check(snap.details.includes("C:/Users/x/plugins/spellcast"), "paths belong in details");
  check(snap.details.includes("backend report in English"), "raw report in details");
  check(!snap.detailsHidden, "details visible when body exists");
  check(!snap.detailsOpen, "details stay collapsed");

  paintSetupView(base({ kind: "installed_unverified", installed: true, hook_trust: "unknown" }), t);
  snap = view();
  check(!snap.status.includes("待信任") && snap.hint.includes("无需重复安装"), "unknown is not untrusted");
  check(document.querySelector('[data-setup-component="skill"]').textContent === "已安装", "trust read failure preserves installation");
  paintSetupView(base({ kind: "installed_pending_trust", installed: true, hook_trust: "modified" }), t);
  check(view().hint.includes("重新信任"), "changed hashes need new trust");
  paintSetupView(base({ kind: "installed_unverified", installed: true, hook_trust: "disabled" }), t);
  check(view().hint.includes("启用 Hook"), "disabled is not untrusted");
  check(view().status.includes("已停用"), "disabled is not unknown");

  paintSetupView(statusReadFailedReport("codex", "invoke failed"), t);
  snap = view();
  check(snap.status === "未完成", `read-failed status ${snap.status}`);
  check(snap.hint === "未能读取当前接入状态，已清除过期路径。", `read-failed hint ${snap.hint}`);
  check(!snap.details.includes("C:/Users/x/plugins/spellcast"), "read-failed must clear stale paths");
  check(snap.details.includes("invoke failed"), "raw error stays in details");

  let client = "codex";
  let url = "http://127.0.0.1:9/mcp";
  let resolveStatus;
  const statusGate = new Promise((resolve) => {
    resolveStatus = resolve;
  });
  const counts = { status: 0, install: 0 };
  const staleVsInstall = createSetupController({
    t,
    status: async () => {
      counts.status += 1;
      return statusGate;
    },
    install: async () => {
      counts.install += 1;
      await wait(40);
      return base({ kind: "failed", note: "install boom" });
    },
    getClient: () => client,
    getUrl: () => url,
  });
  const previewP = staleVsInstall.preview(client, url);
  await wait(15);
  const installP = staleVsInstall.install(client, url);
  await wait(15);
  snap = view();
  check(snap.status === "正在安装", `inflight status ${snap.status}`);
  check(snap.hint.includes("不要重复点击"), `inflight hint ${snap.hint}`);
  check(!snap.details.includes("/old-source"), "installing must not keep old paths");
  resolveStatus(base({
    kind: "verified",
    installed: true,
    source_path: "/old-source",
    cache_path: "/old-cache",
    note: "stale success",
  }));
  await previewP;
  snap = view();
  check(snap.status === "正在安装", `stale preview must not win ${snap.status}`);
  check(!snap.details.includes("/old-source"), "stale success paths must not apply");
  await installP;
  snap = view();
  check(snap.status === "未完成", `install failure ${snap.status}`);
  check(counts.install === 1, `install once, got ${counts.install}`);

  let installs = 0;
  const double = createSetupController({
    t,
    status: async () => base(),
    install: async () => {
      installs += 1;
      await wait(50);
      return base({ kind: "failed", note: "once" });
    },
    getClient: () => client,
    getUrl: () => url,
  });
  await Promise.all([double.install(client, url), double.install(client, url)]);
  check(installs === 1, `double-click must not start two installs (${installs})`);

  client = "codex";
  url = "http://127.0.0.1:1/mcp";
  const change = createSetupController({
    t,
    status: async (_c, u) => {
      if (u.includes(":1/")) {
        await wait(40);
        return base({
          kind: "verified",
          installed: true,
          source_path: "/stale-source",
          cache_path: "/stale-cache",
          marketplace_path: "/stale-mkt",
        });
      }
      throw new Error("new endpoint unavailable");
    },
    install: async () => base({ kind: "failed" }),
    getClient: () => client,
    getUrl: () => url,
  });
  change.paint(base({
    kind: "verified",
    installed: true,
    source_path: "/previous-success",
    cache_path: "/previous-cache",
  }));
  const first = change.preview("codex", url);
  url = "http://127.0.0.1:2/mcp";
  const second = change.preview("codex", url);
  await Promise.all([first, second]);
  const afterUrl = change.lastReport();
  snap = view();
  check(afterUrl?.ui === "status-read-failed", `url change fail ui ${afterUrl?.ui}`);
  check(afterUrl?.installed === false, "must not keep installed");
  check(afterUrl?.source_path == null && afterUrl?.cache_path == null, "must clear mismatched paths");
  check(snap.status === "未完成", `url-change status ${snap.status}`);
  check(snap.hint === "未能读取当前接入状态，已清除过期路径。", `url-change hint ${snap.hint}`);
  check(!snap.details.includes("/stale-source") && !snap.details.includes("/previous-success"), "stale paths after url change");

  client = "codex";
  url = "http://127.0.0.1:3/mcp";
  const clientChange = createSetupController({
    t,
    status: async (c) => {
      if (c === "codex") {
        await wait(40);
        throw new Error("old client fail");
      }
      return base({ client: "windsurf", kind: "unsupported", complete_supported: false });
    },
    install: async () => base({ kind: "failed" }),
    getClient: () => client,
    getUrl: () => url,
  });
  const oldFail = clientChange.preview("codex", url);
  client = "windsurf";
  const otherPreview = clientChange.preview("windsurf", url);
  await Promise.all([oldFail, otherPreview]);
  snap = view();
  check(snap.status === "不支持完整接入", `client-change status ${snap.status}`);
  check(snap.hint === "此客户端不能完整接入，未执行安装。", `client-change hint ${snap.hint}`);
  check(clientChange.lastReport()?.ui !== "status-read-failed", "old client error must not overwrite new client");

  let n = 0;
  const retryCtrl = createSetupController({
    t,
    status: async () => base(),
    install: async () => {
      n += 1;
      if (n === 1) throw new Error("cli missing");
      return base({
        kind: "installed_pending_trust",
        installed: true,
        source_path: "/ok-source",
      });
    },
    getClient: () => "codex",
    getUrl: () => url,
  });
  await retryCtrl.install("codex", url);
  snap = view();
  check(snap.status === "未完成", `fail status ${snap.status}`);
  check(snap.hint === "安装未完成，可重试。", `fail hint ${snap.hint}`);
  check(snap.details.includes("cli missing"), "raw install error in details");
  check(!snap.details.includes("/ok-source"), "failed attempt has no success path");
  await retryCtrl.install("codex", url);
  snap = view();
  check(snap.status === "已安装，待信任", `retry status ${snap.status}`);
  check(snap.hint.includes("信任"), `retry hint ${snap.hint}`);
  check(snap.details.includes("/ok-source"), "retry success path in details");
  check(!/installed_pending_trust/.test(snap.status + snap.hint), "no raw kind after retry");
  check(n === 2, `retry count ${n}`);

  paintSetupView(installingReport("codex"), t);
  snap = view();
  check(snap.status === "正在安装", "installing report status");
  check(snap.detailsHidden || !snap.details.trim(), "installing has no leftover metadata");

  return { failures, installing: installingReport("codex"), readFailed: statusReadFailedReport("codex", "x") };
});

assert.equal(result.readFailed.installed, false);
assert.equal(result.readFailed.source_path, null);
assert.equal(result.readFailed.ui, "status-read-failed");
assert.equal(result.installing.source_path, null);
assert.deepEqual(result.failures, []);
assert.equal(isolation.passthrough.length, 0, JSON.stringify(isolation.passthrough));

await browser.close();
console.log("complete-setup-ui real module + DOM async checks ok");
console.log(JSON.stringify({ esmOut, iifeOut, isolationAborted: isolation.aborted.length }, null, 2));
