import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {openView,planTool} from "./check-workspace-nav.mjs";

/**
 * Linked-trial workbench: flow positions on locked flows, independent candidates, saved trials,
 * replay/compare and adoption. Uses only the intercepted fixture API; no real database or Unity.
 */
export async function runWorkbenchChecks({ page, objects, projects, mutate, screenshotDir, evidence }) {
  const workspace = page.locator(".project-workspace"), root = page.locator(".project-planning");
  const plan = name => root.locator(`[data-plan-action="${name}"]`), planField = name => root.locator(`[data-plan-field="${name}"]`);
  const flowAction = name => root.locator(`[data-flow-action="${name}"]`), flowField = name => root.locator(`[data-flow-field="${name}"]`);
  const get = name => [...objects.values()].find(o => o.name === name);
  const until = async (test, label, timeout = 10_000) => { const start = Date.now(); while (!test()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 40)); } };
  const flowStatus = () => root.locator(".flow-workspace > p[role=status]").innerText();
  const pick = async id => { await planTool(root, "editor"); await root.locator(`[data-plan-object="${id}"]`).click(); await root.locator(`[data-plan-read="${id}"]`).waitFor(); };
  const edit = async () => { await plan("edit").click(); await planField("name").waitFor({ state: "visible" }); };
  const save = async () => { await plan("save").click(); await page.waitForFunction(() => document.querySelector(".plan-status")?.textContent === "Saved"); };
  const noOverflow = async (label, target) => { for (const [width, height] of [[1920, 1080], [1320, 900], [880, 800]]) {
    await page.setViewportSize({ width, height }); await root.locator(".plan-main").evaluate(e => { e.scrollTop = 0; });
    if (target) await root.locator(target).first().evaluate(e => e.scrollIntoView({ block: "start" }));
    assert.equal(await workspace.evaluate(e => e.scrollWidth > e.clientWidth + 2), false, `${label} overflows at ${width}`);
    await page.screenshot({ path: path.join(screenshotDir, `workbench-${label}-${width}.png`) });
  } await page.setViewportSize({ width: 1280, height: 860 }); };

  const project = [...projects.values()][0], reward = get("Fixture reward");
  assert.ok(reward && reward.planning.parameter.value === "11", "flow checks leave the shared value at 11");
  // Isolated fixture flow: a gate that reads the shared parameter, then a manual (external) fight.
  const flowPlanning = { scopes: ["R0"], confirmed: false, body: "", links: [{ target_id: reward.id, relation: "uses", note: "Stamina source" }], references: [], locked: true, flow: { entry: "gate",
    variables: [{ id: "stamina", name: "Stamina", value_type: "number", initial: "", unit: "", parameter_id: reward.id }, { id: "coins", name: "Coins", value_type: "number", initial: "0", unit: "" }],
    steps: [
      { id: "gate", title: "Gate", goal: "Decide to pay", action: "Pay five stamina", feedback: "Door opens", external: false, terminal: false, choices: [{ id: "enter", label: "Pay five", to: "fight", conditions: [{ variable_id: "stamina", op: "gte", operand: { kind: "literal", value: "5" } }], effects: [{ variable_id: "stamina", op: "subtract", operand: { kind: "literal", value: "5" } }] }] },
      { id: "fight", title: "Fight", goal: "", action: "External combat result", feedback: "", external: true, terminal: false, choices: [{ id: "collect", label: "Collect", to: "end", conditions: [], effects: [{ variable_id: "coins", op: "add", operand: { kind: "literal", value: "3" } }] }] },
      { id: "end", title: "Settle", goal: "", action: "", feedback: "Reward shown", external: false, terminal: true, choices: [] }] } };
  mutate({ op: "put_object", project_id: project.id, id: "trial-fixture-flow", expected_revision: 0, name: "Trial fixture", kind: "flow", archived: false, planning: flowPlanning, request_id: "trial-fixture" });
  const flowId = "trial-fixture-flow", flowRevision = objects.get(flowId).revision;
  await openView(page,'planning');
  await page.locator('[data-project-action="refresh"]').click(); await page.waitForFunction(() => document.querySelector(".plan-status")?.hidden === true);

  // 1. Designs attach to a locked flow without changing it.
  const hook = get("Fixture hook"), rule = get("Fixture rule"), content = get("Shared consumer");
  await pick(hook.id); await edit();
  await plan("add-anchor").click(); await planField("anchor-flow-0").selectOption(flowId); await planField("anchor-phase-0").selectOption("cue");
  await plan("add-anchor").click(); await planField("anchor-flow-1").selectOption(flowId); await planField("anchor-step-1").selectOption("end"); await planField("anchor-phase-1").selectOption("payoff");
  await noOverflow("anchor-editor", "[data-plan-anchors]");
  await save();
  await pick(rule.id); await edit();
  await plan("add-anchor").click(); await planField("anchor-flow-0").selectOption(flowId); await planField("anchor-choice-0").selectOption("enter"); await planField("anchor-note-0").fill("costs five");
  await save();
  await pick(content.id); await edit();
  await plan("add-anchor").click(); await planField("anchor-flow-0").selectOption(flowId); await planField("anchor-step-0").selectOption("end");
  await save();
  assert.equal(objects.get(flowId).revision, flowRevision, "Attaching designs must not create a flow revision");
  assert.equal(objects.get(flowId).planning.locked, true, "The flow stays locked");
  assert.deepEqual(get("Fixture hook").planning.anchors, [{ flow_id: flowId, step_id: "gate", phase: "cue" }, { flow_id: flowId, step_id: "end", phase: "payoff" }]);
  assert.deepEqual(get("Fixture rule").planning.anchors, [{ flow_id: flowId, step_id: "gate", choice_id: "enter", note: "costs five" }]);

  // Two-way navigation: object → flow position → object.
  await pick(hook.id); await root.locator('[data-plan-action="open-anchor"]').first().click();
  await root.locator('[data-flow-focus="gate"]').waitFor();
  assert.match(await root.locator('[data-flow-focus="gate"]').innerText(), /Fixture hook/);
  await flowAction("return-object").click(); await root.locator(`[data-plan-read="${hook.id}"]`).waitFor();
  await root.locator('[data-plan-action="open-anchor"]').nth(1).click(); await root.locator('[data-flow-focus="end"]').waitFor();
  assert.match(await root.locator('[data-flow-focus="end"]').innerText(), /Shared consumer/);
  await root.locator('[data-flow-focus="end"] [data-flow-action="open-design"]').first().click();
  await plan("back-to-flow").waitFor(); await plan("back-to-flow").click(); await root.locator('[data-flow-focus="end"]').waitFor();
  await page.screenshot({ path: path.join(screenshotDir, "workbench-flow-focus.png") });
  // A step with attached designs cannot be removed from the flow editor.
  await flowAction("clear-focus").click(); await flowAction("edit-flow").click();
  await root.locator('[data-flow-step="gate"]').waitFor(); await root.locator('[data-flow-step="gate"]').click();
  await flowAction("remove-step").click(); await root.locator("[data-flow-guard]").waitFor();
  assert.match(await root.locator("[data-flow-guard]").innerText(), /Fixture hook[\s\S]*Fixture rule/);
  assert.equal(objects.get(flowId).planning.flow.steps.length, 3);
  await plan("discard").click(); await root.locator(`[data-plan-read="${flowId}"]`).waitFor();
  assert.equal(objects.get(flowId).planning.locked, true);
  assert.match(await root.locator("[data-plan-attached]").innerText(), /Gate[\s\S]*Fixture hook/);

  // 2. Candidates never touch the locked parameter.
  const locked = objects.get(reward.id);
  mutate({ op: "set_object_lock", project_id: project.id, id: reward.id, expected_revision: locked.revision, locked: true, request_id: "lock-reward-for-candidates" });
  const lockedRevision = objects.get(reward.id).revision;
  await page.locator('[data-project-action="refresh"]').click(); await page.waitForFunction(() => document.querySelector(".plan-status")?.hidden === true);
  await pick(reward.id);
  const addCandidate = async (label, value, reason) => {
    await plan("new-candidate").click(); await planField("candidate-label").fill(label); await planField("candidate-value").fill(value); await planField("candidate-reason").fill(reason);
    const before = evidence.candidates.size; await plan("save-candidate").click(); await until(() => evidence.candidates.size === before + 1, `candidate ${label}`);
    await root.locator("[data-plan-candidate]").nth(before).waitFor();
  };
  await addCandidate("Low", "2", "Blocks the gate");
  await addCandidate("High", "9", "Keeps the gate open");
  const low = [...evidence.candidates.values()].find(c => c.label === "Low"), high = [...evidence.candidates.values()].find(c => c.label === "High");
  assert.equal(objects.get(reward.id).revision, lockedRevision, "Candidates must not create a parameter revision");
  assert.equal(objects.get(reward.id).planning.locked, true);
  assert.equal(objects.get(reward.id).planning.parameter.value, "11");
  await plan("convert-variant").click(); await until(() => [...evidence.candidates.values()].some(c => c.from_variant === "Gentle"), "legacy variant conversion");
  await root.getByText("Already saved as an independent candidate").waitFor();
  assert.deepEqual(objects.get(reward.id).planning.parameter.variants.map(v => v.label), ["Gentle"], "Legacy variants are kept as they were");
  const values = await root.locator(".plan-candidate-values").innerText();
  assert.match(values, /Shared \(adopted\): 11 points/); assert.match(values, /Local consumer: 5 \(Intro fixture\)/);
  await noOverflow("candidates", "[data-plan-candidates]");

  // 3. A walkthrough records its input sources and path facts, then is saved immutably.
  await root.locator(`[data-plan-candidate="${low.id}"] [data-plan-action="try-candidate"][data-flow-id="${flowId}"]`).click();
  await flowField(`candidate-${reward.id}`).waitFor();
  assert.equal(await flowField(`candidate-${reward.id}`).inputValue(), low.id, "The chosen candidate is preselected");
  assert.equal(await flowField("initial-stamina").inputValue(), "2");
  await flowField(`candidate-${reward.id}`).selectOption(""); assert.equal(await flowField("initial-stamina").inputValue(), "11");
  await flowAction("start").click(); await root.locator('[data-flow-choice="enter"]').click();
  await flowField("manual-coins").fill("4"); await flowAction("confirm-manual").click(); await root.locator('[data-flow-choice="collect"]').click();
  await page.waitForFunction(() => document.querySelector('[data-flow-value="coins"] dd')?.textContent === "7");
  const facts = await root.locator("[data-flow-facts]").innerText();
  for (const expected of [/线索步骤「Gate」已到达（开始时）/, /规则「Fixture rule」 · 选择「Pay five」已执行（第 1 个动作）/, /回报步骤「Settle」已到达（第 3 个动作后）/, /内容「Shared consumer」 · 步骤「Settle」已到达/]) assert.match(facts, expected);
  assert.doesNotMatch(facts.replace(/不评价体验、理解或钩子效果/, ""), /兑现|成功|理解|有效/, "Automatic reports state path facts only");
  const trialsBefore = evidence.trials.size;
  await flowAction("save-trial").click(); await until(() => evidence.trials.size === trialsBefore + 1, "base trial saved");
  const base = [...evidence.trials.values()].at(-1), frozenBase = JSON.stringify(base);
  assert.equal(base.run.input_sources.find(s => s.variable_id === "stamina").source, "shared");
  assert.equal(base.run.anchors.length, 4);
  await flowAction("save-trial").click(); await page.waitForTimeout(300);
  assert.equal(evidence.trials.size, trialsBefore + 1, "Saving unchanged content again must not duplicate it");

  // 4. Replaying with a lower candidate stops at the first divergence and keeps the base intact.
  await flowAction("replay-from-run").click(); await root.locator(`[data-flow-replay-setup="${base.id}"]`).waitFor();
  await flowField(`replay-candidate-${reward.id}`).selectOption(low.id);
  assert.equal(await root.locator('[data-flow-replay-setup] p[data-replay-changed="true"]').count(), 1);
  await noOverflow("replay-setup");
  await flowAction("start-replay").click(); await root.locator("[data-flow-compare]").waitFor();
  assert.match(await root.locator('[data-compare="route"]').innerText(), /停止重放[\s\S]*条件未满足[\s\S]*Stamina 大于等于 5（当前 2）/);
  assert.match(await root.locator('[data-compare="value"]').innerText(), /初值：Stamina A 11 · B 2/);
  const lowReplay = [...evidence.trials.values()].at(-1);
  assert.deepEqual([lowReplay.origin, lowReplay.run.replay.status, lowReplay.run.replay.base_trial_id], ["replay", "diverged", base.id]);
  assert.equal(JSON.stringify(evidence.trials.get(base.id)), frozenBase, "The base trial must stay unchanged");
  await noOverflow("compare-divergence");

  // 5. A higher candidate pauses at the manual step; reuse is explicit and marked as an assumption.
  await flowAction("mode-trials").click(); await root.locator(`[data-flow-action="replay-trial"][data-trial-id="${base.id}"]`).click();
  await flowField(`replay-candidate-${reward.id}`).selectOption(high.id); await flowAction("start-replay").click();
  await flowAction("reuse-manual").waitFor();
  assert.match(await root.locator(".flow-manual").innerText(), /注意：到达这一步时的执行定义、输入、依赖、关联位置或状态已与基准不同/);
  assert.equal(await flowAction("rewind").isDisabled(), true, "Replays advance only by the base intent");
  await flowAction("reuse-manual").click(); await root.locator("[data-flow-compare]").waitFor();
  const highReplay = [...evidence.trials.values()].at(-1);
  assert.deepEqual([highReplay.run.replay.status, highReplay.run.events[1].assumption.context_changed], ["complete", true]);
  const compare = await root.locator("[data-flow-compare]").innerText();
  assert.match(compare, /路线一致/); assert.match(compare, /初值：Stamina A 11 · B 9/); assert.match(compare, /手动假设；复用时输入或依赖已与基准不同/);
  await noOverflow("compare-assumption");

  // 6. Adoption: explicit unlock, conflict keeps the draft, one shared value changes, local overrides stay.
  await root.locator(`[data-flow-action="adopt-candidate"][data-candidate-id="${high.id}"]`).click();
  await root.locator(`[data-plan-adopt="${reward.id}"]`).waitFor();
  assert.equal(await plan("adopt-confirm").isDisabled(), true, "Locked parameters cannot be adopted into");
  for (const id of [base.id, highReplay.id]) assert.equal(await root.locator(`[data-adopt-trial="${id}"]`).isChecked(), true);
  assert.match(await root.locator("[data-plan-adopt-evidence]").innerText(), /no candidate used; check the actual initial source in trial details/);
  assert.ok(await plan("view-trial-sources").count() >= 2, "Evidence rows link to frozen input details");
  for (const id of [base.id, highReplay.id]) await root.locator(`[data-adopt-trial="${id}"]`).uncheck();
  assert.match(await root.locator("[data-plan-adopt-evidence]").innerText(), /No trial selected/);
  for (const id of [base.id, highReplay.id]) await root.locator(`[data-adopt-trial="${id}"]`).check();
  await root.locator(`[data-plan-action="view-trial-sources"][data-trial-id="${base.id}"]`).click();
  await root.locator(`[data-flow-trial-detail="${base.id}"]`).waitFor();
  assert.match(await root.locator(`[data-flow-trial-detail="${base.id}"]`).innerText(), /Stamina = 11 · Fixture reward · 版本 \d+ · 共享值/);
  await flowAction("return-object").click(); await root.locator(`[data-plan-read="${reward.id}"]`).waitFor();
  await root.locator(`[data-plan-candidate="${high.id}"] [data-plan-action="adopt-candidate"]`).click();
  for (const id of [base.id, highReplay.id]) assert.equal(await root.locator(`[data-adopt-trial="${id}"]`).isChecked(), true, "Adoption selections survive inspecting trial sources");
  assert.match(await root.locator('[data-adopt-impact="local"]').innerText(), /Local consumer · keeps its local value: 5/);
  assert.ok(await root.locator('[data-adopt-impact="inherited"]').count() >= 2);
  await plan("adopt-unlock").click(); await page.waitForFunction(() => !document.querySelector('[data-plan-action="adopt-unlock"]'));
  await planField("adopt-reason").fill("Nine keeps the gate open after one fight");
  await noOverflow("adoption");
  const concurrent = objects.get(reward.id);
  mutate({ op: "put_object", project_id: project.id, id: reward.id, expected_revision: concurrent.revision, name: concurrent.name, kind: "parameter", archived: false, planning: { ...concurrent.planning, body: "Concurrent note" }, request_id: "concurrent-note" });
  await plan("adopt-confirm").click(); await page.waitForFunction(() => /newer version|新版本|changed/.test(document.querySelector(".plan-status")?.textContent || ""));
  assert.equal(evidence.adoptions.size, 0, "A stale adoption must not be written");
  assert.equal(await planField("adopt-reason").inputValue(), "Nine keeps the gate open after one fight", "The adoption draft survives a conflict");
  const beforeAdopt = objects.get(reward.id);
  await plan("adopt-confirm").click(); await until(() => evidence.adoptions.size === 1, "adoption saved");
  const adopted = objects.get(reward.id), record = [...evidence.adoptions.values()][0];
  assert.deepEqual([adopted.planning.parameter.value, adopted.planning.locked, adopted.revision, adopted.planning.body], ["9", true, beforeAdopt.revision + 1, "Concurrent note"]);
  assert.deepEqual([record.candidate.id, record.candidate.revision, record.value_before, record.trial_ids.sort()], [high.id, high.revision, "11", [base.id, highReplay.id].sort()]);
  assert.equal(get("Local consumer").planning.links[0].local.value, "5", "Local overrides stay unchanged");
  await root.locator(`[data-plan-read="${reward.id}"]`).waitFor();
  assert.match(await root.locator("[data-plan-adoptions]").innerText(), /11 → 9 · High/);
  // The low candidate's base is now older: adoption is blocked until it is explicitly rebased.
  assert.equal(await root.locator(`[data-plan-candidate="${low.id}"] [data-base-changed="true"]`).count(), 1);
  await root.locator(`[data-plan-candidate="${low.id}"] [data-plan-action="adopt-candidate"]`).click();
  assert.equal(await plan("adopt-confirm").isDisabled(), true);
  await plan("adopt-rebase").click(); await until(() => evidence.candidates.get(low.id).base.value === "9", "rebased candidate");
  await root.locator('[data-plan-adopt] [data-base-changed="false"]').waitFor();
  await plan("adopt-back").click(); await root.locator(`[data-plan-read="${reward.id}"]`).waitFor();

  // 7. Saved trials, the active checkpoint and the comparison survive a reload.
  const recordedTrials = [...evidence.trials.values()].filter(t => t.flow_id === flowId).length;
  await page.reload({ waitUntil: "commit" }); await page.waitForFunction(() => document.querySelector("#projects-open")?.textContent?.trim() === "Game development");
  await page.locator("#projects-open").evaluate(e => e.click()); await page.waitForSelector("dialog.project-workspace[open]");
  await pick(hook.id); await root.locator('[data-plan-action="open-anchor"]').first().click(); await root.locator('[data-flow-focus="gate"]').waitFor();
  await flowAction("mode-trials").click(); await page.waitForFunction(n => document.querySelectorAll("[data-trial-row]").length === n, recordedTrials);
  await root.locator(`[data-flow-action="view-trial"][data-trial-id="${base.id}"]`).click(); await root.locator(`[data-flow-trial-detail="${base.id}"]`).waitFor();
  assert.match(await root.locator(`[data-flow-trial-detail="${base.id}"]`).innerText(), /Stamina = 11 · Fixture reward · 版本 \d+ · 共享值/);
  assert.match(await root.locator(`[data-trial-row="${base.id}"]`).innerText(), /未使用候选 · 实际初值来源见详情/);
  await root.locator('[data-flow-focus="gate"] [data-flow-action="open-design"]').first().click();
  await plan("back-to-flow").click(); await root.locator(`[data-flow-trial-detail="${base.id}"]`).waitFor();
  await root.locator(`[data-flow-action="replay-trial"][data-trial-id="${base.id}"]`).click();
  await flowField(`replay-candidate-${reward.id}`).selectOption(low.id);
  await root.locator('[data-flow-focus="gate"] [data-flow-action="open-design"]').first().click();
  await plan("back-to-flow").click(); await root.locator(`[data-flow-replay-setup="${base.id}"]`).waitFor();
  assert.equal(await flowField(`replay-candidate-${reward.id}`).inputValue(), low.id, "Replay choice survives design round trip");
  await flowAction("cancel-replay").click();
  await noOverflow("trials", "[data-flow-trials]");
  await flowAction("mode-compare").click(); await root.locator("[data-flow-compare]").waitFor();

  // 8. Local v1 runs are verified before recovery and removed only after the project write.
  const liveFlow = objects.get(flowId), liveReward = objects.get(reward.id);
  await page.evaluate(({ projectId, flow, parameter }) => {
    localStorage.setItem(`spellcast.flow-run.v1.${projectId}.${flow.id}`, JSON.stringify({ version: 1, id: "legacy-run", started: "2026-09-20T10:00:00.000Z", source: flow, dependencies: [parameter], inputs: {}, initial: { stamina: Number(parameter.planning.parameter.value), coins: 0 }, events: [] }));
    localStorage.setItem(`spellcast.flow-run.v1.${projectId}.${flow.id}.previous`, "{broken");
  }, { projectId: project.id, flow: liveFlow, parameter: liveReward });
  await page.reload({ waitUntil: "commit" }); await page.waitForFunction(() => document.querySelector("#projects-open")?.textContent?.trim() === "Game development");
  await page.locator("#projects-open").evaluate(e => e.click()); await root.locator("[data-flow-legacy]").waitFor();
  assert.match(await root.locator("[data-flow-legacy]").innerText(), /发现 2 条本机旧试走[\s\S]*不能恢复：无法解析/);
  await flowAction("recover-legacy").click(); await until(() => [...evidence.trials.values()].some(t => t.origin === "legacy_local"), "legacy recovery");
  await page.waitForFunction(() => (document.querySelector(".flow-workspace > p[role=status]")?.textContent || "").includes("已保存为项目试走"));
  const stored = await page.evaluate(id => [localStorage.getItem(`spellcast.flow-run.v1.${id}`), localStorage.getItem(`spellcast.flow-run.v1.${id}.previous`)], `${project.id}.${flowId}`);
  assert.deepEqual(stored, [null, "{broken"], "Only the verified copy is removed; the corrupt one is kept");
  assert.match(await flowStatus(), /已保存为项目试走/);

  // 9. The portable export carries candidates, trials and adoptions (version 3).
  await openView(page,'records');
  await page.locator("details.project-workspace-exports summary").click();
  const download = page.waitForEvent("download"); await page.locator('[data-export="json"]').click();
  const bundle = JSON.parse(await readFile(await (await download).path(), "utf8"));
  assert.deepEqual([bundle.version, bundle.trials.length, bundle.adoptions.length, bundle.candidates.length], [3, evidence.trials.size, 1, 3]);
  await openView(page,'planning');
  // A checkpoint with inputs but no choice still needs an immutable save before replacement.
  await flowAction("mode-run").click(); await flowAction("reset-inputs").click(); await flowAction("start").click();
  await root.locator('[data-flow-current="gate"]').waitFor();
  const beforeZeroAction = evidence.trials.size;
  await flowAction("reset-inputs").click(); await flowAction("start").click();
  await until(() => evidence.trials.size === beforeZeroAction + 1, "zero-action checkpoint autosaved");
  const zeroAction = [...evidence.trials.values()].at(-1).run;
  assert.equal(zeroAction.events.length, 0, "Zero-action saved run is immutable trial evidence");
  assert.equal(zeroAction.input_sources.find(source => source.variable_id === "stamina").source, "shared");
  assert.equal(zeroAction.candidates, undefined, "Zero-action autosave does not rely on candidate provenance");
  // An archived selected candidate blocks replay; a concurrent revision is rechecked on Start.
  await pick(reward.id);
  await root.locator(`[data-plan-candidate="${high.id}"] [data-plan-action="archive-candidate"]`).click();
  await until(() => evidence.candidates.get(high.id).archived, "candidate archived");
  await planTool(root, "flows"); await flowAction("mode-trials").click();
  await root.locator(`[data-flow-action="replay-trial"][data-trial-id="${highReplay.id}"]`).click();
  await root.locator(`[data-flow-replay-setup="${highReplay.id}"]`).waitFor();
  assert.equal(await flowAction("start-replay").isDisabled(), true, "Archived candidate cannot silently become shared input");
  assert.match(await root.locator("[data-flow-replay-setup]").innerText(), /已归档，请重新选择数值来源/);
  await flowField(`replay-candidate-${reward.id}`).selectOption("");
  assert.equal(await flowAction("start-replay").isDisabled(), false, "Explicit shared-value selection clears the block");
  await root.locator(`[data-flow-action="replay-trial"][data-trial-id="${lowReplay.id}"]`).click();
  const oldLow = evidence.candidates.get(low.id);
  mutate({ op: "put_candidate", project_id: project.id, id: low.id, expected_revision: oldLow.revision, parameter_id: reward.id,
    label: oldLow.label, value: "3", reason: oldLow.reason, base_revision: oldLow.base.revision, archived: false, request_id: "concurrent-low-review" });
  await flowAction("start-replay").click();
  await page.waitForFunction(() => (document.querySelector('.flow-workspace > p[role="status"]')?.textContent || "").includes("已有新版本"));
  assert.equal(await flowAction("start-replay").isDisabled(), true);
  assert.match(await root.locator("[data-flow-replay-setup]").innerText(), /已有新版本，请重新选择数值来源/);
  console.log("workbench fixture passed: locked-flow anchors and two-way location, step deletion guard, independent candidates without unlock, legacy variant conversion, input provenance and path facts, immutable deduplicated trials, first-divergence replay, explicit manual assumption, comparison, explicit-unlock adoption with conflict-kept draft and unchanged local override, base-change blocking and rebase, reload, verified legacy recovery, v3 export, 1920/1320/880 layouts");
}
