import { t } from "./i18n";
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
  StageForm,
  Surface,
  ThrownBubble,
  MemoryItem,
} from "./types";
import type { BoardReply, ReplyPatchRequest, ReplyActionInput } from "./reply-types";

export const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:47194";

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `${t("error.request")} ${res.status}`);
  }
  return data as T;
}

function post(path: string, body: unknown, method = "POST") {
  return fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function fetchBoard(): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("get_board");
  return read(await fetch(`${API}/api/board`));
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
  patch: Partial<Pick<BoardNode, "title" | "body" | "kind" | "weight" | "x" | "y" | "z">>,
): Promise<BoardNode> {
  if (inTauri()) return invoke("patch_node", { id, patch });
  return read(await post(`/api/nodes/${id}`, patch, "PATCH"));
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
  target?: { source_id?: string | null; reply_id?: string | null; block_id?: string | null },
): Promise<AgentEvent> {
  const req = { text, bubble_id: bubbleId ?? null, node_id: nodeId ?? null, ...target };
  if (inTauri()) return invoke("say", { req });
  return read(await post("/api/say", req));
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

export async function patchBoardReply(req: ReplyPatchRequest): Promise<BoardReply> {
  return read(await post("/api/replies/patch", req));
}

export async function actOnBoardReply(req: ReplyActionInput): Promise<BoardReply> {
  const result = await read<{ reply: BoardReply; event: AgentEvent }>(await post("/api/replies/action", req));
  return result.reply;
}

export async function fetchPendingFeedback(): Promise<AgentEvent[]> {
  const result = await read<{ pending: AgentEvent[] }>(await fetch(API + "/api/feedback"));
  return result.pending;
}

export async function fetchMemories(query = ""): Promise<MemoryItem[]> {
  const result = await read<{ memories: MemoryItem[] }>(await fetch(API + "/api/memories?query=" + encodeURIComponent(query)));
  return result.memories;
}

export async function saveMemory(title: string, text: string): Promise<MemoryItem> {
  const result = await read<{ memory: MemoryItem }>(await post("/api/memories", { title, text }));
  return result.memory;
}

export async function forgetMemory(id: string): Promise<void> {
  await read(await fetch(API + "/api/memories/" + encodeURIComponent(id), { method: "DELETE" }));
}

export async function setBubblesPaused(paused: boolean): Promise<BridgeStatus> {
  return read(await post("/api/paused", { paused }));
}
