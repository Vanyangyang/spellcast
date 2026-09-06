import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { applyBubbleEl } from "./bubble-view";
import { t } from "./i18n";
import type { ThrownBubble } from "./types";

type WorkArea = { x: number; y: number; w: number; h: number };

type Flight = {
  item: ThrownBubble;
  scale?: number;
  x: number;
  startY: number;
  endY: number;
  work?: WorkArea;
  margin?: number;
  pad?: number;
};

/** Where the window sits and travels. Re-derived whenever the bubble's real size changes. */
type Geometry = { x: number; w: number; h: number; startY: number; endY: number };

declare global {
  interface Window {
    __SPELLCAST_FLIGHT__?: Flight;
  }
}

function parseHash(): Flight | null {
  try {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!raw) return null;
    return JSON.parse(raw) as Flight;
  } catch {
    return null;
  }
}

async function waitFlight(): Promise<Flight | null> {
  // Rust injects the flight before this script runs; the event is only a fallback.
  if (window.__SPELLCAST_FLIGHT__?.item) return window.__SPELLCAST_FLIGHT__;
  const hashed = parseHash();
  if (hashed) return hashed;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 4000);
    void listen<Flight>("spellcast-flight", (event) => {
      window.clearTimeout(timer);
      resolve(event.payload);
    });
  });
}

