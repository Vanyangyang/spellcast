import "./styles.css";
import "./board-workspace.css";
import {
  createNode,
  configureClient,
  deleteNode,
  describeClient,
  dismissBubble,
  fetchBoard,
  fetchEvents,
  fetchForms,
  fetchStatus,
  installClientSkill,
  keepBubble,
  patchNode,
  resetBoard,
  say,
  setForm as setFormApi,
  setSurface,
  unkeepBubble,
  patchBoardReply,
  actOnBoardReply,
} from "./api";
import { mountReplyBoard } from "./replies";
import { mountBoardTools } from "./board-tools";
import { bt } from "./i18n/board";
import type { BoardReply } from "./reply-types";
import { createShell, isDesktopShell } from "./shell";
import { renderConstellation } from "./forms/constellation";
import { mountSpatial } from "./forms/spatial";
import { renderStack } from "./forms/stack";
import { renderTimeline } from "./forms/timeline";
import { applyDom, currentLocale, LOCALES, onLocale, setLocale, t } from "./i18n";
import type { Locale, MessageKey } from "./i18n";
import type {
  AgentEvent,
  BoardSnapshot,
  BridgeStatus,
  FormInfo,
  FragmentWeight,
  NodeKind,
  PresentResult,
  StageForm,
  Surface,
  ThrownBubble,
} from "./types";
import { FORMS, formLabel, formReason, kindLabel, KINDS, weightLabel, WEIGHTS } from "./types";

const plane = document.querySelector<HTMLElement>("#plane")!;
const spatial = document.querySelector<HTMLCanvasElement>("#spatial")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const formsNav = document.querySelector<HTMLElement>("#forms")!;
const topicEl = document.querySelector<HTMLElement>("#topic")!;
const reasonEl = document.querySelector<HTMLElement>("#form-reason")!;
const logEl = document.querySelector<HTMLOListElement>("#log")!;
const inspector = document.querySelector<HTMLElement>("#inspector")!;
const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const talk = document.querySelector<HTMLFormElement>("#talk")!;
const insTitle = document.querySelector<HTMLInputElement>("#ins-title")!;
const insBody = document.querySelector<HTMLTextAreaElement>("#ins-body")!;
const insKind = document.querySelector<HTMLSelectElement>("#ins-kind")!;
const insWeight = document.querySelector<HTMLSelectElement>("#ins-weight")!;
const peek = document.querySelector<HTMLElement>("#peek")!;
const peekTitle = document.querySelector<HTMLElement>("#peek-title")!;
const peekBody = document.querySelector<HTMLElement>("#peek-body")!;
const peekNote = document.querySelector<HTMLTextAreaElement>("#peek-note")!;
const activityEl = document.querySelector<HTMLOListElement>("#activity")!;
const activityEmpty = document.querySelector<HTMLElement>("#activity-empty")!;
const agentUrl = document.querySelector<HTMLInputElement>("#agent-mcp-url")!;
const settings = document.querySelector<HTMLElement>("#settings")!;
const settingsUrl = document.querySelector<HTMLInputElement>("#settings-mcp-url")!;
const settingsPath = document.querySelector<HTMLInputElement>("#settings-path")!;
const settingsSkillPath = document.querySelector<HTMLInputElement>("#settings-skill-path")!;
const replyHost = document.querySelector<HTMLElement>("#reply-stage")!;
const recipient = document.querySelector<HTMLSelectElement>("#recipient")!;

let board: BoardSnapshot = {
  topic: "",
  form: "constellation",
  form_reason: "",
  nodes: [],
  edges: [],
  messages: [],
  replies: [],
};
let selected: string | null = null;
let forms: FormInfo[] = [];
let spatialHandle: ReturnType<typeof mountSpatial> | null = null;
let inspectorId: string | null = null;
let mode: Surface = initialMode();
let peekItem: ThrownBubble | null = null;
let sending = false;
let bridgeStatus: BridgeStatus | null = null;
let bridgeReachable = true;
let selectedClient = "codex";
let previewRevision = 0;
let boardView: "replies" | "ideas" = "ideas";
let awaitingOrigin: string | null = null;
let noticeTimer = 0;

function mergeBoardReply(reply: BoardReply) {
  const replies = [...(board.replies ?? [])];
  const index = replies.findIndex((item) => item.id === reply.id);
  if (index >= 0) replies[index] = reply;
  else replies.push(reply);
  board.replies = replies;
}

