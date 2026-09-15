import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [exe, databaseBackup, profileBackup] = process.argv.slice(2);
const repo = 'G:/VibeProj/spellcast';
const evidence = path.join(repo, 'artifacts/runtime-acceptance-20260914');
const probe = path.join(evidence, 'NativeUiProbe.exe');
const python = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const cli = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const baselineRun = spawnSync(python, ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("select value from spellcast_state where id=1").fetchone()[0])', databaseBackup], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
assert.equal(baselineRun.status, 0, baselineRun.stderr);
const baseline = JSON.parse(baselineRun.stdout);
const env = { ...process.env };
for (const key of ['SPELLCAST_STATE_FILE', 'SPELLCAST_PORT', 'WEBVIEW2_USER_DATA_FOLDER', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'TAURI_CONFIG']) delete env[key];
const child = spawn(exe, [], { cwd: repo, env, windowsHide: false, detached: true, stdio: 'ignore' });
child.unref();
const report = { pass: false, startedAt: new Date().toISOString(), pid: child.pid, profileBackup, actions: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) { const start = Date.now(); while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch {} await sleep(200); } throw new Error(`Timed out: ${label}`); }
function ui(action, target, scope) { const args = [action, String(child.pid)]; if (target) args.push(target); if (scope) args.push(scope); const run = spawnSync(probe, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 }); assert.equal(run.status, 0, run.stderr); const value = JSON.parse(run.stdout); if (action === 'invoke') report.actions.push({ action, target, scope }); return value; }
const ready = id => until(() => ui('buttons').some(item => item.id === id && item.enabled), id);
function preserved(before, after, location) {
  if (Array.isArray(before)) { assert.ok(Array.isArray(after), location); assert.equal(after.length, before.length, `${location} length`); before.forEach((item, index) => preserved(item, after[index], `${location}[${index}]`)); }
  else if (before && typeof before === 'object') { assert.ok(after && typeof after === 'object', location); for (const [key, value] of Object.entries(before)) preserved(value, after[key], `${location}.${key}`); }
  else assert.deepEqual(after, before, location);
}
try {
  await ready('settings-open');
  const board = await until(async () => { const response = await fetch('http://127.0.0.1:47194/api/board'); return response.ok ? response.json() : null; }, 'physical runtime board');
  preserved(baseline.session.board, board, 'board');
  report.boardPreserved = true;
  report.counts = Object.fromEntries(Object.entries(board).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
  report.originalObserverEnabled = baseline.observer_enabled;
  ui('invoke', 'settings-open');
  await ready('settings-complete-setup');
  ui('invoke', 'Codex', 'settings');
  await ready('settings-complete-setup');
  assert.equal(ui('value', 'settings-mcp-url', 'settings').value, 'http://127.0.0.1:47194/mcp');
  ui('invoke', 'settings-complete-setup', 'settings');
  await sleep(500);
  await ready('settings-complete-setup');
  const controls = ui('dump');
  fs.writeFileSync(path.join(evidence, 'deployment-installed-ui.json'), JSON.stringify(controls, null, 2));
  const listing = spawnSync(cli, ['plugin', 'list', '--marketplace', 'personal', '--json'], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(listing.status, 0, listing.stderr);
  const installed = JSON.parse(listing.stdout).installed?.find(item => item.name === 'spellcast' && item.marketplaceName === 'personal' && item.enabled && item.installed);
  assert.ok(installed, 'Real profile plugin missing.');
  report.installed = installed;
  const source = 'C:/Users/Administrator/plugins/spellcast';
  assert.equal(path.resolve(installed.source.path), path.resolve(source));
  assert.match(installed.version, /^0\.3\.0\+sc\.[0-9a-f]{12}$/);
  assert.equal(installed.version, JSON.parse(fs.readFileSync(path.join(source, '.codex-plugin/plugin.json'), 'utf8')).version);
  const cache = path.join('C:/Users/Administrator/.codex/plugins/cache/personal/spellcast', installed.version);
  const resources = path.join(repo, 'src-tauri/resources/codex-plugin');
  const integrity = JSON.parse(fs.readFileSync(path.join(resources, 'integrity.json'), 'utf8'));
  const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const [relative, expected] of Object.entries(integrity.files)) {
    assert.equal(sha(path.join(cache, relative)), sha(path.join(source, relative)), `cache/source ${relative}`);
    if (!['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json'].includes(relative)) assert.equal(sha(path.join(source, relative)), expected, relative);
  }
  report.verifiedManagedFiles = Object.keys(integrity.files).length;
  assert.ok(fs.readFileSync(path.join(cache, '.mcp.json'), 'utf8').includes('http://127.0.0.1:47194/mcp'));
  const config = fs.readFileSync('C:/Users/Administrator/.codex/config.toml', 'utf8');
  assert.equal(config.includes('[mcp_servers.spellcast]'), false, 'Legacy duplicate MCP still active.');
  assert.equal(fs.existsSync('C:/Users/Administrator/.codex/skills/spellcast/SKILL.md'), false, 'Legacy duplicate Skill still active.');
  report.legacyDuplicatesRemoved = true;
  ui('invoke', 'settings-close', 'settings');
  report.window = ui('window');
  report.pass = true;
} catch (error) { report.error = error.message; report.stack = error.stack; try { fs.writeFileSync(path.join(evidence, 'deployment-failed-ui.json'), JSON.stringify(ui('dump'), null, 2)); } catch {} }
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(evidence, 'deployment-native-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.pass) process.exitCode = 1;
