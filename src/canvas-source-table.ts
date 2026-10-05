import { onLocale } from "./i18n";
import { gh } from "./i18n/game-home";
import { csk } from "./i18n/canvas-source-skeleton";
import { fetchGameConnection } from "./project-game-api";
import { fetchGameDocument } from "./project-game-home-api";
import type { CanvasSourceTable } from "./types";
import "./canvas-source-table.css";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

export type SourceTableOptions = { projectLabel?: string; onRefresh?(): Promise<void> };

const normalizedRoot = (path: string) => {
  const value = path.trim().replaceAll("\\", "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  return /^[a-z]:(?:\/|$)/i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
};

/** A source snapshot has its own readable shape, without an in-place editor. */
export function mountSourceTable(host: HTMLElement, initial: CanvasSourceTable, options: SourceTableOptions = {}) {
  const root = el("section", "", "canvas-source-table");
  host.append(root);
  let table = initial;
  let sourceRequest = 0;
  let destroyed = false;
  let busy = false;
  let refreshError: string | null = null;

  function closeSource() {
    sourceRequest++;
    const panel = root.querySelector<HTMLDialogElement>(".canvas-source-table-source-view");
    if (panel?.open) panel.close();
    panel?.remove();
  }

  async function openSource() {
    if (destroyed) return;
    closeSource();
    const request = ++sourceRequest;
    const { project_id: projectId, root: sourceRoot, path, hash } = table;
    const panel = el("dialog", "", "canvas-source-table-source-view");
    panel.setAttribute("aria-label", path);
    const header = el("header", "", "canvas-source-table-source-head");
    const close = el("button", csk("returnToLoop"), "canvas-source-table-button");
    close.type = "button";
    close.addEventListener("click", () => { closeSource(); root.querySelector<HTMLElement>(".canvas-source-table-tools > summary")?.focus({ preventScroll: true }); });
    header.append(el("strong", path), close);
    const status = el("p", csk("loadingSource"), "canvas-source-table-source-status");
    status.setAttribute("role", "status");
    panel.append(header, status);
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.click(); }
    });
    panel.addEventListener("cancel", event => { event.preventDefault(); close.click(); });
    root.append(panel);
    panel.showModal();
    close.focus({ preventScroll: true });
    try {
      const live = await fetchGameConnection(projectId);
      if (destroyed || request !== sourceRequest) return;
      if (!live.connection || live.connection.project_id !== projectId || normalizedRoot(live.connection.root) !== normalizedRoot(sourceRoot)) {
        status.textContent = csk("sourceMismatch");
        return;
      }
      const document = await fetchGameDocument(projectId, path);
      if (destroyed || request !== sourceRequest) return;
      if (document.path !== path || !document.hash || document.hash.toLowerCase() !== hash.toLowerCase()) {
        status.textContent = csk("sourceMismatch");
        return;
      }
      if (document.error || typeof document.text !== "string") { status.textContent = csk("sourceUnavailable"); return; }
      status.textContent = `SHA-256 ${document.hash}`;
      panel.append(el("pre", document.text, "canvas-source-table-source-text"));
    } catch {
      if (!destroyed && request === sourceRequest) status.textContent = csk("sourceUnavailable");
    }
  }

  function paint() {
    if (destroyed) return;
    closeSource();
    root.setAttribute("aria-label", table.title);
    const header = el("header", "", "canvas-source-table-header");
    const badge = el("small", gh("designBadge"), "canvas-source-table-badge");
    const tools = el("details", "", "canvas-source-table-tools");
    const toggle = el("summary", csk("gameTools"), "canvas-source-table-button");
    const actions = el("div", "", "canvas-source-table-actions");
    const read = el("button", csk("viewSources"), "canvas-source-table-button");
    read.type = "button";
    read.dataset.tableSource = "true";
    read.addEventListener("click", () => { tools.open = false; void openSource(); });
    actions.append(read);
    if (options.onRefresh) {
      const refresh = el("button", busy ? csk("refreshing") : csk("refresh"), "canvas-source-table-button");
      refresh.type = "button";
      refresh.disabled = busy;
      refresh.addEventListener("click", async () => {
        if (busy || destroyed) return;
        busy = true; refreshError = null; refresh.disabled = true; refresh.textContent = csk("refreshing");
        try { await options.onRefresh!(); }
        catch (error) { refreshError = error instanceof Error && error.message ? `${csk("refreshFailed")} ${error.message}` : csk("refreshFailed"); }
        finally { busy = false; if (!destroyed) paint(); }
      });
      actions.append(refresh);
    }
    const manage = el("button", csk("manageProject"), "canvas-source-table-button");
    manage.type = "button";
    manage.addEventListener("click", () => { tools.open = false; window.dispatchEvent(new CustomEvent("spellcast:open-game-workspace", { detail: { projectId: table.project_id } })); });
    const meta = el("details", "", "canvas-source-table-meta");
    const projectName = options.projectLabel?.trim() || table.root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || table.root;
    meta.append(el("summary", csk("snapshotDetails")), el("small", `${csk("project", { name: projectName })}\n${table.root}\n${table.path} § ${table.heading}\nSHA-256 ${table.hash}`));
    actions.append(manage, meta);
    tools.append(toggle, actions);
    tools.addEventListener("keydown", event => {
      if (event.key === "Escape" && tools.open) { event.preventDefault(); event.stopPropagation(); tools.open = false; toggle.focus(); }
    });
    header.append(badge, tools);
    const source = el("small", `${table.path} § ${table.heading} · ${gh("line", { line: table.line })} · sha ${table.hash.slice(0, 8)}`, "canvas-source-table-source");
    source.title = `${table.path}\nSHA-256 ${table.hash}`;
    const note = el("small", gh("designNote"), "canvas-source-table-note");
    const grid = el("div", "", "canvas-source-table-scroll");
    const htmlTable = el("table");
    const columnHeader = el("tr");
    for (const column of table.columns) columnHeader.append(el("th", column));
    htmlTable.append(el("thead"));
    htmlTable.tHead!.append(columnHeader);
    const body = el("tbody");
    for (const cells of table.rows) {
      const row = el("tr");
      for (const cell of cells) row.append(el("td", cell));
      body.append(row);
    }
    htmlTable.append(body);
    grid.append(htmlTable);
    root.replaceChildren(header, grid, source, note);
    if (refreshError) {
      const alert = el("p", refreshError, "canvas-source-table-error");
      alert.setAttribute("role", "alert");
      root.append(alert);
    }
  }

  const unsubscribe = onLocale(paint);
  paint();
  return {
    update(next: CanvasSourceTable) {
      const same = JSON.stringify(next) === JSON.stringify(table);
      table = next;
      if (!same) paint();
    },
    showSource() { void openSource(); },
    destroy() { destroyed = true; closeSource(); unsubscribe(); root.remove(); },
  };
}
