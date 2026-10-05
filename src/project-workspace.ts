import { currentLocale, onLocale } from "./i18n";
import { pt } from "./i18n/projects";
import {
  decideProjectAccess,
  exportProject,
  exportProjectMarkdown,
  fetchProjectAccess,
  fetchProjectHistory,
  fetchProjectObjects,
  fetchProjectRecord,
  fetchProjectRecords,
  fetchProjects,
  mutateProject,
  newProjectRequestId,
  pinProjectRecord,
  type DevelopmentObject,
  type Project,
  type ProjectAccess,
  type ProjectExport,
  type RecordCommand,
  type RecordFields,
  type RecordHistory,
  type RecordStatus,
  type SourceReference,
  type WorkRecord,
} from "./project-record-api";
import "./project-workspace.css";
import { createProjectPlanningView } from "./project-planning-view";
import { createGameHome } from "./project-game-home";
import { gh } from "./i18n/game-home";
import type { GameDocument, PlayerLoop } from "./project-game-home-api";
import type { GameSkeleton } from "./project-game-skeleton-model";
import { planText } from "./i18n/planning";

export type ProjectWorkspace = {
  open(projectId?: string, recordId?: string): Promise<void>;
  openOnCanvas(projectId?: string): Promise<void>;
  close(): void;
};

export type ProjectWorkspaceOptions = {
  onChanged: () => void;
  onOpenSourceTable: (projectId: string, projectName: string, root: string, loop: PlayerLoop) => Promise<string>;
  onOpenSkeleton: (projectId: string, projectName: string, root: string, skeleton: GameSkeleton, documents: readonly GameDocument[]) => Promise<string>;
};

type PendingMutation = { requestId: string; fingerprint: string };
type RecordDraft = {
  projectId: string;
  recordId?: string;
  createdId?: string;
  baseRevision: number;
  fields: RecordFields;
  pending?: PendingMutation;
};
type ProjectDraft = {
  id: string;
  baseRevision: number;
  name: string;
  aliases: string[];
  archived: boolean;
  pending?: PendingMutation;
};
type ObjectDraft = { id: string; projectId: string; name: string; kind: string; pending?: PendingMutation };
type ImportDraft = {
  name: string;
  bundleText: string;
  targetProjectId: string;
  createRequestId: string;
  importRequestId: string;
  projectCreated: boolean;
};

const STATUS: RecordStatus[] = ["planned", "active", "blocked", "done", "cancelled"];
const PREFIX = "spellcast.project-records.v1";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  return value;
}

function button(text: string, className = ""): HTMLButtonElement {
  const value = node("button", text);
  value.type = "button";
  if (className) value.className = className;
  return value;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const value = node("label");
  value.append(node("span", label), control);
  return value;
}

function makeInput(value = "", multiline = false): HTMLInputElement | HTMLTextAreaElement {
  const control = multiline ? document.createElement("textarea") : document.createElement("input");
  control.value = value;
  if (multiline) (control as HTMLTextAreaElement).rows = 3;
  return control;
}

function emptyFields(): RecordFields {
  return {
    object_id: null,
    title: "",
    goal: "",
    scope: "",
    status: "planned",
    result: "",
    boundaries: "",
    next_step: "",
    references: [],
  };
}

function copyFields(value: RecordFields): RecordFields {
  return {
    object_id: value.object_id || null,
    title: value.title || "",
    goal: value.goal || "",
    scope: value.scope || "",
    status: STATUS.includes(value.status as RecordStatus) ? value.status : "planned",
    result: value.result || "",
    boundaries: value.boundaries || "",
    next_step: value.next_step || "",
    references: (value.references || []).map(reference => ({ label: reference.label || "", uri: reference.uri || "", version: reference.version || "" })),
  };
}

function recordDraftKey(projectId: string, recordId?: string) {
  return `${PREFIX}.record.${projectId}.${recordId || "new"}`;
}

function projectDraftKey(projectId: string) {
  return `${PREFIX}.project.${projectId}`;
}

function objectDraftKey(projectId: string) {
  return `${PREFIX}.object.${projectId}`;
}

function importDraftKey() {
  return `${PREFIX}.import`;
}

function mutationKey(key: string) {
  return `${PREFIX}.request.${key}`;
}

function readLocal<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeLocal(key: string) {
  try { localStorage.removeItem(key); } catch { /* A committed request is still safe to replay. */ }
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
}

function isConflict(error: unknown) {
  return /revision|conflict|stale|changed/i.test(asError(error));
}

function formatDate(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return "—";
  return new Date(value).toLocaleString(currentLocale() as string);
}

function statusText(status: string | undefined) {
  const key = `status${(status || "planned").slice(0, 1).toUpperCase()}${(status || "planned").slice(1)}` as "statusPlanned";
  return pt(key);
}

function validUri(uri: string) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  if (!match) return false;
  return !["javascript", "data", "vbscript"].includes(match[1].toLowerCase());
}

function normalizeReferences(references: SourceReference[]) {
  const next: SourceReference[] = [];
  for (const reference of references) {
    const label = reference.label.trim();
    const uri = reference.uri.trim();
    const version = reference.version.trim();
    if (!label && !uri && !version) continue;
    if (!label || !uri || !validUri(uri)) return undefined;
    next.push({ label, uri, version });
  }
  return next;
}

function snapshotTitle(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const data = snapshot as Record<string, unknown>;
  if (typeof data.title === "string") return data.title;
  const fields = data.fields;
  if (fields && typeof fields === "object" && typeof (fields as Record<string, unknown>).title === "string") return (fields as Record<string, unknown>).title as string;
  return undefined;
}

