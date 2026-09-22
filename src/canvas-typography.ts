export type CanvasFontKind = "body" | "title" | "interface";
export type CanvasTypography = Record<CanvasFontKind, number>;

const storageKeys: Record<CanvasFontKind, string> = {
  body: "spellcast.canvas-reading-text-percent",
  title: "spellcast.canvas-reading-title-percent",
  interface: "spellcast.canvas-reading-interface-percent",
};
const kinds: CanvasFontKind[] = ["body", "title", "interface"];

export function clampCanvasFontPercent(value: number, kind: CanvasFontKind = "body"): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(80, Math.min(kind === "body" ? 300 : 200, Math.round(value / 10) * 10));
}

function readPercent(kind: CanvasFontKind): number {
  try {
    const saved = Number(localStorage.getItem(storageKeys[kind]));
    return saved > 0 ? clampCanvasFontPercent(saved, kind) : 100;
  } catch { return 100; }
}

const current: CanvasTypography = {
  body: readPercent("body"),
  title: readPercent("title"),
  interface: readPercent("interface"),
};

export function canvasTypography(): CanvasTypography { return { ...current }; }

export function setCanvasFontPercent(kind: CanvasFontKind, value: number): void {
  const next = clampCanvasFontPercent(value, kind);
  if (current[kind] === next) return;
  current[kind] = next;
  try { localStorage.setItem(storageKeys[kind], String(next)); } catch { /* Current window still updates. */ }
  document.dispatchEvent(new CustomEvent("spellcast-canvas-typography-change", { detail: canvasTypography() }));
}

export function resetCanvasTypography(): void {
  for (const kind of kinds) setCanvasFontPercent(kind, 100);
}

export function onCanvasTypographyChange(listener: (value: CanvasTypography) => void): () => void {
  const notify = () => listener(canvasTypography());
  document.addEventListener("spellcast-canvas-typography-change", notify);
  return () => document.removeEventListener("spellcast-canvas-typography-change", notify);
}
