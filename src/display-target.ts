/** Settings panel for the physical display that desktop bubbles and completion notices use. */
import { inTauri } from "./api";
import { onLocale, t } from "./i18n";

type Screen = {
  id: string;
  number: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
  isActive: boolean;
};
type Mode = "active" | "fixed";
type Target =
  | { mode: "active" }
  | { mode: "fixed"; id: string; number: number; label: string; width: number; height: number };
type Report = {
  target: Target;
  screens: Screen[];
  windowScreen: string | null;
  noticeScreen: string | null;
  fixedConnected: boolean | null;
};
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    /** Dev-server fixture so the panel can be checked in a browser. */
    __SPELLCAST_DISPLAY_FIXTURE__?: Invoke;
  }
}

function transport(): Invoke | null {
  if (import.meta.env.DEV && window.__SPELLCAST_DISPLAY_FIXTURE__) return window.__SPELLCAST_DISPLAY_FIXTURE__;
  if (!inTauri()) return null;
  return async (command, args) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(command, args);
  };
}

const screenName = (number: number, label: string) =>
  `${t("display.screen", { n: number })} · ${label.trim() || t("display.generic")}`;
const screenDetail = (screen: Screen) =>
  `${screenName(screen.number, screen.label)} · ${screen.width}×${screen.height}${screen.isPrimary ? ` · ${t("display.primary")}` : ""}`;

