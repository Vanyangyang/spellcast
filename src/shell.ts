import type { PresentResult, ThrownBubble } from "./types";

type Handlers = {
  onPoke: (item: ThrownBubble) => void;
  onThrown: (item: ThrownBubble) => void;
  onPresent: (result: PresentResult) => void;
  onBoard: () => void;
  onFocus: () => void;
  onAgent: (client: string) => void;
  onFavorite: (item: ThrownBubble, kept: boolean) => void;
};

type FavoriteChanged = { item: ThrownBubble; kept: boolean };

export function isDesktopShell(): boolean {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** Bring the Spellcast window forward so the peek / reply the poke opened is actually seen. */
async function surfaceMain() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (await win.isMinimized()) await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch {
    /* focus is best effort */
  }
}

/**
 * The desktop side. Rust owns bubble windows and emits their local interactions here.
 */
export function createShell(handlers: Handlers) {
  const attach = async () => {
    if (!isDesktopShell()) return;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<ThrownBubble>("spellcast-poke", (event) => {
      if (event.payload.on_poke !== "pin") void surfaceMain();
      handlers.onPoke(event.payload);
    });
    await listen<ThrownBubble>("spellcast-thrown", (event) => handlers.onThrown(event.payload));
    await listen<PresentResult>("spellcast-present", (event) => handlers.onPresent(event.payload));
    await listen("spellcast-board", () => handlers.onBoard());
    await listen("spellcast-focus", () => handlers.onFocus());
    await listen<string>("spellcast-agent", (event) => handlers.onAgent(event.payload));
    await listen<FavoriteChanged>("spellcast-favorite-changed", (event) =>
      handlers.onFavorite(event.payload.item, event.payload.kept),
    );
  };
  void attach();

  return {
    async clear() {
      if (!isDesktopShell()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("close_bubbles").catch(() => undefined);
    },
  };
}
