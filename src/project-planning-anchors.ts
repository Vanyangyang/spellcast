import { planText as t } from "./i18n/planning";
import type { DevelopmentObject } from "./project-record-api";
import { anchorProblem, cleanAnchor, HOOK_PHASES, type FlowAnchor, type HookPhase, type PlanningFields } from "./project-planning-model";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
function button(text: string, action: () => void, name: string) {
  const node = el("button", text); node.type = "button"; node.dataset.planAction = name; node.addEventListener("click", action); return node;
}
function field(text: string, control: HTMLElement) { const node = el("label"); node.append(el("span", text), control); return node; }
function select(values: Array<[string, string]>, value: string, key: string, change: (value: string) => void) {
  const node = el("select"); node.dataset.planField = key;
  for (const [id, text] of values) { const option = el("option", text); option.value = id; node.append(option); }
  node.value = value; node.addEventListener("change", () => change(node.value)); return node;
}
const flowsWithSteps = (objects: DevelopmentObject[]) => objects.filter(o => o.kind === "flow" && o.planning?.flow?.steps.length && (!o.archived));
export const phaseText = (phase?: string) => phase ? t(`phase_${phase}` as "phase_cue") : t("phaseNone");

/** Describes a saved anchor with the live flow names. Missing positions stay visible. */
export function anchorText(anchor: FlowAnchor, objects: DevelopmentObject[]) {
  const flow = objects.find(o => o.id === anchor.flow_id), step = flow?.planning?.flow?.steps.find(s => s.id === anchor.step_id);
  const choice = step?.choices.find(c => c.id === anchor.choice_id);
  return `${flow?.name || anchor.flow_id} · ${step?.title || anchor.step_id}${anchor.choice_id ? ` · ${choice?.label || anchor.choice_id}` : ""}${anchor.phase ? ` · ${phaseText(anchor.phase)}` : ""}`;
}

/** Edits positions owned by this content, rule or hook. The referenced flow is never written. */
export function renderAnchorEditor(fields: PlanningFields, kind: string, objects: DevelopmentObject[], changed: () => void, rerender: () => void): HTMLElement {
  const box = el("section", "", "plan-section plan-anchors"); box.dataset.planAnchors = "true";
  box.append(el("h3", t("flowPositions")), el("small", t("flowPositionsHelp")));
  const flows = flowsWithSteps(objects), anchors = fields.anchors || [];
  const commit = () => { const clean = anchors.map(cleanAnchor); if (clean.length) fields.anchors = clean; else delete fields.anchors; changed(); };
  for (const [index, anchor] of anchors.entries()) {
    const row = el("div", "", "plan-anchor"); row.dataset.planAnchor = String(index);
    const flow = objects.find(o => o.id === anchor.flow_id), steps = flow?.planning?.flow?.steps || [], step = steps.find(s => s.id === anchor.step_id);
    const grid = el("div", "", "plan-anchor-grid");
    grid.append(field(t("anchorFlow"), select([...(flow && !flows.includes(flow) ? [[flow.id, flow.name] as [string, string]] : []), ...flows.map(f => [f.id, f.name] as [string, string])], anchor.flow_id, `anchor-flow-${index}`, value => {
      const next = objects.find(o => o.id === value)?.planning?.flow; anchors[index] = { flow_id: value, step_id: next?.entry || next?.steps[0]?.id || "", phase: anchor.phase, note: anchor.note }; commit(); rerender();
    })), field(t("anchorStep"), select([...(!step && anchor.step_id ? [[anchor.step_id, `${anchor.step_id} · ${t("anchorProblem")}`] as [string, string]] : []), ...steps.map(s => [s.id, s.title] as [string, string])], anchor.step_id, `anchor-step-${index}`, value => {
      anchors[index] = { ...anchor, step_id: value, choice_id: undefined }; commit(); rerender();
    })), field(t("anchorChoice"), select([["", t("anchorWholeStep")], ...(step?.choices || []).map(c => [c.id, c.label] as [string, string])], anchor.choice_id || "", `anchor-choice-${index}`, value => {
      anchors[index] = { ...anchor, choice_id: value || undefined }; commit(); rerender();
    })));
    if (kind === "hook") grid.append(field(t("anchorPhase"), select([["", t("phaseNone")], ...HOOK_PHASES.map(p => [p, phaseText(p)] as [string, string])], anchor.phase || "", `anchor-phase-${index}`, value => {
      anchors[index] = { ...anchor, phase: (value || undefined) as HookPhase | undefined }; commit();
    })));
    const note = el("input"); note.value = anchor.note || ""; note.dataset.planField = `anchor-note-${index}`;
    note.addEventListener("input", () => { anchors[index] = { ...anchors[index], note: note.value }; commit(); });
    grid.append(field(t("anchorNote"), note));
    row.append(grid);
    const problem = anchorProblem(anchor, objects); if (problem) row.append(el("p", `${t("anchorProblem")}：${problem}`, "plan-conflict"));
    row.append(button(t("remove"), () => { anchors.splice(index, 1); commit(); rerender(); }, "remove-anchor"));
    box.append(row);
  }
  const add = button(t("addAnchor"), () => {
    const first = flows[0]!.planning!.flow!; anchors.push({ flow_id: flows[0].id, step_id: first.entry || first.steps[0].id }); fields.anchors = anchors; commit(); rerender();
  }, "add-anchor");
  add.disabled = !flows.length || anchors.length >= 32; box.append(add);
  if (!flows.length) box.append(el("small", t("noFlows")));
  else if (!anchors.length) box.append(el("small", t("noAnchors")));
  return box;
}

export function renderAnchorRead(fields: PlanningFields, objects: DevelopmentObject[], open: (anchor: FlowAnchor) => void): HTMLElement {
  const box = el("section", "", "plan-section plan-anchors"); box.dataset.planAnchorsRead = "true";
  box.append(el("h3", t("flowPositions")));
  if (!fields.anchors?.length) { box.append(el("p", t("noAnchors"))); return box; }
  for (const [index, anchor] of fields.anchors.entries()) {
    const row = el("div", "", "plan-read-link"); row.dataset.planAnchor = String(index);
    row.append(el("strong", anchorText(anchor, objects)));
    if (anchor.note) row.append(el("p", anchor.note, "plan-read-text"));
    const problem = anchorProblem(anchor, objects);
    if (problem) row.append(el("p", `${t("anchorProblem")}：${problem}`, "plan-conflict"));
    else row.append(button(t("openInFlow"), () => open(anchor), "open-anchor"));
    box.append(row);
  }
  return box;
}
