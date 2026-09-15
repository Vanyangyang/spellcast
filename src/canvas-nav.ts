/** Keep-later target vs one in-flight locate that can be cancelled across awaits. */
export type CanvasNavIntent = { gen: number; nodeId: string | null };
export type LocateIntent = { kind: "auto" } | { kind: "object"; id: string } | { kind: "none" };

/** First-frame focus: explicit object never falls back to the last shown item. */
export function initialFocusKey(
  intent: LocateIntent,
  frameIds: Iterable<string>,
  lastShownId: string | undefined,
): string | null {
  const frames = frameIds instanceof Set ? frameIds : new Set(frameIds);
  if (intent.kind === "object") return frames.has(intent.id) ? intent.id : null;
  if (intent.kind === "none") return null;
  return lastShownId ?? null;
}

export function createCanvasNav() {
  let pending: { nodeId: string } | null = null;
  let active: CanvasNavIntent | null = null;
  let gen = 0;
  return {
    remember(nodeId: string | null | undefined) {
      if (nodeId) pending = { nodeId };
    },
    forget(nodeId?: string | null) {
      if (!nodeId || pending?.nodeId === nodeId) pending = null;
    },
    take() {
      const next = pending;
      pending = null;
      return next;
    },
    peek() {
      return pending;
    },
    begin(nodeId: string | null): CanvasNavIntent {
      gen += 1;
      pending = null;
      active = { gen, nodeId };
      return active;
    },
    isCurrent(intent: CanvasNavIntent) {
      return Boolean(active && active.gen === intent.gen);
    },
    /** Human object pick / explicit tool navigation: drop in-flight and keep-later. */
    discardIntent() {
      active = null;
      pending = null;
    },
    /** Leave canvas/desktop: drop in-flight only so a later Open canvas can still consume keep-later. */
    invalidateActive() {
      active = null;
    },
  };
}
