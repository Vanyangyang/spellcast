import type { CanvasPlacement } from "./types";

/** Node dimensions are canvas units; the HTML keeps its logical layout while a user scales it. */
export function scaledPresentation(size: { width: number; height: number }, base: Pick<CanvasPlacement, "width" | "content_scale">) {
  const scale = (base.content_scale ?? 1) * size.width / base.width;
  return { scale, width: size.width / scale, height: size.height / scale };
}
