import { onLocale } from "./i18n";
import { csk } from "./i18n/canvas-source-skeleton";
import { fetchGameConnection } from "./project-game-api";
import { fetchGameDocument, type GameDocument } from "./project-game-home-api";
import { renderGameSkeleton } from "./project-game-skeleton";
import type { SkeletonNode } from "./project-game-skeleton-model";
import type { CanvasSourceSkeleton } from "./types";
import "./canvas-source-skeleton.css";
import "./canvas-source-skeleton-reader.css";

type Options = {
  objectId: string;
  projectLabel?: string;
  onSelect(id: string): void;
  onDiscuss(id: string, intent: "develop" | "question"): void;
  onRefresh(): Promise<void>;
};

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
};

const sourceKey = (id: string) => `spellcast.canvas.skeleton.${id}`;
const hasNode = (source: CanvasSourceSkeleton, id: string) => !id || source.model.nodes.some(node => node.id === id);
const documentTitle = (path: string) => path.split(/[\\/]/).at(-1) || path;
const rootLabel = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
const normalizedRoot = (path: string) => {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  return /^[a-z]:(?:\/|$)/i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
};
type BrowsingView = { selectedId: string; query: string; mapScroll: number; detailScroll: number; bodyScroll: number };
type SavedView = Partial<BrowsingView> & { history?: unknown[]; historyIndex?: number; skeletonSelectedId?: string; skeletonQuery?: string };
const HISTORY_LIMIT = 64;
const safeRead = (key: string): SavedView | null => {
  try {
    const raw = localStorage.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value as SavedView : null;
  } catch { return null; }
};

/** Text used by Canvas selection, copying, annotations, and task context. */
export function skeletonSelectionText(skeleton: CanvasSourceSkeleton, id = ""): { title: string; body: string } {
  const model = skeleton.model;
  const node = id ? model.nodes.find(candidate => candidate.id === id) : undefined;
  const lines: string[] = [];
  const section = (label: string, values: readonly string[] | undefined) => {
    if (values?.length) lines.push(`${label}:`, ...values.map(value => `• ${value}`), "");
  };
  if (!node) {
    lines.push(model.description, "");
    section(csk("roots"), model.entry_ids.map(rootId => model.nodes.find(item => item.id === rootId)).filter((item): item is SkeletonNode => !!item).map(item => `${item.title} — ${item.summary}`));
    section(csk("loop"), model.loop.map(stage => `${stage.title} — ${stage.summary}`));
  } else {
    lines.push(node.summary, "");
    const rules = node.rule;
    const fields = [["trigger", "ruleTrigger"], ["conditions", "ruleConditions"], ["effects", "ruleEffects"], ["exceptions", "ruleExceptions"], ["formulas", "ruleFormulas"], ["conflicts", "ruleConflicts"]] as const;
    for (const [field, label] of fields) section(csk(label), rules?.[field]);
    section(csk("notes"), node.notes);
    section(csk("steps"), node.steps?.map(step => `${step.title}: ${step.text}`));
    section(csk("children"), model.nodes.filter(item => item.parent_id === node.id).map(item => `${item.title} — ${item.summary}`));
    section(csk("related"), model.relations.flatMap(relation => {
      const otherId = relation.from === node.id ? relation.to : relation.to === node.id ? relation.from : "";
      const other = model.nodes.find(item => item.id === otherId);
      return other ? [`${relation.label}: ${other.title}`] : [];
    }));
    section(csk("evidence"), node.provenance?.map(item => `${item.quote}\n${item.path}:L${item.start_line}–${item.end_line} · SHA-256 ${item.hash}${item.archived ? ` (${csk("archived")})` : ""}`));
    section(csk("sources"), node.sources);
  }
  lines.push(`${csk("project", { name: rootLabel(skeleton.root) })}\n${skeleton.root}\n${csk("snapshot")}: ${skeleton.path} · SHA-256 ${skeleton.hash}`);
  return { title: node?.title || skeleton.title || model.title, body: lines.join("\n").trim() };
}

