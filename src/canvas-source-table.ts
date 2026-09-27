import { onLocale } from "./i18n";
import { gh } from "./i18n/game-home";
import type { CanvasSourceTable } from "./types";
import "./canvas-source-table.css";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** A source snapshot has its own readable shape, without an in-place editor. */
export function mountSourceTable(host: HTMLElement, initial: CanvasSourceTable) {
  const root = el("section", "", "canvas-source-table");
  host.append(root);
  let table = initial;

  function paint() {
    const badge = el("small", gh("designBadge"), "canvas-source-table-badge");
    const source = el("small", `${table.path} § ${table.heading} · ${gh("line", { line: table.line })} · sha ${table.hash.slice(0, 8)}`, "canvas-source-table-source");
    source.title = `${table.path}\nSHA-256 ${table.hash}`;
    const note = el("small", gh("designNote"), "canvas-source-table-note");
    const grid = el("div", "", "canvas-source-table-scroll");
    const htmlTable = el("table");
    const header = el("tr");
    for (const column of table.columns) header.append(el("th", column));
    htmlTable.append(el("thead"));
    htmlTable.tHead!.append(header);
    const body = el("tbody");
    for (const cells of table.rows) {
      const row = el("tr");
      for (const cell of cells) row.append(el("td", cell));
      body.append(row);
    }
    htmlTable.append(body);
    grid.append(htmlTable);
    root.replaceChildren(badge, grid, source, note);
  }

  const unsubscribe = onLocale(paint);
  paint();
  return {
    update(next: CanvasSourceTable) { table = next; paint(); },
    destroy() { unsubscribe(); root.remove(); },
  };
}
