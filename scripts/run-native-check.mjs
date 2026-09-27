/**
 * Runs one of the attach-over-CDP native checks against a fresh, isolated debug app: its own
 * identifier (com.spellcast.board.verify), bridge port, database, completion inbox, Codex/Grok
 * homes and WebView profile, with WebView2 remote debugging on the port the check expects. Never
 * touches :47193/:47194, the installed Spellcast or the user's data. The app is stopped afterwards.
 *
 *   npx tauri build --debug --no-bundle --features tauri/devtools --config '{"identifier":"com.spellcast.board.verify","build":{"beforeBuildCommand":"npm run build"}}'
 *   node scripts/run-native-check.mjs check-canvas-studio [--locale en] [--size 1600x900] [--sandbox <dir>] [-- extra args]
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The CDP and bridge ports each check asserts (see the check's own defaults).
const KNOWN = {
  "check-canvas-navigation": { cdp: 9337, port: 47196 },
  "check-atomic-canvas": { cdp: 9338, port: 47198 },
  "check-atomic-composition": { cdp: 9340, port: 47200 },
  "check-canvas-links": { cdp: 9342, port: 47202 },
  "check-canvas-studio": { cdp: 9346, port: 47208 },
  "check-canvas-studio-states": { cdp: 9348, port: 47210 },
};
const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split < 0 ? argv : argv.slice(0, split);
const passThrough = split < 0 ? [] : argv.slice(split + 1);
const name = own[0]?.replace(/\.mjs$/, "").replace(/^scripts[\\/]/, "");
assert(name, "Name the check to run, for example check-canvas-studio");
const option = flag => { const i = own.indexOf(flag); return i < 0 ? undefined : own[i + 1]; };
const cdp = Number(option("--cdp") ?? KNOWN[name]?.cdp);
const port = Number(option("--port") ?? KNOWN[name]?.port);
assert(cdp && port, `No known ports for ${name}; pass --cdp and --port`);
assert(![47193, 47194].includes(port), "Never use the user's ports");
const locale = option("--locale");
const size = option("--size")?.split("x").map(Number);

const exe = path.resolve(repo, process.env.SPELLCAST_NATIVE_EXE ?? "src-tauri/target/debug/spellcast.exe");
const marked = execFileSync("powershell", ["-NoProfile", "-Command", `(Select-String -Path '${exe}' -Pattern 'com.spellcast.board.verify' -SimpleMatch -Quiet)`]).toString().trim();
assert.equal(marked, "True", "Build the debug app with the com.spellcast.board.verify identifier so it cannot reach an installed Spellcast");
for (const busy of [cdp, port]) {
  const taken = await fetch(`http://127.0.0.1:${busy}/`, { signal: AbortSignal.timeout(800) }).then(() => true, () => false);
  assert(!taken, `Port ${busy} is already answering; stop the previous run first`);
}

// --sandbox <dir> reuses an earlier run's database and WebView profile, for the checks' --verify-restart.
const sandbox = option("--sandbox") ? path.resolve(option("--sandbox")) : await mkdtemp(path.join(tmpdir(), `spellcast-${name}-`));
assert(path.basename(sandbox).startsWith(`spellcast-${name}-`), "Only reuse a sandbox this launcher created for the same check");
const output = path.join(repo, "artifacts/native-checks", name);
await mkdir(output, { recursive: true });
const env = {
  ...process.env,
  SPELLCAST_PORT: String(port),
  SPELLCAST_STATE_FILE: path.join(sandbox, "board.sqlite3"),
  SPELLCAST_COMPLETIONS_DIR: path.join(sandbox, "completions"),
  CODEX_HOME: path.join(sandbox, "codex"),
  GROK_HOME: path.join(sandbox, "grok"),
  WEBVIEW2_USER_DATA_FOLDER: path.join(sandbox, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdp}`,
};
for (const proxy of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[proxy];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    try { const value = await read(); if (value) return value; } catch {}
    if (Date.now() - start > timeout) throw new Error(message);
    await sleep(200);
  }
}

const native = spawn(exe, [], { env, stdio: "ignore" });
let code = 1;
try {
  await until(async () => (await fetch(`http://127.0.0.1:${cdp}/json/version`)).ok, "native CDP did not start");
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
  const main = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url() === "http://tauri.localhost/"), "main window did not load");
  await until(() => main.evaluate(() => Boolean(document.querySelector("#settings-open")?.textContent.trim())), "main window did not finish starting");
  const bridge = await main.evaluate(() => window.__TAURI_INTERNALS__.invoke("bridge_status"));
  assert.equal(bridge.port, port, "The app must use the isolated port");
  if (locale) {
    await main.evaluate(l => localStorage.setItem("spellcast.locale", l), locale);
    await main.reload();
    await until(() => main.evaluate(l => document.documentElement.lang === l && Boolean(document.querySelector("#settings-open")?.textContent.trim()), locale), "main window did not restart in the chosen language");
  }
  if (size) {
    await main.evaluate(([width, height]) => window.__TAURI_INTERNALS__.invoke("plugin:window|set_size", { label: "main", value: { Logical: { width, height } } }), size);
    await until(() => main.evaluate(([w, h]) => innerWidth === w && innerHeight === h, size), `window did not reach ${size.join("x")}`);
  }
  console.log(`[run-native-check] ${name}: app pid ${native.pid}, bridge ${port}, CDP ${cdp}, sandbox ${sandbox}`);
  const check = spawn(process.execPath, [path.join(repo, "scripts", `${name}.mjs`), ...passThrough], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, SPELLCAST_CDP: `http://127.0.0.1:${cdp}`, SPELLCAST_TEST_PORT: String(port), SPELLCAST_TEST_OUTPUT: output },
  });
  code = await new Promise(resolve => check.on("exit", resolve));
} finally {
  // WebView2 may hold recent localStorage writes (local drafts) in memory after a busy run. Closing
  // its browser through CDP shuts the profile down cleanly, so a later --verify-restart sees what the
  // check left; the app process itself is then stopped.
  if (native.exitCode === null) {
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json();
      const socket = new WebSocket(webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await until(async () => !(await fetch(`http://127.0.0.1:${cdp}/json/version`, { signal: AbortSignal.timeout(500) }).then(r => r.ok, () => false)), "WebView did not close", 15000);
    } catch (error) { console.warn(`[run-native-check] WebView did not close cleanly: ${error.message}`); }
    await sleep(1000);
    if (native.exitCode === null) {
      try { execFileSync("taskkill", ["/PID", String(native.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
  }
}
console.log(`[run-native-check] ${name} exited ${code}; evidence in ${output}`);
process.exit(code ?? 1);
