import { KIND_TONE } from "./forms/shared";
import { kindLabel } from "./types";
import type { ThrownBubble } from "./types";

export function bubbleMarkup(item: ThrownBubble): string {
  const glimpse =
    item.size === "flare" && item.body && item.body !== item.tease
      ? `<small>${escapeHtml(clip(item.body, 18))}</small>`
      : "";
  const kind = item.size === "whisper" ? "" : `<em>${escapeHtml(kindLabel(item.kind))}</em>`;
  return `
    <i class="sheen" aria-hidden="true"></i>
    ${kind}
    <span>${escapeHtml(item.tease)}</span>
    ${glimpse}
  `;
}

export function applyBubbleEl(el: HTMLElement, item: ThrownBubble) {
  el.className = `bubble size-${item.size}`;
  el.style.setProperty("--tone", KIND_TONE[item.kind]);
  el.dataset.kind = item.kind;
  el.dataset.size = item.size;
  el.dataset.poke = item.on_poke;
  el.setAttribute("aria-label", item.tease);
  el.innerHTML = bubbleMarkup(item);
}

function clip(text: string, max: number) {
  const t = text.trim();
  const chars = [...t];
  return chars.length <= max ? t : `${chars.slice(0, max - 1).join("")}…`;
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
