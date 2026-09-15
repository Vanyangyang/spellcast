export type SavedCanvasView = { scale: number; x: number; y: number };
export type WorldBox = { x: number; y: number; width: number; height: number };

export function savedViewIsPlausible(saved: SavedCanvasView) {
  return [saved.scale, saved.x, saved.y].every(Number.isFinite)
    && saved.scale >= 0.01
    && saved.scale <= 1.5
    && Math.abs(saved.x) <= 1e6
    && Math.abs(saved.y) <= 1e6;
}

export function viewportFromSaved(saved: SavedCanvasView, usableWidth: number, usableHeight: number): WorldBox {
  const width = usableWidth / saved.scale;
  const height = usableHeight / saved.scale;
  return { x: saved.x - width / 2, y: saved.y - height / 2, width, height };
}

export function boxesOverlap(a: WorldBox, b: WorldBox) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function unionBox(boxes: WorldBox[]): WorldBox | null {
  if (!boxes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const box of boxes) {
    x1 = Math.min(x1, box.x);
    y1 = Math.min(y1, box.y);
    x2 = Math.max(x2, box.x + box.width);
    y2 = Math.max(y2, box.y + box.height);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

export function fitScaleFor(content: WorldBox, usableWidth: number, usableHeight: number, pad = 48) {
  return Math.max(0.01, Math.min(1, (usableWidth - pad * 2) / content.width, (usableHeight - pad * 2) / content.height));
}

export function viewportIsUsable(usableWidth: number, usableHeight: number) {
  return usableWidth >= 32 && usableHeight >= 32;
}

/** Recover when no real frame intersects the viewport, or zoom is far below a fit of the union. */
export function viewShouldRecover(saved: SavedCanvasView, frames: WorldBox[], usableWidth: number, usableHeight: number) {
  if (!frames.length) return false;
  if (!viewportIsUsable(usableWidth, usableHeight)) return true;
  const view = viewportFromSaved(saved, usableWidth, usableHeight);
  if (!frames.some((frame) => boxesOverlap(view, frame))) return true;
  const content = unionBox(frames);
  if (!content) return false;
  return saved.scale < fitScaleFor(content, usableWidth, usableHeight) * 0.4;
}
