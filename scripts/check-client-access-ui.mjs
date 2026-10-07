/**
 * Synthetic contract regression for the actual application delegation UI module.
 * No native applications, real grants, bridge, private data, or database are used.
 * Run: node scripts/check-client-access-ui.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
const bundled = await build({
  stdin: {
    contents: `import { mountClientAccessSettings } from './src/client-access-ui';
      import { setLocale } from './src/i18n';
      window.__clientAccessUI = { ...mountClientAccessSettings(document.querySelector('#fixture')), setLocale };`,
    resolveDir: root, sourcefile: "client-access-contract-entry.ts", loader: "ts",
  },
  bundle: true, format: "iife", platform: "browser", write: false,
  outfile: path.join(root, "client-access-contract-fixture.js"),
});
const script = bundled.outputFiles.find(file => file.path.endsWith(".js")).text;
const css = bundled.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const origin = "http://client-access-contract.test";
const identity = { path: "C:\\Synthetic\\CCGUI.exe", sha256: "a".repeat(64), sid: "S-1-5-21-123-456-789-1001", file_id: "synthetic-file-1" };
const candidate = { id: "candidate-1", identity, process_id: 4567, created_at: 1700000000000 };
const grant = { id: "grant-1", identity, scopes: { records: true, sigil_drafts: false }, state: "approved", revision: 7, generation: 3, approved_at_ms: 1700000000000, updated_at_ms: 1700000000001 };
const list = (candidates = [candidate], grants = []) => ({ available: true, candidates, grants });

async function launchBrowser() {
  for (const channel of ["chrome", "msedge"]) {
    try { return await playwright.chromium.launch({ channel, headless: true }); } catch {}
  }
  return playwright.chromium.launch({ headless: true });
}
const browser = await launchBrowser();
let checks = 0;
async function fixture({ native = true, state = list(), reads = [], writes = [] } = {}) {
  const context = await browser.newContext({ locale: "en-US" });
  const blocked = [];
  await context.route("**/*", route => {
    if (route.request().url() === `${origin}/`) return route.fulfill({
      contentType: "text/html", body: '<!doctype html><html><head><meta charset="UTF-8"></head><body><main id="fixture"></main></body></html>',
    });
    blocked.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(config => {
    localStorage.setItem("spellcast.locale", "en");
    window.isTauri = config.native;
    const pendingReads = [];
    const pendingWrites = [];
    const harness = {
      state: config.state, calls: [], reads: config.reads, writes: config.writes,
      releaseRead: () => pendingReads.shift()?.(), releaseWrite: () => pendingWrites.shift()?.(),
    };
    window.__clientAccessHarness = harness;
    // Trap preview IPC too, so accidental invocation is observable.
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      harness.calls.push({ command, args });
      if (!config.native) throw new Error("Preview IPC is forbidden");
      if (command === "client_access_list") {
        const step = harness.reads.shift() ?? {};
        if (step.hold) await new Promise(resolve => pendingReads.push(resolve));
        if (step.fail) throw new Error("Synthetic read failure");
        return structuredClone(Object.hasOwn(step, "result") ? step.result : harness.state);
      }
      if (command !== "client_access_approve" && command !== "client_access_revoke") throw new Error(`Unexpected command ${command}`);
      const step = harness.writes.shift() ?? {};
      if (step.hold) await new Promise(resolve => pendingWrites.push(resolve));
      if (step.state) harness.state = structuredClone(step.state);
      if (step.fail) throw new Error("Synthetic CAS or reply failure");
      if (Object.hasOwn(step, "result")) return structuredClone(step.result);
      let updated;
      if (command === "client_access_approve") {
        const found = harness.state.candidates.find(item => item.id === args.candidateId);
        if (!found || (found.grant?.revision ?? 0) !== args.expectedRevision) throw new Error("Synthetic approval CAS failure");
        updated = {
          id: found.grant?.id ?? "grant-1", identity: found.identity, scopes: args.scopes, state: "approved",
          revision: args.expectedRevision + 1, generation: (found.grant?.generation ?? 0) + 1,
          approved_at_ms: 1700000000002, updated_at_ms: 1700000000002,
        };
        found.grant = updated;
      } else {
        const found = harness.state.grants.find(item => item.id === args.grantId);
        if (!found || found.revision !== args.expectedRevision) throw new Error("Synthetic revocation CAS failure");
        updated = { ...found, state: "revoked", revision: found.revision + 1, updated_at_ms: 1700000000002 };
        for (const item of harness.state.candidates) if (item.grant?.id === updated.id) item.grant = updated;
      }
      harness.state.grants = [...harness.state.grants.filter(item => item.id !== updated.id), updated];
      return structuredClone(updated);
    } };
  }, { native, state, reads, writes });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return { context, page, errors, blocked };
}
const calls = page => page.evaluate(() => window.__clientAccessHarness.calls);
const mutations = async page => (await calls(page)).filter(call => call.command !== "client_access_list");
const candidateCard = page => page.locator("#client-access-candidates .client-access-card").first();
const records = page => candidateCard(page).locator('[data-scope="records"]');
const drafts = page => candidateCard(page).locator('[data-scope="sigil_drafts"]');
const claims = page => candidateCard(page).locator('[data-scope="sigil_claims"]');
const runScope = page => candidateCard(page).locator('[data-scope="sigil_run"]');
const review = page => candidateCard(page).getByRole("button", { name: "Review approval" });
const confirmation = page => page.locator("#client-access-confirmation");
async function phase(page, value) {
  await page.waitForFunction(expected => document.querySelector("#client-access-settings").dataset.state === expected, value);
}
async function openConfirmation(page, { record = true, draft = false, claim = false, run = false } = {}) {
  if (record) await records(page).check();
  if (draft) await drafts(page).check();
  if (claim) await claims(page).check();
  if (run) await runScope(page).check();
  await review(page).click();
  assert.equal(await confirmation(page).isVisible(), true);
}
async function run(name, config, check) {
  const { context, page, errors, blocked } = await fixture(config);
  try {
    await check(page);
    assert.deepEqual(errors, [], "UI module must not produce browser errors");
    assert.deepEqual(blocked, [], "UI module must not attempt network access");
    for (const call of await calls(page)) assert.ok(["client_access_list", "client_access_approve", "client_access_revoke"].includes(call.command));
    console.log(`ok ${++checks} - ${name}`);
  } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  finally { await context.close(); }
}

