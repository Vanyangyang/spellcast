import { t } from "../i18n";
import type { BoardNode, BoardSnapshot, NodeKind } from "../types";
import { kindLabel } from "../types";
import { cardHtml } from "./shared";

const COLS: NodeKind[] = ["insight", "idea", "question", "risk", "action"];

export function renderStack(
  host: HTMLElement,
  board: BoardSnapshot,
  selected: string | null,
  onSelect: (id: string | null) => void,
) {
  const used = COLS.filter((k) => board.nodes.some((n) => n.kind === k));
  const columns = (used.length ? used : COLS).map((kind) => {
    const nodes = board.nodes.filter((n) => n.kind === kind);
    return `
      <section class="col">
        <h2>${kindLabel(kind)} <em>${nodes.length}</em></h2>
        ${nodes.map((n: BoardNode) => cardHtml(n, n.id === selected)).join("")}
      </section>
    `;
  });

  host.innerHTML = `
    <div class="stack">
      <p class="form-kicker">${t("formKicker.stack")}</p>
      <div class="cols">${columns.join("")}</div>
    </div>
  `;

  host.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(el.dataset.id ?? null);
    });
  });
}