function exportIsValid(value: unknown): value is ProjectExport {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.format === "spellcast.project" && [1, 2, 3, 4].includes(Number(data.version)) && typeof data.version === "number" && !!data.project && Array.isArray(data.objects) && Array.isArray(data.records) && Array.isArray(data.history);
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A local editor for project-scoped records. Main owns navigation and Canvas placement. */
export function createProjectWorkspace(options: ProjectWorkspaceOptions): ProjectWorkspace {
  const dialog = document.createElement("dialog");
  dialog.className = "project-workspace";
  dialog.dataset.projectWorkspace = "true";
  const heading = node("h2");
  heading.id = `project-workspace-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const notice = node("p");
  notice.className = "project-workspace-notice";
  notice.setAttribute("role", "status");
  const refresh = button(pt("refresh"), "ghost");
  const closeButton = button(pt("close"), "ghost");
  refresh.dataset.projectAction = "refresh";
  closeButton.dataset.projectAction = "close";
  const header = node("header");
  const headerActions = node("div");
  headerActions.className = "project-workspace-header-actions";
  // One project picker and one tools menu: views and manual tools appear on demand, not as tabs.
  const projectPicker = document.createElement("select");
  projectPicker.className = "project-workspace-project-picker"; projectPicker.dataset.projectPicker = "true";
  const tools = node("details"); tools.className = "project-workspace-tools"; tools.dataset.projectTools = "true";
  const toolsSummary = node("summary"); const toolsMenu = node("div"); toolsMenu.className = "project-workspace-tools-menu"; toolsMenu.setAttribute("role", "menu");
  const gameTab = button(""); gameTab.dataset.projectView = "game";
  const planningTab = button(""); planningTab.dataset.projectView = "planning";
  const recordsTab = button(""); recordsTab.dataset.projectView = "records";
  const sourceLibrary = button(""); sourceLibrary.dataset.projectAction = "source-library";
  const reloadSources = button(""); reloadSources.dataset.projectAction = "reload-sources";
  for (const item of [gameTab, planningTab, recordsTab, sourceLibrary, reloadSources]) item.setAttribute("role", "menuitem");
  toolsMenu.append(gameTab, planningTab, recordsTab, sourceLibrary, reloadSources); tools.append(toolsSummary, toolsMenu);
  tools.addEventListener("keydown", event => { if (event.key === "Escape" && tools.open) { event.preventDefault(); event.stopPropagation(); tools.open = false; toolsSummary.focus(); } });
  headerActions.append(projectPicker, tools, refresh, closeButton);
  header.append(heading, notice, headerActions);
  const projectsPanel = node("aside");
  projectsPanel.className = "project-workspace-projects";
  const recordsPanel = node("section");
  recordsPanel.className = "project-workspace-records";
  const detailPanel = node("section");
  detailPanel.className = "project-workspace-detail";
  const layout = node("div");
  layout.className = "project-workspace-layout";
  layout.append(projectsPanel, recordsPanel, detailPanel);
  dialog.append(header, layout);
  document.body.append(dialog);

  let projects: Project[] = [];
  let selectedProject: Project | undefined;
  let objects: DevelopmentObject[] = [];
  let records: WorkRecord[] = [];
  let accesses: ProjectAccess[] = [];
  let selectedRecord: WorkRecord | undefined;
  let selectedRecordId: string | undefined;
  let recordHistory: RecordHistory[] = [];
  let projectDraft: ProjectDraft | undefined;
  let projectCreateMode = false;
  let recordDraft: RecordDraft | undefined;
  let detailMode: "summary" | "edit" | "new" = "summary";
  let objectDraft: ObjectDraft | undefined;
  let importDraft: ImportDraft | undefined;
  let filters: { query: string; status: RecordStatus | ""; includeArchived: boolean } = { query: "", status: "", includeArchived: false };
  let recordLoadVersion = 0;
  let requestVersion = 0;
  let searchTimer = 0;
  let mutationBusy = false;
  let workspaceView:"game"|"planning"|"records"="game";
  let recordOpenRequested=false;
  const planningView=createProjectPlanningView({
    openRecord:id=>{setWorkspaceView("records");void selectRecord(id);},onChanged:options.onChanged,
    focusEditor:value=>{dialog.dataset.planningFocus=String(value);},
    createRecord:(object,seed)=>{
      if(!selectedProject||object.project_id!==selectedProject.id)return;
      objects=[...objects.filter(item=>item.id!==object.id),object];
      setWorkspaceView("records");openNewRecord();
      if(recordDraft&&!recordDraft.fields.object_id&&(!recordDraft.fields.status||recordDraft.fields.status==="planned")&&!recordDraft.fields.title.trim()&&!recordDraft.fields.goal?.trim()&&!recordDraft.fields.result?.trim()&&!recordDraft.fields.scope?.trim()&&!recordDraft.fields.boundaries?.trim()&&!recordDraft.fields.next_step?.trim()&&!recordDraft.fields.references?.length){
        recordDraft.fields={...recordDraft.fields,title:object.name,
          ...seed,object_id:object.id,
          scope:`${object.name}\n${object.id}\n${planText("revision")} ${object.revision} · ${object.planning?.scopes.join(" / ") || ""}`};
        if(seed?.scope)recordDraft.fields.scope=seed.scope;
        saveRecordDraft(recordDraft);renderDetail();
      }else setNotice(planText("workDraftKept"));
    },
  });
  layout.append(planningView.element);
  const gameHome = createGameHome({
    openRecord: id => { setWorkspaceView("records"); void selectRecord(id); },
    onChanged: options.onChanged,
    openSkeleton: async (skeleton, documents, root, nodeId) => {
      if (!selectedProject) throw new Error("No project selected");
      const objectId = await options.onOpenSkeleton(selectedProject.id, selectedProject.name, root, skeleton, documents);
      closeWorkspace();
      window.dispatchEvent(new CustomEvent("spellcast:locate-canvas-object", { detail: { objectId, nodeId, activate: true } }));
    },
    openTool: view => setWorkspaceView(view),
    openSourceTable: async (loop, root) => {
      if (!selectedProject) throw new Error("No project selected");
      const objectId = await options.onOpenSourceTable(selectedProject.id, selectedProject.name, root, loop);
      closeWorkspace();
      window.dispatchEvent(new CustomEvent("spellcast:locate-canvas-object", { detail: { objectId } }));
    },
  });
  layout.append(gameHome.element);
  function setWorkspaceView(view:"game"|"planning"|"records",remember=true){
    workspaceView=view;
    if(remember&&selectedProject)writeLocal(`${PREFIX}.workspace-view.v3.${selectedProject.id}`,view);
    tools.open=false;
    render();
  }
  gameTab.addEventListener("click",()=>{recordOpenRequested=false;setWorkspaceView("game");gameHome.showGame();void gameHome.refresh(false);});
  planningTab.addEventListener("click",()=>{recordOpenRequested=false;setWorkspaceView("planning");void planningView.refresh();});
  recordsTab.addEventListener("click",()=>setWorkspaceView("records"));
  sourceLibrary.addEventListener("click",()=>{recordOpenRequested=false;setWorkspaceView("game");gameHome.showSources();});
  reloadSources.addEventListener("click",()=>{recordOpenRequested=false;setWorkspaceView("game");void gameHome.refresh(true);});
  projectPicker.addEventListener("change",()=>{ if(projectPicker.value) void selectProject(projectPicker.value); });

  function setNotice(value = "") {
    notice.textContent = value;
    notice.hidden = !value;
  }

  function storageWarning() {
    setNotice(pt("draftStorageFailed"));
  }

  function saveRecordDraft(draft: RecordDraft) {
    if (!writeLocal(recordDraftKey(draft.projectId, draft.recordId), draft)) storageWarning();
  }

  function storedRecordDraft(projectId: string, record?: WorkRecord): RecordDraft | undefined {
    const saved = readLocal<RecordDraft>(recordDraftKey(projectId, record?.id));
    if (saved && saved.projectId === projectId && (saved.recordId || undefined) === (record?.id || undefined) && saved.fields && typeof saved.fields.title === "string" && typeof saved.baseRevision === "number") {
      return { ...saved, fields: copyFields(saved.fields) };
    }
    return undefined;
  }

  function loadRecordDraft(projectId: string, record?: WorkRecord): RecordDraft {
    const saved = storedRecordDraft(projectId, record);
    if (saved) return saved;
    return {
      projectId,
      recordId: record?.id,
      baseRevision: record?.revision || 0,
      fields: copyFields(record || emptyFields()),
    };
  }

  function saveProjectDraft(draft: ProjectDraft) {
    if (!writeLocal(projectDraftKey(draft.id), draft)) storageWarning();
  }

  function loadProjectDraft(project?: Project): ProjectDraft {
    const id = project?.id || "new";
    const saved = readLocal<ProjectDraft>(projectDraftKey(id));
    if (saved && saved.id === id && typeof saved.name === "string" && Array.isArray(saved.aliases) && typeof saved.baseRevision === "number") return { ...saved, aliases: [...saved.aliases] };
    return { id, baseRevision: project?.revision || 0, name: project?.name || "", aliases: [...(project?.aliases || [])], archived: Boolean(project?.archived) };
  }

  function saveObjectDraft(draft: ObjectDraft) {
    if (!writeLocal(objectDraftKey(draft.projectId), draft)) storageWarning();
  }

  function loadObjectDraft(projectId: string): ObjectDraft {
    const saved = readLocal<ObjectDraft>(objectDraftKey(projectId));
    if (saved && saved.projectId === projectId && typeof saved.name === "string" && typeof saved.kind === "string" && typeof saved.id === "string") return saved;
    return { id: crypto.randomUUID(), projectId, name: "", kind: "feature" };
  }

  function loadImportDraft(): ImportDraft {
    const saved = readLocal<ImportDraft>(importDraftKey());
    if (saved && typeof saved.name === "string" && typeof saved.bundleText === "string" && typeof saved.targetProjectId === "string" && typeof saved.createRequestId === "string" && typeof saved.importRequestId === "string") return saved;
    return { name: "", bundleText: "", targetProjectId: crypto.randomUUID(), createRequestId: newProjectRequestId(), importRequestId: newProjectRequestId(), projectCreated: false };
  }

  function persistImportDraft() {
    if (importDraft && !writeLocal(importDraftKey(), importDraft)) storageWarning();
  }

  function requestIdFor(key: string) {
    const localKey = mutationKey(key);
    const saved = readLocal<string>(localKey);
    if (typeof saved === "string" && saved) return saved;
    const requestId = newProjectRequestId();
    if (!writeLocal(localKey, requestId)) storageWarning();
    return requestId;
  }

  function clearRequestId(key: string) {
    removeLocal(mutationKey(key));
  }

  function persistSelectedRecord(projectId: string, recordId: string) {
    try { localStorage.setItem(`${PREFIX}.last-record.${projectId}`, recordId); } catch { /* The selection remains available for this open window. */ }
  }

  function statusOptions(select: HTMLSelectElement, includeAll = true) {
    if (includeAll) {
      const all = node("option", pt("statusAll")); all.value = ""; select.append(all);
    }
    for (const status of STATUS) {
      const option = node("option", statusText(status)); option.value = status; select.append(option);
    }
  }

  function setControlBusy(control: HTMLButtonElement) {
    control.disabled = mutationBusy;
  }

  function renderProjects() {
    projectsPanel.replaceChildren();
    const top = node("div"); top.className = "project-workspace-panel-head";
    top.append(node("h3", pt("projectList")));
    const newButton = button(pt("newProject"), "primary");
    newButton.dataset.projectAction = "new";
    newButton.disabled = mutationBusy;
    newButton.addEventListener("click", () => {
      projectCreateMode = true;
      projectDraft = loadProjectDraft();
      renderProjects();
    });
    top.append(newButton);
    projectsPanel.append(top);
    const list = node("nav"); list.className = "project-workspace-project-list";
    if (!projects.length) list.append(node("p", pt("noProjects")));
    for (const project of projects) {
      const item = button(project.name || project.id, "project-workspace-project-item");
      item.dataset.projectId = project.id;
      item.setAttribute("aria-current", String(project.id === selectedProject?.id));
      if (project.archived) item.dataset.archived = "true";
      item.title = `${project.name}\n${project.id}`;
      item.addEventListener("click", () => { void selectProject(project.id); });
      const meta = node("small", `${pt("revision")} ${project.revision}${project.archived ? ` · ${pt("archived")}` : ""}`);
      item.append(meta);
      list.append(item);
    }
    projectsPanel.append(list);

    if (selectedProject || projectCreateMode) {
      const editing = projectCreateMode ? undefined : selectedProject;
      projectDraft ??= loadProjectDraft(editing);
      const draft = projectDraft;
      const box = node("details"); box.className = "project-workspace-project-editor";
      box.open = projectCreateMode;
      box.append(node("summary", editing ? pt("projectSettings") : pt("newProject")));
      const form = document.createElement("form");
      form.noValidate = true;
      const name = makeInput(draft.name) as HTMLInputElement;
      name.required = true; name.name = "project-name"; name.dataset.projectName = "true";
      name.addEventListener("input", () => { draft.name = name.value; saveProjectDraft(draft); });
      form.append(field(pt("projectName"), name));
      const aliasDetails = node("details");
      const summary = node("summary", pt("aliases"));
      const aliases = makeInput(draft.aliases.join("\n"), true) as HTMLTextAreaElement;
      aliases.rows = 3;
      aliases.addEventListener("input", () => { draft.aliases = aliases.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean); saveProjectDraft(draft); });
      aliasDetails.append(summary, node("p", pt("aliasesHint")), aliases, node("p", pt("aliasesWarning")));
      form.append(aliasDetails);
      if (editing) {
        const archived = document.createElement("input"); archived.type = "checkbox"; archived.checked = draft.archived;
        archived.addEventListener("change", () => { draft.archived = archived.checked; saveProjectDraft(draft); });
        const toggle = node("label"); toggle.className = "project-workspace-check"; toggle.append(archived, node("span", pt("projectArchived")));
        form.append(toggle);
      }
      const actions = node("div"); actions.className = "project-workspace-actions";
      const save = button(editing ? pt("saveProject") : pt("createProject"), "primary"); save.type = "submit"; setControlBusy(save);
      save.dataset.projectAction = editing ? "save" : "create";
      const discard = button(pt("discardDraft")); setControlBusy(discard);
      discard.addEventListener("click", () => {
        removeLocal(projectDraftKey(draft.id));
        projectDraft = loadProjectDraft(editing);
        setNotice(pt("draftDiscarded"));
        renderProjects();
      });
      actions.append(save, discard); form.append(actions);
      form.addEventListener("submit", event => { event.preventDefault(); void saveProject(); });
      box.append(form);
      projectsPanel.append(box);
    }
  }

  function renderRecords() {
    recordsPanel.replaceChildren();
    const top = node("div"); top.className = "project-workspace-panel-head";
    top.append(node("h3", pt("records")));
    const newButton = button(pt("newRecord"), "primary");
    newButton.dataset.recordAction = "new";
    newButton.disabled = !selectedProject || mutationBusy;
    newButton.addEventListener("click", () => openNewRecord());
    top.append(newButton);
    recordsPanel.append(top);
    if (!selectedProject) { recordsPanel.append(node("p", pt("noProjectSelected"))); return; }
    recordsPanel.append(node("p", pt("recordsHelp")));
    const controls = node("div"); controls.className = "project-workspace-filters";
    const search = makeInput(filters.query) as HTMLInputElement;
    search.type = "search"; search.placeholder = pt("searchRecords"); search.dataset.recordSearch = "true";
    search.addEventListener("input", () => {
      filters.query = search.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void refreshSelectedProject(), 180);
    });
    const status = document.createElement("select"); status.dataset.recordStatus = "true"; statusOptions(status); status.value = filters.status;
    status.addEventListener("change", () => { filters.status = status.value as RecordStatus | ""; void refreshSelectedProject(); });
    const archived = document.createElement("input"); archived.type = "checkbox"; archived.checked = filters.includeArchived; archived.dataset.recordArchived = "true";
    archived.addEventListener("change", () => { filters.includeArchived = archived.checked; void refreshSelectedProject(); });
    const archiveLabel = node("label"); archiveLabel.className = "project-workspace-check"; archiveLabel.append(archived, node("span", pt("showArchived")));
    controls.append(search, status, archiveLabel); recordsPanel.append(controls);
    const list = node("div"); list.className = "project-workspace-record-list";
    if (!records.length) list.append(node("p", pt("noRecords")));
    for (const record of records) {
      const item = button("", "project-workspace-record-item");
      item.dataset.recordId = record.id;
      item.setAttribute("aria-current", String(record.id === selectedRecordId));
      if (record.archived) item.dataset.archived = "true";
      const itemTop = node("span"); itemTop.className = "project-workspace-record-item-top";
      itemTop.append(node("strong", record.title || record.id), node("small", statusText(record.status)));
      item.append(itemTop, node("small", `${pt("updated")} ${formatDate(record.updated_at_ms)}`));
      item.addEventListener("click", () => { void selectRecord(record.id); });
      list.append(item);
    }
    recordsPanel.append(list);
  }

  function updateDraftText(draft: RecordDraft, key: "title" | "goal" | "scope" | "result" | "boundaries" | "next_step", control: HTMLInputElement | HTMLTextAreaElement) {
    control.addEventListener("input", () => { draft.fields[key] = control.value; saveRecordDraft(draft); });
  }

  function renderReferences(draft: RecordDraft, container: HTMLElement) {
    container.replaceChildren();
    const references = draft.fields.references || [];
    if (!references.length) container.append(node("p", pt("referencesHelp")));
    references.forEach((reference, index) => {
      const row = node("div"); row.className = "project-workspace-reference";
      const label = makeInput(reference.label) as HTMLInputElement; label.placeholder = pt("refLabel");
      const uri = makeInput(reference.uri) as HTMLInputElement; uri.placeholder = pt("refUri"); uri.type = "url";
      const version = makeInput(reference.version) as HTMLInputElement; version.placeholder = pt("refVersion");
      const apply = () => { const target = draft.fields.references![index]; target.label = label.value; target.uri = uri.value; target.version = version.value; saveRecordDraft(draft); };
      label.addEventListener("input", apply); uri.addEventListener("input", apply); version.addEventListener("input", apply);
      const remove = button(pt("removeReference"));
      remove.addEventListener("click", () => { draft.fields.references!.splice(index, 1); saveRecordDraft(draft); renderDetail(); });
      row.append(label, uri, version, remove); container.append(row);
    });
    const add = button(pt("addReference"));
    add.addEventListener("click", () => { draft.fields.references ??= []; draft.fields.references.push({ label: "", uri: "", version: "" }); saveRecordDraft(draft); renderDetail(); });
    container.append(add);
  }

  function renderObjectCreator(draft: RecordDraft, container: HTMLElement) {
    if (!selectedProject) return;
    objectDraft ??= loadObjectDraft(selectedProject.id);
    const object = objectDraft;
    container.replaceChildren();
    container.append(node("p", pt("objectPickerHelp")));
    const name = makeInput(object.name) as HTMLInputElement; name.placeholder = pt("objectName"); name.dataset.objectName = "true";
    const kind = makeInput(object.kind) as HTMLInputElement; kind.placeholder = pt("objectKind"); kind.dataset.objectKind = "true";
    name.addEventListener("input", () => { object.name = name.value; saveObjectDraft(object); });
    kind.addEventListener("input", () => { object.kind = kind.value; saveObjectDraft(object); });
    const create = button(pt("createObject")); create.dataset.objectAction = "create"; setControlBusy(create);
    create.addEventListener("click", () => { void createObject(draft); });
    container.append(field(pt("objectName"), name), field(pt("objectKind"), kind), create);
  }

  function renderHistory() {
    const box = node("details"); box.className = "project-workspace-history";
    box.append(node("summary", pt("history")));
    if (!selectedRecord) { box.append(node("p", pt("noHistory"))); return box; }
    if (!recordHistory.length) box.append(node("p", pt("noHistory")));
    for (const entry of recordHistory) {
      const row = node("article"); row.className = "project-workspace-history-row";
      const title = snapshotTitle(entry.snapshot) || selectedRecord.title || entry.id;
      const meta = `${pt("revision")} ${entry.revision} · ${formatDate(entry.at_ms)} · ${entry.actor.label || entry.actor.kind}`;
      row.append(node("strong", title), node("small", meta), node("p", entry.operation));
      if (entry.revision !== selectedRecord.revision) {
        const restore = button(pt("restore")); restore.dataset.restoreRevision = String(entry.revision); setControlBusy(restore);
        restore.addEventListener("click", () => { void restoreRecord(entry.revision); }); row.append(restore);
      } else row.append(node("small", pt("historyCurrent")));
      box.append(row);
    }
    return box;
  }

  function renderAccess() {
    const box = node("details"); box.className = "project-workspace-access";
    box.append(node("summary", pt("access")), node("p", pt("accessHelp")), node("p", pt("aliasesWarning")), node("p", pt("accessNoToken")));
    if (!accesses.length) box.append(node("p", pt("noAccess")));
    for (const access of accesses) {
      const row = node("article"); row.className = "project-workspace-access-row";
      const label = node("strong", access.label || access.source_id);
      const status = node("span", access.state === "approved" ? pt("accessApproved") : access.state === "revoked" ? pt("accessRevoked") : pt("accessPending"));
      status.className = "project-workspace-status"; status.dataset.state = access.state;
      row.append(label, status, node("small", `${pt("taskId")}: ${access.thread_id}`), node("small", `${pt("source")}: ${access.source_id}`), node("small", `${pt("cwd")}: ${access.cwd || "—"}`));
      if (access.state !== "approved") {
        const approve = button(pt("approve")); approve.dataset.accessAction = "approve"; setControlBusy(approve);
        approve.addEventListener("click", () => { void updateAccess(access, "approved"); }); row.append(approve);
      }
      if (access.state !== "revoked") {
        const revoke = button(pt("revoke")); revoke.dataset.accessAction = "revoke"; setControlBusy(revoke);
        revoke.addEventListener("click", () => { void updateAccess(access, "revoked"); }); row.append(revoke);
      }
      box.append(row);
    }
    return box;
  }

  function renderExports() {
    const box = node("details"); box.className = "project-workspace-exports";
    box.append(node("summary", pt("exports")), node("p", pt("externalFiles")));
    const actions = node("div"); actions.className = "project-workspace-actions";
    const json = button(pt("exportJson")); json.dataset.export = "json";
    const markdown = button(pt("exportMarkdown")); markdown.dataset.export = "markdown";
    json.addEventListener("click", () => { void downloadJson(); });
    markdown.addEventListener("click", () => { void downloadMarkdown(); });
    actions.append(json, markdown); box.append(actions);
    importDraft ??= loadImportDraft();
    const draft = importDraft;
    const importBox = node("div"); importBox.className = "project-workspace-import";
    importBox.append(node("h4", pt("importJson")), node("p", pt("importHelp")));
    const name = makeInput(draft.name) as HTMLInputElement; name.placeholder = pt("importName"); name.dataset.importName = "true";
    name.addEventListener("input", () => { draft.name = name.value; persistImportDraft(); });
    const file = document.createElement("input"); file.type = "file"; file.accept = "application/json,.json"; file.dataset.importFile = "true";
    file.addEventListener("change", () => { void readImportFile(file); });
    const importButton = button(pt("importJson"), "primary"); importButton.dataset.importAction = "submit"; setControlBusy(importButton);
    importButton.addEventListener("click", () => { void importBundle(); });
    importBox.append(field(pt("importName"), name), field(pt("chooseJson"), file), importButton);
    if (draft.bundleText) importBox.append(node("small", pt("draftKept")));
    box.append(importBox);
    return box;
  }

  function recordSummaryValue(label: string, value: string | undefined) {
    const row = node("section"); row.className = "project-workspace-summary-value";
    row.append(node("h4", label), node("p", value?.trim() || pt("noValue")));
    return row;
  }

  function renderRecordSummary(record: WorkRecord) {
    const summary = node("article"); summary.className = "project-workspace-record-summary";
    const top = node("div"); top.className = "project-workspace-panel-head";
    const headingGroup = node("div"); headingGroup.className = "project-workspace-summary-heading";
    headingGroup.append(node("small", pt("savedRecord")), node("h3", record.title || record.id));
    const state = node("span", statusText(record.status)); state.className = "project-workspace-status"; state.dataset.state = record.archived ? "archived" : "current";
    top.append(headingGroup, state); summary.append(top);
    const metadata = node("div"); metadata.className = "project-workspace-summary-meta";
    metadata.append(
      node("small", `${pt("createdAt")}: ${formatDate(record.created_at_ms)}`),
      node("small", `${pt("updatedAt")}: ${formatDate(record.updated_at_ms)}`),
      node("small", `${pt("revision")}: ${record.revision}`),
      node("small", `${pt("updatedBy")}: ${record.updated_by.label || record.updated_by.kind}`),
    );
    summary.append(metadata);
    const fields = node("div"); fields.className = "project-workspace-summary-fields";
    fields.append(recordSummaryValue(pt("result"), record.result), recordSummaryValue(pt("boundaries"), record.boundaries), recordSummaryValue(pt("nextStep"), record.next_step));
    summary.append(fields);
    const context = node("details"); context.className = "project-workspace-summary-context";
    context.append(node("summary", pt("context")), recordSummaryValue(pt("goal"), record.goal), recordSummaryValue(pt("scope"), record.scope));
    const selectedObject = record.object_id ? objects.find(item => item.id === record.object_id) : undefined;
    context.append(recordSummaryValue(pt("object"), selectedObject?.name || record.object_id || undefined));
    const references = node("section"); references.className = "project-workspace-summary-references";
    references.append(node("h4", pt("references")));
    if (!record.references?.length) references.append(node("p", pt("noValue")));
    for (const reference of record.references || []) {
      const row = node("div"); row.className = "project-workspace-summary-reference";
      row.append(node("strong", reference.label), node("small", reference.uri));
      if (reference.version) row.append(node("small", reference.version));
      references.append(row);
    }
    context.append(references); summary.append(context);
    const localDraft = selectedProject ? storedRecordDraft(selectedProject.id, record) : undefined;
    if (localDraft) {
      const draftNotice = node("div"); draftNotice.className = "project-workspace-local-draft";
      draftNotice.append(node("p", pt("localDraftAvailable")));
      const continueDraft = button(pt("continueDraft")); continueDraft.dataset.recordAction = "continue-draft"; setControlBusy(continueDraft);
      continueDraft.addEventListener("click", openRecordEditor); draftNotice.append(continueDraft); summary.append(draftNotice);
    }
    const actions = node("div"); actions.className = "project-workspace-actions";
    const edit = button(pt("edit"), "primary"); edit.dataset.recordAction = "edit"; setControlBusy(edit); edit.addEventListener("click", openRecordEditor);
    const archive = button(record.archived ? pt("unarchive") : pt("archive")); archive.dataset.recordAction = record.archived ? "unarchive" : "archive"; setControlBusy(archive);
    archive.addEventListener("click", () => { void archiveRecord(!record.archived); });
    const pin = button(pt("pinCanvas")); pin.dataset.recordAction = "pin"; setControlBusy(pin); pin.addEventListener("click", () => { void pinRecord(); });
    actions.append(edit, archive, pin); summary.append(actions);
    return summary;
  }

  function renderDetail() {
    detailPanel.replaceChildren();
    if (!selectedProject) { detailPanel.append(node("p", pt("noProjectSelected"))); return; }
    if (selectedRecord && detailMode === "summary") {
      detailPanel.append(renderRecordSummary(selectedRecord), renderHistory(), renderExports(), renderAccess());
      return;
    }
    if (!recordDraft) {
      const empty = node("div"); empty.className = "project-workspace-empty-detail";
      empty.append(node("h3", pt("editRecord")), node("p", pt("noRecordSelected")));
      const add = button(pt("newRecord"), "primary"); add.addEventListener("click", openNewRecord); empty.append(add); detailPanel.append(empty);
      detailPanel.append(renderExports(), renderAccess());
      return;
    }
    const draft = recordDraft;
    const form = document.createElement("form"); form.className = "project-workspace-record-editor"; form.noValidate = true;
    const top = node("div"); top.className = "project-workspace-panel-head"; top.append(node("h3", detailMode === "new" ? pt("newRecord") : pt("editRecord")));
    const title = makeInput(draft.fields.title) as HTMLInputElement; title.required = true; title.dataset.recordTitle = "true"; title.placeholder = pt("recordTitle");
    updateDraftText(draft, "title", title); form.append(top, field(pt("recordTitle"), title));
    const optional = node("details"); optional.className = "project-workspace-optional";
    optional.append(node("summary", pt("optionalFields")));
    const status = document.createElement("select"); status.dataset.recordEditStatus = "true"; statusOptions(status, false); status.value = draft.fields.status || "planned";
    status.addEventListener("change", () => { draft.fields.status = status.value as RecordStatus; saveRecordDraft(draft); });
    optional.append(field(pt("status"), status));
    const object = document.createElement("select"); object.dataset.recordObject = "true";
    const none = node("option", pt("objectNone")); none.value = ""; object.append(none);
    for (const item of objects) {
      const option = node("option", `${item.name}${item.archived ? ` · ${pt("objectArchived")}` : ""}`); option.value = item.id; option.disabled = item.archived && item.id !== draft.fields.object_id; object.append(option);
    }
    object.value = draft.fields.object_id || "";
    object.addEventListener("change", () => { draft.fields.object_id = object.value || null; saveRecordDraft(draft); });
    optional.append(field(pt("object"), object));
    for (const [key, label] of [["goal", "goal"], ["scope", "scope"], ["result", "result"], ["boundaries", "boundaries"], ["next_step", "nextStep"]] as const) {
      const control = makeInput(draft.fields[key] || "", true) as HTMLTextAreaElement;
      control.dataset.recordField = key;
      updateDraftText(draft, key, control); optional.append(field(pt(label), control));
    }
    const refs = node("div"); refs.className = "project-workspace-references";
    const refList = node("div"); refList.className = "project-workspace-reference-list";
    refs.append(node("h4", pt("references")), node("p", pt("referencesHelp")), refList); renderReferences(draft, refList); optional.append(refs);
    const objectCreator = node("details"); objectCreator.append(node("summary", pt("objectCreate")));
    const objectContent = node("div"); objectContent.className = "project-workspace-object-create"; renderObjectCreator(draft, objectContent); objectCreator.append(objectContent); optional.append(objectCreator);
    form.append(optional, node("p", pt("draftKept")));
    const actions = node("div"); actions.className = "project-workspace-actions";
    const save = button(pt("saveRecord"), "primary"); save.type = "submit"; save.dataset.recordAction = "save"; setControlBusy(save);
    const discard = button(pt("discardDraft")); discard.dataset.recordAction = "discard"; setControlBusy(discard);
    discard.addEventListener("click", () => {
      removeLocal(recordDraftKey(draft.projectId, draft.recordId));
      recordDraft = loadRecordDraft(draft.projectId, selectedRecord);
      setNotice(pt("draftDiscarded")); renderDetail();
    });
    actions.append(save, discard); form.append(actions);
    form.addEventListener("submit", event => { event.preventDefault(); void saveRecord(); });
    detailPanel.append(form, renderHistory(), renderExports(), renderAccess());
  }

  function render() {
    heading.textContent = selectedProject ? `${pt("gameDevelopment")} · ${selectedProject.name}` : pt("gameDevelopment");
    refresh.textContent = pt("refresh"); closeButton.textContent = pt("close");
    refresh.disabled = mutationBusy;
    toolsSummary.textContent = gh("tools"); toolsSummary.setAttribute("aria-label", gh("toolsLabel"));
    gameTab.textContent = gh("backToGame"); planningTab.textContent = gh("planningTool"); recordsTab.textContent = gh("recordsTool"); reloadSources.textContent = gh("reloadSources");
    sourceLibrary.textContent = gh("sourceLibrary"); sourceLibrary.disabled = !selectedProject;
    planningTab.disabled = !selectedProject; gameTab.disabled = !selectedProject; reloadSources.disabled = !selectedProject;
    // Without a project there is nothing to show but the project list, where projects are created.
    const shown = selectedProject ? workspaceView : "records";
    for (const [item, view] of [[gameTab, "game"], [planningTab, "planning"], [recordsTab, "records"]] as const) item.setAttribute("aria-pressed", String(shown === view));
    projectPicker.replaceChildren(...projects.map(project => { const option = node("option", project.name || project.id); option.value = project.id; return option; }));
    projectPicker.value = selectedProject?.id || ""; projectPicker.hidden = projects.length < 2; projectPicker.setAttribute("aria-label", gh("projectLabel"));
    dialog.dataset.workspaceView=shown;
    projectsPanel.hidden = shown === "game";
    recordsPanel.hidden=shown!=="records";detailPanel.hidden=shown!=="records";planningView.element.hidden=shown!=="planning";
    gameHome.element.hidden = shown !== "game";
    gameHome.visible(shown === "game" && dialog.open);
    renderProjects(); renderRecords(); renderDetail();
    void planningView.setProject(selectedProject);
    if (workspaceView === "game" || !selectedProject) void gameHome.setProject(selectedProject);
  }

  async function runMutation(work: () => Promise<void>) {
    if (mutationBusy) return;
    mutationBusy = true; render();
    try { await work(); }
    finally { mutationBusy = false; render(); }
  }

  async function reloadProjects(preferredProjectId?: string, preferredRecordId?: string) {
    const version = ++requestVersion;
    setNotice(pt("loading"));
    try {
      projects = await fetchProjects();
      if (version !== requestVersion) return;
      const stored = (() => { try { return localStorage.getItem(`${PREFIX}.last-project`) || undefined; } catch { return undefined; } })();
      const target = preferredProjectId || selectedProject?.id || stored || projects.find(project => !project.archived)?.id || projects[0]?.id;
      const storedRecord = target ? (() => { try { return localStorage.getItem(`${PREFIX}.last-record.${target}`) || undefined; } catch { return undefined; } })() : undefined;
      if (target) await selectProject(target, preferredRecordId || storedRecord, false);
      else {
        selectedProject = undefined; objects = []; records = []; accesses = []; selectedRecord = undefined; selectedRecordId = undefined; recordDraft = undefined; detailMode = "summary"; recordHistory = [];
        setNotice(""); render();
      }
    } catch (error) {
      if (version === requestVersion) { setNotice(`${pt("error")} ${asError(error)}`); render(); }
    }
  }

  async function selectProject(projectId: string, wantedRecordId?: string, announce = true) {
    const project = projects.find(item => item.id === projectId);
    if (!project) return;
    const changed = selectedProject?.id !== projectId;
    selectedProject = project;
    if (changed) {
      const savedView=readLocal<string>(`${PREFIX}.workspace-view.v3.${projectId}`);
      workspaceView=recordOpenRequested?"records":savedView==="records"?"records":savedView==="planning"?"planning":"game";
      const storedRecord = (() => { try { return localStorage.getItem(`${PREFIX}.last-record.${projectId}`) || undefined; } catch { return undefined; } })();
      projectCreateMode = false; projectDraft = undefined; objectDraft = undefined; recordDraft = undefined; detailMode = "summary"; selectedRecord = undefined; selectedRecordId = wantedRecordId || storedRecord; recordHistory = [];
      try { localStorage.setItem(`${PREFIX}.last-project`, projectId); } catch { /* Project selection does not need local storage. */ }
    } else if (wantedRecordId !== undefined) selectedRecordId = wantedRecordId;
    if (announce) setNotice(pt("loading"));
    render();
    await refreshSelectedProject();
  }

  async function refreshSelectedProject() {
    if (!selectedProject) return;
    const projectId = selectedProject.id;
    const version = ++requestVersion;
    try {
      const results = await Promise.allSettled([
        fetchProjectObjects(projectId),
        fetchProjectRecords(projectId, filters),
        fetchProjectAccess(projectId),
      ]);
      if (version !== requestVersion || selectedProject?.id !== projectId) return;
      const [objectResult, recordResult, accessResult] = results;
      objects = objectResult.status === "fulfilled" ? objectResult.value : [];
      records = recordResult.status === "fulfilled" ? recordResult.value : [];
      accesses = accessResult.status === "fulfilled" ? accessResult.value : [];
      const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult | undefined;
      if (failure) setNotice(`${pt("error")} ${asError(failure.reason)}`); else setNotice("");
      const wanted = selectedRecordId;
      selectedRecord = wanted ? records.find(record => record.id === wanted) : undefined;
      render();
      if (wanted) await loadSelectedRecord(wanted);
    } catch (error) {
      if (version === requestVersion) { setNotice(`${pt("error")} ${asError(error)}`); render(); }
    }
  }

  async function selectRecord(recordId: string) {
    if (!selectedProject) return;
    workspaceView="records";
    recordOpenRequested=true;
    selectedRecordId = recordId;
    selectedRecord = records.find(record => record.id === recordId);
    recordDraft = undefined;
    detailMode = "summary";
    recordHistory = [];
    persistSelectedRecord(selectedProject.id, recordId);
    render();
    await loadSelectedRecord(recordId);
  }

  async function loadSelectedRecord(recordId: string) {
    if (!selectedProject || selectedRecordId !== recordId) return;
    const projectId = selectedProject.id;
    const version = ++recordLoadVersion;
    const [recordResult, historyResult] = await Promise.allSettled([
      fetchProjectRecord(projectId, recordId),
      fetchProjectHistory(projectId, "record", recordId),
    ]);
    if (version !== recordLoadVersion || selectedProject?.id !== projectId || selectedRecordId !== recordId) return;
    if (recordResult.status === "fulfilled") {
      selectedRecord = recordResult.value;
      const index = records.findIndex(record => record.id === recordId);
      if (index >= 0) records[index] = selectedRecord; else records.unshift(selectedRecord);
    } else {
      selectedRecord = undefined;
      recordDraft = undefined;
      detailMode = "summary";
      setNotice(`${pt("recordUnavailable")} ${asError(recordResult.reason)}`);
    }
    recordHistory = historyResult.status === "fulfilled" ? historyResult.value : [];
    render();
  }

  function openRecordEditor() {
    if (!selectedProject || !selectedRecord || mutationBusy) return;
    recordDraft = loadRecordDraft(selectedProject.id, selectedRecord);
    detailMode = "edit";
    render();
    detailPanel.querySelector<HTMLInputElement>("[data-record-title]")?.focus();
  }

  function openNewRecord() {
    if (!selectedProject || mutationBusy) return;
    selectedRecordId = undefined; selectedRecord = undefined; recordHistory = [];
    recordDraft = loadRecordDraft(selectedProject.id);
    detailMode = "new";
    render();
    const input = detailPanel.querySelector<HTMLInputElement>("[data-record-title]"); input?.focus();
  }

  async function saveProject() {
    const draft = projectDraft;
    if (!draft || mutationBusy) return;
    const name = draft.name.trim();
    if (!name) { setNotice(pt("titleRequired")); render(); return; }
    const aliases = [...new Set(draft.aliases.map(alias => alias.trim()).filter(Boolean))];
    const isNew = draft.id === "new";
    if (isNew) {
      draft.id = crypto.randomUUID();
      removeLocal(projectDraftKey("new"));
      saveProjectDraft(draft);
    }
    const body = isNew
      ? { project_id: draft.id, op: "create_project" as const, name, aliases }
      : { project_id: draft.id, op: "update_project" as const, expected_revision: draft.baseRevision, name, aliases, archived: draft.archived };
    const fingerprint = JSON.stringify(body);
    const requestId = draft.pending?.fingerprint === fingerprint ? draft.pending.requestId : newProjectRequestId();
    draft.pending = { requestId, fingerprint }; draft.name = name; draft.aliases = aliases; saveProjectDraft(draft);
    await runMutation(async () => {
      try {
        const result = await mutateProject({ ...body, request_id: requestId } as RecordCommand);
        removeLocal(projectDraftKey(draft.id));
        projectDraft = undefined; projectCreateMode = false;
        setNotice(pt("saved")); options.onChanged();
        await reloadProjects(result.project?.id || draft.id);
      } catch (error) {
        setNotice(`${isConflict(error) ? pt("conflictDraft") : pt("error")} ${asError(error)}`);
      }
    });
  }

  async function saveRecord() {
    const draft = recordDraft;
    const project = selectedProject;
    if (!draft || !project || mutationBusy) return;
    const fields = copyFields(draft.fields);
    fields.title = fields.title.trim();
    if (!fields.title) { setNotice(pt("titleRequired")); render(); return; }
    const references = normalizeReferences(fields.references || []);
    if (!references) { setNotice(pt("invalidReference")); render(); return; }
    fields.references = references;
    const id = draft.recordId || draft.createdId || crypto.randomUUID();
    if (!draft.recordId) draft.createdId = id;
    const body = { project_id: project.id, op: "put_record" as const, id, expected_revision: draft.baseRevision, fields };
    const fingerprint = JSON.stringify(body);
    const previous = draft.pending;
    const requestId = previous?.fingerprint === fingerprint ? previous.requestId : newProjectRequestId();
    draft.pending = { requestId, fingerprint }; draft.fields = fields; saveRecordDraft(draft);
    if (previous && previous.fingerprint !== fingerprint) setNotice(pt("uncertainSave"));
    await runMutation(async () => {
      try {
        const result = await mutateProject({ ...body, request_id: requestId });
        removeLocal(recordDraftKey(draft.projectId, draft.recordId));
        recordDraft = undefined;
        selectedRecord = result.record;
        selectedRecordId = result.record?.id || id;
        detailMode = "summary";
        persistSelectedRecord(project.id, selectedRecordId);
        setNotice(pt("saved")); options.onChanged();
        await refreshSelectedProject();
        if (selectedRecordId) await loadSelectedRecord(selectedRecordId);
      } catch (error) {
        setNotice(`${isConflict(error) ? pt("conflictDraft") : pt("error")} ${asError(error)}`);
      }
    });
  }

  async function createObject(draft: RecordDraft) {
    const project = selectedProject;
    const object = objectDraft;
    if (!project || !object || mutationBusy) return;
    const name = object.name.trim();
    const kind = object.kind.trim();
    if (!name || !kind) { setNotice(pt("objectName")); return; }
    const body = { project_id: project.id, op: "put_object" as const, id: object.id, expected_revision: 0, name, kind, archived: false };
    const fingerprint = JSON.stringify(body);
    const requestId = object.pending?.fingerprint === fingerprint ? object.pending.requestId : newProjectRequestId();
    object.pending = { requestId, fingerprint }; object.name = name; object.kind = kind; saveObjectDraft(object);
    await runMutation(async () => {
      try {
        const result = await mutateProject({ ...body, request_id: requestId });
        removeLocal(objectDraftKey(project.id));
        objectDraft = loadObjectDraft(project.id);
        if (result.object) {
          objects = [...objects.filter(item => item.id !== result.object!.id), result.object];
          draft.fields.object_id = result.object.id; saveRecordDraft(draft);
        }
        setNotice(pt("saved")); options.onChanged();
      } catch (error) {
        setNotice(`${isConflict(error) ? pt("conflictDraft") : pt("error")} ${asError(error)}`);
      }
    });
  }

  async function archiveRecord(archived: boolean) {
    const project = selectedProject, record = selectedRecord;
    if (!project || !record || mutationBusy) return;
    const key = `archive:${project.id}:${record.id}:${record.revision}:${archived}`;
    const requestId = requestIdFor(key);
    await runMutation(async () => {
      try {
        const result = await mutateProject({ request_id: requestId, project_id: project.id, op: "archive_record", id: record.id, expected_revision: record.revision, archived });
        clearRequestId(key);
        if (result.record) selectedRecord = result.record;
        setNotice(pt("saved")); options.onChanged();
        await refreshSelectedProject();
      } catch (error) {
        setNotice(`${isConflict(error) ? pt("conflictDraft") : pt("error")} ${asError(error)}`);
      }
    });
  }

  async function restoreRecord(revision: number) {
    const project = selectedProject, record = selectedRecord;
    if (!project || !record || mutationBusy) return;
    const key = `restore:${project.id}:${record.id}:${record.revision}:${revision}`;
    const requestId = requestIdFor(key);
    await runMutation(async () => {
      try {
        const result = await mutateProject({ request_id: requestId, project_id: project.id, op: "restore_record", id: record.id, expected_revision: record.revision, restore_revision: revision });
        clearRequestId(key);
        if (result.record) selectedRecord = result.record;
        setNotice(pt("restored")); options.onChanged();
        await refreshSelectedProject();
        if (selectedRecordId) await loadSelectedRecord(selectedRecordId);
      } catch (error) {
        setNotice(`${isConflict(error) ? pt("conflictDraft") : pt("error")} ${asError(error)}`);
      }
    });
  }

  async function pinRecord() {
    const project = selectedProject, record = selectedRecord;
    if (!project || !record || mutationBusy) return;
    const key = `pin:${project.id}:${record.id}`;
    const requestId = requestIdFor(key);
    await runMutation(async () => {
      try {
        await pinProjectRecord(project.id, record.id, requestId);
        clearRequestId(key); setNotice(pt("pinnedCanvas")); options.onChanged();
        window.dispatchEvent(new CustomEvent("spellcast:locate-project-record", { detail: { projectId: project.id, recordId: record.id } }));
      } catch (error) {
        setNotice(`${pt("error")} ${asError(error)}`);
      }
    });
  }

  async function updateAccess(access: ProjectAccess, decision: "approved" | "revoked") {
    const project = selectedProject;
    if (!project || mutationBusy) return;
    await runMutation(async () => {
      try {
        const updated = await decideProjectAccess(project.id, access.id, access.revision, decision);
        accesses = accesses.map(item => item.id === updated.id ? updated : item);
        setNotice(pt("saved")); options.onChanged();
      } catch (error) {
        setNotice(`${isConflict(error) ? pt("conflictDraft") : pt("error")} ${asError(error)}`);
      }
    });
  }

  async function downloadJson() {
    if (!selectedProject) return;
    try {
      const bundle = await exportProject(selectedProject.id);
      download(`${selectedProject.name || "project"}.spellcast-project.json`, JSON.stringify(bundle, null, 2), "application/json");
      setNotice(pt("exported"));
    } catch (error) { setNotice(`${pt("error")} ${asError(error)}`); }
  }

  async function downloadMarkdown() {
    if (!selectedProject) return;
    try {
      const result = await exportProjectMarkdown(selectedProject.id);
      download(`${selectedProject.name || "project"}.md`, result.markdown, "text/markdown;charset=utf-8");
      setNotice(pt("exported"));
    } catch (error) { setNotice(`${pt("error")} ${asError(error)}`); }
  }

  async function readImportFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!exportIsValid(parsed)) throw new Error(pt("invalidImport"));
      importDraft ??= loadImportDraft();
      importDraft.bundleText = text;
      if (!importDraft.name.trim()) importDraft.name = (parsed as ProjectExport).project.name || "";
      persistImportDraft();
      setNotice(""); renderDetail();
    } catch (error) { setNotice(`${pt("invalidImport")} ${asError(error)}`); }
  }

  async function importBundle() {
    const draft = importDraft;
    if (!draft || mutationBusy) return;
    let bundle: ProjectExport;
    try { bundle = JSON.parse(draft.bundleText) as ProjectExport; } catch { setNotice(pt("invalidImport")); return; }
    if (!draft.name.trim() || !exportIsValid(bundle)) { setNotice(pt("invalidImport")); return; }
    await runMutation(async () => {
      try {
        if (!draft.projectCreated) {
          const created = await mutateProject({ request_id: draft.createRequestId, project_id: draft.targetProjectId, op: "create_project", name: draft.name.trim(), aliases: [] });
          draft.targetProjectId = created.project?.id || draft.targetProjectId;
          draft.projectCreated = true; persistImportDraft();
        }
        const result = await mutateProject({ request_id: draft.importRequestId, project_id: draft.targetProjectId, op: "import_project", bundle, name: draft.name.trim() });
        const target = result.project?.id || draft.targetProjectId;
        removeLocal(importDraftKey());
        importDraft = undefined;
        setNotice(pt("imported")); options.onChanged();
        await reloadProjects(target);
      } catch (error) {
        setNotice(`${isConflict(error) ? pt("conflictDraft") : pt("error")} ${asError(error)}`);
      }
    });
  }

  function prepareClose() {
    if (selectedRecord && detailMode === "edit") {
      // The draft stays in local storage; reopening presents the saved record first.
      recordDraft = undefined;
      detailMode = "summary";
    }
  }

  function closeWorkspace() {
    prepareClose();
    if (dialog.open) dialog.close();
  }

  refresh.addEventListener("click", () => { if(workspaceView==="planning")void planningView.refresh();else if(workspaceView==="game")void gameHome.refresh(false);else void reloadProjects(selectedProject?.id, selectedRecordId); });
  closeButton.addEventListener("click", closeWorkspace);
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // Back navigation must prevent the key's default close request. Chromium stops honoring
    // repeated preventDefault calls on the dialog's cancel event.
    if (tools.open) { event.preventDefault(); event.stopPropagation(); tools.open = false; return; }
    const typing = document.activeElement?.closest?.("textarea, input, select");
    if (workspaceView === "game" && !typing && gameHome.back()) {
      event.preventDefault(); event.stopPropagation();
    }
  });
  dialog.addEventListener("cancel", event => {
    // Keep non-keyboard close requests usable as a fallback.
    if (tools.open) { event.preventDefault(); tools.open = false; return; }
    const typing = document.activeElement?.closest?.("textarea, input, select");
    if (workspaceView === "game" && !typing && gameHome.back()) { event.preventDefault(); return; }
    prepareClose();
  });
  dialog.addEventListener("close", () => { prepareClose(); gameHome.visible(false); tools.open = false; });
  onLocale(() => { if (dialog.open) render(); });
  render();

  return {
    async openOnCanvas(projectId?: string) {
      recordOpenRequested = false;
      await reloadProjects(projectId);
      if (selectedProject) {
        const current = selectedProject;
        try {
          await gameHome.setProject(current);
          const source = await gameHome.canvasSource();
          if (selectedProject?.id !== current.id) return;
          if (source) {
            const objectId = await options.onOpenSkeleton(current.id, current.name, source.root, source.skeleton, source.documents);
            closeWorkspace();
            window.dispatchEvent(new CustomEvent("spellcast:locate-canvas-object", { detail: { objectId, activate: true } }));
            return;
          }
        } catch (error) { setNotice(`${pt("error")} ${asError(error)}`); }
      }
      // Projects without a readable skeleton still need their connection and management tools.
      if (!dialog.open) dialog.showModal();
      gameHome.visible(workspaceView === "game");
    },
    async open(projectId?: string, recordId?: string) {
      dialog.setAttribute("aria-busy", "true");
      try {
        recordOpenRequested=!!recordId;
        if(recordId)workspaceView="records";
        const previous = selectedProject?.id;
        if (!dialog.open) dialog.showModal();
        await reloadProjects(projectId, recordId);
        if(workspaceView==="planning")await planningView.refresh();
        else if(workspaceView==="game") {
          if(previous&&previous===selectedProject?.id)await gameHome.refresh(false);
          else { await gameHome.setProject(selectedProject); await gameHome.canvasSource(); }
        }
        gameHome.visible(workspaceView==="game");
      } finally { dialog.setAttribute("aria-busy", "false"); }
    },
    close() {
      closeWorkspace();
    },
  };
}
