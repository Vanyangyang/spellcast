/** Isolated native completion-inbox verification. Never writes production Codex/Canvas state. */
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
catch { playwright = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repo, 'output/completion-notifications', `check-${Date.now()}`);
await mkdir(output, { recursive: true });
const home = path.join(output, 'codex');
await mkdir(home, { recursive: true });
const inbox = path.join(home, 'spellcast/completions');
const executable = process.env.SPELLCAST_COMPLETION_TEST_EXE || path.join(repo, 'src-tauri/target/debug/spellcast.exe');
const env = { ...process.env, CODEX_HOME: home, SPELLCAST_COMPLETIONS_DIR: inbox,
  SPELLCAST_STATE_FILE: path.join(output, 'board.sqlite3'), SPELLCAST_PORT: '47215',
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9351' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 15000) {
  const start = Date.now();
  do { const value = await read(); if (value) return value; await sleep(150); } while (Date.now() - start < timeout);
  throw new Error(message);
}
async function run(args) {
  const process = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise((resolve, reject) => { process.on('exit', resolve); process.on('error', reject); }), 0);
}
const forward = path.join(output, 'forward.mjs');
const forwarded = path.join(output, 'forwarded.json');
await writeFile(forward, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(forwarded)},JSON.stringify(process.argv.slice(2)));`);
await writeFile(path.join(home, 'config.toml'), `model = "preserve-me"\nnotify = ${JSON.stringify([process.execPath, forward, 'literal $() argument'])}\n[hooks]\nenabled = true\n`);
await run(['--install-completion-hook']);
const config = await readFile(path.join(home, 'config.toml'), 'utf8');
assert(config.includes('preserve-me')); assert(config.includes('[hooks]')); assert(config.includes('--codex-notify'));
const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,source TEXT)');
const thread = process.env.CODEX_THREAD_ID;
assert.match(thread ?? '', /^[0-9a-f-]{36}$/i, 'Use the invoking Codex thread only for the explicit deep-link smoke check.');
db.prepare('INSERT INTO threads VALUES (?,?,?)').run(thread, '完成气泡 · 原生交互验证', 'vscode');
const hidden = '12345678-1234-4234-9234-123456789abc';
db.prepare('INSERT INTO threads VALUES (?,?,?)').run(hidden, '内部任务，不应显示', '{"subagent":{"other":"title"}}');
const payload = (id, turn) => JSON.stringify({ type: 'agent-turn-complete', 'thread-id': id, 'turn-id': turn,
  cwd: 'G:\\VibeProj\\spellcast', 'input-messages': ['测试完成通知'], 'last-assistant-message': '去重、置顶和原生交互验证；这是一条隔离的测试通知。' });
let native, browser, nativeErrors = '', generation = 0;
function start() {
  nativeErrors = '';
  generation++;
  native = spawn(executable, [], { env: { ...env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(output, `webview-${generation}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${9350 + generation}`,
  }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  native.stderr.on('data', chunk => { nativeErrors += chunk.toString(); });
}
async function connect() {
  await until(async () => {
    if (native.exitCode !== null) throw new Error(`Native app exited ${native.exitCode}: ${nativeErrors}`);
    try { return (await fetch(`http://127.0.0.1:${9350 + generation}/json/version`)).ok; } catch { return false; }
  }, 'Native CDP did not start');
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${9350 + generation}`);
}
async function overlay() { return until(async () => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('completions.html')), 'Completion window did not appear'); }
async function focus(page) {
  await page.bringToFront();
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus', { label: 'completions' }));
  await until(() => page.evaluate(() => document.hasFocus()), 'Native test window did not gain focus');
}
async function stop() {
  if (browser) {
    for (const page of browser.contexts().flatMap(context => context.pages()).sort((a, b) => Number(a.url().endsWith('/')) - Number(b.url().endsWith('/')))) {
      try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label })); } catch {}
    }
    await browser.close(); browser = undefined;
    await sleep(700);
  }
  if (native && native.exitCode === null) {
    const ended = new Promise(resolve => native.once('exit', resolve)); native.kill(); await ended;
  }
  native = undefined;
  await sleep(700);
}
const report = { evidence: 'isolated synthetic notify input + native WebView interaction; no live host-completion event claimed' };
try {
  await run(['--codex-notify', inbox, payload(hidden, 'internal')]);
  await run(['--codex-notify', inbox, payload(thread, 'first')]);
  await run(['--codex-notify', inbox, payload(thread, 'first')]);
  await until(async () => { try { return JSON.parse(await readFile(forwarded, 'utf8')).at(-1) === payload(thread, 'first'); } catch { return false; } }, 'Original notify was not forwarded');
  const args = JSON.parse(await readFile(forwarded, 'utf8')); assert.equal(args[0], 'literal $() argument');
  report.originalNotifyForwarded = true;
  start(); await connect(); let page = await overlay();
  await page.locator('.completion-bubble').waitFor();
  assert.equal(await page.locator('.completion-bubble').count(), 1);
  report.deduplicatedAndFiltered = true;
  const style = await page.locator('.completion-bubble').evaluate(el => ({ background: getComputedStyle(el).backgroundImage, title: el.querySelector('.title').textContent }));
  assert(style.background.includes('rgba(')); assert(style.title.includes('原生交互'));
  await page.screenshot({ path: path.join(output, 'completion-native.png'), omitBackground: true });
  report.style = style;
  report.alwaysOnTop = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_always_on_top', { label: 'completions' }));
  assert.equal(report.alwaysOnTop, true);
  await focus(page);
  assert.equal(await page.locator('#completion-voice').getAttribute('aria-pressed'), 'true');
  await page.locator('#completion-voice').click();
  await until(async () => (await page.locator('#completion-voice').getAttribute('aria-pressed')) === 'false', 'Voice mute did not persist');
  report.voiceToggle = true;
  await page.locator('.task').click();
  assert.match(await page.locator('.hint').innerText(), /双击回到 Codex ↗|Double-click to return to Codex ↗/);
  await sleep(17000); assert.equal(await page.locator('.completion-bubble').count(), 1);
  report.survivesOrdinaryBubbleLifetime = true;
  await page.locator('.task').dblclick();
  await until(() => page.isClosed(), 'Double click did not dismiss the opened completion');
  report.doubleClickOpensAndDismisses = true;
  await run(['--codex-notify', inbox, payload(thread, 'keyboard')]);
  page = await overlay(); await page.locator('.completion-bubble').waitFor();
  await page.screenshot({ path: path.join(output, 'completion-before-keyboard.png'), omitBackground: true });
  await focus(page);
  await page.locator('.task').focus(); await page.keyboard.press('Enter');
  await until(() => page.isClosed(), 'Keyboard navigation did not dismiss the opened completion');
  report.keyboardOpensAndDismisses = true;
  const captured = new DatabaseSync(path.join(inbox, 'inbox.sqlite3'), { readOnly: true });
  assert.equal(captured.prepare('SELECT dismissed FROM completions WHERE thread_id=? AND turn_id=?').get(thread, 'first').dismissed, 1);
  assert.equal(captured.prepare('SELECT dismissed FROM completions WHERE thread_id=? AND turn_id=?').get(thread, 'keyboard').dismissed, 1);
  captured.close();
  await run(['--codex-notify', inbox, payload(thread, 'restore')]);
  page = await overlay(); await page.locator('.completion-bubble').waitFor();
  await stop(); start(); await connect(); page = await overlay();
  await page.locator('.completion-bubble').waitFor(); report.restartRecovery = true;
  assert.equal(await page.locator('.completion-bubble').getAttribute('data-turn'), 'restore');
  assert.equal(await page.locator('#completion-voice').getAttribute('aria-pressed'), 'false');
  report.voiceMuteSurvivesRestart = true;
  await focus(page);
  await page.screenshot({ path: path.join(output, 'completion-after-restart.png'), omitBackground: true });
  await page.locator('.dismiss').click();
  await until(() => page.isClosed(), 'Dismiss did not close the empty native window');
  await run(['--codex-notify', inbox, payload(thread, 'second')]);
  page = await overlay(); await page.locator('.completion-bubble').waitFor();
  assert.equal(await page.locator('.completion-bubble').getAttribute('data-turn'), 'second');
  report.newTurnAfterDismiss = true;
  const readStatePath = path.join(home, '.codex-global-state.json');
  const readState = ids => JSON.stringify({ 'electron-thread-read-state-v1': {
    version: 1, unreadByIdentity: { 'fixture-account': { 'local:fixture-host': ids } },
  } });
  await writeFile(readStatePath, readState([thread]));
  const readDb = new DatabaseSync(path.join(inbox, 'inbox.sqlite3'), { readOnly: true });
  try {
    await until(() => {
      try { return readDb.prepare('SELECT 1 FROM completion_unread_observations WHERE thread_id=? AND turn_id=?').get(thread, 'second'); }
      catch { return false; }
    }, 'Unread observation was not persisted');
    await writeFile(readStatePath, readState([]));
    await until(() => page.isClosed(), 'Codex read-state transition did not close the completion window');
    assert.equal(readDb.prepare('SELECT dismissed FROM completions WHERE thread_id=? AND turn_id=?').get(thread, 'second').dismissed, 1);
    report.codexReadStateDismissesNativeWindow = true;
    await run(['--codex-notify', inbox, payload(thread, 'after-read')]);
    page = await overlay(); await page.locator('.completion-bubble').waitFor();
    await sleep(2200);
    assert.equal(await page.locator('.completion-bubble').getAttribute('data-turn'), 'after-read');
    report.previousReadPreservesNewTurn = true;
  } finally { readDb.close(); }
  for (let index = 0; index < 12; index++) {
    const id = `12345678-1234-4234-9234-${String(index).padStart(12, '0')}`;
    db.prepare('INSERT INTO threads VALUES (?,?,?)').run(id, `其他完成任务 ${index + 1}`, 'vscode');
    await run(['--codex-notify', inbox, payload(id, 'one')]);
  }
  await until(async () => (await page.locator('.completion-bubble').count()) === 13, 'Concurrent tasks were lost');
  report.scrollableOverflow = await page.locator('#completions').evaluate(el => el.scrollHeight > el.clientHeight);
  assert(report.scrollableOverflow);
  await page.screenshot({ path: path.join(output, 'completion-overflow.png'), omitBackground: true });
  await run(['--uninstall-completion-hook']);
  assert((await readFile(path.join(home, 'config.toml'), 'utf8')).includes('literal $() argument'));
  report.uninstallRestoresNotify = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} finally { await stop(); db.close(); }
