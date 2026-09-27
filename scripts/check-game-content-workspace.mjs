import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {openView,planTool} from "./check-workspace-nav.mjs";

/** Browser checks against the caller's intercepted project API; no service or database access. */
export async function runContentChecks({ page, objects, projects, mutate, screenshotDir }) {
  const root = page.locator(".project-planning");
  const main = root.locator(".plan-main");
  const workspace = page.locator(".project-workspace");
  const plan = name => root.locator(`[data-plan-action="${name}"]`);
  const content = name => root.locator(`[data-content-action="${name}"]`);
  const flow = name => root.locator(`[data-flow-action="${name}"]`);
  const text = index => root.locator("[data-content-text]").nth(index);
  const saved = id => objects.get(id);
  const previousProject = await page.locator('[data-project-id][aria-current="true"]').getAttribute("data-project-id");
  const projectId = randomUUID();
  const ids = { system: randomUUID(), parameter: randomUUID(), rule: randomUUID(), flow: randomUUID(), legacy: randomUUID() };
  const stepId = randomUUID();
  const longBody = Array.from({ length: 35 }, (_, i) => `Content fixture system paragraph ${i + 1}: saved design context.`).join("\n\n");
  const legacyBody = "Content fixture legacy first line\n\nSecond paragraph **kept verbatim**.\n";
  const planning = (body = "", extra = {}) => ({ scopes: ["R0"], confirmed: false, body, links: [], references: [], locked: true, ...extra });
  const put = (id, kind, name, fields) => mutate({ op: "put_object", project_id: projectId, id, expected_revision: 0,
    name, kind, archived: false, planning: fields, request_id: `content-fixture-${id}` });

  mutate({ op: "create_project", project_id: projectId, name: "Content fixture project", aliases: [], request_id: `content-fixture-project-${projectId}` });
  put(ids.parameter, "parameter", "Content fixture parameter", planning("", {
    parameter: { value: "17", unit: "points", min: "0", max: "100", formula: "", variants: [] },
  }));

  async function pick(id) {
    await planTool(root, "editor");
    await root.locator(`[data-plan-object="${id}"]`).click();
    await root.locator(`[data-plan-read="${id}"]`).waitFor();
  }
  async function save() {
    await plan("save").click();
    await page.waitForFunction(() => document.querySelector(".plan-status")?.textContent === "Saved");
    await root.locator("[data-plan-read]").waitFor();
  }
  async function reload() {
    await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(() => document.querySelector("#projects-open")?.textContent?.trim() === "Game development");
    await page.locator("#projects-open").evaluate(element => element.click());
    await root.locator("[data-plan-read]").waitFor();
  }

  try {
    // The project was created by the fixture, so reopen to fetch the project catalog.
    await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(() => document.querySelector("#projects-open")?.textContent?.trim() === "Game development");
    await page.locator("#projects-open").evaluate(element => element.click());
    await planTool(root, "editor");
    await page.locator(`[data-project-id="${projectId}"]`).click();
    await openView(page,'planning');
    await planTool(root, "write-content");
    assert.equal(await root.locator("[data-content-text]").count(), 1, "Write content should start with one section");
    const first = "# Content fixture standalone\n\n**Bold** and [safe](https://example.invalid/content-fixture).\n\n<img src=x onerror=alert(1)> [unsafe](javascript:alert(1))";
    await text(0).fill(first);
    await content("add").click();
    await text(1).fill("Content fixture reason");
    await root.locator("[data-content-role-select]").nth(1).selectOption("reason");
    await root.locator('[data-content-section-editor]').nth(1).locator('.content-sources > summary').click();
    await content("add-source").nth(1).click();
    const source = root.locator(".content-source-editor").first().locator("input");
    await source.nth(0).fill("Content fixture source");
    await source.nth(1).fill("https://example.invalid/content-fixture-source");
    await source.nth(2).fill("v1");
    await content("add").click();
    await text(2).fill("Content fixture unanswered question?");
    await root.locator("[data-content-role-select]").nth(2).selectOption("question");
    const questionId = await root.locator("[data-content-section-editor]").nth(2).getAttribute("data-content-section-editor");
    await root.locator("[data-content-section-editor]").nth(2).locator('[data-content-action="up"]').click();
    await root.locator("[data-content-section-editor]").nth(2).locator('[data-content-action="remove"]').click();
    assert.equal(await root.locator("[data-content-section-editor]").count(), 2);
    await content("undo-remove").click();
    assert.equal(await root.locator("[data-content-section-editor]").count(), 3);
    await plan("add-link").click();
    const link = root.locator(".plan-link").last();
    await link.locator("select").nth(0).selectOption("uses");
    await link.locator("select").nth(1).selectOption(ids.parameter);
    await save();
    const standalone = [...objects.values()].find(o => o.project_id === projectId && o.name === "Content fixture standalone");
    assert.ok(standalone, "First heading should provide the untitled content name");
    assert.equal(standalone.kind, "content");
    assert.equal(standalone.planning.confirmed, false);
    assert.equal(standalone.planning.body, "", "Sections must be the only content source");
    assert.deepEqual(standalone.planning.sections.map(s => s.role), ["body", "question", "reason"]);
    assert.equal(standalone.planning.sections[1].id, questionId);
    assert.equal(standalone.planning.sections[0].text, first);
    assert.deepEqual(standalone.planning.sections[2].references, [{ label: "Content fixture source", uri: "https://example.invalid/content-fixture-source", version: "v1" }]);
    assert.equal(standalone.planning.links.some(l => l.target_id === ids.parameter && l.relation === "uses"), true);
    assert.match(await main.locator(".content-values").innerText(), /Content fixture parameter.*Shared value.*17 points/s);
    const prose = main.locator(`[data-content-body="${standalone.id}"] .content-prose`).first();
    assert.equal(await prose.locator("strong").innerText(), "Bold");
    assert.equal(await prose.locator('a[href^="https://example.invalid/"]').count(), 1);
    assert.equal(await prose.locator("img,script,a[href^='javascript:']").count(), 0, "Markdown must not create active HTML or script links");
    assert.match(await prose.innerText(), /<img src=x onerror=alert\(1\)>/);

    put(ids.system, "system", "Content fixture system", planning(longBody));
    put(ids.rule, "rule", "Content fixture related rule", planning("Content fixture rule body", {
      links: [{ target_id: ids.system, relation: "belongs_to", note: "" }],
      rule: { trigger: "Content fixture trigger", condition: "Always", effect: "Keep reading" },
    }));
    put(ids.legacy, "content", "Content fixture legacy", planning(legacyBody));
    put(ids.flow, "flow", "Content fixture locked flow", planning("", {
      flow: { entry: stepId, variables: [], steps: [{ id: stepId, title: "Content fixture step", goal: "Read", action: "Write", feedback: "Saved", external: false, terminal: true, choices: [] }] },
    }));
    await page.locator('[data-project-action="refresh"]').click();

    // A still-open standalone draft must not be re-used at another location.
    await planTool(root,'write-content'); await text(0).fill('Content fixture unfinished elsewhere');
    const pendingId = await root.locator('[data-content-text]').first().getAttribute('data-content-text');
    await pick(ids.system); await plan('write-here').click();
    assert.notEqual(await root.locator('[data-content-text]').first().getAttribute('data-content-text'), pendingId);
    assert.equal(await text(0).inputValue(), '');
    await plan('discard').click(); await planTool(root,'write-content');
    assert.equal(await text(0).inputValue(), 'Content fixture unfinished elsewhere', 'The other location draft remains recoverable');
    await plan('discard').click();

    await pick(ids.legacy);
    const beforeCancel = structuredClone(saved(ids.legacy).planning);
    await plan("edit").click();
    await root.locator('[data-plan-field="body"]').waitFor();
    await content("convert").click();
    await content("cancel-convert").click();
    assert.deepEqual(saved(ids.legacy).planning.body, beforeCancel.body);
    assert.equal(saved(ids.legacy).planning.sections, undefined);
    await plan("discard").click();
    await root.locator(`[data-plan-read="${ids.legacy}"]`).waitFor();
    assert.equal(saved(ids.legacy).planning.body, legacyBody);
    await plan("edit").click();
    await content("convert").click();
    await content("confirm-convert").click();
    await save();
    assert.equal(saved(ids.legacy).planning.body, "");
    assert.deepEqual(saved(ids.legacy).planning.sections.map(s => [s.role, s.text]), [["body", legacyBody]]);
    await root.locator('[data-plan-history] > summary').click();
    await plan("history").click();
    await page.waitForFunction(() => document.querySelectorAll('.content-difference').length >= 2);
    assert.ok(await root.locator('.content-difference').count() >= 2, 'Content history shows readable changes');
    await root.locator('.content-difference').first().locator('..').evaluate(element => { element.open = true; });
    assert.match(await root.locator('[data-plan-history]').innerText(), /Added|Removed|Order changed/);

    await pick(ids.system);
    await plan("write-here").click();
    await text(0).fill("# Content fixture system note\n\nRelated saved text.");
    await save();
    const systemContent = [...objects.values()].find(o => o.project_id === projectId && o.name === "Content fixture system note");
    assert.ok(systemContent?.planning.links.some(l => l.target_id === ids.system && l.relation === "belongs_to"));
    await pick(ids.system);
    const related = root.locator(`[data-content-related="${ids.system}"]`);
    await related.locator(`[data-content-related-object="${systemContent.id}"]`).waitFor();
    assert.match(await related.innerText(), /Content fixture system note[\s\S]*Related saved text/);
    assert.match(await related.innerText(), /Content fixture related rule[\s\S]*Content fixture trigger/);
    await main.evaluate(element => { element.scrollTop = Math.min(260, element.scrollHeight - element.clientHeight); element.dispatchEvent(new Event("scroll")); });
    const editRelated = related.locator(`[data-content-related-object="${systemContent.id}"] [data-content-action="edit-section"]`);
    await editRelated.scrollIntoViewIfNeeded();
    const readingScroll = await main.evaluate(element => element.scrollTop);
    assert.ok(readingScroll > 0, "System reader needs a meaningful scroll position");
    await editRelated.click();
    await text(0).waitFor();
    await text(0).fill("# Content fixture system note\n\nRelated saved text, edited.");
    await save();
    await plan("back-to-reading").click();
    await root.locator(`[data-plan-read="${ids.system}"]`).waitFor();
    assert.ok(Math.abs((await main.evaluate(element => element.scrollTop)) - readingScroll) < 8, "Editing a related paragraph should return to its reading position");
    await reload();
    assert.equal(await root.locator("[data-plan-read]").getAttribute("data-plan-read"), ids.system);
    assert.ok(Math.abs((await main.evaluate(element => element.scrollTop)) - readingScroll) < 8, "Reload should restore the selected object and reading position");
    assert.equal(saved(systemContent.id).planning.sections[0].text, "# Content fixture system note\n\nRelated saved text, edited.");

    // Backend key order must not create a phantom draft. Concurrent anchors survive a text merge.
    const reordered = saved(systemContent.id);
    reordered.planning = Object.fromEntries(Object.entries(reordered.planning).reverse());
    await page.locator('[data-project-action="refresh"]').click(); await pick(systemContent.id);
    assert.equal(await root.locator('.plan-draft-notice').count(), 0);
    await plan('edit').click(); await text(0).fill('# Content fixture system note\n\nMy concurrent text.');
    const beforeRemote = structuredClone(saved(systemContent.id));
    mutate({op:'put_object',project_id:projectId,id:beforeRemote.id,expected_revision:beforeRemote.revision,name:beforeRemote.name,kind:'content',archived:false,
      planning:{...beforeRemote.planning,anchors:[{flow_id:ids.flow,step_id:stepId}]},request_id:'content-fixture-concurrent-anchor'});
    await plan('save').click(); await root.locator('.plan-conflict').waitFor(); await plan('rebase').click(); await save();
    assert.equal(saved(systemContent.id).planning.sections[0].text, '# Content fixture system note\n\nMy concurrent text.');
    assert.deepEqual(saved(systemContent.id).planning.anchors, [{flow_id:ids.flow,step_id:stepId}], 'Rebasing a text edit preserves concurrent flow anchors');

    await planTool(root, "flows");
    await root.locator('[data-flow-field="flow-picker"]').selectOption(ids.flow);
    await flow("start").click();
    await root.locator(`[data-flow-current="${stepId}"]`).waitFor();
    const flowRevision = saved(ids.flow).revision;
    await root.locator(`[data-flow-current="${stepId}"] [data-flow-action="write-content"]`).click();
    await text(0).fill("# Content fixture anchored note\n\nWritten from locked flow.");
    await save();
    const anchored = [...objects.values()].find(o => o.project_id === projectId && o.name === "Content fixture anchored note");
    assert.ok(anchored);
    assert.deepEqual(anchored.planning.anchors, [{ flow_id: ids.flow, step_id: stepId }]);
    assert.equal(anchored.planning.links.some(l => l.target_id === ids.flow && l.relation === "belongs_to"), true);
    assert.equal(saved(ids.flow).revision, flowRevision, "Writing content must not change the locked flow revision");
    assert.equal(saved(ids.flow).planning.locked, true);

    await mkdir(screenshotDir, { recursive: true });
    await pick(standalone.id);
    for (const [width, height] of [[1280, 860], [880, 800], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 2), false, `Content workspace overflow at ${width}px`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false, `Page overflow at ${width}px`);
      await page.screenshot({ path: path.join(screenshotDir, `content-reader-${width}.png`) });
    }
    await plan("edit").click();
    await text(0).waitFor();
    for (const [width, height] of [[1280, 860], [880, 800], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 2), false, `Content editor overflow at ${width}px`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false, `Page overflow in content editor at ${width}px`);
      await page.screenshot({ path: path.join(screenshotDir, `content-editor-${width}.png`) });
    }
    await plan("discard").click();
    await root.locator(`[data-plan-read="${standalone.id}"]`).waitFor();
    await page.setViewportSize({ width: 1280, height: 860 });
    console.log("content UI passed: independent sections, role/order/source/undo, legacy conversion, related reading and return, safe Markdown, reload position, locked flow anchor, responsive screenshots");
  } finally {
    await page.setViewportSize({ width: 1280, height: 860 });
    if (previousProject && projects.has(previousProject)) {
      await planTool(root, "editor");
      await page.locator(`[data-project-id="${previousProject}"]`).click();
      await openView(page,'planning');
    }
  }
}
