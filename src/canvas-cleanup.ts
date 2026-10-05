import { Archive, ArchiveRestore, CheckCheck, ListFilter, LocateFixed, Merge, RefreshCw, Undo2, X, createElement, type IconNode } from "lucide";
import { fetchFeedbackState } from "./api";
import { applyCleanup, cleanupGuard, type CleanupGuard } from "./canvas-cleanup-api";
import { analyzeCleanup, mergeCleanupItems, prepareCleanup, type CleanupAnalysis, type CleanupGroup, type CleanupItem, type CleanupPrepared } from "./canvas-cleanup-model";
import { cleanupText as tx } from "./i18n/canvas-cleanup";
import { onLocale } from "./i18n";
import type { BoardSnapshot, CanvasBatchRequest, CanvasOperation, CanvasRead, FeedbackState } from "./types";
import "./canvas-cleanup.css";

type Options = {
  reload(): Promise<BoardSnapshot>;
  scopeIds(): ReadonlySet<string>;
  selectedIds(): string[];
  protectedIds(): ReadonlySet<string>;
  applied(board: BoardSnapshot): void;
  locate(id: string): void;
  openRemoved(): void;
};
type Pending = { prepared: CleanupPrepared; guard: CleanupGuard; attempts: number };
type Undo = { batch: CanvasBatchRequest; revision: number };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function iconButton(icon: IconNode, action: () => void, className = "ghost") {
  const node = el("button", className); node.type = "button"; node.addEventListener("click", action);
  node.append(createElement(icon, { width: 16, height: 16, "aria-hidden": "true" })); return node;
}
function labelButton(node: HTMLButtonElement, text: string, icon?: IconNode) {
  node.replaceChildren(); if (icon) node.append(createElement(icon, { width: 16, height: 16, "aria-hidden": "true" }));
  node.append(document.createTextNode(text)); node.title = text; node.setAttribute("aria-label", text);
}

