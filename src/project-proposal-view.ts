import { gh, type GameHomeKey } from "./i18n/game-home";
import { currentLocale } from "./i18n";
import type { DevelopmentObject, RecordFields, WorkRecord } from "./project-record-api";
import type { PlanningFields } from "./project-planning-model";
import { decideProposal, returnFeedback, type Decision, type ProjectProposal, type ProposalItem, type ProposalMutation, type ProposedObject } from "./project-game-home-api";

type Context = {
  projectId: string;
  objects: DevelopmentObject[];
  records: WorkRecord[];
  busy(): boolean;
  setBusy(value: boolean): void;
  decided(result: ProposalMutation, message: string): void;
  /** Label of the author task when it is still bound, for honest return feedback. */
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
};
function button(text: string, action: () => void, name = "", className = "") {
  const node = el("button", text, className); node.type = "button"; if (name) node.dataset.proposalAction = name;
  node.addEventListener("click", action); return node;
}
export function badge(text: string, tone = "") { return el("span", text, `gh-badge ${tone}`.trim()); }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (value: string, length = 8) => value.length > length ? value.slice(0, length) : value;
const time = (ms: number) => new Date(ms).toLocaleString(currentLocale() as string, { dateStyle: "short", timeStyle: "short" });
const basisKey: Record<string, GameHomeKey> = { config: "basisConfig", design: "basisDesign", code: "basisCode", inference: "basisInference" };
const basisTone: Record<string, string> = { config: "config", design: "design", code: "code", inference: "inference" };
export function kindLabel(kind: string) { const key = `kind_${kind}` as GameHomeKey; return ["content", "rule", "hook", "parameter", "flow", "system"].includes(kind) ? gh(key) : kind; }

function planningText(planning?: PlanningFields): string {
  if (!planning) return "";
  const parts: string[] = [];
  if (planning.sections?.length) parts.push(...planning.sections.map(section => section.text));
  else if (planning.body) parts.push(planning.body);
  if (planning.rule) parts.push(...[planning.rule.trigger, planning.rule.condition, planning.rule.effect].filter(Boolean));
  if (planning.hook) parts.push(...[planning.hook.cue, planning.hook.action, planning.hook.payoff, planning.hook.continuation].filter(Boolean));
  if (planning.parameter) parts.push([planning.parameter.value, planning.parameter.unit].filter(Boolean).join(" ") + (planning.parameter.min || planning.parameter.max ? ` [${planning.parameter.min || "…"}, ${planning.parameter.max || "…"}]` : ""));
  if (planning.flow) parts.push(planning.flow.steps.map(step => step.title).join(" → "));
  return parts.filter(Boolean).join("\n\n");
}

function planningDetails(planning: PlanningFields, objects: DevelopmentObject[]): HTMLElement {
  const box = el("div", "", "gh-proposal-content");
  const text = planningText(planning);
  if (text) box.append(el("p", text, "gh-prose"));
  const meta = el("div", "", "gh-inline");
  meta.append(badge(planning.scopes.join(" / ")));
  for (const link of planning.links) {
    const target = objects.find(object => object.id === link.target_id)?.name || link.target_id;
    meta.append(badge(`${link.relation} → ${target}`));
  }
  box.append(meta);
  return box;
}

function recordDetails(fields: RecordFields): HTMLElement {
  const box = el("div", "", "gh-proposal-content");
  box.append(el("strong", fields.title));
  for (const value of [fields.goal, fields.scope, fields.next_step]) if (value) box.append(el("p", value, "gh-prose"));
  if (fields.boundaries) box.append(el("small", fields.boundaries));
  return box;
}

/** Why an adopt would be refused, so the user sees it before pressing the button. */
function targetState(item: ProposalItem, context: Context): { kind: "ok" | "locked" | "stale" | "exists"; text?: string } {
  if (item.target === "object") {
    const current = context.objects.find(object => object.id === item.target_id);
    const name = item.object?.name || item.target_id;
    if (item.base_revision === 0 && current) return { kind: "exists", text: gh("existsTarget", { name }) };
    if (item.base_revision > 0 && current && current.revision !== item.base_revision) return { kind: "stale", text: gh("staleTarget", { base: item.base_revision, current: current.revision }) };
    if (current?.planning?.locked) return { kind: "locked", text: gh("lockedTarget", { name: current.name }) };
  } else {
    const current = context.records.find(record => record.id === item.target_id);
    const name = item.record?.title || item.target_id;
    if (item.base_revision === 0 && current) return { kind: "exists", text: gh("existsTarget", { name }) };
    if (item.base_revision > 0 && current && current.revision !== item.base_revision) return { kind: "stale", text: gh("staleTarget", { base: item.base_revision, current: current.revision }) };
  }
  return { kind: "ok" };
}

