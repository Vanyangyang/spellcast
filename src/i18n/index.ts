import { catalogs, LOCALES, type Locale, type MessageKey } from "./messages";

export type { Locale, MessageKey };
export { LOCALES };

const STORAGE = "orbit.locale";

function detect(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved === "zh-CN" || saved === "en" || saved === "ja") return saved;
  } catch {
    /* ignore */
  }
  const raw = (navigator.language || "en").toLowerCase();
  if (raw.startsWith("zh")) return "zh-CN";
  if (raw.startsWith("ja")) return "ja";
  return "en";
}

let locale: Locale = detect();
const listeners = new Set<() => void>();

export function currentLocale(): Locale {
  return locale;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let text = catalogs[locale][key] || catalogs.en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export function setLocale(next: Locale) {
  locale = next;
  try {
    localStorage.setItem(STORAGE, next);
  } catch {
    /* ignore */
  }
  applyDom();
  listeners.forEach((fn) => fn());
}

export function onLocale(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyDom(root: ParentNode = document) {
  document.documentElement.lang = locale;
  document.title = t("doc.title");
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as MessageKey | undefined;
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder as MessageKey | undefined;
    if (key && "placeholder" in el) (el as HTMLInputElement).placeholder = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    const key = el.dataset.i18nAria as MessageKey | undefined;
    if (key) el.setAttribute("aria-label", t(key));
  });
}

export function providerLabel(id: string, fallback: string): string {
  const key = `provider.${id}` as MessageKey;
  return key in catalogs.en ? t(key) : fallback;
}

export function providerHint(id: string, fallback: string): string {
  const key = `providerHint.${id}` as MessageKey;
  return key in catalogs.en ? t(key) : fallback;
}
