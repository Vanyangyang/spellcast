import { KIND_TONE } from "./forms/shared";
import { t } from "./i18n";
import type { BubbleShape, ThrownBubble } from "./types";

/**
 * Bubbles are not boxes of a fixed size. Each shape lays its words out differently and
 * grows to fit them; the window around it is fitted afterwards (see bubble.ts).
 */
export function bubbleMarkup(item: ThrownBubble): string {
  const tease = item.tease.trim();
  const title = item.title.trim();
  const body = item.body.trim();
  const showTitle = title && title !== tease && !tease.startsWith(title.replace(/…$/, ""));
  const showBody = body && body !== tease;
  const kind = `<em class="kind">${escapeHtml(t(`bubble.kind.${item.kind}`))}</em>`;

  switch (item.shape) {
    case "orb":
      return `<i class="sheen" aria-hidden="true"></i><span class="tease">${escapeHtml(tease)}</span>`;
    case "pill":
      return `<i class="dot" aria-hidden="true"></i><span class="tease">${escapeHtml(tease)}</span>`;
    case "code":
      return `
        ${kind}
        <pre class="tease"><code>${escapeHtml(stripFence(tease))}</code></pre>
        ${showBody ? `<p class="body">${escapeHtml(body)}</p>` : ""}
      `;
    case "sticky":
      return `
        <i class="fold" aria-hidden="true"></i>
        ${showTitle ? `<strong class="title">${escapeHtml(title)}</strong>` : kind}
        <span class="tease">${escapeHtml(tease)}</span>
        ${showBody ? `<p class="body">${escapeHtml(body)}</p>` : ""}
      `;
    case "speech":
      return `
        <i class="tail" aria-hidden="true"></i>
        ${showTitle ? `<strong class="title">${escapeHtml(title)}</strong>` : kind}
        <span class="tease">${escapeHtml(tease)}</span>
        ${showBody ? `<p class="body">${escapeHtml(body)}</p>` : ""}
      `;
    case "card":
    default:
      return `
        <header>${kind}${showTitle ? `<strong class="title">${escapeHtml(title)}</strong>` : ""}</header>
        <span class="tease">${escapeHtml(tease)}</span>
        ${showBody ? `<p class="body">${escapeHtml(body)}</p>` : ""}
      `;
  }
}

/** The star that sits top-centre on every bubble. Outline until the user keeps it; then filled gold. */
export const KEEP_STAR = `
  <button type="button" class="keep" aria-label="收藏到板上" aria-pressed="false">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6L2.5 9.5l6.6-.8z"/></svg>
  </button>
`;

export function applyBubbleEl(el: HTMLElement, item: ThrownBubble) {
  const shape: BubbleShape = item.shape ?? "pill";
  el.className = `bubble shape-${shape} size-${item.size}`;
  el.style.setProperty("--tone", KIND_TONE[item.kind]);
  el.dataset.kind = item.kind;
  el.dataset.size = item.size;
  el.dataset.shape = shape;
  el.dataset.poke = item.on_poke;
  el.setAttribute("aria-label", item.tease);
  el.innerHTML = KEEP_STAR + bubbleMarkup(item);
  el.querySelector(".keep")?.setAttribute("aria-label", t("peek.keep"));
}

function stripFence(text: string) {
  return text
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .replace(/^`([^`]+)`$/, "$1")
    .trim();
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
