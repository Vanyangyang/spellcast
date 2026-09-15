import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))); }
const [appArg, cliArg, resourceArg, rootArg] = process.argv.slice(2);
assert.ok(appArg && cliArg && resourceArg && rootArg, 'Pass app exe, native Codex exe, resources, fresh isolated root.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(rootArg), cli = path.resolve(cliArg), appSource = path.resolve(appArg), resources = path.resolve(resourceArg);
assert.equal(existsSync(root), false, 'Use a fresh acceptance root.');
const hash = data => createHash('sha256').update(data).digest('hex');
const fileHash = file => existsSync(file) ? hash(readFileSync(file)) : null;
const realHome = process.env.USERPROFILE;
const protectedFiles = ['.codex/config.toml', '.agents/plugins/marketplace.json', '.codex/skills/spellcast/SKILL.md', 'plugins/spellcast/.codex-plugin/plugin.json', 'AppData/Roaming/com.spellcast.board/spellcast.sqlite3'].map(rel => path.join(realHome, rel));
const before = Object.fromEntries(protectedFiles.map(file => [file, fileHash(file)]));
const existing = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process spellcast -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8', windowsHide: true });
assert.equal(existing.stdout.trim(), '0', 'An existing Spellcast process must be handled before isolated native acceptance.');
const preflight = spawnSync(process.execPath, [path.join(repo, 'scripts/check-native-codex-isolation.mjs'), cli, root, resources], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
const isolation = JSON.parse(readFileSync(path.join(root, 'result.json'), 'utf8'));
const appDir = path.join(root, 'app'), appExe = path.join(appDir, 'spellcast.exe');
mkdirSync(appDir);
cpSync(appSource, appExe);
cpSync(resources, path.join(appDir, 'resources', 'codex-plugin'), { recursive: true });
const port = 47321, cdpPort = 47322;
for (const candidatePort of [port, cdpPort]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(candidatePort, '127.0.0.1', () => probe.close(resolve));
  });
}
const windows = process.env.SystemRoot || 'C:\\Windows';
const machineEnv = Object.fromEntries(['SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const env = {
  ...machineEnv,
  SystemRoot: windows, WINDIR: windows, COMSPEC: path.join(windows, 'System32', 'cmd.exe'),
  PATH: [path.dirname(cli), path.join(windows, 'System32'), path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
  HOME: isolation.userHome, USERPROFILE: isolation.userHome, CODEX_HOME: isolation.codexHome,
  APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
  SPELLCAST_PORT: String(port), SPELLCAST_STATE_FILE: path.join(root, 'state.sqlite3'),
  WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'WebView2'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
};
const children = [];
function startApp() {
  const child = spawn(appExe, [], { cwd: path.join(root, 'empty-cwd'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const record = { child, exit, output: () => ({ stdout, stderr }) }; children.push(record); return record;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
function treeHash(dir) {
  const files = [];
  const walk = (current, relative = '') => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name), rel = path.join(relative, name);
      if (statSync(file).isDirectory()) walk(file, rel); else files.push([rel, fileHash(file)]);
    }
  };
  walk(dir); return hash(JSON.stringify(files));
}
const startedAt = new Date().toISOString(), first = startApp();
const cdpProbes = [];
let browser, page, report;
try {
  await until(async () => {
    if (first.child.exitCode !== null) throw new Error(`Candidate exited before CDP: ${first.child.exitCode}; ${first.output().stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(500) });
      cdpProbes.push({ status: response.status, body: (await response.text()).slice(0, 300) });
      return response.ok;
    } catch (error) { cdpProbes.push({ error: error.message, cause: error.cause?.code }); return false; }
  }, 20000, 'WebView2 CDP');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => /tauri[.:]/.test(candidate.url())), 10000, 'native Tauri page');
  await page.locator('#settings-open').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__?.invoke)), true);
  await page.evaluate(() => {
    window.__setupAcceptance = [];
    const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      const result = await invoke(command, args, options);
      if (command === 'complete_setup_install' || command === 'complete_setup_status') window.__setupAcceptance.push({ command, args, result });
      return result;
    };
  });
  if (!(await page.locator('#settings-open').isVisible())) await page.locator('.top-more summary').click();
  await page.locator('#settings-open').click();
  await page.locator('#settings-clients [data-client="codex"]').click();
  const install = page.locator('#settings-complete-setup');
  await until(() => install.isEnabled(), 10000, 'setup enabled');
  const installOnce = async () => {
    const count = await page.evaluate(() => window.__setupAcceptance.filter(item => item.command === 'complete_setup_install').length);
    await install.click();
    const result = await until(() => page.evaluate(previous => {
      const calls = window.__setupAcceptance.filter(item => item.command === 'complete_setup_install');
      return calls.length > previous ? calls.at(-1).result : null;
    }, count), 45000, 'native setup result');
    writeFileSync(path.join(root, `install-${count + 1}.json`), JSON.stringify(result, null, 2));
    assert.equal(result.installed, true, JSON.stringify(result));
    assert.equal(result.mcp_url, `http://127.0.0.1:${port}/mcp`, 'Setup must use the actual native bridge endpoint.');
    for (const field of ['source_path', 'cache_path', 'marketplace_path']) assert.ok(path.resolve(result[field]).startsWith(root + path.sep), `${field} escaped isolation`);
    return result;
  };
  const installed = await installOnce();
  await page.screenshot({ path: path.join(root, 'native-installed.png') });
  const snap = () => ({ source: treeHash(installed.source_path), cache: treeHash(installed.cache_path), config: fileHash(path.join(isolation.codexHome, 'config.toml')), marketplace: fileHash(installed.marketplace_path) });
  const firstSnapshot = snap();
  await until(() => install.isEnabled(), 10000, 'setup settled');
  const repeated = await installOnce();
  const repeatedSnapshot = snap();
  assert.deepEqual(repeatedSnapshot, firstSnapshot, 'Repeat setup rewrote installed content.');
  await page.locator('#settings-close').click();
  const beforePage = await page.evaluate(() => ({ url: location.href, locale: localStorage.getItem('spellcast.locale'), view: localStorage.getItem('spellcast.canvas-view') }));
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|hide', { label: 'main' }));
  const second = startApp();
  const secondExit = await Promise.race([second.exit, sleep(10000).then(() => { throw new Error('Second instance did not exit'); })]);
  assert.equal(secondExit.code, 0);
  assert.equal(first.child.exitCode, null, 'The original instance exited.');
  await until(() => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })), 5000, 'existing main window shown');
  assert.deepEqual(await page.evaluate(() => ({ url: location.href, locale: localStorage.getItem('spellcast.locale'), view: localStorage.getItem('spellcast.canvas-view') })), beforePage);
  await page.screenshot({ path: path.join(root, 'native-single-instance.png') });
  const after = Object.fromEntries(protectedFiles.map(file => [file, fileHash(file)]));
  assert.deepEqual(after, before, 'Production baseline changed.');
  report = { pass: true, startedAt, finishedAt: new Date().toISOString(), appExe, appSha256: fileHash(appExe), nativeUrl: page.url(), nativePort: port, firstPid: first.child.pid, secondPid: second.child.pid, secondExit, existingWindowRestored: true, installed, repeated, repeatUnchanged: true, profile: root, protectedBefore: before, protectedAfter: after, trustConfirmed: false, note: 'Actual Tauri UI invoked native installation in an isolated profile. Fresh Codex hook activation is a separate acceptance step.' };
  writeFileSync(path.join(root, 'native-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, firstPid: report.firstPid, secondPid: report.secondPid, installedKind: installed.kind, repeatedKind: repeated.kind, repeatUnchanged: true, root }));
} catch (error) {
  const listeners = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetTCPConnection -LocalPort 47321,47322 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  writeFileSync(path.join(root, 'native-failure.json'), JSON.stringify({ message: error.message, stack: error.stack, cdpProbes: cdpProbes.slice(-3), listeners: listeners.stdout, processes: children.map(item => ({ pid: item.child.pid, exitCode: item.child.exitCode, signalCode: item.child.signalCode, stderr: item.output().stderr })) }, null, 2));
  throw error;
} finally {
  if (page && !page.isClosed()) { try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })); } catch {} }
  const normalExit = await Promise.race([first.exit, sleep(6000).then(() => null)]);
  if (browser) { try { await browser.close(); } catch {} }
  for (const [index, item] of children.entries()) {
    if (item.child.exitCode === null && !item.child.killed) item.child.kill();
    const output = item.output();
    writeFileSync(path.join(root, `app-${index + 1}.stdout.txt`), output.stdout);
    writeFileSync(path.join(root, `app-${index + 1}.stderr.txt`), output.stderr);
  }
  writeFileSync(path.join(root, 'app-processes.json'), JSON.stringify(children.map(item => ({ pid: item.child.pid, exitCode: item.child.exitCode, signalCode: item.child.signalCode, killRequested: item.child.killed })), null, 2));
  if (report) {
    report.firstExit = normalExit;
    report.pass = report.pass && normalExit?.code === 0;
    writeFileSync(path.join(root, 'native-result.json'), JSON.stringify(report, null, 2));
    assert.equal(report.pass, true, 'Candidate failed to exit normally after closing its window.');
  }
}
