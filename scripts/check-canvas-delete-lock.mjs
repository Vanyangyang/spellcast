/** Real browser input against isolated Canvas fixtures. Never touches the user's board. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const url = process.env.SPELLCAST_TEST_URL ?? 'http://127.0.0.1:47199/delete-lock-fixture';
const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/board-workspace.css"><style>:root{--paper:#f4f1ea;--mute:#aeb3c6;--line:#50556a;--lilac:#d4b3ff;--font:Arial,sans-serif}html,body,#host{width:100%;height:100%;margin:0}body{background:#0c0e14;color:#f4f1ea}</style></head><body><div id="host"></div></body></html>' }));
  await page.goto(url);
  await page.evaluate(async () => {
    const { mountCanvas } = await import('/src/canvas.ts');
    await import('/src/fonts.css'); await import('/src/canvas-studio.css'); await import('/src/theme.css');
    document.body.classList.add('mode-focus', 'view-replies'); document.body.dataset.theme = 'dark';
    let snapshot = { topic: '', form: 'spatial', form_reason: '', nodes: [], edges: [], messages: [], replies: [], canvas: {
      revision: 1, compositions: [], annotations: [], proposals: [],
      objects: ['keep', 'free-a', 'free-b'].map(id => ({ id, content_revision: 1, content: { type: 'block', block: { id: `${id}-body`, type: 'text', title: id === 'keep' ? '锁定测试内容' : id, text: '仅用于防误删验证的测试内容。' } } })),
      items: ['keep', 'free-a', 'free-b'].map((id, i) => ({ item_id: id, revision: 1, x: 120 + i * 390, y: 140, width: 350, height: 280, z: i, removed: false, appearance: 'card' })),
    } };
    let canvas;
    const writes = [], notices = [];
    const mutate = fn => { snapshot = structuredClone(snapshot); fn(snapshot.canvas); snapshot.canvas.revision++; return snapshot; };
    const handlers = {
      onSelect() {}, onFocusNotice: message => notices.push(message), onError: message => { throw Error(message); },
      onReload: async () => snapshot,
      onLayout: async (_revision, items) => mutate(layout => { for (const item of items) Object.assign(layout.items.find(p => p.item_id === item.item_id), item, { revision: item.revision + 1 }); }).canvas,
      onDeleteLock: async (current, locked) => mutate(layout => {
        for (const read of current) { const item = layout.items.find(p => p.item_id === read.id); if (item.revision !== read.revision) throw Error('stale lock'); item.delete_locked = locked; item.revision++; }
      }),
      onDelete: async id => mutate(layout => {
        const item = layout.items.find(p => p.item_id === id); if (item.delete_locked) throw Error('UI attempted to delete a locked object');
        writes.push(id); item.removed = true; item.revision++;
      }),
      onBatch: async request => mutate(layout => {
        for (const op of request.operations) {
          if (op.op !== 'place' || op.fields.removed !== true) throw Error('unexpected fixture batch');
          const item = layout.items.find(p => p.item_id === op.id); if (item.delete_locked) throw Error('UI batch included a locked object');
          writes.push(op.id); item.removed = true; item.revision++;
        }
      }),
      onRestoreComposer() {}, onRestore: async () => snapshot,
      onAction: async () => { throw Error('Unexpected action'); }, onPatch: async () => { throw Error('Unexpected edit'); },
      onCreate: async () => { throw Error('Unexpected create'); }, onNodePatch: async () => { throw Error('Unexpected node edit'); },
      onNodeAsk: async () => { throw Error('Unexpected ask'); }, onBlockAction: async () => { throw Error('Unexpected block action'); }, onProposal: async () => { throw Error('Unexpected proposal'); },
    };
    const mount = () => { canvas = mountCanvas(document.getElementById('host'), handlers); canvas.update(snapshot); };
    mount();
    window.lockFixture = { state: () => snapshot, writes, notices, select: id => canvas.selectObject(id), remount: () => { canvas.destroy(); snapshot = JSON.parse(JSON.stringify(snapshot)); mount(); } };
  });
  const keep = page.locator('.canvas-frame[data-item-id="keep"]');
  await keep.waitFor();
  await page.evaluate(() => window.lockFixture.select('keep'));
  const lock = page.locator('.canvas-delete-lock');
  await lock.click();
  await page.waitForFunction(() => window.lockFixture.state().canvas.items[0].delete_locked === true);
  assert.equal(await lock.textContent(), '解锁');
  assert.equal(await keep.locator('.canvas-frame-lock').isVisible(), true);
  await page.locator('.canvas-graph').focus(); await page.keyboard.press('Delete');
  assert.deepEqual(await page.evaluate(() => window.lockFixture.writes), []);
  assert.match(await page.evaluate(() => window.lockFixture.notices.at(-1)), /保留.*锁定/);

  await page.evaluate(() => window.lockFixture.remount());
  await keep.waitFor(); await page.evaluate(() => window.lockFixture.select('keep'));
  assert.equal(await lock.textContent(), '解锁', 'Lock must render from the saved board after remount.');
  await page.locator('.canvas-graph').focus(); await page.keyboard.press('Backspace');
  assert.deepEqual(await page.evaluate(() => window.lockFixture.writes), []);
  await page.keyboard.press('Control+a');
  await page.locator('.canvas-selection-more summary').click();
  await page.getByRole('button', { name: '从画布移除', exact: true }).click();
  await page.waitForFunction(() => window.lockFixture.writes.length === 2);
  assert.deepEqual(await page.evaluate(() => window.lockFixture.writes), ['free-a', 'free-b']);
  assert.equal(await keep.isVisible(), true);
  assert.match(await page.evaluate(() => window.lockFixture.notices.at(-1)), /保留了 1 个锁定对象/);
  if (process.env.SPELLCAST_TEST_LOCK_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_LOCK_SHOT });

  await page.evaluate(() => window.lockFixture.select('keep'));
  await lock.click();
  await page.waitForFunction(() => window.lockFixture.state().canvas.items[0].delete_locked === false);
  await page.locator('.canvas-graph').focus(); await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.lockFixture.state().canvas.items.every(p => p.removed));
  assert.deepEqual(await page.evaluate(() => window.lockFixture.writes), ['free-a', 'free-b', 'keep']);
  assert.deepEqual(errors, []);
  console.log('PASS: visible lock/unlock state, Delete and Backspace protection, saved-state remount, mixed batch preserves locked objects, explicit unlock then removal.');
} finally { await browser.close(); }
