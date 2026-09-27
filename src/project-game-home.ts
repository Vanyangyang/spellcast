import { currentLocale, onLocale } from "./i18n";
import { gh } from "./i18n/game-home";
import { pt } from "./i18n/projects";
import { bindCodexTask, fetchFeedbackState } from "./api";
import type { CodexBinding } from "./types";
import { connectGame, fetchGameConnection, fetchGameSource, fetchGameView, type GameConnection, type GameLocation } from "./project-game-api";
import {
  createGoal, fetchGameOverview, fetchGoals, fetchProposals, promoteGoal, sendGoal,
  type CodeHit, type DocMention, type GameDocument, type GameOverview, type Goal, type GoalContext, type ProjectProposal, type SourceStamp, type ZoneResponse,
} from "./project-game-home-api";
import { decideProjectAccess, fetchProjectAccess, fetchProjectObjects, fetchProjectRecords, type DevelopmentObject, type Project, type ProjectAccess, type WorkRecord } from "./project-record-api";
import { createDocumentReview, documentFileUri, documentReviewRecords, DOCUMENT_DECISION_SCOPE, DOCUMENT_REVIEW_SCOPE, DOCUMENT_SELECTION_SCOPE, type DocumentMark } from "./project-document-review";
import { badge, kindLabel, renderProposalCard, renderProposalReview, subjectLabel } from "./project-proposal-view";
import "./project-game-home.css";

type Scale = "overview" | "experience" | "object";
type Options = { openRecord(id: string): void; onChanged(): void; openTool(view: "planning" | "records"): void; openSourceTable(loop: import("./project-game-home-api").PlayerLoop, root: string): Promise<void> };
type Draft = { text: string; target: string; withContext: boolean; pending?: { id: string; fingerprint: string } };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
};
function button(text: string, action: () => void, name = "", className = "") {
  const node = el("button", text, className); node.type = "button"; if (name) node.dataset.ghAction = name;
  node.addEventListener("click", action); return node;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (hash: string) => hash ? hash.slice(0, 8) : "—";
const same = (a: string, b: string) => a.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() === b.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const readLocal = <T>(key: string): T | undefined => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : undefined; } catch { return undefined; } };
const writeLocal = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* View state only. */ } };
const date = (ms: number) => new Date(ms).toLocaleString(currentLocale() as string, { dateStyle: "short", timeStyle: "short" });
const IN_FLIGHT = new Set(["waiting", "dispatching", "submitted", "received"]);

function section(title: string, name: string, ...badges: HTMLElement[]) {
  const box = el("section", "", "gh-section"); box.dataset.ghSection = name;
  const head = el("header"); head.append(el("h3", title), ...badges); box.append(head); return box;
}
function sourceLine(source: SourceStamp & { line?: number; heading?: string }) {
  const line = el("small", "", "gh-source");
  const parts = source.path.split("/"); const shown = parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : source.path;
  line.append(el("code", shown), document.createTextNode(`${source.heading ? ` § ${source.heading}` : ""}${source.line ? ` · ${gh("line", { line: source.line })}` : ""} · sha ${short(source.hash)}`));
  line.title = `${source.path}\nSHA-256 ${source.hash}`; return line;
}

