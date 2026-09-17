import type { CanvasAnchor, CanvasLayout, CanvasObject } from "./types";
import type { ReplyBlock, ReplyImageReference, ReplyTarget } from "./reply-types";
import { currentLocale } from "./i18n";
import { apiBase } from "./api";
import { workspaceIdentity } from "./content-origin";
import { annotationMarker, type ImageAnnotation } from "./canvas-annotation-markers";

const copy = {
  zh: { image: "画面", none: "不附画面", empty: "先把图片与这个组件放进同一个 Idea 组合。", external: "网络图片需先保存为本地资源，才能固定引用。", saved: "已固定画面", changed: "原图已更新 · 这里保留原画面", detached: "原图已离开此组合 · 保留原画面", missing: "原图不可用 · 保留原画面", failed: "画面资源无法读取", refresh: "更新为当前画面", focus: "讨论这一项", focused: "已选中此项", region: "拖动画面可框选局部；选好后点击发送。", clear: "清除框选", regionSelected: "已选中画面局部" },
  en: { image: "Image", none: "No image", empty: "Add an image and this component to the same Idea composition first.", external: "Save web images as local resources before pinning a reference.", saved: "Pinned image", changed: "Original updated · showing pinned image", detached: "Original left this Idea · showing pinned image", missing: "Original unavailable · showing pinned image", failed: "Image resource unavailable", refresh: "Use current image", focus: "Discuss this item", focused: "Item selected", region: "Drag to select a region, then click Send when ready.", clear: "Clear region", regionSelected: "Image region selected" },
  ja: { image: "画像", none: "画像なし", empty: "画像とこのコンポーネントを同じ Idea に追加してください。", external: "Web 画像はローカルに保存してから参照してください。", saved: "固定された画像", changed: "元画像は更新済み · 固定画像を表示", detached: "元画像はこの Idea の外 · 固定画像を表示", missing: "元画像は利用不可 · 固定画像を表示", failed: "画像を読み込めません", refresh: "現在の画像に更新", focus: "この項目について話す", focused: "選択中の項目", region: "ドラッグで範囲を選び、最後に送信してください。", clear: "範囲を解除", regionSelected: "画像の範囲を選択中" },
};
export const imageText = (key: keyof typeof copy.en) => { const locale = currentLocale(); return copy[locale === "zh-CN" ? "zh" : locale][key]; };
export function targetLabel(block: ReplyBlock, target?: ReplyTarget): string | undefined {
  if (block.type === "comparison" && target?.kind === "option") return block.options.find(item => item.id === target.id)?.title;
  if (block.type === "sequence" && target?.kind === "step") return block.steps.find(item => item.id === target.id)?.title;
  if (block.type === "graph" && target?.kind === "graph_node") return block.nodes.find(item => item.id === target.id)?.title;
  if (block.type === "graph" && target?.kind === "graph_edge") return block.edges.find(item => item.id === target.id)?.label;
  return undefined;
}
export function immutableImage(src: string) { return /^data:image\/(png|jpeg|webp);base64,/.test(src) || src.startsWith("/artifacts/"); }
export function sameIdea(layout: CanvasLayout | undefined, first: string, second: string): boolean {
  const groups = layout?.compositions ?? [];
  const reaches = (id: string, target: string, seen = new Set<string>()): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return groups.find(group => group.id === id)?.members.some(member => reaches(member, target, seen)) ?? false;
  };
  return groups.some(group => reaches(group.id, first) && reaches(group.id, second));
}
export function imageChoices(layout: CanvasLayout | undefined, ownerId: string): CanvasObject[] {
  const owner = layout?.objects.find(object => object.id === ownerId);
  return (layout?.objects ?? []).filter(object => object.content.type === "image" && immutableImage(object.content.src)
    && (!owner?.source_id || !object.source_id || owner.source_id === object.source_id)
    && (!owner?.origin?.cwd || !object.origin?.cwd || workspaceIdentity(owner.origin.cwd) === workspaceIdentity(object.origin.cwd))
    && sameIdea(layout, ownerId, object.id));
}
export function imageSnapshot(object: CanvasObject): ReplyImageReference {
  if (object.content.type !== "image") throw new Error("Image required");
  return { object_id: object.id, content_revision: object.content_revision, title: object.content.title, alt: object.content.alt, src: object.content.src };
}
export function referenceState(layout: CanvasLayout | undefined, ownerId: string, image: ReplyImageReference) {
  if (!layout) return "saved";
  const source = layout.objects.find(object => object.id === image.object_id);
  if (!source || source.content.type !== "image") return "missing";
  if (!sameIdea(layout, ownerId, image.object_id)) return "detached";
  if (source.content_revision !== image.content_revision || source.content.src !== image.src) return "changed";
  return "saved";
}
export function targetImage(block: ReplyBlock, target?: ReplyTarget): ReplyImageReference | undefined {
  if (block.type === "comparison" && target?.kind === "option") return block.options.find(item => item.id === target.id)?.image ?? undefined;
  if (block.type === "sequence" && target?.kind === "step") return block.steps.find(item => item.id === target.id)?.image ?? undefined;
  return undefined;
}
export function targetExists(block: ReplyBlock, target: ReplyTarget): boolean {
  if (block.type === "comparison" && target.kind === "option") return block.options.some(item => item.id === target.id);
  if (block.type === "sequence" && target.kind === "step") return block.steps.some(item => item.id === target.id);
  if (block.type === "graph" && target.kind === "graph_node") return block.nodes.some(item => item.id === target.id);
  if (block.type === "graph" && target.kind === "graph_edge") return block.edges.some(item => item.id === target.id);
  return false;
}

