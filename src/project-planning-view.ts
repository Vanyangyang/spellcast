import { onLocale } from "./i18n";
import { planText as t } from "./i18n/planning";
import { pt } from "./i18n/projects";
import { fetchProjectAdoptions, fetchProjectCandidates, fetchProjectHistory, fetchProjectObjects, fetchProjectRecords, fetchProjectTrials, mutateProject, newProjectRequestId,
  type CandidateAdoption, type DevelopmentObject, type ParameterCandidate, type Project, type RecordHistory, type WorkRecord, type RecordFields, type TrialSummary } from "./project-record-api";
import { anchoredDesigns, emptyPlanning, PLANNING_KINDS, planningBody, planningContext, planningImpact, supportsAnchors, type PlanningFields,
  type PlanningKind, type PlanningLink } from "./project-planning-model";
import { createPlanningMap, type PlanningCreation } from "./project-planning-map";
import { createFlowEditor } from "./game-flow-editor";
import { createFlowWorkspace, type FlowFocus, type FlowReturnState } from "./game-flow-workspace";
import { blankFlow, flowDiagnostics } from "./game-flow-model";
import { designLabel } from "./game-flow-links";
import { anchorText, renderAnchorEditor, renderAnchorRead } from "./project-planning-anchors";
import { adoptionCommand, adoptKey, forgetAdoptDraft, readAdoptDraft, renderAdoption, renderCandidates, writeAdoptDraft, type AdoptDraft, type CandidateContext } from "./project-planning-candidates";
import { ct, renderContentBody, renderContentEditor, renderContentDifference, renderReferencedValues } from "./project-content";
import { renderLightText } from "./light-text";
import { dataEqual, mergeDraft, chooseLocal, type DraftConflict } from "./project-planning-drafts";
import "./project-planning.css";

type Draft = { object: DevelopmentObject & { planning: PlanningFields }; base?: DevelopmentObject; pending?: { fingerprint: string; id: string } };
type Options = { onChanged(): void; openRecord(id: string): void; createRecord(object: DevelopmentObject, fields?: Partial<RecordFields>): void; focusEditor(value: boolean): void };
const PREFIX = "spellcast.planning.v1";
const clone = <T>(value: T): T => structuredClone(value);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
function button(text: string, action: () => void, name = "") {
  const node = el("button", text); node.type = "button"; node.dataset.planAction = name;
  node.addEventListener("click", action); return node;
}
function label(text: string, control: HTMLElement) { const node = el("label"); node.append(el("span", text), control); return node; }
function select(values: Array<[string, string]>, value: string, change: (value: string) => void) {
  const node = el("select");
  for (const [id, text] of values) { const item = el("option", text); item.value = id; node.append(item); }
  node.value = value; node.addEventListener("change", () => change(node.value)); return node;
}
function check(text: string, value: boolean, change: (value: boolean) => void) {
  const node = el("input"); node.type = "checkbox"; node.checked = value;
  node.addEventListener("change", () => change(node.checked)); const wrap = label(text, node); wrap.className = "plan-check"; return wrap;
}
function read<T>(key: string): T | undefined { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : undefined; } catch { return undefined; } }
function kindName(kind: string) { return PLANNING_KINDS.includes(kind as PlanningKind) ? t(kind as PlanningKind) : kind; }
function draftKey(object: DevelopmentObject) { return `${PREFIX}.draft.${object.project_id}.${object.id}`; }
function displayValue(value?: string, unit = "") { return value?.trim() ? `${value} ${unit}`.trim() : t("undecided"); }

