import "./styles.css";
import "./board-workspace.css";
import {
  createNode,
  actOnCanvasBlock,
  checkTaskTarget,

  deleteNode,
  deleteCanvasItem,
  restoreCanvasItem,
  completeSetupInstall,
  completeSetupStatus,
  dismissBubble,
  fetchBoard,
  fetchEvents,
  fetchForms,
  fetchStatus,

  keepBubble,
  patchNode,
  resetBoard,
  say,
  setForm as setFormApi,
  setSurface,
  setObserverEnabled,
  fetchObserverStatus,
  unkeepBubble,
  patchBoardReply,
  actOnBoardReply,
  patchCanvas,
  applyCanvasBatch,
  resolveCanvasProposal,
} from "./api";
import { mountCanvas, type CanvasSelection } from "./canvas";
import { CanvasRecipient, originalTask } from "./canvas-recipient";
import type { DeliveryReceipt } from "./types";
import { createCanvasNav } from "./canvas-nav";
import { resolveNavObjectId, type ContentNavTarget } from "./content-organization";
import "./canvas-studio.css";
import { ct } from "./i18n/canvas";
import { replyDrafts, draftKey, contentKey, type DraftRecord } from "./reply-drafts";
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
  CodexBinding,
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
import { createSetupController } from "./complete-setup-ui";

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
const settings = document.querySelector<HTMLDialogElement>("#settings")!;
const settingsUrl = document.querySelector<HTMLInputElement>("#settings-mcp-url")!;
const replyHost = document.querySelector<HTMLElement>("#reply-stage")!;
const recipient = document.querySelector<HTMLSelectElement>("#recipient")!;
const recipientNotice = document.createElement("p"); recipientNotice.className = "composer-recipient-status"; recipientNotice.id = "recipient-status"; recipientNotice.setAttribute("role", "status"); recipientNotice.hidden = true;
document.querySelector(".composer-context")!.after(recipientNotice);
const recipientWorkspace = document.querySelector<HTMLSelectElement>("#recipient-workspace")!;
let recipientBlocked = true;
const recipientControl = new CanvasRecipient(recipient, recipientWorkspace, recipientNotice, checkTaskTarget, blocked => { recipientBlocked = blocked; document.querySelector<HTMLButtonElement>("#send")!.disabled = blocked || sending || (boardView !== "replies" && !input.value.trim()); }, {
  root: document.querySelector<HTMLElement>("#recipient-route")!, summary: document.querySelector<HTMLElement>("#recipient-summary")!,
  toggle: document.querySelector<HTMLButtonElement>("#recipient-change")!, picker: document.querySelector<HTMLElement>("#recipient-picker")!,
});
let codexBindings: CodexBinding[] = [];
let deliveries: DeliveryReceipt[] = [];
const deliveryNotice = document.createElement("p"); deliveryNotice.className = "composer-delivery-status";
deliveryNotice.setAttribute("role", "status"); deliveryNotice.hidden = true; recipientNotice.after(deliveryNotice);

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
const canvasNav = createCanvasNav();
let forms: FormInfo[] = [];
let spatialHandle: ReturnType<typeof mountSpatial> | null = null;
let inspectorId: string | null = null;
let mode: Surface = initialMode();
let peekItem: ThrownBubble | null = null;
let sending = false;
let bridgeStatus: BridgeStatus | null = null;
let observerKnown: {
  enabled: boolean;
  paused: boolean;
  allowed?: boolean;
  reason?: string;
  policy_revision: number;
} | null = null;
let observerSaveInflight = false;
let bridgeReachable = true;
let selectedClient = "codex";
let manualConnectionUrl: string | null = null;
const setupController = createSetupController({
  t,
  status: completeSetupStatus,
  install: completeSetupInstall,
  getClient: () => selectedClient,
  getUrl: () => settingsUrl.value.trim(),
  setLocked: (locked) => setSetupLocked(locked),
});
let urlDebounce = 0;
let boardView: "replies" | "ideas" = "replies";
let awaitingOrigin: string | null = null;
let noticeTimer = 0;
let canvasTargetKey = "";
let canvasRouteKey = "";
let composerDraft: DraftRecord | null = null;

function mergeBoardReply(reply: BoardReply) {
  const replies = [...(board.replies ?? [])];
  const index = replies.findIndex((item) => item.id === reply.id);
  if (index >= 0) replies[index] = reply;
  else replies.push(reply);
  board.replies = replies;
}

