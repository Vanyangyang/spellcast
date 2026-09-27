import { planText as t } from "./i18n/planning";
import { fetchProjectHistory, newProjectRequestId, type CandidateAdoption, type DevelopmentObject, type ParameterCandidate, type RecordCommand,
  type RecordHistory, type RecordMutationResult, type TrialSummary } from "./project-record-api";
import { candidateBaseChanges } from "./game-flow-model";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
function button(text: string, action: () => void, name: string) {
  const node = el("button", text); node.type = "button"; node.dataset.planAction = name; node.addEventListener("click", action); return node;
}
function input(text: string, value: string, key: string, change: (value: string) => void, multiline = false) {
  const node = multiline ? el("textarea") : el("input"); node.value = value; node.dataset.planField = key;
  if (node instanceof HTMLTextAreaElement) node.rows = 3;
  node.addEventListener("input", () => change(node.value));
  const wrap = el("label"); wrap.append(el("span", text), node); return wrap;
}
const read = <T>(key: string): T | undefined => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : undefined; } catch { return undefined; } };
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const forget = (key: string) => { try { localStorage.removeItem(key); } catch { /* The saved project data is authoritative. */ } };
const when = (ms: number) => new Date(ms).toLocaleString();

export type CandidateForm = { label: string; value: string; reason: string };
export type CandidateContext = {
  projectId: string; parameter: DevelopmentObject; objects: DevelopmentObject[]; candidates: ParameterCandidate[]; adoptions: CandidateAdoption[]; trials: TrialSummary[];
  busy: boolean; editing?: string; showArchived: boolean;
  mutate(command: RecordCommand): Promise<RecordMutationResult>; setStatus(text: string): void; refresh(): Promise<void>; rerender(): void;
  edit(id?: string): void; toggleArchived(): void; tryIn(flow: DevelopmentObject, candidate: ParameterCandidate): void; adopt(candidate: ParameterCandidate): void;
};
const formKey = (projectId: string, parameterId: string, id: string) => `spellcast.planning.v1.candidate.${projectId}.${parameterId}.${id}`;
export const adoptKey = (projectId: string, parameterId: string) => `spellcast.planning.v1.adopt.${projectId}.${parameterId}`;

/** Flows whose variables read this shared parameter. */
export function flowsUsing(parameterId: string, objects: DevelopmentObject[]) {
  return objects.filter(o => o.kind === "flow" && !o.archived && o.planning?.flow?.variables.some(v => v.parameter_id === parameterId));
}

async function saveCandidate(ctx: CandidateContext, candidate: ParameterCandidate | undefined, form: CandidateForm, changes: Partial<{ archived: boolean; rebase: boolean }> = {}) {
  const parameter = ctx.parameter;
  const result = await ctx.mutate({ op: "put_candidate", request_id: newProjectRequestId(), project_id: ctx.projectId, id: candidate?.id || crypto.randomUUID(),
    expected_revision: candidate?.revision || 0, parameter_id: parameter.id, label: form.label.trim(), value: form.value.trim(), reason: form.reason,
    base_revision: !candidate || changes.rebase ? parameter.revision : candidate.base.revision, archived: changes.archived ?? candidate?.archived ?? false,
    ...(candidate?.from_variant ? { from_variant: candidate.from_variant } : {}) });
  if (!result.candidate) throw new Error("候选保存结果缺失");
  return result.candidate;
}