/** Canvas-native, read-only browser for an authored game structure snapshot. */
export function mountSourceSkeleton(host: HTMLElement, initial: CanvasSourceSkeleton, options: Options) {
  const root = element("section", "canvas-source-skeleton");
  root.dataset.canvasSourceSkeleton = options.objectId;
  root.setAttribute("aria-label", initial.title || initial.model.title);
  host.append(root);
  const key = sourceKey(options.objectId);
  const saved = safeRead(key) || safeRead(`spellcast.game-home.v1.${initial.project_id}.view`);
  let source = initial;
  const savedId = saved?.selectedId ?? saved?.skeletonSelectedId ?? "";
  let selectedId = typeof savedId === "string" && hasNode(source, savedId) ? savedId : "";
  const savedQuery = saved?.query ?? saved?.skeletonQuery;
  let query = typeof savedQuery === "string" ? savedQuery : "";
  const scrollValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  let mapScroll = scrollValue(saved?.mapScroll);
  let detailScroll = scrollValue(saved?.detailScroll);
  let bodyScroll = scrollValue(saved?.bodyScroll);
  let narrowMode = false;
  const currentView = (): BrowsingView => ({ selectedId, query, mapScroll, detailScroll, bodyScroll });
  const readHistory = (values: unknown[]): BrowsingView[] => values.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const view = value as Partial<BrowsingView>;
    return typeof view.selectedId === "string" && hasNode(source, view.selectedId)
      ? [{ selectedId: view.selectedId, query: typeof view.query === "string" ? view.query : "", mapScroll: scrollValue(view.mapScroll), detailScroll: scrollValue(view.detailScroll), bodyScroll: scrollValue(view.bodyScroll) }]
      : [];
  });
  const savedHistory = Array.isArray(saved?.history) ? saved.history.slice(0, HISTORY_LIMIT) : [];
  const savedIndex = Number.isInteger(saved?.historyIndex) && saved!.historyIndex! >= 0 && saved!.historyIndex! < savedHistory.length ? saved!.historyIndex! : 0;
  const previous = readHistory(savedHistory.slice(0, savedIndex));
  // Older versions remember a node but no history. Its ancestors still provide a way back.
  if (!savedHistory.length && selectedId) {
    const seen = new Set([selectedId]);
    let parentId = source.model.nodes.find(node => node.id === selectedId)?.parent_id;
    while (parentId && !seen.has(parentId) && previous.length < HISTORY_LIMIT - 2) {
      const parent = source.model.nodes.find(node => node.id === parentId);
      if (!parent) break;
      seen.add(parentId);
      previous.unshift({ selectedId: parentId, query: "", mapScroll: 0, detailScroll: 0, bodyScroll: 0 });
      parentId = parent.parent_id;
    }
    previous.unshift({ selectedId: "", query: "", mapScroll: 0, detailScroll: 0, bodyScroll: 0 });
  }
  let history = [...previous, currentView(), ...readHistory(savedHistory.slice(savedIndex + 1))];
  let historyIndex = previous.length;
  let busy = false;
  let refreshError: string | null = null;
  let sourceRequest = 0;
  let destroyed = false;

  function captureScroll() {
    if (narrowMode) {
      const body = root.querySelector<HTMLElement>(".canvas-source-skeleton-body");
      if (body) bodyScroll = body.scrollTop;
      return;
    }
    const map = root.querySelector<HTMLElement>(".canvas-source-skeleton-map");
    const detail = root.querySelector<HTMLElement>(".canvas-source-skeleton-detail");
    if (map) mapScroll = map.scrollTop;
    if (detail) detailScroll = detail.scrollTop;
  }

  function selectedControl() {
    return [...root.querySelectorAll<HTMLButtonElement>(".gs-node-row, .gs-group-title")].find(node => node.dataset.gsNodeId === selectedId);
  }

  function layoutView(fresh = false) {
    const body = root.querySelector<HTMLElement>(".canvas-source-skeleton-body");
    const map = root.querySelector<HTMLElement>(".canvas-source-skeleton-map");
    const detail = root.querySelector<HTMLElement>(".canvas-source-skeleton-detail");
    if (destroyed || !body?.clientWidth || !map || !detail) return;
    const nextNarrow = body.clientWidth <= 760;
    if (!fresh && nextNarrow !== narrowMode) captureScroll();
    narrowMode = nextNarrow;
    body.classList.toggle("is-narrow", narrowMode);
    if (narrowMode) {
      const row = selectedControl()?.closest<HTMLElement>(".gs-node-entry");
      const heading = map.querySelector<HTMLElement>(".gs-group-header");
      if (row) { if (detail.parentElement !== row) row.append(detail); }
      else if (heading) { if (heading.nextElementSibling !== detail) heading.after(detail); }
      else if (detail.parentElement !== map) map.prepend(detail);
      body.scrollTop = bodyScroll;
    } else {
      if (detail.parentElement !== body) body.append(detail);
      map.scrollTop = mapScroll;
      detail.scrollTop = detailScroll;
    }
  }

  function focusSelection(reveal = false) {
    const control = selectedControl();
    if (!control || root.closest("[inert]")) return;
    control.focus({ preventScroll: true });
    if (!reveal) return;
    const scroller = root.querySelector<HTMLElement>(narrowMode ? ".canvas-source-skeleton-body" : ".canvas-source-skeleton-map");
    if (!scroller) return;
    const item = control.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
    if (item.top < viewport.top) scroller.scrollTop -= viewport.top - item.top;
    else if (item.bottom > viewport.bottom) scroller.scrollTop += item.bottom - viewport.bottom;
  }

  function persist() {
    history[historyIndex] = currentView();
    try { localStorage.setItem(key, JSON.stringify({ ...currentView(), history, historyIndex })); } catch { /* browsing still works */ }
  }

  function select(id: string, notify = true) {
    const next = hasNode(source, id) ? id : "";
    if (next === selectedId) return;
    captureScroll(); persist();
    history = history.slice(0, historyIndex + 1);
    selectedId = next; detailScroll = 0;
    history.push(currentView());
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    persist(); paint(true, true);
    if (notify) options.onSelect(selectedId);
  }

  function travel(offset: -1 | 1) {
    const nextIndex = historyIndex + offset;
    const next = history[nextIndex];
    if (!next) return;
    captureScroll(); persist();
    historyIndex = nextIndex;
    ({ selectedId, query, mapScroll, detailScroll, bodyScroll } = next);
    persist(); paint(true); options.onSelect(selectedId);
  }

  function closeSource() {
    sourceRequest++;
    const panel = root.querySelector<HTMLDialogElement>(".canvas-source-skeleton-source-view");
    if (panel?.open) panel.close();
    panel?.remove();
  }

  function sourcePanel(title: string, returnToList = false) {
    closeSource();
    const panel = element("dialog", "canvas-source-skeleton-source-view");
    panel.setAttribute("aria-label", title);
    const header = element("header", "canvas-source-skeleton-source-head");
    const actions = element("div", "canvas-source-skeleton-source-actions");
    const back = element("button", "canvas-source-skeleton-button", csk("returnToSkeleton"));
    back.type = "button";
    back.addEventListener("click", () => {
      closeSource(); focusSelection();
      if (!selectedControl()) root.querySelector<HTMLElement>("[data-skeleton-tools-toggle]")?.focus({ preventScroll: true });
    });
    let initialFocus = back;
    if (returnToList) {
      const listBack = element("button", "canvas-source-skeleton-button", `← ${csk("returnToSourceList")}`);
      listBack.type = "button";
      listBack.addEventListener("click", () => showSources(title));
      actions.append(listBack);
      initialFocus = listBack;
    }
    actions.append(back);
    header.append(element("strong", "", title), actions);
    const status = element("p", "canvas-source-skeleton-source-status", csk("loadingSource"));
    status.setAttribute("role", "status");
    panel.append(header, status);
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); back.click(); }
    });
    panel.addEventListener("cancel", event => { event.preventDefault(); back.click(); });
    root.append(panel);
    panel.showModal();
    initialFocus.focus({ preventScroll: true });
    return { panel, status };
  }

  async function openSource(path: string, returnToList = false) {
    if (destroyed) return;
    const documentStamp = source.documents.find(document => document.path === path);
    const { panel, status } = sourcePanel(path, returnToList);
    const request = ++sourceRequest;
    if (!documentStamp || documentStamp.error || !documentStamp.hash) { status.textContent = csk("sourceUnavailable"); return; }
    const documentHash = documentStamp.hash;
    const projectId = source.project_id;
    const sourceRoot = source.root;
    try {
      const live = await fetchGameConnection(projectId);
      if (destroyed || request !== sourceRequest) return;
      if (!live.connection || live.connection.project_id !== projectId || normalizedRoot(live.connection.root) !== normalizedRoot(sourceRoot) || source.project_id !== projectId || source.root !== sourceRoot) {
        status.textContent = csk("sourceMismatch");
        return;
      }
      const document = await fetchGameDocument(projectId, path);
      if (destroyed || request !== sourceRequest) return;
      const expected = source.documents.find(item => item.path === path);
      if (source.project_id !== projectId || source.root !== sourceRoot || !expected || expected.hash !== documentHash || document.path !== path || !document.hash || document.hash.toLowerCase() !== documentHash.toLowerCase()) {
        status.textContent = csk("sourceMismatch");
        return;
      }
      if (document.error || typeof document.text !== "string") { status.textContent = csk("sourceUnavailable"); return; }
      status.textContent = `${documentTitle(path)} · SHA-256 ${document.hash}`;
      panel.append(element("pre", "canvas-source-skeleton-source-text", document.text));
    } catch {
      if (!destroyed && request === sourceRequest) status.textContent = csk("sourceUnavailable");
    }
  }

  function showSources(focusPath = "") {
    if (destroyed) return;
    const nodes = selectedId ? source.model.nodes.filter(node => node.id === selectedId) : source.model.nodes;
    const referenced = new Set(nodes.flatMap(node => [...node.sources, ...(node.provenance || []).filter(item => !item.archived).map(item => item.path)]));
    const documents = source.documents.filter(document => referenced.has(document.path));
    const { panel, status } = sourcePanel(csk("viewSources"));
    status.textContent = csk(documents.length ? "chooseSource" : "noSources");
    const list = element("div", "canvas-source-skeleton-source-list");
    let focusTarget: HTMLButtonElement | undefined;
    for (const document of documents) {
      const button = element("button", "canvas-source-skeleton-button");
      button.type = "button";
      button.append(element("strong", "", documentTitle(document.path)), element("small", "", document.path));
      if (document.error || !document.hash) button.append(element("small", "", csk("sourceUnavailable")));
      button.addEventListener("click", () => { void openSource(document.path, true); });
      if (document.path === focusPath) focusTarget = button;
      list.append(button);
    }
    panel.append(list);
    if (focusTarget) {
      list.scrollTop = Math.max(0, focusTarget.offsetTop - list.offsetTop);
      focusTarget.focus({ preventScroll: true });
    }
  }

  function paint(restoreView = false, revealSelection = false) {
    if (destroyed) return;
    if (!restoreView) captureScroll();
    const focusSearch = root.contains(document.activeElement) && document.activeElement?.classList.contains("gs-search-input");
    const focusNavigation = root.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.skeletonNavigation : undefined;
    const focusNode = root.contains(document.activeElement) && !!(document.activeElement as HTMLElement)?.closest("[data-gs-node-id]");
    const focusTools = root.contains(document.activeElement) && !!(document.activeElement as HTMLElement)?.closest(".canvas-source-skeleton-tools");
    closeSource();

    const header = element("header", "canvas-source-skeleton-header");
    const navigation = element("nav", "canvas-source-skeleton-navigation");
    navigation.setAttribute("aria-label", csk("navigation"));
    for (const [direction, offset, label] of [["back", -1, `← ${csk("back")}`], ["forward", 1, `${csk("forward")} →`]] as const) {
      const button = element("button", "canvas-source-skeleton-button", label);
      button.type = "button";
      button.dataset.skeletonNavigation = direction;
      button.setAttribute("aria-label", csk(direction));
      const destination = history[historyIndex + offset];
      button.disabled = !destination;
      button.title = destination ? csk(direction === "back" ? "backTo" : "forwardTo", { name: source.model.nodes.find(node => node.id === destination.selectedId)?.title || csk("rootSummary") }) : csk(direction);
      button.addEventListener("click", () => travel(offset));
      navigation.append(button);
    }
    const toolsMenu = element("details", "canvas-source-skeleton-tools");
    const toolsToggle = element("summary", "canvas-source-skeleton-button", csk("gameTools"));
    toolsToggle.dataset.skeletonToolsToggle = "true";
    toolsToggle.setAttribute("aria-label", csk("gameTools"));
    const actions = element("div", "canvas-source-skeleton-header-actions");
    const sources = element("button", "canvas-source-skeleton-button", csk("viewSources"));
    sources.type = "button";
    sources.addEventListener("click", () => { toolsMenu.open = false; showSources(); });
    const manage = element("button", "canvas-source-skeleton-button", csk("manageProject"));
    manage.type = "button";
    manage.dataset.skeletonAction = "manage";
    manage.addEventListener("click", () => { toolsMenu.open = false; window.dispatchEvent(new CustomEvent("spellcast:open-game-workspace", { detail: { projectId: source.project_id } })); });
    const refresh = element("button", "canvas-source-skeleton-button", busy ? csk("refreshing") : csk("refresh"));
    refresh.type = "button";
    refresh.dataset.skeletonAction = "refresh";
    refresh.disabled = busy;
    refresh.addEventListener("click", async () => {
      if (busy || destroyed) return;
      busy = true; refreshError = null; refresh.disabled = true; refresh.textContent = csk("refreshing");
      try { await options.onRefresh(); }
      catch (error) { refreshError = error instanceof Error && error.message ? `${csk("refreshFailed")} ${error.message}` : csk("refreshFailed"); }
      finally { busy = false; if (!destroyed) paint(); }
    });
    actions.append(sources, refresh, manage);
    const meta = element("details", "canvas-source-skeleton-meta");
    meta.append(element("summary", "", csk("snapshotDetails")), element("small", "", `${csk("project", { name: options.projectLabel?.trim() || rootLabel(source.root) })}\n${source.root}\n${source.path}\nSHA-256 ${source.hash}`));
    actions.append(meta);
    toolsMenu.append(toolsToggle, actions);
    toolsMenu.addEventListener("keydown", event => {
      if (event.key === "Escape" && toolsMenu.open) { event.preventDefault(); event.stopPropagation(); toolsMenu.open = false; toolsToggle.focus(); }
    });
    const alert = refreshError ? element("p", "canvas-source-skeleton-error", refreshError) : null;
    if (alert) alert.setAttribute("role", "alert");

    const documents: GameDocument[] = source.documents.map(document => ({ ...document, title: documentTitle(document.path) }));
    const rendered = renderGameSkeleton({
      skeleton: { source: { path: source.path, hash: source.hash }, model: source.model },
      documents, selectedId, query, mode: "canvas",
      onSelect: id => select(id),
      onQuery: value => { query = value; persist(); },
      onDiscuss: options.onDiscuss,
      onSource: path => { void openSource(path); },
    });
    header.append(navigation);
    if (rendered.navigation) header.append(rendered.navigation);
    if (rendered.search) header.append(rendered.search);
    header.append(toolsMenu);
    if (alert) header.append(alert);
    const body = element("div", "canvas-source-skeleton-body");
    const map = element("div", "canvas-source-skeleton-map");
    const detail = element("div", "canvas-source-skeleton-detail");
    detail.setAttribute("aria-label", source.model.nodes.find(node => node.id === selectedId)?.title || csk("rootSummary"));
    map.append(rendered.map); detail.append(rendered.detail); body.append(map, detail);
    root.replaceChildren(header, body);
    layoutView(true);
    map.addEventListener("scroll", () => { if (map.isConnected && !narrowMode) { mapScroll = map.scrollTop; persist(); } }, { passive: true });
    detail.addEventListener("scroll", () => { if (detail.isConnected && !narrowMode) { detailScroll = detail.scrollTop; persist(); } }, { passive: true });
    body.addEventListener("scroll", () => { if (body.isConnected && narrowMode) { bodyScroll = body.scrollTop; persist(); } }, { passive: true });
    if (focusSearch) root.querySelector<HTMLInputElement>(".gs-search-input")?.focus();
    if (focusNavigation) (navigation.querySelector<HTMLButtonElement>(`[data-skeleton-navigation="${focusNavigation}"]:not(:disabled)`) || navigation.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
    else if (focusNode || revealSelection) focusSelection(revealSelection);
    else if (focusTools) toolsToggle.focus({ preventScroll: true });
  }

  const unsubscribe = onLocale(paint);
  const resize = new ResizeObserver(() => layoutView());
  resize.observe(root);
  paint();
  return {
    update(next: CanvasSourceSkeleton) {
      const same = next.hash === source.hash && next.project_id === source.project_id && next.root === source.root && next.path === source.path && next.title === source.title && JSON.stringify(next.documents) === JSON.stringify(source.documents);
      if (!same) captureScroll();
      source = next;
      if (!same) {
        if (!hasNode(source, selectedId)) { selectedId = ""; detailScroll = 0; }
        const before = readHistory(history.slice(0, historyIndex));
        history = [...before, currentView(), ...readHistory(history.slice(historyIndex + 1))];
        historyIndex = before.length;
        persist(); paint(true);
      }
    },
    select(id: string) { select(id, false); },
    selectedId: () => selectedId,
    showSources,
    destroy() { captureScroll(); persist(); destroyed = true; resize.disconnect(); closeSource(); unsubscribe(); root.remove(); },
  };
}
