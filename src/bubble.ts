import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { applyBubbleEl } from "./bubble-view";
import { t } from "./i18n";
import type { ThrownBubble } from "./types";

type WorkArea = { x: number; y: number; w: number; h: number };

type Flight = {
  item: ThrownBubble;
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
  const applyGeometry = async (y: number) => {
    try {
      await win.setSize(new LogicalSize(geo.w, geo.h));
      await win.setPosition(new LogicalPosition(geo.x, y));
    } catch {
      /* window may already be closing */
    }
  };
  await applyGeometry(geo.startY);
  requestAnimationFrame(() => {
    orb.classList.add("is-in");
    requestAnimationFrame(() => { void emit("spellcast-ready", flight.item.id).catch(() => undefined); });
  });

  const life = Math.max(8000, flight.item.linger_ms || 16000);
  let started = performance.now();
  let gone = false;
  let held = false;
  let heldAt = 0;
  let heldFor = 0;
  let lastY = Number.NaN;
  let progress = 0;
  let dragging = false;

  // A late font swap or a wrapped line can still change the size; follow it.
  const watcher = new ResizeObserver(() => {
    if (gone) return;
    const next = measure(orb, flight, geo);
    if (next.w === geo.w && next.h === geo.h) return;
    geo = next;
    lastY = Number.NaN;
    void applyGeometry(Math.round(geo.startY + (geo.endY - geo.startY) * progress));
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
    heldAt = performance.now();
    orb.classList.add("is-held");
  });
  orb.addEventListener("pointerleave", () => {
    if (!held) return;
    heldFor += performance.now() - heldAt;
    held = false;
    orb.classList.remove("is-held");
  });

  const tick = async () => {
    if (gone) return;
    if (held || dragging) {
      requestAnimationFrame(() => void tick());
      return;
    }
    const t = Math.min(1, (performance.now() - started - heldFor) / life);
    const eased = t * t * (3 - 2 * t);
    progress = eased;
    const y = Math.round(geo.startY + (geo.endY - geo.startY) * eased);
    if (y !== lastY) {
      lastY = y;
      try {
        await win.setPosition(new LogicalPosition(geo.x, y));
      } catch {
        return;
      }
    }
    if (t >= 1) {
      die(true);
      return;
    }
    requestAnimationFrame(() => void tick());
  };
  requestAnimationFrame(() => void tick());

  const poke = async (event: Event) => {
    event.preventDefault();
    if (gone) return;
    die(false);
    try {
      await emit("spellcast-poke", flight.item);
    } catch {
      /* main may already be gone */
    }
  };

  // The star keeps the bubble's words on the board without popping it. It does not count
  // as a poke, and the bubble lingers a beat longer so the fill can be seen.
  const star = orb.querySelector<HTMLButtonElement>(".keep");
  let kept = false;
  let changingKeep = false;
  const keep = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (gone || changingKeep) return;
    changingKeep = true;
    kept = !kept;
    star?.classList.toggle("is-kept", kept);
    star?.setAttribute("aria-pressed", String(kept));
    star?.setAttribute("aria-label", t(kept ? "peek.unkeep" : "peek.keep"));
    heldFor += 2600;
    try {
      const result = await invoke<{ node?: { id: string } }>(kept ? "keep_bubble" : "unkeep_bubble", { bubble: flight.item });
      const item = kept && result.node ? { ...flight.item, node_id: result.node.id } : flight.item;
      await emit("spellcast-favorite-changed", { item, kept });
    } catch {
      kept = !kept;
      star?.classList.toggle("is-kept", kept);
      star?.setAttribute("aria-pressed", String(kept));
    } finally {
      changingKeep = false;
    }
  };
  star?.addEventListener("pointerdown", (event) => event.stopPropagation());
  star?.addEventListener("click", (event) => void keep(event));

  // Behave like a normal draggable window: press-drag moves it, press-release pops it.
  orb.addEventListener("pointerdown", async (event) => {
    if (gone || dragging || event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    orb.classList.add("is-dragging");
    try {
      const before = await win.outerPosition();
      await win.startDragging();
      const after = await win.outerPosition();
      if (Math.hypot(after.x - before.x, after.y - before.y) < 3) {
        void poke(event);
        return;
      }

      const monitor = await currentMonitor();
      const scale = monitor?.scaleFactor ?? (await win.scaleFactor());
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
      progress = 0;
      started = performance.now();
      heldFor = 0;
      if (held) heldAt = started;
      lastY = Number.NaN;
    } catch {
      void poke(event);
    } finally {
      dragging = false;
      orb.classList.remove("is-dragging");
    }
  });
  orb.addEventListener("click", (event) => {
    if (event.detail === 0) void poke(event); // keyboard activation
  });
}

void boot();