try {
  await run("changed image is not displayed as currently approved and reapproval uses prior CAS", {state:{available:true,candidates:[{id:"candidate-1",identity:{...identity,sha256:"b".repeat(64)},process_id:123,created_at:1,grant:{id:"grant-1",identity,scopes:{records:true,sigil_drafts:false},state:"approved",revision:1,generation:1,approved_at_ms:1,updated_at_ms:1}}],grants:[{id:"grant-1",identity,scopes:{records:true,sigil_drafts:false},state:"approved",revision:1,generation:1,approved_at_ms:1,updated_at_ms:1}]}}, async page=>{
    await phase(page,"ready");
    assert.match(await candidateCard(page).textContent(),/application image changed/);
    assert.equal(await records(page).isChecked(),false);
    await openConfirmation(page);await confirmation(page).getByRole("button",{name:"Approve selected permissions",exact:true}).click();
    await phase(page,"saved");
    const writes=await mutations(page);assert.equal(writes.length,1);assert.equal(writes[0].args.expectedRevision,1);
    assert.equal(await candidateCard(page).locator('[data-identity="sha256"]').textContent(),"b".repeat(64));
  });
  await run("unavailable pipe retains revocation controls and shows a safe storage reason", { state: { available: false, error_code: "storage_unprotected", candidates: [], grants: [{ id:"grant-1",identity,scopes:{records:true,sigil_drafts:false},state:"approved",revision:1,generation:1,approved_at_ms:1,updated_at_ms:1 }] } }, async page => {
    await phase(page,"unavailable");
    assert.match(await page.locator("#client-access-status").textContent(),/state directory is not restricted/);
    assert.equal(await page.locator('[data-scope]').count(),0);
    await page.getByRole("button",{name:"Revoke access",exact:true}).click();
    await phase(page,"revokedDone");
    assert.equal((await mutations(page)).length,1);
    assert.equal((await mutations(page))[0].command,"client_access_revoke");
  });
  await run("preview is unavailable and never invokes IPC", { native: false }, async page => {
    await phase(page, "unavailable");
    assert.equal(await page.locator("#client-access-refresh").isDisabled(), true);
    assert.equal(await page.locator("[data-scope]").count(), 0);
    await page.evaluate(async () => { await window.__clientAccessUI.refresh(); window.dispatchEvent(new Event("focus")); });
    assert.deepEqual(await calls(page), []);
    await page.evaluate(() => window.__clientAccessUI.setLocale("zh-CN"));
    assert.match(await page.locator("#client-access-status").textContent(), /Windows 桌面应用/);
  });
  await run("discovery and refresh grant no rights; all scopes start unchecked", {}, async page => {
    await phase(page, "ready");
    assert.equal(await records(page).isChecked(), false);
    assert.equal(await drafts(page).isChecked(), false);
    assert.equal(await claims(page).isChecked(), false);
    assert.equal(await runScope(page).isChecked(), false);
    assert.equal(await review(page).isDisabled(), true);
    await page.locator("#client-access-refresh").click();
    await phase(page, "ready");
    assert.equal((await calls(page)).length, 2);
    assert.deepEqual(await mutations(page), []);
  });
  await run("native unavailable and malformed lists expose no approval controls", { state: { available: false, error_code: "UNSUPPORTED", candidates: [], grants: [] } }, async page => {
    await phase(page, "unavailable");
    assert.equal(await page.locator("[data-scope]").count(), 0);
    await page.evaluate(() => { window.__clientAccessHarness.state = { available: true, candidates: [{ id: "bad" }], grants: [] }; });
    await page.locator("#client-access-refresh").click();
    await phase(page, "loadFailed");
    assert.equal(await page.locator("#client-access-status").getAttribute("role"), "alert");
    assert.deepEqual(await mutations(page), []);
  });
  await run("confirmation displays canonical identity, scope and global boundaries; cancel is read-only", {}, async page => {
    await phase(page, "ready");
    await openConfirmation(page);
    for (const key of ["path", "sha256", "sid"]) assert.equal(await confirmation(page).locator(`[data-identity="${key}"]`).textContent(), identity[key]);
    assert.equal(await confirmation(page).locator("li").count(), 1);
    const content = await confirmation(page).textContent();
    for (const part of ["all present and future projects", "all global drafts", "fixed new-draft Canvas card", "all current and future approved CCGUI web devices", "until you revoke", "freezing", "starting", "executing", "commands", "models", "Observer"]) assert.ok(content.includes(part), part);
    assert.deepEqual(await mutations(page), []);
    await confirmation(page).getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await confirmation(page).isVisible(), false);
    assert.deepEqual(await mutations(page), []);
    await review(page).click();
    await page.keyboard.press("Escape");
    assert.equal(await confirmation(page).isVisible(), false);
    assert.deepEqual(await mutations(page), []);
  });
  for (const scopes of [
    { records: true, sigil_drafts: false, sigil_claims: false, sigil_run: false },
    { records: false, sigil_drafts: true, sigil_claims: false, sigil_run: false },
    { records: true, sigil_drafts: true, sigil_claims: true, sigil_run: true },
  ]) {
    await run(`explicit approval sends only chosen scopes ${JSON.stringify(scopes)}`, {}, async page => {
      await phase(page, "ready");
      await openConfirmation(page, { record: scopes.records, draft: scopes.sigil_drafts, claim: scopes.sigil_claims, run: scopes.sigil_run });
      await confirmation(page).getByRole("button", { name: "Approve selected permissions", exact: true }).click();
      await phase(page, "saved");
      assert.deepEqual(await mutations(page), [{ command: "client_access_approve", args: { candidateId: "candidate-1", expectedRevision: 0, scopes } }]);
      assert.equal((await calls(page)).filter(call => call.command === "client_access_list").length, 2);
      assert.equal(await records(page).isChecked(), false);
      assert.equal(await drafts(page).isChecked(), false);
    });
  }
  await run("existing grant approval uses its revision and increments generation", { state: list([{ ...candidate, grant }], [grant]) }, async page => {
    await phase(page, "ready");
    assert.equal(await records(page).isChecked(), false);
    assert.equal(await drafts(page).isChecked(), false);
    await openConfirmation(page, { record: false, draft: true });
    await confirmation(page).getByRole("button", { name: "Approve selected permissions" }).click();
    await phase(page, "saved");
    assert.equal((await mutations(page))[0].args.expectedRevision, 7);
    const actual = await page.evaluate(() => window.__clientAccessHarness.state.grants[0]);
    assert.equal(actual.revision, 8);
    assert.equal(actual.generation, 4);
  });
  await run("revoke sends exact grant CAS and refreshes current state", { state: list([{ ...candidate, grant }], [grant]) }, async page => {
    await phase(page, "ready");
    await page.locator("#client-access-grants").getByRole("button", { name: "Revoke access" }).click();
    await phase(page, "revokedDone");
    assert.deepEqual(await mutations(page), [{ command: "client_access_revoke", args: { grantId: "grant-1", expectedRevision: 7 } }]);
    assert.equal(await page.locator("#client-access-grants").getByRole("button").count(), 0);
    assert.match(await page.locator("#client-access-grants").textContent(), /Revoked/);
  });
  await run("CAS failure refreshes changed state without success claim or retry mutation", {
    state: list([{ ...candidate, grant }], [grant]),
    writes: [{ fail: true, state: list([{ ...candidate, grant: { ...grant, revision: 8 } }], [{ ...grant, revision: 8 }]) }],
  }, async page => {
    await phase(page, "ready");
    await page.locator("#client-access-grants").getByRole("button", { name: "Revoke access" }).click();
    await phase(page, "writeFailed");
    assert.equal(await page.locator("#client-access-status").getAttribute("role"), "alert");
    assert.match(await page.locator("#client-access-status").textContent(), /not confirmed/);
    assert.match(await page.locator("#client-access-grants").textContent(), /Revision: 8/);
    assert.equal((await mutations(page)).length, 1);
    assert.equal((await calls(page)).filter(call => call.command === "client_access_list").length, 2);
  });
  await run("uncertain approval reply with committed state remains an error", { writes: [{ fail: true, state: list([{ ...candidate, grant }], [grant]) }] }, async page => {
    await phase(page, "ready");
    await openConfirmation(page);
    await confirmation(page).getByRole("button", { name: "Approve selected permissions" }).click();
    await phase(page, "writeFailed");
    assert.match(await page.locator("#client-access-grants").textContent(), /Approved/);
    assert.match(await page.locator("#client-access-status").textContent(), /not confirmed/);
  });
  await run("failed mutation and failed refresh disable uncertain grants", { state: list([candidate], [grant]), reads: [{}, { fail: true }], writes: [{ fail: true }] }, async page => {
    await phase(page, "ready");
    await page.locator("#client-access-grants").getByRole("button", { name: "Revoke access" }).click();
    await phase(page, "writeFailed");
    assert.equal(await page.locator("[data-scope]").count(), 0);
    assert.equal(await page.locator("#client-access-grants").getByRole("button").count(), 0);
    await page.locator("#client-access-refresh").click();
    await phase(page, "ready");
    assert.equal((await mutations(page)).length, 1);
  });
  await run("pending reads and writes suppress overlapping actions", { reads: [{ hold: true }], writes: [{ hold: true }] }, async page => {
    await phase(page, "loading");
    assert.equal(await page.locator("#client-access-refresh").isDisabled(), true);
    await page.evaluate(async () => { await window.__clientAccessUI.refresh(); });
    assert.equal((await calls(page)).length, 1);
    await page.evaluate(() => window.__clientAccessHarness.releaseRead());
    await phase(page, "ready");
    await openConfirmation(page);
    await confirmation(page).getByRole("button", { name: "Approve selected permissions" }).click();
    await phase(page, "loading");
    assert.equal(await records(page).isDisabled(), true);
    await page.evaluate(async () => { await window.__clientAccessUI.refresh(); });
    assert.equal((await mutations(page)).length, 1);
    await page.evaluate(() => window.__clientAccessHarness.releaseWrite());
    await phase(page, "saved");
  });
  await run("malicious identity is displayed literally in list and confirmation", {
    state: list([{ ...candidate, identity: { ...identity, path: '<img src="https://invalid.test/attack" onerror="window.__identityExecuted=true">', sid: '<script>window.__identityExecuted=true</script>' } }]),
  }, async page => {
    await phase(page, "ready");
    assert.match(await candidateCard(page).locator('[data-identity="path"]').textContent(), /^<img/);
    assert.equal(await page.locator("#client-access-settings img, #client-access-settings script").count(), 0);
    await openConfirmation(page);
    assert.equal(await confirmation(page).locator("img, script").count(), 0);
    assert.equal(await page.evaluate(() => window.__identityExecuted), undefined);
    assert.deepEqual(await mutations(page), []);
  });
  await run("locale changes update list and open confirmation without changing selected scopes", {}, async page => {
    await phase(page, "ready");
    await openConfirmation(page, { record: false, draft: true });
    await page.evaluate(() => window.__clientAccessUI.setLocale("zh-CN"));
    assert.equal(await page.locator("#client-access-heading").textContent(), "应用委托");
    assert.equal(await confirmation(page).getByRole("heading", { name: "确认应用委托" }).count(), 1);
    assert.equal(await confirmation(page).locator("li").textContent(), "保存全局 Sigil 草稿");
    assert.match(await confirmation(page).textContent(), /所有现有及未来项目/);
    assert.equal(await drafts(page).isChecked(), true);
    await confirmation(page).getByRole("button", { name: "取消", exact: true }).click();
    await page.evaluate(() => window.__clientAccessUI.setLocale("en"));
    assert.equal(await review(page).isEnabled(), true);
    assert.deepEqual(await mutations(page), []);
  });
  console.log(`Passed ${checks} synthetic client access UI checks. No actual grants were tested.`);
} finally { await browser.close(); }
