import "./styles.css";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyBubbleEl } from "./bubble-view";
import type { ThrownBubble } from "./types";

type Flight = {
  item: ThrownBubble;
  x: number;
  startY: number;
  endY: number;
};

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
  const hashed = parseHash();
  if (hashed) return hashed;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 4000);
    void listen<Flight>("orbit-flight", (event) => {
      window.clearTimeout(timer);
      resolve(event.payload);
    });
  });
}

async function boot() {
  const flight = await waitFlight();
  const orb = document.querySelector<HTMLButtonElement>("#orb");
  if (!flight || !orb) return;
  applyBubbleEl(orb, flight.item);
  orb.classList.add("is-in");

  const win = getCurrentWindow();
  const life = Math.max(8000, flight.item.linger_ms || 16000);
  const started = performance.now();
  let gone = false;
  let held = false;
  let heldAt = 0;
  let heldFor = 0;

  const die = (quietly: boolean) => {
    if (gone) return;
    gone = true;
    orb.classList.add(quietly ? "is-fade" : "is-pop");
    window.setTimeout(() => void win.close(), quietly ? 720 : 320);
  };

  orb.addEventListener("pointerenter", () => {
    if (gone || held) return;
    held = true;
    heldAt = performance.now();
  });
  orb.addEventListener("pointerleave", () => {
    if (!held) return;
    heldFor += performance.now() - heldAt;
    held = false;
  });

  const tick = async () => {
    if (gone) return;
    if (held) {
      requestAnimationFrame(() => void tick());
      return;
    }
    const t = Math.min(1, (performance.now() - started - heldFor) / life);
    const eased = t * t * (3 - 2 * t);
    const y = flight.startY + (flight.endY - flight.startY) * eased;
    try {
      await win.setPosition(new LogicalPosition(flight.x, y));
    } catch {
      return;
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
      await emit("orbit-poke", flight.item);
    } catch {
      /* main may already be gone */
    }
  };
  orb.addEventListener("pointerdown", (event) => void poke(event));
  orb.addEventListener("click", (event) => void poke(event));
}

void boot();