const replyBoard = mountReplyBoard(replyHost, {
  onAction: async (request) => {
    const reply = await actOnBoardReply(request);
    mergeBoardReply(reply);
    void boardTools.refreshFeedback();
    return reply;
  },
  onPatch: async (request) => {
    const reply = await patchBoardReply(request);
    mergeBoardReply(reply);
    void boardTools.refreshFeedback();
    return reply;
  },
  onSelect: () => paintComposerContext(),
  onError: (message) => flash(message),
});
const boardTools = mountBoardTools({
  getStatus: () => bridgeStatus,
  onStatus: (status) => { bridgeStatus = status; paintConnection(); },
  onError: (error) => flash(error),
  onNavigate: (event) => {
    if (event.reply_id) {
      boardView = "replies"; replyBoard.select(event.reply_id);
    } else if (event.node_id) {
      boardView = "ideas"; selected = event.node_id;
    }
    void setMode("focus");
  },
});

type Activity = { at: number; key: MessageKey; vars: Record<string, string | number> };
const activity: Activity[] = [];
let lastSeq = 0;

function initialMode(): Surface {
  const q = new URLSearchParams(location.search).get("mode");
  if (q === "ambient" || q === "focus") return q;
  try {
    const saved = localStorage.getItem("spellcast.mode");
    if (saved === "ambient" || saved === "focus") return saved;
  } catch {
    /* ignore */
  }
  return "ambient";
}

const shell = createShell({
  onPoke: (item) => handlePoke(item),
  onThrown: (item) => note("act.thrown", { tease: item.tease }),
  onPresent: (result) => void onPresent(result),
  onBoard: () => void refreshBoard(),
  onFocus: () => void setMode("focus"),
  onAgent: (client) => {
    const now = Date.now();
    const agents = [...(bridgeStatus?.agents ?? [])];
    const index = agents.findIndex((agent) => agent.client === client);
    if (index >= 0) agents[index] = { client, last_call_ms: now };
    else agents.push({ client, last_call_ms: now });
    agents.sort((left, right) => right.last_call_ms - left.last_call_ms);
    if (agents.length > 8) agents.length = 8;
    bridgeStatus = {
      surface: mode,
      port: bridgeStatus?.port ?? 47194,
      client,
      last_call_ms: now,
      calls: (bridgeStatus?.calls ?? 0) + 1,
      agents,
    };
    bridgeReachable = true;
    paintConnection();
  },
  onFavorite: (item, kept) => {
    if (kept) keptBubbles.add(item.id);
    else keptBubbles.delete(item.id);
    if (peekItem?.id === item.id) paintPeekKeep();
    note(kept ? "act.kept" : "act.unkept", { title: item.title });
    if (kept && item.node_id) {
      selected = item.node_id;
      if (mode === "ambient") boardView = "ideas";
      void refreshBoard();
    }
  },
});

type ConfigClient = "cursor" | "claude-code" | "codex" | "windsurf" | "generic";

function syncSnippetFromUrl(client: string, url: string): string {
  if (client === "codex") {
    return `[mcp_servers.spellcast]\nenabled = true\nurl = ${JSON.stringify(url)}\n`;
  }
  const entry =
    client === "cursor" || client === "claude-code"
      ? { type: "http", url }
      : client === "windsurf"
        ? { serverUrl: url }
        : { url };
  return JSON.stringify({ mcpServers: { spellcast: entry } }, null, 2);
}

function setPreviewText(snippet: string) {
  document.querySelector<HTMLElement>("#agent-snippet")!.textContent = snippet;
  document.querySelector<HTMLElement>("#settings-snippet")!.textContent = snippet;
}

function setPickedClient(client: string) {
  document.querySelectorAll<HTMLButtonElement>("[data-client]").forEach((button) => {
    button.classList.toggle("is-on", button.dataset.client === client);
  });
}