const replyBoard = mountCanvas(replyHost, {
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
  onNodePatch: async (id, request) => {
    if (request.block.type !== "text") throw new Error("A thought must contain text.");
    const node = await patchNode(id, { object_id: request.object_id, title: request.block.title, body: request.block.text, expected_revision: request.expected_revision });
    board.nodes = board.nodes.map(item => item.id === id ? node : item);
    void boardTools.refreshFeedback(); return node;
  },
  onNodeAsk: async (id, text) => {
    const source = board.nodes.find(item => item.id === id)?.source_id || recipient.value;
    if (!source) throw new Error(ct("noTask"));
    const object_id = board.canvas?.objects.find(object => object.content.type === "node" && object.content.id === id)?.id;
    await say(text, null, id, { object_id, source_id: source }); void boardTools.refreshFeedback();
  },
  onBlockAction: async (id, request, expected_revision) => {
    const object = board.canvas?.objects.find(object => object.id === id);
    const result = await actOnCanvasBlock(id, { expected_revision, block_id: request.block_id, action: request.action,
      request_id: request.request_id, option_id: request.option_id, text: request.text,
      source_id: object?.source_id || recipient.value || object?.origin?.source_id || null });
    board = result.board; void boardTools.refreshFeedback(); return board;
  },
  onCreate: () => createNode({ title: ct("newNote"), body: "", kind: "idea", weight: "note" }),
  onDelete: async (itemId, expectedRevision) => { board = await deleteCanvasItem(itemId, expectedRevision); return board; },
  onRestore: async (itemId, expectedRevision) => { board = await restoreCanvasItem(itemId, expectedRevision); return board; },
  onLayout: patchCanvas,
  onBatch: async request => {
    const outcome = await applyCanvasBatch(request);
    board = outcome.board;
    if (outcome.result.status !== "applied") throw new Error(outcome.result.targets.find(target => target.status !== "ready")?.message || t("error.generic"));
    return board;
  },
  onProposal: async (id, action, current) => {
    const outcome = await resolveCanvasProposal(id, action, current);
    board = outcome.board;
    if (outcome.result.status === "proposed") throw new Error(outcome.result.targets.find(target => target.status !== "ready")?.message || t("error.generic"));
    void boardTools.refreshFeedback();
    return board;
  },
  onReload: async () => { board = await fetchBoard(); return board; },
  onRestoreComposer: (record) => { composerDraft = record; input.value = record.text ?? ""; recipientControl.resetChoice(record.target_source_id); paintComposerContext(); input.focus(); },
  onSelect: (selection) => {
    selected = selection?.node_id ?? null;
    const key = JSON.stringify(selection);
    const routeKey = selectionRouteKey(selection);
    if (key !== canvasTargetKey) {
      const sameRoute = routeKey === canvasRouteKey, retainedText = input.value;
      const previousKey = composerDraft ? draftKey(composerDraft) : null, previousDraft = previousKey ? replyDrafts.get(previousKey) : undefined;
      if (!sameRoute) { recipient.value = ""; recipientControl.resetChoice(); }
      const reply = selection?.reply_id ? board.replies?.find(item => item.id === selection.reply_id) : null;
      const block = reply?.blocks.find(item => item.id === selection?.block_id);
      const node = selection?.node_id ? board.nodes.find(item => item.id === selection.node_id) : null;
      composerDraft = reply && block ? { source_id: reply.source_id, reply_id: reply.id, reply_title: reply.title, block_id: block.id, block_type: block.type, kind: "ask", expected_revision: reply.revision, updated_at: 0, text: "" }
        : node ? { source_id: `node:${node.id}`, reply_id: `node:${node.id}`, reply_title: node.title, block_id: "text", block_type: "text", kind: "ask", expected_revision: node.revision ?? 0, updated_at: 0, text: "" } : null;
      if (composerDraft) { composerDraft.channel = "composer"; composerDraft.object_id = selection?.object_id; }
      if (selection?.anchors?.length) {
        const first = board.canvas?.objects.find(object => object.id === selection.anchors![0].object_id);
        composerDraft = { object_id: selection.anchors.length === 1 ? first?.id : undefined,
          source_id: first?.source_id || "canvas", reply_id: `canvas:${first?.id ?? selection.anchors[0].object_id}`,
          reply_title: first && "title" in first.content ? first.content.title : reply?.title || node?.title || "Canvas",
          block_id: "canvas", block_type: "text", kind: "ask", channel: "composer", expected_revision: selection.anchors[0].content_revision,
          anchors: structuredClone(selection.anchors), target_source_id: recipient.value || preferredCanvasSource(selection) || undefined, updated_at: 0, text: "" };
      }
      const recovered = !sameRoute && composerDraft ? replyDrafts.getComposer(composerDraft) : undefined;
      input.value = sameRoute ? retainedText : recovered?.text ?? "";
      if (recovered) { composerDraft = recovered; recipientControl.resetChoice(recovered.target_source_id); }
      if (sameRoute && composerDraft && retainedText.trim()) {
        const saved = replyDrafts.put({ ...composerDraft, text: retainedText, updated_at: Date.now() });
        if (!saved) flash(ct("draftUnsafe"));
        else if (previousKey && previousDraft && previousKey !== draftKey(composerDraft)) replyDrafts.remove(previousKey, previousDraft.updated_at);
      }
    }
    canvasTargetKey = key; canvasRouteKey = routeKey; paintComposerContext();
  },
  onHumanSelect: () => canvasNav.discardIntent(),
  onFocusNotice: message => flash(message),
  onError: (message) => flash(message),
});

