import { t } from "./i18n";
import { contentKey } from "./reply-drafts";
import type {
  AgentEvent,
  BoardNode,
  BoardSnapshot,
  BridgeStatus,
  ClientConfig,
  FormInfo,
  FragmentWeight,
  NodeKind,
  SkillInstall,
  SetupReport,
  StageForm,
  Surface,
  ThrownBubble,
  MemoryItem,
  ObserverStatus,
} from "./types";
import type { BoardReply, ReplyPatchRequest, ReplyActionInput } from "./reply-types";
import type { CanvasLayout, CanvasPlacement, CanvasBatchRequest, CanvasBatchResult, CanvasRead, CanvasAnchor, FeedbackState, DeliveryReceipt, CodexBinding } from "./types";

export const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:47194";
let nativeBase: Promise<string> | null = null;

export async function apiBase(): Promise<string> {
  if (!inTauri() || import.meta.env.VITE_API_URL) return API;
  nativeBase ??= invoke<BridgeStatus>("bridge_status").then(status => `http://127.0.0.1:${status.port}`).catch(error => { nativeBase = null; throw error; });
  return nativeBase;
}

export function inTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : String(error));
  }
}

async function read<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => {
    if (res.ok) throw new Error(`${t("error.request")} — invalid response`);
    return {};
  });
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `${t("error.request")} ${res.status}`);
  }
  return data as T;
}

