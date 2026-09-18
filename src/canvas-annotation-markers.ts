import type { CanvasAnnotation, CanvasLayout, CanvasAnchor } from "./types";
import type { ReplyTarget } from "./reply-types";
import { currentLocale } from "./i18n";

export const annotationLabel = (count = 0) => `${currentLocale() === "zh-CN" ? "注释" : "Annotations"}${count ? ` ${count}` : ""}`;
export const annotationSelected = () => currentLocale() === "zh-CN" ? "已选中注释" : "Annotation selected";
export type ImageAnnotation = { id: string; text: string; region: NonNullable<CanvasAnchor["region"]> };
export function imageAnnotations(layout: CanvasLayout | undefined, objectId: string, src: string, blockId?: string, target?: ReplyTarget): ImageAnnotation[] {
  return (layout?.annotations || []).filter(note => !note.removed && note.anchor.object_id === objectId && note.anchor.block_id === blockId
    && JSON.stringify(note.anchor.target || null) === JSON.stringify(target || null) && note.anchor.region?.resource === src)
    .map(note => ({ id: note.id, text: note.text, region: note.anchor.region! }));
}
export function annotationMarker(note: ImageAnnotation, index: number, open?: (id: string) => void) {
  const box = document.createElement("button"); box.type = "button"; box.className = "canvas-annotation-region"; box.dataset.annotationId = note.id;
  box.title = note.text; box.setAttribute("aria-label", `${annotationLabel(index + 1)}: ${note.text.slice(0, 120)}`);
  const badge = document.createElement("span"); badge.textContent = String(index + 1); box.append(badge);
  for (const event of ["pointerdown", "mousedown", "dblclick"]) box.addEventListener(event, e => e.stopPropagation());
  box.onclick = event => { event.stopPropagation(); open?.(note.id); };
  return box;
}
