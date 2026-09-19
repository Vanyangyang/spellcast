export type ThemePreference = "dark" | "light" | "system";

const STORAGE_KEY = "spellcast.theme";

function savedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "dark" || value === "light" || value === "system") return value;
  } catch {
    // Private browsing or disabled storage still gets the dark default.
  }
  return "dark";
}

export function mountTheme() {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const selects = [...document.querySelectorAll<HTMLSelectElement>("[data-theme-select]")];
  let preference = savedPreference();

  const apply = () => {
    const effective = preference === "system" ? (systemDark.matches ? "dark" : "light") : preference;
    document.body.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
    for (const select of selects) select.value = preference;
    document.dispatchEvent(new CustomEvent("spellcast-theme-change", { detail: effective }));
  };

  for (const select of selects) {
    select.addEventListener("change", () => {
      const value = select.value;
      if (value !== "dark" && value !== "light" && value !== "system") return;
      preference = value;
      try { localStorage.setItem(STORAGE_KEY, value); } catch { /* current window still updates */ }
      apply();
    });
  }
  systemDark.addEventListener("change", () => { if (preference === "system") apply(); });
  apply();
}