export function createGameHome(options: Options) {
  const element = el("section", "", "game-home"); element.dataset.gameHome = "true";
  const top = el("header", "", "gh-top"), composer = el("form", "", "gh-composer"), body = el("div", "", "gh-body");
  const main = el("main", "", "gh-main"), side = el("aside", "", "gh-side");
  const status = el("p", "", "gh-status"); status.setAttribute("role", "status");
  body.append(main, side); element.append(top, composer, status, body);
  const sourceDialog = el("dialog", "", "gh-source-view"); element.append(sourceDialog);
  let documentViewer: ReturnType<typeof createDocumentReview> | undefined;
  sourceDialog.addEventListener("close", () => { if (sourceDialog.open) return; documentViewer?.dispose(); documentViewer = undefined; if (sourceDialog.classList.contains("gh-document-review")) { sourceDialog.classList.remove("gh-document-review"); if (documentsOpen) render(); } });

  let project: Project | undefined, connection: GameConnection | null | undefined, overview: GameOverview | undefined, zone: ZoneResponse | undefined;
  let goals: Goal[] = [], proposals: ProjectProposal[] = [], objects: DevelopmentObject[] = [], records: WorkRecord[] = [], accesses: ProjectAccess[] = [], bindings: CodexBinding[] = [];
  let scale: Scale = "overview", zoneId = "", locationId = "", reviewing: string | undefined;
  let documentsOpen = false, documentQuery = "", documentFilter = "all";
  let documentMarks: Record<string, DocumentMark> = {};
  let loading = false, zoneLoading = false, busy = false, error = "", zoneError = "", notice = "", epoch = 0, connectionOpen: boolean | undefined;
  let draft: Draft = { text: "", target: "", withContext: true };
  let poll = 0;
  const key = (part: string) => `spellcast.game-home.v1.${project?.id}.${part}`;
  const setNotice = (text = "") => { notice = text; status.textContent = text; status.hidden = !text; };
  const saveDraft = () => writeLocal(key("composer"), draft);
  const remember = () => writeLocal(key("view"), { scale, zoneId, locationId });

  function root(): string { return connection?.root || project?.aliases[0] || ""; }
  function sortedBindings(): CodexBinding[] {
    const home = [connection?.root, ...(project?.aliases || [])].filter((value): value is string => !!value);
    const near = (binding: CodexBinding) => home.some(path => same(path, binding.cwd));
    return [...bindings].sort((a, b) => Number(near(b)) - Number(near(a)) || a.label.localeCompare(b.label));
  }
  function location(): GameLocation | undefined { return zone?.view.locations.find(item => item.id === locationId); }

  function context(): GoalContext {
    const empty: GoalContext = { scale: "", zone_id: "", location_id: "", entity_kind: "", entity_id: "", label: "", source_revision: "", sources: [] };
    if (!draft.withContext) return empty;
    if (scale === "overview" || !zone) {
      const sources = [overview?.loop?.source, overview?.world?.source].filter((value): value is SourceStamp & { heading?: string } => !!value).map(({ path, hash }) => ({ path, hash }));
      return { ...empty, scale: "overview", label: gh("scaleOverview"), source_revision: overview?.source_revision || "", sources };
    }
    const view = zone.view, node = location();
    const paths = new Set([view.zone.path, ...(node ? [node.path || "", ...node.candidates.flatMap(item => item.paths), ...(node.loot_points || []).map(point => point.path || "")] : [])]);
    const sources = (node ? view.sources.filter(source => paths.has(source.path)) : view.sources).slice(0, 96).map(({ path, hash }) => ({ path, hash }));
    if (scale === "object" && node) return { ...empty, scale: "object", zone_id: view.zone.id, location_id: node.id, entity_kind: "location", entity_id: node.id,
      label: `${view.zone.name} / ${node.name}`, source_revision: view.source_revision, sources };
    return { ...empty, scale: "experience", zone_id: view.zone.id, label: view.zone.name, source_revision: view.source_revision, sources };
  }

  function goalStatus(goal: Goal): { text: string; tone: string } {
    const label = goal.target?.label || "Codex";
    if (goal.status === "unsent") return { text: gh("unsent"), tone: "muted" };
    const delivery = goal.delivery;
    if (!delivery) return { text: gh("archivedReceipt"), tone: "done" };
    const text = {
      waiting: gh("waiting", { label }), dispatching: gh("dispatching"), submitted: gh("submitted"), received: gh("received"), responded: goal.context.entity_kind === "document_question" ? gh("respondedDocument") : gh("responded"),
      handled: gh("handled"), unanswered: gh("unanswered"), failed: gh("failed", { error: delivery.error || "—" }), unknown: gh("unknown", { error: delivery.error || "—" }),
      queued: gh("waiting", { label }),
    }[delivery.phase] || delivery.phase;
    const tone = delivery.phase === "failed" || delivery.phase === "unknown" || delivery.phase === "unanswered" ? "warning" : delivery.phase === "responded" || delivery.phase === "handled" ? "done" : "live";
    return { text: delivery.attention ? `${text} · ${gh("attention", { text: delivery.attention })}` : text, tone };
  }

  // ---- data ---------------------------------------------------------------------------------
  async function loadProjectData(projectId: string, version: number) {
    const [goalResult, proposalResult, objectResult, recordResult, accessResult, feedbackResult] = await Promise.allSettled([
      fetchGoals(projectId), fetchProposals(projectId, true), fetchProjectObjects(projectId), fetchProjectRecords(projectId), fetchProjectAccess(projectId), fetchFeedbackState(),
    ]);
    if (version !== epoch) return;
    if (goalResult.status === "fulfilled") goals = goalResult.value;
    if (proposalResult.status === "fulfilled") proposals = proposalResult.value;
    if (objectResult.status === "fulfilled") objects = objectResult.value;
    if (recordResult.status === "fulfilled") records = recordResult.value;
    if (accessResult.status === "fulfilled") accesses = accessResult.value;
    if (feedbackResult.status === "fulfilled") bindings = feedbackResult.value.bindings;
    const failure = [goalResult, proposalResult, objectResult, recordResult, accessResult, feedbackResult].find(result => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (failure) error = message(failure.reason);
  }

  async function load(refresh = false) {
    if (!project) return;
    const version = ++epoch, projectId = project.id;
    loading = true; error = ""; render();
    try {
      await loadProjectData(projectId, version);
      if (version !== epoch) return;
      connection = (await fetchGameConnection(projectId)).connection;
      if (version !== epoch) return;
      if (connection) {
        overview = await fetchGameOverview(projectId, refresh);
        if (version !== epoch) return;
        // The overview just refreshed both caches; the zone reads the same snapshot incrementally.
        if (scale !== "overview" && zoneId) await loadZone(zoneId, false, version);
      } else { overview = undefined; zone = undefined; }
    } catch (failure) { if (version === epoch) error = message(failure); }
    finally { if (version === epoch) { loading = false; render(); schedulePoll(); } }
  }

  async function loadZone(id: string, refresh = false, version = epoch) {
    if (!project) return;
    zoneLoading = true; zoneError = ""; render();
    try {
      const next = await fetchGameView(project.id, id, refresh) as ZoneResponse;
      if (version !== epoch) return;
      if (next.view === null) { zone = undefined; zoneError = (next as unknown as { view_error?: string }).view_error || gh("error"); }
      else { zone = next; zoneId = next.view.zone.id; if (locationId && !next.view.locations.some(item => item.id === locationId)) { locationId = ""; if (scale === "object") scale = "experience"; } }
    } catch (failure) { if (version === epoch) zoneError = message(failure); }
    finally { if (version === epoch) { zoneLoading = false; remember(); render(); } }
  }

  /** Delivery changes happen on the server; poll lightly only while a goal is in flight. */
  function schedulePoll() {
    window.clearTimeout(poll);
    if (!project || element.hidden || !element.isConnected) return;
    if (!goals.some(goal => goal.status === "sent" && (!goal.delivery || IN_FLIGHT.has(goal.delivery.phase) ||
      (goal.context.entity_kind === "document_question" && goal.delivery.phase === "responded" && (goal.response_record_ids || []).some(id => !records.some(record => record.id === id)))))) return;
    poll = window.setTimeout(async () => {
      if (!project || busy) { schedulePoll(); return; }
      const version = epoch;
      await loadProjectData(project.id, version).catch(() => undefined);
      if (version === epoch) { renderQuiet(); if (sourceDialog.open && documentViewer) void documentViewer.refresh(); schedulePoll(); }
    }, 4000);
  }

  // ---- navigation -----------------------------------------------------------------------------
  function go(next: Scale, zone_?: string, location_?: string) {
    reviewing = undefined;
    documentsOpen = false;
    scale = next;
    if (next === "overview") { locationId = ""; }
    if (zone_ !== undefined && zone_ !== zoneId) { zoneId = zone_; zone = undefined; locationId = ""; void loadZone(zoneId); }
    if (location_ !== undefined) locationId = location_;
    remember(); render();
    main.querySelector<HTMLElement>("h3")?.focus?.();
  }
  /** Escape walks up one level; the workspace closes only from the overview. */
  function back(): boolean {
    if (sourceDialog.open) return false;
    if (connectionOpen) { connectionOpen = false; renderTop(); top.querySelector<HTMLElement>("[data-gh-connection-toggle]")?.focus(); return true; }
    if (reviewing) { reviewing = undefined; render(); main.querySelector<HTMLElement>("h3")?.focus(); return true; }
    if (documentsOpen) { documentsOpen = false; render(); main.querySelector<HTMLElement>("h3")?.focus(); return true; }
    if (scale === "object") { go("experience"); return true; }
    if (scale === "experience") { go("overview"); return true; }
    return false;
  }

  // ---- actions --------------------------------------------------------------------------------
  async function submitGoal(send: boolean) {
    if (!project || busy) return;
    const text = draft.text.trim(); if (!text) return;
    const target = sortedBindings().find(binding => binding.source_id === draft.target);
    if (send && !target) return;
    const goalContext = context();
    const fingerprint = JSON.stringify({ text, goalContext });
    if (draft.pending?.fingerprint !== fingerprint) draft.pending = { id: crypto.randomUUID(), fingerprint };
    saveDraft();
    const projectId = project.id, id = draft.pending.id;
    busy = true; setNotice(gh("sending")); render();
    try {
      await createGoal(projectId, { id, text, context: goalContext });
      draft = { text: "", target: draft.target, withContext: draft.withContext }; saveDraft();
      if (send && target) {
        try { await sendGoal(projectId, id, { source_id: target.source_id, thread_id: target.thread_id }); setNotice(gh("goalQueued", { label: target.label })); }
        catch (failure) { setNotice(`${gh("unsent")}：${message(failure)}`); }
      } else setNotice(gh("goalSaved"));
      options.onChanged();
    } catch (failure) { setNotice(`${gh("error")}：${message(failure)}`); }
    finally { busy = false; await loadProjectData(projectId, epoch).catch(() => undefined); render(); schedulePoll(); }
  }

  async function sendSaved(goal: Goal) {
    const target = sortedBindings().find(binding => binding.source_id === draft.target) || sortedBindings()[0];
    if (!project || !target || busy) return;
    busy = true; render();
    try { await sendGoal(project.id, goal.id, { source_id: target.source_id, thread_id: target.thread_id }); setNotice(gh("goalQueued", { label: target.label })); }
    catch (failure) { setNotice(`${gh("unsent")}：${message(failure)}`); }
    finally { busy = false; await loadProjectData(project.id, epoch).catch(() => undefined); render(); schedulePoll(); }
  }

  async function promote(goal: Goal) {
    if (!project || busy) return;
    busy = true; render();
    try { const next = await promoteGoal(project.id, goal.id); setNotice(gh("decisionSaved")); options.onChanged(); if (next.record_id) options.openRecord(next.record_id); }
    catch (failure) { setNotice(`${gh("error")}：${message(failure)}`); }
    finally { busy = false; await loadProjectData(project.id, epoch).catch(() => undefined); render(); }
  }

  async function decideAccess(access: ProjectAccess, decision: "approved" | "revoked") {
    if (!project || busy) return;
    busy = true; render();
    try { await decideProjectAccess(project.id, access.id, access.revision, decision); setNotice(gh("decisionSaved")); options.onChanged(); }
    catch (failure) { setNotice(`${gh("error")}：${message(failure)}`); }
    finally { busy = false; await loadProjectData(project.id, epoch).catch(() => undefined); render(); }
  }

  async function link(thread: string, cwd: string) {
    if (busy) return;
    busy = true; setNotice(gh("linking")); render();
    try { await bindCodexTask(`codex:${thread}`, thread, cwd || undefined); draft.target = `codex:${thread}`; saveDraft(); setNotice(gh("decisionSaved")); }
    catch (failure) { setNotice(`${gh("error")}：${message(failure)}`); }
    finally { busy = false; if (project) await loadProjectData(project.id, epoch).catch(() => undefined); render(); }
  }

  async function connect(path: string) {
    if (!project || busy) return;
    busy = true; render();
    try { connection = await connectGame(project.id, path.trim(), connection?.revision || 0, crypto.randomUUID()); await load(false); }
    catch (failure) { setNotice(`${gh("error")}：${message(failure)}`); }
    finally { busy = false; render(); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice(gh("copied")); } catch (failure) { setNotice(message(failure)); }
  }

  async function showSource(path: string) {
    if (!project) return;
    documentViewer?.dispose(); documentViewer = undefined;
    sourceDialog.classList.remove("gh-document-review");
    sourceDialog.replaceChildren(el("p", gh("loading"))); if (!sourceDialog.open) sourceDialog.showModal();
    try {
      const source = await fetchGameSource(project.id, path);
      const head = el("header"); head.append(el("h3", path.split("/").at(-1) || path), button(pt("close"), () => sourceDialog.close(), "close-source"));
      const pre = el("pre", JSON.stringify(source.json, null, 2)); pre.dataset.ghSourceJson = "true";
      sourceDialog.replaceChildren(head, el("small", path), el("small", `SHA-256 ${source.hash}`), pre);
    } catch (failure) { sourceDialog.replaceChildren(el("p", message(failure)), button(pt("close"), () => sourceDialog.close(), "close-source")); }
  }

  async function showDocument(path: string) {
    if (!project) return;
    documentViewer?.dispose();
    const ownerProjectId = project.id;
    sourceDialog.classList.add("gh-document-review");
    const viewer = createDocumentReview({ dialog: sourceDialog, projectId: ownerProjectId, root: root(), documents: overview?.documents || [],
      records: () => records, onRecords: next => { if (documentViewer !== viewer || project?.id !== ownerProjectId) return; records = next; if (documentsOpen) render(); },
      marks: documentMarks, onNotice: text => { if (documentViewer === viewer && project?.id === ownerProjectId) setNotice(text); },
      bindings: () => bindings, goals: () => goals, onGoals: next => { if (documentViewer === viewer && project?.id === ownerProjectId) { goals = next; renderSide(); schedulePoll(); } } });
    documentViewer = viewer;
    sourceDialog.replaceChildren(el("p", gh("loading"))); if (!sourceDialog.open) sourceDialog.showModal();
    try { const next = await fetchProjectRecords(ownerProjectId); if (documentViewer !== viewer || project?.id !== ownerProjectId) return; records = next; if (documentsOpen) render(); }
    catch (failure) { if (documentViewer === viewer && project?.id === ownerProjectId) setNotice(`${gh("error")}：${message(failure)}`); }
    if (documentViewer !== viewer || project?.id !== ownerProjectId) return;
    await viewer.open(path);
  }

  // ---- rendering ------------------------------------------------------------------------------
  function render() {
    renderTop(); renderComposer(); renderMain(); renderSide();
    element.dataset.scale = reviewing ? "review" : scale;
    element.dataset.documents = String(documentsOpen);
  }
  /** Background refreshes never replace what the user is typing or editing. */
  function renderQuiet() {
    renderTop(); renderSide();
    if (!main.querySelector(".gh-proposal-editor, .gh-note") && !main.contains(document.activeElement)) renderMain();
    if (!composer.contains(document.activeElement)) renderComposer();
    element.dataset.scale = reviewing ? "review" : scale;
    element.dataset.documents = String(documentsOpen);
  }

  function renderTop() {
    top.replaceChildren();
    const crumbs = el("nav", "", "gh-crumbs"); crumbs.setAttribute("aria-label", gh("breadcrumb"));
    const crumb = (text: string, active: boolean, action: () => void, name: string) => {
      const node = button(text, action, name); node.setAttribute("aria-current", String(active)); return node;
    };
    crumbs.append(crumb(`${gh("scaleOverview")}${overview?.world?.name ? ` · ${overview.world.name}` : ""}`, scale === "overview" && !reviewing && !documentsOpen, () => { documentsOpen = false; go("overview"); }, "scale-overview"));
    if (documentsOpen) crumbs.append(el("span", "›"), crumb(gh("documentBoard"), true, () => {}, "documents"));
    if (zone && scale !== "overview") crumbs.append(el("span", "›"), crumb(`${gh("scaleExperience")} · ${zone.view.zone.name}`, scale === "experience" && !reviewing, () => go("experience"), "scale-experience"));
    const node = location();
    if (node && scale === "object") crumbs.append(el("span", "›"), crumb(`${gh("scaleObject")} · ${node.name}`, !reviewing, () => go("object"), "scale-object"));
    top.append(crumbs, renderConnection());
  }

  function renderConnection(): HTMLElement {
    const available = sortedBindings();
    const pending = accesses.filter(access => access.state === "pending");
    const box = el("details", "", "gh-connection"); box.dataset.ghConnection = available.length ? "ready" : "none";
    box.open = connectionOpen === true;
    box.addEventListener("toggle", () => { connectionOpen = box.open; });
    const summary = el("summary"); summary.dataset.ghConnectionToggle = "true"; summary.append(el("span", available.length ? gh("connectionReady", { count: available.length }) : gh("connectionNone")));
    if (pending.length) summary.append(badge(`${pending.length}`, "warning"));
    box.append(summary);
    const panel = el("div", "", "gh-connection-panel");
    panel.append(el("p", gh("connectionHelp")));
    if (available.length) {
      const list = el("ul", "", "gh-list");
      const home = [connection?.root, ...(project?.aliases || [])].filter((value): value is string => !!value);
      for (const binding of available) {
        const row = el("li"); row.append(el("strong", binding.label || binding.source_id), el("small", `${binding.cwd} · ${binding.thread_id.slice(0, 8)}`));
        if (home.some(path => same(path, binding.cwd))) row.append(badge(gh("sameDirectory"), "config"));
        list.append(row);
      }
      panel.append(list);
    } else {
      const instructions = gh("startInstructions", { project: project?.name || "", id: project?.id || "", root: root() || "—" });
      panel.append(el("p", gh("startHelp", { root: root() || "—" })));
      const pre = el("pre", instructions, "gh-instructions"); pre.dataset.ghInstructions = "true";
      panel.append(pre, button(gh("copyStart"), () => void copy(instructions), "copy-start"));
      const bound = new Set(bindings.map(binding => binding.thread_id));
      const seen = new Map<string, { label: string; cwd: string }>();
      for (const actor of [...records.map(record => record.updated_by), ...proposals.map(proposal => proposal.created_by)]) {
        if (actor.kind === "agent" && actor.thread_id && !bound.has(actor.thread_id) && /^[0-9a-f-]{36}$/i.test(actor.thread_id)) seen.set(actor.thread_id, { label: actor.label, cwd: actor.cwd || "" });
      }
      if (seen.size) {
        panel.append(el("h4", gh("candidates")));
        const list = el("ul", "", "gh-list");
        for (const [thread, info] of seen) {
          const row = el("li"); row.append(el("strong", info.label || thread.slice(0, 8)), el("small", `${info.cwd || "—"} · ${thread.slice(0, 8)}`));
          const action = button(gh("linkTask"), () => void link(thread, info.cwd), "link-task"); action.disabled = busy; row.append(action); list.append(row);
        }
        panel.append(list);
      }
    }
    for (const access of accesses.filter(access => access.state !== "revoked")) {
      const row = el("div", "", "gh-access"); row.dataset.ghAccess = access.state;
      if (access.state === "pending") {
        row.append(el("span", gh("accessPending", { label: access.label || access.source_id })), el("small", `${access.cwd} · ${access.thread_id.slice(0, 8)}`));
        const approve = button(gh("approve"), () => void decideAccess(access, "approved"), "approve-access", "primary"), reject = button(gh("reject"), () => void decideAccess(access, "revoked"), "reject-access");
        approve.disabled = reject.disabled = busy; row.append(approve, reject);
      } else row.append(el("span", gh("accessApproved", { label: access.label || access.source_id, date: access.expires_at_ms ? date(access.expires_at_ms) : "—" })));
      panel.append(row);
    }
    if (!accesses.length) panel.append(el("small", gh("accessNone")));
    panel.append(el("small", gh("hostNote"), "gh-host-note"));
    box.append(panel);
    return box;
  }

  function renderComposer() {
    composer.replaceChildren();
    composer.dataset.ghComposer = "true";
    const label = el("label", "", "gh-composer-label"); const input = el("textarea");
    input.value = draft.text; input.rows = 2; input.maxLength = 4000; input.placeholder = gh("composerPlaceholder"); input.dataset.ghGoal = "true"; input.disabled = busy;
    label.append(el("span", gh("composerLabel")), input);
    const row = el("div", "", "gh-composer-row");
    const ctx = context();
    const chip = button(draft.withContext ? (ctx.scale === "overview" ? gh("contextOverview") : gh(ctx.scale === "object" ? "contextObject" : "contextExperience", { name: ctx.label })) : gh("contextNone"),
      () => { draft.withContext = !draft.withContext; saveDraft(); renderComposer(); }, "toggle-context", "gh-chip");
    chip.setAttribute("aria-pressed", String(draft.withContext)); chip.title = draft.withContext ? gh("dropContext") : gh("useContext");
    const available = sortedBindings();
    if (draft.target && !available.some(binding => binding.source_id === draft.target)) draft.target = "";
    if (!draft.target && available.length === 1) draft.target = available[0].source_id;
    const targetLabel = el("label", "", "gh-target"); const select = el("select"); select.dataset.ghTarget = "true"; select.disabled = busy || !available.length;
    select.setAttribute("aria-label", gh("targetHint"));
    const none = el("option", available.length ? gh("targetHint") : gh("noTarget")); none.value = ""; select.append(none);
    for (const binding of available) { const option = el("option", gh("taskLabel", { label: binding.label || binding.source_id, thread: binding.thread_id.slice(0, 8) })); option.value = binding.source_id; select.append(option); }
    select.value = draft.target; targetLabel.append(el("span", gh("target")), select);
    const target = available.find(binding => binding.source_id === draft.target);
    const send = el("button", target ? gh("send", { label: target.label || target.source_id }) : gh("sendSaved"), "primary"); send.type = "submit"; send.dataset.ghSend = "true";
    const save = button(gh("saveUnsent"), () => void submitGoal(false), "save-unsent");
    const update = () => {
      const text = input.value.trim();
      send.disabled = busy || !text || !target; save.disabled = busy || !text;
    };
    input.addEventListener("input", () => { draft.text = input.value; saveDraft(); update(); });
    input.addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!send.disabled) void submitGoal(true); } });
    select.addEventListener("change", () => { draft.target = select.value; saveDraft(); renderComposer(); });
    update();
    row.append(chip, targetLabel, send, save);
    composer.append(label, row);
    if (!available.length) {
      const hint = el("p", "", "gh-connect-hint"); hint.append(el("span", gh("connectionNone")), button(gh("howToConnect"), () => { connectionOpen = true; renderTop(); top.querySelector<HTMLElement>("[data-gh-connection-toggle]")?.focus(); }, "how-to-connect"));
      composer.append(hint);
    }
    const suggestions = suggest();
    if (suggestions.length && !draft.text) {
      const box = el("div", "", "gh-suggestions"); box.append(el("small", gh("suggestions")));
      for (const text of suggestions) box.append(button(text, () => { draft.text = text; saveDraft(); renderComposer(); composer.querySelector<HTMLTextAreaElement>("[data-gh-goal]")?.focus(); }, "suggest", "gh-chip"));
      composer.append(box);
    }
  }
  composer.addEventListener("submit", event => { event.preventDefault(); void submitGoal(true); });

  /** Deterministic starting points from the projection. They only fill the input box. */
  function suggest(): string[] {
    if (!overview) return [];
    const items: string[] = [];
    if (scale === "object" && location()) items.push(gh("suggestObject", { name: location()!.name }));
    else if (scale === "experience" && zone) items.push(gh("suggestZone", { zone: zone.view.zone.name }));
    else {
      if (overview.loop) items.push(gh("suggestLoop"));
      const first = overview.routed_zones.find(item => item.id === "zone_forest_shrine_outer") || overview.routed_zones[0];
      if (first) items.push(gh("suggestZone", { zone: first.name }));
      const missing = overview.regions.filter(region => !region.main_quest_found).length;
      if (missing) items.push(gh("suggestQuests", { count: missing }));
    }
    return items;
  }

  function renderMain() {
    main.replaceChildren();
    if (!project) return;
    if (error) { const alert = el("p", error, "gh-alert"); alert.setAttribute("role", "alert"); main.append(alert, button(gh("retry"), () => void load(false), "retry")); }
    if (reviewing) {
      const proposal = proposals.find(item => item.id === reviewing);
      if (proposal) {
        main.append(button(gh("back"), () => { reviewing = undefined; render(); }, "close-review", "gh-back"), renderProposalReview(proposal, {
          projectId: project.id, objects, records, busy: () => busy, setBusy: value => { busy = value; },
          decided: (_, text) => { setNotice(text); options.onChanged(); void load(false); },
        }));
        return;
      }
      reviewing = undefined;
    }
    if (connection === undefined && loading) { main.append(el("p", gh("loading"), "gh-loading")); return; }
    if (!connection) { renderConnect(); return; }
    if (!overview) { main.append(el("p", loading ? gh("loading") : gh("noConnectionYet"), "gh-loading")); return; }
    if (scale === "overview") { if (documentsOpen) renderDocuments(); else renderOverview(); }
    else if (zoneLoading && !zone) main.append(el("p", gh("loadingZone"), "gh-loading"));
    else if (zoneError && !zone) { const alert = el("p", zoneError, "gh-alert"); alert.setAttribute("role", "alert"); main.append(alert, button(gh("back"), () => go("overview"), "back-overview")); }
    else if (scale === "experience") renderExperience();
    else renderObject();
  }

  function renderConnect() {
    const box = section(gh("connectGame"), "connect", badge(gh("configBadge"), "config"));
    const form = el("form", "", "gh-connect"); const label = el("label"); const input = el("input"); input.value = root(); input.dataset.ghRoot = "true";
    label.append(el("span", gh("root")), input);
    const submit = el("button", gh("connect"), "primary"); submit.type = "submit"; submit.disabled = busy;
    form.append(el("p", gh("connectHelp")), label, submit);
    form.addEventListener("submit", event => { event.preventDefault(); void connect(input.value); });
    box.append(form); main.append(box);
  }

  function renderOverview() {
    const data = overview!;
    const intro = el("section", "", "gh-intro");
    const title = el("h3", data.world?.name || project!.name); title.tabIndex = -1;
    intro.append(title, el("p", gh("scaleHint"), "gh-muted"));
    if (data.world) {
      const start = data.regions.find(region => region.id === data.world!.starting_region_id);
      intro.append(el("p", gh("startRegion", { name: start?.name || data.world.starting_region_id || "—" })), sourceLine(data.world.source));
    }
    main.append(intro);

    const documentEntry = section(gh("documentBoard"), "documents-entry", badge(String(data.documents?.length || 0), "design"));
    documentEntry.append(el("p", gh("documentHelp"), "gh-muted"), button(gh("openDocuments", { count: data.documents?.length || 0 }), () => { documentsOpen = true; render(); main.scrollTop = 0; }, "open-documents", "primary"));
    main.append(documentEntry);

    const loop = section(gh("loopTitle"), "loop", badge(gh("designBadge"), "design"));
    if (data.loop) {
      const open = button(gh("openLoopCanvas"), () => {
        open.disabled = true;
        void options.openSourceTable(data.loop!, root()).catch(failure => setNotice(`${gh("error")}：${message(failure)}`)).finally(() => { open.disabled = false; });
      }, "open-loop-canvas");
      loop.querySelector("header")?.append(open);
      const table = el("table", "", "gh-loop"); const head = el("tr");
      for (const column of data.loop.columns) head.append(el("th", column));
      const thead = el("thead"); thead.append(head); const tbody = el("tbody");
      for (const row of data.loop.rows) { const tr = el("tr"); row.forEach(cell => tr.append(el("td", cell))); tbody.append(tr); }
      table.append(thead, tbody); loop.append(table, sourceLine(data.loop.source), el("small", gh("designNote"), "gh-muted"));
    } else loop.append(el("p", gh("loopNone", { path: "Assets/Documents/Atlas/domains/cycle.md" }), "gh-unknown"));
    main.append(loop);

    const explorable = section(gh("explorable"), "explorable", badge(gh("configBadge"), "config"));
    if (!data.routed_zones.length) explorable.append(el("p", gh("noRoutes"), "gh-unknown"));
    const grid = el("div", "", "gh-zone-grid");
    for (const item of data.routed_zones) {
      const region = data.regions.find(value => value.id === item.region_id), dungeon = region?.dungeons.find(value => value.id === item.dungeon_id);
      const card = button("", () => go("experience", item.id), "open-zone", "gh-zone-card"); card.dataset.ghZone = item.id;
      card.append(el("strong", item.name), el("small", [region?.name, dungeon?.name].filter(Boolean).join(" · ")), el("small", gh("zoneMeta", { locations: item.locations, routes: item.routes })));
      grid.append(card);
    }
    explorable.append(grid); main.append(explorable);

    const world = section(gh("worldTitle"), "world", badge(gh("configBadge"), "config"));
    for (const region of data.regions) {
      const details = el("details", "", "gh-region"); details.dataset.ghRegion = region.id;
      const zones = region.dungeons.flatMap(dungeon => dungeon.zones), routed = zones.filter(item => item.routes > 0).length;
      const summary = el("summary"); summary.append(el("strong", region.name), el("small", gh("regionMeta", { dungeons: region.dungeons.length, zones: zones.length, routed })));
      if (!region.main_quest_found) summary.append(badge(gh("mainQuestMissing", { id: region.main_quest_id }), "warning"));
      details.append(summary);
      if (region.description) details.append(el("p", region.description, "gh-prose"));
      for (const dungeon of region.dungeons) {
        const row = el("div", "", "gh-dungeon"); row.append(el("strong", dungeon.name));
        const chips = el("div", "", "gh-inline");
        for (const item of dungeon.zones) {
          if (item.routes > 0) { const chip = button(item.name, () => go("experience", item.id), "open-zone", "gh-chip"); chip.dataset.ghZone = item.id; chips.append(chip); }
          else chips.append(badge(`${item.name} · ${item.configured === false ? gh("unconfigured") : gh("noRoute")}${item.hidden ? ` · ${gh("hiddenZone")}` : ""}`, "muted"));
        }
        row.append(chips, sourceLine(dungeon.source)); details.append(row);
      }
      details.append(sourceLine(region.source)); world.append(details);
    }
    main.append(world);

    const verify = el("p", "", "gh-verify-line"); verify.append(badge(gh("verificationBadge"), "verification"), el("span", gh("verificationUnknown"), "gh-unknown"));
    const checks = el("details", "", "gh-checks"); checks.append(el("summary", gh("checks", { count: data.issues.length })));
    for (const issue of data.issues.slice(0, 60)) { const line = el("p", issue.message, issue.severity === "error" ? "gh-warning" : "gh-muted"); line.title = issue.path; checks.append(line); }
    main.append(verify, el("small", gh("counts", { regions: data.counts.regions, dungeons: data.counts.dungeons, zones: data.counts.zones, locations: data.counts.locations,
      contents: data.counts.contents, missions: data.counts.missions, docs: data.counts.design_documents, code: data.counts.code_files }), "gh-counts"));
    if (data.issues.length) main.append(checks);
  }

  function renderDocuments() {
    const documents = overview?.documents || [];
    const board = section(gh("documentBoard"), "documents", badge(gh("documentScope"), "design"));
    board.append(el("p", gh("documentHelp"), "gh-muted"));
    const actions = el("div", "", "gh-actions");
    actions.append(button(gh("back"), () => { documentsOpen = false; render(); }, "back-overview"));
    board.append(actions, el("small", gh("documentLocal"), "gh-muted"));
    const controls = el("div", "", "gh-document-controls");
    const search = el("input"); search.type = "search"; search.placeholder = gh("documentSearch"); search.setAttribute("aria-label", gh("documentSearch"));
    search.value = documentQuery; search.dataset.ghDocumentSearch = "true";
    const filter = el("select"); filter.setAttribute("aria-label", gh("documentBoard")); filter.dataset.ghDocumentFilter = "true";
    for (const [value, label] of [["all", gh("documentAll")], ["comments", gh("documentWithComments")], ["discarded", gh("documentWithDiscarded")]]) {
      const option = el("option", label); option.value = value; filter.append(option);
    }
    filter.value = documentFilter;
    const count = el("small", "", "gh-muted");
    controls.append(search, filter, count); board.append(controls);
    const groups = el("div", "", "gh-document-groups");
    const byGroup = new Map<string, GameDocument[]>();
    for (const item of documents) {
      const parts = item.path.split("/");
      const group = parts[2] === "Content" && parts[3] === "Regions" && parts.length > 5
        ? `${parts[2]} / ${parts[3]} / ${parts[4]}`
        : parts.length > 4 ? `${parts[2]} / ${parts[3]}` : parts[2] || gh("documentScope");
      const rows = byGroup.get(group) || []; rows.push(item); byGroup.set(group, rows);
    }
    const indexed: Array<{ item: GameDocument; row: HTMLElement; group: HTMLDetailsElement }> = [];
    const empty = el("p", gh("documentEmpty"), "gh-muted"); empty.hidden = true;
    for (const [name, items] of [...byGroup].sort(([left], [right]) => left.localeCompare(right))) {
      const group = el("details", "", "gh-document-group");
      const summary = el("summary"); const visibleCount = el("small", String(items.length));
      summary.append(el("strong", name), visibleCount); group.append(summary);
      const list = el("div", "", "gh-document-list");
      for (const item of items) {
        const row = el("article", "", "gh-document-row"); row.dataset.ghDocument = item.path;
        const title = el("strong", item.title || item.path.split("/").at(-1) || item.path);
        const source = el("small", item.path, "gh-muted");
        const meta = el("small", item.error || `${gh("documentLines", { count: item.lines ?? 0 })} · SHA-256 ${short(item.hash)}`, item.error ? "gh-warning" : "gh-muted");
        const comments = documentReviewRecords(records, documentFileUri(root(), item.path));
        const uri = documentFileUri(root(), item.path);
        const discards = records.filter(record => !record.archived && record.scope === DOCUMENT_SELECTION_SCOPE && record.result === "discard" && record.status === "active" && record.references?.[0]?.uri.split("#", 1)[0] === uri);
        const stale = discards.some(record => record.references?.[0]?.version !== item.hash);
        const review = el("small", `${gh("documentCommentCount", { count: comments.length, open: comments.filter(record => record.status !== "done").length })} · ${gh("documentDiscardCount", { count: discards.filter(record => record.references?.[0]?.version === item.hash).flatMap(record => record.references || []).length })}${stale ? ` · ${gh("documentDiscardStale")}` : ""}`, stale ? "gh-warning" : "gh-muted");
        const rowActions = el("div", "", "gh-actions");
        rowActions.append(button(gh("documentOpen"), () => void showDocument(item.path), "read-document"));
        row.append(title, source, meta, review, rowActions); list.append(row);
        indexed.push({ item, row, group });
      }
      group.append(list); groups.append(group);
    }
    const applyFilter = () => {
      const term = documentQuery.trim().toLocaleLowerCase(), visible = new Map<HTMLDetailsElement, number>();
      for (const { item, row, group } of indexed) {
        const hasComments = documentReviewRecords(records, documentFileUri(root(), item.path)).length > 0;
        const hasDiscard = records.some(record => !record.archived && record.scope === DOCUMENT_SELECTION_SCOPE && record.result === "discard" && record.status === "active" && record.references?.[0]?.uri.split("#", 1)[0] === documentFileUri(root(), item.path));
        const show = (documentFilter === "all" || (documentFilter === "comments" && hasComments) || (documentFilter === "discarded" && hasDiscard)) && `${item.title} ${item.path}`.toLocaleLowerCase().includes(term);
        row.hidden = !show;
        if (show) visible.set(group, (visible.get(group) || 0) + 1);
      }
      for (const group of groups.querySelectorAll<HTMLDetailsElement>(".gh-document-group")) {
        const shown = visible.get(group) || 0;
        group.hidden = shown === 0;
        const label = group.querySelector<HTMLElement>("summary small"); if (label) label.textContent = String(shown);
        if (term || documentFilter !== "all") group.open = shown > 0;
      }
      const shown = [...visible.values()].reduce((sum, value) => sum + value, 0);
      count.textContent = gh("documentCount", { shown, total: documents.length }); empty.hidden = shown > 0;
    };
    search.addEventListener("input", () => { documentQuery = search.value; applyFilter(); });
    filter.addEventListener("change", () => { documentFilter = filter.value; applyFilter(); });
    board.append(groups, empty); main.append(board); applyFilter();
  }

  function orderedLocations(): GameLocation[] {
    if (!zone) return [];
    const view = zone.view, order: string[] = [], seen = new Set<string>();
    const queue = view.locations.some(item => item.id === view.entry) ? [view.entry] : [];
    while (queue.length) { const current = queue.shift()!; if (seen.has(current)) continue; seen.add(current); order.push(current);
      for (const route of view.routes) { const next = route.from === current ? route.to : route.to === current ? route.from : undefined; if (next && !seen.has(next)) queue.push(next); } }
    return [...order.map(id => view.locations.find(item => item.id === id)!).filter(Boolean), ...view.locations.filter(item => !seen.has(item.id))];
  }

  function role(node: GameLocation) {
    if (!zone) return "";
    return node.id === zone.view.entry ? gh("entry") : node.role === "gate" ? gh("gate") : node.role === "shop" ? gh("shop") : node.rest ? gh("rest") : gh("location");
  }

  function renderGraph(container: HTMLElement) {
    if (!zone) return;
    const view = zone.view, distances = new Map<string, number>(), queue: string[] = [];
    if (view.locations.some(node => node.id === view.entry)) { distances.set(view.entry, 0); queue.push(view.entry); }
    while (queue.length) { const current = queue.shift()!; for (const edge of view.routes) { const next = edge.from === current ? edge.to : edge.to === current ? edge.from : undefined; if (next && !distances.has(next)) { distances.set(next, distances.get(current)! + 1); queue.push(next); } } }
    const last = Math.max(0, ...distances.values()); for (const node of view.locations) if (!distances.has(node.id)) distances.set(node.id, last + 1);
    const levels = new Map<number, GameLocation[]>(); for (const node of view.locations) { const depth = distances.get(node.id)!; levels.set(depth, [...(levels.get(depth) || []), node]); }
    for (const group of levels.values()) group.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    const columns = Math.max(1, levels.size), rows = Math.max(1, ...[...levels.values()].map(group => group.length));
    const width = Math.max(520, columns * 150), height = Math.max(200, rows * 92 + 30);
    const scroll = el("div", "", "gh-graph-scroll"); const stage = el("div", "", "gh-graph"); stage.style.width = `${width}px`; stage.style.height = `${height}px`;
    const positions = new Map<string, { x: number; y: number }>();
    for (const [column, group] of levels) group.forEach((node, index) => positions.set(node.id, { x: (column + .5) * width / columns, y: (index + .5) * height / group.length }));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("aria-hidden", "true");
    for (const edge of view.routes) { const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) continue;
      const line = document.createElementNS(svg.namespaceURI, "path"); line.setAttribute("d", `M ${from.x} ${from.y} L ${to.x} ${to.y}`); if (locationId === edge.from || locationId === edge.to) line.classList.add("selected"); svg.append(line); }
    stage.append(svg);
    for (const node of view.locations) {
      const position = positions.get(node.id)!;
      const item = button("", () => go("object", undefined, node.id), "open-location", "gh-node"); item.dataset.ghLocation = node.id;
      item.setAttribute("aria-pressed", String(locationId === node.id)); item.style.left = `${position.x}px`; item.style.top = `${position.y}px`;
      if (node.missing) item.classList.add("missing");
      item.append(el("strong", node.name), el("small", role(node))); stage.append(item);
    }
    scroll.append(stage); container.append(scroll, el("small", gh("routeHelp"), "gh-muted"));
  }

  function mentions(ids: string[]): DocMention[] {
    const seen = new Set<string>(), found: DocMention[] = [];
    for (const id of ids) for (const mention of zone?.relations?.design[id] || []) { const key = `${mention.path}:${mention.line}`; if (!seen.has(key)) { seen.add(key); found.push(mention); } }
    return found;
  }
  function excerpt(text: string) {
    const line = text.trim();
    if (line.startsWith("|")) return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim()).filter(Boolean).join(" · ").replaceAll("`", "");
    return line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "").replaceAll("**", "").replaceAll("`", "");
  }
  function renderMentions(container: HTMLElement, found: DocMention[]) {
    if (!found.length) { container.append(el("p", gh("noDesign"), "gh-unknown")); return; }
    const list = el("ul", "", "gh-mentions");
    for (const mention of found.slice(0, 12)) {
      const row = el("li"); row.append(el("strong", mention.heading.replaceAll("`", "") || mention.title), el("p", excerpt(mention.excerpt), "gh-prose"), sourceLine({ path: mention.path, hash: mention.hash, line: mention.line }));
      list.append(row);
    }
    container.append(list);
  }
  function proposalsFor(filter: (proposal: ProjectProposal) => boolean, container: HTMLElement) {
    const list = proposals.filter(filter);
    if (!list.length) return;
    const box = section(gh("proposalsHere"), "proposals-here", badge(gh("inferenceBadge"), "inference"));
    for (const proposal of list) box.append(renderProposalCard(proposal, () => { reviewing = proposal.id; render(); }));
    container.append(box);
  }

  function renderExperience() {
    if (!zone) return;
    const view = zone.view, relations = zone.relations;
    const head = el("section", "", "gh-intro"); const title = el("h3", view.zone.name); title.tabIndex = -1;
    head.append(title, el("small", [relations?.dungeon?.name, relations?.region?.name].filter(Boolean).join(" · ")), el("p", view.description, "gh-prose"));
    const meta = el("div", "", "gh-inline"); meta.append(badge(gh("configBadge"), "config"), el("small", `${view.zone.id} · ${gh("sourceRevision", { hash: short(view.source_revision) })}`));
    head.append(meta); main.append(head);
    const route = section(gh("routeTitle"), "route", badge(gh("configBadge"), "config")); renderGraph(route); main.append(route);

    const chain = section(gh("chainTitle"), "chain", badge(gh("configBadge"), "config"));
    for (const node of orderedLocations()) {
      const card = el("article", "", "gh-location"); card.dataset.ghChain = node.id;
      const top = el("header"); top.append(el("strong", node.name), badge(role(node)));
      if (node.missing) top.append(badge(gh("missing"), "warning"));
      card.append(top);
      const encounters = node.candidates.filter(item => item.kind !== "shop");
      card.append(el("p", encounters.length ? `${gh("encounters")}：${encounters.map(item => `${kindLabelFor(item.kind)} ${item.associated_name || item.name}`).join("、")}` : gh("noEncounters"), "gh-prose"));
      const rewards = [...new Set([...node.candidates.map(item => item.loot_table_name || item.loot_table_id).filter(Boolean), ...(node.loot_points || []).map(point => point.loot_table_name || point.loot_table_id)])];
      card.append(el("p", rewards.length ? `${gh("rewards")}：${rewards.join("、")}` : gh("noRewards"), "gh-prose"));
      const extra = el("div", "", "gh-inline");
      if (node.unlock_cost !== undefined && node.unlock_cost !== null) extra.append(badge(gh("unlockCost", { value: JSON.stringify(node.unlock_cost) })));
      if (node.unlocks_zone) extra.append(badge(gh("unlocksZone", { zone: node.unlocks_zone })));
      card.append(extra, button(gh("scaleObject"), () => go("object", undefined, node.id), "open-location"));
      chain.append(card);
    }
    main.append(chain);

    const missions = section(gh("missionsTitle"), "missions", badge(gh("configBadge"), "config"));
    if (!relations?.missions.length) missions.append(el("p", gh("noMissions"), "gh-unknown"));
    for (const mission of relations?.missions || []) {
      const card = el("article", "", "gh-mission"); card.dataset.ghMission = mission.id;
      card.append(el("strong", mission.name || mission.id), el("small", mission.basis.map(item => item.text).join(" · ")));
      for (const objective of mission.objectives) {
        const places = objective.at.map(at => zone!.view.locations.find(item => item.id === at.location_id)?.name || at.location_id);
        card.append(el("p", `${objective.name || objective.id}${objective.enemy_id ? ` · ${objective.enemy_id}${objective.amount ? ` ×${objective.amount}` : ""}` : ""}${places.length ? ` → ${places.join("、")}` : ""}`, "gh-prose"));
      }
      card.append(sourceLine(mission.source)); missions.append(card);
    }
    main.append(missions);

    const design = section(gh("designTitle"), "design", badge(gh("designBadge"), "design"));
    renderMentions(design, mentions([view.zone.id, view.dungeon_id || ""].filter(Boolean)));
    design.append(el("small", gh("designNote"), "gh-muted")); main.append(design);
    proposalsFor(proposal => proposal.subject?.zone_id === view.zone.id && !proposal.subject.location_id, main);
    if (view.issues.length) {
      const checks = el("details", "", "gh-checks"); checks.append(el("summary", gh("checks", { count: view.issues.length })));
      for (const issue of view.issues) { const line = el("p", issue.message, issue.severity === "error" ? "gh-warning" : "gh-muted"); line.title = issue.path; checks.append(line); }
      main.append(checks);
    }
  }

  function kindLabelFor(kind: string) {
    const known: Record<string, string> = currentLocale() === "zh-CN"
      ? { Battle: "战斗", Event: "事件", Treasure: "宝藏", Rest: "休息", BossGate: "守关战", shop: "商店" }
      : { Battle: "Battle", Event: "Event", Treasure: "Treasure", Rest: "Rest", BossGate: "Gate battle", shop: "Shop" };
    return known[kind] || kind;
  }

  function codeFields(node: GameLocation): string[] {
    const fields = ["SubLocationRoutes", "EntrySubLocationId"];
    if (node.candidates.length) fields.push("ContentPoolIds", "ContentPoolWeights", "FirstEntryContent", "AssociatedDataId");
    if (node.role === "gate") fields.push("BossGateContentId", "UnlocksZoneId");
    if ((node.loot_points || []).length || node.candidates.some(item => item.loot_table_id)) fields.push("LootPoints", "LootTableId");
    if (node.rest) fields.push("RestContentId");
    if (node.role === "shop") fields.push("ShopConfigId");
    return fields;
  }

  function renderObject() {
    const node = location();
    if (!zone || !node) { main.append(el("p", gh("noLocation"), "gh-unknown"), button(gh("back"), () => go("experience"), "back-experience")); return; }
    const head = el("section", "", "gh-intro"); const title = el("h3", node.name); title.tabIndex = -1;
    const meta = el("div", "", "gh-inline"); meta.append(badge(role(node)), el("code", node.id));
    head.append(title, meta, el("p", node.description, "gh-prose")); main.append(head);
    const grid = el("div", "", "gh-evidence");

    const design = section(gh("designTitle"), "object-design", badge(gh("designBadge"), "design"));
    renderMentions(design, mentions([node.id, ...node.candidates.flatMap(item => [item.id, item.associated_id || ""]).filter(Boolean)]));
    grid.append(design);

    const config = section(gh("configTitle"), "object-config", badge(gh("configBadge"), "config"));
    for (const candidate of node.candidates) {
      const card = el("article", "", "gh-candidate"); card.dataset.ghCandidate = candidate.id;
      const top = el("header"); top.append(badge(kindLabelFor(candidate.kind)), el("strong", candidate.associated_name || candidate.name));
      if (candidate.first_entry) top.append(badge(gh("first")));
      if (candidate.weight !== null && candidate.weight !== undefined) top.append(badge(gh("weight", { value: candidate.weight })));
      if (candidate.missing) top.append(badge(gh("missing"), "warning"));
      card.append(top, el("code", [candidate.id, candidate.associated_id].filter(Boolean).join(" → ")));
      if (candidate.enemies.length) card.append(el("small", gh("enemies", { list: candidate.enemies.join("、") })));
      if (candidate.loot_table_id) card.append(el("small", gh("table", { name: candidate.loot_table_name || candidate.loot_table_id })));
      const sources = el("div", "", "gh-inline");
      for (const path of candidate.paths) { const open = button(path.split("/").at(-1) || path, () => void showSource(path), "view-source", "gh-source-button"); open.title = path; open.dataset.ghSource = path; sources.append(open); }
      card.append(sources); config.append(card);
    }
    for (const point of node.loot_points || []) {
      const row = el("p", gh("lootPoint", { kind: point.kind || point.name, table: point.loot_table_name || point.loot_table_id }), point.missing ? "gh-warning" : "gh-prose");
      if (point.unlock_condition) row.append(el("small", ` · ${point.unlock_condition}`));
      config.append(row);
    }
    if (node.unlock_cost !== undefined && node.unlock_cost !== null) config.append(el("p", gh("unlockCost", { value: JSON.stringify(node.unlock_cost) })));
    if (node.unlocks_zone) config.append(el("p", gh("unlocksZone", { zone: node.unlocks_zone })));
    if (node.path) { const open = button(gh("viewSource"), () => void showSource(node.path!), "view-source", "gh-source-button"); open.dataset.ghSource = node.path; config.append(open); }
    grid.append(config);

    const code = section(gh("codeTitle"), "object-code", badge(gh("codeBadge"), "code"));
    const hits = codeFields(node).flatMap(field => (zone!.relations?.code[field] || []).slice(0, 3).map(hit => ({ field, hit })));
    if (!hits.length) code.append(el("p", gh("noCode"), "gh-unknown"));
    const list = el("ul", "", "gh-code");
    for (const { field, hit } of hits as Array<{ field: string; hit: CodeHit }>) { const row = el("li"); row.append(el("strong", field), el("code", hit.text), sourceLine({ path: hit.path, hash: hit.hash, line: hit.line })); list.append(row); }
    code.append(list, el("small", gh("codeNote"), "gh-muted")); grid.append(code);

    const verify = section(gh("verificationTitle"), "object-verification", badge(gh("verificationBadge"), "verification"));
    verify.append(el("p", gh("verificationUnknown"), "gh-unknown"));
    const objectId = zone.object_ids.find(item => item.location_id === node.id)?.object_id;
    const paths = new Set([node.path, ...node.candidates.flatMap(item => item.paths)].filter(Boolean) as string[]);
    const related = records.filter(record => record.object_id === objectId || (record.references || []).some(reference => [...paths].some(path => decodeSafe(reference.uri).endsWith(path))));
    verify.append(el("h4", gh("relatedRecords")));
    if (!related.length) verify.append(el("p", gh("noRecords"), "gh-muted"));
    for (const record of related) {
      const row = el("article", "", "gh-record"); row.append(el("strong", record.title), badge(pt(({ planned: "statusPlanned", active: "statusActive", blocked: "statusBlocked", done: "statusDone", cancelled: "statusCancelled" } as const)[record.status || "planned"])));
      if (record.boundaries) row.append(el("small", gh("recordBoundary", { text: record.boundaries })));
      row.append(button(gh("openRecord"), () => options.openRecord(record.id), "open-record")); verify.append(row);
    }
    grid.append(verify);
    main.append(grid);
    const ids = new Set([node.id, ...node.candidates.map(item => item.id)]);
    proposalsFor(proposal => proposal.subject?.zone_id === zone!.view.zone.id && (proposal.subject.location_id === node.id || ids.has(proposal.subject.entity_id || "")), main);
  }

  function renderSide() {
    side.replaceChildren();
    if (!project) return;
    const heading = el("h3", gh("currentWork")); side.append(heading);
    const review = el("section", "", "gh-side-section"); review.dataset.ghSide = "proposals";
    const open = proposals.filter(proposal => proposal.status === "open");
    review.append(el("h4", `${gh("reviewTitle")} · ${open.length}`));
    if (!open.length) review.append(el("p", gh("noProposals"), "gh-muted"));
    for (const proposal of open.slice(0, 8)) review.append(renderProposalCard(proposal, () => { reviewing = proposal.id; render(); main.querySelector<HTMLElement>("h3")?.focus(); }));
    side.append(review);

    const goalBox = el("section", "", "gh-side-section"); goalBox.dataset.ghSide = "goals";
    goalBox.append(el("h4", gh("goalsTitle")));
    if (!goals.length) goalBox.append(el("p", gh("noGoals"), "gh-muted"));
    for (const goal of goals.slice(0, 10)) {
      const card = el("article", "", "gh-goal"); card.dataset.ghGoalId = goal.id; card.dataset.status = goal.status;
      const state = goalStatus(goal); card.dataset.tone = state.tone;
      card.append(el("p", goal.text.length > 160 ? `${goal.text.slice(0, 160)}…` : goal.text, "gh-prose"));
      card.append(el("small", [goal.context.label, date(goal.created_at_ms)].filter(Boolean).join(" · ")));
      const line = el("p", state.text, `gh-goal-status ${state.tone}`); line.dataset.ghGoalStatus = goal.delivery?.phase || goal.status; card.append(line);
      const pendingAccess = goal.target && accesses.find(access => access.thread_id === goal.target!.thread_id && access.state === "pending");
      const actions = el("div", "", "gh-actions");
      if (pendingAccess) {
        card.append(el("small", gh("accessPending", { label: pendingAccess.label || pendingAccess.source_id }), "gh-warning"));
        const approve = button(gh("approve"), () => void decideAccess(pendingAccess, "approved"), "approve-access", "primary"); approve.disabled = busy; actions.append(approve);
      }
      if (goal.status === "unsent" && sortedBindings().length && goal.context.entity_kind !== "document_question") { const send = button(gh("sendSaved"), () => void sendSaved(goal), "send-saved", "primary"); send.disabled = busy; actions.append(send); }
      for (const id of goal.proposal_ids) { const proposal = proposals.find(item => item.id === id); if (proposal) actions.append(button(`${gh("viewProposal")} · ${proposal.title}`, () => { reviewing = id; render(); }, "open-goal-proposal")); }
      if (goal.record_id) actions.append(button(gh("openRecord"), () => options.openRecord(goal.record_id!), "open-goal-record"));
      else if (goal.context.entity_kind !== "document_question") { const track = button(gh("promote"), () => void promote(goal), "promote"); track.disabled = busy; actions.append(track); }
      card.append(actions); goalBox.append(card);
    }
    side.append(goalBox);

    const work = el("section", "", "gh-side-section"); work.dataset.ghSide = "records";
    work.append(el("h4", gh("recordsTitle")));
    const active = records.filter(record => !record.archived && record.scope !== DOCUMENT_REVIEW_SCOPE && record.scope !== DOCUMENT_DECISION_SCOPE && record.scope !== DOCUMENT_SELECTION_SCOPE && ["active", "blocked", "planned"].includes(record.status || "planned")).slice(0, 6);
    if (!active.length) work.append(el("p", gh("noActiveRecords"), "gh-muted"));
    for (const record of active) {
      const row = el("article", "", "gh-record"); row.append(el("strong", record.title), badge(pt(({ planned: "statusPlanned", active: "statusActive", blocked: "statusBlocked", done: "statusDone", cancelled: "statusCancelled" } as const)[record.status || "planned"])));
      if (record.next_step) row.append(el("small", record.next_step.length > 120 ? `${record.next_step.slice(0, 120)}…` : record.next_step));
      row.append(button(gh("openRecord"), () => options.openRecord(record.id), "open-record")); work.append(row);
    }
    side.append(work);
  }

  function decodeSafe(uri: string) { try { return decodeURI(uri).replaceAll("\\", "/"); } catch { return uri.replaceAll("\\", "/"); } }

  document.addEventListener("click", event => {
    if (!connectionOpen) return;
    const box = top.querySelector("[data-gh-connection]");
    if (box && !box.contains(event.target as Node) && !(event.target as HTMLElement).closest?.("[data-gh-action=how-to-connect]")) { connectionOpen = false; renderTop(); }
  });
  window.addEventListener("focus", () => { if (!element.hidden && element.closest("dialog")?.open && project && !busy && !loading && !sourceDialog.open) void loadProjectData(project.id, epoch).then(() => renderQuiet()).catch(() => undefined); });
  onLocale(() => { if (project) render(); });
  render();

  return {
    element,
    async setProject(next: Project | undefined) {
      if (project?.id === next?.id) { project = next; if (next && connection === undefined && !loading) await load(false); return; }
      documentViewer?.dispose(); documentViewer = undefined; if (sourceDialog.open) sourceDialog.close();
      window.clearTimeout(poll); ++epoch;
      project = next; connection = undefined; overview = undefined; zone = undefined; goals = []; proposals = []; objects = []; records = []; accesses = []; bindings = [];
      reviewing = undefined; documentsOpen = false; documentQuery = ""; documentFilter = "all"; error = ""; zoneError = ""; setNotice("");
      documentMarks = project ? readLocal<Record<string, DocumentMark>>(key("doc-marks")) || {} : {};
      const saved = project ? readLocal<{ scale: Scale; zoneId: string; locationId: string }>(key("view")) : undefined;
      scale = saved?.scale || "overview"; zoneId = saved?.zoneId || ""; locationId = saved?.locationId || "";
      if (scale !== "overview" && !zoneId) scale = "overview";
      draft = { text: "", target: "", withContext: true, ...(project ? readLocal<Draft>(key("composer")) : {}) };
      render();
      if (project) await load(false);
    },
    async refresh(force = false) { if (project) await load(force); },
    visible(value: boolean) { if (value) { schedulePoll(); } else window.clearTimeout(poll); },
    back,
  };
}

export { subjectLabel, kindLabel };
