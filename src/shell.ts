import { listScreens, resolveScreen } from "./screens";
import type { ThrownBubble } from "./types";

type Handlers = {
  onPoke: (item: ThrownBubble) => void;
};

export function isDesktopShell(): boolean {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function createShell(_root: HTMLElement, handlers: Handlers) {
  let unlisten: (() => void) | null = null;
  let live = 0;

  const attach = async () => {
    if (!isDesktopShell() || unlisten) return;
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<ThrownBubble>("orbit-poke", (event) => {
      live = Math.max(0, live - 1);
      handlers.onPoke(event.payload);
    });
  };
  void attach();

  return {
    async throwAll(items: ThrownBubble[]) {
      if (!isDesktopShell()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      const screens = await listScreens();
      for (const item of items.slice(0, 3)) {
        const aimed = { ...item, screen: resolveScreen(screens, item.screen || "active").isActive ? item.screen : item.screen };
        window.setTimeout(() => {
          live += 1;
          void invoke("spawn_bubble", { item: aimed }).catch((err) => {
            live = Math.max(0, live - 1);
            console.warn("desktop throw failed", err);
          });
        }, item.delay_ms || 0);
      }
    },
    async clear() {
      live = 0;
      if (!isDesktopShell()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("close_bubbles").catch(() => undefined);
    },
    living() {
      return live;
    },
  };
}