async function previewClient(client: ConfigClient, url = settingsUrl.value.trim()) {
  selectedClient = client;
  const currentUrl = url || `http://127.0.0.1:${bridgeStatus?.port ?? 47194}/mcp`;
  agentUrl.value = currentUrl;
  settingsUrl.value = currentUrl;
  setPickedClient(client);
  setPreviewText(syncSnippetFromUrl(client, currentUrl));

  const copyOnly = client === "generic" || client === "claude-code";
  const agentWrite = document.querySelector<HTMLButtonElement>("#agent-write")!;
  const settingsWrite = document.querySelector<HTMLButtonElement>("#settings-write-file")!;
  const settingsFile = document.querySelector<HTMLElement>("#settings-file")!;
  const agentPath = document.querySelector<HTMLElement>("#agent-path")!;
  const agentSkillPath = document.querySelector<HTMLElement>("#agent-skill-path")!;
  const agentInstallSkill = document.querySelector<HTMLButtonElement>("#agent-install-skill")!;
  const settingsInstallSkill = document.querySelector<HTMLButtonElement>("#settings-install-skill")!;
  const settingsSkill = document.querySelector<HTMLElement>("#settings-skill")!;
  settingsFile.hidden = copyOnly;
  agentWrite.hidden = copyOnly;
  settingsWrite.hidden = copyOnly;
  settingsPath.value = "";
  agentPath.textContent = "";
  settingsSkillPath.value = "";
  agentSkillPath.textContent = "";
  settingsSkill.hidden = client === "generic";
  agentInstallSkill.hidden = client === "generic";
  settingsInstallSkill.hidden = client === "generic";
  document.querySelector<HTMLElement>("#agent-result")!.hidden = false;

  const revision = ++previewRevision;
  try {
    const config = await describeClient(client, currentUrl);
    if (revision !== previewRevision || selectedClient !== client || settingsUrl.value.trim() !== currentUrl) return;
    // Path and note come from the client registry. The snippet always comes from the live input.
    const path = config.path ?? "";
    const skillPath = config.skill_path ?? "";
    settingsPath.value = path;
    agentPath.textContent = path;
    agentPath.hidden = !path;
    settingsSkillPath.value = skillPath;
    agentSkillPath.textContent = skillPath;
    agentSkillPath.hidden = !skillPath;
    settingsSkill.hidden = !skillPath;
    agentInstallSkill.hidden = !skillPath;
    settingsInstallSkill.hidden = !skillPath;
    settingsFile.hidden = copyOnly || !path;
    agentWrite.hidden = copyOnly || !path;
    settingsWrite.hidden = copyOnly || !path;
    document.querySelector<HTMLElement>("#agent-note")!.textContent = config.note;
    document.querySelector<HTMLElement>("#settings-note")!.textContent = config.note;
  } catch (error) {
    const message = error instanceof Error ? error.message : t("error.generic");
    document.querySelector<HTMLElement>("#agent-note")!.textContent = message;
    document.querySelector<HTMLElement>("#settings-note")!.textContent = message;
  }
}

