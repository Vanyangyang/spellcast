import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const [appArg, cliArg, resourceArg, rootArg] = process.argv.slice(2);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(rootArg), cli = path.resolve(cliArg), appSource = path.resolve(appArg), resources = path.resolve(resourceArg);
const probe = path.join(repo, 'artifacts/runtime-acceptance-20260914/NativeUiProbe.exe');
assert.ok(fs.existsSync(probe));
assert.equal(fs.existsSync(root), false);
const digest = data => createHash('sha256').update(data).digest('hex');
const hashFile = file => fs.existsSync(file) ? digest(fs.readFileSync(file)) : null;
const protectedFiles = ['.codex/config.toml', '.agents/plugins/marketplace.json', '.codex/skills/spellcast/SKILL.md', 'plugins/spellcast/.codex-plugin/plugin.json', 'AppData/Roaming/com.spellcast.board/spellcast.sqlite3'].map(rel => path.join(process.env.USERPROFILE, rel));
const before = Object.fromEntries(protectedFiles.map(file => [file, hashFile(file)]));
const preflight = spawnSync(process.execPath, [path.join(repo, 'scripts/check-native-codex-isolation.mjs'), cli, root, resources], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
const isolation = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
const appDir = path.join(root, 'app'), appExe = path.join(appDir, 'spellcast.exe');
fs.mkdirSync(appDir);
fs.cpSync(appSource, appExe);
fs.cpSync(resources, path.join(appDir, 'resources/codex-plugin'), { recursive: true });
const windows = process.env.SystemRoot || 'C:\\Windows', port = 47321;
const legacySource = path.join(isolation.userHome, 'plugins/spellcast');
assert.ok(legacySource.startsWith(root + path.sep));
fs.unlinkSync(path.join(legacySource, 'integrity.json'));
const standalone = path.join(isolation.codexHome, 'skills/spellcast');
fs.cpSync(path.join(resources, 'skills/spellcast'), standalone, { recursive: true });
fs.writeFileSync(path.join(standalone, 'SKILL.md.before-observer-fixture'), 'preserve this legacy backup');
fs.writeFileSync(path.join(isolation.codexHome, 'config.toml'), `[mcp_servers.spellcast]\nenabled = true\nurl = "http://127.0.0.1:${port}/mcp"\n\n[mcp_servers.keepme]\nenabled = false\nurl = "http://127.0.0.1:47329/mcp"\n`);
await new Promise((resolve, reject) => {
  const admission = net.createServer();
  admission.once('error', reject);
  admission.listen(port, '127.0.0.1', () => admission.close(resolve));
});
const machineEnv = Object.fromEntries(['SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const env = { ...machineEnv, SystemRoot: windows, WINDIR: windows, COMSPEC: path.join(windows, 'System32/cmd.exe'), PATH: [path.dirname(cli), path.join(windows, 'System32'), path.join(windows, 'System32/WindowsPowerShell/v1.0')].join(';'), HOME: isolation.userHome, USERPROFILE: isolation.userHome, CODEX_HOME: isolation.codexHome, APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), SPELLCAST_PORT: String(port), SPELLCAST_STATE_FILE: path.join(root, 'state.sqlite3'), WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'WebView2') };
const children = [], actions = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout, label) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(150); } throw new Error(`Timed out: ${label}`); }
function startApp() {
  const child = spawn(appExe, [], { cwd: path.join(root, 'empty-cwd'), env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const record = { child, exit: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))), output: () => ({ stdout, stderr }) };
  children.push(record); return record;
}
function ui(action, target, scope) {
  const args = [action, String(first.child.pid)]; if (target) args.push(target); if (scope) args.push(scope);
  const result = spawnSync(probe, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'UI probe failed');
  const value = JSON.parse(result.stdout);
  if (action !== 'buttons' && action !== 'dump' && action !== 'window') actions.push({ action, target, scope, value });
  return value;
}
async function readyButton(id, scope) { return until(() => { try { return ui('buttons', undefined, scope).find(item => item.id === id && item.enabled); } catch { return false; } }, 15000, `button ${id}`); }
function listInstalled() {
  const result = spawnSync(cli, ['plugin', 'list', '--marketplace', isolation.marketName, '--json'], { cwd: path.join(root, 'empty-cwd'), env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).installed?.find(item => item.name === 'spellcast' && item.marketplaceName === isolation.marketName && item.installed && item.enabled);
}
function treeHash(dir) {
  const files = []; const walk = (current, rel = '') => { for (const name of fs.readdirSync(current).sort()) { const file = path.join(current, name), key = path.join(rel, name); if (fs.statSync(file).isDirectory()) walk(file, key); else files.push([key, hashFile(file)]); } }; walk(dir); return digest(JSON.stringify(files));
}
const startedAt = new Date().toISOString(), first = startApp();
let report = { pass: false, startedAt }, failed;
try {
  await readyButton('settings-open');
  ui('invoke', 'settings-open');
  await readyButton('settings-complete-setup');
  ui('invoke', 'Codex', 'settings');
  await readyButton('settings-complete-setup');
  const endpoint = ui('value', 'settings-mcp-url', 'settings').value;
  assert.equal(endpoint, `http://127.0.0.1:${port}/mcp`);
  const installAndWait = async () => {
    ui('invoke', 'settings-complete-setup', 'settings');
    await sleep(400);
    await readyButton('settings-complete-setup');
    return until(() => listInstalled(), 15000, 'native CLI installed result');
  };
  const installed = await installAndWait();
  fs.writeFileSync(path.join(root, 'native-installed-ui.json'), JSON.stringify(ui('dump'), null, 2));
  const installedConfig = fs.readFileSync(path.join(isolation.codexHome, 'config.toml'), 'utf8');
  assert.equal(installedConfig.includes('[mcp_servers.spellcast]'), false, 'Legacy duplicate MCP remains.');
  assert.ok(installedConfig.includes('[mcp_servers.keepme]') && installedConfig.includes('47329/mcp'));
  assert.equal(fs.existsSync(path.join(standalone, 'SKILL.md')), false, 'Duplicate standalone Skill remains active.');
  const namedFiles = (directory, name) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? namedFiles(path.join(directory, entry.name), name) : entry.name === name ? [path.join(directory, entry.name)] : []);
  };
  assert.deepEqual(namedFiles(path.join(isolation.codexHome, 'skills'), 'SKILL.md'), [], 'Legacy backup is still inside Skill discovery.');
  const preserved = namedFiles(isolation.userHome, 'SKILL.md.before-observer-fixture');
  assert.equal(preserved.length, 1, 'Legacy extra backup was lost or duplicated.');
  assert.equal(fs.readFileSync(preserved[0], 'utf8'), 'preserve this legacy backup');
  const source = path.resolve(installed.source.path);
  assert.equal(source, path.join(isolation.userHome, 'plugins/spellcast'));
  const cache = path.join(isolation.codexHome, 'plugins/cache', isolation.marketName, 'spellcast', installed.version);
  const mcp = JSON.parse(fs.readFileSync(path.join(cache, '.mcp.json'), 'utf8'));
  assert.ok(JSON.stringify(mcp).includes(endpoint));
  // Reproduce a prior plugin installation that still has duplicate legacy entries.
  // Its source/cache already match, so the installer must not take its no-op path.
  fs.cpSync(path.join(resources, 'skills/spellcast'), standalone, { recursive: true });
  fs.writeFileSync(path.join(isolation.codexHome, 'config.toml'), `[mcp_servers.spellcast]\nenabled = true\nurl = "${endpoint}"\n\n[mcp_servers.keepme]\nenabled = false\nurl = "http://127.0.0.1:47329/mcp"\n`);
  await installAndWait();
  assert.equal(fs.existsSync(path.join(standalone, 'SKILL.md')), false, 'Matching plugin skipped Skill migration.');
  const migratedConfig = fs.readFileSync(path.join(isolation.codexHome, 'config.toml'), 'utf8');
  assert.equal(migratedConfig.includes('[mcp_servers.spellcast]'), false, 'Matching plugin skipped legacy MCP migration.');
  assert.ok(migratedConfig.includes('[mcp_servers.keepme]'));
  const snapshot = () => ({ source: treeHash(source), cache: treeHash(cache), config: hashFile(path.join(isolation.codexHome, 'config.toml')), marketplace: hashFile(path.join(isolation.userHome, '.agents/plugins/marketplace.json')) });
  const firstSnapshot = snapshot();
  const repeated = await installAndWait();
  assert.deepEqual(snapshot(), firstSnapshot);
  Object.assign(report, { installed, repeated, legacyMigration: true, repeatUnchanged: true, firstSnapshot });
  ui('invoke', 'settings-close', 'settings');
  const originalWindow = ui('window');
  report.originalWindow = originalWindow;
  ui('invoke', 'Minimize');
  report.minimizeObservations = [];
  await until(() => { const state = ui('window'); report.minimizeObservations.push(state); return state.minimized; }, 3000, 'minimized window');
  const second = startApp();
  const secondExit = await Promise.race([second.exit, sleep(10000).then(() => { throw new Error('Second instance did not exit'); })]);
  assert.equal(secondExit.code, 0);
  assert.equal(first.child.exitCode, null);
  const restored = await until(() => { const state = ui('window'); return state.visible && !state.minimized ? state : false; }, 5000, 'same window restored');
  assert.equal(restored.hwnd, originalWindow.hwnd);
  const after = Object.fromEntries(protectedFiles.map(file => [file, hashFile(file)]));
  assert.deepEqual(after, before);
  report = { pass: true, startedAt, appExe, appSha256: hashFile(appExe), profile: root, method: 'Native Windows UI Automation InvokePattern and native CLI verification; no browser mock', endpoint, installed, repeated, legacyMigration: true, matchingPluginMigration: true, repeatUnchanged: true, firstPid: first.child.pid, secondPid: second.child.pid, secondExit, originalWindow, restored, protectedBefore: before, protectedAfter: after, trustConfirmed: false };
} catch (error) { failed = error; Object.assign(report, { pass: false, error: error.message, stack: error.stack }); try { fs.writeFileSync(path.join(root, 'native-failed-ui.json'), JSON.stringify(ui('dump'), null, 2)); } catch {} }
finally {
  try { ui('close'); } catch {}
  const firstExit = await Promise.race([first.exit, sleep(6000).then(() => null)]);
  report.firstExit = firstExit;
  report.pass = report.pass && firstExit?.code === 0;
  for (const [index, item] of children.entries()) {
    if (item.child.exitCode === null && !item.child.killed) item.child.kill();
    const output = item.output(); fs.writeFileSync(path.join(root, `app-${index + 1}.stderr.txt`), output.stderr); fs.writeFileSync(path.join(root, `app-${index + 1}.stdout.txt`), output.stdout);
  }
  report.actions = actions; report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'native-result.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ pass: report.pass, root, firstPid: first.child.pid, error: report.error }));
if (!report.pass) throw failed || new Error('App did not exit normally.');