async function post(path: string, body: unknown, method = "POST") {
  return fetch(`${await apiBase()}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Keep an uncertain attempt's ID across retries/reload; the server owns replay protection. */
async function requestOnce<T, R extends { request_id?: string }>(operation: string, request: R, send: (request: R) => Promise<T>): Promise<T> {
  if (request.request_id) return send(request);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contentKey([await apiBase(), operation, request])));
  const key = "spellcast.request." + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  let id: string;
  try {
    id = localStorage.getItem(key) || crypto.randomUUID();
    localStorage.setItem(key, id);
  } catch { throw new Error("Cannot preserve the request ID locally. Nothing was sent; keep your input and retry after local storage is available."); }
  const result = await send({ ...request, request_id: id });
  try { localStorage.removeItem(key); } catch { /* Reusing a committed ID remains safe. */ }
  return result;
}

export async function fetchBoard(): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("get_board");
  return read(await fetch(`${API}/api/board`));
}

export async function actOnCanvasBlock(id: string, request: {
  expected_revision: number; block_id: string; action: "ask" | "select";
  request_id?: string; source_id?: string | null; option_id?: string; text?: string;
}): Promise<{ board: BoardSnapshot; event: AgentEvent }> {
  return requestOnce(`canvas-block:${id}`, request, value => post(`/api/canvas/blocks/${encodeURIComponent(id)}/action`, value).then(read<{ board: BoardSnapshot; event: AgentEvent }>));
}

export async function fetchForms(): Promise<FormInfo[]> {
  if (inTauri()) {
    const data = await invoke<{ forms: FormInfo[] }>("list_forms");
    return data.forms;
  }
  const data = await read<{ forms: FormInfo[] }>(await fetch(`${API}/api/forms`));
  return data.forms;
}

export async function setSurface(surface: Surface): Promise<BridgeStatus> {
  if (inTauri()) return invoke("set_surface", { surface });
  return read(await post("/api/surface", { surface }));
}

export async function setForm(form: StageForm): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("set_form", { req: { form } });
  return read(await post("/api/board/form", { form }));
}

export async function resetBoard(): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("reset_board");
  return read(await fetch(`${API}/api/board`, { method: "DELETE" }));
}

export async function createNode(draft: {
  title?: string;
  body?: string;
  kind?: NodeKind;
  weight?: FragmentWeight;
  x?: number;
  y?: number;
  z?: number;
}): Promise<BoardNode> {
  if (inTauri()) return invoke("add_node", { draft });
  return read(await post("/api/nodes", draft));
}

export async function patchNode(
  id: string,
  patch: Partial<Pick<BoardNode, "title" | "body" | "kind" | "weight" | "x" | "y" | "z">> & { object_id?: string; expected_revision?: number; request_id?: string },
): Promise<BoardNode> {
  const send = async (request: typeof patch): Promise<BoardNode> => {
    if (inTauri()) return invoke("patch_node", { id, patch: request });
    return read(await post(`/api/nodes/${id}`, request, "PATCH"));
  };
  return patch.title === undefined && patch.body === undefined ? send(patch) : requestOnce(`node:${id}`, patch, send);
}

export async function deleteNode(id: string): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("remove_node", { id });
  return read(await fetch(`${API}/api/nodes/${id}`, { method: "DELETE" }));
}

/** Words for the agent: from a popped bubble (bubble_id) or the board's composer. */
export async function say(
  text: string,
  bubbleId?: string | null,
  nodeId?: string | null,
  target?: { object_id?: string | null; source_id?: string | null; target_thread_id?: string | null; reply_id?: string | null; block_id?: string | null; anchors?: CanvasAnchor[] },
): Promise<AgentEvent> {
  const req = { text, bubble_id: bubbleId ?? null, node_id: nodeId ?? null, ...target };
  return requestOnce<AgentEvent, typeof req & { request_id?: string }>("say", req, async request => {
    if (inTauri()) return invoke("say", { req: request });
    return read(await post("/api/say", request));
  });
}

export async function dismissBubble(bubbleId: string): Promise<AgentEvent> {
  if (inTauri()) return invoke("dismiss_bubble", { bubbleId });
  return read(await post("/api/dismiss", { bubble_id: bubbleId }));
}

/** The user starred a bubble: its words become a fragment on the board. */
export async function keepBubble(bubble: ThrownBubble): Promise<{ node: BoardNode; event: AgentEvent }> {
  if (inTauri()) return invoke("keep_bubble", { bubble });
  return read(await post("/api/keep", bubble));
}

export async function fetchEvents(since: number): Promise<{ events: AgentEvent[]; last_seq: number }> {
  return read(await fetch(`${API}/api/events?since=${since}`));
}

export async function unkeepBubble(
  bubble: ThrownBubble,
): Promise<{ removed: boolean; node_id?: string | null; event: AgentEvent }> {
  if (inTauri()) return invoke("unkeep_bubble", { bubble });
  return read(await post("/api/unkeep", bubble));
}

export async function fetchStatus(): Promise<BridgeStatus> {
  if (inTauri()) return invoke("bridge_status");
  return read(await fetch(`${API}/api/health`));
}

export async function describeClient(client: string, url: string): Promise<ClientConfig> {
  if (inTauri()) return invoke("mcp_config", { client, url });
  const snippets: Record<string, string> = {
    cursor: JSON.stringify({ mcpServers: { spellcast: { type: "http", url } } }, null, 2),
    codex: `[mcp_servers.spellcast]\nenabled = true\nurl = ${JSON.stringify(url)}\n`,
    windsurf: JSON.stringify({ mcpServers: { spellcast: { serverUrl: url } } }, null, 2),
    "claude-code": JSON.stringify({ mcpServers: { spellcast: { type: "http", url } } }, null, 2),
    generic: JSON.stringify({ mcpServers: { spellcast: { url } } }, null, 2),
  };
  return {
    client,
    label: client,
    path: null,
    snippet: snippets[client] ?? snippets.generic,
    written: false,
    backup: null,
    skill_path: null,
    note: t("settings.previewNote"),
  };
}

export async function configureClient(client: string, url: string): Promise<ClientConfig> {
  if (!inTauri()) throw new Error(t("settings.desktopOnly"));
  return invoke("configure_client", { client, url });
}

export async function installClientSkill(client: string): Promise<SkillInstall> {
  if (!inTauri()) throw new Error(t("settings.desktopOnly"));
  return invoke("install_client_skill", { client });
}

export async function completeSetupStatus(client: string, url: string): Promise<SetupReport> {
  if (!inTauri()) {
    const desktop = client === "codex";
    return {
      client,
      kind: desktop ? "not_installed" : "unsupported",
      complete_supported: desktop,
      installed: false,
      note: desktop ? t("setup.desktopPreview") : t("setup.unsupported"),
      done: [],
      not_done: desktop ? [] : [t("setup.unsupported")],
      conflicts: [],
    };
  }
  return invoke("complete_setup_status", { client, url });
}

export async function completeSetupInstall(client: string, url: string): Promise<SetupReport> {
  if (!inTauri()) throw new Error(t("settings.desktopOnly"));
  return invoke("complete_setup_install", { client, url });
}

export async function deleteCanvasItem(item_id: string, expected_revision: number): Promise<BoardSnapshot> {
  return read(await post("/api/canvas", { item_id, expected_revision }, "DELETE"));
}

export async function restoreCanvasItem(item_id: string, expected_revision: number): Promise<BoardSnapshot> {
  return read(await post("/api/canvas/restore", { item_id, expected_revision }));
}

export async function patchBoardReply(req: ReplyPatchRequest): Promise<BoardReply> {
  const send = async (request: ReplyPatchRequest) => read<BoardReply>(await post("/api/replies/patch", request));
  return req.layout_only ? send(req) : requestOnce("patch", req, send);
}

export async function actOnBoardReply(req: ReplyActionInput): Promise<BoardReply> {
  const result = await requestOnce("action", req, async request => read<{ reply: BoardReply; event: AgentEvent }>(await post("/api/replies/action", request)));
  return result.reply;
}

export async function fetchArtifact(id: string): Promise<import("./reply-types").ArtifactBundle> {
  return read(await fetch(`${await apiBase()}/api/artifacts/${encodeURIComponent(id)}`));
}

export async function fetchArtifactHistory(id: string): Promise<import("./reply-types").ArtifactBundle[]> {
  return read(await fetch(`${await apiBase()}/api/artifacts/${encodeURIComponent(id)}/history`));
}

export async function editArtifactFile(req: { object_id?: string; reply_id: string; block_id: string; bundle_id: string; expected_revision: number; name: string; text: string; request_id?: string }): Promise<BoardReply> {
  return requestOnce("artifact-edit", req, async request => read(await post("/api/artifacts/edit", request)));
}

export async function saveArtifactState(req: { object_id?: string; reply_id: string; block_id: string; bundle_id: string; expected_state_revision: number; state: Record<string, unknown> }): Promise<BoardReply> {
  return read(await post("/api/artifacts/state", req));
}

export async function fetchPendingFeedback(): Promise<AgentEvent[]> {
  const result = await fetchFeedbackState();
  return result.pending;
}

export async function fetchFeedbackState(): Promise<FeedbackState> {
  return read(await fetch((await apiBase()) + "/api/feedback"));
}

export async function checkTaskTarget(target: import("./types").TaskTarget): Promise<import("./types").TaskTargetStatus> {
  return read(await post("/api/task-target", { source_id: target.source_id, thread_id: target.thread_id, cwd: target.cwd }));
}

export async function retryFeedback(sequence: number): Promise<DeliveryReceipt> {
  return read(await post(`/api/feedback/${sequence}/retry`, {}));
}

export async function bindCodexTask(source_id: string, thread_id: string, cwd?: string): Promise<CodexBinding> {
  return read(await post("/api/bindings/codex", { source_id, thread_id, cwd }));
}

export async function unbindCodexTask(source_id: string): Promise<void> {
  await read(await fetch(`${await apiBase()}/api/bindings/${encodeURIComponent(source_id)}`, { method: "DELETE" }));
}

export async function patchCanvas(expected_revision: number | undefined, items: CanvasPlacement[]): Promise<CanvasLayout> {
  return read(await post("/api/canvas", { expected_revision, items }));
}

export async function applyCanvasBatch(request: CanvasBatchRequest): Promise<{ result: CanvasBatchResult; board: BoardSnapshot }> {
  return read(await post("/api/canvas/batch", request));
}

export async function resolveCanvasProposal(id: string, action: "apply" | "dismiss", current: CanvasRead[]): Promise<{ result: CanvasBatchResult; board: BoardSnapshot }> {
  return read(await post(`/api/canvas/proposals/${encodeURIComponent(id)}`, { action, current }));
}

export async function fetchMemories(query = ""): Promise<MemoryItem[]> {
  const result = await read<{ memories: MemoryItem[] }>(await fetch((await apiBase()) + "/api/memories?query=" + encodeURIComponent(query)));
  return result.memories;
}

export async function saveMemory(title: string, text: string): Promise<MemoryItem> {
  const result = await read<{ memory: MemoryItem }>(await post("/api/memories", { title, text }));
  return result.memory;
}

export async function forgetMemory(id: string): Promise<void> {
  await read(await fetch((await apiBase()) + "/api/memories/" + encodeURIComponent(id), { method: "DELETE" }));
}

export async function setBubblesPaused(paused: boolean): Promise<BridgeStatus> {
  return read(await post("/api/paused", { paused }));
}

export async function fetchObserverStatus(): Promise<ObserverStatus> {
  return read(await fetch(`${await apiBase()}/api/observer/status`));
}

export async function setObserverEnabled(enabled: boolean): Promise<ObserverStatus> {
  return read(await post("/api/observer/settings", { enabled }));
}