async function installPickedSkill() {
  if (selectedClient === "generic") return;
  const buttons = [
    document.querySelector<HTMLButtonElement>("#agent-install-skill")!,
    document.querySelector<HTMLButtonElement>("#settings-install-skill")!,
  ];
  buttons.forEach((button) => (button.disabled = true));
  try {
    const result = await installClientSkill(selectedClient);
    document.querySelector<HTMLElement>("#agent-note")!.textContent = result.note;
    document.querySelector<HTMLElement>("#settings-note")!.textContent = result.note;
  } catch (error) {
    const message = error instanceof Error ? error.message : t("error.generic");
    document.querySelector<HTMLElement>("#agent-note")!.textContent = message;
    document.querySelector<HTMLElement>("#settings-note")!.textContent = message;
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}

async function writePicked() {
  if (selectedClient === "generic" || selectedClient === "claude-code") return;
  const url = settingsUrl.value.trim();
  const buttons = [
    document.querySelector<HTMLButtonElement>("#agent-write")!,
    document.querySelector<HTMLButtonElement>("#settings-write-file")!,
  ];
  buttons.forEach((button) => (button.disabled = true));
  try {
    const config = await configureClient(selectedClient, url);
    const message = config.note;
    document.querySelector<HTMLElement>("#agent-note")!.textContent = message;
    document.querySelector<HTMLElement>("#settings-note")!.textContent = message;
  } catch (error) {
    const message = error instanceof Error ? error.message : t("error.generic");
    document.querySelector<HTMLElement>("#agent-note")!.textContent = message;
    document.querySelector<HTMLElement>("#settings-note")!.textContent = message;
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}

async function copyUrl(button: HTMLButtonElement) {
  await navigator.clipboard.writeText(settingsUrl.value.trim());
  button.textContent = t("agent.copied");
  window.setTimeout(() => (button.textContent = t("agent.copy")), 1200);
}

function ageText(seconds: number) {
  if (seconds < 60) return t("agent.ago.seconds", { n: Math.max(1, Math.floor(seconds)) });
  return t("agent.ago.minutes", { n: Math.floor(seconds / 60) });
}

function paintConnection() {
  let state = "away";
  let fallback = t("agent.none");
  let agents: { client: string; last_call_ms: number }[] = [];
  if (!bridgeReachable) {
    fallback = t("agent.unreachable");
  } else {
    agents =
      bridgeStatus?.agents && bridgeStatus.agents.length > 0
        ? bridgeStatus.agents
        : bridgeStatus?.client && bridgeStatus.last_call_ms
          ? [{ client: bridgeStatus.client, last_call_ms: bridgeStatus.last_call_ms }]
          : [];
    if (agents.length > 0) {
      const now = Date.now();
      state = agents.some((agent) => (now - agent.last_call_ms) / 1000 <= 45)
        ? "live"
        : "stale";
    } else {
      state = "ready";
    }
  }
  for (const prefix of ["agent", "settings-agent"]) {
    const dot = document.querySelector<HTMLElement>(`#${prefix}-dot`)!;
    const label = document.querySelector<HTMLElement>(`#${prefix}-seen`)!;
    dot.className = `agent-dot ${state}`;
    label.replaceChildren();
    if (!bridgeReachable || agents.length === 0) {
      label.textContent = fallback;
      continue;
    }
    const chips = document.createElement("div");
    chips.className = "agent-chips";
    const now = Date.now();
    let latest = 0;
    for (const agent of agents) {
      const seconds = Math.max(0, (now - agent.last_call_ms) / 1000);
      const chip = document.createElement("span");
      chip.className = `agent-chip ${seconds <= 45 ? "live" : "stale"}`;
      chip.textContent = agent.client;
      chips.append(chip);
      if (agent.last_call_ms > latest) latest = agent.last_call_ms;
    }
    const when = document.createElement("div");
    when.className = "agent-last";
    when.textContent = t("agent.last", {
      ago: ageText(Math.max(0, (now - latest) / 1000)),
    });
    label.append(chips, when);
  }
}

async function refreshStatus() {
  try {
    bridgeStatus = await fetchStatus();
    bridgeReachable = true;
  } catch {
    bridgeReachable = false;
  }
  paintConnection();
  boardTools.paintLabels();
  paintComposerContext();
}

function applyMode() {
  document.body.classList.toggle("mode-ambient", mode === "ambient");
  document.body.classList.toggle("mode-focus", mode === "focus");
}

function selectBoardView(next: "replies" | "ideas") {
  boardView = next;
  awaitingOrigin = null;
  recipient.value = "";
  paint();
}

function receiveBoard(next: BoardSnapshot) {
  if (awaitingOrigin && selected === awaitingOrigin) {
    const reply = next.replies?.find((item) => item.origin_node_id === awaitingOrigin
      && !(board.replies ?? []).some((old) => old.id === item.id && old.revision >= item.revision));
    if (reply) {
      boardView = "replies";
      board = next;
      replyBoard.update(board.replies ?? []);
      replyBoard.select(reply.id);
      awaitingOrigin = null;
      return;
    }
  }
  board = next;
}

async function setMode(next: Surface) {
  mode = next;
  applyMode();
  try {
    localStorage.setItem("spellcast.mode", next);
  } catch {
    /* ignore */
  }
  void setSurface(next).catch(() => undefined);
  if (next === "focus") {
    await shell.clear();
    closePeek();
  } else if (spatialHandle) {
    spatialHandle.destroy();
    spatialHandle = null;
  }
  paint();
}

async function boot() {
  try {
    [board, forms] = await Promise.all([fetchBoard(), fetchForms()]);
    boardView = board.replies?.length ? "replies" : "ideas";
  } catch (err) {
    reasonEl.textContent = err instanceof Error ? err.message : t("error.backend");
    forms = FORMS.map((id) => ({ id, label: formLabel(id), blurb: "" }));
  }
  applyMode();
  void setSurface(mode).catch(() => undefined);
  fillLocaleSelect();
  applyDom();
  fillKindWeight();
  paintForms();
  paint();
  paintActivity();
  void refreshStatus();
  void previewClient(selectedClient as ConfigClient, settingsUrl.value);
  window.setInterval(() => void refreshStatus(), 15_000);
  document.querySelector("#mode-focus")?.addEventListener("click", () => void setMode("focus"));
  document.querySelector("#mode-desktop")?.addEventListener("click", () => void setMode("ambient"));
  document.querySelector("#view-replies")?.addEventListener("click", () => selectBoardView("replies"));
  document.querySelector("#view-ideas")?.addEventListener("click", () => selectBoardView("ideas"));
  onLocale(() => {
    applyDom();
    fillKindWeight();
    paintForms();
    paint();
    paintActivity();
    paintConnection();
  });
  if (!isDesktopShell()) {
    // Browser preview: no Tauri events, so poll the bridge instead.
    window.setInterval(() => void pollPreview(), 2500);
  }
  const chrome = new ResizeObserver(() => {
    const top = document.querySelector<HTMLElement>(".top")!.getBoundingClientRect().height;
    const bottom = document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--board-top", (top + 14) + "px");
    document.documentElement.style.setProperty("--board-bottom", (bottom + 32) + "px");
  });
  chrome.observe(document.querySelector(".top")!);
  chrome.observe(document.querySelector(".composer")!);
  window.addEventListener("beforeunload", () => { chrome.disconnect(); replyBoard.destroy(); }, { once: true });
}

document.querySelectorAll<HTMLButtonElement>("[data-client]").forEach((button) => {
  button.addEventListener("click", () => {
    void previewClient(button.dataset.client as ConfigClient, settingsUrl.value);
  });
});

for (const field of [agentUrl, settingsUrl]) {
  field.addEventListener("blur", () => void previewClient(selectedClient as ConfigClient, field.value));
}

document.querySelector("#agent-write")?.addEventListener("click", () => void writePicked());
document.querySelector("#settings-write-file")?.addEventListener("click", () => void writePicked());
document.querySelector("#agent-install-skill")?.addEventListener("click", () => void installPickedSkill());
document.querySelector("#settings-install-skill")?.addEventListener("click", () => void installPickedSkill());
document.querySelector<HTMLButtonElement>("#agent-copy-url")?.addEventListener("click", (event) => {
  void copyUrl(event.currentTarget as HTMLButtonElement);
});
document.querySelector<HTMLButtonElement>("#settings-copy-url")?.addEventListener("click", (event) => {
  void copyUrl(event.currentTarget as HTMLButtonElement);
});
document.querySelector("#settings-open")?.addEventListener("click", () => {
  settings.hidden = false;
  void previewClient(selectedClient as ConfigClient, agentUrl.value);
});
document.querySelector("#settings-close")?.addEventListener("click", () => (settings.hidden = true));
settings.addEventListener("click", (event) => {
  if (event.target === settings) settings.hidden = true;
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settings.hidden) settings.hidden = true;
});

async function pollPreview() {
  try {
    const [next, ev] = await Promise.all([fetchBoard(), fetchEvents(lastSeq)]);
    const changed = JSON.stringify(next) !== JSON.stringify(board);
    receiveBoard(next);
    for (const e of ev.events) noteEvent(e);
    lastSeq = ev.last_seq;
    if (changed) paint();
  } catch {
    /* backend away */
  }
}

async function refreshBoard() {
  try {
    receiveBoard(await fetchBoard());
    if (selected && !board.nodes.some((n) => n.id === selected)) selected = null;
    paint();
  } catch (err) {
    flash(err);
  }
}

async function onPresent(result: PresentResult) {
  note("act.present", { n: result.nodes.length, form: formLabel(result.form) });
  await refreshBoard();
  if (result.open) {
    if (result.nodes[0]) selected = result.nodes[0].id;
    await setMode("focus");
  }
}

function noteEvent(e: AgentEvent) {
  if (e.kind === "poke") note("act.poke", { title: e.title ?? "" });
  else if (e.kind === "reply") note("act.reply", { text: e.text ?? "" });
  else if (e.kind === "say") note("act.say", { text: e.text ?? "" });
  else if (e.kind === "dismiss") note("act.dismiss", {});
  else if (e.kind === "kept") {
    if (e.bubble_id) keptBubbles.add(e.bubble_id);
    note("act.kept", { title: e.title ?? "" });
  } else if (e.kind === "expired") note("act.expired", {});
  else if (e.kind === "cleared") note("act.cleared", {});
}

function note(key: MessageKey, vars: Record<string, string | number>) {
  activity.unshift({ at: Date.now(), key, vars });
  while (activity.length > 12) activity.pop();
  paintActivity();
}

function paintActivity() {
  activityEmpty.hidden = activity.length > 0;
  activityEl.innerHTML = activity
    .map((a) => `<li><time>${clock(a.at)}</time><span>${escape(t(a.key, a.vars))}</span></li>`)
    .join("");
}

function clock(ms: number) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fillLocaleSelect() {
  const sel = document.querySelector<HTMLSelectElement>("#locale")!;
  sel.innerHTML = LOCALES.map(
    (item) =>
      `<option value="${item.id}" ${item.id === currentLocale() ? "selected" : ""}>${item.native}</option>`,
  ).join("");
  sel.onchange = () => setLocale(sel.value as Locale);
}

function fillKindWeight() {
  insKind.innerHTML = KINDS.map((id) => `<option value="${id}">${kindLabel(id)}</option>`).join("");
  insWeight.innerHTML = WEIGHTS.map((id) => `<option value="${id}">${weightLabel(id)}</option>`).join("");
}

function paintForms() {
  formsNav.innerHTML = forms
    .map(
      (f) =>
        `<button type="button" data-form="${f.id}" class="${f.id === board.form ? "is-on" : ""}" title="${formReason(f.id)}">${formLabel(f.id)}</button>`,
    )
    .join("");
  formsNav.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const form = btn.dataset.form as StageForm;
      try {
        board = await setFormApi(form);
        selected = selected && board.nodes.some((n) => n.id === selected) ? selected : null;
        paint();
      } catch (err) {
        flash(err);
      }
    });
  });
}

