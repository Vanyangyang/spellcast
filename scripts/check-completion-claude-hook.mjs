/**
 * Isolated end-to-end check of the Claude Code Stop-hook completion source.
 *
 * It installs the hook into a fake CLAUDE_CONFIG_DIR, then runs the installed hook entry exactly the way
 * Claude Code does (exec form: `command` + `args`, the Stop envelope on stdin, no inbox in the environment),
 * next to Codex and Grok completions, and checks the native overlay shows distinct Claude cards.
 *
 * Needs the verify-identifier debug build, so it can never reach an installed Spellcast:
 *   TAURI_CONFIG='{"identifier":"com.spellcast.board.verify"}' cargo build --manifest-path src-tauri/Cargo.toml
 *
 * The card's headline is the session's own name, never a prompt: a Claude session without one shows only its project,
 * and the name CC GUI later gives it (its auto-title plugin writes sessions.custom_title) appears on the card already shown.
 *
 * Claude Code starts the hook as a child of its own process, and that process's command line says whether this is a chat
 * (CC GUI: `-p --input-format stream-json`) or a one-off question (`claude -p "<question>"`, which is how CC GUI's
 * auto-title plugin names a chat). A stand-in claude.exe (cmd.exe under that name) makes the helper's real process lookup
 * observable: the one-off run must leave no card, the chat run must.
 *
 * What this does not do: start a real Claude Code session. The Stop envelope is synthetic and follows
 * https://code.claude.com/docs/en/hooks#stop-input; that Claude Code fires the hook is its own contract.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repo, 'output/completion-claude-hook', `check-${Date.now()}`);
const claudeHome = path.join(output, 'claude');
const codexHome = path.join(output, 'codex');
const grokHome = path.join(output, 'grok');
const inbox = path.join(codexHome, 'spellcast/completions');
const executable = path.resolve(repo, process.env.SPELLCAST_COMPLETION_TEST_EXE ?? 'src-tauri/target/debug/spellcast.exe');
const PORT = 47217, CDP = 9362;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 20000) {
  const start = Date.now();
  do { try { const value = await read(); if (value) return value; } catch {} await sleep(150); } while (Date.now() - start < timeout);
  throw new Error(message);
}

assert((await readFile(executable)).includes(Buffer.from('com.spellcast.board.verify')),
  'Build the debug app with the com.spellcast.board.verify identifier so it cannot reach an installed Spellcast');
for (const busy of [PORT, CDP]) {
  assert(!(await fetch(`http://127.0.0.1:${busy}/`, { signal: AbortSignal.timeout(800) }).then(() => true, () => false)), `Port ${busy} is already answering`);
}
await Promise.all([claudeHome, codexHome, grokHome].map(dir => mkdir(dir, { recursive: true })));

const env = { ...process.env, CODEX_HOME: codexHome, GROK_HOME: grokHome, CLAUDE_CONFIG_DIR: claudeHome,
  SPELLCAST_COMPLETIONS_DIR: inbox, SPELLCAST_CCGUI_DB: path.join(output, 'ccgui-app.db'), SPELLCAST_STATE_FILE: path.join(output, 'board.sqlite3'), SPELLCAST_PORT: String(PORT),
  WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` };
for (const proxy of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[proxy];

function exec(command, args, { input = '', extraEnv = {}, base = env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...base, ...extraEnv }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// A settings.json shaped like a lived-in one: other hooks, another tool's Stop hook, keys in a deliberate order.
const original = JSON.stringify({
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  env: { KEEP_ME: '1' },
  model: 'opus',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo session-start' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node C:/tools/supervisor/hook.mjs', timeout: 10 }] }],
  },
  statusLine: { type: 'command', command: 'echo status' },
  theme: 'dark',
}, null, 2) + '\n';
const settingsPath = path.join(claudeHome, 'settings.json');
await writeFile(settingsPath, original);

const report = { evidence: 'real helper + real overlay in an isolated app; synthetic Claude Stop envelope, no live Claude Code session' };
let native, browser, nativeErrors = '';
async function stop() {
  if (browser) {
    for (const page of browser.contexts().flatMap(context => context.pages()).sort((a, b) => Number(a.url().endsWith('/')) - Number(b.url().endsWith('/')))) {
      try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: window.__TAURI_INTERNALS__.metadata.currentWindow.label })); } catch {}
    }
    await browser.close().catch(() => {}); browser = undefined;
    await sleep(700);
  }
  if (native && native.exitCode === null) {
    const ended = new Promise(resolve => native.once('exit', resolve)); native.kill(); await ended;
  }
  native = undefined;
}
async function shoot(page, name, backdrop) {
  // Cards animate in; capture them at rest.
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await sleep(300);
  // The overlay window is transparent over the desktop; give the capture a desktop to sit on.
  const style = await page.addStyleTag({ content: `html,body{background:${backdrop} !important}` });
  await page.screenshot({ path: path.join(output, name) });
  await style.evaluate(node => node.remove());
}

try {
  // 1. Install into the fake Claude config.
  const installed = await exec(executable, ['--install-claude-completion-hook']);
  assert.equal(installed.code, 0, installed.stderr);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(Object.keys(settings), ['$schema', 'env', 'model', 'hooks', 'statusLine', 'theme'], 'member order changed');
  const groups = settings.hooks.Stop;
  assert.equal(groups.length, 2); assert.equal(groups[0].hooks[0].command, 'node C:/tools/supervisor/hook.mjs');
  const entry = groups[1].hooks[0];
  assert.equal(entry.type, 'command'); assert(Array.isArray(entry.args) && entry.args[0] === '--claude-notify');
  assert.equal(path.resolve(entry.args[1]), path.resolve(inbox));
  assert.equal(path.resolve(entry.command), path.join(path.resolve(inbox), 'spellcast-notify.exe'));
  report.installedEntry = entry;

  // 2. Run that entry the way Claude Code does. The inbox is NOT in the environment: it must come from args.
  const hookEnv = { ...env }; for (const key of ['SPELLCAST_COMPLETIONS_DIR', 'CODEX_HOME', 'GROK_HOME']) delete hookEnv[key];
  const transcriptDir = path.join(claudeHome, 'projects/G--Demos-Platformer');
  await mkdir(transcriptDir, { recursive: true });
  const session = { platformer: 'a09c1947-841e-48c0-8817-6b82325eef08', orbit: 'e2b1f6d4-5c3a-4f0e-9b7d-3a6c8d1f2e47' };
  const records = lines => lines.map(line => JSON.stringify(line)).join('\n') + '\n';
  const transcript = id => path.join(transcriptDir, `${id}.jsonl`);
  await writeFile(transcript(session.platformer), records([
    { type: 'user', message: { role: 'user', content: '给平台跳跃加二段跳' }, sessionId: session.platformer },
    { type: 'ai-title', aiTitle: '平台跳跃：加二段跳', sessionId: session.platformer },
    { type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: '二段跳已加好，落地后重置。' }] } },
  ]));
  // A session without a title record: its last prompt is in the transcript, and must not become the headline.
  await writeFile(transcript(session.orbit), records([
    { type: 'last-prompt', lastPrompt: '把轨道关卡的相机跟随调平滑一点', sessionId: session.orbit },
  ]));
  // CC GUI's session table: `title` is the first message; `custom_title` is a name, empty until one is chosen.
  const ccguiDb = new DatabaseSync(path.join(output, 'ccgui-app.db'));
  ccguiDb.exec("CREATE TABLE sessions(engine TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', custom_title TEXT, PRIMARY KEY(engine, session_id))");
  for (const id of [session.platformer, session.orbit]) {
    ccguiDb.prepare('INSERT INTO sessions(engine,session_id,title,custom_title) VALUES (?,?,?,NULL)').run('claude', id, '开头的提示词，不该做标题');
  }
  const stopEnvelope = (id, cwd, message, extra = {}) => JSON.stringify({
    session_id: id, transcript_path: transcript(id), cwd, permission_mode: 'default',
    hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message, ...extra });
  const fakeBin = path.join(output, 'fake-claude'); await mkdir(fakeBin, { recursive: true });
  const fakeClaude = path.join(fakeBin, 'claude.exe');
  await copyFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), fakeClaude);
  const runUnderClaude = async (flags, payload) => {
    const result = await exec(fakeClaude, ['/c', entry.command, ...entry.args, ...flags], { input: payload, base: hookEnv });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '', 'a Stop hook must not print: Claude Code parses stdout as a decision');
  };
  const runHook = async (payload) => {
    const result = await exec(entry.command, entry.args, { input: payload, base: hookEnv });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '', 'a Stop hook must not print: Claude Code parses stdout as a decision');
    return result;
  };
  // The first one arrives the way CC GUI's chats do (under a claude process in streaming mode); the rest come straight
  // from this script, whose parent is no claude process: nothing is hidden then.
  await runUnderClaude(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'], stopEnvelope(session.platformer, 'G:\\Demos\\Platformer',
    '二段跳已加好：canDoubleJump 在落地时重置，空中第二次起跳会清掉下落速度。已跑过移动脚本，没有回归。'));
  await runHook(stopEnvelope(session.orbit, 'G:\\Demos\\Orbit', '**相机跟随**改成了 `临界阻尼`，抖动没有了。'));
  // Subagent and observer children must not produce a bubble.
  await runHook(stopEnvelope('11111111-2222-4333-8444-555555555555', 'G:\\Demos\\Platformer', 'subagent finished',
    { hook_event_name: 'SubagentStop', agent_id: 'agent-7', agent_type: 'Explore' }));
  await runHook(stopEnvelope('66666666-7777-4888-8999-000000000000', 'G:\\Demos\\Platformer', 'child', { agent_id: 'agent-9' }));
  // A one-off question under claude (the auto-title plugin's naming run, a connection test) leaves no card.
  const oneOff = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  await runUnderClaude(['-p', '只回复两个字：正常', '--output-format', 'text', '--model', 'haiku'], stopEnvelope(oneOff, 'G:\\Demos\\Platformer', '正常'));
  report.hookRuns = 5;

  // 3. A Codex and a Grok completion at the same moment.
  const threadDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  threadDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,source TEXT)');
  const codexThread = '01a08f1a-30e0-7f02-a84f-5898148cca8e';
  threadDb.prepare('INSERT INTO threads VALUES (?,?,?)').run(codexThread, '完成气泡 · 区分来源', 'vscode');
  assert.equal((await exec(executable, ['--codex-notify', inbox, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': codexThread,
    'turn-id': 'demo', cwd: 'G:\\VibeProj\\spellcast', 'input-messages': ['给不同客户端换不同的提示风格'],
    'last-assistant-message': 'Codex 和 Grok、Claude 的卡片现在各有各的样子。' })])).code, 0);
  assert.equal((await exec(executable, ['--grok-notify', inbox], { input: JSON.stringify({ hookEventName: 'stop',
    sessionId: '01a0b2f3-fc97-7432-8a3e-e2a4bd689751', cwd: 'G:\\Demos\\Platformer', promptId: '41676faa-10c7-4f09-88fd-f1742d435226',
    reason: 'end_turn', lastAssistantMessage: 'Coins and score added.' }), extraEnv: { GROK_HOOK_EVENT: 'stop' } })).code, 0);

  const captured = new DatabaseSync(path.join(inbox, 'inbox.sqlite3'), { readOnly: true });
  const rows = captured.prepare('SELECT client,thread_id,title,project,summary FROM completions ORDER BY sequence').all();
  assert.deepEqual(rows.map(row => row.client), ['claude', 'claude', 'codex', 'grok'], JSON.stringify(rows));
  assert.equal(rows[0].title, '平台跳跃：加二段跳'); assert.equal(rows[0].project, 'Platformer');
  assert.equal(rows[1].title, '', 'a prompt is not a name'); assert.equal(rows[1].project, 'Orbit');
  assert.equal(rows[1].summary, '相机跟随改成了 临界阻尼，抖动没有了。', 'the stored summary is plain text');
  assert(!rows.some(row => row.thread_id === oneOff), 'a one-off claude -p run must not leave a card');
  report.oneOffPrintRunLeavesNoCard = true;
  report.inbox = rows;

  // 4. The overlay.
  native = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  native.stderr.on('data', chunk => { nativeErrors += chunk; });
  await until(async () => {
    if (native.exitCode !== null) throw new Error(`Native app exited ${native.exitCode}: ${nativeErrors}`);
    return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok;
  }, 'Native CDP did not start', 60000);
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('completions.html')), 'Completion window did not appear', 60000);
  await until(async () => (await page.locator('.completion-bubble').count()) === 4, 'Expected four cards (2 Claude, Codex, Grok)');
  const cards = await page.locator('.completion-bubble').evaluateAll(list => list.map(card => {
    const style = getComputedStyle(card);
    return { client: card.dataset.client, thread: card.dataset.thread, titleHidden: card.querySelector('.title')?.hidden, origin: card.querySelector('.origin')?.textContent, title: card.querySelector('.title')?.textContent,
      project: card.querySelector('.project')?.textContent ?? null, hint: card.querySelector('.hint')?.textContent,
      radius: style.borderTopLeftRadius, background: style.backgroundColor, label: card.getAttribute('aria-label') };
  }));
  const of = client => cards.filter(card => card.client === client);
  assert.equal(of('claude').length, 2); assert.equal(of('codex').length, 1); assert.equal(of('grok').length, 1);
  assert(of('claude').every(card => card.origin === 'Claude' && /Claude · (双击关闭|Double-click to dismiss)/.test(card.hint)), JSON.stringify(of('claude')));
  assert(of('claude').some(card => card.title === '平台跳跃：加二段跳'));
  const unnamed = cards.find(card => card.thread === session.orbit);
  assert(unnamed.titleHidden && unnamed.title === '' && unnamed.project === 'Orbit', `an unnamed session shows only its project: ${JSON.stringify(unnamed)}`);
  assert.equal(of('codex')[0].origin, 'Codex'); assert.equal(of('grok')[0].origin, 'Grok');
  assert.equal(new Set(cards.map(card => card.client + card.radius)).size, 3, 'each client keeps its own card shape');
  assert.notEqual(of('claude')[0].radius, of('codex')[0].radius); assert.notEqual(of('claude')[0].background, of('codex')[0].background);
  report.cards = cards;
  await shoot(page, 'stack-dark.png', 'linear-gradient(160deg,#16202e,#2a3a52)');
  await shoot(page, 'stack-light.png', 'linear-gradient(160deg,#dfe6ef,#f5efe6)');
  await page.locator('.completion-bubble[data-client="claude"]').first().screenshot({ path: path.join(output, 'claude-card.png'), omitBackground: true });

  // 4b. CC GUI names the session after the card is already up (its auto-title plugin runs after each turn): the card
  // picks the name up, replaces nothing else, and the first-message `title` column is never used.
  ccguiDb.prepare('UPDATE sessions SET custom_title=? WHERE engine=? AND session_id=?').run('🧩 Orbit｜相机跟随', 'claude', session.orbit);
  const orbitTitle = page.locator(`.completion-bubble[data-thread="${session.orbit}"] .title`);
  await until(async () => (await orbitTitle.textContent()) === '🧩 Orbit｜相机跟随' && await orbitTitle.isVisible(), 'The CC GUI name did not reach the card');
  assert.equal(await page.locator(`.completion-bubble[data-thread="${session.platformer}"] .title`).textContent(), '平台跳跃：加二段跳', 'a session CC GUI has not named keeps its transcript title');
  assert.equal(await page.locator('.completion-bubble').count(), 4);
  report.ccguiNameReachesAShownCard = true;

  // 5. A second Claude turn arrives while the overlay is up: the same session keeps one card, now with the new reply.
  await runHook(stopEnvelope(session.platformer, 'G:\\Demos\\Platformer', '第二轮：二段跳的手感测试补上了，全部通过。'));
  await until(async () => (await page.locator(`.completion-bubble[data-thread="${session.platformer}"] .summary`).textContent()).includes('第二轮'), 'The second Claude turn did not replace the first');
  assert.equal(await page.locator('.completion-bubble').count(), 4, 'one card per session');
  await sleep(500);

  // 6. Double-click a Claude card: it only dismisses (no Claude deep link), and leaves the rest alone.
  // The mouse events come from the debugging protocol, so neither the real cursor nor window focus is involved.
  const target = page.locator('.completion-bubble[data-client="claude"]').first();
  const targetThread = await target.getAttribute('data-thread');
  await target.locator('.task').dblclick();
  await until(async () => (await page.locator('.completion-bubble').count()) === 3, 'Double-click did not dismiss the Claude card');
  assert.equal(await page.locator(`.completion-bubble[data-thread="${targetThread}"]`).count(), 0);
  assert.equal(await page.locator('.completion-bubble[data-client="codex"]').count(), 1);
  // Only the clicked turn is marked; the session's older turn stays hidden behind it, and the other session's card stays.
  assert.equal(captured.prepare('SELECT dismissed FROM completions WHERE thread_id=? ORDER BY sequence DESC LIMIT 1').get(targetThread).dismissed, 1);
  assert.equal(await page.locator('.completion-bubble[data-client="claude"]').count(), 1);
  report.doubleClickDismissesOnlyThatClaudeCard = true;
  captured.close(); threadDb.close(); ccguiDb.close();
  await stop();

  // 7. Uninstall restores the user's file byte for byte.
  const removed = await exec(executable, ['--uninstall-claude-completion-hook']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(await readFile(settingsPath, 'utf8'), original);
  assert.notEqual((await exec(executable, ['--uninstall-claude-completion-hook'])).code, 0, 'a second uninstall must refuse');
  report.uninstallRestoresSettingsByteForByte = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally { await stop(); }
