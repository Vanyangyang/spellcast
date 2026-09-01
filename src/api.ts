import { currentLocale } from "./i18n";
import { t } from "./i18n";
import type {
  BoardNode,
  BoardSnapshot,
  ChatMessage,
  ChatResponse,
  FormInfo,
  FragmentWeight,
  NodeKind,
  StageForm,
  Surface,
} from "./types";

const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:47194";

function inTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

async function read<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `${t("error.request")} ${res.status}`);
  }
  return data as T;
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

export async function sendChat(
  messages: ChatMessage[],
  focus?: string | null,
  surface: Surface = "focus",
  screenCount = 1,
): Promise<ChatResponse> {
  const req = {
    messages,
    provider: "preview",
    model: null,
    api_key: null,
    base_url: null,
    focus_node_id: focus || null,
    locale: currentLocale(),
    surface,
    screen_count: screenCount,
  };
  if (inTauri()) return invoke("chat", { req });
  return read(
    await fetch(`${API}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }),
  );
}

export async function setForm(form: StageForm): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("set_form", { req: { form } });
  return read(
    await fetch(`${API}/api/board/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ form }),
    }),
  );
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
  return read(
    await fetch(`${API}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }),
  );
}

export async function patchNode(
  id: string,
  patch: Partial<Pick<BoardNode, "title" | "body" | "kind" | "weight" | "x" | "y" | "z">>,
): Promise<BoardNode> {
  if (inTauri()) return invoke("patch_node", { id, patch });
  return read(
    await fetch(`${API}/api/nodes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteNode(id: string): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("remove_node", { id });
  return read(await fetch(`${API}/api/nodes/${id}`, { method: "DELETE" }));
}

export async function importTranscript(transcript: string): Promise<BoardSnapshot> {
  if (inTauri()) return invoke("import_transcript", { req: { transcript } });
  return read(
    await fetch(`${API}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    }),
  );
}