async function fontsSettled() {
  // Web fonts change the measured size; wait for them, but never hold the bubble hostage.
  const ready = document.fonts?.ready ?? Promise.resolve();
  await Promise.race([ready, new Promise((r) => window.setTimeout(r, 700))]);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/**
 * The window was opened as a generous transparent canvas so the words could wrap at
 * their natural max-width. Now that they are laid out, shrink the window to hug them.
 */
function measure(orb: HTMLElement, flight: Flight, fallback: Geometry | null): Geometry {
  const margin = flight.margin ?? 18;
  const pad = flight.pad ?? 20;
  // Margins carry parts that hang outside the box, like the speech tail.
  const style = getComputedStyle(orb);
  const hang = (parseFloat(style.marginBottom) || 0) + (parseFloat(style.marginTop) || 0);
  const w = Math.ceil(orb.offsetWidth) + margin * 2 + 2;
  const h = Math.ceil(orb.offsetHeight + hang) + margin * 2 + 2;
  const work = flight.work;
  if (!work) {
    return { x: Math.round(flight.x), w, h, startY: flight.startY, endY: flight.endY };
  }
  const x = clamp(Math.round(fallback?.x ?? flight.x), work.x + pad, work.x + work.w - w - pad);
  return {
    x,
    w,
    h,
    startY: Math.round(work.y + work.h - h - pad),
    endY: Math.round(work.y + pad),
  };
}

async function boot() {
  const win = getCurrentWindow();
  const flight = await waitFlight();
  const orb = document.querySelector<HTMLButtonElement>("#orb");
  if (!flight || !orb) {
    // Never leave an invisible always-on-top window sitting on the desktop.
    void win.close();
    return;
  }
  applyBubbleEl(orb, flight.item);
  await fontsSettled();

  let geo = measure(orb, flight, null);
  let displayScale = flight.scale ?? (await win.scaleFactor());
  const positionAt = (y: number) => new PhysicalPosition(Math.round(geo.x * displayScale), Math.round(y * displayScale));
  const applyGeometry = async (y: number) => {
    try {
      await win.setSize(new LogicalSize(geo.w, geo.h));
      await win.setPosition(positionAt(y));
    } catch {
      /* window may already be closing */
    }
  };
  await applyGeometry(geo.startY);
  requestAnimationFrame(() => {
    orb.classList.add("is-in");
  });

  const life = Math.max(8000, flight.item.linger_ms || 16000);
  let elapsed = 0;
  let lastTick = performance.now();
  let gone = false;
  let held = false;
  let lastY = Number.NaN;
  let progress = 0;
  let dragging = false;
  let kept = false;
  let anchored = false;
  let changingKeep = false;
  let openingBoard = false;
  let lastClickAt = 0;
  let resumeAt = 0;

  const releaseInteraction = () => {
    held = false;
    orb.classList.remove("is-held");
  };

  const restartFlight = (y: number) => {
    geo = { ...geo, startY: y };
    progress = 0;
    elapsed = 0;
    lastTick = performance.now();
    lastY = Number.NaN;
  };

  // A late font swap or a wrapped line can still change the size; follow it.
  const watcher = new ResizeObserver(() => {
    if (gone) return;
    const next = measure(orb, flight, geo);
    if (next.w === geo.w && next.h === geo.h) return;
    const y = kept ? geo.startY + (geo.endY - geo.startY) * progress
      : next.startY + (next.endY - next.startY) * progress;
    geo = next;
    if (kept) restartFlight(y);
    lastY = Number.NaN;
    void applyGeometry(Math.round(y));
  });
  watcher.observe(orb);

  const die = (quietly: boolean) => {
    if (gone) return;
    gone = true;
    watcher.disconnect();
    orb.classList.add(quietly ? "is-fade" : "is-pop");
    if (quietly) {
      // Nobody cared. That silence is an answer the agent can read.
      void emit("spellcast-expired", flight.item.id).catch(() => undefined);
    }
    window.setTimeout(() => void win.close(), quietly ? 720 : 320);
  };

  orb.addEventListener("pointerenter", () => {
    if (gone || held) return;
    held = true;
    orb.classList.add("is-held");
  });
  orb.addEventListener("pointerleave", () => {
    if (!held) return;
    held = false;
    orb.classList.remove("is-held");
  });

  const tick = async () => {
    if (gone) return;
    const now = performance.now();
    const delta = Math.max(0, now - Math.max(lastTick, resumeAt));
    lastTick = now;
    if (held || dragging || (kept && anchored) || changingKeep || openingBoard || now < resumeAt) {
      requestAnimationFrame(() => void tick());
      return;
    }
    elapsed += delta;
    const t = Math.min(1, elapsed / life);
    const eased = t * t * (3 - 2 * t);
    progress = eased;
    const y = Math.round(geo.startY + (geo.endY - geo.startY) * eased);
    if (y !== lastY) {
      lastY = y;
      try {
        await win.setPosition(positionAt(y));
      } catch {
        return;
      }
    }
    if (t >= 1 && !kept) {
      die(true);
      return;
    }
    requestAnimationFrame(() => void tick());
  };
  requestAnimationFrame(() => void tick());

  const openBoard = async (event: Event) => {
    event.preventDefault();
    if (gone || changingKeep || openingBoard) return;
    openingBoard = true;
    try {
      const { node } = await invoke<{ node: { id: string } }>("keep_bubble", { bubble: flight.item });
      flight.item = { ...flight.item, node_id: node.id };
      kept = true;
      paintKeep();
      await emit("spellcast-poke", { ...flight.item, on_poke: "focus" });
      die(false);
    } catch {
      // Keep the thought available when the board cannot be reached.
    } finally {
      openingBoard = false;
    }
  };

  // Kept thoughts finish floating upward, then remain at the top of the desktop.
  const star = orb.querySelector<HTMLButtonElement>(".keep");
  const paintKeep = () => {
    star?.classList.toggle("is-kept", kept);
    star?.setAttribute("aria-pressed", String(kept));
    star?.setAttribute("aria-label", t(kept ? "peek.unkeep" : "peek.keep"));
  };
  const keep = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (gone || changingKeep || openingBoard || dragging) return;
    changingKeep = true;
    kept = !kept;
    lastClickAt = 0;
    paintKeep();
    try {
      const result = await invoke<{ node?: { id: string } }>(kept ? "keep_bubble" : "unkeep_bubble", { bubble: flight.item });
      flight.item = { ...flight.item, node_id: kept ? result.node?.id ?? flight.item.node_id : null };
      if (!kept) anchored = false;
      releaseInteraction();
      await emit("spellcast-favorite-changed", { item: flight.item, kept }).catch(() => undefined);
    } catch {
      kept = !kept;
      paintKeep();
    } finally {
      changingKeep = false;
    }
  };
  star?.addEventListener("pointerdown", (event) => event.stopPropagation());
  star?.addEventListener("click", (event) => void keep(event));

  // A single press may start a drag; two stationary clicks open this thought on the board.
  orb.addEventListener("pointerdown", async (event) => {
    if (gone || dragging || changingKeep || openingBoard || event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    orb.classList.add("is-dragging");
    try {
      // Begin the native move while the mouse is still down, without an IPC read first.
      // The command resolves only after the OS move loop ends, i.e. when the mouse is released.
      const after = await invoke<{ x: number; y: number; moved: boolean }>("drag_bubble");
      if (!after.moved) {
        const now = performance.now();
        if (lastClickAt > 0 && now - lastClickAt <= 500) {
          lastClickAt = 0;
          void openBoard(event);
        } else {
          lastClickAt = now;
        }
        return;
      }
      lastClickAt = 0;

      const monitor = await currentMonitor();
      const scale = monitor?.scaleFactor ?? (await win.scaleFactor());
      displayScale = scale;
      const x = after.x / scale;
      const y = after.y / scale;
      const work = monitor
        ? {
            x: monitor.workArea.position.x / scale,
            y: monitor.workArea.position.y / scale,
            w: monitor.workArea.size.width / scale,
            h: monitor.workArea.size.height / scale,
          }
        : null;
      if (work) flight.work = work;
      flight.x = x;
      geo = { ...geo, x, startY: y, endY: work ? work.y + (flight.pad ?? 20) : y };
      restartFlight(y);
      anchored = kept;
      resumeAt = kept ? 0 : performance.now() + 5000;
      releaseInteraction();
      // A frame queued just before the press is delivered after the move loop ends;
      // pin the drop point so that stale frame cannot snap the window back.
      await win.setPosition(new PhysicalPosition(after.x, after.y));
    } catch {
      lastClickAt = 0;
    } finally {
      dragging = false;
      orb.classList.remove("is-dragging");
    }
  });
  orb.addEventListener("click", (event) => {
    if (event.detail === 0) void openBoard(event); // keyboard activation
  });
  orb.addEventListener("dblclick", (event) => void openBoard(event));
  requestAnimationFrame(() => { void emit("spellcast-ready", flight.item.id).catch(() => undefined); });
}

void boot();