export function canvasCleanup(options: Options) {
  const dialog = el("dialog", "canvas-cleanup"); dialog.id = "canvas-cleanup-dialog";
  const head = el("header"), title = el("h2"); title.id = "canvas-cleanup-title"; dialog.setAttribute("aria-labelledby", title.id);
  const close = iconButton(X, () => dialog.close(), "ghost cleanup-icon"); head.append(title, close);
  const controls = el("div", "cleanup-controls");
  const scopeLabel = el("label"), scopeText = el("span"), scope = el("select"); scope.id = "cleanup-scope"; scopeLabel.append(scopeText, scope);
  const tabs = el("div", "cleanup-tabs"); tabs.setAttribute("role", "tablist");
  const suggestions = el("button"), all = el("button");
  for (const tab of [suggestions, all]) { tab.type = "button"; tab.setAttribute("role", "tab"); }
  suggestions.dataset.cleanupTab = "suggestions"; all.dataset.cleanupTab = "all"; tabs.append(suggestions, all);
  const search = el("input"); search.type = "search"; search.id = "cleanup-search";
  const refresh = iconButton(RefreshCw, () => { void load(); }, "ghost cleanup-icon");
  controls.append(scopeLabel, tabs, search, refresh);
  const actions = el("div", "cleanup-actions");
  const selectHandled = iconButton(CheckCheck, () => {
    for (const item of analysis.items) if (item.reason === "handled" && !item.blocked.length && matches(item)) archiveIds.add(item.id);
    pending = null; paint();
  });
  const selectVisible = iconButton(CheckCheck, () => {
    for (const item of listedItems()) if (!item.blocked.length) archiveIds.add(item.id);
    pending = null; paint();
  });
  const clear = iconButton(X, () => { archiveIds.clear(); mergeIds.clear(); pending = null; paint(); });
  const manualMerge = iconButton(Merge, () => {
    try {
      const group = mergeCleanupItems(analysis.items.filter(item => archiveIds.has(item.id)));
      customGroup = group; analysis.groups = [group, ...analysis.groups.filter(candidate => !candidate.items.some(item => group.items.some(member => member.id === item.id)))];
      for (const item of group.items) archiveIds.delete(item.id);
      mergeIds = new Set([...mergeIds].filter(id => analysis.groups.some(candidate => candidate.id === id)));
      mergeIds.add(group.id); pending = null; tab = "suggestions"; search.value = ""; notice(); paint();
      list.scrollTop = 0;
      list.querySelector<HTMLDetailsElement>("details[data-merge-preview]")?.setAttribute("open", "");
    } catch { notice(tx("mergeUnavailable"), true); }
  });
  const count = el("small"); actions.append(selectHandled, selectVisible, clear, manualMerge, count);
  const list = el("div", "cleanup-list"); list.setAttribute("role", "tabpanel");
  const message = el("p", "cleanup-notice"); message.setAttribute("role", "status");
  const footer = el("footer"), total = el("span", "cleanup-total");
  const removed = iconButton(ArchiveRestore, () => { dialog.close(); options.openRemoved(); });
  const undo = iconButton(Undo2, () => { void revert(); });
  const apply = iconButton(Archive, () => { void save(); }, "primary");
  const caption = el("p", "cleanup-caption"); footer.append(total, removed, undo, apply, caption);
  dialog.append(head, controls, actions, list, message, footer); document.body.append(dialog);

  let snapshot: BoardSnapshot | null = null, feedback: FeedbackState | null = null;
  let analysis: CleanupAnalysis = { items: [], groups: [] };
  let tab: "suggestions" | "all" = "suggestions", busy = false, stale = false, destroyed = false;
  let viewIds = new Set<string>(), selectedIds = new Set<string>();
  let archiveIds = new Set<string>(), mergeIds = new Set<string>();
  let customGroup: CleanupGroup | null = null, pending: Pending | null = null, lastUndo: Undo | null = null;
  let undoRequest: { batch: CanvasBatchRequest; guard: CleanupGuard } | null = null;
  const trigger = iconButton(ListFilter, () => { void open(); }, "ghost canvas-tool-icon canvas-cleanup-open");

  function notice(text = "", error = false) { message.textContent = text; message.classList.toggle("is-error", error); }
  function matches(item: CleanupItem) {
    const query = search.value.trim().toLocaleLowerCase();
    return !query || [item.title, item.text ?? item.excerpt, item.origin.taskLabel, item.origin.workspaceLabel].join("\n").toLocaleLowerCase().includes(query);
  }
  function listedItems() { return analysis.items.filter(item => matches(item) && (tab === "all" || item.reason !== "none") && !mergeMembers().has(item.id)); }
  function mergeMembers() { return new Set(analysis.groups.filter(group => mergeIds.has(group.id)).flatMap(group => group.items.map(item => item.id))); }
  function recalculate() {
    if (!snapshot || !feedback) return;
    analysis = analyzeCleanup(snapshot, feedback, scope.value === "selection" ? selectedIds : viewIds, options.protectedIds());
    archiveIds = new Set(analysis.items.filter(item => item.reason === "handled" && !item.blocked.length).map(item => item.id));
    mergeIds.clear(); customGroup = null; pending = null; stale = false; paint();
  }
  async function load() {
    if (busy) return;
    busy = true; notice(tx("loading")); paint();
    try {
      const next = await options.reload();
      const state = await fetchFeedbackState();
      if (destroyed) return;
      snapshot = next; feedback = state; viewIds = new Set(options.scopeIds());
      recalculate(); notice();
    } catch (error) { snapshot = null; feedback = null; analysis = { items: [], groups: [] }; notice(String(error), true); }
    finally { busy = false; if (!destroyed) paint(); }
  }
  async function open() {
    selectedIds = new Set(options.selectedIds());
    scope.replaceChildren(new Option(tx("view"), "view"));
    if (selectedIds.size) scope.append(new Option(`${tx("selection")} (${selectedIds.size})`, "selection"));
    scope.value = selectedIds.size > 1 ? "selection" : "view";
    search.value = ""; tab = "suggestions";
    if (!dialog.open) dialog.showModal();
    await load();
  }
  function makeUndo(board: BoardSnapshot, prepared: CleanupPrepared): Undo {
    const objects = new Map(board.canvas?.objects.map(object => [object.id, object]));
    const items = new Map(board.canvas?.items.map(item => [item.item_id, item]));
    const reads: CanvasRead[] = [], operations: CanvasOperation[] = [];
    for (const id of [...prepared.archivedIds, ...prepared.createdIds]) {
      const object = objects.get(id), item = items.get(id); if (!object || !item) throw new Error(tx("changed"));
      reads.push({ kind: "content", id, revision: object.content_revision }, { kind: "presentation", id, revision: item.revision });
      operations.push({ op: "place", id, expected_revision: item.revision, fields: { removed: prepared.createdIds.includes(id) } });
    }
    return { revision: board.canvas?.revision ?? 0, batch: { request_id: crypto.randomUUID(), reads, operations } };
  }
  async function save() {
    if (busy || !snapshot || !feedback || (stale && !pending)) return;
    try {
      const protectedNow = options.protectedIds();
      const affected = pending ? pending.prepared.archivedIds : [...archiveIds, ...mergeMembers()];
      if (affected.some(id => protectedNow.has(id))) { stale = true; throw new Error("cleanup.changed"); }
      if (!pending) {
        pending = { prepared: prepareCleanup(analysis, { archiveIds, mergeIds }), guard: cleanupGuard(snapshot, feedback), attempts: 0 };
      }
      busy = true; notice(tx("applying")); paint();
      const held = pending; held.attempts++;
      const outcome = await applyCleanup(held.guard, held.prepared.batch);
      if (destroyed) return;
      options.applied(outcome.board);
      if (outcome.result.status !== "applied") { pending = null; stale = true; throw new Error(tx("changed")); }
      lastUndo = held.attempts === 1 ? makeUndo(outcome.board, held.prepared) : null;
      undoRequest = null; snapshot = outcome.board; pending = null;
      const n = held.prepared.archivedIds.length;
      recalculate(); archiveIds.clear(); notice(tx("done", { n }));
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const key = code === "cleanup.empty" ? "nothing" : code === "cleanup.limit" ? "limit" : code === "cleanup.changed" ? "changed" : null;
      notice(key ? tx(key) : `${pending ? tx("failed") + "\n" : ""}${code}`, true);
    } finally { busy = false; if (!destroyed) paint(); }
  }
  async function revert() {
    if (busy || !lastUndo) return;
    busy = true; notice(tx("applying")); paint();
    try {
      const protectedNow = options.protectedIds();
      if (lastUndo.batch.operations.some(operation => operation.op === "place" && protectedNow.has(operation.id))) throw new Error(tx("undoChanged"));
      if (!undoRequest) {
        const next = await options.reload();
        if ((next.canvas?.revision ?? 0) !== lastUndo.revision) throw new Error(tx("undoChanged"));
        feedback = await fetchFeedbackState();
        undoRequest = { batch: lastUndo.batch, guard: cleanupGuard(next, feedback) };
      }
      const outcome = await applyCleanup(undoRequest.guard, undoRequest.batch);
      if (destroyed) return;
      options.applied(outcome.board);
      if (outcome.result.status !== "applied") throw new Error(tx("undoChanged"));
      lastUndo = null; undoRequest = null; snapshot = outcome.board; recalculate(); archiveIds.clear(); notice(tx("undoDone"));
    } catch (error) { notice(String(error), true); }
    finally { busy = false; if (!destroyed) paint(); }
  }

  function itemRow(item: CleanupItem) {
    const row = el("article", "cleanup-row"); row.dataset.cleanupItem = item.id;
    const label = el("label"), check = el("input"); check.type = "checkbox"; check.checked = archiveIds.has(item.id);
    check.disabled = busy || stale || !!item.blocked.length || !!pending;
    check.setAttribute("aria-label", `${tx("archive")} ${item.title || tx("untitled")}`);
    check.addEventListener("change", () => { if (check.checked) archiveIds.add(item.id); else archiveIds.delete(item.id); paintActions(); });
    const copy = el("div", "cleanup-copy"); copy.append(el("strong", "", item.title || tx("untitled")), el("p", "", item.excerpt));
    const meta = el("div", "cleanup-meta");
    meta.append(el("span", `cleanup-state${item.blocked.length ? " is-blocked" : ""}`, item.blocked.length ? item.blocked.map(reason => tx(reason)).join(" · ") : tx(item.reason)));
    meta.append(el("span", "", [item.origin.workspaceLabel, item.origin.taskLabel].filter(Boolean).join(" · "))); copy.append(meta);
    label.append(check, copy); row.append(label);
    const details = el("details"); details.append(el("summary", "", tx("details")), el("pre", "cleanup-original", item.text ?? item.excerpt));
    const locate = iconButton(LocateFixed, () => { dialog.close(); options.locate(item.id); }, "ghost cleanup-locate"); labelButton(locate, tx("inspect"), LocateFixed); details.append(locate); row.append(details);
    return row;
  }
  function groupRow(group: CleanupGroup) {
    const row = el("article", "cleanup-row"); row.dataset.cleanupGroup = group.id;
    const label = el("label"), check = el("input"); check.type = "checkbox"; check.checked = mergeIds.has(group.id); check.disabled = busy || stale || !!pending;
    check.setAttribute("aria-label", `${tx("merge")} ${group.title || tx("untitled")}`);
    check.addEventListener("change", () => {
      if (check.checked) { mergeIds.add(group.id); for (const item of group.items) archiveIds.delete(item.id); }
      else mergeIds.delete(group.id);
      paint();
    });
    const copy = el("div", "cleanup-copy"); copy.append(el("strong", "", group.title || tx("untitled")));
    copy.append(el("p", "", group.items.map(item => item.title || item.excerpt).join(" · ")));
    copy.append(el("span", "cleanup-meta", `${group === customGroup ? tx("merge") : tx(group.exact ? "exact" : "similar")} · ${tx("groupCount", { n: group.items.length })}`));
    label.append(check, copy); row.append(label);
    const details = el("details"); details.dataset.mergePreview = group.id;
    details.append(el("summary", "", tx("preview")), el("p", "cleanup-caption", tx("mergeHint")), el("pre", "cleanup-merged", group.text));
    const originals = el("details"); originals.append(el("summary", "", tx("originals")));
    for (const item of group.items) originals.append(el("strong", "", item.title || tx("untitled")), el("pre", "cleanup-original", item.text ?? ""));
    details.append(originals); row.append(details); return row;
  }
  function paintActions() {
    const merged = mergeMembers(), archives = [...archiveIds].filter(id => !merged.has(id));
    total.textContent = tx("summary", { archive: archives.length, merge: mergeIds.size });
    count.textContent = tx("count", { n: analysis.items.length });
    labelButton(apply, tx(busy ? "applying" : pending ? "retry" : "apply"), Archive);
    apply.disabled = busy || (!pending && (stale || (!archives.length && !mergeIds.size)));
    manualMerge.disabled = busy || stale || !!pending || archives.length < 2;
    clear.disabled = busy || !!pending || (!archiveIds.size && !mergeIds.size);
    selectHandled.disabled = busy || stale || !!pending; selectVisible.disabled = busy || stale || !!pending;
    refresh.disabled = busy; scope.disabled = busy || !!pending; search.disabled = busy;
    undo.hidden = !lastUndo; undo.disabled = busy; removed.disabled = busy;
    close.disabled = busy;
  }
  function paint() {
    const expanded = new Set([...list.querySelectorAll<HTMLDetailsElement>("details[data-merge-preview][open]")].map(node => node.dataset.mergePreview));
    list.replaceChildren();
    const items = listedItems();
    const groups = tab === "suggestions" ? analysis.groups.filter(group => group.items.some(matches)) : [];
    if (groups.length) { list.append(el("h3", "", tx("mergeSection"))); for (const group of groups) list.append(groupRow(group)); }
    if (items.length) { if (tab === "suggestions") list.append(el("h3", "", tx("archiveSection"))); for (const item of items) list.append(itemRow(item)); }
    for (const detail of list.querySelectorAll<HTMLDetailsElement>("details[data-merge-preview]")) detail.open = expanded.has(detail.dataset.mergePreview);
    if (!items.length && !groups.length) list.append(el("p", "cleanup-empty", busy ? tx("loading") : tx(search.value ? "emptySearch" : tab === "all" ? "emptyAll" : "empty")));
    suggestions.setAttribute("aria-selected", String(tab === "suggestions")); all.setAttribute("aria-selected", String(tab === "all"));
    paintActions();
  }
  function labels() {
    title.textContent = tx("title"); trigger.title = tx("title"); trigger.setAttribute("aria-label", tx("title"));
    close.title = tx("close"); close.setAttribute("aria-label", tx("close"));
    refresh.title = tx("refresh"); refresh.setAttribute("aria-label", tx("refresh"));
    scopeText.textContent = tx("scope"); search.placeholder = tx("search"); search.setAttribute("aria-label", tx("search"));
    suggestions.textContent = tx("suggestions"); all.textContent = tx("all");
    labelButton(selectHandled, tx("selectHandled"), CheckCheck); labelButton(selectVisible, tx("selectVisible"), CheckCheck);
    labelButton(clear, tx("clear"), X); labelButton(manualMerge, tx("mergeSelected"), Merge);
    labelButton(undo, tx("undo"), Undo2); labelButton(removed, tx("removed"), ArchiveRestore);
    caption.textContent = tx("ready");
    for (const option of scope.options) option.text = option.value === "view" ? tx("view") : `${tx("selection")} (${selectedIds.size})`;
    paint();
  }
  scope.addEventListener("change", () => { recalculate(); notice(); });
  search.addEventListener("input", () => { paint(); list.scrollTop = 0; });
  suggestions.addEventListener("click", () => { tab = "suggestions"; paint(); list.scrollTop = 0; });
  all.addEventListener("click", () => { tab = "all"; paint(); list.scrollTop = 0; });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  const unsubscribe = onLocale(labels); labels();
  return {
    button: trigger,
    changed(board: BoardSnapshot) {
      if (!dialog.open || busy || !snapshot || (board.canvas?.revision ?? 0) === (snapshot.canvas?.revision ?? 0)) return;
      stale = true; notice(tx("changed"), true); paint();
    },
    destroy() { destroyed = true; unsubscribe(); dialog.remove(); trigger.remove(); },
  };
}
