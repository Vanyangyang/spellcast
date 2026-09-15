import { fetchMemories, fetchFeedbackState, retryFeedback, bindCodexTask, unbindCodexTask, forgetMemory, saveMemory, setBubblesPaused } from "./api";
import { currentLocale, onLocale } from "./i18n";
import { bt } from "./i18n/board";
import { ct } from "./i18n/canvas";
import type { BoardSnapshot, BridgeStatus, DeliveryPhase, DeliveryReceipt, FeedbackState } from "./types";
import {
  targetOnBoard,
  applyLocalReceipt,
  mergeFeedbackFetch,
  stampReceiptGuard,
  type ContentNavTarget,
  type FeedbackView,
  type MessageRow,
} from "./content-organization";
import { feedbackInbox, filterInbox, type InboxEntry } from "./feedback-inbox";
import { resolveContentOrigin } from "./content-origin";
import "./feedback-inbox.css";

type Options = {
  getStatus(): BridgeStatus | null;
  getBoard(): BoardSnapshot;
  getScope?(): { workspace: string; task: string };
  onStatus(status: BridgeStatus): void;
  onNavigate(target: ContentNavTarget): void;
  onFeedbackState(state: FeedbackState): void;
  onError(error: unknown): void;
};

export function mountBoardTools(options: Options) {
  const memoryDialog = document.querySelector<HTMLDialogElement>("#memory-dialog")!;
  const feedbackDialog = document.querySelector<HTMLDialogElement>("#feedback-dialog")!;
  const memories = document.querySelector<HTMLElement>("#memory-list")!;
  const feedback = document.querySelector<HTMLElement>("#feedback-list")!;
  const diagnostics = document.querySelector<HTMLDetailsElement>("#feedback-diagnostics")!;
  const taskList = document.querySelector<HTMLElement>("#feedback-task-list")!;
  const memoryForm = document.querySelector<HTMLFormElement>("#memory-form")!;
  const name = document.querySelector<HTMLInputElement>("#memory-name")!;
  const content = document.querySelector<HTMLTextAreaElement>("#memory-text")!;
  const search = document.querySelector<HTMLInputElement>("#memory-search")!;
  const feedbackSearch = document.querySelector<HTMLInputElement>("#feedback-search")!;
  const workspaceFilter = document.querySelector<HTMLSelectElement>("#feedback-workspace")!;
  const taskFilter = document.querySelector<HTMLSelectElement>("#feedback-task")!;
  const feedbackScroll = document.querySelector<HTMLElement>("#feedback-scroll")!;
  const feedbackSummary = document.querySelector<HTMLElement>("#feedback-summary")!;
  const syncNotice = document.querySelector<HTMLElement>("#feedback-sync")!;
  const memoryStatus = document.querySelector<HTMLElement>("#memory-status")!;
  const pause = document.querySelector<HTMLButtonElement>("#bubbles-pause")!;
  const pendingBadge = document.querySelector<HTMLElement>("#feedback-count")!;
  let state: FeedbackState = { pending: [], deliveries: [], bindings: [] };
  let loaded = false;
  let queryVersion = 0;
  let searchTimer = 0;
  let feedbackBusy = false;
  let view: FeedbackView = "followup";
  let paintKey = "";
  let workspace = "all", task = "all";
  let syncFailed = false;
  const retryInflight = new Set<number>();
  let mutationEpoch = 0;
  const receiptGuards = new Map<number, number>();
  const expanded = new Set<string>();
  const bindingForm = document.createElement("form");
  const sourceInput = document.createElement("input"); sourceInput.required = true;
  const threadInput = document.createElement("input"); threadInput.required = true;
  const cwdInput = document.createElement("input");
  const bind = document.createElement("button"); bind.type = "submit";
  const bindingStatus = document.createElement("p"); bindingStatus.setAttribute("role", "status");
  const bindHelp = document.createElement("p");
  bindingForm.append(bindHelp, sourceInput, threadInput, cwdInput, bind, bindingStatus);
  taskList.after(bindingForm);
  bindingForm.addEventListener("submit", async event => {
    event.preventDefault(); bind.disabled = true; bindingStatus.textContent = ct("binding");
    try { await bindCodexTask(sourceInput.value.trim(), threadInput.value.trim(), cwdInput.value.trim() || undefined); bindingStatus.textContent = ct("bound"); await refreshFeedback(); }
    catch (error) { bindingStatus.textContent = String(error); }
    finally { bind.disabled = false; }
  });

  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  function phaseLabel(status: DeliveryPhase | "none") {
    if (status === "none") return bt("statusUnknown");
    return ct(`phase.${status}` as Parameters<typeof ct>[0]);
  }

  function paintViews() {
    document.querySelectorAll<HTMLButtonElement>("[data-feedback-view]").forEach((button) => {
      const on = button.dataset.feedbackView === view;
      button.setAttribute("aria-selected", String(on));
      button.classList.toggle("is-on", on);
      button.tabIndex = on ? 0 : -1;
    });
  }

  function paintLabels() {
    document.querySelectorAll<HTMLElement>("[data-board-text]").forEach((element) => {
      const key = element.dataset.boardText as Parameters<typeof bt>[0];
      const value = bt(key);
      if (element.textContent !== value) element.textContent = value;
    });
    search.placeholder = bt("searchPlaceholder");
    feedbackSearch.placeholder = bt("searchFeedback");
    pause.textContent = options.getStatus()?.paused ? bt("resume") : bt("pause");
    pause.setAttribute("aria-pressed", String(Boolean(options.getStatus()?.paused)));
    bindHelp.textContent = ct("bindHelp"); bind.textContent = ct("bind");
    for (const [input, key] of [[sourceInput, "sourceId"], [threadInput, "threadId"], [cwdInput, "cwd"]] as const) { input.placeholder = ct(key); input.setAttribute("aria-label", ct(key)); }
    document.querySelector("#feedback-views")!.setAttribute("aria-label", bt("feedback"));
    paintViews();
    paintFeedback(true);
  }

  function paintBindings() {
    taskList.replaceChildren();
    for (const binding of state.bindings) {
      const row = node("article"); row.className = "saved-item";
      row.append(node("strong", binding.label), node("p", binding.source_id), node("small", binding.thread_id));
      const unlink = node("button", ct("unbind")); unlink.type = "button";
      unlink.addEventListener("click", async () => { unlink.disabled = true; try { await unbindCodexTask(binding.source_id); await refreshFeedback(); } catch (error) { options.onError(error); unlink.disabled = false; } });
      row.append(unlink); taskList.append(row);
    }
    if (!state.bindings.length) taskList.append(node("p", ct("noBindings")));
  }

  function activityAction(kind: string) {
    if (kind === "kept") return bt("activityKept");
    if (kind === "unkept") return bt("activityUnkept");
    return bt("activityRecord");
  }

  function applyReceipt(receipt: DeliveryReceipt) {
    const stamped = stampReceiptGuard(receiptGuards, mutationEpoch, receipt.event.seq);
    mutationEpoch = stamped.epoch;
    receiptGuards.clear();
    for (const [seq, epoch] of stamped.guards) receiptGuards.set(seq, epoch);
    state = applyLocalReceipt(state, receipt);
  }

  function activityBlock(row: MessageRow) {
    const block = node("article");
    block.className = "feedback-note feedback-activity";
    block.dataset.seq = String(row.seq);
    const action = node("p", activityAction(row.kind)); action.className = "feedback-kicker";
    block.append(action, node("small", new Date(row.at_ms).toLocaleString(currentLocale())));
    if (!row.originalTarget.missing) {
      const open = node("button", bt("openContent")); open.type = "button"; open.className = "ghost";
      open.addEventListener("click", () => { feedbackDialog.close(); options.onNavigate(row.originalTarget); });
      block.append(open);
    }
    const details = node("details"); details.dataset.itemId = `activity-${row.seq}`;
    if (expanded.has(details.dataset.itemId)) details.open = true;
    details.addEventListener("toggle", () => {
      if (details.open) expanded.add(details.dataset.itemId!); else expanded.delete(details.dataset.itemId!);
    });
    details.append(node("summary", bt("diagnostics")));
    details.append(node("p", row.kind));
    block.append(details);
    return block;
  }

  function messageBlock(row: MessageRow) {
    const block = node("div");
    block.className = "feedback-note";
    block.dataset.seq = String(row.seq);
    const who = node("p", bt(row.kind === "selection" ? "selectionRecord" : row.kind === "reply_edit" ? "editRecord" : "yourMessage")); who.className = "feedback-kicker";
    const text = node("p", row.text); text.className = "feedback-message-text";
    block.append(who, text);
    if (row.receipt) {
      const attention = row.receipt.error || row.receipt.desktop?.attention;
      if (attention) { const warning = node("p", attention); warning.className = "feedback-warning"; block.append(warning); }
    }
    if (row.unbound && !row.canRetry && view === "followup") block.append(node("small", bt("noRetryUnbound")));
    const actions = node("div"); actions.className = "feedback-actions";
    if (row.canRetry && view !== "activity") {
      const retry = node("button", ct(row.status === "unknown" || row.status === "unanswered" || row.receipt?.desktop?.accepted_at_ms ? "reconcile" : "retry")); retry.type = "button";
      retry.disabled = retryInflight.has(row.seq);
      retry.addEventListener("click", async () => {
        if (retryInflight.has(row.seq)) return;
        retryInflight.add(row.seq); retry.disabled = true;
        try {
          applyReceipt(await retryFeedback(row.seq));
          await refreshFeedback();
        } catch (error) { options.onError(error); }
        finally {
          retryInflight.delete(row.seq);
          paintFeedback(true);
        }
      });
      actions.append(retry);
    }
    if (row.responseTarget && targetOnBoard(row.responseTarget, options.getBoard())) {
      const open = node("button", bt("viewCurrentResult"));
      open.type = "button"; open.className = "feedback-primary";
      open.addEventListener("click", () => { feedbackDialog.close(); options.onNavigate(row.responseTarget!); });
      actions.append(open);
    }
    if (targetOnBoard(row.originalTarget, options.getBoard()) && !(row.responseTarget && targetOnBoard(row.responseTarget, options.getBoard()))) {
      const open = node("button", bt("openContent")); open.type = "button"; open.className = "ghost";
      open.addEventListener("click", () => { feedbackDialog.close(); options.onNavigate(row.originalTarget); });
      actions.append(open);
    }
    if (actions.childElementCount) block.append(actions);
    if (row.receipt) {
      const details = node("details"); details.dataset.itemId = `receipt-${row.seq}`;
      if (expanded.has(details.dataset.itemId)) details.open = true;
      details.addEventListener("toggle", () => {
        if (details.open) expanded.add(details.dataset.itemId!); else expanded.delete(details.dataset.itemId!);
      });
      details.append(node("summary", ct("details")));
      details.append(node("p", `${ct("sourceId")}: ${row.source_id || ""}`));
      for (const [key, time] of [["timelineSaved", row.at_ms], ["timelineQueued", row.receipt.queued_at_ms], ["timelineRead", row.receipt.received_at_ms], ["timelineReply", row.receipt.responded_at_ms], ["timelineHandled", row.receipt.handled_at_ms]] as const) {
        if (time != null) details.append(node("p", `${ct(key)}: ${new Date(time).toLocaleTimeString(currentLocale())} · +${((time - row.at_ms) / 1000).toFixed(2)}s`));
      }
      if (row.receipt.error) details.append(node("p", row.receipt.error));
      block.append(details);
    }
    return block;
  }

  function paintFilters(entries: InboxEntry[]) {
    const origins = [...entries.map(entry => entry.origin), ...state.bindings.map(binding => resolveContentOrigin(undefined, binding.source_id, [binding]))];
    const workspaces = new Map(origins.map(origin => [origin.workspaceKey, origin.cwd || bt("unassignedWorkspace")]));
    if (workspace !== "all" && !workspaces.has(workspace)) workspaces.set(workspace, workspace.replace(/^workspace:/, ""));
    const option = (value: string, label: string) => { const result = node("option", label); result.value = value; return result; };
    workspaceFilter.replaceChildren(option("all", bt("allWorkspaces")), ...[...workspaces].sort((a, b) => a[1].localeCompare(b[1])).map(([id, label]) => option(id, label)));
    workspaceFilter.value = workspace;
    const tasks = new Map(origins.filter(origin => workspace === "all" || origin.workspaceKey === workspace).map(origin => [origin.taskKey, origin.taskLabel || bt("taskUnlinked")]));
    if (!tasks.has(task)) task = "all";
    taskFilter.replaceChildren(option("all", bt("allTasks")), ...[...tasks].map(([id, label]) => option(id, label)));
    taskFilter.value = task;
  }

  function entryCard(entry: InboxEntry) {
    const { row } = entry;
    const card = node("article"); card.className = "feedback-card"; card.dataset.itemId = `request-${row.seq}`; card.dataset.seq = String(row.seq);
    const header = node("header");
    const title = node("h3", entry.title || bt("contentUnavailable"));
    title.title = entry.title;
    const status = node("span", entry.view === "activity" ? bt("historicalRecord") : row.status === "handled" ? bt("handledStatus") : row.status === "responded" ? bt("repliedStatus") : row.unbound ? bt("taskUnlinked") : phaseLabel(row.status));
    status.className = "feedback-status"; status.dataset.tone = entry.view === "activity" ? "quiet" : entry.view === "replied" ? "done" : entry.attention ? "attention" : "active";
    header.append(title, status); card.append(header);
    const meta = node("div"); meta.className = "feedback-meta";
    const origin = node("span", [entry.origin.workspaceLabel || bt("unassignedWorkspace"), row.taskLabel || bt("taskUnlinked")].join(" · "));
    origin.title = [entry.origin.cwd, row.taskLabel].filter(Boolean).join("\n");
    const time = node("time", new Date(row.at_ms).toLocaleString(currentLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })); time.dateTime = new Date(row.at_ms).toISOString();
    time.title = new Date(row.at_ms).toLocaleString(currentLocale()); meta.append(origin, time); card.append(meta);
    if (row.kind === "say" || row.kind === "reply" || row.kind === "selection" || row.kind === "reply_edit") card.append(messageBlock(row));
    else card.append(activityBlock(row));
    if (entry.view === "replied") {
      const result = node("div"); result.className = "feedback-result";
      result.append(node("small", entry.hasResult ? bt("currentCanvasResult") : bt("handledWithoutResult")));
      if (entry.result) result.append(node("p", entry.result));
      card.append(result);
    }
    if (entry.context) {
      const existing = card.querySelector<HTMLDetailsElement>(".feedback-note > details");
      if (existing) {
        existing.append(node("strong", bt("originalContext")), node("p", entry.context));
      } else {
      const context = node("details"); context.className = "feedback-context"; context.dataset.itemId = `context-${row.seq}`;
      context.open = expanded.has(context.dataset.itemId);
      context.addEventListener("toggle", () => { if (context.open) expanded.add(context.dataset.itemId!); else expanded.delete(context.dataset.itemId!); });
      context.append(node("summary", bt("originalContext")), node("p", entry.context)); card.append(context);
      }
    }
    // Keep the result next to the user's request, with actions and diagnostics below it.
    const actions = card.querySelector(".feedback-actions");
    const details = card.querySelector(".feedback-note > details");
    if (actions) card.append(actions);
    if (details) card.append(details);
    return card;
  }

  function paintFeedback(force = false) {
    const entries = feedbackInbox(state, options.getBoard());
    const count = filterInbox(entries, options.getScope?.().workspace || "all", "all", "", "followup").length;
    const label = count ? bt("waiting", { n: count }) : "";
    pendingBadge.textContent = label;
    pendingBadge.hidden = !count;
    if (!feedbackDialog.open && !force) return;
    const query = feedbackSearch.value;
    const nextKey = JSON.stringify({ entries, view, query, workspace, task, loaded, syncFailed, bindings: state.bindings });
    if (!force && nextKey === paintKey) return;
    const scroll = feedbackScroll.scrollTop;
    const searchFocused = document.activeElement === feedbackSearch;
    const selectionStart = feedbackSearch.selectionStart;
    const selectionEnd = feedbackSearch.selectionEnd;
    const selectionDirection = feedbackSearch.selectionDirection;
    diagnostics.open = expanded.has("diagnostics");
    paintKey = nextKey;
    paintFilters(entries);
    const scoped = filterInbox(entries, workspace, task);
    document.querySelectorAll<HTMLButtonElement>("[data-feedback-view]").forEach(button => {
      const name = button.dataset.feedbackView as FeedbackView;
      const key = name === "followup" ? "followUp" : name === "replied" ? "repliedHandled" : "recentActivity";
      button.textContent = `${bt(key)} ${scoped.filter(entry => entry.view === name).length}`;
    });
    paintViews();
    feedback.setAttribute("aria-labelledby", `feedback-tab-${view}`);
    syncNotice.hidden = !syncFailed;
    paintBindings();
    feedback.replaceChildren();
    const cards = filterInbox(entries, workspace, task, query, view);
    feedbackSummary.textContent = !loaded ? bt("loadingFeedback") : view === "activity" ? bt("historyHelp", { n: cards.length }) : bt("requestCount", { n: cards.length });
    if (!cards.length && loaded) {
      const empty = node("div"); empty.className = "feedback-empty";
      empty.append(node("strong", query ? bt("noSearchResults") : view === "followup" ? bt("followUpEmpty") : view === "replied" ? bt("repliedEmpty") : bt("activityEmpty")));
      empty.append(node("p", bt("changeFiltersHint")));
      feedback.append(empty);
    }
    for (const entry of cards) feedback.append(entryCard(entry));
    feedbackScroll.scrollTop = scroll;
    if (searchFocused) {
      feedbackSearch.focus();
      if (selectionStart != null && selectionEnd != null) {
        feedbackSearch.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
      }
    }
  }

  async function refreshFeedback() {
    if (feedbackBusy) return;
    feedbackBusy = true;
    const fetchStartedAt = mutationEpoch;
    try {
      const next = await fetchFeedbackState();
      loaded = true;
      syncFailed = false;
      const merged = mergeFeedbackFetch(state, next, receiptGuards, fetchStartedAt);
      state = merged.state;
      receiptGuards.clear();
      for (const [seq, epoch] of merged.guards) receiptGuards.set(seq, epoch);
      options.onFeedbackState(state);
      paintFeedback();
    }
    catch { syncFailed = true; paintFeedback(); }
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
    const scope = options.getScope?.(); workspace = scope?.workspace || "all"; task = scope?.task || "all";
    feedbackDialog.showModal(); paintFeedback(true); void refreshFeedback();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-feedback-view]").forEach((button) => {
    button.addEventListener("click", () => {
      view = (button.dataset.feedbackView as FeedbackView) || "followup";
      feedbackScroll.scrollTop = 0;
      paintViews();
      paintFeedback(true);
    });
  });
  document.querySelector("#feedback-views")!.addEventListener("keydown", event => {
    const key = (event as KeyboardEvent).key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-feedback-view]")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = key === "Home" ? 0 : key === "End" ? buttons.length - 1 : (current + (key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[index].click(); buttons[index].focus();
  });
  workspaceFilter.addEventListener("change", () => { workspace = workspaceFilter.value; task = "all"; feedbackScroll.scrollTop = 0; paintFeedback(true); });
  taskFilter.addEventListener("change", () => { task = taskFilter.value; feedbackScroll.scrollTop = 0; paintFeedback(true); });
  document.querySelector("#feedback-refresh")!.addEventListener("click", () => void refreshFeedback());
  feedbackSearch.addEventListener("input", () => paintFeedback(true));
  diagnostics.addEventListener("toggle", () => {
    if (diagnostics.open) expanded.add("diagnostics"); else expanded.delete("diagnostics");
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