/** Candidates live beside the parameter. Creating one needs no unlock and never changes the parameter. */
export function renderCandidates(ctx: CandidateContext): HTMLElement {
  const { parameter, objects } = ctx, definition = parameter.planning!.parameter!;
  const box = el("section", "", "plan-section plan-candidates"); box.dataset.planCandidates = "true";
  box.append(el("h3", t("candidateTitle")), el("small", t("candidateHelp")));
  const values = el("div", "", "plan-candidate-values");
  const consumers = objects.filter(o => o.planning?.links.some(l => l.target_id === parameter.id && l.relation === "uses"));
  values.append(el("p", `${t("sharedCurrent")}: ${definition.value || t("undecided")} ${definition.unit} · ${t("revision")} ${parameter.revision}`));
  const locals = consumers.flatMap(o => o.planning!.links.filter(l => l.target_id === parameter.id && l.local).map(l => `${o.name}: ${l.local!.value} (${l.local!.reason})`));
  values.append(el("p", `${t("localOverrides")}: ${locals.join(" · ") || t("noLocalOverrides")}`));
  box.append(values);
  const own = ctx.candidates.filter(c => c.parameter_id === parameter.id), shown = own.filter(c => ctx.showArchived || !c.archived);
  const flows = flowsUsing(parameter.id, objects);
  if (!shown.length) box.append(el("p", t("noCandidates")));
  for (const candidate of shown) {
    const card = el("article", "", "plan-candidate"); card.dataset.planCandidate = candidate.id; card.dataset.archived = String(candidate.archived);
    const changes = candidateBaseChanges(candidate, parameter), adopted = ctx.adoptions.filter(a => a.candidate.id === candidate.id);
    card.append(el("strong", `${candidate.label} · ${candidate.value} ${definition.unit}`.trim()), el("small", `${t("candidateBase")}: ${t("parameterRevision")} ${candidate.base.revision} = ${candidate.base.value || t("undecided")} · ${t("candidateRevision")} ${candidate.revision}${candidate.archived ? ` · ${t("archived")}` : ""}${candidate.from_variant ? ` · ${t("fromVariant")} ${candidate.from_variant}` : ""}`));
    if (candidate.reason) card.append(el("p", candidate.reason, "plan-read-text"));
    const base = el("p", changes.length ? `${t("baseChanged")}: ${changes.join("；")}` : t("baseSame"), changes.length ? "plan-conflict" : "plan-candidate-ok"); base.dataset.baseChanged = String(changes.length > 0);
    card.append(base);
    for (const adoption of adopted) card.append(el("small", `${t("adoptedAt")} ${when(adoption.at_ms)} · ${adoption.value_before || t("undecided")} → ${adoption.value_after} · ${adoption.reason}`));
    if (ctx.editing === candidate.id) card.append(renderForm(ctx, candidate));
    else {
      const bar = el("div", "", "plan-read-actions");
      const edit = button(t("edit"), () => ctx.edit(candidate.id), "edit-candidate");
      const archive = button(candidate.archived ? t("restoreCandidate") : t("archiveCandidate"), () => void run(ctx, async () => { await saveCandidate(ctx, candidate, candidate, { archived: !candidate.archived }); }), "archive-candidate");
      bar.append(edit, archive);
      if (changes.length) bar.append(button(t("rebaseCandidate"), () => void run(ctx, async () => { await saveCandidate(ctx, candidate, candidate, { rebase: true }); }), "rebase-candidate"));
      if (!candidate.archived) {
        for (const flow of flows) { const go = button(`${t("tryCandidate")} · ${flow.name}`, () => ctx.tryIn(flow, candidate), "try-candidate"); go.dataset.flowId = flow.id; bar.append(go); }
        const adopt = button(t("adoptCandidate"), () => ctx.adopt(candidate), "adopt-candidate"); bar.append(adopt);
      }
      for (const control of bar.querySelectorAll("button")) control.disabled = ctx.busy;
      card.append(bar);
      const history = el("details", "", "plan-candidate-history"); history.append(el("summary", t("candidateHistory")));
      history.addEventListener("toggle", () => { if (history.open && history.childElementCount === 1) void loadHistory(ctx, candidate, history); }, { once: false });
      card.append(history);
    }
    box.append(card);
  }
  if (ctx.editing === "new") box.append(renderForm(ctx));
  else { const create = button(t("newCandidate"), () => ctx.edit("new"), "new-candidate"); create.disabled = ctx.busy || parameter.archived; box.append(create); }
  if (own.some(c => c.archived)) {
    const toggle = el("label", "", "plan-check"), check = el("input"); check.type = "checkbox"; check.checked = ctx.showArchived; check.addEventListener("change", ctx.toggleArchived);
    toggle.append(check, el("span", t("showArchivedCandidates"))); box.append(toggle);
  }
  if (!flows.length) box.append(el("small", t("noTrialUse")));
  if (definition.variants.length) {
    const legacy = el("section", "", "plan-legacy-variants"); legacy.append(el("h4", t("legacyVariants")));
    for (const variant of definition.variants) {
      const row = el("div", "", "plan-read-link"), done = own.some(c => c.from_variant === variant.label);
      row.append(el("span", `${variant.label}: ${variant.value}${variant.reason ? ` · ${variant.reason}` : ""}`));
      if (done) row.append(el("small", t("converted")));
      else {
        const convert = button(t("convertVariant"), () => void run(ctx, async () => {
          const result = await ctx.mutate({ op: "put_candidate", request_id: newProjectRequestId(), project_id: ctx.projectId, id: crypto.randomUUID(), expected_revision: 0, parameter_id: parameter.id,
            label: variant.label, value: variant.value, reason: variant.reason, base_revision: parameter.revision, archived: false, from_variant: variant.label });
          if (!result.candidate) throw new Error("候选保存结果缺失");
        }), "convert-variant");
        convert.disabled = ctx.busy; row.append(convert);
      }
      legacy.append(row);
    }
    box.append(legacy);
  }
  const records = ctx.adoptions.filter(a => a.parameter_id === parameter.id);
  if (records.length) {
    const log = el("section", "", "plan-adoptions"); log.dataset.planAdoptions = "true"; log.append(el("h4", t("adoptions")));
    for (const adoption of [...records].reverse()) log.append(el("p", `${when(adoption.at_ms)} · ${t("revision")} ${adoption.parameter_revision_before} → ${adoption.parameter_revision_after} · ${adoption.value_before || t("undecided")} → ${adoption.value_after} · ${adoption.candidate.label} (${t("revision")} ${adoption.candidate.revision}) · ${adoption.reason}${adoption.trial_ids.length ? ` · ${t("adoptEvidence")}: ${adoption.trial_ids.map(id => id.slice(0, 8)).join(", ")}` : ""}`, "plan-read-text"));
    box.append(log);
  }
  return box;
}

