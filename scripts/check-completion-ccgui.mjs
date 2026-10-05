/**
 * Isolated native check of Claude completion cards against a CC GUI window.
 *
 * A fake CC GUI plugin stands in for the real one: it registers a lease per conversation through the same
 * HTTP endpoints, reports attention with an `active: true` heartbeat, and polls `/api/hosts/requests` for the
 * focus request a double-clicked card sends. The overlay is the real one, in the verify-identifier debug build
 * (so it can never reach an installed Spellcast); the real CC GUI window is never raised
 * (SPELLCAST_CCGUI_EXE points at a name nothing runs under).
 *
 *   TAURI_CONFIG='{"identifier":"com.spellcast.board.verify"}' cargo build --manifest-path src-tauri/Cargo.toml
 *
 * Not covered: the real plugin inside a real CC GUI, and the real window being brought to the front.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repo, 'output/completion-ccgui', `check-${Date.now()}`);
const inbox = path.join(output, 'inbox');
const executable = path.resolve(repo, process.env.SPELLCAST_COMPLETION_TEST_EXE ?? 'src-tauri/target/debug/spellcast.exe');
const PORT = 47219, CDP = 9364;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 20000) {
  const start = Date.now();
  do { try { const value = await read(); if (value) return value; } catch {} await sleep(120); } while (Date.now() - start < timeout);
  throw new Error(message);
}

assert((await readFile(executable)).includes(Buffer.from('com.spellcast.board.verify')),
  'Build the debug app with the com.spellcast.board.verify identifier so it cannot reach an installed Spellcast');
for (const busy of [PORT, CDP]) {
  assert(!(await fetch(`http://127.0.0.1:${busy}/`, { signal: AbortSignal.timeout(800) }).then(() => true, () => false)), `Port ${busy} is already answering`);
}
await mkdir(inbox, { recursive: true });
const env = { ...process.env, CODEX_HOME: path.join(output, 'codex'), GROK_HOME: path.join(output, 'grok'), CLAUDE_CONFIG_DIR: path.join(output, 'claude'),
  SPELLCAST_COMPLETIONS_DIR: inbox, SPELLCAST_STATE_FILE: path.join(output, 'board.sqlite3'), SPELLCAST_PORT: String(PORT),
  SPELLCAST_CCGUI_EXE: 'spellcast-check-no-such-window.exe',
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` };
for (const proxy of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[proxy];
function exec(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(input);
  });
}

const S = { platformer: 'a09c1947-841e-48c0-8817-6b82325eef08', orbit: 'e2b1f6d4-5c3a-4f0e-9b7d-3a6c8d1f2e47',
  plain: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', silent: '0f1e2d3c-4b5a-4968-8776-655443322110' };
const stop = (session, cwd, message) => JSON.stringify({ session_id: session, transcript_path: '', cwd, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message });
const complete = async (session, cwd, message) => assert.equal((await exec(['--claude-notify', inbox], stop(session, cwd, message))).code, 0);

// ---- a fake CC GUI plugin ----
const base = `http://127.0.0.1:${PORT}`;
let hostKey;
async function call(route, { body, token, method = 'POST' } = {}) {
  const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}`);
  return response.json();
}
const leases = new Map();
async function connect(session, cwd) {
  const registered = await call('/api/hosts/register', { token: hostKey, body: { source_id: `claude:${session}`, client: 'ccgui', engine: 'claude',
    native_session_id: session, gui_session_id: session, cwd, client_instance_id: 'check-instance', window_id: 'window-1',
    capabilities: ['canvas_requests', 'durable_receipts'], label: `CC GUI · ${session.slice(0, 8)}`, active: false } });
  const lease = { pin: registered.host_pin, token: registered.lease_token, session, focusSeen: new Set(), selected: [] };
  leases.set(session, lease);
  return lease;
}
const attend = lease => call('/api/hosts/heartbeat', { token: lease.token, body: { host_pin: lease.pin, active: true } });
let polling = true;
async function pollLoop() {
  while (polling) {
    for (const lease of leases.values()) {
      try {
        // Leases last 30 seconds; a connected window keeps them alive with liveness-only heartbeats.
        if (!(Date.now() - (lease.beat ?? 0) < 5000)) { lease.beat = Date.now(); await call('/api/hosts/heartbeat', { token: lease.token, body: { host_pin: lease.pin, active: false } }); }
        if (!lease.answers) continue;
        const page = await call(`/api/hosts/requests?lease_id=${encodeURIComponent(lease.pin.lease_id)}&since=0&wait_ms=0`, { token: lease.token, method: 'GET' });
        if (page.focus?.id && !lease.focusSeen.has(page.focus.id)) {
          lease.focusSeen.add(page.focus.id); lease.selected.push(lease.session);
          await attend(lease); // what the plugin does after sessions.selectSession
        }
      } catch {}
    }
    await sleep(150);
  }
}

let native, browser, nativeErrors = '';
async function shutdown() {
  polling = false;
  if (browser) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label })); } catch {}
    }
    await browser.close().catch(() => {}); browser = undefined; await sleep(700);
  }
  if (native && native.exitCode === null) { const ended = new Promise(resolve => native.once('exit', resolve)); native.kill(); await ended; }
  native = undefined;
}
const report = { evidence: 'real overlay + real bridge endpoints in an isolated app; fake CC GUI plugin; the real CC GUI is never touched or raised' };

try {
  // Seed completions before the app starts: two chats a CC GUI will report for, one nobody reports for, one Codex task.
  await complete(S.platformer, 'G:/Demos/Platformer', '二段跳已加好。');
  await complete(S.orbit, 'G:/Demos/Orbit', '相机跟随调平滑了。');
  await complete(S.plain, 'G:/Demos/Plain', '没有 CC GUI 的会话。');
  await complete(S.silent, 'G:/Demos/Silent', 'CC GUI 连着但不会响应聚焦请求。');
  native = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  native.stderr.on('data', chunk => { nativeErrors += chunk; });
  await until(async () => {
    if (native.exitCode !== null) throw new Error(`Native app exited ${native.exitCode}: ${nativeErrors}`);
    return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok;
  }, 'Native CDP did not start', 60000);
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('completions.html')), 'Completion window did not appear', 60000);
  const card = session => page.locator(`.completion-bubble[data-thread="${session}"]`);
  const hint = async session => (await card(session).locator('.hint').textContent()) ?? '';
  await until(async () => (await page.locator('.completion-bubble').count()) === 4, 'Expected four cards');

  // 1. No CC GUI connected yet: every Claude card can only be closed.
  for (const session of Object.values(S)) assert.match(await hint(session), /Claude · (双击关闭|Double-click to dismiss)/, session);

  // 2. Connected CC GUI windows turn their cards into "return to CC GUI"; a chat nobody reports for stays closable.
  hostKey = (await readFile(path.join(output, 'credentials/host-link.key'), 'utf8')).trim();
  const platformer = await connect(S.platformer, 'G:/Demos/Platformer');
  const orbit = await connect(S.orbit, 'G:/Demos/Orbit');
  const silent = await connect(S.silent, 'G:/Demos/Silent');
  platformer.answers = true; orbit.answers = true; // `silent` is registered but never polls
  void pollLoop();
  const returns = /CC GUI/;
  for (const session of [S.platformer, S.orbit, S.silent]) await until(async () => returns.test(await hint(session)), `${session} did not become openable`);
  assert.match(await hint(S.plain), /Claude · (双击关闭|Double-click to dismiss)/);
  const aria = await card(S.platformer).locator('.task').getAttribute('aria-label');
  assert.match(aria, /CC GUI/); assert.doesNotMatch(aria, /Codex/);
  report.hintsWithConnectedWindow = { platformer: await hint(S.platformer), plain: await hint(S.plain) };
  await page.locator('.completion-bubble').first().screenshot({ path: path.join(output, 'card-openable.png') });

  // 3. Liveness is not attention: a heartbeat without `active` leaves the card alone.
  await call('/api/hosts/heartbeat', { token: orbit.token, body: { host_pin: orbit.pin, active: false } });
  await sleep(2500);
  assert.equal(await card(S.orbit).count(), 1);

  // 4. Opening the chat in CC GUI after the task finished clears its card, and only that one.
  await attend(orbit);
  await until(async () => (await card(S.orbit).count()) === 0, 'Attention on the chat did not clear its card', 8000);
  assert.equal(await card(S.platformer).count(), 1); assert.equal(await card(S.plain).count(), 1);
  const db = new DatabaseSync(path.join(inbox, 'inbox.sqlite3'), { readOnly: true });
  assert.equal(db.prepare('SELECT dismissed FROM completions WHERE thread_id=?').get(S.orbit).dismissed, 1);
  report.attentionClearsOnlyThatCard = true;

  // 5. Double-click: the request reaches the plugin, which answers with attention; the card goes away.
  const opening = card(S.platformer).locator('.task').dblclick();
  await opening;
  await until(async () => (await card(S.platformer).count()) === 0, 'Double-click did not return to CC GUI and clear the card', 8000);
  assert.deepEqual(platformer.selected, [S.platformer], 'the plugin got exactly one focus request for that chat');
  assert.equal(db.prepare('SELECT dismissed FROM completions WHERE thread_id=?').get(S.platformer).dismissed, 1);
  report.doubleClickReturnsAndClears = true;

  // 6. A window that never answers: the card stays, with the reason, and can be tried again.
  await card(S.silent).locator('.task').dblclick();
  await until(async () => ((await card(S.silent).locator('.error').textContent()) ?? '').length > 0, 'No error shown for an unresponsive CC GUI', 8000);
  assert.equal(await card(S.silent).count(), 1);
  assert.match(await card(S.silent).locator('.error').textContent(), /CC GUI/);
  assert.match(await hint(S.silent), /CC GUI/, 'the hint is restored for another try');
  assert.equal(db.prepare('SELECT dismissed FROM completions WHERE thread_id=?').get(S.silent).dismissed, 0);
  report.unresponsiveWindowKeepsTheCard = true;

  // 7. A chat with no CC GUI still just closes.
  await card(S.plain).locator('.task').dblclick();
  await until(async () => (await card(S.plain).count()) === 0, 'A plain Claude card did not close');
  assert.equal(db.prepare('SELECT dismissed FROM completions WHERE thread_id=?').get(S.plain).dismissed, 1);
  report.cardWithoutWindowJustCloses = true;

  // 8. The next task of an attended chat is a new card again, and it can be opened.
  await sleep(20);
  await complete(S.orbit, 'G:/Demos/Orbit', '第二轮：又做完了一件事。');
  await until(async () => (await card(S.orbit).count()) === 1, 'The next task of an attended chat did not show again');
  assert.match(await hint(S.orbit), returns);
  db.close();
  await sleep(300);
  await shutdown();
  await writeReport();
} finally { await shutdown(); }

async function writeReport() {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