/** The image keeps its aspect ratio, so normalized coordinates describe the actual pixels. */
export function referencePreview(image: ReplyImageReference, state: ReturnType<typeof referenceState>, onRegion?: (region?: CanvasAnchor["region"]) => void, selectedRegion?: CanvasAnchor["region"], annotations: ImageAnnotation[] = [], openAnnotation?: (id: string) => void) {
  const figure = document.createElement("figure"); figure.className = "rb-image-reference";
  const wrap = document.createElement("div"); wrap.className = "rb-image-pixels";
  const img = document.createElement("img"); img.alt = image.alt || image.title; img.draggable = false;
  const box = document.createElement("div"); box.className = "rb-image-region"; box.hidden = true;
  const caption = document.createElement("figcaption"); caption.textContent = imageText(state);
  const paint = (region?: CanvasAnchor["region"]) => {
    box.hidden = !region;
    if (region) Object.assign(box.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` });
  };
  img.addEventListener("error", () => { caption.textContent = imageText("failed"); figure.dataset.state = "failed"; });
  if (immutableImage(image.src)) {
    if (image.src.startsWith("/artifacts/")) void apiBase().then(base => { img.src = base + image.src; }); else img.src = image.src;
  } else caption.textContent = imageText("failed");
  wrap.append(img, box); figure.append(wrap, caption); figure.dataset.state = state;
  annotations.forEach((note, index) => { const marker = annotationMarker(note, index, openAnnotation), region = note.region; Object.assign(marker.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }); wrap.append(marker); });
  paint(selectedRegion);
  if (onRegion) {
    wrap.title = imageText("region"); wrap.style.touchAction = "none";
    let start: { x: number; y: number; pointer: number } | null = null;
    let region: CanvasAnchor["region"];
    const point = (event: PointerEvent) => { const rect = img.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
    wrap.addEventListener("pointerdown", event => { if (event.button !== 0 || !img.naturalWidth) return; event.stopPropagation(); event.preventDefault(); start = { ...point(event), pointer: event.pointerId }; region = undefined; wrap.setPointerCapture(event.pointerId); });
    wrap.addEventListener("pointermove", event => { if (!start || event.pointerId !== start.pointer) return; const end = point(event); region = { resource: image.src, unit: "normalized", x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }; paint(region); });
    wrap.addEventListener("pointerup", event => { if (!start || event.pointerId !== start.pointer) return; start = null; if (region && (region.width < .005 || region.height < .005)) region = undefined; paint(region); onRegion(region); });
    wrap.addEventListener("pointercancel", () => { start = null; paint(selectedRegion); });
    const clear = document.createElement("button"); clear.type = "button"; clear.textContent = imageText("clear"); clear.className = "rb-quiet";
    clear.hidden = !selectedRegion;
    const updateClear = () => { clear.hidden = box.hidden; };
    wrap.addEventListener("pointerup", updateClear); wrap.addEventListener("pointercancel", updateClear);
    clear.addEventListener("click", () => { paint(); clear.hidden = true; onRegion(); }); figure.append(clear);
  }
  return figure;
}
