/** One-time direct local update explicitly requested by the owner. Run unpackaged. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const source = 'C:/Users/Administrator/plugins/spellcast';
const resource = path.join(root, 'src-tauri/resources/codex-plugin');
const cli = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const integrity = read(path.join(resource, 'integrity.json'));
const managed = Object.keys(integrity.files).filter(name => name !== 'bin/spellcast-hook.exe');
assert.equal(read(path.join(source, '.mcp.json')).mcpServers.spellcast.url, 'http://127.0.0.1:47194/mcp');
for (const [relative, hash] of Object.entries(integrity.files)) {
  assert.equal(digest(fs.readFileSync(path.join(resource, relative))), hash, relative);
  if (['.mcp.json', 'hooks/hooks.json', '.codex-plugin/plugin.json'].includes(relative)) continue;
  fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
  fs.copyFileSync(path.join(resource, relative), path.join(source, relative));
}
function sorted(value) { if (Array.isArray(value)) return value.map(sorted); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])); return value; }
const manifest = read(path.join(resource, '.codex-plugin/plugin.json')); delete manifest.version;
let bytes = '';
for (const relative of managed) {
  const content = relative === '.codex-plugin/plugin.json' ? JSON.stringify(sorted(manifest)) : fs.readFileSync(path.join(source, relative));
  bytes += `${relative}:${digest(content)};`;
}
bytes += `helper:${digest(fs.readFileSync(path.join(source, 'bin/spellcast-hook.exe')))}`;
const version = `0.3.0+sc.${digest(bytes).slice(0, 12)}`;
manifest.version = version; fs.writeFileSync(path.join(source, '.codex-plugin/plugin.json'), JSON.stringify(sorted(manifest), null, 2) + '\n');
fs.copyFileSync(path.join(resource, 'integrity.json'), path.join(source, 'integrity.json'));
const installed = spawnSync(cli, ['plugin', 'add', 'spellcast@personal', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 45000 });
assert.equal(installed.status, 0, installed.stderr);
const listed = spawnSync(cli, ['plugin', 'list', '--marketplace', 'personal', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
assert.equal(listed.status, 0, listed.stderr);
const entry = JSON.parse(listed.stdout).installed.find(item => item.name === 'spellcast' && item.marketplaceName === 'personal');
assert(entry?.enabled && entry.installed); assert.equal(entry.version, version);
console.log(JSON.stringify({ pass: true, version, source, method: 'Direct managed-payload replacement followed by the native Codex plugin add command' }));
