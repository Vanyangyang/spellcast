import type { ScreenAim } from "./types";

export type DesktopScreen = {
  index: number;
  name: string;
  scale: number;
  workX: number;
  workY: number;
  workW: number;
  workH: number;
  isPrimary: boolean;
  isActive: boolean;
};

function inTauri(): boolean {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function logicalWork(monitor: {
  name: string | null;
  scaleFactor: number;
  position: { x: number; y: number; toLogical?: (s: number) => { x: number; y: number } };
  size: { width: number; height: number; toLogical?: (s: number) => { width: number; height: number } };
  workArea?: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
}): { x: number; y: number; w: number; h: number; scale: number } {
  const scale = monitor.scaleFactor || 1;
  const area = monitor.workArea;
  if (area) {
    return {
      x: area.position.x / scale,
      y: area.position.y / scale,
      w: area.size.width / scale,
      h: area.size.height / scale,
      scale,
    };
  }
  const mac = /Mac/i.test(navigator.userAgent);
  const top = mac ? 28 : 0;
  const bottom = mac ? 68 : 48;
  return {
    x: monitor.position.x / scale,
    y: monitor.position.y / scale + top,
    w: monitor.size.width / scale,
    h: Math.max(200, monitor.size.height / scale - top - bottom),
    scale,
  };
}

/** Enumerate physical screens. Work area already excludes the Windows taskbar and the Mac menu/dock. */
export async function listScreens(): Promise<DesktopScreen[]> {
  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const native = await invoke<DesktopScreen[]>("list_desktop_screens");
      if (native?.length) return native;
    } catch {
      /* fall through to JS monitors */
    }
    const { availableMonitors, currentMonitor, primaryMonitor } = await import("@tauri-apps/api/window");
    const [all, current, primary] = await Promise.all([
      availableMonitors(),
      currentMonitor(),
      primaryMonitor(),
    ]);
    if (!all?.length) return [fallbackScreen()];
    return all.map((monitor, index) => {
      const work = logicalWork(monitor);
      const name = monitor.name || `display-${index}`;
      return {
        index,
        name,
        scale: work.scale,
        workX: work.x,
        workY: work.y,
        workW: work.w,
        workH: work.h,
        isPrimary: primary?.name === monitor.name || (index === 0 && !primary),
        isActive: current?.name === monitor.name,
      };
    });
  }
  return [fallbackScreen()];
}

type ScreenOrigin = Screen & { availLeft?: number; availTop?: number };

function screenOrigin(): { left: number; top: number } {
  const s = screen as ScreenOrigin;
  return { left: s.availLeft ?? 0, top: s.availTop ?? 0 };
}

function fallbackScreen(): DesktopScreen {
  const { left: availLeft, top: availTop } = screenOrigin();
  return {
    index: 0,
    name: "this",
    scale: window.devicePixelRatio || 1,
    workX: availLeft,
    workY: availTop,
    workW: screen.availWidth,
    workH: screen.availHeight,
    isPrimary: true,
    isActive: true,
  };
}

/** Pick exactly one screen. A bubble never spans a bezel and is never copied to every display. */
export function resolveScreen(screens: DesktopScreen[], aim: ScreenAim = "active"): DesktopScreen {
  if (!screens.length) return fallbackScreen();
  const active = screens.find((s) => s.isActive) ?? screens[0];
  const primary = screens.find((s) => s.isPrimary) ?? screens[0];
  if (aim === "primary") return primary;
  if (aim === "side") {
    const side = screens.find((s) => s.index !== active.index) ?? screens.find((s) => !s.isActive);
    return side ?? active;
  }
  return active;
}

/**
 * Viewport rectangle that stays on the OS screen containing the window center.
 * If the browser window is stretched across two monitors, bubbles stay on one side.
 */
export function viewportOnCurrentScreen(): { left: number; top: number; width: number; height: number } {
  const { left: availLeft, top: availTop } = screenOrigin();
  const availW = screen.availWidth;
  const availH = screen.availHeight;
  const chromeX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const chromeY = Math.max(0, window.outerHeight - window.innerHeight - chromeX);
  const viewX = window.screenX + chromeX;
  const viewY = window.screenY + chromeY;
  const left = Math.max(0, availLeft - viewX);
  const top = Math.max(0, availTop - viewY);
  const right = Math.min(window.innerWidth, availLeft + availW - viewX);
  const bottom = Math.min(window.innerHeight, availTop + availH - viewY);
  return {
    left,
    top,
    width: Math.max(96, right - left),
    height: Math.max(96, bottom - top),
  };
}

export function bubblePx(size: ThrownSize): number {
  if (size === "whisper") return 86;
  if (size === "flare") return 168;
  return 128;
}

type ThrownSize = "whisper" | "note" | "flare";
