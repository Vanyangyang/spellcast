/** Browser check against a Vite dev server. Uses an isolated in-memory Canvas fixture. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const url = process.env.SPELLCAST_TEST_URL ?? "http://127.0.0.1:47197/atom-workspace-fixture";
const browser = await playwright.chromium.launch({ headless: true, channel: "chrome", args: ["--no-proxy-server"], timeout: 15000 });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.fixtureClipboard = value; } } }); });
const errors = [];
page.on("pageerror", error => errors.push(error.message));

try {
  await page.route(url, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/board-workspace.css"><style>:root{--paper:#f4f1ea;--mute:#aeb3c6;--line:#50556a;--line-strong:#8189a0;--lilac:#d4b3ff;--font:Arial,sans-serif}html,body,#host{width:100%;height:100%;margin:0}body{background:#0c0e14;color:#f4f1ea}</style></head><body><div id="host"></div></body></html>',
  }));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(async () => {
    const { mountCanvas } = await import("/src/canvas.ts");
    await import('/src/canvas-studio.css');
    await import('/src/theme.css');
    document.body.classList.add('mode-focus', 'view-replies');
    document.body.dataset.theme = 'dark';
    const reply = {
      id: "reply", source_id: "fixture-source", source_label: "Fixture", title: "Long structured reply",
      revision: 1, created_at_ms: 1, updated_at_ms: 1,
      blocks: [
        { id: "first", type: "text", title: "First atom", text: "Read the first atom. ".repeat(100) },
        { id: "second", type: "text", title: "Second atom", text: "Edit the second atom. ".repeat(100) },
        { id: "third", type: "text", title: "Third atom", text: "Read the third atom. ".repeat(700) },
        { id: "graph", type: "graph", title: "Runtime chain", nodes: [{ id: "node-a", title: "Arrive" }, { id: "node-b", title: "Choose" }],
          edges: [{ id: "edge-a", from: "node-a", to: "node-b", label: "then" }] },
        { id: "comparison", type: "comparison", title: "Options", criteria: ["Cost"],
          options: [{ id: "option-a", title: "Keep", summary: "Keep it", values: ["Low"] }, { id: "option-b", title: "Move", summary: "Move it", values: ["High"] }] },
        { id: "sequence", type: "sequence", title: "Next steps", steps: [{ id: "step-a", title: "Review", action: "Read the result" }] },
      ],
    };
    let snapshot = {
      topic: "", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [], replies: [reply],
      canvas: {
        revision: 1, objects: [
          { id: "object", content: { type: "reply", id: reply.id }, content_revision: 1 },
          { id: "atom", content: { type: "block", block: { id: "atom-text", type: "text", title: "Standalone atom", text: "Edit me" } }, content_revision: 1 },
        ],
        items: [
          { item_id: "object", revision: 1, z: 0, removed: false, appearance: "plain", x: 100, y: 100, width: 640, height: 520, user_modified: true },
          { item_id: "atom", revision: 1, z: 1, removed: false, appearance: "plain", x: 850, y: 100, width: 460, height: 280 },
        ],
        compositions: [], annotations: [], proposals: [],
      },
    };
    let canvas;
    window.fixtureDiscussCount = 0;
    const handlers = {
      onSelect() {},
      onDiscussSelection() { window.fixtureDiscussCount++; },
      onNodePatch: async () => { throw Error("Unexpected node patch"); },
      onNodeAsk: async () => { throw Error("Unexpected node action"); },
      onBlockAction: async () => { throw Error("Unexpected atom action"); },
      onCreate: async () => { throw Error("Unexpected create"); },
      onDelete: async () => { throw Error("Unexpected delete"); },
      onRestore: async () => { throw Error("Unexpected restore"); },
      onLayout: async (_revision, items) => {
        snapshot = { ...snapshot, canvas: { ...snapshot.canvas, revision: snapshot.canvas.revision + 1,
          items: snapshot.canvas.items.map(item => { const patch = items.find(candidate => candidate.item_id === item.item_id); return patch ? { ...patch, revision: item.revision + 1 } : item; }) } };
        return snapshot.canvas;
      },
      onBatch: async () => { throw Error("Unexpected batch write"); },
      onProposal: async () => { throw Error("Unexpected proposal"); },
      onReload: async () => snapshot,
      onRestoreComposer() {},
      onError(message) { window.fixtureErrors.push(message); },
      onAction: async () => { throw Error("Unexpected reply action"); },
      onPatch: async request => {
        if (window.failNextSave) { window.failNextSave = false; throw Error("Fixture save failure"); }
        const prior = snapshot.replies[0];
        const next = { ...prior, revision: prior.revision + 1, updated_at_ms: prior.updated_at_ms + 1,
          blocks: prior.blocks.map(block => block.id === request.block.id ? request.block : block) };
        snapshot = { ...snapshot, replies: [next] };
        queueMicrotask(() => canvas.update(snapshot));
        return next;
      },
    };
    canvas = mountCanvas(document.getElementById("host"), handlers);
    window.fixtureErrors = [];
    canvas.update(snapshot);
    window.fixture = { canvas, state: () => snapshot, remount: () => {
      canvas.destroy(); canvas = mountCanvas(document.getElementById("host"), handlers);
      canvas.update(snapshot); window.fixture.canvas = canvas;
    }, setGraph: () => {
      const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `node-${i}`, title: `Graph step ${i + 1}`, detail: `Description for step ${i + 1}` }));
      const graph = { id: "graph", type: "graph", title: "Runtime chain", nodes,
        edges: nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, from: nodes[i].id, to: node.id, label: `Transition ${i + 1}` })) };
      snapshot = { ...snapshot, replies: [{ ...snapshot.replies[0], revision: snapshot.replies[0].revision + 1,
        blocks: snapshot.replies[0].blocks.map(block => block.id === "graph" ? graph : block) }] };
      canvas.update(snapshot);
    }, removeBlock: id => {
      snapshot = { ...snapshot, replies: [{ ...snapshot.replies[0], revision: snapshot.replies[0].revision + 1, blocks: snapshot.replies[0].blocks.filter(block => block.id !== id) }] };
      canvas.update(snapshot);
    } };
  });

  await page.locator('.canvas-frame[data-item-id="object"]').waitFor();
  await page.locator('.canvas-frame[data-item-id="object"] .canvas-reply-summary-atom[data-block-id="second"]').click();
  const reader = page.locator(".canvas-reader");
  await reader.waitFor({ state: "visible" });
  assert.equal(await reader.locator('.rb-block[data-block-id="first"]').isVisible(), false, "Clicking a summary atom must focus that atom.");
  await reader.locator(".canvas-reader-close").click();
  await reader.waitFor({ state: "hidden" });
  await page.evaluate(() => window.fixture.canvas.select("reply"));
  if (process.env.SPELLCAST_TEST_SUMMARY_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_SUMMARY_SHOT, animations: "disabled" });
  assert.equal(await page.locator('.canvas-frame[data-item-id="object"] .canvas-reply-summary').isVisible(), true);
  assert.equal(await page.locator('.canvas-frame[data-item-id="object"] .rb-root').isVisible(), false);
  const handle = page.locator('.canvas-frame[data-item-id="object"] > .canvas-frame-head');
  assert.equal(await handle.isVisible(), true, "Selected plain replies must expose the expand control.");
  await handle.locator("button").last().click();
  await reader.waitFor({ state: "visible" });
  const box = await reader.boundingBox();
  assert(box.width >= 1300 && box.height >= 800, "Expanded work area must use most of the viewport.");
  const readingPane = reader.locator(".canvas-reader-workspace > .canvas-frame-content");
  await reader.locator('.canvas-reader-outline > button').first().click();
  const scroll = await readingPane.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight }));
  assert(scroll.content > scroll.height, "Long atom compositions must remain scrollable.");
  const readingText = reader.locator('.rb-block[data-block-id="first"] .rb-text p').first();
  const initialFont = await readingText.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  const heading = reader.locator('.rb-block[data-block-id="first"] .rb-block-title');
  const outlineButton = reader.locator('.canvas-reader-outline > button').first();
  const initialHeading = await heading.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  const initialOutline = await outlineButton.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  await page.evaluate(async () => {
    const typography = await import('/src/canvas-typography.ts');
    typography.setCanvasFontPercent('title', 140);
    typography.setCanvasFontPercent('interface', 130);
  });
  const configuredHeading = await heading.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  const configuredOutline = await outlineButton.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  assert(configuredHeading > initialHeading, 'Heading size must have its own setting.');
  assert(configuredOutline > initialOutline, 'Outline and action size must have its own setting.');
  assert.equal(await readingText.evaluate(node => parseFloat(getComputedStyle(node).fontSize)), initialFont, 'Changing heading and interface sizes must leave body text alone.');
  await page.evaluate(() => { window.fixtureSettingsRequests = 0; document.addEventListener('spellcast-open-settings', () => window.fixtureSettingsRequests++); });
  await reader.locator('.canvas-reader-font-settings').click();
  assert.equal(await page.evaluate(() => window.fixtureSettingsRequests), 1, 'The reader must expose the Settings shortcut.');
  await readingText.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('.canvas-reader-text-size')?.textContent === '110%');
  assert((await readingText.evaluate(node => parseFloat(getComputedStyle(node).fontSize))) > initialFont, 'Ctrl+wheel in the reader must enlarge readable text.');
  assert.equal(await heading.evaluate(node => parseFloat(getComputedStyle(node).fontSize)), configuredHeading, 'Ctrl+wheel must not change heading size.');
  assert.equal(await outlineButton.evaluate(node => parseFloat(getComputedStyle(node).fontSize)), configuredOutline, 'Ctrl+wheel must not change outline size.');
  const textWidth = await reader.locator('.rb-block[data-block-id="first"] .rb-text').evaluate(node => ({ own: node.getBoundingClientRect().width, parent: node.parentElement.getBoundingClientRect().width }));
  assert(textWidth.own >= textWidth.parent - 2, 'Expanded body text must use the available card width.');
  await page.evaluate(async () => (await import('/src/canvas-typography.ts')).setCanvasFontPercent('body', 200));
  await readingText.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('.canvas-reader-text-size')?.textContent === '210%');
  if (process.env.SPELLCAST_TEST_TEXT_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_TEXT_SHOT, animations: 'disabled' });
  await page.evaluate(async () => (await import('/src/canvas-typography.ts')).setCanvasFontPercent('body', 110));
  await reader.locator('button[data-block-id="graph"]').click();
  await reader.locator('.rb-graph-canvas').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  assert.equal(await reader.locator('.canvas-reader-text-size').textContent(), '110%', 'Graph Ctrl+wheel must not change the reader font size.');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('spellcast.canvas-reading-title-percent'), localStorage.getItem('spellcast.canvas-reading-interface-percent')]), ['140', '130']);
  await page.evaluate(async () => {
    const typography = await import('/src/canvas-typography.ts');
    typography.setCanvasFontPercent('title', 100);
    typography.setCanvasFontPercent('interface', 100);
  });
  if (process.env.SPELLCAST_TEST_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_SHOT, animations: "disabled" });
  assert.equal(await reader.locator(".canvas-reader-atoms button").count(), 6);
  assert.equal(await reader.locator('.rb-block[data-block-id="graph"]').isVisible(), true);
  assert.equal(await reader.locator('.rb-block[data-block-id="first"]').isVisible(), false);
  await reader.locator('button[data-block-id="second"]').click();
  assert.equal(await reader.locator('.rb-block[data-block-id="first"]').isVisible(), false);
  assert.equal(await reader.locator('.rb-block[data-block-id="second"]').isVisible(), true);
  await reader.locator(".canvas-reader-outline > button").last().click();
  const field = reader.locator('.rb-block[data-block-id="second"] .rb-area textarea');
  await field.waitFor({ state: "visible" });
  assert((await field.boundingBox()).width > 800, "The editor must have a wide text area.");
  assert((await field.evaluate(node => parseFloat(getComputedStyle(node).fontSize))) > 14, 'The expanded editor must use the reading text size.');
  await field.fill("Edited in the expanded atom workspace.");
  await reader.locator('.rb-block[data-block-id="second"] .rb-form-actions button[type="submit"]').click();
  await page.waitForFunction(() => window.fixture.state().replies[0].revision === 2);
  const state = await page.evaluate(() => window.fixture.state());
  assert.equal(state.replies[0].blocks[1].text, "Edited in the expanded atom workspace.");
  assert.deepEqual(state.canvas.items[0], { item_id: "object", revision: 1, z: 0, removed: false, appearance: "plain", x: 100, y: 100, width: 640, height: 520, user_modified: true });

  // Navigating and closing a long block retains the exact scroll offset.
  await reader.locator('button[data-block-id="third"]').click();
  await readingPane.evaluate(node => { node.scrollTop = 240; });
  await reader.locator('button[data-block-id="first"]').click();
  await reader.locator('button[data-block-id="third"]').click();
  await page.waitForFunction(() => document.querySelector('.canvas-reader-workspace > .canvas-frame-content').scrollTop === 240);
  await reader.locator('.canvas-reader-close').click();
  await reader.waitFor({ state: 'hidden' });
  await page.locator('.canvas-tool-selection > .canvas-tool-primary:not(.canvas-selection-discuss)').click();
  await reader.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.canvas-reader-workspace > .canvas-frame-content').scrollTop === 240);
  await page.evaluate(() => window.fixture.remount());
  await reader.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.canvas-reader-workspace > .canvas-frame-content')?.scrollTop === 240);
  assert.equal(await reader.locator('.rb-block[data-block-id="third"]').isVisible(), true, 'Remount must restore the focused block.');
  await reader.locator('.canvas-reader-close').click();
  await reader.waitFor({state:'hidden'});
  await page.evaluate(() => window.fixture.remount());
  assert.equal(await reader.isVisible(), false, 'An explicitly closed reader must stay closed after remount.');
  await page.evaluate(() => window.fixture.canvas.select('reply'));
  await page.locator('.canvas-tool-selection > .canvas-tool-primary:not(.canvas-selection-discuss)').click();
  await reader.waitFor({state:'visible'});

  // Hidden dirty blocks stay marked. Ctrl+S saves only the focused block and errors remain recoverable.
  await reader.locator('button[data-block-id="first"]').click();
  await reader.locator('.canvas-reader-outline > button').last().click();
  const firstField = reader.locator('.rb-block[data-block-id="first"] textarea');
  await firstField.fill('Keyboard saved first block.');
  await page.waitForFunction(() => document.querySelector('.canvas-reader-atom-row[data-block-id="first"]').dataset.editState === 'dirty');
  await reader.locator('button[data-block-id="third"]').click();
  assert.equal(await reader.locator('.canvas-reader-atom-row[data-block-id="first"] .canvas-reader-draft').isVisible(), true);
  await reader.locator('button[data-block-id="first"]').click();
  await firstField.focus();
  await page.evaluate(() => { window.failNextSave = true; });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('.canvas-reader-atom-row[data-block-id="first"]').dataset.editState === 'error');
  assert.equal(await firstField.inputValue(), 'Keyboard saved first block.');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.fixture.state().replies[0].revision === 3);
  assert.equal(await page.evaluate(() => window.fixture.state().replies[0].blocks[0].text), 'Keyboard saved first block.');
  await page.waitForFunction(() => document.querySelector('.canvas-reader-atom-row[data-block-id="first"]').dataset.editState === 'clean');

  // Selected block anchors remain distinct even though they share one Canvas object.
  await reader.locator('.canvas-reader-atom-row[data-block-id="third"] input').check();
  await reader.locator('.canvas-reader-compare').click();
  assert.equal(await reader.locator('.rb-block[data-block-id="first"]').isVisible(), true);
  assert.equal(await reader.locator('.rb-block[data-block-id="third"]').isVisible(), true);
  assert.equal(await reader.locator('.rb-block[data-block-id="second"]').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().anchors.map(anchor => anchor.block_id)), ['first', 'third']);
  if (process.env.SPELLCAST_TEST_COMPARE_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_COMPARE_SHOT, animations: 'disabled' });
  await reader.locator('header button').first().click();
  assert.equal(await reader.locator('.canvas-reader-outline').isVisible(), false);
  await reader.locator('header button').first().click();
  await reader.locator('.canvas-reader-width').fill('340');
  assert((await reader.locator('.canvas-reader-outline').boundingBox()).width >= 338);
  await reader.locator('.canvas-reader-atom-row[data-block-id="third"] input').uncheck();
  assert.equal(await reader.locator('.canvas-reader-outline > button').last().isEnabled(), true, 'One remaining block must leave comparison mode and allow editing.');
  await reader.locator('.canvas-reader-atom-row[data-block-id="third"] input').check();
  await reader.locator('.canvas-reader-discuss').click();
  await reader.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().anchors.map(anchor => anchor.block_id)), ['first', 'third']);

  // Ctrl-click and Shift-click must both add objects without losing the first selection.
  await page.evaluate(() => { window.fixtureDiscussCount = 0; });
  await page.evaluate(() => window.fixture.canvas.select('reply'));
  await page.locator('.canvas-frame[data-item-id="atom"] .canvas-card-drag').click({modifiers:['Control'],position:{x:70,y:90}});
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().object_ids), ['object', 'atom']);
  await page.locator('.canvas-selection-compare').click();
  const multiReader = page.locator('.canvas-selection-reader');
  await multiReader.waitFor({state:'visible'});
  await multiReader.locator('.canvas-reader-font-settings').click();
  assert.equal(await page.evaluate(() => window.fixtureSettingsRequests), 2, 'Selected-content reading must expose the Settings shortcut.');
  assert.equal(await multiReader.locator('.canvas-selection-reader-card').count(), 2);
  const multiBox = await multiReader.boundingBox();
  assert(multiBox.width >= 1300 && multiBox.height >= 800, 'Multi-object reading must use most of the viewport.');
  const wideCards = await multiReader.locator('.canvas-selection-reader-card').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  assert(wideCards[1].x > wideCards[0].x, 'Selected objects must appear side by side on wide screens.');
  assert(wideCards.every(card => card.height >= 600), 'Side-by-side cards must use the available reading height.');
  assert.match(await multiReader.locator('.canvas-selection-reader-card[data-object-id="object"]').innerText(), /Keyboard saved first block/);
  const comparedText = multiReader.locator('.canvas-selection-reader-text').first();
  const comparedFont = await comparedText.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  await comparedText.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('.canvas-selection-reader .canvas-reader-text-size')?.textContent === '120%');
  assert((await comparedText.evaluate(node => parseFloat(getComputedStyle(node).fontSize))) > comparedFont, 'Selected-content reading must share the text-size control.');
  await multiReader.locator('.canvas-reader-text-size').click();
  assert.equal(await multiReader.locator('.canvas-reader-text-size').textContent(), '100%');
  assert.equal(await page.evaluate(() => localStorage.getItem('spellcast.canvas-reading-text-percent')), '100');
  if (process.env.SPELLCAST_TEST_COMPARE_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_COMPARE_SHOT, animations: 'disabled', timeout: 30000 });
  await page.setViewportSize({width:720,height:800});
  const narrowCards = await multiReader.locator('.canvas-selection-reader-card').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  assert(narrowCards[1].y > narrowCards[0].y, 'Selected objects must stack on narrow screens.');
  await page.setViewportSize({width:1440,height:900});
  await multiReader.locator(':scope > header > button').last().click();
  await page.locator('.canvas-selection-discuss').click();
  assert.equal(await page.evaluate(() => window.fixtureDiscussCount), 1);
  assert.equal((await page.evaluate(() => window.fixture.canvas.getSelection().anchors)).length, 2);
  await page.locator('.canvas-selection-more summary').click();
  await page.locator('.canvas-selection-copy').click();
  assert.match(await page.evaluate(() => window.fixtureClipboard), /Fixture[\s\S]*Keyboard saved first block/);
  assert.match(await page.evaluate(() => window.fixtureClipboard), /Standalone atom[\s\S]*Edit me/);
  assert.equal((await page.evaluate(() => window.fixtureClipboard)).split('来自 ').length - 1, 2);
  await page.locator('.canvas-frame[data-item-id="atom"] .canvas-card-drag').click({modifiers:['Control'],position:{x:70,y:90}});
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().object_ids), ['object']);
  await page.locator('.canvas-reply-summary-atom[data-block-id="first"]').click({modifiers:['Control']});
  await page.locator('.canvas-reply-summary-atom[data-block-id="second"]').click({modifiers:['Control']});
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().anchors.map(anchor => anchor.block_id)), ['first', 'second']);
  assert.equal(await page.locator('.canvas-reply-summary-atom[data-block-id="second"]').getAttribute('aria-pressed'), 'true');
  await page.locator('.canvas-tool-selection > .canvas-tool-primary:not(.canvas-selection-discuss)').click();
  await reader.waitFor({state:'visible'});
  assert.equal(await reader.locator('.canvas-reader-atom-row[data-block-id="first"] input').isChecked(), true);
  assert.equal(await reader.locator('.canvas-reader-atom-row[data-block-id="second"] input').isChecked(), true);
  await reader.locator('.rb-block[data-block-id="third"] p').first().click({modifiers:['Control']});
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().anchors.map(anchor => anchor.block_id)), ['first', 'second', 'third']);
  await reader.locator('.canvas-reader-atom-row[data-block-id="first"] button').click({modifiers:['Control']});
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().anchors.map(anchor => anchor.block_id)), ['second', 'third']);
  await reader.locator('.canvas-reader-close').click();
  await reader.waitFor({state:'hidden'});
  // Shift-clicking a summary selects the object without opening it; the toolbar counts the selection.
  await page.evaluate(() => window.fixture.canvas.select('reply'));
  await page.locator('.canvas-frame[data-item-id="atom"] .canvas-card-drag').click({modifiers:['Shift'],position:{x:70,y:90}});
  assert.equal((await page.evaluate(() => window.fixture.canvas.getSelection().object_ids)).length, 2);
  assert.match(await page.locator('.canvas-tool-selection-title').innerText(), /2/);
  await page.locator('.canvas-reply-summary-atom[data-block-id="second"]').click({modifiers:['Shift']});
  assert.equal(await reader.isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.fixture.canvas.getSelection().object_ids), ['atom']);
  await page.locator('.canvas-reply-summary-atom[data-block-id="second"]').click({modifiers:['Shift']});
  await page.locator('.canvas-selection-more summary').click();
  await page.locator('.canvas-align-left').click();
  await page.waitForFunction(() => window.fixture.state().canvas.items[0].x === window.fixture.state().canvas.items[1].x);
  assert.equal(await page.evaluate(() => {
    const [first, second] = window.fixture.state().canvas.items;
    return second.y >= first.y + first.height + 32;
  }), true, 'Left alignment must keep selected cards from overlapping.');
  await page.locator('.canvas-graph').focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.fixture.state().canvas.items[1].x === 850 && window.fixture.state().canvas.items[1].y === 100);

  // Blank-space drag selects intersecting objects in screen coordinates.
  await page.locator('.canvas-tool-camera button').first().click();
  await page.locator('.canvas-tool-multiselect').click();
  const bounds = await page.locator('.canvas-frame').evaluateAll(nodes => nodes.map(node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}; }));
  await page.mouse.move(Math.min(...bounds.map(b=>b.x))-8, Math.min(...bounds.map(b=>b.y))-8);
  await page.mouse.down();
  await page.mouse.move(Math.max(...bounds.map(b=>b.right))+8, Math.max(...bounds.map(b=>b.bottom))+8,{steps:8});
  await page.mouse.up();
  assert.equal((await page.evaluate(() => window.fixture.canvas.getSelection().object_ids)).length, 2);
  await page.locator('.canvas-graph').focus(); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.fixture.canvas.getSelection()), null);
  await page.keyboard.down('Control');
  await page.mouse.move(Math.min(...bounds.map(b=>b.x))-8, Math.min(...bounds.map(b=>b.y))-8);
  await page.mouse.down();
  await page.mouse.move(Math.max(...bounds.map(b=>b.right))+8, Math.max(...bounds.map(b=>b.bottom))+8,{steps:8});
  await page.mouse.up();
  await page.keyboard.up('Control');
  assert.equal((await page.evaluate(() => window.fixture.canvas.getSelection().object_ids)).length, 2);
  await page.keyboard.press('Control+a');
  assert.equal((await page.evaluate(() => window.fixture.canvas.getSelection().object_ids)).length, 2);
  if (process.env.SPELLCAST_TEST_MULTI_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_MULTI_SHOT, animations: 'disabled' });
  const beforeGroup = await page.evaluate(() => JSON.stringify(window.fixture.state().canvas));
  await page.locator('.canvas-tool-selection > button').filter({hasText:/^组合$/}).click();
  const idea = page.locator('.canvas-idea');
  await idea.waitFor({state:'visible'});
  assert.equal(await idea.locator('select[name="arrangement"]').inputValue(), 'free');
  assert.equal(await idea.locator('.canvas-idea-members li').count(), 2);
  assert.equal(await page.evaluate(() => JSON.stringify(window.fixture.state().canvas)), beforeGroup, 'Opening group settings must not move or merge selected content.');
  await idea.locator('.canvas-idea-actions button').first().click();
  await idea.waitFor({state:'hidden'});

  await page.evaluate(() => window.fixture.canvas.select('reply'));
  await page.locator('.canvas-tool-selection > .canvas-tool-primary:not(.canvas-selection-discuss)').click();
  await reader.waitFor({state:'visible'});
  await reader.locator(".canvas-reader-close").click();
  await reader.waitFor({ state: "hidden" });
  assert.equal(await page.locator('.canvas-frame[data-item-id="object"] > .canvas-frame-content').count(), 1);
  await page.evaluate(() => window.fixture.canvas.selectObject("atom"));
  await page.locator(".canvas-tool-selection > .canvas-tool-primary:not(.canvas-selection-discuss)").click();
  await page.locator('.canvas-frame[data-item-id="atom"] .rb-block-tools button').last().click();
  await reader.waitFor({ state: "visible" });
  assert.equal(await reader.locator(".canvas-reader-outline").isVisible(), false, "A standalone atom needs the wide editor without an empty outline.");
  assert.equal(await reader.locator('.rb-block[data-block-id="atom-text"] .rb-area textarea').isVisible(), true);
  await reader.locator(".canvas-reader-close").click();
  await reader.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 720, height: 800 });
  await page.evaluate(() => window.fixture.canvas.select("reply"));
  await page.locator(".canvas-tool-selection > .canvas-tool-primary:not(.canvas-selection-discuss)").click();
  await reader.waitFor({ state: "visible" });
  const mobile = await reader.evaluate(node => ({
    width: node.getBoundingClientRect().width,
    workspaceWidth: node.querySelector(".canvas-reader-workspace").clientWidth,
    workspaceScroll: node.querySelector(".canvas-reader-workspace").scrollWidth,
  }));
  assert(mobile.width >= 700 && mobile.workspaceScroll <= mobile.workspaceWidth + 1, "The narrow work area must use the viewport without horizontal clipping.");
  await reader.locator(".canvas-reader-close").click();
  await reader.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.canvas-reply-summary-atom[data-block-id="third"]').click();
  await reader.waitFor({state:'visible'});
  await reader.locator('.canvas-reader-close').click();
  await reader.waitFor({state:'hidden'});
  await page.evaluate(() => window.fixture.removeBlock('third'));
  assert.equal(await page.evaluate(() => window.fixture.canvas.getSelection()), null, 'Removing a selected block remotely must not broaden discussion to the entire object.');
  await page.evaluate(() => window.fixture.setGraph());
  await page.locator('.canvas-reply-summary-atom[data-block-id="graph"]').click();
  await reader.waitFor({state:'visible'});
  const graphBounds = await reader.locator('.rb-block[data-block-id="graph"]').evaluate(node => ({
    cardBottom: node.getBoundingClientRect().bottom,
    detailsBottom: node.querySelector('.rb-graph-below').getBoundingClientRect().bottom,
  }));
  assert(graphBounds.detailsBottom <= graphBounds.cardBottom + 1, 'Graph details must stay inside the focused block border.');
  await reader.locator('.canvas-reader-close').click();
  await reader.waitFor({state:'hidden'});
  await page.locator('.canvas-tool-camera > button:nth-child(4)').click();
  const cameraScale = await page.locator('.canvas-tool-camera > .canvas-zoom-value').textContent();
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('spellcast.canvas-view:') && JSON.parse(localStorage.getItem(key)).scale > 0));
  await page.evaluate(() => window.fixture.remount());
  await page.waitForFunction(expected => document.querySelector('.canvas-tool-camera > .canvas-zoom-value')?.textContent === expected, cameraScale);
  assert.deepEqual(errors, []);
  assert.equal((await page.evaluate(() => window.fixtureErrors)).length, 1, 'Only the deliberately failed save should report an error.');
  console.log("PASS: viewport, reader Ctrl+wheel text size, Shift/Ctrl and marquee selection, alignment/undo, block comparison/anchors, session scroll restore, graph bounds, draft/error badges, Ctrl+S retry, remote removal, and preserved Canvas placement");
} finally {
  await browser.close();
}
