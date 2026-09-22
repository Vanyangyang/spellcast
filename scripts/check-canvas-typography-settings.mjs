/** Exercise the real Settings controls with backend requests isolated from user data. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require(process.env.SPELLCAST_PLAYWRIGHT ?? path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }

const url = process.env.SPELLCAST_TEST_URL ?? "http://127.0.0.1:47198/";
const browser = await playwright.chromium.launch({ headless: true, channel: "chrome", args: ["--no-proxy-server"], timeout: 15000 });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
page.setDefaultTimeout(20000);

try {
  await page.route("http://127.0.0.1:47194/**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture"}' }));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#settings-open").click();
  const settings = page.locator("#settings");
  await settings.waitFor({ state: "visible" });
  const body = settings.locator("#settings-font-body");
  const heading = settings.locator("#settings-font-title");
  const ui = settings.locator("#settings-font-interface");
  const preview = settings.locator(".settings-font-preview");
  const sizes = () => preview.evaluate(node => ({
    body: parseFloat(getComputedStyle(node.querySelector("p")).fontSize),
    heading: parseFloat(getComputedStyle(node.querySelector("strong")).fontSize),
    ui: parseFloat(getComputedStyle(node.querySelector("small")).fontSize),
  }));
  const before = await sizes();
  const change = async (control, value) => control.evaluate((node, next) => {
    node.value = String(next);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

  await change(body, 140);
  const afterBody = await sizes();
  assert(afterBody.body > before.body && afterBody.heading === before.heading && afterBody.ui === before.ui, "The body slider must only change body text.");
  assert.equal(await body.locator("xpath=../output").textContent(), "140%");
  await change(body, 300);
  assert.equal(await body.locator("xpath=../output").textContent(), "300%", "Settings must expose the larger body range.");
  await change(body, 140);

  await change(heading, 150);
  await change(ui, 130);
  const afterAll = await sizes();
  assert(afterAll.heading > before.heading && afterAll.ui > before.ui && afterAll.body === afterBody.body, "Heading and interface sliders must be independent.");
  assert.deepEqual(await page.evaluate(() => [
    localStorage.getItem("spellcast.canvas-reading-text-percent"),
    localStorage.getItem("spellcast.canvas-reading-title-percent"),
    localStorage.getItem("spellcast.canvas-reading-interface-percent"),
  ]), ["140", "150", "130"]);
  if (process.env.SPELLCAST_TEST_SETTINGS_SHOT) await page.screenshot({ path: process.env.SPELLCAST_TEST_SETTINGS_SHOT, animations: "disabled" });

  await settings.locator("#settings-close").click();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("#settings-font-body")?.value === "140");
  await page.evaluate(() => {
    const reader = document.createElement("dialog");
    reader.id = "fixture-reader";
    document.body.append(reader);
    reader.showModal();
    document.dispatchEvent(new Event("spellcast-open-settings"));
  });
  await settings.waitFor({ state: "visible" });
  assert.equal(await page.locator("#fixture-reader").evaluate(node => node.open), true, "Settings must open over the active reader.");
  assert.deepEqual([await body.inputValue(), await heading.inputValue(), await ui.inputValue()], ["140", "150", "130"], "Font settings must survive reload.");
  await settings.locator("#settings-font-reset").click();
  assert.deepEqual([await body.inputValue(), await heading.inputValue(), await ui.inputValue()], ["100", "100", "100"]);
  await settings.locator("#settings-close").click();
  assert.equal(await page.locator("#fixture-reader").evaluate(node => node.open), true, "Closing Settings must return to the reader.");
  console.log("PASS: Settings body, heading, and interface text sizes update independently, persist, reset, and open above the reader");
} finally {
  await browser.close();
}
