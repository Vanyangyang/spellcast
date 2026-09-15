import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [cliArg, rootArg, resourceArg] = process.argv.slice(2);
assert.ok(cliArg && rootArg && resourceArg, 'Pass native codex.exe, fresh isolated root, and packaged plugin resources.');
const cli = path.resolve(cliArg), root = path.resolve(rootArg), resources = path.resolve(resourceArg);
assert.equal(path.basename(cli).toLowerCase(), 'codex.exe');
assert.equal(existsSync(root), false, 'Use a fresh root; never overwrite an earlier profile.');
const digest = data => createHash('sha256').update(data).digest('hex');
const integrity = JSON.parse(readFileSync(path.join(resources, 'integrity.json'), 'utf8'));
for (const [relative, expected] of Object.entries(integrity.files)) {
  const file = path.resolve(resources, relative);
  assert.ok(file.startsWith(resources + path.sep));
  assert.equal(digest(readFileSync(file)), expected, relative);
}
const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
const marketName = `spellcast-isolation-${Date.now()}`;
const source = path.join(home, 'plugins', 'spellcast');
for (const dir of [codexHome, path.join(home, '.agents', 'plugins'), path.join(root, 'empty-cwd'), path.join(root, 'temp'), path.join(root, 'Roaming'), path.join(root, 'Local')]) mkdirSync(dir, { recursive: true });
cpSync(resources, source, { recursive: true });
writeFileSync(path.join(codexHome, 'config.toml'), '');
writeFileSync(path.join(home, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: marketName, plugins: [{ name: 'spellcast', source: { source: 'local', path: './plugins/spellcast' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2));
const windows = process.env.SystemRoot || 'C:\\Windows';
const env = {
  SystemRoot: windows, WINDIR: windows, COMSPEC: path.join(windows, 'System32', 'cmd.exe'),
  PATH: [path.dirname(cli), path.join(windows, 'System32'), path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
  HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
  APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
};
const startedAt = new Date().toISOString();
const result = spawnSync(cli, ['plugin', 'list', '--marketplace', marketName, '--available', '--json'], { cwd: path.join(root, 'empty-cwd'), env, encoding: 'utf8', timeout: 20000, windowsHide: true });
writeFileSync(path.join(root, 'list.stdout.json'), result.stdout ?? '');
writeFileSync(path.join(root, 'list.stderr.txt'), result.stderr ?? '');
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr);
const data = JSON.parse(result.stdout);
const entries = Array.isArray(data) ? data : Array.isArray(data.plugins) ? data.plugins : [...(data.installed ?? []), ...(data.available ?? [])];
const found = entries.find(entry => entry.name === 'spellcast' && entry.marketplaceName === marketName);
if (!found) {
  const markets = spawnSync(cli, ['plugin', 'marketplace', 'list', '--json'], { cwd: path.join(root, 'empty-cwd'), env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  writeFileSync(path.join(root, 'marketplaces.stdout.json'), markets.stdout ?? '');
  writeFileSync(path.join(root, 'marketplaces.stderr.txt'), markets.stderr ?? '');
  console.log(JSON.stringify({ isolatedRoot: root, listShape: Object.keys(data), marketplaceListExit: markets.status, marketplaceList: markets.stdout, marketplaceErrors: markets.stderr }));
}
assert.ok(found, 'The native CLI did not discover the isolated canary marketplace. Do not install.');
assert.equal(path.resolve(home, found.source?.path ?? ''), source);
assert.notEqual(found.installed, true);
let installed = null;
if (process.argv.includes('--install')) {
  const add = spawnSync(cli, ['plugin', 'add', `spellcast@${marketName}`, '--json'], { cwd: path.join(root, 'empty-cwd'), env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  writeFileSync(path.join(root, 'add.stdout.json'), add.stdout ?? '');
  writeFileSync(path.join(root, 'add.stderr.txt'), add.stderr ?? '');
  assert.equal(add.error, undefined, add.error?.message);
  assert.equal(add.status, 0, add.stderr);
  const listed = spawnSync(cli, ['plugin', 'list', '--marketplace', marketName, '--json'], { cwd: path.join(root, 'empty-cwd'), env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  writeFileSync(path.join(root, 'installed.stdout.json'), listed.stdout ?? '');
  assert.equal(listed.status, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  installed = payload.installed?.find(entry => entry.name === 'spellcast' && entry.marketplaceName === marketName);
  assert.equal(installed?.installed, true);
  assert.equal(installed?.enabled, true);
  assert.equal(path.resolve(home, installed.source.path), source);
}
const report = { pass: true, startedAt, finishedAt: new Date().toISOString(), cli, cliSha256: digest(readFileSync(cli)), isolatedRoot: root, cwd: path.join(root, 'empty-cwd'), userHome: home, codexHome, marketName, canary: { name: found.name, marketplaceName: found.marketplaceName, source: found.source, installed: found.installed }, credentialsCopied: false, installInvoked: Boolean(installed), installed, exitCode: result.status, resourceFilesVerified: Object.keys(integrity.files).length };
writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