function editor(item: ProposalItem): { element: HTMLElement; value(): { object?: ProposedObject; record?: RecordFields } } {
  const form = el("div", "", "gh-proposal-editor"); form.dataset.proposalEditor = item.id;
  const field = (label: string, value: string, multiline = true) => {
    const wrap = el("label"); const control = multiline ? el("textarea") : el("input");
    control.value = value; if (control instanceof HTMLTextAreaElement) control.rows = Math.min(8, Math.max(3, value.split("\n").length + 1));
    wrap.append(el("span", label), control); form.append(wrap); return control;
  };
  if (item.target === "record" && item.record) {
    const record = structuredClone(item.record);
    const title = field(gh("nameField"), record.title, false), goal = field("goal", record.goal || ""), next = field("next_step", record.next_step || ""), bounds = field(gh("boundaries"), record.boundaries || "");
    return { element: form, value: () => ({ record: { ...record, title: title.value.trim(), goal: goal.value, next_step: next.value, boundaries: bounds.value } }) };
  }
  const object = structuredClone(item.object!);
  const name = field(gh("nameField"), object.name, false);
  const planning = object.planning;
  const reads: Array<() => void> = [];
  if (planning.sections?.length) planning.sections.forEach((section, index) => { const control = field(`${gh("textField")} ${index + 1} · ${section.role || "body"}`, section.text); reads.push(() => { planning.sections![index].text = control.value; }); });
  else if (planning.body || !(planning.rule || planning.hook || planning.parameter)) { const control = field(gh("textField"), planning.body || ""); reads.push(() => { planning.body = control.value; }); }
  if (planning.rule) for (const key of ["trigger", "condition", "effect"] as const) { const control = field(key, planning.rule[key] || ""); reads.push(() => { planning.rule![key] = control.value; }); }
  if (planning.hook) for (const key of ["cue", "action", "payoff", "continuation"] as const) { const control = field(key, planning.hook[key] || ""); reads.push(() => { planning.hook![key] = control.value; }); }
  if (planning.parameter) for (const key of ["value", "min", "max", "unit"] as const) { const control = field(key === "value" ? gh("valueField") : key, planning.parameter[key] || "", false); reads.push(() => { planning.parameter![key] = control.value.trim(); }); }
  return { element: form, value: () => { reads.forEach(read => read()); return { object: { ...object, name: name.value.trim(), planning } }; } };
}

export function proposalCounts(proposal: ProjectProposal) {
  const count = (status: string) => proposal.items.filter(item => item.status === status).length;
  return { pending: count("pending"), adopted: count("adopted"), returned: count("returned"), dismissed: count("dismissed") };
}

export function subjectLabel(proposal: ProjectProposal) {
  const subject = proposal.subject || { scale: "" };
  return [subject.scale ? gh(subject.scale === "overview" ? "scaleOverview" : subject.scale === "experience" ? "scaleExperience" : "scaleObject") : "", subject.zone_id, subject.location_id || subject.entity_id].filter(Boolean).join(" · ");
}

/** A compact entry for lists; `open` shows the full review. */
/** Only an Agent-authored proposal is AI inference; a user draft says so. */
function authorBadge(proposal: ProjectProposal) { return proposal.created_by.kind === "agent" ? badge(gh("inferenceBadge"), "inference") : badge(gh("userDraft")); }

export function renderProposalCard(proposal: ProjectProposal, open: () => void): HTMLElement {
  const card = el("article", "", "gh-proposal-card"); card.dataset.proposalCard = proposal.id;
  const counts = proposalCounts(proposal);
  const head = el("header"); head.append(el("strong", proposal.title), authorBadge(proposal));
  card.append(head, el("small", [subjectLabel(proposal), gh("proposalBy", { author: proposal.created_by.label || proposal.created_by.kind, time: time(proposal.updated_at_ms) })].filter(Boolean).join(" · ")),
    el("small", gh("proposalItems", counts)), button(gh("viewProposal"), open, "open", counts.pending || counts.returned ? "primary" : ""));
  return card;
}

