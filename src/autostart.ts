import { invoke, isTauri } from "@tauri-apps/api/core";
import { onLocale, t } from "./i18n";

/** Read the actual system entry; never create a startup entry just by opening settings. */
export function mountAutostart(root: HTMLElement) {
  const toggle = root.querySelector<HTMLInputElement>("#autostart-enabled")!;
  const status = root.querySelector<HTMLElement>("#autostart-status")!;
  const retry = root.querySelector<HTMLButtonElement>("#autostart-retry")!;
  const native = isTauri();
  let confirmed: boolean | null = null;
  let desired = false;
  let busy = false;
  let phase: "loading" | "ready" | "saving" | "error" | "unsupported" = native ? "loading" : "unsupported";
  let retryAction: "load" | "save" = "load";

  function paint() {
    toggle.checked = phase === "saving" ? desired : confirmed === true;
    toggle.disabled = !native || busy || confirmed === null;
    toggle.dataset.autostartState = phase;
    status.classList.toggle("has-warning", phase === "error");
    status.setAttribute("role", phase === "error" ? "alert" : "status");
    status.textContent = t(phase === "unsupported" ? "startup.desktopOnly"
      : phase === "loading" ? "startup.loading"
      : phase === "saving" ? "startup.saving"
      : phase === "error" ? retryAction === "load" ? "startup.loadFailed" : "startup.saveFailed"
      : confirmed ? "startup.enabled" : "startup.disabled");
    retry.hidden = phase !== "error";
    retry.disabled = busy;
    retry.textContent = t("startup.retry");
  }

  async function read() {
    const value = await invoke<boolean>("get_autostart_enabled");
    if (typeof value !== "boolean") throw new Error("Invalid startup state");
    return value;
  }

  async function refresh() {
    if (!native || busy) return;
    busy = true;
    phase = "loading";
    paint();
    try {
      confirmed = await read();
      phase = "ready";
    } catch {
      confirmed = null;
      retryAction = "load";
      phase = "error";
    } finally {
      busy = false;
      paint();
    }
  }

  async function save(enabled: boolean) {
    if (!native || busy) return;
    desired = enabled;
    busy = true;
    phase = "saving";
    paint();
    try {
      const actual = await invoke<boolean>("set_autostart_enabled", { enabled });
      if (actual !== enabled) throw new Error("Startup setting was not applied");
      confirmed = actual;
      phase = "ready";
    } catch {
      // A failed IPC reply may follow a successful OS write. Re-read before displaying a state.
      try { confirmed = await read(); } catch { confirmed = null; }
      retryAction = "save";
      phase = "error";
    } finally {
      busy = false;
      paint();
    }
  }

  toggle.addEventListener("change", () => {
    if (confirmed === null || busy) { paint(); return; }
    void save(toggle.checked);
  });
  retry.addEventListener("click", () => {
    if (retryAction === "save") void save(desired);
    else void refresh();
  });
  window.addEventListener("focus", () => { if (!root.hidden) void refresh(); });
  onLocale(paint);
  paint();
  void refresh();
  return { refresh };
}
