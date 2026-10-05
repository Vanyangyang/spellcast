/**
 * Real native main-window close regression, using only an isolated verify build.
 *
 *   SPELLCAST_CLOSE_TEST_EXE=<verify baseline or fixed exe> node scripts/check-close-lifecycle.mjs
 *
 * Requires Node with node:sqlite, Playwright, and a Windows debug executable built
 * with identifier=com.spellcast.board.verify and WebView2 CDP support. No build is
 * performed here. Fixtures are synthetic; window commands, PIDs, and TCP listeners
 * are real. The system pointer is never moved. A forced kill is failure cleanup only.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repo, 'output/close-lifecycle', `check-${Date.now()}-${process.pid}`);
const executable = path.resolve(repo, process.env.SPELLCAST_CLOSE_TEST_EXE ?? 'src-tauri/target/debug/spellcast.exe');
const inbox = path.join(output, 'inbox');
const forbiddenPorts = new Set([47193, 47194]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const children = [];
const browsers = [];
const report = {
  startedAt: new Date().toISOString(), executable, output,
  evidence: 'synthetic Claude Stop data + real native window close, process exits, listener ownership, and TCP release; no system pointer movement',
  checks: [], processes: [], cleanup: [], passed: false,
};
let env, bridgePort, cdpPort, playwright;

async function until(read, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

function within(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

// Binding, rather than just an HTTP request failing, proves the listener is gone.
async function canBind(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve(true)));
  });
}

async function freePort(excluded = new Set()) {
  for (;;) {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!forbiddenPorts.has(port) && !excluded.has(port)) return port;
  }
}

async function powershell(command) {
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function listenerOwners(port) {
  assert(!forbiddenPorts.has(port), 'Never inspect the installed application ports');
  const raw = await powershell(`@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`);
  return raw ? [JSON.parse(raw)].flat().filter(value => value !== null) : [];
}

async function matchingProcesses() {
  const quoted = executable.replaceAll("'", "''");
  const raw = await powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${quoted}' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`);
  return raw ? [JSON.parse(raw)].flat().filter(value => value !== null) : [];
}

function launch(kind, args = [], input) {
  const child = spawn(executable, args, { cwd: repo, env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  const record = { kind, pid: child.pid, args, launchedAt: new Date().toISOString(), stderr: '' };
  const tracked = { child, record, done: false, error: undefined };
  children.push(tracked);
  report.processes.push(record);
  tracked.ended = new Promise(resolve => {
    child.once('error', error => {
      tracked.error = error;
      tracked.done = true;
      record.spawnError = String(error);
      resolve(record);
    });
    child.once('exit', (code, signal) => {
      tracked.done = true;
      Object.assign(record, { exitCode: code, signal, exitedAt: new Date().toISOString() });
      resolve(record);
    });
  });
  child.stderr.on('data', chunk => { record.stderr = (record.stderr + chunk).slice(-16000); });
  // A failed process may close stdin before the fixture has been written.
  child.stdin.on('error', error => { record.stdinError = String(error); });
  child.stdin.end(input ?? '');
  return tracked;
}

function assertAlive(native) {
  if (native.error) throw native.error;
  assert(!native.done, `Native PID ${native.record.pid} exited unexpectedly: ${JSON.stringify(native.record)}`);
}

async function expectExit(native, label, timeout = 20000) {
  const result = await within(native.ended, timeout, `${label}: PID ${native.record.pid} did not exit normally`);
  if (native.error) throw native.error;
  assert.equal(result.exitCode, 0, `${label}: expected successful native exit`);
  assert.equal(result.signal, null, `${label}: native process must not be killed`);
  return result;
}

async function assertPortsReleased(label) {
  await until(async () => (await canBind(bridgePort)) && (await canBind(cdpPort)), `${label}: bridge or CDP listener survived native exit`, 15000);
  const owners = { bridge: await listenerOwners(bridgePort), cdp: await listenerOwners(cdpPort) };
  assert.deepEqual(owners, { bridge: [], cdp: [] }, `${label}: listener ownership remains`);
  return owners;
}

const invoke = (page, command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });

async function windowState(app) {
  const state = await app.main.evaluate(async () => {
    const call = window.__TAURI_INTERNALS__.invoke;
    return { mainVisible: await call('plugin:window|is_visible', { label: 'main' }),
      completionVisible: await call('plugin:window|is_visible', { label: 'completions' }),
      bridge: await call('bridge_status'), voice: await call('get_completion_voice') };
  });
  state.cards = await app.completions.locator('.completion-bubble').count();
  assert.equal(state.bridge.port, bridgePort, 'Native app used the wrong bridge port');
  return state;
}

async function startApp(label) {
  await assertPortsReleased(`${label}: before launch`);
  const native = launch(label);
  await until(async () => {
    assertAlive(native);
    return fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(600) }).then(response => response.ok, () => false);
  }, `${label}: isolated WebView2 CDP did not start`, 60000);
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 15000 });
  browsers.push(browser);
  const app = { native, browser };
  await until(async () => {
    assertAlive(native);
    const pages = browser.contexts().flatMap(context => context.pages());
    for (const page of pages) {
      if (page.isClosed()) continue;
      const label = await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => undefined);
      if (label === 'main') app.main = page;
      if (label === 'completions') app.completions = page;
    }
    return app.main && app.completions;
  }, `${label}: both native WebViews must exist`, 30000);
  await until(async () => {
    assertAlive(native);
    return !(await canBind(bridgePort));
  }, `${label}: bridge did not start`);
  const bridgeOwners = await listenerOwners(bridgePort);
  assert.deepEqual(bridgeOwners, [native.record.pid], `${label}: bridge must belong to this spawned native PID`);
  const voice = await invoke(app.main, 'set_completion_voice', { enabled: false });
  assert.equal(voice.enabled, false, 'Disable completion speech before synthesizing any event');
  report.checks.push({ label: `${label}: started`, pid: native.record.pid, bridgeOwners, ...(await windowState(app)) });
  return app;
}

async function closeMain(app, label) {
  assertAlive(app.native);
  const before = await windowState(app);
  const started = Date.now();
  // A native close may destroy the WebView before its IPC result is delivered.
  // Keep the evaluation observed, but do not require the dying page to answer.
  const closeResult = invoke(app.main, 'plugin:window|close', { label: 'main' })
    .then(() => ({ returned: true }), error => ({ error: String(error) }));
  const exited = await expectExit(app.native, label);
  const owners = await assertPortsReleased(label);
  const ipc = await within(closeResult, 2000, 'close IPC remained pending after process exit')
    .catch(error => ({ interruptedAfterExit: String(error) }));
  if (ipc.error) assert.match(ipc.error, /closed|destroyed|disconnected|detached|terminated|cannot find context/i, 'Unexpected close IPC error');
  report.checks.push({ label, pid: app.native.record.pid, before, closeCommand: 'plugin:window|close',
    closeLabel: 'main', ipc, exitCode: exited.exitCode, signal: exited.signal, elapsedMs: Date.now() - started, releasedListeners: owners });
  await app.browser.close().catch(() => {});
}

function completionRows() {
  const db = new DatabaseSync(path.join(inbox, 'inbox.sqlite3'), { readOnly: true });
  try { return db.prepare('SELECT thread_id,turn_id,summary,client,dismissed FROM completions ORDER BY sequence').all(); }
  finally { db.close(); }
}

async function notify(session, message) {
  const payload = JSON.stringify({ session_id: session, transcript_path: '', cwd: path.join(output, 'synthetic-project'),
    hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message });
  const helper = launch('synthetic Claude Stop helper', ['--claude-notify', inbox], payload);
  await expectExit(helper, 'Claude Stop helper', 10000);
  const rows = completionRows().filter(row => row.thread_id === session);
  assert.equal(rows.length, 1, 'Helper must record exactly one synthetic completion');
  assert.equal(rows[0].client, 'claude');
  assert.equal(rows[0].summary, message);
  assert.equal(rows[0].dismissed, 0);
  return rows[0];
}

const sessions = {
  dismiss: 'ad7a054f-8231-4579-b3c4-8f04bc180001',
  visible: 'ad7a054f-8231-4579-b3c4-8f04bc180002',
  offline: 'ad7a054f-8231-4579-b3c4-8f04bc180003',
};

try {
  assert.equal(process.platform, 'win32', 'This regression requires the Windows native app');
  assert((await readFile(executable)).includes(Buffer.from('com.spellcast.board.verify')),
    'Refuse to launch: executable must embed com.spellcast.board.verify; never use the installed Spellcast');
  const require = createRequire(import.meta.url);
  try { playwright = require('playwright'); }
  catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  assert.deepEqual(await matchingProcesses(), [], 'Selected verify executable is already running; do not attach to another test');
  await mkdir(inbox, { recursive: true });
  bridgePort = await freePort();
  cdpPort = await freePort(new Set([bridgePort]));
  Object.assign(report, { identifier: 'com.spellcast.board.verify', bridgePort, cdpPort });
  env = { ...process.env, SPELLCAST_PORT: String(bridgePort), SPELLCAST_STATE_FILE: path.join(output, 'board.sqlite3'),
    SPELLCAST_COMPLETIONS_DIR: inbox, CODEX_HOME: path.join(output, 'codex'), GROK_HOME: path.join(output, 'grok'),
    CLAUDE_CONFIG_DIR: path.join(output, 'claude'), SPELLCAST_CCGUI_EXE: 'spellcast-close-check-no-such-window.exe',
    WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` };
  for (const key of Object.keys(env)) if (/^(http|https|all)_proxy$/i.test(key)) delete env[key];
  await Promise.all(['codex', 'grok', 'claude', 'webview', 'synthetic-project'].map(folder => mkdir(path.join(output, folder), { recursive: true })));

  const empty = await startApp('empty inbox');
  const emptyState = await windowState(empty);
  assert.equal(emptyState.cards, 0);
  assert.equal(emptyState.completionVisible, false, 'Warm completion window must exist but remain hidden without events');
  assert.deepEqual(completionRows(), [], 'No completion event is allowed in the empty-inbox case');
  await closeMain(empty, 'main close with hidden completion window exits');

  const active = await startApp('reopen after clean exit');
  assert.notEqual(active.native.record.pid, empty.native.record.pid, 'Reopen must create a new native process');
  await invoke(active.main, 'plugin:window|hide', { label: 'main' });
  assert.equal((await windowState(active)).mainVisible, false, 'Fixture must hide main before single-instance restore');
  const second = launch('second launch while active');
  await expectExit(second, 'Second launch delegates to the existing instance', 10000);
  await until(async () => (await windowState(active)).mainVisible, 'Second launch did not restore the original main window');
  assertAlive(active.native);
  assert.deepEqual(await matchingProcesses(), [active.native.record.pid], 'Second launch must not leave a second native service process');
  const owners = await listenerOwners(bridgePort);
  assert.deepEqual(owners, [active.native.record.pid], 'Second launch must preserve the original bridge owner');
  report.checks.push({ label: 'second launch restores main and preserves one service', originalPid: active.native.record.pid,
    secondPid: second.record.pid, secondExitCode: second.record.exitCode, bridgeOwners: owners, ...(await windowState(active)) });

  const dismissed = await notify(sessions.dismiss, 'Synthetic card to dismiss individually');
  const pending = await notify(sessions.visible, 'Synthetic card preserved across main close');
  await until(async () => (await windowState(active)).cards === 2 && (await windowState(active)).completionVisible, 'Two synthetic cards did not become visible');
  await invoke(active.completions, 'dismiss_completion', { threadId: dismissed.thread_id, turnId: dismissed.turn_id });
  await until(async () => (await windowState(active)).cards === 1, 'Individual completion dismissal did not remove exactly one card');
  assertAlive(active.native);
  assert.equal(await active.completions.locator(`.completion-bubble[data-thread="${sessions.visible}"]`).count(), 1, 'Other card must remain');
  assert.equal(completionRows().find(row => row.thread_id === sessions.dismiss).dismissed, 1);
  assert.equal(completionRows().find(row => row.thread_id === sessions.visible).dismissed, 0);
  report.checks.push({ label: 'dismiss_completion closes only its card; native app and bridge still work', pid: active.native.record.pid, ...(await windowState(active)) });
  await closeMain(active, 'main close with visible completion card exits');
  assert.equal(completionRows().find(row => row.thread_id === pending.thread_id).dismissed, 0, 'Main close must preserve the pending inbox');

  const offline = await notify(sessions.offline, 'Synthetic offline completion restored on next launch');
  const offlineOwners = await assertPortsReleased('offline helper');
  assert.deepEqual(await matchingProcesses(), [], 'Offline helper must not create or retain any GUI process');
  // Watch for delayed startup too; the helper should only have written the inbox.
  await sleep(1500);
  await assertPortsReleased('offline helper after quiet interval');
  assert.deepEqual(await matchingProcesses(), [], 'Offline helper started a delayed GUI process');
  report.checks.push({ label: 'offline helper records only; no GUI or listeners', row: offline, releasedListeners: offlineOwners });

  const restored = await startApp('reopen with persisted inbox');
  assert.equal((await invoke(restored.main, 'get_completion_voice')).enabled, false, 'Disabled voice preference must persist across restart');
  await until(async () => (await windowState(restored)).cards === 2 && (await windowState(restored)).completionVisible, 'Pending online and offline cards did not restore');
  for (const session of [sessions.visible, sessions.offline]) {
    assert.equal(await restored.completions.locator(`.completion-bubble[data-thread="${session}"]`).count(), 1, 'Expected persisted card was not restored');
  }
  assert.equal(await restored.completions.locator(`.completion-bubble[data-thread="${sessions.dismiss}"]`).count(), 0, 'Dismissed card must not restore');
  report.checks.push({ label: 'restart recovers pending cards and preserves dismissal', rows: completionRows(), ...(await windowState(restored)) });
  await closeMain(restored, 'final main close exits normally');
  assert.deepEqual(await matchingProcesses(), [], 'All test GUI processes must be gone');
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  // Only processes spawned by this script are eligible for forced cleanup. A
  // forced exit is never accepted as successful close-lifecycle evidence.
  for (const tracked of children) {
    if (tracked.done) continue;
    await within(tracked.ended, 1500, 'cleanup grace period elapsed').catch(() => {});
    if (tracked.done) continue;
    report.cleanup.push({ pid: tracked.record.pid, forced: true, reason: 'test failed or child exceeded normal-exit timeout' });
    report.passed = false;
    process.exitCode = 1;
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(tracked.record.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      await within(tracked.ended, 5000, 'spawned process remained after cleanup');
    } catch (error) { report.cleanup.at(-1).error = String(error); }
  }
  for (const browser of browsers) await within(browser.close(), 3000, 'CDP detach timed out').catch(() => {});
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  const reportPath = path.join(output, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, checks: report.checks.length, report: reportPath }));
}