function selectionRouteKey(selection: CanvasSelection | null): string {
  if (!selection) return "";
  return contentKey({
    object_ids: selection.object_ids,
    composition_id: selection.composition_id,
    object_id: selection.object_id,
    reply_id: selection.reply_id,
    node_id: selection.node_id,
    block_id: selection.block_id,
    anchors: selection.anchors?.map(({ content_revision: _revision, artifact, inputs: _inputs, compositions, ...anchor }) => ({
      ...anchor,
      ...(compositions?.length ? { compositions: compositions.map(group => group.id) } : {}),
      ...(artifact ? { artifact: { bundle_id: artifact.bundle_id, selection: artifact.selection } } : {}),
    })),
  });
}

function canvasHasNode(nodeId: string) {
  const object = board.canvas?.objects.find(
    (item) => item.content.type === "node" && item.content.id === nodeId,
  );
  if (!object) return false;
  const placement = board.canvas?.items.find((item) => item.item_id === object.id);
  return Boolean(placement && !placement.removed);
}

function applyCanvasLocate(nodeId: string | null) {
  if (!nodeId) {
    selected = null;
    replyBoard.selectNode(null);
    flash(ct("noTarget"));
    return;
  }
  const present = board.nodes.some((item) => item.id === nodeId) && canvasHasNode(nodeId);
  if (!present) {
    if (selected === nodeId) selected = null;
    replyBoard.selectNode(nodeId);
    flash(ct("noTarget"));
    return;
  }
  selected = nodeId;
  replyBoard.selectNode(nodeId);
}

async function openCanvasToNode(nodeId: string | null | undefined) {
  const intent = canvasNav.begin(nodeId ?? null);
  boardView = "replies";
  awaitingOrigin = null;
  recipient.value = "";
  closePeek();
  await refreshBoard();
  if (!canvasNav.isCurrent(intent)) return;
  await setMode("focus");
  if (!canvasNav.isCurrent(intent)) return;
  applyCanvasLocate(intent.nodeId);
}

function onFavoriteChanged(item: ThrownBubble, kept: boolean) {
  if (kept) keptBubbles.add(item.id);
  else keptBubbles.delete(item.id);
  if (peekItem?.id === item.id) paintPeekKeep();
  note(kept ? "act.kept" : "act.unkept", { title: item.title });
  if (kept && item.node_id) {
    canvasNav.remember(item.node_id);
    void refreshBoard();
    return;
  }
  canvasNav.forget(item.node_id);
  if (item.node_id && selected === item.node_id) selected = null;
  void refreshBoard();
}
async function navigateContent(target: ContentNavTarget) {
  if (target.missing) {
    flash(bt("responseMissing"));
    return;
  }
  if (target.nodeId && !target.objectId && !target.replyId && !target.objectIds?.length) {
    void openCanvasToNode(target.nodeId);
    return;
  }
  const intent = canvasNav.begin(target.nodeId ?? null);
  boardView = "replies";
  awaitingOrigin = null;
  const locate = () => {
    if (!canvasNav.isCurrent(intent)) return false;
    const objectId = resolveNavObjectId(target, board);
    if (objectId) {
      replyBoard.selectObject(objectId);
      return true;
    }
    if (target.objectId || target.objectIds?.length) {
      if (target.replyId && board.replies?.some((item) => item.id === target.replyId)) {
        replyBoard.select(target.replyId);
        return true;
      }
      return false;
    }
    if (target.replyId) {
      if (!board.replies?.some((item) => item.id === target.replyId)) return false;
      replyBoard.select(target.replyId);
      return true;
    }
    if (target.nodeId) {
      applyCanvasLocate(target.nodeId);
      return canvasHasNode(target.nodeId);
    }
    return false;
  };
  await setMode("focus");
  if (!canvasNav.isCurrent(intent)) return;
  if (locate()) return;
  await refreshBoard();
  if (!canvasNav.isCurrent(intent)) return;
  if (locate()) return;
  flash(bt("responseMissing"));
}

const boardTools = mountBoardTools({
  getStatus: () => bridgeStatus,
  getBoard: () => board,
  getScope: () => replyBoard.getScope(),
  onStatus: (status) => { bridgeStatus = status; paintConnection(); },
  onFeedbackState: (state) => { codexBindings = state.bindings; deliveries = state.deliveries; replyBoard.setOverviewMeta({ bindings: state.bindings }); paintComposerContext(); },
  onError: (error) => flash(error),
  onNavigate: (target) => { void navigateContent(target); },
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
  onBoard: () => { void refreshBoard(); void boardTools.refreshFeedback(); },
  onFocus: () => {
    const pending = canvasNav.take();
    if (pending) void openCanvasToNode(pending.nodeId);
    else void setMode("focus");
  },
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
  onFavorite: (item, kept) => onFavoriteChanged(item, kept),
});

type ConfigClient = "cursor" | "claude-code" | "codex" | "windsurf" | "generic";

function setupButtons() {
  return [
    document.querySelector<HTMLButtonElement>("#agent-complete-setup")!,
    document.querySelector<HTMLButtonElement>("#settings-complete-setup")!,
  ];
}