function paint() {
  document.body.classList.toggle("view-replies", boardView === "replies");
  topicEl.textContent = board.topic || t("topic.empty");
  reasonEl.textContent = formReason(board.form);
  empty.hidden = board.nodes.length > 0 || mode !== "focus" || boardView === "replies";
  document.querySelector("#empty h1")!.textContent = bt("boardEmpty");
  document.querySelector("#empty > p:last-of-type")!.textContent = bt("boardEmptyBody");
  document.querySelector("#view-replies")!.setAttribute("aria-pressed", String(boardView === "replies"));
  document.querySelector("#view-ideas")!.setAttribute("aria-pressed", String(boardView === "ideas"));
  paintLog();
  paintInspector();
  paintFormsState();
  paintStage();
  paintComposerContext();
}

function paintComposerContext() {
  input.placeholder = boardView === "replies" ? bt("replyPlaceholder") : t("composer.placeholder");
  document.querySelector("#send")!.textContent = boardView === "replies" ? bt("continue") : t("action.say");
  const focus = mode === "focus" && boardView === "replies" ? replyBoard.getSelection() : null;
  const reply = focus ? board.replies?.find((item) => item.id === focus.reply_id) : null;
  const node = !reply && selected ? board.nodes.find((item) => item.id === selected) : null;
  const title = reply?.blocks.find((block) => block.id === focus?.block_id)?.title || reply?.title || node?.title;
  reasonEl.textContent = title ? bt("about", { title }) : bt("noTarget");
  const source = reply?.source_id || node?.source_id;
  const previous = recipient.value;
  recipient.replaceChildren();
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = bt("chooseTask"); recipient.append(blank);
  for (const item of bridgeStatus?.sources ?? []) {
    const option = document.createElement("option");
    option.value = item.id; option.textContent = item.label; recipient.append(option);
  }
  if ([...recipient.options].some((option) => option.value === previous)) recipient.value = previous;
  recipient.hidden = Boolean(source) || !(bridgeStatus?.sources?.length);
  document.querySelector<HTMLElement>("#recipient-label")!.hidden = recipient.hidden;
}

