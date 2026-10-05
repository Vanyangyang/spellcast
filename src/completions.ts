import "./completions.css";
import "./fonts.css";
import "./night-desk-notices.css";
import "./completion-clients.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow, type PhysicalPosition } from "@tauri-apps/api/window";
import { applyDom, currentLocale, onLocale, t, type MessageKey } from "./i18n";

type Completion = {
  thread_id: string;
  turn_id: string;
  title: string;
  summary: string;
  project: string;
  completed_at_ms: number;
  client?: string;
  host?: string;
};
type Client = "codex" | "claude" | "grok";
// `host` names the client when a task has no title; `origin` is the tag on the card. Only Codex has a
// thread to return to (completions.rs); every other client's card is simply closed.
const CLIENTS: Record<Client, { host: string; origin: string; hint: MessageKey; aria: MessageKey }> = {
  codex: { host: "Codex", origin: "Codex", hint: "completion.hint", aria: "completion.aria" },
  claude: { host: "Claude", origin: "Claude", hint: "completion.hintClaude", aria: "completion.ariaClaude" },
  grok: { host: "Grok Build", origin: "Grok", hint: "completion.hintGrok", aria: "completion.ariaGrok" },
};
// Unknown or missing clients keep the Codex look, as the stylesheet does.
const clientOf = (item: Completion): Client => item.client === "claude" || item.client === "grok" ? item.client : "codex";
// A Claude task whose CC GUI window is connected can be returned to, like a Codex task (completions.rs).
const inCcgui = (item: Completion) => clientOf(item) === "claude" && item.host === "ccgui";
const returnsToHost = (item: Completion) => clientOf(item) === "codex" || inCcgui(item);
const hintFor = (item: Completion) => t(inCcgui(item) ? "completion.hintCcgui" : CLIENTS[clientOf(item)].hint);
const ariaFor = (item: Completion): MessageKey => inCcgui(item) ? "completion.ariaCcgui" : CLIENTS[clientOf(item)].aria;
const openingFor = (item: Completion) => t(inCcgui(item) ? "completion.openingCcgui" : returnsToHost(item) ? "completion.opening" : "completion.closingGrok");
const openedFor = (item: Completion) => t(inCcgui(item) ? "completion.openedCcgui" : returnsToHost(item) ? "completion.opened" : "completion.closedGrok");
const root = document.querySelector<HTMLElement>("#completions")!;
const cards = new Map<string, HTMLElement>();
type VoiceSettings = { enabled: boolean; supported: boolean; volume: number; cooldown_seconds: number; quiet_hours: string };
const voiceButton = document.querySelector<HTMLButtonElement>("#completion-voice")!;
let voice: VoiceSettings | undefined;
let items: Completion[] = [];
// The desktop shell injects its internals before this script runs; a browser preview has no native
// window, so the page still renders its chrome and cursor routing simply stays off.
const completionWindow = "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;
let windowOrigin: PhysicalPosition | undefined;
let windowScale = 1;
let cursorProbePending = false;
let ignoringCursorEvents = false;

async function refreshWindowMetrics(win: NonNullable<typeof completionWindow>) {
  [windowOrigin, windowScale] = await Promise.all([
    win.innerPosition(),
    win.scaleFactor(),
  ]);
}

function capturesPointerAt(x: number, y: number) {
  const target = document.elementFromPoint(x, y);
  if (target?.closest(".completion-bubble, #completion-voice")) return true;
  const list = target?.closest<HTMLElement>("#completions");
  if (!list || list.scrollHeight <= list.clientHeight) return false;
  const bounds = list.getBoundingClientRect();
  return x >= bounds.right - 12 && x <= bounds.right;
}

async function routeCursorEvents() {
  if (!completionWindow || cursorProbePending || items.length === 0) return;
  cursorProbePending = true;
  try {
    if (!windowOrigin) await refreshWindowMetrics(completionWindow);
    const cursor = await cursorPosition();
    const x = (cursor.x - windowOrigin!.x) / windowScale;
    const y = (cursor.y - windowOrigin!.y) / windowScale;
    const ignore = !capturesPointerAt(x, y);
    if (ignore !== ignoringCursorEvents) {
      await completionWindow.setIgnoreCursorEvents(ignore);
      ignoringCursorEvents = ignore;
      document.documentElement.dataset.cursorRouting = ignore ? "passthrough" : "capture";
    }
  } catch {
    // Browser preview and platforms without cursor-event routing keep the ordinary window behavior.
  } finally {
    cursorProbePending = false;
  }
}

window.setInterval(() => void routeCursorEvents(), 50);

function paintChrome() {
  applyDom();
  document.title = t("completion.docTitle");
}

function paintVoice(settings?: VoiceSettings) {
  if (settings) voice = settings;
  const current = voice;
  if (!current) {
    voiceButton.textContent = t("completion.voice");
    return;
  }
  const on = current.enabled && current.supported;
  voiceButton.disabled = !current.supported;
  voiceButton.setAttribute("aria-pressed", String(on));
  voiceButton.textContent = on ? t("completion.voiceOn") : t("completion.voiceOff");
  voiceButton.title = current.supported
    ? t("completion.voiceTitle", {
        volume: current.volume,
        cooldown: current.cooldown_seconds,
        hours: current.quiet_hours,
        action: current.enabled ? t("completion.voiceDisable") : t("completion.voiceEnable"),
      })
    : t("completion.voiceUnsupported");
}