async function run(ctx: CandidateContext, work: () => Promise<void>) {
  try { await work(); ctx.edit(undefined); await ctx.refresh(); ctx.setStatus(t("saved")); }
  catch (error) { await ctx.refresh(); ctx.setStatus(`${t("error")}: ${String(error)} · ${t("draftKept")}`); }
}

function renderForm(ctx: CandidateContext, candidate?: ParameterCandidate): HTMLElement {
  const storage = formKey(ctx.projectId, ctx.parameter.id, candidate?.id || "new");
  const form: CandidateForm = read<CandidateForm>(storage) || { label: candidate?.label || "", value: candidate?.value || "", reason: candidate?.reason || "" };
  const box = el("div", "", "plan-candidate-form"); box.dataset.planCandidateForm = candidate?.id || "new";
  const keep = () => write(storage, form);
  box.append(input(t("candidate"), form.label, "candidate-label", value => { form.label = value; keep(); }),
    input(t("candidateValue"), form.value, "candidate-value", value => { form.value = value; keep(); }),
    input(t("candidateReason"), form.reason, "candidate-reason", value => { form.reason = value; keep(); }, true));
  const bar = el("div", "", "plan-read-actions");
  const save = button(t("saveCandidate"), () => void run(ctx, async () => {
    if (!form.label.trim() || !form.value.trim()) throw new Error(t("candidateRequired"));
    await saveCandidate(ctx, candidate, form); forget(storage);
  }), "save-candidate");
  save.disabled = ctx.busy;
  bar.append(save, button(t("cancel"), () => { forget(storage); ctx.edit(undefined); }, "cancel-candidate"));
  box.append(bar);
  return box;
}

