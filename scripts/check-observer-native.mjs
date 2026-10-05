/**
 * Native observer lifecycle regression with a synthetic, integrity-checked runner.
 * Uses only a .verify app, a fresh database/profile/ports and synthetic source IDs.
 * No Claude model, real conversation, installed plugin, or installed app is used.
 *
 * Build a debug com.spellcast.board.verify app with tauri/devtools, then:
 *   node scripts/check-observer-native.mjs --hold-ms 120000
 *
 * The launcher below stages its own executable/resources, then reuses run-native-check.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const holdIndex = process.argv.indexOf("--hold-ms");
const holdMs = Number(holdIndex >= 0 ? process.argv[holdIndex + 1] : 1000);
assert(Number.isFinite(holdMs) && holdMs >= 0 && holdMs <= 130000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read().catch(() => null);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(message);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert(![47193, 47194].includes(port));
  return port;
}

if (!process.env.SPELLCAST_CDP) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "spellcast-check-observer-native-"));
  const stage = path.join(sandbox, "app");
  const fixture = path.join(sandbox, "observer-fixture");
  const plugin = path.join(stage, "resources/claude-plugin");
  await mkdir(path.join(plugin, "hooks"), { recursive: true });
  await mkdir(fixture);
  const exe = path.join(stage, "spellcast.exe");
  await copyFile(path.join(repo, "src-tauri/target/debug/spellcast.exe"), exe);
  const script = [
    "import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';",
    "let input=''; for await(const part of process.stdin) input+=part; const brief=JSON.parse(input);",
    "const root=" + JSON.stringify(fixture) + ";",
    "const key=encodeURIComponent(brief.source_id);",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});",
    "fs.writeFileSync(path.join(root,key+'.started'),JSON.stringify({pid:process.pid,childPid:child.pid,parentPid:process.ppid,id:brief.observer_id,source:brief.source_id}));",
    "const timer=setInterval(()=>{if(!fs.existsSync(path.join(root,key+'.release')))return; clearInterval(timer);",
    "const result={status:'ready',observer_id:brief.observer_id,thought:{tease:'NATIVE ASIDE TEST '+brief.source_id,body:'Synthetic lifecycle fixture; no model was called.'}};",
    "process.stdout.write(JSON.stringify(result),()=>process.exit(0));},25);",
  ].join("\n");
  await writeFile(path.join(plugin, "hooks/claude-observer-runner.mjs"), script);
  await writeFile(path.join(plugin, "integrity.json"), JSON.stringify({
    algorithm: "sha256",
    files: { "hooks/claude-observer-runner.mjs": createHash("sha256").update(script).digest("hex") },
  }));
  await writeFile(path.join(fixture, "host-client.mjs"), [
    "import fs from 'node:fs/promises';",
    "const request=JSON.parse(await fs.readFile(process.argv[3],'utf8'));",
    "const response=await fetch(process.argv[2],{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(request)});",
    "if(!response.ok)throw new Error('MCP HTTP '+response.status);",
    "process.stdout.write(await response.text());",
  ].join("\n"));
  const cdp = await freePort();
  let port = await freePort();
  while (port === cdp) port = await freePort();
  const child = spawn(process.execPath, [
    path.join(repo, "scripts/run-native-check.mjs"), "check-observer-native",
    "--cdp", String(cdp), "--port", String(port), "--sandbox", sandbox,
    "--", "--hold-ms", String(holdMs),
  ], {
    cwd: repo, stdio: "inherit", windowsHide: true,
    env: { ...process.env, SPELLCAST_NATIVE_EXE: exe, SPELLCAST_OBSERVER_FIXTURE_DIR: fixture,
      CLAUDE_CONFIG_DIR: path.join(sandbox, "claude") },
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  process.exitCode = code ?? 1;
} else {
  await check();
}

async function check() {
  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require("playwright"); }
  catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ??
    path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
  const fixture = process.env.SPELLCAST_OBSERVER_FIXTURE_DIR;
  assert(fixture && path.isAbsolute(fixture), "the launcher must provide its isolated fixture");
  const output = path.resolve(process.env.SPELLCAST_TEST_OUTPUT);
  await mkdir(output, { recursive: true });
  const browser = await playwright.chromium.connectOverCDP(process.env.SPELLCAST_CDP);
  const main = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === "http://tauri.localhost/");
  assert(main, "isolated native main window");
  const status = await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("bridge_status"));
  assert.equal(status.port, Number(process.env.SPELLCAST_TEST_PORT));
  assert(![47193, 47194].includes(status.port));
  const origin = "http://127.0.0.1:" + status.port;
  const report = { scope: "isolated real Tauri app and MCP, synthetic runner, no model or real host conversation", port: status.port, holdMs, checks: [], processes: [], errors: [] };
  const ok = text => { report.checks.push(text); console.log("ok - " + text); };
  const seen = source => readFile(path.join(fixture, encodeURIComponent(source) + ".started"), "utf8").then(JSON.parse);
  const release = source => writeFile(path.join(fixture, encodeURIComponent(source) + ".release"), "");
  const snapshot = source => ({ source_id: source, snapshot: {
    checkpoint_id: randomUUID(), project: "Isolated observer validation",
    goal: "Keep the foreground caller independent", change: "Synthetic slow observer", facts: [],
  } });
  let rpc = 0;
  async function mcp(name, args) {
    const response = await fetch(origin + "/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
    const body = await response.json();
    assert(response.ok && !body.error && !body.result?.isError, JSON.stringify(body));
    return body.result.structuredContent;
  }
  async function setting(route, body) {
    const response = await fetch(origin + route, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert(response.ok, route + ": " + response.status);
    return response.json();
  }
  async function start(source) {
    const response = await mcp("spellcast_checkpoint", snapshot(source));
    assert.equal(response.status, "scheduled");
    assert(!("brief" in response));
    const record = await until(() => seen(source), "native runner did not start");
    assert(alive(record.pid) && alive(record.childPid));
    report.processes.push(record);
    return record;
  }
  async function stopped(record) {
    await until(async () => !alive(record.pid) && !alive(record.childPid), "an owned observer process survived");
  }
  try {
    assert.equal((await setting("/api/observer/provider", { provider: "claude" })).provider, "claude");
    assert.equal((await setting("/api/observer/settings", { enabled: true })).enabled, true);
    const source = "claude:" + randomUUID();
    const request = path.join(fixture, "foreground-request.json");
    await writeFile(request, JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call",
      params: { name: "spellcast_checkpoint", arguments: snapshot(source) } }));
    const began = Date.now();
    const caller = spawn(process.execPath, [path.join(fixture, "host-client.mjs"), origin + "/mcp", request],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    caller.stdout.on("data", part => { stdout += part; });
    caller.stderr.on("data", part => { stderr += part; });
    let timeout;
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        caller.once("error", reject);
        caller.once("exit", resolve);
        timeout = setTimeout(() => reject(new Error("foreground MCP caller stayed alive")), 10000);
      });
    } finally {
      clearTimeout(timeout);
      // This child belongs solely to the synthetic test. A failed check must not keep the
      // check process alive and prevent the outer launcher from cleaning up its native app.
      if (caller.exitCode === null && caller.signalCode === null) caller.kill();
    }
    assert.equal(code, 0, stderr);
    const answer = JSON.parse(stdout).result.structuredContent;
    assert.equal(answer.status, "scheduled");
    assert(!("brief" in answer));
    const record = await until(() => seen(source), "independent native observer missing");
    report.processes.push(record);
    report.foreground = { pid: caller.pid, elapsedMs: Date.now() - began, response: answer };
    assert(!alive(caller.pid) && alive(record.pid) && alive(record.childPid));
    assert.notEqual(record.parentPid, caller.pid, "observer must belong to the app, not the caller");
    ok("the foreground MCP client exits while the application-owned observer keeps running");
    console.log("Holding the synthetic observer for " + holdMs + " ms after its caller exited.");
    await sleep(holdMs);
    assert(!alive(caller.pid) && alive(record.pid));
    await release(source);
    const bubble = await until(async () => {
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        if (!page.url().includes("bubble.html")) continue;
        if ((await page.locator("#orb").innerText()).includes(source)) return page;
      }
    }, "native aside bubble never appeared");
    await stopped(record);
    await bubble.screenshot({ path: path.join(output, "native-aside.png") });
    ok("a late decision appears as a real native bubble after the caller is already gone");
    assert(!alive(caller.pid), "the foreground caller was never resumed");

    const cancelledSource = "claude:" + randomUUID();
    const cancelled = await start(cancelledSource);
    assert.equal((await mcp("spellcast_checkpoint", { source_id: cancelledSource, snapshot: null })).status, "cancelled");
    await stopped(cancelled);
    assert.equal((await mcp("spellcast_observer_complete", { observer_id: cancelled.id, provider: "claude",
      thought: { tease: "This late fixture must not appear" } })).status, "stale");
    ok("source cancellation kills the runner and descendant, and rejects a late completion");

    const disabled = await start("claude:" + randomUUID());
    await setting("/api/observer/settings", { enabled: false });
    await stopped(disabled);
    ok("turning asides off stops the application-owned process tree");
    await setting("/api/observer/settings", { enabled: true });

    const exiting = await start("claude:" + randomUUID());
    const nativePid = exiting.parentPid;
    assert(alive(nativePid));
    const closing = main.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" })).catch(() => {});
    await until(async () => !alive(nativePid), "native main-window close did not exit the app");
    await stopped(exiting);
    await Promise.race([closing, sleep(1000)]);
    ok("normal native app exit leaves neither the observer nor its descendant running");
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.errors.push(String(error.stack ?? error));
    process.exitCode = 1;
  } finally {
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await browser.close().catch(() => {});
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, errors: report.errors }));
  }
}