export function createProjectPlanningView(options: Options) {
  const element = el("section", "", "project-planning"); element.dataset.projectPlanning = "true";
  const toolbar = el("div", "", "plan-toolbar"), status = el("p", "", "plan-status"), layout = el("div", "", "plan-layout");
  const nav = el("aside", "", "plan-nav"), main = el("section", "", "plan-main");
  status.setAttribute("role", "status"); layout.append(nav, main); element.append(toolbar, status, layout);
  let project: Project | undefined, objects: DevelopmentObject[] = [], records: WorkRecord[] = [], draft: Draft | undefined;
  let scope = "", kind = "", search = "", includeArchived = false, numbers = false, focused = false, busy = false;
  let overview = true, editing = false, toolsOpen = false;
  let loaded = false;
  let flowWorkspace = false, flowSelection = "";
  // Candidates, trial summaries and adoptions are separate project data; the objects stay canonical.
  let candidates: ParameterCandidate[] = [], adoptions: CandidateAdoption[] = [], trialSummaries: TrialSummary[] = [];
  let flowFocus: FlowFocus | undefined, flowPreselect: { parameterId: string; candidateId: string } | undefined;
  let returnFlow: FlowFocus | undefined, returnFlowState: FlowReturnState | undefined, returnObject: { id: string; scroll: number } | undefined;
  let candidateEditing: string | undefined, showArchivedCandidates = false, adopting: AdoptDraft | undefined;
  let flowView: { dispose(): void } | undefined;
  let mapView: ReturnType<typeof createPlanningMap> | undefined;
  let epoch = 0, historyEpoch = 0, history: RecordHistory[] | undefined;
  let readingId: string | undefined, readingReturn: { id: string; scroll: number } | undefined;
  let mergeReview: { value: Draft["object"]; conflicts: DraftConflict[]; local: Draft["object"]; revision: number } | undefined;
  const readingKey = (id: string) => `${PREFIX}.reading.${project?.id}.${id}`;
  function keepReadingPosition() {
    if (!readingId) return;
    try { localStorage.setItem(readingKey(readingId), String(main.scrollTop)); } catch { /* View state only. */ }
  }
  function readingPosition(id: string) { try { return Math.max(0, Number(localStorage.getItem(readingKey(id))) || 0); } catch { return 0; } }
  main.addEventListener("scroll", keepReadingPosition, { passive: true });
  const drafts = new Map<string, Draft>();
  const setStatus = (text = "") => { status.textContent = text; status.hidden = !text; };
  const stateKey = () => `${PREFIX}.view.${project?.id}`;
  function remember() { try { localStorage.setItem(stateKey(), JSON.stringify({ scope, kind, numbers, overview, flowWorkspace, flowSelection, id: draft?.object.id })); } catch { /* Selection only. */ } }
  function persist(value = draft) {
    if (!value) return;
    drafts.set(draftKey(value.object), value);
    try { localStorage.setItem(draftKey(value.object), JSON.stringify(value)); setStatus(t("draftKept")); }
    catch { setStatus(t("storageFailed")); }
  }
  function forget(object: DevelopmentObject) {
    drafts.delete(draftKey(object));
    try { localStorage.removeItem(draftKey(object)); } catch { setStatus(t("storageFailed")); }
  }
  function loadDraft(object: DevelopmentObject & { planning: PlanningFields }): Draft {
    const key = draftKey(object), saved = drafts.get(key) || read<Draft>(key);
    if (saved?.object?.id === object.id && saved.object.project_id === object.project_id && saved.object.planning
      && typeof saved.object.name === "string" && Array.isArray(saved.object.planning.links)) {
      if (!saved.base && saved.object.revision === object.revision) saved.base = clone(object);
      return saved;
    }
    const normalized = clone(object);
    normalized.planning = { ...emptyPlanning(object.kind), ...normalized.planning };
    return { object: normalized, base: clone(object) };
  }
  function visible() { return objects.filter(o => o.planning && (includeArchived || !o.archived) && (!scope || o.planning.scopes.includes(scope))); }
  function current() { return objects.find(o => o.id === draft?.object.id); }
  function dirty() { const saved = current(); return !!draft && (!saved || !dataEqual(saved, draft.object)); }
  function input(text: string, value: string, change: (value: string) => void, multiline = false, key = "") {
    const node = multiline ? el("textarea") : el("input"); node.value = value; node.dataset.planField = key || text;
    if (node instanceof HTMLTextAreaElement) node.rows = 3;
    node.addEventListener("input", () => { change(node.value); persist(); }); return label(text, node);
  }
  function section(title: string) { const box = el("section", "", "plan-section"); box.append(el("h3", title)); return box; }
  function details(title: string) { const box = el("details", "", "plan-section"); box.append(el("summary", title)); return box; }
  /** `from` remembers the flow position a design was opened from, so it can be returned to. */
  function open(object: DevelopmentObject, from?: FlowFocus, flowState?: FlowReturnState) {
    if (!object.planning || busy) return;
    keepReadingPosition();
    flowWorkspace = false; adopting = undefined; candidateEditing = undefined; returnFlow = from; returnFlowState = flowState; mergeReview = undefined;
    draft = loadDraft(object as Draft["object"]); numbers = false; overview = false; editing = false; history = undefined; historyEpoch++;
    if (object.kind === "content") { focused = true; options.focusEditor(true); }
    remember(); setStatus(""); render(); main.scrollTop = readingPosition(object.id);
  }
  function newObject(context?: PlanningCreation) {
    if (!project || busy) return;
    keepReadingPosition();
    flowWorkspace = false;
    readingReturn = undefined;
    returnFlow = context?.anchor ? { flowId: context.anchor.flow_id, stepId: context.anchor.step_id, ...(context.anchor.choice_id ? { choiceId: context.anchor.choice_id } : {}) } : undefined;
    returnFlowState = undefined;
    mergeReview = undefined;
    const location = context?.kind === "content" ? encodeURIComponent(JSON.stringify({ parent: context.parent || "", anchor: context.anchor || null, scopes: context.scopes })) : "";
    const newKey = location ? `${PREFIX}.new-content.${project.id}.${location}` : `${PREFIX}.new.${project.id}`;
    const oldId = read<string>(newKey);
    const pending = oldId ? drafts.get(`${PREFIX}.draft.${project.id}.${oldId}`) || read<Draft>(`${PREFIX}.draft.${project.id}.${oldId}`) : undefined;
    if (pending && !objects.some(o => o.id === pending.object.id)) draft = pending;
    else {
      const nextKind = context?.kind || kind || "system";
      draft = { object: { id: crypto.randomUUID(), project_id: project.id, name: "", kind: nextKind, revision: 0, archived: false,
        planning: emptyPlanning(nextKind, context?.scopes || (scope ? [scope] : ["R0"])) } };
      if (nextKind === "flow") draft.object.planning.flow = blankFlow();
      if (nextKind === "content") draft.object.planning.sections = [{ id: crypto.randomUUID(), role: "body", text: "" }];
      if (context?.parent) draft.object.planning.links.push({ target_id: context.parent, relation: "belongs_to", note: "" });
      if (context?.anchor) draft.object.planning.anchors = [context.anchor];
      try { localStorage.setItem(newKey, JSON.stringify(draft.object.id)); } catch { /* Draft warning below. */ }
    }
    persist(); history = undefined; historyEpoch++; numbers = false; overview = false; editing = true; remember(); render();
    if (pending && draft === pending) setStatus(t("resumeNew"));
    (main.querySelector<HTMLTextAreaElement>('[data-content-text]') || main.querySelector<HTMLInputElement>('[data-plan-field="name"]'))?.focus();
  }
  function writeContent(context?: PlanningCreation) {
    focused = true; options.focusEditor(true);
    newObject(context || { kind: "content", scopes: scope ? [scope] : ["R0"] });
  }
  /** `from` is the object the user came from; the workspace offers a way back to it. */
  function openFlow(id = "", focus?: FlowFocus, from?: DevelopmentObject, preselect?: { parameterId: string; candidateId: string }, returnState?: FlowReturnState) {
    returnObject = from ? { id: from.id, scroll: main.scrollTop } : undefined;
    flowFocus = focus; flowPreselect = preselect; returnFlowState = returnState;
    flowWorkspace = true; flowSelection = id || flowSelection; overview = false; numbers = false; editing = false; adopting = undefined;
    focused = true; options.focusEditor(true); remember(); setStatus(""); render(); main.scrollTop = 0;
  }
  function backToObject() {
    const target = returnObject && objects.find(o => o.id === returnObject!.id), scroll = returnObject?.scroll || 0;
    returnObject = undefined; flowPreselect = undefined;
    if (target) { open(target); main.scrollTop = scroll; }
  }
  function startAdopt(candidate: ParameterCandidate, trialIds: string[] = []) {
    const parameter = objects.find(o => o.id === candidate.parameter_id);
    if (!project || busy || !parameter?.planning?.parameter) return;
    const stored = readAdoptDraft<AdoptDraft>(adoptKey(project.id, parameter.id));
    adopting = stored?.candidateId === candidate.id ? { ...stored, trialIds: [...new Set([...stored.trialIds, ...trialIds])] }
      : { parameterId: parameter.id, candidateId: candidate.id, trialIds: [...new Set(trialIds)], reason: "" };
    writeAdoptDraft(adoptKey(project.id, parameter.id), adopting);
    flowWorkspace = false; overview = false; numbers = false; editing = false; candidateEditing = undefined;
    draft = loadDraft(parameter as Draft["object"]); history = undefined; historyEpoch++;
    focused = true; options.focusEditor(true); remember(); setStatus(""); render(); main.scrollTop = 0;
  }
  async function refreshEvidence() {
    if (!project) return;
    const id = project.id;
    try {
      const [nextCandidates, nextAdoptions, nextTrials] = await Promise.all([fetchProjectCandidates(id), fetchProjectAdoptions(id), fetchProjectTrials(id)]);
      if (project?.id !== id) return;
      candidates = nextCandidates; adoptions = nextAdoptions; trialSummaries = nextTrials;
    } catch (error) { if (project?.id === id) setStatus(`${t("error")}: ${String(error)}`); }
  }
  /** One manual-tools menu instead of a flat row; the scope filter appears only where it filters. */
  function renderToolbar() {
    toolbar.replaceChildren();
    const close = (action: () => void) => () => { toolsOpen = false; action(); };
    const menu = el("details", "", "plan-tools"); menu.dataset.planTools = "true"; menu.open = toolsOpen;
    menu.addEventListener("toggle", () => { toolsOpen = menu.open; });
    menu.addEventListener("keydown", event => { if (event.key === "Escape" && menu.open) { event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector("summary")?.focus(); } });
    const current = flowWorkspace ? "流程与试走" : numbers ? t("numbers") : overview ? t("structure") : t("objects");
    const summary = el("summary", t("toolsMenu")); summary.dataset.planToolsToggle = "true";
    const panel = el("div", "", "plan-tools-menu");
    const group = (title: string, ...items: HTMLElement[]) => { const box = el("div", "", "plan-tools-group"); box.append(el("small", title), ...items); return box; };
    panel.append(
      group(t("toolsViews"),
        button(t("structure"), close(() => { flowWorkspace = false; overview = true; numbers = false; editing = false; focused = false; options.focusEditor(false); remember(); render(); main.scrollTop = 0; }), "overview"),
        button("流程与试走", close(() => openFlow()), "flows"),
        button(t("objects"), close(() => { flowWorkspace = false; overview = false; numbers = false; focused = false; options.focusEditor(false); remember(); render(); }), "editor"),
        button(t("numbers"), close(() => { flowWorkspace = false; numbers = true; overview = false; remember(); render(); }), "numbers")),
      group(t("toolsManual"), button(ct("write"), close(() => writeContent()), "write-content"), button(t("new"), close(() => newObject()), "new")),
      group(t("toolsLayout"), button(t(focused ? "showNav" : "hideNav"), close(() => { focused = !focused; options.focusEditor(focused); render(); }), "focus")));
    menu.append(summary, panel);
    toolbar.append(menu, el("strong", current, "plan-current-view"));
    if (!flowWorkspace && !editing) {
      const scopeSelect = select([["", t("all")], ...["R0", "R1", "R2"].map(v => [v, v] as [string, string])], scope,
        v => { scope = v; remember(); render(); }); scopeSelect.dataset.planScope = "true";
      toolbar.append(label(t(overview ? "overlayScope" : "scope"), scopeSelect));
    }
    toolbar.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = !project || busy || !loaded);
    element.dataset.focused = String(focused);
    element.dataset.overview = String(overview);
    element.dataset.editing = String(editing);
    element.dataset.flowWorkspace = String(flowWorkspace);
    toolbar.querySelector('[data-plan-action="overview"]')?.setAttribute("aria-pressed", String(overview));
  }
  function renderNav() {
    nav.replaceChildren();
    const searchInput = el("input"); searchInput.type = "search"; searchInput.placeholder = t("search"); searchInput.value = search;
    searchInput.setAttribute("aria-label", t("search")); searchInput.addEventListener("input", () => { search = searchInput.value; renderList(); });
    const kindSelect = select([["", t("allTypes")], ...PLANNING_KINDS.map(k => [k, t(k)] as [string, string])], kind,
      value => { kind = value; remember(); renderList(); }); kindSelect.dataset.planKindFilter = "true";
    nav.append(searchInput, label(t("kind"), kindSelect), check(t("showArchived"), includeArchived, value => { includeArchived = value; renderList(); }));
    const list = el("nav", "", "plan-object-list"); nav.append(list);
    function renderList() {
      list.replaceChildren();
      const filtered = visible().filter(o => (!kind || o.kind === kind) && `${o.name}\n${planningBody(o.planning!)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
      const pending = [...drafts.values()].filter(value => value.object.project_id === project?.id && !objects.some(o => o.id === value.object.id));
      if (pending.length) {
        list.append(el("h4", t("draft")));
        for (const value of pending) list.append(button(value.object.name || planningBody(value.object.planning).slice(0, 60) || t("new"), () => {
          keepReadingPosition(); draft = value; mergeReview = undefined; flowWorkspace = false; overview = false; numbers = false; editing = true; remember(); render();
        }, "resume-content-draft"));
      }
      if (!filtered.length && !pending.length) list.append(el("p", t("noMatches")));
      for (const k of PLANNING_KINDS) {
        const entries = filtered.filter(o => o.kind === k); if (!entries.length) continue;
        list.append(el("h4", `${t(k)} · ${entries.length}`));
        for (const object of entries) {
          const item = button(object.name, () => open(object)); item.dataset.planObject = object.id;
          item.setAttribute("aria-current", String(draft?.object.id === object.id));
          item.append(el("small", `${object.planning!.scopes.join(" / ")} · ${t(object.planning!.locked ? "locked" : "unlocked")} · ${t(object.planning!.confirmed ? "confirmed" : "unconfirmed")}${object.archived ? ` · ${t("archived")}` : ""}`));
          const parentNames = object.planning!.links.filter(l => l.relation === "belongs_to").map(l => objects.find(o => o.id === l.target_id)?.name).filter(Boolean);
          if (parentNames.length) item.append(el("small", `${t("belongs_to")} · ${parentNames.join(" / ")}`));
          list.append(item);
        }
      }
    }
    renderList();
  }
  function renderNumbers() {
    const box = section(t("numbers")); main.append(box);
    const parameters = visible().filter(o => o.kind === "parameter");
    if (!parameters.length) { box.append(el("p", t("emptyParameter"))); return; }
    const scroll = el("div", "", "plan-table-scroll"), table = el("table"), head = el("thead"), row = el("tr");
    for (const key of ["name", "value", "unit", "limits", "candidates", "independentCandidates", "usesCount", "design"] as const) row.append(el("th", t(key)));
    head.append(row); table.append(head); const body = el("tbody");
    for (const object of parameters) {
      const p = object.planning!.parameter, tr = el("tr"), name = el("td"); name.append(button(object.name, () => open(object)));
      tr.append(name, el("td", displayValue(p?.value)), el("td", p?.unit || "—"), el("td", `${p?.min || "—"} … ${p?.max || "—"}`),
        el("td", p?.variants.map(v => `${v.label}: ${v.value}`).join(" / ") || "—"),
        el("td", candidates.filter(c => c.parameter_id === object.id && !c.archived).map(c => `${c.label}: ${c.value}`).join(" / ") || "—"),
        el("td", String(planningImpact(objects, object.id).filter(v => v.depth === 1).length)), el("td", t(object.planning!.confirmed ? "confirmed" : "unconfirmed")));
      body.append(tr);
    }
    table.append(body); scroll.append(table); box.append(scroll);
  }
  function renderLinks(fields: PlanningFields) {
    const box = section(t("relations"));
    box.dataset.planLinks = "true";
    for (const [index, link] of fields.links.entries()) {
      const row = el("div", "", "plan-link"), grid = el("div", "", "plan-grid");
      const targets = objects.filter(o => o.planning && o.id !== draft!.object.id && (!o.archived || o.id === link.target_id));
      const target = objects.find(o => o.id === link.target_id), parameter = target?.planning?.parameter;
      grid.append(label(t("relation"), select((["belongs_to", "uses", "depends_on", "follows"] as const).map(k => [k, t(k)]), link.relation, v => {
        link.relation = v as PlanningLink["relation"]; if (v !== "uses") delete link.local; persist(); renderMain();
      })), label(t("target"), select([["", t("choose")], ...targets.map(o => [o.id, `${kindName(o.kind)} · ${o.name}${o.archived ? ` (${t("archived")})` : ""}`] as [string, string])], link.target_id,
        v => { link.target_id = v; delete link.local; persist(); renderMain(); })));
      row.append(grid, input(t("note"), link.note, v => { link.note = v; }, true, `link-note-${index}`));
      if (target) row.append(button(`${t("editor")} · ${target.name}`, () => open(target)));
      if (parameter && link.relation === "uses") {
        row.append(el("p", `${t("shared")}: ${displayValue(parameter.value, parameter.unit)} · ${parameter.min || "—"} … ${parameter.max || "—"}`),
          check(t("local"), !!link.local, value => { if (value) link.local = { value: parameter.value, reason: "" }; else delete link.local; persist(); renderMain(); }));
        if (link.local) row.append(input(t("value"), link.local.value, v => { link.local!.value = v; }, false, `local-value-${index}`),
          input(t("reason"), link.local.reason, v => { link.local!.reason = v; }, true, `local-reason-${index}`), el("small", t("localHelp")));
        else row.append(el("small", t("inherited")));
      }
      row.append(button(t("remove"), () => { fields.links.splice(index, 1); persist(); renderMain(); }, "remove-link")); box.append(row);
    }
    const add = button(t("addLink"), () => { fields.links.push({ target_id: "", relation: "uses", note: "" }); persist(); renderMain(); }, "add-link");
    add.disabled = fields.links.length >= 64 || !objects.some(o => o.planning && !o.archived && o.id !== draft?.object.id);
    box.append(add); if (add.disabled && !fields.links.length) box.append(el("small", t("noTarget")));
    return box;
  }
  function renderImpact(id: string) {
    const box = section(t("impact")); box.append(el("p", t("impactHelp")));
    const impacted = planningImpact(objects, id);
    if (!impacted.length) box.append(el("small", t("noImpact")));
    for (const { object, depth } of impacted) {
      const row = el("div", "", "plan-impact"); row.dataset.planImpact = object.id;
      row.append(button(`${t(depth === 1 ? "direct" : "indirect")} · ${object.name}${object.archived ? ` (${t("archived")})` : ""}`, () => open(object)));
      for (const link of object.planning!.links.filter(l => l.target_id === id)) {
        row.append(el("small", `${t(link.relation)}${link.local ? ` · ${t("localValue")}: ${link.local.value} · ${link.local.reason}` : ""}`));
      }
      for (const anchor of object.planning!.anchors?.filter(a => a.flow_id === id) || []) row.append(el("small", `${t("flowPositions")} · ${anchorText(anchor, objects)}`));
      box.append(row);
    }
    return box;
  }
  function jsonPreview(title: string, value: unknown) {
    const box = details(title); box.append(el("pre", JSON.stringify(value, null, 2))); return box;
  }
  function renderHistory() {
    const box = details(t("history")); box.dataset.planHistory = "true";
    if (!history) box.append(button(t("loadHistory"), () => { void loadHistory(); }, "history"));
    else {
      box.open = true;
      if (!history.length) box.append(el("p", t("noHistory")));
      const sorted = [...history].sort((a, b) => b.revision - a.revision);
      for (const [index, item] of sorted.entries()) {
        const title = `${t("revision")} ${item.revision} · ${new Date(item.at_ms).toLocaleString()} · ${item.actor.label}`;
        const snapshot = item.snapshot as DevelopmentObject;
        const entry = snapshot.kind === "content" && snapshot.planning ? details(title) : jsonPreview(title, item.snapshot);
        if (snapshot.kind === "content" && snapshot.planning) {
          entry.append(el("small", item.operation === "set_object_lock" ? t(snapshot.planning.locked ? "locked" : "unlocked") : item.operation === "restore_object" ? t("restore") : t("saved")));
          entry.append(renderContentDifference((sorted[index + 1]?.snapshot as DevelopmentObject | undefined)?.planning, snapshot.planning));
        }
        const restore = button(t("restore"), () => { void restoreVersion(item); }, "restore"); restore.disabled = busy || !!current()?.planning?.locked || item.revision === current()?.revision;
        entry.append(restore); box.append(entry);
      }
    }
    if (current()?.planning?.locked) box.append(el("small", t("lockedRestore")));
    return box;
  }
  function renderWork(saved: DevelopmentObject) {
    const work = section(t("work")), linked = records.filter(r => r.object_id === saved.id);
    work.append(button(t("newWork"), () => options.createRecord(saved), "new-work"),
      button(t("copy"), () => { void copy(planningContext(saved, objects)); }, "copy-context"));
    if (!linked.length) work.append(el("p", t("noWork")));
    const statusKeys = { planned: "statusPlanned", active: "statusActive", blocked: "statusBlocked", done: "statusDone", cancelled: "statusCancelled" } as const;
    for (const record of linked) work.append(button(`${record.title} · ${pt(statusKeys[record.status || "planned"])}`, () => options.openRecord(record.id)));
    main.append(work, renderHistory());
  }
  function candidateContext(parameter: DevelopmentObject): CandidateContext {
    return { projectId: project!.id, parameter, objects, candidates, adoptions, trials: trialSummaries, busy, editing: candidateEditing, showArchived: showArchivedCandidates,
      async mutate(command) { busy = true; setStatus(t("saving")); try { return await mutateProject(command); } finally { busy = false; } },
      setStatus, async refresh() { await refreshEvidence(); renderMain(); }, rerender: renderMain,
      edit(id) { candidateEditing = id; renderMain(); }, toggleArchived() { showArchivedCandidates = !showArchivedCandidates; renderMain(); },
      tryIn(flow, candidate) { openFlow(flow.id, undefined, parameter, { parameterId: candidate.parameter_id, candidateId: candidate.id }); },
      adopt(candidate) { startAdopt(candidate); } };
  }
  function renderAdopt() {
    const active = adopting!, parameter = objects.find(o => o.id === active.parameterId);
    if (!project || !parameter?.planning?.parameter) { adopting = undefined; renderMain(); return; }
    const projectId = project.id, key = adoptKey(projectId, parameter.id), candidate = candidates.find(c => c.id === active.candidateId);
    main.append(renderAdoption({ projectId, parameter, candidate, objects, trials: trialSummaries, busy, draft: active,
      keep: () => { if (!writeAdoptDraft(key, active)) setStatus(t("storageFailed")); }, rerender: renderMain,
      back: () => { adopting = undefined; open(parameter); },
      viewTrial: (trialId, flowId) => openFlow(flowId, undefined, parameter, undefined,
        { flowId, mode: "trials", viewing: trialId, inspect: "", chartVariable: "", chartOpen: false }),
      unlock: () => setLock(false),
      async rebase() {
        if (!candidate || busy) return;
        busy = true; setStatus(t("saving"));
        try {
          await mutateProject({ op: "put_candidate", request_id: newProjectRequestId(), project_id: projectId, id: candidate.id, expected_revision: candidate.revision, parameter_id: parameter.id,
            label: candidate.label, value: candidate.value, reason: candidate.reason, base_revision: parameter.revision, archived: candidate.archived, ...(candidate.from_variant ? { from_variant: candidate.from_variant } : {}) });
          await refreshEvidence(); setStatus(t("saved"));
        } catch (error) { await refreshEvidence(); setStatus(`${t("error")}: ${String(error)}`); }
        finally { busy = false; render(); }
      },
      async confirm() {
        if (!candidate || busy || adopting !== active) return;
        const command = adoptionCommand({ projectId, parameter, candidate, draft: active });
        writeAdoptDraft(key, active); busy = true; render(); setStatus(t("saving"));
        try {
          const result = await mutateProject(command);
          if (!result.object?.planning) throw new Error("Missing saved object");
          forgetAdoptDraft(key);
          if (project?.id === projectId) {
            objects = [...objects.filter(o => o.id !== parameter.id), result.object];
            if (adopting === active) { adopting = undefined; draft = { object: clone(result.object as Draft["object"]), base: clone(result.object) }; editing = false; history = undefined; }
            await refreshEvidence();
          }
          options.onChanged(); setStatus(t("adoptDone"));
        } catch (error) {
          if (project?.id === projectId) { await refresh(); setStatus(`${t("error")}: ${String(error)} · ${t("adoptConflict")}`); }
        } finally { busy = false; render(); }
      } }));
  }
  function renderRead(saved: DevelopmentObject) {
    readingId = saved.id;
    const fields = saved.planning!, top = el("header", "", "plan-read-top"); top.dataset.planRead = saved.id;
    top.append(el("small", `${t("reading")} · ${kindName(saved.kind)} · ${fields.scopes.join(" / ")} · ${t("revision")} ${saved.revision}`), el("h2", saved.name));
    const actions = el("div", "", "plan-read-actions");
    const edit = button(t(fields.locked ? "unlockEdit" : "edit"), () => { void beginEdit(); }, "edit"); edit.disabled = busy;
    actions.append(el("strong", t(fields.locked ? "locked" : "unlocked")), edit);
    if (!fields.locked) { const lock = button(t("lock"), () => { void setLock(true); }, "lock"); lock.disabled = busy; actions.append(lock); }
    if (returnFlow) {
      const back = returnFlow, flow = objects.find(o => o.id === back.flowId), step = flow?.planning?.flow?.steps.find(s => s.id === back.stepId);
      const flowState = returnFlowState;
      actions.append(button(`${t("backToFlow")} · ${flow?.name || back.flowId} · ${step?.title || back.stepId}`, () => { returnFlow = undefined; openFlow(back.flowId, back, undefined, undefined, flowState); }, "back-to-flow"));
    }
    top.append(actions, el("small", t("lockHelp"))); main.append(top);
    if (saved.kind === "flow") {
      const flow = section("玩家流程"); flow.append(el("p", fields.flow ? `${fields.flow.steps.length} 个步骤 · ${fields.flow.variables.length} 个变量` : "尚未定义玩家步骤与分支。"), button("查看流程与试走", () => openFlow(saved.id), "open-flow"));
      const attached = anchoredDesigns(objects.filter(o => !o.archived), saved.id);
      if (attached.length) {
        const list = el("div", "", "plan-attached"); list.dataset.planAttached = "true"; list.append(el("h4", `${t("attachedDesigns")} · ${attached.length}`));
        for (const design of attached) {
          const row = el("div", "", "plan-read-link"), step = fields.flow?.steps.find(s => s.id === design.anchor.step_id);
          const where = `${step?.title || design.anchor.step_id}${design.anchor.choice_id ? ` · ${step?.choices.find(c => c.id === design.anchor.choice_id)?.label || design.anchor.choice_id}` : ""}`;
          row.append(el("span", `${where} — ${designLabel(design)}`), button(t("editor"), () => open(design.object, { flowId: saved.id, stepId: design.anchor.step_id, ...(design.anchor.choice_id ? { choiceId: design.anchor.choice_id } : {}) }), "open-attached"));
          list.append(row);
        }
        flow.append(list);
      }
      main.append(flow);
    }
    if (dirty()) main.append(el("p", t("draftAvailable"), "plan-draft-notice"));
    const body = saved.kind === "content" ? el("section", "", "content-reading-sheet") : section(t("body"));
    body.append(el("small", `${t(fields.confirmed ? "confirmed" : "unconfirmed")}${fields.sections?.some(s => s.role === "question") ? ` · ${ct("question")} ${fields.sections.filter(s => s.role === "question").length}` : ""}`), renderContentBody(saved, id => { void beginEdit(id); })); main.append(body);
    const referencedValues = renderReferencedValues(saved, objects); if (referencedValues) main.append(referencedValues);
    const definition = fields.rule || fields.hook || fields.parameter;
    if (definition) {
      const box = section(kindName(saved.kind)); box.classList.add("plan-definition");
      const keys = fields.rule ? ["trigger", "condition", "effect"] as const : fields.hook ? ["cue", "action", "payoff", "continuation"] as const : ["value", "unit", "min", "max", "formula"] as const;
      for (const key of keys) { const item = el("div"); item.append(el("h4", t(key)), el("p", String((definition as unknown as Record<string, unknown>)[key] || t("undecided")), "plan-read-text")); box.append(item); }
      for (const variant of fields.parameter?.variants || []) box.append(el("p", `${variant.label}: ${variant.value} · ${variant.reason}`));
      main.append(box);
    }
    if (supportsAnchors(saved.kind)) main.append(renderAnchorRead(fields, objects, anchor => openFlow(anchor.flow_id, { flowId: anchor.flow_id, stepId: anchor.step_id, ...(anchor.choice_id ? { choiceId: anchor.choice_id } : {}) }, saved)));
    if (saved.kind === "parameter" && fields.parameter && project) main.append(renderCandidates(candidateContext(saved)));
    if (saved.kind === "system" || saved.kind === "flow") {
      main.append(button(ct("here"), () => writeContent({ kind: "content", scopes: [...fields.scopes], parent: saved.id }), "write-here"));
    }
    renderRelatedContent(saved);
    const links = section(t("relations"));
    if (!fields.links.length) links.append(el("p", t("noSavedRelations")));
    for (const link of fields.links) {
      const target = objects.find(o => o.id === link.target_id), row = el("div", "", "plan-read-link");
      row.append(el("small", t(link.relation)));
      if (target) row.append(button(target.name, () => open(target))); else row.append(el("span", link.target_id));
      if (link.note) row.append(el("p", link.note, "plan-read-text"));
      const parameter = target?.planning?.parameter;
      if (parameter && link.relation === "uses") row.append(el("p", `${t("shared")}: ${displayValue(parameter.value, parameter.unit)}`),
        el("p", link.local ? `${t("localValue")}: ${link.local.value} · ${link.local.reason}` : t("inherited")));
      links.append(row);
    }
    if (saved.kind === "system" || saved.kind === "flow") {
      const additions = el("div", "", "plan-read-actions");
      for (const kind of ["rule", "parameter", "hook", "content"] as const) additions.append(button(`+ ${t(kind)}`, () => newObject({ kind, scopes: [...fields.scopes], parent: saved.id })));
      links.append(additions);
    }
    main.append(links, renderImpact(saved.id));
    if (fields.references.length) {
      const refs = section(t("references"));
      for (const ref of fields.references) refs.append(el("p", `${ref.label} · ${ref.uri} · ${ref.version}`, "plan-read-text")); main.append(refs);
    }
    renderWork(saved);
  }
  function renderRelatedContent(saved: DevelopmentObject) {
    const direct = saved.planning!.links.map(link => link.target_id);
    const related = objects.filter(o => o.id !== saved.id && o.planning && !o.archived && (!scope || o.planning.scopes.includes(scope)) &&
      (direct.includes(o.id) || o.planning.links.some(link => link.target_id === saved.id && link.relation === "belongs_to") || o.planning.anchors?.some(anchor => anchor.flow_id === saved.id)));
    if (!related.length) return;
    const box = el("section", "", "content-related"); box.dataset.contentRelated = saved.id;
    box.append(el("h2", ct("related")), el("small", ct("relatedHelp")));
    for (const object of related) {
      const card = el("article", "", "content-related-card"), head = el("header"), fields = object.planning!;
      card.dataset.contentRelatedObject = object.id;
      const edit = (id?: string) => { readingReturn = { id: saved.id, scroll: main.scrollTop }; open(object); void beginEdit(id); };
      head.append(el("h3", object.name), el("small", `${kindName(object.kind)} · ${t("revision")} ${object.revision}`),
        button(t(fields.locked ? "unlockEdit" : "edit"), () => edit(), "edit-related"));
      card.append(head, renderContentBody(object, edit));
      const definition = fields.rule || fields.hook || fields.parameter;
      if (definition) {
        const rows = fields.rule ? ["trigger", "condition", "effect"] as const : fields.hook ? ["cue", "action", "payoff", "continuation"] as const : ["value", "unit", "min", "max", "formula"] as const;
        for (const key of rows) { const text = String((definition as unknown as Record<string, unknown>)[key] || t("undecided")); const value = el("div"); renderLightText(value, text); card.append(el("h4", t(key)), value); }
      }
      const values = renderReferencedValues(object, objects); if (values) card.append(values);
      if (fields.references.length) { const refs = details(t("references")); fields.references.forEach(ref => refs.append(el("p", `${ref.label} · ${ref.uri} · ${ref.version}`, "plan-read-text"))); card.append(refs); }
      box.append(card);
    }
    main.append(box);
  }
  function renderMain() {
    const scroll = main.scrollTop; keepReadingPosition(); readingId = undefined; mapView?.dispose(); mapView = undefined; flowView?.dispose(); flowView = undefined; main.replaceChildren(); main.dataset.map = "false";
    main.dataset.contentView = String(draft?.object.kind === "content");
    if (!project) { main.append(el("p", t("noProject"))); return; }
    if (!loaded) { main.append(el("p", t("loading"))); return; }
    if (flowWorkspace) {
      const id = project.id;
      const origin = returnObject && objects.find(o => o.id === returnObject!.id);
      const view = createFlowWorkspace({ projectId: id, objects, candidates, scope, selected: flowSelection, focus: flowFocus, returnState: returnFlowState, preselect: flowPreselect,
        returnTo: origin ? { label: `${t("backToObject")}「${origin.name}」`, action: backToObject } : undefined,
        create() { focused = true; options.focusEditor(true); newObject({ kind: "flow", scopes: scope ? [scope] : ["R0"] }); },
        edit(object) { open(object); focused = true; options.focusEditor(true); void beginEdit(); },
        record: options.createRecord, selectedFlow(value) { flowSelection = value; remember(); },
        async refreshSources() { const fresh = await fetchProjectObjects(id); if (project?.id === id) objects = fresh; return fresh; },
        openObject(design, back, flowState) { open(design, back, flowState); },
        writeContent(flow, stepId, choiceId, state) {
          writeContent({ kind: "content", scopes: [...flow.planning!.scopes], parent: flow.id, anchor: { flow_id: flow.id, step_id: stepId, ...(choiceId ? { choice_id: choiceId } : {}) } });
          returnFlow = { flowId: flow.id, stepId, ...(choiceId ? { choiceId } : {}) }; returnFlowState = state;
        },
        adopt(candidate, trialIds) { startAdopt(candidate, trialIds); },
        trialsChanged() { void fetchProjectTrials(id).then(list => { if (project?.id === id) trialSummaries = list; }).catch(() => undefined); } });
      flowView = view; returnFlowState = undefined; main.append(view.element); return;
    }
    if (adopting) { renderAdopt(); return; }
    if (overview) { renderMap(); return; }
    if (numbers) { renderNumbers(); return; }
    if (!draft) {
      renderMap(); return;
    }
    const object = draft.object, fields = object.planning, saved = current();
    if (saved && !editing) {
      if (readingReturn) { const back = readingReturn; main.append(button(ct("return"), () => { const target = objects.find(o => o.id === back.id); readingReturn = undefined; if (target) { open(target); main.scrollTop = back.scroll; } }, "back-to-reading")); }
      renderRead(saved); main.scrollTop = readingPosition(saved.id); return;
    }
    const top = el("div", "", "plan-editor-top");
    top.append(el("h2", object.kind === "flow" ? "编辑玩家流程" : object.kind === "content" ? ct("write") : object.name || t("new")), el("small", `${kindName(object.kind)} · ${t("revision")} ${object.revision}`));
    main.append(top); if (object.kind !== "flow") main.append(el("p", t("editHelp")));
    if (saved?.planning?.locked) {
      main.append(el("p", t("lockHelp")), button(t("unlockEdit"), () => { void beginEdit(); }, "edit"));
    }
    if (saved && saved.revision !== object.revision) {
      const warning = section(t("stale")); warning.classList.add("plan-conflict");
      warning.append(jsonPreview(t("compare"), saved), button(t("rebase"), () => {
        if (!draft?.base) { setStatus(ct("noBase")); return; }
        const result = mergeDraft(draft.base, draft.object, saved);
        if (!result.value.planning) return;
        if (result.conflicts.length) { mergeReview = { value: result.value as Draft["object"], conflicts: result.conflicts, local: clone(draft.object), revision: saved.revision }; renderMain(); }
        else { draft.object = result.value as Draft["object"]; draft.base = clone(saved); delete draft.pending; persist(); renderMain(); }
      }, "rebase")); main.append(warning);
      if (mergeReview) {
        const review = mergeReview; warning.append(el("p", ct("conflictHelp")));
        for (const conflict of review.conflicts) warning.append(jsonPreview(conflict.path.join("."), { [ct("myChanges")]: conflict.local, [ct("savedChanges")]: conflict.remote }));
        const apply = (mine: boolean) => {
          if (!draft || current()?.revision !== review.revision || !dataEqual(draft.object, review.local)) { mergeReview = undefined; setStatus(ct("mergeChanged")); renderMain(); return; }
          draft.object = mine ? chooseLocal(review.value, review.conflicts) : clone(review.value);
          draft.base = clone(current()!); delete draft.pending; mergeReview = undefined; persist(); renderMain();
        };
        warning.append(button(ct("chooseMine"), () => apply(true), "resolve-local"), button(ct("chooseSaved"), () => apply(false), "resolve-remote"));
      }
    }
    const form = el("form"); form.noValidate = true;
    form.dataset.flowForm = String(object.kind === "flow");
    form.addEventListener("submit", event => { event.preventDefault(); void save(); });
    form.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } });
    const controls = el("fieldset"); controls.disabled = busy || !!saved?.planning?.locked;
    const meta = el("div", "", "plan-grid");
    meta.append(input(t("name"), object.name, v => { object.name = v; }, false, "name"));
    const kindSelect = select(PLANNING_KINDS.map(k => [k, t(k)]), object.kind, value => {
      object.kind = value;
      const next = emptyPlanning(value, fields.scopes); object.planning = { ...next, body: fields.body, confirmed: false, links: fields.links, references: fields.references, ...(supportsAnchors(value) && fields.anchors?.length ? { anchors: fields.anchors } : {}) };
      if (value === "flow") object.planning.flow = blankFlow();
      persist(); renderMain();
    }); kindSelect.disabled = object.revision > 0; kindSelect.dataset.planKind = "true";
    const kindField = label(t("kind"), kindSelect);
    if (object.kind !== "content") meta.append(kindField); else meta.classList.add("content-name");
    const scopes = el("div", "", "plan-scope-checks"); scopes.append(el("span", t("scope")));
    for (const s of ["R0", "R1", "R2"]) scopes.append(check(s, fields.scopes.includes(s), yes => {
      fields.scopes = yes ? [...fields.scopes, s].sort() : fields.scopes.filter(v => v !== s); persist();
    }));
    scopes.append(check(t("confirmed"), fields.confirmed, value => { fields.confirmed = value; persist(); }));
    controls.append(meta);
    if (object.kind === "flow" || object.kind === "content") { const metadata = el("details", "", "flow-metadata"); metadata.append(el("summary", `${t("scope")} · ${fields.scopes.join(" / ")} · ${t(fields.confirmed ? "confirmed" : "unconfirmed")}`)); if (object.kind === "content") metadata.append(kindField); metadata.append(scopes, el("small", t("confirmationHelp"))); controls.append(metadata); }
    else controls.append(scopes, el("small", t("confirmationHelp")));
    const body = input(t("body"), fields.body, v => { fields.body = v; }, true, "body"); body.className = "plan-body";
    if (object.kind === "content") controls.append(renderContentEditor(fields, () => persist()));
    else if (!fields.rule && !fields.hook && !fields.parameter && object.kind !== "flow") controls.append(body, el("small", t("bodyHelp")));
    if (object.kind === "flow") { const view = createFlowEditor(object, objects, () => persist(), (design, anchor) => open(design, { flowId: anchor.flow_id, stepId: anchor.step_id, ...(anchor.choice_id ? { choiceId: anchor.choice_id } : {}) }), (stepId) => {
      if (!saved || dirty()) { setStatus("请先保存流程，再在这个步骤写内容。"); return; }
      writeContent({ kind: "content", scopes: [...fields.scopes], parent: object.id, anchor: { flow_id: object.id, step_id: stepId } });
    }); flowView = view; controls.append(view.element); }
    if (fields.rule) {
      const grid = section(t("rule"));
      for (const key of ["trigger", "condition", "effect"] as const) grid.append(input(t(key), fields.rule[key], v => { fields.rule![key] = v; }, true, key));
      controls.append(grid);
    }
    if (fields.hook) {
      const grid = section(t("hook")); grid.classList.add("plan-grid");
      for (const key of ["cue", "action", "payoff", "continuation"] as const) grid.append(input(t(key), fields.hook[key], v => { fields.hook![key] = v; }, true, key));
      controls.append(grid);
    }
    if (fields.parameter) {
      const parameter = fields.parameter, box = section(t("parameter")), grid = el("div", "", "plan-grid");
      for (const key of ["value", "unit", "min", "max"] as const) grid.append(input(t(key), parameter[key], v => { parameter[key] = v; }, false, key));
      box.append(grid, input(t("formula"), parameter.formula, v => { parameter.formula = v; }, true, "formula"), el("h4", t("variants")));
      for (const [index, variant] of parameter.variants.entries()) {
        const row = el("div", "", "plan-variant"); row.append(input(t("candidate"), variant.label, v => { variant.label = v; }, false, `variant-name-${index}`),
          input(t("value"), variant.value, v => { variant.value = v; }, false, `variant-value-${index}`),
          input(t("candidateReason"), variant.reason, v => { variant.reason = v; }, true, `variant-reason-${index}`),
          button(t("adoptValue"), () => { parameter.value = variant.value; persist(); renderMain(); }, "adopt-value"),
          button(t("remove"), () => { parameter.variants.splice(index, 1); persist(); renderMain(); }, "remove-variant")); box.append(row);
      }
      const add = button(t("addVariant"), () => { parameter.variants.push({ label: "", value: "", reason: "" }); persist(); renderMain(); }, "add-variant"); add.disabled = parameter.variants.length >= 8;
      box.append(add); controls.append(box);
    }
    if (fields.rule || fields.hook || fields.parameter || object.kind === "flow") {
      const discussion = details(t("body")); discussion.open = !!fields.body;
      discussion.append(body, el("small", t("bodyHelp"))); controls.append(discussion);
    }
    controls.append(renderLinks(fields));
    if (supportsAnchors(object.kind)) controls.append(renderAnchorEditor(fields, object.kind, objects, () => persist(), () => renderMain()));
    controls.append(renderImpact(object.id));
    const refs = details(t("references"));
    for (const [index, ref] of fields.references.entries()) {
      const row = el("div", "", "plan-reference");
      for (const key of ["label", "uri", "version"] as const) row.append(input(t(key), ref[key], v => { ref[key] = v; }, false, `source-${key}-${index}`));
      row.append(button(t("remove"), () => { fields.references.splice(index, 1); persist(); renderMain(); }, "remove-source")); refs.append(row);
    }
    refs.open = fields.references.length > 0;
    refs.append(button(t("addSource"), () => { fields.references.push({ label: "", uri: "", version: "" }); persist(); renderMain(); main.querySelector<HTMLDetailsElement>("details")?.setAttribute("open", ""); }, "add-source"));
    controls.append(refs, check(t("archived"), object.archived, value => { object.archived = value; persist(); }));
    form.append(controls);
    const actions = el("div", "", "plan-save-bar"), submit = el("button", t(busy ? "saving" : "saveLock"), "primary");
    submit.type = "submit"; submit.dataset.planAction = "save"; submit.disabled = busy || !!saved?.planning?.locked || (!!saved && saved.revision !== object.revision);
    const discard = button(t(saved ? "cancelLock" : "discard"), () => { void discardDraft(); }, "discard"); discard.disabled = busy;
    actions.append(submit, discard, button(t("copyDraft"), () => { void copy(JSON.stringify({ state: "local draft", ...object }, null, 2)); }, "copy-draft"));
    if (object.kind === "flow") { const preview = button("保存并试走", () => { void save().then(() => { if (!editing && current()?.id === object.id) openFlow(object.id); }); }, "save-flow"); preview.disabled = submit.disabled; actions.append(preview); }
    form.append(actions); main.append(form);
    if (saved) renderWork(saved); else main.append(el("p", t("savedOnly")));
    main.scrollTop = scroll;
  }
  function renderMap() {
    if (!project) return;
    main.dataset.map = "true";
    mapView = createPlanningMap({ projectId: project.id, objects, scope, open,
      create(context) { focused = true; options.focusEditor(true); newObject(context); },
      edit(object, relations) { open(object); focused = true; options.focusEditor(true); void beginEdit().then(() => { if (relations) main.querySelector('[data-plan-links]')?.scrollIntoView({ block: "start" }); }); } });
    main.append(mapView.element);
  }
  function render() { renderToolbar(); renderNav(); renderMain(); }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setStatus(t("copied")); }
    catch { setStatus(t("clipboardFailed")); const node = el("textarea"); node.value = text; node.readOnly = true; node.rows = 10; main.append(node); node.focus(); node.select(); }
  }
  async function refresh() {
    if (!project) return;
    const id = project.id, version = ++epoch; setStatus(t("loading"));
    try {
      const [nextObjects, nextRecords] = await Promise.all([fetchProjectObjects(id), fetchProjectRecords(id, { includeArchived: true }), refreshEvidence()]);
      if (epoch !== version || project?.id !== id) return;
      // Configuration projections and historical plain objects never enter a new planning surface automatically.
      objects = nextObjects; records = nextRecords; loaded = true;
      if (!draft) {
        const saved = read<{ id?: string }>(stateKey());
        const selected = objects.find(o => o.id === saved?.id && o.planning);
        const pending = saved?.id ? read<Draft>(`${PREFIX}.draft.${id}.${saved.id}`) : undefined;
        if (selected?.planning) draft = loadDraft(selected as Draft["object"]);
        else if (pending?.object?.project_id === id && pending.object.planning) { draft = pending; editing = true; }
      }
      setStatus(""); render();
    } catch (error) { if (epoch === version) setStatus(`${t("error")}: ${String(error)}`); }
  }
  async function save() {
    if (!draft || busy || !editing || current()?.planning?.locked) return;
    const active = draft, object = active.object, projectId = object.project_id;
    if (!object.name.trim() && object.kind === "content") object.name = (object.planning.sections?.find(s => s.text.trim())?.text || object.planning.body).trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
    if (!object.name.trim() || !object.planning.scopes.length) { setStatus(t("required")); return; }
    if (object.planning.flow) { const issues = flowDiagnostics(object.planning.flow).filter(message => !message.startsWith("还没有步骤")); if (issues.length) { setStatus(issues.join("\n")); return; } }
    const body = { project_id: projectId, op: "put_object" as const, id: object.id, expected_revision: object.revision,
      name: object.name.trim(), kind: object.kind, archived: object.archived, planning: { ...clone(object.planning), locked: true } };
    const fingerprint = JSON.stringify(body), requestId = active.pending?.fingerprint === fingerprint ? active.pending.id : newProjectRequestId();
    active.pending = { fingerprint, id: requestId }; persist(active); busy = true; render(); setStatus(t("saving"));
    try {
      const result = await mutateProject({ ...body, request_id: requestId }); if (!result.object?.planning) throw new Error("Missing saved object");
      forget(object);
      if (project?.id === projectId) {
        objects = [...objects.filter(o => o.id !== result.object!.id), result.object];
        if (draft === active) { draft = { object: clone(result.object as Draft["object"]), base: clone(result.object) }; editing = false; }
        history = undefined; remember(); setStatus(t("saved"));
      }
      options.onChanged();
    } catch (error) {
      if (project?.id === projectId) { await refresh(); setStatus(`${t("error")}: ${String(error)} · ${t("draftKept")}`); }
    } finally { busy = false; render(); }
  }
  async function setLock(locked: boolean): Promise<boolean> {
    const saved = current(), active = draft; if (!saved?.planning || busy) return false;
    if (!!saved.planning.locked === locked) return true;
    const key = `${PREFIX}.lock.${saved.project_id}.${saved.id}.${saved.revision}.${locked}`;
    const requestId = read<string>(key) || newProjectRequestId();
    try { localStorage.setItem(key, JSON.stringify(requestId)); } catch { /* Revision checking still applies. */ }
    busy = true; render();
    try {
      const result = await mutateProject({ request_id: requestId, project_id: saved.project_id, op: "set_object_lock", id: saved.id, expected_revision: saved.revision, locked });
      if (!result.object?.planning) throw new Error("Missing saved object");
      if (project?.id !== saved.project_id || draft !== active) return false;
      const hadDraft = dirty(); objects = objects.map(o => o.id === saved.id ? result.object! : o);
      if (active && active.object.revision === saved.revision) {
        active.object.revision = result.object.revision; active.object.planning.locked = locked; delete active.pending;
        active.base = clone(result.object);
        if (hadDraft) persist(active); else { forget(saved); draft = { object: clone(result.object as Draft["object"]), base: clone(result.object) }; }
      }
      history = undefined; options.onChanged(); setStatus(""); return true;
    } catch (error) { if (project?.id === saved.project_id) { await refresh(); setStatus(`${t("error")}: ${String(error)}`); } return false; }
    finally { busy = false; render(); }
  }
  async function beginEdit(sectionId?: string) {
    if (!current() || busy) return;
    keepReadingPosition();
    if (current()?.planning?.locked && !await setLock(false)) return;
    editing = true; overview = false; numbers = false; render(); main.scrollTop = 0;
    if (sectionId) {
      const target = sectionId === "legacy-body" ? main.querySelector<HTMLTextAreaElement>('[data-plan-field="body"]') : main.querySelector<HTMLTextAreaElement>(`[data-content-text="${CSS.escape(sectionId)}"]`);
      target?.focus(); target?.scrollIntoView({ block: "center" });
    }
  }
  async function discardDraft() {
    const active = draft, saved = current(); if (!active || busy) return;
    if (saved?.planning && !await setLock(true)) return;
    if (draft?.object.id !== active.object.id || project?.id !== active.object.project_id) return;
    forget(active.object); const latest = current(); draft = latest?.planning ? { object: clone(latest as Draft["object"]), base: clone(latest) } : undefined;
    editing = false; overview = !draft; remember(); setStatus(""); render();
  }
  async function loadHistory() {
    const object = current(); if (!object) return;
    const version = ++historyEpoch;
    try {
      const entries = await fetchProjectHistory(object.project_id, "object", object.id);
      if (version !== historyEpoch || draft?.object.id !== object.id || project?.id !== object.project_id) return;
      history = entries; renderMain();
    } catch (error) { if (version === historyEpoch) setStatus(`${t("error")}: ${String(error)}`); }
  }
  async function restoreVersion(item: RecordHistory) {
    const saved = current(); if (!saved || busy) return;
    if (saved.planning?.locked) { setStatus(t("lockedRestore")); return; }
    if (dirty()) { setStatus(t("dirtyRestore")); return; }
    const id = saved.id, projectId = saved.project_id, active = draft;
    const key = `${PREFIX}.restore.${projectId}.${id}.${saved.revision}.${item.revision}`;
    const requestId = read<string>(key) || newProjectRequestId();
    try { localStorage.setItem(key, JSON.stringify(requestId)); } catch { /* OCC still protects state. */ }
    busy = true; render();
    try {
      const result = await mutateProject({ request_id: requestId, project_id: projectId, op: "restore_object", id, expected_revision: saved.revision, restore_revision: item.revision });
      if (project?.id === projectId && result.object) {
        forget(saved); objects = [...objects.filter(o => o.id !== id), result.object];
        if (draft === active) draft = result.object.planning ? { object: clone(result.object as Draft["object"]), base: clone(result.object) } : undefined;
        history = undefined; editing = false; setStatus(t("saved")); options.onChanged();
      }
    } catch (error) { if (project?.id === projectId) { await refresh(); setStatus(`${t("error")}: ${String(error)}`); } }
    finally { busy = false; render(); }
  }
  onLocale(render);
  render();
  return { element, refresh, async setProject(value?: Project) {
    if (value?.id === project?.id) { project = value; return; }
    keepReadingPosition(); readingId = undefined; readingReturn = undefined;
    epoch++; historyEpoch++; project = value; objects = []; records = []; draft = undefined; history = undefined; loaded = false;
    mergeReview = undefined;
    if (project) try {
      const prefix = `${PREFIX}.draft.${project.id}.`;
      for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix)) { const pending = read<Draft>(key); if (pending?.object?.project_id === project.id && pending.object.planning) drafts.set(key, pending); } }
    } catch { /* Saved project content is unaffected. */ }
    candidates = []; adoptions = []; trialSummaries = []; adopting = undefined; candidateEditing = undefined; flowFocus = undefined; flowPreselect = undefined; returnFlow = undefined; returnObject = undefined;
    const saved = read<{ scope?: string; kind?: string; numbers?: boolean; overview?: boolean; flowWorkspace?: boolean; flowSelection?: string }>(stateKey());
    scope = saved?.scope && ["R0", "R1", "R2"].includes(saved.scope) ? saved.scope : "";
    kind = PLANNING_KINDS.includes(saved?.kind as PlanningKind) ? saved!.kind! : ""; numbers = !!saved?.numbers; search = "";
    overview = saved?.overview ?? true; editing = false; focused = false; options.focusEditor(false);
    flowWorkspace = !!saved?.flowWorkspace; flowSelection = saved?.flowSelection || "";
    if (flowWorkspace) { focused = true; options.focusEditor(true); }
    render(); if (project) await refresh();
  } };
}
