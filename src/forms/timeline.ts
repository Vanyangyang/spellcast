import { t } from "../i18n";
import type { BoardSnapshot } from "../types";
import { cardHtml } from "./shared";

export function renderTimeline(
  host: HTMLElement,
  board: BoardSnapshot,
  selected: string | null,
  onSelect: (id: string | null) => void,
) {
  const ordered = [...board.nodes].sort((a, b) => a.x - b.x || a.z - b.z);
  const items = ordered
    .map(
      (n, i) => `
      <li class="beat">
        <div class="mark">${String(i + 1).padStart(2, "0")}</div>
        ${cardHtml(n, n.id === selected)}
      </li>
    `,
    )
    .join("");

  host.innerHTML = `
    <div class="timeline">
      <p class="form-kicker">${t("formKicker.timeline")}</p>
      <ol>${items}</ol>
    </div>
  `;

  host.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(el.dataset.id ?? null);
    });
  });
}