function setSetupLocked(locked: boolean) {
  agentUrl.readOnly = locked;
  settingsUrl.readOnly = locked;
  document.querySelectorAll<HTMLButtonElement>("[data-client]").forEach((button) => {
    button.disabled = locked || button.dataset.client !== "codex";
  });
  const supported = selectedClient === "codex";
  setupButtons().forEach((button) => {
    button.disabled = locked || !supported;
  });
}

function setPickedClient(client: string) {
  document.querySelectorAll<HTMLButtonElement>("[data-client]").forEach((button) => {
    button.classList.toggle("is-on", button.dataset.client === client);
    button.setAttribute("aria-pressed", String(button.dataset.client === client));
  });
}

async function previewClient(client: ConfigClient) {
  if (client !== "codex" || setupController.session.state().inflight) return;
  const currentUrl = manualConnectionUrl ?? `http://127.0.0.1:${bridgeStatus?.port ?? 47194}/mcp`;
  selectedClient = client;
  agentUrl.value = currentUrl;
  settingsUrl.value = currentUrl;
  setPickedClient(client);
  const supported = client === "codex";
  setupButtons().forEach((button) => {
    button.disabled = !supported;
  });
  document.querySelector<HTMLElement>("#agent-result")!.hidden = false;
  await setupController.preview(client, currentUrl);
}

function schedulePreviewFromUrl(url: string) {
  if (setupController.session.state().inflight) return;
  manualConnectionUrl = url.trim() || null;
  window.clearTimeout(urlDebounce);
  urlDebounce = window.setTimeout(() => {
    void previewClient(selectedClient as ConfigClient);
  }, 400);
}

async function installCompleteSetup() {
  if (selectedClient !== "codex") return;
  await setupController.install(selectedClient, settingsUrl.value.trim());
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

function applyObserverSlice(
  slice: {
    enabled: boolean;
    paused: boolean;
    allowed?: boolean;
    reason?: string;
    policy_revision: number;
  },
  _source: "save" | "health" | "refetch",
) {
  const rev = Number(slice.policy_revision) || 0;
  if (observerKnown && rev < observerKnown.policy_revision) {
    if (bridgeStatus) {
      bridgeStatus.observer_enabled = observerKnown.enabled;
      bridgeStatus.observer_policy_revision = observerKnown.policy_revision;
      bridgeStatus.observer_allowed = observerKnown.allowed;
      bridgeStatus.observer_reason = observerKnown.reason;
      bridgeStatus.paused = observerKnown.paused;
    }
    paintObserver();
    return false;
  }
  observerKnown = { ...slice, policy_revision: rev };
  if (!bridgeStatus) {
    bridgeStatus = {
      surface: mode,
      port: 47194,
      last_call_ms: 0,
      calls: 0,
      paused: slice.paused,
      observer_enabled: slice.enabled,
      observer_policy_revision: rev,
      observer_allowed: slice.allowed,
      observer_reason: slice.reason,
    };
  } else {
    bridgeStatus.observer_enabled = slice.enabled;
    bridgeStatus.observer_policy_revision = rev;
    bridgeStatus.observer_allowed = slice.allowed;
    bridgeStatus.observer_reason = slice.reason;
    bridgeStatus.paused = slice.paused;
  }
  paintObserver();
  return true;
}

async function refreshStatus() {
  try {
    const health = await fetchStatus();
    bridgeReachable = true;
    bridgeStatus = health;
    applyObserverSlice({
      enabled: Boolean(health.observer_enabled),
      paused: Boolean(health.paused),
      allowed: health.observer_allowed,
      reason: health.observer_reason,
      policy_revision: health.observer_policy_revision ?? 0,
    }, "health");
  } catch {
    bridgeReachable = false;
  }
  paintConnection();
  paintObserver();
  boardTools.paintLabels();
  paintComposerContext();
}

function applyMode() {
  document.body.classList.toggle("mode-ambient", mode === "ambient");
  document.body.classList.toggle("mode-focus", mode === "focus");
}

function selectBoardView(next: "replies" | "ideas") {
  if (next !== "replies") canvasNav.invalidateActive();
  boardView = next;
  awaitingOrigin = null;
  recipient.value = "";
  paint();
}

function receiveBoard(next: BoardSnapshot) {
  replyDrafts.bindObjects(next.canvas?.objects ?? [], next.replies ?? []);
  if (awaitingOrigin && selected === awaitingOrigin) {
    const reply = next.replies?.find((item) => item.origin_node_id === awaitingOrigin
      && !(board.replies ?? []).some((old) => old.id === item.id && old.revision >= item.revision));
    if (reply) {
      boardView = "replies";
      board = next;
      replyBoard.update(board);
      replyBoard.select(reply.id);
      awaitingOrigin = null;
      return;
    }
  }
  board = next;
}

async function setMode(next: Surface) {
  if (next === "ambient") canvasNav.invalidateActive();
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
    boardView = "replies";
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
  paintObserver();
  await refreshStatus();
  void previewClient(selectedClient as ConfigClient);
  window.setInterval(() => void refreshStatus(), 15_000);
  document.querySelector("#mode-focus")?.addEventListener("click", () => {
    const pending = canvasNav.take();
    if (pending) void openCanvasToNode(pending.nodeId);
    else void setMode("focus");
  });
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
    paintObserver();
    const lastSetup = setupController.lastReport();
    if (lastSetup) setupController.paint(lastSetup);
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
  const topMore = document.querySelector<HTMLDetailsElement>(".top-more");
  window.addEventListener("resize", syncTopMore);
  window.matchMedia("(max-width: 1100px)").addEventListener("change", syncTopMore);
  topMore?.addEventListener("toggle", () => {
    if (!topMore.classList.contains("is-compact") && !topMore.open) topMore.open = true;
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !topMore?.classList.contains("is-compact") || !topMore.open) return;
    event.preventDefault();
    topMore.open = false;
    topMore.querySelector("summary")?.focus();
  });
  for (const id of ["settings-open", "memory-open", "feedback-open"]) {
    document.querySelector("#" + id)?.addEventListener("click", () => {
      if (topMore?.classList.contains("is-compact")) topMore.open = false;
    });
  }
  syncTopMore();
  window.addEventListener("beforeunload", () => { chrome.disconnect(); replyBoard.destroy(); }, { once: true });
}