async function loadHistory(ctx: CandidateContext, candidate: ParameterCandidate, box: HTMLElement) {
  try {
    const entries: RecordHistory[] = await fetchProjectHistory(ctx.projectId, "candidate", candidate.id);
    for (const entry of [...entries].reverse()) {
      const snapshot = entry.snapshot as ParameterCandidate;
      box.append(el("p", `${t("revision")} ${entry.revision} · ${when(entry.at_ms)} · ${snapshot.label}: ${snapshot.value} · ${t("candidateBase")} ${snapshot.base.revision} (${snapshot.base.value || t("undecided")})${snapshot.archived ? ` · ${t("archived")}` : ""}${snapshot.reason ? ` · ${snapshot.reason}` : ""}`, "plan-read-text"));
    }
  } catch (error) { box.append(el("p", `${t("error")}: ${String(error)}`, "plan-conflict")); }
}

export type AdoptDraft = { parameterId: string; candidateId: string; trialIds: string[]; reason: string; pending?: { fingerprint: string; request_id: string; adoption_id: string } };
export type AdoptContext = {
  projectId: string; parameter: DevelopmentObject; candidate: ParameterCandidate | undefined; objects: DevelopmentObject[]; trials: TrialSummary[]; busy: boolean; draft: AdoptDraft;
  keep(): void; rerender(): void; back(): void; viewTrial(id: string, flowId: string): void; unlock(): Promise<boolean>; rebase(): Promise<void>; confirm(): Promise<void>;
};

/**
 * Shows exactly what adoption would change: one shared value, its base, where it is inherited
 * and which local overrides stay. Requires an explicit unlock and a written reason.
 */
