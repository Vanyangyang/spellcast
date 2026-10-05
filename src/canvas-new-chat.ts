import { currentLocale } from "./i18n";
import { workspaceIdentity } from "./content-origin";
import type { CanvasAnchor } from "./types";
import { inTauri } from "./api";
import { replyDrafts, type DraftRecord } from "./reply-drafts";
import "./canvas-new-chat.css";

export type CodexWorkspace = { path: string; label: string; project_id?: string | null };
type OpenedDraft = { context_path: string; status: "draft_open_requested"; draft_saved?: boolean };
const en = {
  entry: "New conversation…", title: "Start in a workspace", workspace: "Workspace", choose: "Choose a workspace",
  other: "Another local directory…", path: "Absolute directory path", request: "Your request", cancel: "Cancel",
  open: "Open new conversation in Codex", opening: "Opening…", loading: "Loading workspaces…",
  help: "Your request and selected Canvas content will be backed up locally before opening Codex. Review and send there; your input stays in Spellcast.",
  opened: "Requested a new conversation in Codex. Check the workspace and send there. Your Spellcast draft is kept.",
  openedWithBackup: "Requested a new conversation in Codex. The draft could not be saved, but your request and selected content are backed up locally. Review and send in Codex.",
  unavailable: "Use the Spellcast desktop app to open a Codex conversation.",
  required: "Choose a workspace or enter an absolute directory path.",
  noRequest: "Write your request before opening a new conversation.",
};
const zh: Record<keyof typeof en,string> = {
  entry: "新对话…", title: "在工作区开启新对话", workspace: "工作区", choose: "选择工作区",
  other: "其他本机目录…", path: "目录的绝对路径", request: "你的请求", cancel: "取消",
  open: "在 Codex 中新建", opening: "正在打开…", loading: "正在读取工作区…",
  help: "请求和选中的画布内容会先备份到本机，再打开 Codex 供你确认并发送。Spellcast 中的输入会保留。",
  opened: "已请求在 Codex 中打开新对话，请检查工作区并发送。Spellcast 中的草稿已保留。",
  openedWithBackup: "已请求在 Codex 中打开新对话。草稿暂未保存，但请求和所选内容已备份到本机；请到 Codex 检查并发送。",
  unavailable: "请在 Spellcast 桌面版中开启 Codex 新对话。",
  required: "请选择工作区，或填写目录的绝对路径。",
  noRequest: "先写下你希望新对话处理的请求。",
};
export function newChatText(key: keyof typeof en) { return (currentLocale() === "zh-CN" ? zh : en)[key]; }

export async function loadCodexWorkspaces(): Promise<CodexWorkspace[]> {
  if (!inTauri()) throw new Error(newChatText("unavailable"));
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("codex_workspaces");
}
export async function openCanvasNewChat(workspace: CodexWorkspace, text: string, anchors: CanvasAnchor[], draft?: DraftRecord | null): Promise<OpenedDraft> {
  if (!inTauri()) throw new Error(newChatText("unavailable"));
  // The native command durably writes the full request before opening Codex.
  // An unavailable draft cache must not prevent that independent backup.
  const draft_saved = draft ? replyDrafts.put(draft) : undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<OpenedDraft>("open_canvas_new_chat", { req: { workspace, text, anchors } });
  return { ...result, draft_saved };
}

