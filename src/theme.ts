import { invoke, isTauri } from "@tauri-apps/api/core";
import { onLocale, t } from "./i18n";

export type ThemePreference = "dark" | "light" | "system";

const STORAGE_KEY = "spellcast.theme";

const validPreference = (value: unknown): value is ThemePreference => value === "dark" || value === "light" || value === "system";

function savedPreference(): ThemePreference | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (validPreference(value)) return value;
  } catch {
    // Native preferences can restore the choice even when WebView storage is unavailable.
  }
  return null;
}

function cachePreference(value: ThemePreference): boolean {
  try { localStorage.setItem(STORAGE_KEY, value); return true; }
  catch { return false; }
}

export function mountTheme() {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const selects = [...document.querySelectorAll<HTMLSelectElement>("[data-theme-select]")];
  const native = isTauri();
  const legacy = savedPreference();
  let preference: ThemePreference = legacy ?? "light";
  let revision = 0;
  let writes = Promise.resolve();
  let phase: "loading" | "ready" | "saving" | "saved" | "error" = "ready";
  let retryAction: "load" | "save" | null = null;
  const status = document.querySelector<HTMLElement>("#theme-status");
  const retry = document.querySelector<HTMLButtonElement>("#theme-retry");

  const paintStatus = () => {
    for (const select of selects) select.dataset.themeSaveState = phase;
    if (status) {
      status.hidden = phase === "ready" || phase === "saved";
      status.classList.toggle("has-warning", phase === "error");
      status.setAttribute("role", phase === "error" ? "alert" : "status");
      status.textContent = phase === "error" ? t(retryAction === "load" ? "theme.loadFailed" : "theme.saveFailed")
        : phase === "loading" ? t("theme.loading") : phase === "saving" ? t("theme.saving") : "";
    }
    if (retry) { retry.hidden = phase !== "error"; retry.textContent = t("theme.retry"); }
  };

  const setPhase = (next: typeof phase, action: typeof retryAction = null) => {
    phase = next; retryAction = action; paintStatus();
  };

  const apply = () => {
    const effective = preference === "system" ? (systemDark.matches ? "dark" : "light") : preference;
    document.body.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
    for (const select of selects) select.value = preference;
    document.dispatchEvent(new CustomEvent("spellcast-theme-change", { detail: effective }));
  };

  const save = (value: ThemePreference, ticket: number) => {
    const cached = cachePreference(value);
    setPhase("saving");
    // Serialize native commits so a slow earlier write cannot become the final preference.
    writes = writes.then(async () => {
      try {
        if (native) await invoke<ThemePreference>("set_theme_preference", { preference: value });
        else if (!cached) throw new Error("Theme storage is unavailable");
        if (ticket === revision) setPhase("saved");
      } catch {
        if (ticket === revision) setPhase("error", "save");
      }
    });
  };

  const loadNative = async () => {
    const ticket = revision;
    setPhase("loading");
    try {
      const stored = await invoke<ThemePreference | null>("get_theme_preference");
      if (ticket !== revision) return;
      if (validPreference(stored)) {
        preference = stored; cachePreference(stored); apply(); setPhase("ready");
      } else if (stored == null) {
        // Only migrate a real earlier choice. Reading a fresh default must not save it.
        if (legacy) save(legacy, ticket);
        else setPhase("ready");
      } else throw new Error("Invalid native theme preference");
    } catch {
      if (ticket === revision) setPhase("error", "load");
    }
  };

  for (const select of selects) {
    select.addEventListener("change", () => {
      const value = select.value;
      if (!validPreference(value)) return;
      preference = value;
      revision++;
      apply();
      save(value, revision);
    });
  }
  retry?.addEventListener("click", () => {
    if (retryAction === "load") void loadNative();
    else if (retryAction === "save") save(preference, ++revision);
  });
  window.addEventListener("storage", event => {
    if (event.key !== STORAGE_KEY) return;
    preference = validPreference(event.newValue) ? event.newValue : "light";
    revision++; apply(); setPhase("ready");
  });
  systemDark.addEventListener("change", () => { if (preference === "system") apply(); });
  onLocale(paintStatus);
  apply();
  paintStatus();
  if (native) void loadNative();
}