voiceButton.addEventListener("click", async () => {
  if (!voice || voiceButton.disabled) return;
  voiceButton.disabled = true;
  try { paintVoice(await invoke<VoiceSettings>("set_completion_voice", { enabled: !voice.enabled })); }
  catch {
    voiceButton.disabled = !voice.supported;
    voiceButton.title = t("completion.voiceSaveFailed");
  }
});

function displayName(item: Completion) {
  const title = item.title.trim();
  // A name that only repeats the project (a new Grok session) says nothing the status row does not.
  const meaningfulTitle = title && !/^(codex|claude|grok(\s*build)?)\s*(任务|task)$/i.test(title)
    && title.toLowerCase() !== item.project.trim().toLowerCase();
  return { title, meaningfulTitle, name: meaningfulTitle ? title : item.project || CLIENTS[clientOf(item)].host };
}

function paintCard(card: HTMLElement, item: Completion) {
  const { title, meaningfulTitle, name } = displayName(item);
  const titleEl = card.querySelector<HTMLElement>(".title")!;
  titleEl.textContent = meaningfulTitle ? title : "";
  titleEl.hidden = !meaningfulTitle;
  card.querySelector(".done")!.textContent = t("completion.done");
  card.querySelector(".summary")!.textContent = item.summary;
  card.querySelector(".project")!.textContent = item.project;
  const hint = card.querySelector<HTMLElement>(".hint")!;
  if (card.dataset.opening !== "1") hint.textContent = hintFor(item);
  const dismiss = card.querySelector<HTMLButtonElement>(".dismiss")!;
  dismiss.setAttribute("aria-label", t("completion.dismissAria"));
  dismiss.title = t("completion.dismissTitle");
  const client = clientOf(item);
  card.dataset.client = client;
  card.querySelector(".origin")!.textContent = CLIENTS[client].origin;
  card.querySelector(".task")!.setAttribute("aria-label", t(ariaFor(item), { name }));
}

function render(next: Completion[]) {
  items = next;
  const active = new Set(next.map(item => item.thread_id));
  for (const [id, card] of cards) if (!active.has(id)) { card.remove(); cards.delete(id); }
  next.forEach((item, index) => {
    let card = cards.get(item.thread_id);
    if (!card || card.dataset.turn !== item.turn_id) {
      card?.remove();
      card = document.createElement("article");
      card.className = "completion-bubble";
      card.dataset.thread = item.thread_id;
      card.dataset.turn = item.turn_id;
      card.innerHTML = `<button class="task" type="button"><span class="status"><span class="check" aria-hidden="true">✓</span><span class="done"></span><span class="origin"></span><span class="project"></span></span><strong class="title"></strong><span class="summary"></span><span class="hint"></span></button><button class="dismiss" type="button">×</button><span class="error" role="status"></span>`;
      const button = card.querySelector<HTMLButtonElement>(".task")!;
      const error = card.querySelector<HTMLElement>(".error")!;
      const open = async () => {
        if (card!.dataset.opening === "1") return;
        card!.dataset.opening = "1"; error.textContent = "";
        const hint = card!.querySelector<HTMLElement>(".hint")!;
        // The list changes under an open card (a CC GUI window connects or goes away); read the current entry.
        const current = () => items.find(entry => entry.thread_id === item.thread_id && entry.turn_id === item.turn_id) ?? item;
        hint.textContent = openingFor(current());
        try {
          await invoke("open_completed_task", { threadId: item.thread_id, turnId: item.turn_id });
          card?.classList.add("dismissing");
          hint.textContent = openedFor(current());
        }
        catch (reason) { error.textContent = String(reason); hint.textContent = hintFor(current()); }
        finally { delete card!.dataset.opening; }
      };
      button.addEventListener("dblclick", () => void open());
      button.addEventListener("click", event => { if (event.detail === 0) void open(); });
      card.querySelector(".dismiss")!.addEventListener("click", async () => {
        try {
          await invoke("dismiss_completion", { threadId: item.thread_id, turnId: item.turn_id });
          card?.classList.add("dismissing");
        } catch { error.textContent = t("completion.dismissFailed"); }
      });
      cards.set(item.thread_id, card);
    }
    paintCard(card, item);
    if (root.children[index] !== card) root.insertBefore(card, root.children[index] ?? null);
  });
  windowOrigin = undefined;
  void routeCursorEvents();
}

async function syncLocale() {
  try { await invoke("set_ui_locale", { locale: currentLocale() }); }
  catch { /* browser preview and missing native command */ }
}

async function boot() {
  paintChrome();
  onLocale(() => {
    paintChrome();
    paintVoice();
    render(items);
    void syncLocale();
  });
  void syncLocale();
  await listen<VoiceSettings>("spellcast-completion-voice", event => paintVoice(event.payload));
  await listen<Completion[]>("spellcast-completions", event => render(event.payload));
  const [next, settings] = await Promise.all([invoke<Completion[]>("get_completions"), invoke<VoiceSettings>("get_completion_voice")]);
  render(next); paintVoice(settings);
}
void boot().catch(() => { root.textContent = t("completion.unavailable"); });