document.querySelectorAll<HTMLButtonElement>("[data-client]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled || button.dataset.client !== "codex" || setupController.session.state().inflight) return;
    void previewClient(button.dataset.client as ConfigClient);
  });
});

for (const field of [agentUrl, settingsUrl]) {
  field.addEventListener("input", () => schedulePreviewFromUrl(field.value));
  field.addEventListener("blur", () => {
    window.clearTimeout(urlDebounce);
    if (setupController.session.state().inflight) return;
    void previewClient(selectedClient as ConfigClient);
  });
}

document.querySelector("#agent-complete-setup")?.addEventListener("click", () => void installCompleteSetup());
document.querySelector("#settings-complete-setup")?.addEventListener("click", () => void installCompleteSetup());
document.querySelector<HTMLButtonElement>("#agent-copy-url")?.addEventListener("click", (event) => {
  void copyUrl(event.currentTarget as HTMLButtonElement);
});
document.querySelector<HTMLButtonElement>("#settings-copy-url")?.addEventListener("click", (event) => {
  void copyUrl(event.currentTarget as HTMLButtonElement);
});
let settingsTrigger: HTMLElement | null = null;
function settingsTriggerVisible(node: HTMLElement | null | undefined) {
  if (!node) return false;
  const box = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.display !== "none";
}
function restoreSettingsTrigger() {
  const preferred = settingsTrigger;
  settingsTrigger = null;
  const openBtn = document.querySelector<HTMLElement>("#settings-open");
  const more = document.querySelector<HTMLDetailsElement>(".top-more");
  const summary = more?.querySelector("summary");
  if (settingsTriggerVisible(preferred)) { preferred!.focus(); return; }
  if (settingsTriggerVisible(openBtn)) { openBtn!.focus(); return; }
  if (more?.classList.contains("is-compact")) summary?.focus();
}
function closeSettings() {
  if (settings.open) settings.close();
  settings.hidden = true;
}
function observerToggles() {
  return [...document.querySelectorAll<HTMLInputElement>("[data-observer-toggle]")];
}

function hideObserverErrors() {
  for (const node of document.querySelectorAll<HTMLElement>("#agent-observer-error, #settings-observer-error")) {
    node.hidden = true;
    node.textContent = "";
  }
}

function showObserverError(trigger: HTMLInputElement, message: string) {
  const error = trigger.closest(".agent-observer, .settings-observer")?.querySelector<HTMLElement>(".has-warning");
  if (!error) return;
  error.hidden = false;
  error.textContent = message;
}

function syncObserverControl(box: HTMLInputElement) {
  box.setAttribute("aria-checked", box.checked ? "true" : "false");
}

function paintObserver() {
  const enabled = Boolean(observerKnown?.enabled ?? bridgeStatus?.observer_enabled);
  for (const box of observerToggles()) {
    if (!observerSaveInflight) box.checked = enabled;
    syncObserverControl(box);
  }
}

async function saveObserverEnabled(event: Event) {
  const trigger = event.currentTarget as HTMLInputElement;
  if (observerSaveInflight) {
    paintObserver();
    return;
  }
  observerSaveInflight = true;
  const next = trigger.checked;
  hideObserverErrors();
  for (const box of observerToggles()) {
    box.checked = next;
    box.disabled = true;
    syncObserverControl(box);
  }
  try {
    const status = await setObserverEnabled(next);
    applyObserverSlice({
      enabled: status.enabled,
      paused: status.paused,
      allowed: status.allowed,
      reason: status.reason,
      policy_revision: status.policy_revision,
    }, "save");
  } catch (err) {
    showObserverError(trigger, err instanceof Error ? err.message : t("observer.error"));
    try {
      const real = await fetchObserverStatus();
      applyObserverSlice({
        enabled: real.enabled,
        paused: real.paused,
        allowed: real.allowed,
        reason: real.reason,
        policy_revision: real.policy_revision,
      }, "refetch");
    } catch {
      /* keep observerKnown */
    }
  } finally {
    observerSaveInflight = false;
    for (const box of observerToggles()) box.disabled = false;
    paintObserver();
  }
}