export function mountDisplayTarget(panel: HTMLElement) {
  const call = transport();
  const q = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const modes = [...panel.querySelectorAll<HTMLInputElement>('input[name="display-mode"]')];
  const fieldset = q<HTMLFieldSetElement>(".display-modes");
  const select = q<HTMLSelectElement>("#display-fixed-screen");
  const missing = q<HTMLElement>("#display-missing");
  const map = q<HTMLElement>("#display-map");
  const identify = q<HTMLButtonElement>("#display-identify");
  const identified = q<HTMLElement>("#display-identified");
  const identifiedText = q<HTMLElement>("#display-identified-text");
  const useCurrent = q<HTMLButtonElement>("#display-use-current");
  const status = q<HTMLElement>("#display-status");
  const error = q<HTMLElement>("#display-error");
  const help = q<HTMLElement>("#display-help");
  const multi = q<HTMLElement>("#display-multi");
  const single = q<HTMLElement>("#display-single");
  const singleName = q<HTMLElement>("#display-single-name");
  const singleMissing = q<HTMLElement>("#display-single-missing");
  const singleMissingText = q<HTMLElement>("#display-single-missing-text");
  const followActive = q<HTMLButtonElement>("#display-follow-active");
  let report: Report | null = null;
  let busy = false;
  let identifiedId: string | null = null;
  let statusTimer = 0;

  q<HTMLElement>("#display-unsupported").hidden = Boolean(call);
  fieldset.disabled = !call;
  identify.disabled = !call;
  select.disabled = true;

  const showError = (text = "") => {
    error.textContent = text;
    error.hidden = !text;
  };

  function paint() {
    if (!report) return;
    const { target, screens } = report;
    for (const input of modes) input.checked = input.value === target.mode;
    const ordered = [...screens].sort((a, b) => a.number - b.number);
    const saved = target.mode === "fixed" ? target : null;
    const savedMissing = Boolean(saved && report.fixedConnected === false);
    select.replaceChildren();
    if (saved && savedMissing) {
      const option = new Option(t("display.missingOption", { name: screenName(saved.number, saved.label) }), saved.id);
      option.disabled = true;
      select.append(option);
    }
    for (const screen of ordered) select.append(new Option(screenDetail(screen), screen.id));
    select.value = saved?.id ?? report.windowScreen ?? report.noticeScreen ?? ordered[0]?.id ?? "";
    select.disabled = busy || target.mode !== "fixed";
    missing.hidden = !savedMissing;
    missing.textContent = saved && savedMissing ? t("display.missing", { name: screenName(saved.number, saved.label) }) : "";
    paintMap(ordered);
    paintIdentified();
    paintSingle(ordered, saved && savedMissing ? saved : null);
  }

  /** With one display there is nothing to choose: say where notices go, and offer to drop a fixed
   *  choice only when it points at a display that is not connected. The multi-display controls keep
   *  their state underneath and return as soon as a second display is reported. */
  function paintSingle(screens: Screen[], lost: Extract<Target, { mode: "fixed" }> | null) {
    const alone = screens.length === 1;
    single.hidden = !alone;
    multi.hidden = alone;
    help.hidden = alone;
    if (!alone) return;
    singleName.textContent = screenDetail(screens[0]);
    singleMissing.hidden = !lost;
    singleMissingText.textContent = lost ? t("display.singleMissing", { name: screenName(lost.number, lost.label) }) : "";
    followActive.disabled = busy;
  }

  function paintMap(screens: Screen[]) {
    map.replaceChildren();
    map.hidden = screens.length === 0;
    if (!screens.length || !report) return;
    const left = Math.min(...screens.map(s => s.x));
    const top = Math.min(...screens.map(s => s.y));
    const width = Math.max(...screens.map(s => s.x + s.width)) - left;
    const height = Math.max(...screens.map(s => s.y + s.height)) - top;
    const frame = document.createElement("div");
    frame.className = "display-map-frame";
    frame.style.aspectRatio = `${width} / ${height}`;
    frame.style.width = `min(100%, ${Math.round((150 * width) / height)}px)`;
    for (const screen of screens) {
      const tile = document.createElement("div");
      tile.className = "display-tile";
      tile.dataset.screen = screen.id;
      tile.classList.toggle("is-target", screen.id === report.noticeScreen);
      tile.classList.toggle("is-window", screen.id === report.windowScreen);
      tile.classList.toggle("is-identified", screen.id === identifiedId);
      Object.assign(tile.style, {
        left: `${((screen.x - left) / width) * 100}%`,
        top: `${((screen.y - top) / height) * 100}%`,
        width: `${(screen.width / width) * 100}%`,
        height: `${(screen.height / height) * 100}%`,
      });
      const number = document.createElement("strong");
      number.textContent = String(screen.number);
      const label = document.createElement("span");
      label.className = "display-tile-label";
      label.textContent = screen.label.trim() || t("display.generic");
      // Notice target and window are shown by the tile's styling and the legend below the map;
      // spelled out inside a small tile they were cut off.
      const tags = document.createElement("span");
      tags.className = "display-tile-tags";
      tags.textContent = screen.isPrimary ? t("display.primary") : "";
      tile.append(number, label, tags);
      frame.append(tile);
    }
    map.append(frame);
  }

  function paintIdentified() {
    if (!report || identifiedId === null) {
      identified.hidden = true;
      return;
    }
    const screen = report.screens.find(s => s.id === identifiedId);
    identified.hidden = false;
    if (!screen) {
      identifiedText.textContent = t("display.identifyFailed");
      useCurrent.hidden = true;
      return;
    }
    const already = report.target.mode === "fixed" && report.target.id === screen.id;
    // The "already fixed" note gets its own line rather than wrapping onto the long sentence.
    identifiedText.textContent = `${t("display.identified", { name: screenDetail(screen) })}${already ? `\n${t("display.identifiedFixed")}` : ""}`;
    useCurrent.hidden = already;
    useCurrent.disabled = busy;
  }

  async function refresh() {
    if (!call || busy) return;
    try {
      report = await call<Report>("display_target_report");
      showError();
      paint();
    } catch (reason) {
      showError(t("display.loadFailed", { error: String(reason) }));
    }
  }

  async function save(next: { mode: Mode; id?: string }) {
    if (!call || busy) return;
    busy = true;
    fieldset.disabled = true;
    select.disabled = true;
    useCurrent.disabled = true;
    try {
      report = await call<Report>("set_display_target", { target: next });
      showError();
      window.clearTimeout(statusTimer);
      status.textContent = t("display.saved");
      statusTimer = window.setTimeout(() => { status.textContent = ""; }, 2400);
    } catch (reason) {
      showError(t("display.saveFailed", { error: String(reason) }));
    } finally {
      busy = false;
      fieldset.disabled = false;
      paint();
    }
  }

  for (const input of modes) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const mode = input.value as Mode;
      if (mode !== "fixed") return void save({ mode });
      const id = select.value || report?.windowScreen || report?.noticeScreen;
      if (id) void save({ mode, id });
    });
  }
  select.addEventListener("change", () => {
    const screen = report?.screens.find(s => s.id === select.value);
    if (screen) void save({ mode: "fixed", id: screen.id });
  });
  identify.addEventListener("click", async () => {
    await refresh();
    identifiedId = report?.windowScreen ?? "";
    paint();
    const tile = map.querySelector<HTMLElement>(".display-tile.is-identified");
    tile?.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 520, easing: "ease-out" });
  });
  useCurrent.addEventListener("click", () => {
    if (identifiedId) void save({ mode: "fixed", id: identifiedId });
  });
  // Clears a fixed choice whose display is gone, so notices follow the one that is here.
  followActive.addEventListener("click", () => void save({ mode: "active" }));
  onLocale(paint);

  // Displays can be plugged in or out while the panel is open.
  window.setInterval(() => {
    if (!panel.hidden && panel.closest("dialog")?.open) void refresh();
  }, 3000);

  return {
    refresh,
    /** Forget a previous identification when the panel is reopened. */
    reset() {
      identifiedId = null;
      paintIdentified();
    },
  };
}