export function renderAdoption(ctx: AdoptContext): HTMLElement {
  const { parameter, candidate, draft } = ctx, definition = parameter.planning!.parameter!;
  const box = el("section", "", "plan-adopt"); box.dataset.planAdopt = parameter.id;
  const top = el("header", "", "plan-read-top");
  top.append(el("small", `${t("adoptTitle")} · ${t("parameter")}`), el("h2", parameter.name), button(t("adoptBack"), ctx.back, "adopt-back"));
  box.append(top);
  if (!candidate) { box.append(el("p", t("adoptMissing"), "plan-conflict")); return box; }
  const changes = candidateBaseChanges(candidate, parameter), locked = !!parameter.planning?.locked;
  const summary = el("section", "", "plan-section plan-adopt-summary");
  summary.append(el("h3", t("adoptChange")), el("p", `${definition.value || t("undecided")} → ${candidate.value} ${definition.unit}`.trim(), "plan-adopt-value"),
    el("small", `${t("adoptTarget")}: ${parameter.name} · ${t("revision")} ${parameter.revision} · ${t(locked ? "locked" : "unlocked")}`),
    el("small", `${t("candidate")}: ${candidate.label} · ${t("candidateRevision")} ${candidate.revision}${candidate.reason ? ` · ${candidate.reason}` : ""}`));
  const base = el("p", changes.length ? `${t("adoptBaseBlocked")} ${changes.join("；")}` : `${t("candidateBase")}: ${t("parameterRevision")} ${candidate.base.revision} = ${candidate.base.value || t("undecided")} · ${t("baseSame")}`, changes.length ? "plan-conflict" : "plan-candidate-ok");
  base.dataset.baseChanged = String(changes.length > 0); summary.append(base);
  if (changes.length) { const rebase = button(t("rebaseCandidate"), () => void ctx.rebase(), "adopt-rebase"); rebase.disabled = ctx.busy; summary.append(rebase); }
  box.append(summary);
  const impact = el("section", "", "plan-section plan-adopt-impact"); impact.append(el("h3", t("adoptImpact")));
  const users = ctx.objects.filter(o => !o.archived && o.planning?.links.some(l => l.target_id === parameter.id && l.relation === "uses"));
  if (!users.length) impact.append(el("p", t("noImpact")));
  for (const user of users) {
    const link = user.planning!.links.find(l => l.target_id === parameter.id && l.relation === "uses")!;
    const row = el("p", link.local ? `${user.name} · ${t("adoptLocalKept")}: ${link.local.value} (${link.local.reason})` : `${user.name} · ${t("adoptInherited")}: ${candidate.value} ${definition.unit}`.trim());
    row.dataset.adoptImpact = link.local ? "local" : "inherited"; impact.append(row);
  }
  box.append(impact);
  const evidence = el("section", "", "plan-section plan-adopt-evidence"); evidence.dataset.planAdoptEvidence = "true";
  evidence.append(el("h3", t("adoptEvidence")), el("small", t("adoptEvidenceHelp")));
  const usable = ctx.trials.filter(trial => trial.parameter_ids.includes(parameter.id));
  if (!usable.length) evidence.append(el("p", t("adoptNoTrials")));
  const noSelected = el("p", t("adoptWithoutTrials"), "plan-conflict"); noSelected.hidden = !!draft.trialIds.length; evidence.append(noSelected);
  for (const trial of usable) {
    const line = el("div", "", "plan-read-link"), row = el("label", "", "plan-check"), check = el("input"); check.type = "checkbox"; check.checked = draft.trialIds.includes(trial.id); check.dataset.adoptTrial = trial.id;
    check.addEventListener("change", () => { draft.trialIds = check.checked ? [...new Set([...draft.trialIds, trial.id])] : draft.trialIds.filter(id => id !== trial.id); noSelected.hidden = !!draft.trialIds.length; ctx.keep(); });
    const used = trial.candidates.find(c => c.parameter_id === parameter.id);
    row.append(check, el("span", `${when(trial.created_at_ms)} · ${trial.flow_name}${trial.label ? ` · ${trial.label}` : ""} · ${trial.event_count} · ${used ? `${t("usedCandidate")} ${used.label} = ${used.value} (${t("candidateRevision")} ${used.revision})${used.id === candidate.id && used.revision === candidate.revision ? ` ✓` : ""}` : t("noCandidateUsed")}${trial.assumption_count ? ` · ${t("adoptAssumption")}` : ""}`));
    const view = button(t("viewTrialSources"), () => ctx.viewTrial(trial.id, trial.flow_id), "view-trial-sources"); view.dataset.trialId = trial.id;
    line.append(row, view); evidence.append(line);
  }
  box.append(evidence);
  const reason = el("section", "", "plan-section"); reason.append(input(t("adoptReason"), draft.reason, "adopt-reason", value => { draft.reason = value; ctx.keep(); confirm.disabled = !ready(); }, true));
  box.append(reason);
  const bar = el("div", "", "plan-save-bar");
  const ready = () => !ctx.busy && !locked && !changes.length && !!draft.reason.trim() && !candidate.archived;
  if (locked) {
    bar.append(el("p", t("adoptLocked")));
    const unlock = button(t("adoptUnlock"), () => void ctx.unlock().then(ok => { if (ok) ctx.rerender(); }), "adopt-unlock"); unlock.disabled = ctx.busy; bar.append(unlock);
  }
  const confirm = button(t("adoptConfirm"), () => void ctx.confirm(), "adopt-confirm"); confirm.classList.add("primary"); confirm.disabled = !ready();
  bar.append(confirm);
  box.append(bar);
  return box;
}

/** Stable retry identity for the same adoption body. */
export function adoptionCommand(ctx: { projectId: string; parameter: DevelopmentObject; candidate: ParameterCandidate; draft: AdoptDraft }): RecordCommand {
  const body = { parameter_id: ctx.parameter.id, expected_revision: ctx.parameter.revision, candidate_id: ctx.candidate.id, candidate_revision: ctx.candidate.revision,
    trial_ids: [...ctx.draft.trialIds].sort(), reason: ctx.draft.reason.trim(), lock_after: true };
  const fingerprint = JSON.stringify(body);
  if (ctx.draft.pending?.fingerprint !== fingerprint) ctx.draft.pending = { fingerprint, request_id: newProjectRequestId(), adoption_id: crypto.randomUUID() };
  return { op: "adopt_candidate", project_id: ctx.projectId, request_id: ctx.draft.pending.request_id, adoption_id: ctx.draft.pending.adoption_id, ...body };
}
export { read as readAdoptDraft, write as writeAdoptDraft, forget as forgetAdoptDraft };