function openSettings() {
  const active = document.activeElement as HTMLElement | null;
  settingsTrigger = active?.closest("button, summary") ?? active;
  settings.hidden = false;
  if (!settings.open) settings.showModal();
  paintObserver();
  void previewClient(selectedClient as ConfigClient);
}
for (const box of observerToggles()) {
  box.addEventListener("change", event => void saveObserverEnabled(event));
}
document.querySelector("#settings-open")?.addEventListener("click", () => openSettings());
document.querySelector("#settings-close")?.addEventListener("click", () => closeSettings());
settings.addEventListener("click", (event) => {
  if (event.target === settings) closeSettings();
});
settings.addEventListener("close", () => {
  settings.hidden = true;
  restoreSettingsTrigger();
});
function settingsTabStops() {
  return [...settings.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]")]
    .filter(node => {
      if (node.tabIndex < 0) return false;
      if ("disabled" in node && Boolean((node as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled)) return false;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return node.getClientRects().length > 0;
    });
}
if (settings.tabIndex < 0) settings.tabIndex = -1;
settings.addEventListener("keydown", event => {
  if (!settings.open || event.key !== "Tab") return;
  const stops = settingsTabStops();
  if (!stops.length) {
    event.preventDefault();
    settings.focus();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const index = active ? stops.indexOf(active) : -1;
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    stops[stops.length - 1].focus();
  } else if (!event.shiftKey && (index === -1 || index === stops.length - 1)) {
    event.preventDefault();
    stops[0].focus();
  }
}, true);

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

function syncTopMore() {
  const more = document.querySelector<HTMLDetailsElement>(".top-more");
  if (!more) return;
  const compact = document.body.classList.contains("mode-focus")
    && document.body.classList.contains("view-replies")
    && window.matchMedia("(max-width: 1100px)").matches;
  const wasCompact = more.classList.contains("is-compact");
  more.classList.toggle("is-compact", compact);
  if (!compact) more.open = true;
  else if (!wasCompact) more.open = false;
}

function paint() {
  document.body.classList.toggle("view-replies", boardView === "replies");
  syncTopMore();
  topicEl.textContent = board.topic || t("topic.empty");
  reasonEl.textContent = formReason(board.form);
  empty.hidden = board.nodes.length > 0 || mode !== "focus" || boardView === "replies";
  document.querySelector("#empty h1")!.textContent = bt("boardEmpty");
  document.querySelector("#empty > p:last-of-type")!.textContent = bt("boardEmptyBody");
  document.querySelector("#view-replies")!.setAttribute("aria-pressed", String(boardView === "replies"));
  document.querySelector("#view-ideas")!.setAttribute("aria-pressed", String(boardView === "ideas"));
  document.querySelector("#view-replies")!.textContent = ct("canvas");
  document.querySelector("#view-ideas")!.textContent = ct("layouts");
  paintLog();
  paintInspector();
  paintFormsState();
  paintStage();
  paintComposerContext();
}

function preferredCanvasSource(selection: CanvasSelection | null): string | null {
  return originalTask(board, selection, codexBindings, bridgeStatus?.sources)?.source_id || null;
}

function paintComposerContext() {
  input.placeholder = boardView === "replies" ? bt("replyPlaceholder") : t("composer.placeholder");
  document.querySelector("#send")!.textContent = boardView === "replies" ? bt("continue") : t("action.say");
  document.querySelector<HTMLElement>("#recipient-label")!.textContent = ct("recipientTaskLabel");
  document.querySelector<HTMLElement>("#recipient-workspace-label")!.textContent = ct("recipientWorkspaceLabel");
  const focus = mode === "focus" && boardView === "replies" ? replyBoard.getSelection() : null;
  const reply = focus ? board.replies?.find((item) => item.id === focus.reply_id) : null;
  const node = !reply && selected ? board.nodes.find((item) => item.id === selected) : null;
  const nativeTitles = focus?.anchors?.map(anchor => {
    const object = board.canvas?.objects.find(item => item.id === anchor.object_id);
    if (!object) return "";
    const content = object.content;
    if (content.type === "block") return content.block.title;
    if ("title" in content) return content.title;
    if (content.type === "reply") {
      const reply = board.replies?.find(reply => reply.id === content.id);
      const block = reply?.blocks.find(block => block.id === anchor.block_id);
      return block ? block.title?.trim() || ct("untitledBlock") : reply?.title;
    }
    return board.nodes.find(node => node.id === content.id)?.title;
  }).filter(Boolean).join(" + ");
  const idea = focus?.composition_id ? board.canvas?.compositions?.find(group => group.id === focus.composition_id) : undefined;
  const title = idea?.title || nativeTitles || reply?.blocks.find((block) => block.id === focus?.block_id)?.title || reply?.title || node?.title;
  reasonEl.textContent = title ? bt("about", { title }) : bt("noTarget");
  const nodeObject = !focus && boardView !== "replies" && node ? board.canvas?.objects.find(object => object.content.type === "node" && object.content.id === node.id) : undefined;
  const routingSelection = focus || (nodeObject ? { object_id: nodeObject.id, node_id: node!.id } : null);
  recipientControl.update(board, routingSelection, codexBindings, bridgeStatus?.sources || []);
  input.disabled = !routingSelection;
  paintDeliveryStatus(focus);
}

function paintDeliveryStatus(focus: CanvasSelection | null) {
  const anchors = focus?.anchors || [];
  const receipt = focus ? deliveries.filter(receipt => receipt.desktop && receipt.event.source_id === recipient.value &&
    (receipt.event.anchors?.some(sent => anchors.some(current => current.object_id === sent.object_id && (!current.block_id || current.block_id === sent.block_id)))
      || receipt.event.object_id === focus.object_id && (!focus.block_id || !receipt.event.block_id || receipt.event.block_id === focus.block_id)))
    .sort((a, b) => b.event.seq - a.event.seq)[0] : undefined;
  deliveryNotice.hidden = !receipt;
  if (!receipt) return;
  const label = receipt.phase === "submitted" && receipt.desktop?.host_status === "active" ? ct("desktopWorking") : ct(`phase.${receipt.phase}`);
  deliveryNotice.textContent = [label, receipt.error || receipt.desktop?.attention].filter(Boolean).join(" · ");
  deliveryNotice.dataset.phase = receipt.phase;
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
    replyDrafts.bindObjects(board.canvas?.objects ?? [], board.replies ?? []);
    replyBoard.update(board);
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
  if (selected !== id) { recipient.value = ""; recipientControl.resetChoice(); }
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
  const text = input.value.trim() || (mode === "focus" && boardView === "replies" && replyBoard.getSelection() ? bt("sendCurrent") : "");
  if (!text || sending) return;
  const draft = composerDraft ? replyDrafts.get(draftKey(composerDraft)) : null;
  const targetKey = canvasTargetKey;
  if (await tell(text, null, selected)) {
    if (draft) replyDrafts.remove(draftKey(draft), draft.updated_at);
    if (canvasTargetKey === targetKey && input.value.trim() === text) input.value = "";
  }
});