function paintFormsState() {
  formsNav.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.form === board.form);
  });
}

function paintLog() {
  logEl.innerHTML = board.messages
    .slice(-8)
    .map((m) => `<li class="${m.role}">${escape(m.content)}</li>`)
    .join("");
  logEl.scrollTop = logEl.scrollHeight;
}

function paintInspector() {
  if (boardView === "replies") { inspector.hidden = true; return; }
  const node = board.nodes.find((n) => n.id === selected);
  inspector.hidden = !node;
  if (!node) {
    inspectorId = null;
    return;
  }
  const editing = inspector.contains(document.activeElement);
  if (editing && inspectorId === node.id) return;
  inspectorId = node.id;
  insTitle.value = node.title;
  insBody.value = node.body;
  insKind.value = node.kind;
  insWeight.value = node.weight;
  document.querySelector("#ask-btn")!.textContent = bt("expand");
}

function paintStage() {
  replyHost.hidden = mode !== "focus" || boardView !== "replies";
  if (mode !== "focus") {
    spatial.hidden = true;
    plane.hidden = true;
    return;
  }
  if (boardView === "replies") {
    spatial.hidden = true; plane.hidden = true;
    if (spatialHandle) { spatialHandle.destroy(); spatialHandle = null; }
    replyBoard.update(board.replies ?? []);
    return;
  }
  const isSpatial = board.form === "spatial";
  spatial.hidden = !isSpatial;
  plane.hidden = isSpatial;

  if (isSpatial) {
    if (!spatialHandle) {
      spatialHandle = mountSpatial(spatial, board, selected, onSelect);
    } else {
      spatialHandle.update(board, selected);
    }
    return;
  }

  if (spatialHandle) {
    spatialHandle.destroy();
    spatialHandle = null;
  }
  plane.replaceChildren();
  if (board.form === "timeline") renderTimeline(plane, board, selected, onSelect);
  else if (board.form === "stack") renderStack(plane, board, selected, onSelect);
  else {
    renderConstellation(plane, board, selected, {
      onSelect,
      onMove: (id, x, z) => void moveFragment(id, x, z),
      onCreateAt: (x, z) => void addFragment({ x, z }),
    });
  }
}

