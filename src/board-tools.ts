import { fetchMemories, fetchPendingFeedback, forgetMemory, saveMemory, setBubblesPaused } from "./api";
import { currentLocale, onLocale } from "./i18n";
import { bt } from "./i18n/board";
import type { AgentEvent, BridgeStatus } from "./types";

type Options = {
  getStatus(): BridgeStatus | null;
  onStatus(status: BridgeStatus): void;
  onNavigate(event: AgentEvent): void;
  onError(error: unknown): void;
};

export function mountBoardTools(options: Options) {
  const memoryDialog = document.querySelector<HTMLDialogElement>("#memory-dialog")!;
  const feedbackDialog = document.querySelector<HTMLDialogElement>("#feedback-dialog")!;
  const memories = document.querySelector<HTMLElement>("#memory-list")!;
  const feedback = document.querySelector<HTMLElement>("#feedback-list")!;
  const memoryForm = document.querySelector<HTMLFormElement>("#memory-form")!;
  const name = document.querySelector<HTMLInputElement>("#memory-name")!;
  const content = document.querySelector<HTMLTextAreaElement>("#memory-text")!;
  const search = document.querySelector<HTMLInputElement>("#memory-search")!;
  const memoryStatus = document.querySelector<HTMLElement>("#memory-status")!;
  const pause = document.querySelector<HTMLButtonElement>("#bubbles-pause")!;
  const pendingBadge = document.querySelector<HTMLElement>("#feedback-count")!;
  let pending: AgentEvent[] = [];
  let loaded = false;
  let queryVersion = 0;
  let searchTimer = 0;
  let feedbackBusy = false;

  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  function paintLabels() {
    document.querySelectorAll<HTMLElement>("[data-board-text]").forEach((element) => {
      const key = element.dataset.boardText as Parameters<typeof bt>[0];
      const value = bt(key);
      if (element.textContent !== value) element.textContent = value;
    });
    search.placeholder = bt("searchPlaceholder");
    pause.textContent = options.getStatus()?.paused ? bt("resume") : bt("pause");
    pause.setAttribute("aria-pressed", String(Boolean(options.getStatus()?.paused)));
    paintFeedback();
  }

  function paintFeedback() {
    const label = pending.length ? bt("waiting", { n: pending.length }) : "";
    pendingBadge.textContent = label;
    pendingBadge.hidden = !pending.length;
    if (!feedbackDialog.open) return;
    feedback.replaceChildren();
    if (!pending.length && loaded) { feedback.append(node("p", bt("emptyFeedback"))); return; }
    for (const event of [...pending].reverse()) {
      const row = node("article");
      row.className = "saved-item";
      const head = node("header");
      const title = node("strong", event.title || (event.kind === "kept" ? bt("ideas") : bt("feedback")));
      const source = options.getStatus()?.sources?.find((s) => s.id === event.source_id)?.label;
      head.append(title, node("small", source || (event.source_id ? "Agent" : bt("unassigned"))));
      row.append(head, node("p", event.text || event.kind));
      row.append(node("small", new Date(event.at_ms).toLocaleString(currentLocale())));
      if (event.reply_id || event.node_id) {
        const open = node("button", event.reply_id ? bt("openReply") : bt("openIdea"));
        open.type = "button"; open.className = "ghost";
        open.addEventListener("click", () => { feedbackDialog.close(); options.onNavigate(event); });
        row.append(open);
      }
      feedback.append(row);
    }
  }

  async function refreshFeedback() {
    if (feedbackBusy) return;
    feedbackBusy = true;
    try { pending = await fetchPendingFeedback(); loaded = true; paintFeedback(); }
    catch { /* Keep the last confirmed state during a brief bridge restart. */ }
    finally { feedbackBusy = false; }
  }

  async function refreshMemories() {
    const version = ++queryVersion;
    try {
      const items = await fetchMemories(search.value);
      if (version !== queryVersion) return;
      memories.replaceChildren();
      if (!items.length) memories.append(node("p", bt("noMemories")));
      for (const item of items) {
        const row = node("article"); row.className = "saved-item";
        const head = node("header"); head.append(node("strong", item.title));
        const remove = node("button", bt("forget")); remove.type = "button"; remove.className = "ghost";
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try { await forgetMemory(item.id); row.remove(); memoryStatus.textContent = bt("memoryForgotten"); }
          catch (error) { remove.disabled = false; options.onError(error); }
        });
        head.append(remove);
        row.append(head, node("p", item.text), node("small", new Date(item.created_at_ms).toLocaleDateString(currentLocale())));
        memories.append(row);
      }
    } catch (error) { if (version === queryVersion) options.onError(error); }
  }

  document.querySelector("#memory-open")!.addEventListener("click", () => {
    memoryDialog.showModal(); void refreshMemories();
  });
  document.querySelector("#feedback-open")!.addEventListener("click", () => {
    feedbackDialog.showModal(); paintFeedback(); void refreshFeedback();
  });
  for (const dialog of [memoryDialog, feedbackDialog]) {
    dialog.querySelector<HTMLButtonElement>("[data-close]")!.addEventListener("click", () => dialog.close());
  }
  pause.addEventListener("click", async () => {
    pause.disabled = true;
    try { options.onStatus(await setBubblesPaused(!options.getStatus()?.paused)); paintLabels(); }
    catch (error) { options.onError(error); }
    finally { pause.disabled = false; }
  });
  memoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = content.value.trim();
    if (!text) { content.focus(); return; }
    const button = memoryForm.querySelector<HTMLButtonElement>("[type=submit]")!;
    button.disabled = true; memoryStatus.textContent = bt("saving");
    try {
      await saveMemory(name.value.trim(), text);
      name.value = ""; content.value = ""; search.value = "";
      memoryStatus.textContent = bt("memorySaved"); await refreshMemories();
    } catch (error) { memoryStatus.textContent = bt("error"); options.onError(error); }
    finally { button.disabled = false; }
  });
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    queryVersion += 1;
    searchTimer = window.setTimeout(() => void refreshMemories(), 180);
  });
  onLocale(() => { paintLabels(); if (memoryDialog.open) void refreshMemories(); });
  paintLabels();
  void refreshFeedback();
  const timer = window.setInterval(() => void refreshFeedback(), 3000);
  window.addEventListener("beforeunload", () => window.clearInterval(timer), { once: true });
  return { refreshFeedback, paintLabels };
}