export async function showNewChatDialog(options: {
  text: string; workspaces: CodexWorkspace[]; preferredPath?: string;
  load?: () => Promise<CodexWorkspace[]>;
  open: (workspace: CodexWorkspace) => Promise<OpenedDraft>;
  done: (result: OpenedDraft) => void;
}) {
  if (document.querySelector("#canvas-new-chat")) return;
  const priorFocus = document.activeElement;
  const dialog = document.createElement("dialog"); dialog.id = "canvas-new-chat"; dialog.className = "board-dialog canvas-new-chat";
  dialog.setAttribute("aria-labelledby", "new-chat-title"); dialog.setAttribute("aria-describedby", "new-chat-help");
  const title = document.createElement("h2"); title.id = "new-chat-title"; title.textContent = newChatText("title");
  const help = document.createElement("p"); help.id = "new-chat-help"; help.textContent = newChatText("help");
  const form = document.createElement("form");
  const label = document.createElement("label"), select = document.createElement("select"); select.id = "new-chat-workspace";
  label.htmlFor = select.id; label.textContent = newChatText("workspace");
  const pathLabel = document.createElement("label"), path = document.createElement("input"); path.id = "new-chat-path";
  pathLabel.htmlFor = path.id; pathLabel.textContent = newChatText("path"); path.autocomplete = "off"; path.spellcheck = false;
  const caption = document.createElement("label"), request = document.createElement("textarea"); request.id = "new-chat-request";
  caption.htmlFor = request.id; caption.textContent = newChatText("request"); request.readOnly = true; request.value = options.text;
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.className = "new-chat-status";
  status.textContent = newChatText("loading");
  const actions = document.createElement("div"); actions.className = "new-chat-actions";
  const cancel = document.createElement("button"), submit = document.createElement("button");
  cancel.type = "button"; cancel.textContent = newChatText("cancel"); submit.type = "submit"; submit.className = "primary"; submit.textContent = newChatText("open");
  let busy = false, chosenByUser = false, choices: CodexWorkspace[] = [];
  const close = () => { if (busy) return; dialog.close(); dialog.remove(); if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus(); };
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => event.stopPropagation());
  const togglePath = () => { path.hidden = pathLabel.hidden = select.value !== "other"; submit.disabled = !select.value || busy; };
  const fill = (items: CodexWorkspace[]) => {
    const seen = new Set<string>();
    choices = items.filter(item => {
      const key = workspaceIdentity(item.path);
      if (!item.path || seen.has(key)) return false;
      seen.add(key); return true;
    });
    select.replaceChildren(new Option(newChatText("choose"), ""));
    choices.forEach((item, index) => select.append(new Option(`${item.label} · ${item.path}`, String(index))));
    select.append(new Option(newChatText("other"), "other"));
    const preferred = choices.findIndex(item => workspaceIdentity(item.path) === workspaceIdentity(options.preferredPath || ""));
    if (preferred >= 0) select.value = String(preferred);
    togglePath();
  };
  select.addEventListener("change", () => { chosenByUser = true; togglePath(); });
  form.addEventListener("submit", event => {
    event.preventDefault(); if (busy) return;
    const workspace = select.value === "other" ? { path:path.value.trim(),label:path.value.trim() } : choices[Number(select.value)];
    if (!select.value || !workspace?.path) { status.textContent = newChatText("required"); return; }
    if (!options.text.trim()) { status.textContent = newChatText("noRequest"); return; }
    busy = true; submit.disabled = cancel.disabled = select.disabled = path.disabled = true; submit.textContent = newChatText("opening"); status.textContent = "";
    void options.open(workspace).then(result => { options.done(result); busy = false; close(); }).catch(error => {
      status.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => { busy = false; submit.disabled = cancel.disabled = select.disabled = path.disabled = false; submit.textContent = newChatText("open"); });
  });
  actions.append(cancel, submit); form.append(label, select, pathLabel, path, caption, request, status, actions); dialog.append(title, help, form); document.body.append(dialog);
  fill(options.workspaces); dialog.showModal(); select.focus();
  try {
    const saved = await (options.load || loadCodexWorkspaces)();
    // Loading must not replace a workspace already selected by the user.
    if (dialog.isConnected && !busy && !chosenByUser) {
      fill([...saved, ...options.workspaces]);
    }
    if (dialog.isConnected && !busy) status.textContent = "";
  } catch (error) { if (dialog.isConnected && !busy) status.textContent = error instanceof Error ? error.message : String(error); }
}