function onSelect(id: string | null) {
  if (selected !== id) recipient.value = "";
  selected = id;
  paintComposerContext();
  paintInspector();
  if (board.form === "spatial" && spatialHandle) {
    spatialHandle.update(board, selected);
    spatialHandle.focus(id);
  } else {
    paintStage();
  }
}

talk.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || sending) return;
  if (await tell(text, null, selected)) input.value = "";
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    talk.requestSubmit();
  }
});

/** Words for the agent. Nothing is generated here; the agent reads them on its next tool call. */
async function tell(text: string, bubbleId: string | null, nodeId: string | null): Promise<boolean> {
  let succeeded = false;
  sending = true;
  document.body.classList.add("busy");
  try {
    const target = !bubbleId && mode === "focus" && boardView === "replies" ? replyBoard.getSelection() : null;
    if (!bubbleId && boardView === "replies" && !target) {
      throw new Error(bt("noTarget"));
    }
    const reply = target ? board.replies?.find((item) => item.id === target.reply_id) : null;
    const source = reply?.source_id
      || (bubbleId && peekItem?.id === bubbleId ? peekItem.source_id : null)
      || board.nodes.find((item) => item.id === nodeId)?.source_id
      || recipient.value || null;
    const sent = await say(text, bubbleId, target ? reply?.origin_node_id : nodeId, {
      source_id: source,
      reply_id: target?.reply_id,
      block_id: target?.block_id,
    });
    succeeded = true;
    if (!bubbleId && nodeId && boardView === "ideas") awaitingOrigin = nodeId;
    note(bubbleId ? "act.reply" : "act.say", { text });
    reasonEl.textContent = sent.source_id ? bt("sent") : bt("savedUnassigned");
    board = await fetchBoard();
    paintLog();
    void boardTools.refreshFeedback();
  } catch (err) {
    flash(err);
  } finally {
    sending = false;
    document.body.classList.remove("busy");
  }
  return succeeded;
}

async function addFragment(pos?: { x?: number; z?: number }) {
  boardView = "ideas";
  try {
    const node = await createNode({
      title: t("fragment.newTitle"),
      body: t("fragment.newBody"),
      kind: "idea",
      weight: "note",
      x: pos?.x ?? 0,
      y: 0,
      z: pos?.z ?? 0,
    });
    board = await fetchBoard();
    selected = node.id;
    paint();
    insTitle.focus();
    insTitle.select();
  } catch (err) {
    flash(err);
  }
}

async function moveFragment(id: string, x: number, z: number) {
  const node = board.nodes.find((n) => n.id === id);
  if (node) {
    node.x = x;
    node.z = z;
  }
  try {
    await patchNode(id, { x, z });
  } catch (err) {
    flash(err);
  }
}

async function saveInspector() {
  if (!selected) return;
  const node = board.nodes.find((n) => n.id === selected);
  if (!node) return;
  const title = insTitle.value.trim() || node.title;
  const body = insBody.value;
  const kind = insKind.value as NodeKind;
  const weight = insWeight.value as FragmentWeight;
  node.title = title;
  node.body = body;
  node.kind = kind;
  node.weight = weight;
  try {
    await patchNode(selected, { title, body, kind, weight });
    paintStage();
  } catch (err) {
    flash(err);
  }
}

document.querySelector("#add-btn")!.addEventListener("click", () => void addFragment());
document.querySelector("#empty-add")?.addEventListener("click", () => void addFragment());

