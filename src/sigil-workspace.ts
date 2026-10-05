import "./sigil-workspace.css";
import { onLocale } from "./i18n";
import { st, type SigilKey } from "./i18n/sigil";
import { fetchSigils, type SigilSummary } from "./sigil-api";
import { mountSigilCard, type SigilCard } from "./sigil-card";
import { isDesktopShell } from "./shell";

type Filter = "all" | "draft" | "active" | "finished";
const filters: { id: Filter; label: SigilKey }[] = [
  { id: "all", label: "workspaceAll" }, { id: "draft", label: "workspaceDraft" },
  { id: "active", label: "workspaceActive" }, { id: "finished", label: "workspaceFinished" },
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function matches(sigil: SigilSummary, filter: Filter): boolean {
  if (filter === "draft") return sigil.state === "draft" || sigil.state === "frozen";
  if (filter === "active") return sigil.state === "running" || sigil.state === "paused";
  if (filter === "finished") return ["completed", "aborted", "archived"].includes(sigil.state);
  return true;
}

/** A list of all sigils. The existing card owns every detail action and live execution state. */
export function mountSigilWorkspace(host: HTMLElement, options: { onBack: () => void }): {
  refresh(): void; refreshLabels(): void; destroy(): void;
} {
  const root = element("section", "sigil-workspace");
  const header = element("header", "sigil-workspace-header");
  const back = element("button", "sigil-workspace-button");
  back.type = "button"; back.dataset.action = "back";
  const title = element("h1", "sigil-workspace-title");
  const refreshButton = element("button", "sigil-workspace-button");
  refreshButton.type = "button"; refreshButton.dataset.action = "refresh";
  header.append(back, title, refreshButton);
  const status = element("div", "sigil-workspace-status");
  const statusText = element("p");
  const retry = element("button", "sigil-workspace-button");
  retry.type = "button"; retry.dataset.action = "refresh";
  status.append(statusText, retry);
  const body = element("div", "sigil-workspace-body");
  const list = element("section", "sigil-workspace-list");
  list.setAttribute("role", "region");
  const filterBar = element("div", "sigil-workspace-filters");
  filterBar.setAttribute("role", "group");
  for (const filter of filters) {
    const button = element("button", "sigil-workspace-filter");
    button.type = "button"; button.dataset.filter = filter.id;
    filterBar.append(button);
  }
  const count = element("p", "sigil-workspace-count");
  const entries = element("ul", "sigil-workspace-entries");
  const empty = element("div", "sigil-workspace-empty");
  const emptyTitle = element("p"), emptyHint = element("p");
  empty.append(emptyTitle, emptyHint);
  list.append(filterBar, count, entries, empty);
  const detail = element("section", "sigil-workspace-detail");
  detail.setAttribute("role", "region");
  const placeholder = element("p", "sigil-workspace-placeholder");
  detail.append(placeholder);
  body.append(list, detail);
  root.append(header, status, body);
  host.append(root);

  let sigils: SigilSummary[] = [], selectedId: string | null = null, activeFilter: Filter = "all";
  let card: SigilCard | null = null;
  let destroyed = false, loading = false, loaded = false, queued = false;
  let loadError = "", eventError = "";
  let request: AbortController | null = null;
  let unlisten: (() => void) | null = null;
  let subscribing = false;

  function visibleSigils() { return sigils.filter(sigil => matches(sigil, activeFilter)); }

  function renderStatus() {
    refreshButton.disabled = loading; retry.disabled = loading;
    list.setAttribute("aria-busy", String(loading));
    const error = loadError || eventError;
    status.hidden = !error && !loading;
    status.setAttribute("role", error ? "alert" : "status");
    statusText.textContent = loadError ? st("workspaceLoadFailed", { error: loadError })
      : eventError ? st("workspaceEventsFailed", { error: eventError }) : st("loading");
    retry.hidden = !error;
  }

  function select(id: string | null) {
    if (selectedId === id) return;
    card?.destroy(); card = null;
    selectedId = id;
    root.dataset.selectedSigil = id ?? "";
    detail.replaceChildren();
    detail.setAttribute("aria-label", st("workspaceDetail"));
    if (id) {
      card = mountSigilCard(detail, { type: "sigil", sigil_id: id }, cardTitle => {
        if (!destroyed && selectedId === id) detail.setAttribute("aria-label", `${st("workspaceDetail")} · ${cardTitle}`);
      });
    } else {
      placeholder.textContent = st("workspaceSelect");
      detail.append(placeholder);
    }
  }

  function reconcileSelection() {
    const visible = visibleSigils();
    if (!visible.some(sigil => sigil.id === selectedId)) select(visible[0]?.id ?? null);
  }

  function renderList() {
    const focusedId = document.activeElement instanceof HTMLElement && entries.contains(document.activeElement)
      ? document.activeElement.dataset.sigilId : undefined;
    const scrollTop = entries.scrollTop;
    const visible = visibleSigils();
    const nodes = visible.map(sigil => {
      const item = element("li");
      const button = element("button", "sigil-workspace-entry");
      button.type = "button"; button.dataset.sigilId = sigil.id; button.dataset.state = sigil.state;
      button.setAttribute("aria-current", String(sigil.id === selectedId));
      const label = sigil.title.trim() ? sigil.title : st("untitled");
      const state = st(`state.${sigil.state}`);
      const steps = st("steps", { n: sigil.steps });
      button.setAttribute("aria-label", `${label} · ${state} · ${steps}`);
      button.append(element("span", "sigil-workspace-entry-title", label),
        element("span", "sigil-workspace-entry-state", state), element("small", "sigil-workspace-entry-steps", steps));
      item.append(button);
      return item;
    });
    entries.replaceChildren(...nodes);
    entries.scrollTop = scrollTop;
    if (focusedId) {
      const buttons = [...entries.querySelectorAll<HTMLButtonElement>("[data-sigil-id]")];
      (buttons.find(button => button.dataset.sigilId === focusedId)
        ?? buttons.find(button => button.dataset.sigilId === selectedId) ?? filterBar.querySelector<HTMLButtonElement>("[aria-pressed='true']"))?.focus({ preventScroll: true });
    }
    count.hidden = !loaded;
    count.textContent = st("workspaceCount", { n: visible.length });
    empty.hidden = visible.length > 0 || !loaded;
    emptyTitle.textContent = st(sigils.length ? "workspaceNoMatches" : "workspaceEmpty");
    emptyHint.textContent = sigils.length ? "" : st("workspaceEmptyHint");
    emptyHint.hidden = sigils.length > 0;
  }

  function refreshList() {
    if (destroyed) return;
    if (loading) { queued = true; return; }
    loading = true;
    request = new AbortController();
    renderStatus();
    void fetchSigils(request.signal).then(value => {
      if (destroyed) return;
      sigils = value; loaded = true; loadError = "";
      reconcileSelection(); renderList();
    }).catch(error => {
      if (!destroyed) loadError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      loading = false; request = null;
      if (destroyed) return;
      renderStatus();
      if (queued) { queued = false; refreshList(); }
    });
  }

  function refresh() {
    if (destroyed) return;
    if (eventError) subscribeEvents();
    card?.refresh();
    refreshList();
  }

  function refreshLabels() {
    if (destroyed) return;
    title.textContent = st("workspaceTitle");
    root.setAttribute("aria-label", st("workspaceTitle"));
    back.textContent = st("workspaceBack"); back.setAttribute("aria-label", st("workspaceBack"));
    refreshButton.textContent = st("workspaceRefresh"); refreshButton.setAttribute("aria-label", st("workspaceRefresh"));
    retry.textContent = st("workspaceRetry"); retry.setAttribute("aria-label", st("workspaceRetry"));
    list.setAttribute("aria-label", st("workspaceList"));
    detail.setAttribute("aria-label", st("workspaceDetail"));
    filterBar.setAttribute("aria-label", st("workspaceFilters"));
    for (const filter of filters) {
      const button = filterBar.querySelector<HTMLButtonElement>(`[data-filter="${filter.id}"]`)!;
      button.textContent = st(filter.label);
      button.setAttribute("aria-pressed", String(filter.id === activeFilter));
    }
    placeholder.textContent = st("workspaceSelect");
    renderList(); renderStatus(); card?.refreshLabels();
  }

  function handleClick(event: MouseEvent) {
    if (destroyed || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button");
    if (!button || !root.contains(button) || button.disabled) return;
    if (button.dataset.action === "back") options.onBack();
    else if (button.dataset.action === "refresh") refresh();
    else if (button.dataset.filter) {
      activeFilter = button.dataset.filter as Filter;
      reconcileSelection(); refreshLabels();
    } else if (button.dataset.sigilId) {
      select(button.dataset.sigilId); renderList();
    }
  }
  root.addEventListener("click", handleClick);
  const unlocale = onLocale(refreshLabels);
  // Cards already listen for their own id, so this event refreshes only the list.
  const handleSigilEvent = () => refreshList();
  function subscribeEvents() {
    if (destroyed || unlisten || subscribing) return;
    if (!isDesktopShell()) {
      window.addEventListener("spellcast-sigil", handleSigilEvent);
      unlisten = () => window.removeEventListener("spellcast-sigil", handleSigilEvent);
      return;
    }
    subscribing = true;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (destroyed) return;
      return listen("spellcast-sigil", handleSigilEvent).then(stop => {
        if (destroyed) stop();
        else {
          unlisten = stop;
          eventError = "";
          renderStatus();
        }
      });
    }).catch(error => {
      if (destroyed) return;
      eventError = error instanceof Error ? error.message : String(error);
      renderStatus();
    }).finally(() => { subscribing = false; });
  }

  subscribeEvents();
  refreshLabels(); refreshList();
  return {
    refresh, refreshLabels,
    destroy() {
      if (destroyed) return;
      destroyed = true; queued = false;
      request?.abort(); request = null;
      unlisten?.(); unlisten = null; unlocale();
      root.removeEventListener("click", handleClick);
      card?.destroy(); card = null;
      root.remove();
    },
  };
}