input.addEventListener("input", () => {
  document.querySelector<HTMLButtonElement>("#send")!.disabled = recipientBlocked || sending || (boardView !== "replies" && !input.value.trim());
  if (!composerDraft) return;
  if (!input.value.trim()) { replyDrafts.remove(draftKey(composerDraft)); return; }
  if (!replyDrafts.put({ ...composerDraft, text: input.value, updated_at: Date.now() })) flash(ct("draftUnsafe"));
});

recipient.addEventListener("recipient-change", () => {
  paintDeliveryStatus(replyBoard.getSelection());
  if (!composerDraft?.anchors?.length) return;
  const previousKey = draftKey(composerDraft), previous = replyDrafts.get(previousKey);
  composerDraft.target_source_id = recipient.value || undefined;
  if (input.value.trim()) {
    if (!replyDrafts.put({ ...composerDraft, text: input.value, updated_at: Date.now() })) flash(ct("draftUnsafe"));
    // Retarget the current draft instead of leaving a second copy under its old
    // recipient. A newer draft from another window must remain untouched.
    else if (previous && previousKey !== draftKey(composerDraft) && !replyDrafts.remove(previousKey, previous.updated_at)) flash(ct("draftUnsafe"));
  }
});
recipientWorkspace.addEventListener("change", () => paintDeliveryStatus(replyBoard.getSelection()));
window.addEventListener("focus", () => recipientControl.refresh());

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    talk.requestSubmit();
  }
});