/** The full review: every item with its sources, reasons and boundaries, and the user's decisions. */
export function renderProposalReview(proposal: ProjectProposal, context: Context): HTMLElement {
  const root = el("section", "", "gh-proposal-review"); root.dataset.proposalReview = proposal.id;
  const alert = el("p", "", "gh-alert"); alert.setAttribute("role", "alert"); alert.hidden = true;
  const selected = new Set<string>();
  const fail = (error: unknown) => { alert.textContent = message(error); alert.hidden = false; };
  async function run(decision: Decision, after?: (result: ProposalMutation) => Promise<string | void>) {
    if (context.busy()) return;
    context.setBusy(true); alert.hidden = true;
    try {
      const result = await decideProposal(context.projectId, proposal, decision);
      const text = (after && await after(result)) || (result.proposal?.status === "closed" ? gh("proposalClosed") : gh("decisionSaved"));
      context.decided(result, text);
    } catch (error) { fail(error); }
    finally { context.setBusy(false); }
  }
  const head = el("header", "", "gh-proposal-head");
  head.append(el("h3", proposal.title), authorBadge(proposal));
  root.append(head, el("small", [subjectLabel(proposal), gh("proposalBy", { author: proposal.created_by.label || proposal.created_by.kind, time: time(proposal.updated_at_ms) }), `rev ${proposal.revision}`].filter(Boolean).join(" · ")));
  if (proposal.summary) root.append(el("p", proposal.summary, "gh-prose"));
  if (proposal.boundaries) root.append(el("p", `${gh("boundaries")}：${proposal.boundaries}`, "gh-boundary"));
  root.append(alert);
  const list = el("div", "", "gh-proposal-items");
  for (const item of proposal.items) list.append(renderItem(item));
  root.append(list);
  const open = proposal.items.filter(item => item.status === "pending" || item.status === "returned");
  if (open.length > 1) {
    const bulk = button(gh("adoptSelected"), () => { if (selected.size) void run({ decision: "adopt", itemIds: proposal.items.filter(item => selected.has(item.id)).map(item => item.id), confirm: true }); }, "adopt-selected", "primary");
    bulk.disabled = true; bulk.dataset.bulk = "true";
    root.append(bulk);
  }
  if (proposal.references.length) root.append(references(proposal.references));
  return root;

  function renderItem(item: ProposalItem): HTMLElement {
    const card = el("article", "", "gh-proposal-item"); card.dataset.proposalItem = item.id; card.dataset.status = item.status;
    const title = item.target === "object" ? item.object?.name || item.target_id : item.record?.title || item.target_id;
    const top = el("header");
    top.append(badge(item.target === "object" ? `${gh("itemObject")} · ${kindLabel(item.object?.kind || "")}` : gh("itemRecord")), el("strong", title),
      badge(item.base_revision ? gh("update", { base: item.base_revision }) : gh("create")));
    for (const basis of item.basis) top.append(badge(gh(basisKey[basis] || "basisInference"), basisTone[basis] || "inference"));
    card.append(top);
    const state = targetState(item, context);
    const current = item.target === "object" ? context.objects.find(object => object.id === item.target_id) : undefined;
    if (item.target === "object" && item.object) {
      if (current && item.base_revision) {
        const compare = el("div", "", "gh-compare");
        const left = el("div"); left.append(el("small", `${gh("current")} v${current.revision}`), el("strong", current.name), el("p", planningText(current.planning) || "—", "gh-prose"));
        const right = el("div"); right.append(el("small", gh("proposed")), el("strong", item.object.name), el("p", planningText(item.object.planning) || "—", "gh-prose"));
        compare.append(left, right); card.append(compare);
      } else card.append(planningDetails(item.object.planning, context.objects));
    } else if (item.record) card.append(recordDetails(item.record));
    if (item.reason) card.append(el("p", `${gh("reason")}：${item.reason}`, "gh-reason"));
    if (item.boundaries) card.append(el("p", `${gh("boundaries")}：${item.boundaries}`, "gh-boundary"));
    if (item.references.length) card.append(references(item.references));
    if (item.edited_by) card.append(el("small", gh("edited")));
    if (item.decision && item.status !== "pending") {
      const decision = item.decision;
      const text = item.status === "adopted" ? gh(decision.confirmed ? "adopted" : "adoptedDraft", { revision: decision.applied_revision ?? "?" })
        : item.status === "returned" ? gh("returned", { note: decision.note }) : gh("dismissed", { note: decision.note ? `：${decision.note}` : "" });
      card.append(el("p", text, `gh-decision ${item.status}`));
    }
    if (item.status !== "pending" && item.status !== "returned") return card;
    if (state.text) card.append(el("p", state.text, "gh-warning"));
    const actions = el("div", "", "gh-actions");
    const pick = el("label", "", "gh-check"); const box = el("input"); box.type = "checkbox"; box.dataset.proposalSelect = item.id;
    box.addEventListener("change", () => { if (box.checked) selected.add(item.id); else selected.delete(item.id); const bulk = root.querySelector<HTMLButtonElement>("[data-bulk]"); if (bulk) bulk.disabled = !selected.size; });
    pick.append(box, el("span", gh("selectItem")));
    const locked = state.kind === "locked";
    const blocked = state.kind === "stale" || state.kind === "exists";
    const adopt = button(gh(locked ? "unlockAdopt" : "adoptConfirm"), () => void run({ decision: "adopt", itemIds: [item.id], confirm: true, unlock: locked }), locked ? "unlock-adopt" : "adopt", "primary");
    adopt.disabled = blocked;
    actions.append(pick, adopt);
    if (item.target === "object") {
      const draft = button(gh("adoptDraft"), () => void run({ decision: "adopt", itemIds: [item.id], confirm: false, unlock: locked }), "adopt-draft");
      draft.disabled = blocked; actions.append(draft);
    }
    actions.append(button(gh("edit"), () => openEditor(card, item, locked), "edit"), button(gh("returnItem"), () => openNote(card, item, "return"), "return"),
      button(gh("dismiss"), () => openNote(card, item, "dismiss"), "dismiss"));
    card.append(actions);
    return card;
  }

  function openEditor(card: HTMLElement, item: ProposalItem, locked: boolean) {
    card.querySelector(".gh-proposal-editor, .gh-note")?.remove();
    const form = editor(item);
    const actions = el("div", "", "gh-actions");
    const revised = () => { const value = form.value(); return { revisedObject: value.object, revisedRecord: value.record }; };
    actions.append(button(gh("saveEdit"), () => void run({ decision: "revise", itemIds: [item.id], ...revised() }), "save-edit"),
      button(gh("editAdopt"), () => void run({ decision: "adopt", itemIds: [item.id], confirm: true, unlock: locked, ...revised() }), "edit-adopt", "primary"),
      button(gh("cancel"), () => form.element.remove(), "cancel-edit"));
    form.element.append(actions);
    form.element.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); form.element.remove(); } });
    card.append(form.element);
    form.element.querySelector<HTMLElement>("input,textarea")?.focus();
  }

  function openNote(card: HTMLElement, item: ProposalItem, kind: "return" | "dismiss") {
    card.querySelector(".gh-proposal-editor, .gh-note")?.remove();
    const box = el("div", "", "gh-note"); box.dataset.proposalNote = kind;
    const label = el("label"); const note = el("textarea"); note.rows = 3; note.dataset.proposalNoteText = kind;
    label.append(el("span", gh(kind === "return" ? "returnNote" : "dismissNote")), note);
    const confirm = button(gh(kind === "return" ? "returnSend" : "dismiss"), () => {
      if (kind === "return" && !note.value.trim()) { note.focus(); return; }
      void run({ decision: kind, itemIds: [item.id], note: note.value.trim() }, kind === "return" ? async () => {
        const sent = await returnFeedback(context.projectId, { request_id: crypto.randomUUID(), proposal_id: proposal.id, item_ids: [item.id], note: note.value.trim() })
          .catch(error => ({ sent: false, reason: message(error) }));
        return sent.sent ? gh("returnedSent", { label: proposal.created_by.label || "Codex" }) : gh("returnedKept");
      } : undefined);
    }, kind === "return" ? "return-send" : "dismiss-confirm", "primary");
    const actions = el("div", "", "gh-actions"); actions.append(confirm, button(gh("cancel"), () => box.remove(), "cancel-note"));
    box.append(label, actions);
    box.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); box.remove(); } });
    card.append(box); note.focus();
  }
}

export function readableUri(uri: string) {
  const path = uri.replace(/^file:\/\/\/?/, "");
  try { return decodeURIComponent(path); } catch { return path; }
}

function references(items: Array<{ label: string; uri: string; version: string }>): HTMLElement {
  const box = el("details", "", "gh-references"); box.append(el("summary", `${gh("references")} · ${items.length}`));
  for (const item of items) {
    const row = el("div", "", "gh-reference");
    row.append(el("strong", item.label), el("small", readableUri(item.uri)));
    if (item.version) row.append(el("code", short(item.version, 18)));
    box.append(row);
  }
  return box;
}
