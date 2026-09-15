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

assert.equal(SETUP_KIND_MESSAGE.verified, "setup.status.unverified");
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
assert.equal(s.beginPreview("cursor", "http://127.0.0.1:47194/mcp"), null, "preview blocked while installing");
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
const next = s.beginPreview("cursor", "http://127.0.0.1:9/mcp");
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
    "setup.status.failed": "未完成",
    "setup.hint.unsupported": "此客户端不能完整接入，未执行安装。",
    "setup.hint.notInstalled": "可一次安装 MCP、hooks 与 Skill。",
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
    note: "backend report in English should not occupy the main hint",
    source_path: "C:/Users/x/plugins/spellcast",
    cache_path: "C:/Users/x/.codex/plugins/cache/personal/spellcast/0.3.0",
    marketplace_path: "C:/Users/x/.agents/plugins/marketplace.json",
  }), t);
  let snap = view();
  check(snap.status === "未验证", `verified paints unverified, got ${snap.status}`);
  check(snap.hint === "尚未核验为运行时已生效。", `main hint localized, got ${snap.hint}`);
  check(!/verified|not_installed|C:\\\\Users|plugins\/spellcast/i.test(snap.status + snap.hint), "raw kind or paths on main");
  check(snap.details.includes("C:/Users/x/plugins/spellcast"), "paths belong in details");
  check(snap.details.includes("backend report in English"), "raw report in details");
  check(!snap.detailsHidden, "details visible when body exists");
  check(!snap.detailsOpen, "details stay collapsed");

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
      return base({ client: "cursor", kind: "unsupported", complete_supported: false });
    },
    install: async () => base({ kind: "failed" }),
    getClient: () => client,
    getUrl: () => url,
  });
  const oldFail = clientChange.preview("codex", url);
  client = "cursor";
  const cursorPreview = clientChange.preview("cursor", url);
  await Promise.all([oldFail, cursorPreview]);
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