/** Save the request before its original task is notified. */
async function tell(text: string, bubbleId: string | null, nodeId: string | null): Promise<boolean> {
  let succeeded = false;
  sending = true;
  document.body.classList.add("busy");
  try {
    const canvasSend = !bubbleId && mode === "focus" && boardView === "replies";
    if (canvasSend) {
      const startMode = mode;
      const startView = boardView;
      const startTarget = replyBoard.getSelection();
      if (!startTarget) throw new Error(bt("noTarget"));
      const startRoute = selectionRouteKey(startTarget);
      const frozenRecipient = startTarget.anchors?.length
        ? recipient.value || preferredCanvasSource(startTarget) || ""
        : recipient.value;
      const startSource = startTarget.anchors?.length
        ? frozenRecipient || null
        : board.replies?.find((item) => item.id === startTarget.reply_id)?.source_id
          || board.nodes.find((item) => item.id === startTarget.node_id)?.source_id
          || frozenRecipient || null;
      if (!startSource) throw new Error(ct("noTask"));
      const checkedTarget = await recipientControl.verify();
      if (checkedTarget.source_id !== startSource) throw new Error(ct("sendCancelled"));
      await replyBoard.prepareFeedback();
      const stillCanvas = mode === startMode && boardView === startView;
      const latest = stillCanvas ? replyBoard.getSelection() : null;
      if (!stillCanvas || recipientControl.switching || recipient.value !== frozenRecipient || selectionRouteKey(latest) !== startRoute) {
        flash(ct("sendCancelled"));
        return false;
      }
      const target = latest!;
      const reply = board.replies?.find((item) => item.id === target.reply_id) ?? null;
      const anchored = Boolean(target.anchors?.length);
      const sent = await say(text, null, anchored ? null : reply ? reply.origin_node_id : target.node_id ?? null, anchored ? {
        source_id: startSource, anchors: target.anchors, target_thread_id: checkedTarget.thread_id,
      } : {
        source_id: startSource,
        target_thread_id: checkedTarget.thread_id,
        object_id: target.object_id,
        reply_id: target.reply_id,
        block_id: target.block_id,
      });
      succeeded = true;
      if (!reply && target.node_id) awaitingOrigin = target.node_id;
      note("act.say", { text });
      reasonEl.textContent = sent.source_id ? bt("sent") : bt("savedUnassigned");
      board = await fetchBoard();
      paintLog();
      void boardTools.refreshFeedback();
    } else {
      if (!bubbleId && boardView === "replies") {
        throw new Error(bt("noTarget"));
      }
      const target = !bubbleId && mode === "focus" && boardView === "replies" ? replyBoard.getSelection() : null;
      const reply = target ? board.replies?.find((item) => item.id === target.reply_id) : null;
      nodeId = target?.node_id ?? nodeId;
      const anchored = Boolean(target?.anchors?.length);
      const source = anchored ? recipient.value || null : reply?.source_id
        || (bubbleId && peekItem?.id === bubbleId ? peekItem.source_id : null)
        || board.nodes.find((item) => item.id === nodeId)?.source_id
        || recipient.value || null;
      if (!source) throw new Error(ct("noTask"));
      const sent = await say(text, bubbleId, anchored ? null : reply ? reply.origin_node_id : nodeId, anchored ? {
        source_id: source, anchors: target!.anchors,
      } : {
        source_id: source,
        object_id: target?.object_id,
        reply_id: target?.reply_id,
        block_id: target?.block_id,
      });
      succeeded = true;
      if (!bubbleId && nodeId && !reply) awaitingOrigin = nodeId;
      note(bubbleId ? "act.reply" : "act.say", { text });
      reasonEl.textContent = sent.source_id ? bt("sent") : bt("savedUnassigned");
      board = await fetchBoard();
      paintLog();
      void boardTools.refreshFeedback();
    }
  } catch (err) {
    flash(err);
  } finally {
    sending = false;
    document.body.classList.remove("busy");
    paintComposerContext();
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
  const kind = insKind.value as NodeKind;
  const weight = insWeight.value as FragmentWeight;
  try {
    const updated = await patchNode(selected, { kind, weight });
    board.nodes = board.nodes.map(item => item.id === updated.id ? updated : item);
    paintStage();
  } catch (err) {
    flash(err);
  }
}

document.querySelector("#add-btn")!.addEventListener("click", () => void addFragment());
document.querySelector("#empty-add")?.addEventListener("click", () => void addFragment());

insTitle.readOnly = true;
insBody.readOnly = true;
const editOnCanvas = document.createElement("button");
editOnCanvas.type = "button"; editOnCanvas.className = "ghost"; editOnCanvas.textContent = ct("edit") + " · Canvas";
editOnCanvas.addEventListener("click", () => {
  const id = selected;
  canvasNav.discardIntent();
  boardView = "replies";
  paint();
  if (id) replyBoard.selectNode(id);
});
insBody.after(editOnCanvas);
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
  if (document.querySelector("dialog[open]")) return;
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

async function handlePoke(item: ThrownBubble) {
  note("act.poke", { title: item.title });
  peekItem = item;
  if (item.on_poke === "focus") {
    await openCanvasToNode(item.node_id ?? null);
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
      if (peekItem?.id === item.id) peekItem.node_id = node.id;
      canvasNav.remember(node.id);
    } else {
      const result = await unkeepBubble(item);
      note("act.unkept", { title: item.title });
      const gone = result.node_id ?? item.node_id;
      canvasNav.forget(gone);
      if (peekItem?.id === item.id) peekItem.node_id = null;
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
  const id = peekItem?.node_id ?? null;
  closePeek();
  void openCanvasToNode(id);
});
/** Browser-only fixture shim. Not Tauri listen(); production desktop uses createShell. */
window.addEventListener("spellcast-favorite-changed", (event) => {
  const detail = (event as CustomEvent<{ item?: ThrownBubble; kept?: boolean }>).detail;
  if (detail?.item) onFavoriteChanged(detail.item, Boolean(detail.kept));
});
window.addEventListener("spellcast-poke", (event) => {
  const item = (event as CustomEvent<ThrownBubble>).detail;
  if (item) void handlePoke(item);
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
