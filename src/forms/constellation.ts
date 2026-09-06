import type { BoardSnapshot } from "../types";
import { bounds, cardHtml, mapRange } from "./shared";

export type ConstellationHandlers = {
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, z: number) => void;
  onCreateAt: (x: number, z: number) => void;
};

export function renderConstellation(
  host: HTMLElement,
  board: BoardSnapshot,
  selected: string | null,
  handlers: ConstellationHandlers,
) {
  const box = bounds(board.nodes);
  const cards = board.nodes
    .map((n) => {
      const left = mapRange(n.x, box.minX, box.maxX, 8, 86);
      const top = mapRange(n.z, box.minZ, box.maxZ, 10, 78);
      // The outermost fragments map to 8% / 86%; on a narrow plane that lands a 240px card
      // half outside the window. Keep the whole card inside so a focused thought is readable.
      return `<div class="pin" data-pin="${n.id}" style="left:clamp(132px, ${left}%, calc(100% - 132px));top:${top}%">${cardHtml(n, n.id === selected)}</div>`;
    })
    .join("");

  const lines = board.edges
    .map((e) => {
      const a = board.nodes.find((n) => n.id === e.from);
      const b = board.nodes.find((n) => n.id === e.to);
      if (!a || !b) return "";
      const x1 = mapRange(a.x, box.minX, box.maxX, 8, 86);
      const y1 = mapRange(a.z, box.minZ, box.maxZ, 10, 78);
      const x2 = mapRange(b.x, box.minX, box.maxX, 8, 86);
      const y2 = mapRange(b.z, box.minZ, box.maxZ, 10, 78);
      return `<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%" />`;
    })
    .join("");

  host.innerHTML = `
    <div class="constellation">
      <svg class="threads" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>
      ${cards}
    </div>
  `;

  const field = host.querySelector<HTMLElement>(".constellation")!;

  field.querySelectorAll<HTMLElement>("[data-pin]").forEach((pin) => {
    const id = pin.dataset.pin!;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;

    pin.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      pin.setPointerCapture(event.pointerId);
      pin.classList.add("is-drag");
    });

    pin.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 4) moved = true;
      const rect = field.getBoundingClientRect();
      const left = ((event.clientX - rect.left) / rect.width) * 100;
      const top = ((event.clientY - rect.top) / rect.height) * 100;
      pin.style.left = `${Math.min(92, Math.max(4, left))}%`;
      pin.style.top = `${Math.min(88, Math.max(6, top))}%`;
    });

    pin.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      pin.classList.remove("is-drag");
      pin.releasePointerCapture(event.pointerId);
      if (moved) {
        const rect = field.getBoundingClientRect();
        const left = ((event.clientX - rect.left) / rect.width) * 100;
        const top = ((event.clientY - rect.top) / rect.height) * 100;
        handlers.onMove(
          id,
          mapRange(left, 8, 86, box.minX, box.maxX),
          mapRange(top, 10, 78, box.minZ, box.maxZ),
        );
      } else {
        handlers.onSelect(id);
      }
    });
  });

  field.addEventListener("click", (event) => {
    if (event.target === field) handlers.onSelect(null);
  });

  field.addEventListener("dblclick", (event) => {
    if (event.target !== field && !(event.target as HTMLElement).classList.contains("threads")) {
      return;
    }
    const rect = field.getBoundingClientRect();
    const left = ((event.clientX - rect.left) / rect.width) * 100;
    const top = ((event.clientY - rect.top) / rect.height) * 100;
    handlers.onCreateAt(
      mapRange(left, 8, 86, box.minX, box.maxX),
      mapRange(top, 10, 78, box.minZ, box.maxZ),
    );
  });
}