insTitle.addEventListener("change", () => void saveInspector());
insBody.addEventListener("change", () => void saveInspector());
insKind.addEventListener("change", () => void saveInspector());
insWeight.addEventListener("change", () => void saveInspector());

document.querySelector("#delete-btn")!.addEventListener("click", async () => {
  if (!selected) return;
  try {
    board = await deleteNode(selected);
    selected = null;
    paint();
  } catch (err) {
    flash(err);
  }
});

document.querySelector("#ask-btn")!.addEventListener("click", () => {
  const node = board.nodes.find((n) => n.id === selected);
  if (!node) return;
  if (sending) return;
  void tell(bt("expandText"), null, node.id);
});

document.querySelector("#clear-btn")!.addEventListener("click", async () => {
  try {
    board = await resetBoard();
    selected = null;
    paint();
  } catch (err) {
    flash(err);
  }
});

window.addEventListener("keydown", (event) => {
  if (document.querySelector(".board-dialog[open]")) return;
  if (boardView === "replies" && mode === "focus") return;
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement;
  if (event.key === "n" && !typing && !event.metaKey && !event.ctrlKey && mode === "focus") {
    event.preventDefault();
    void addFragment();
  }
  if ((event.key === "Delete" || event.key === "Backspace") && !typing && selected) {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>("#delete-btn")?.click();
  }
  if (event.key === "Escape") {
    if (!peek.hidden) {
      void dismissPeek();
      return;
    }
    selected = null;
    paintInspector();
    paintStage();
  }
});

function handlePoke(item: ThrownBubble) {
  note("act.poke", { title: item.title });
  peekItem = item;
  if (item.on_poke === "focus") {
    if (item.node_id) selected = item.node_id;
    void setMode("focus");
    return;
  }
  if (item.on_poke === "pin") {
    closePeek();
    return;
  }
  openPeek(item, item.on_poke === "reply");
}

function openPeek(item: ThrownBubble, replyFirst: boolean) {
  peekItem = item;
  peek.hidden = false;
  peekTitle.textContent = item.title;
  peekBody.textContent = item.body;
  peekNote.value = "";
  paintPeekKeep();
  if (replyFirst) peekNote.focus();
}

const peekKeep = document.querySelector<HTMLButtonElement>("#peek-keep")!;
const keptBubbles = new Set<string>();

function paintPeekKeep() {
  const kept = Boolean(peekItem && keptBubbles.has(peekItem.id));
  peekKeep.classList.toggle("is-kept", kept);
  peekKeep.setAttribute("aria-pressed", String(kept));
  peekKeep.setAttribute("aria-label", t(kept ? "peek.unkeep" : "peek.keep"));
}

peekKeep.addEventListener("click", async () => {
  const item = peekItem;
  if (!item || peekKeep.disabled) return;
  const next = !keptBubbles.has(item.id);
  if (next) keptBubbles.add(item.id);
  else keptBubbles.delete(item.id);
  paintPeekKeep();
  peekKeep.disabled = true;
  try {
    if (next) {
      const { node } = await keepBubble(item);
      note("act.kept", { title: node.title });
      selected = node.id;
    } else {
      const result = await unkeepBubble(item);
      note("act.unkept", { title: item.title });
      if (result.removed && selected === result.node_id) selected = null;
    }
    await refreshBoard();
  } catch (err) {
    if (next) keptBubbles.delete(item.id);
    else keptBubbles.add(item.id);
    paintPeekKeep();
    flash(err);
  } finally {
    peekKeep.disabled = false;
  }
});

function closePeek() {
  peek.hidden = true;
  peekItem = null;
}

async function dismissPeek() {
  const item = peekItem;
  closePeek();
  if (item) {
    note("act.dismiss", {});
    await dismissBubble(item.id).catch(() => undefined);
  }
}

document.querySelector("#peek-reply")?.addEventListener("click", async () => {
  const item = peekItem;
  const text = peekNote.value.trim();
  if (!item || !text || sending) return;
  if (await tell(text, item.id, item.node_id ?? null)) closePeek();
});

document.querySelector("#peek-focus")?.addEventListener("click", () => {
  if (peekItem?.node_id) selected = peekItem.node_id;
  closePeek();
  void setMode("focus");
});

document.querySelector("#peek-dismiss")?.addEventListener("click", () => void dismissPeek());

function flash(err: unknown) {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : t("error.generic");
  reasonEl.textContent = msg;
  const notice = document.querySelector<HTMLElement>("#app-notice")!;
  notice.textContent = msg; notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 12_000);
}

function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

boot();
