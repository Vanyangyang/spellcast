import type { BoardSnapshot, CanvasObject, CodexBinding, TaskTarget, TaskTargetStatus } from "./types";
import type { CanvasSelection } from "./canvas";
import { ct } from "./i18n/canvas";
import { workspaceIdentity } from "./content-origin";

type Source = { id: string; label: string };
type RecipientView = { root: HTMLElement; summary: HTMLElement; toggle: HTMLButtonElement; picker: HTMLElement };
type Reconnect = (target: TaskTarget & { thread_id: string }) => Promise<CodexBinding>;
const CODEX_SOURCE = /^codex:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;
function objectTarget(object: CanvasObject, board: BoardSnapshot, bindings: CodexBinding[], sources: Source[]): TaskTarget | undefined {
  const content = object.content;
  const note = content.type === "node" ? board.nodes.find(n => n.id === content.id) : undefined;
  const reply = content.type === "reply" ? board.replies?.find(r => r.id === content.id) : undefined;
  const original = reply?.origin_node_id ? board.nodes.find(n => n.id === reply.origin_node_id && n.source_id === reply.source_id) : undefined;
  const captured = note?.captured_context || original?.captured_context;
  const source_id = note?.source_id || reply?.source_id || object.source_id || object.origin?.source_id || captured?.source_id;
  if (!source_id) return;
  const binding = bindings.find(b => b.source_id === source_id);
  const thread_id = captured?.thread_id || object.origin?.thread_id || binding?.thread_id;
  const current = binding && (!thread_id || binding.thread_id === thread_id) ? binding : undefined;
  return { source_id, thread_id, cwd: captured?.cwd || object.origin?.cwd || current?.cwd,
    label: current?.label || object.origin?.label || captured?.goal || reply?.source_label || sources.find(s => s.id === source_id)?.label || source_id };
}

/** Canvas send-back currently needs a bound desktop task. MCP-only hosts stay visible but cannot receive it yet. */
export function canReturnCanvas(sourceId: string | undefined, bindings: CodexBinding[]): boolean {
  return Boolean(sourceId && bindings.some(binding => binding.source_id === sourceId));
}

/** The selected idea owns the destination; referenced components are context, not votes. */
export function originalTask(board: BoardSnapshot, selection: CanvasSelection | null, bindings: CodexBinding[], sources: Source[] = []): TaskTarget | undefined {
  if (!selection) return;
  const objects = board.canvas?.objects || [];
  const selected = objects.filter(o => (selection.object_ids || selection.anchors?.map(a => a.object_id) || [selection.object_id]).includes(o.id));
  const owner = board.canvas?.compositions?.find(group => group.id === selection.composition_id)?.source_id;
  if (owner) {
    const captured = selected.map(o => objectTarget(o, board, bindings, sources)).find(target => target?.source_id === owner);
    if (captured) return captured;
    const binding = bindings.find(b => b.source_id === owner);
    return { source_id: owner, thread_id: binding?.thread_id, cwd: binding?.cwd, label: binding?.label || sources.find(s => s.id === owner)?.label || owner };
  }
  const primary = objects.find(o => o.id === selection.object_id) || selected[0];
  const own = primary && objectTarget(primary, board, bindings, sources);
  if (own) return own;
  const candidates = selected.map(o => objectTarget(o, board, bindings, sources)).filter((t): t is TaskTarget => Boolean(t));
  return new Set(candidates.map(t => t.source_id)).size === 1 ? candidates[0] : undefined;
}

export class CanvasRecipient {
  private board: BoardSnapshot | undefined;
  private selection: CanvasSelection | null = null;
  private bindings: CodexBinding[] = [];
  private sources: Source[] = [];
  private manual: string | null = null;
  private workspaceChoice: string | null = null;
  private editing = false;
  private origin?: TaskTarget;
  private confirmation?: { source: string; signature: string; cancel: () => void };
  private cache = new Map<string, { value?: TaskTargetStatus; pending?: Promise<TaskTargetStatus>; at: number }>();
  private reconnectButton = document.createElement("button");
  private reconnecting = false;
  private reconnectError: string | null = null;
  constructor(private select: HTMLSelectElement, private workspace: HTMLSelectElement, private notice: HTMLElement, private lookup: (target: TaskTarget) => Promise<TaskTargetStatus>, private onState: (blocked: boolean) => void, private view: RecipientView, private reconnect?: Reconnect) {
    this.reconnectButton.type = "button";
    this.reconnectButton.className = "ghost recipient-reconnect";
    this.reconnectButton.hidden = true;
    notice.after(this.reconnectButton);
    this.reconnectButton.addEventListener("click", () => void this.reconnectOriginal());
    view.toggle.addEventListener("click", () => {
      if (!this.selection || this.confirmation) return;
      this.editing = !this.editing; this.workspaceChoice = null; this.paint();
      if (this.editing) this.workspace.focus();
    });
    view.picker.addEventListener("keydown", event => {
      if (event.key !== "Escape" || this.confirmation) return;
      event.preventDefault(); event.stopPropagation();
      this.editing = false; this.workspaceChoice = null; this.paint(); view.toggle.focus();
    });
    workspace.addEventListener("change", () => {
      const chosen = workspace.value;
      this.confirmation?.cancel();
      this.workspaceChoice = chosen;
      this.paint();
    });
    select.addEventListener("change", event => {
      // Draft listeners receive only a committed choice, never an unconfirmed one.
      event.stopImmediatePropagation();
      void this.change(select.value);
    });
  }
  resetChoice(value?: string) { this.confirmation?.cancel(); this.manual = value ?? null; this.workspaceChoice = null; this.editing = false; }
  update(board: BoardSnapshot, selection: CanvasSelection | null, bindings: CodexBinding[], sources: Source[]) {
    if (this.selection?.object_id !== selection?.object_id) this.reconnectError = null;
    this.board = board; this.selection = selection; this.bindings = bindings; this.sources = sources;
    if (!selection) { this.editing = false; this.workspaceChoice = null; }
    this.origin = originalTask(board, selection, bindings, sources); this.paint();
    if (this.confirmation && this.confirmation.signature !== this.choiceSignature(this.confirmation.source)) this.confirmation.cancel();
  }
  target(): TaskTarget | undefined {
    const target = this.committedTarget();
    return target && this.workspaceKey(target) === this.chosenWorkspace() ? target : undefined;
  }
  private committedTarget() { return this.sourceTarget(this.manual ?? this.origin?.source_id); }
  private workspaceKey(target: TaskTarget) { return workspaceIdentity(target.cwd || ""); }
  private chosenWorkspace() { const target = this.committedTarget(); return this.workspaceChoice ?? (target ? this.workspaceKey(target) : ""); }
  private availableTargets() {
    const targets = new Map<string, TaskTarget>();
    if (this.origin) targets.set(this.origin.source_id, this.origin);
    const committed = this.committedTarget();
    if (committed) targets.set(committed.source_id, committed);
    for (const binding of this.bindings) if (!targets.has(binding.source_id) && workspaceIdentity(binding.cwd) !== "unsorted") targets.set(binding.source_id, { ...binding });
    // Prefer the original or explicit source when one task has several sources.
    const seen = new Set<string>();
    return [...targets.values()].filter(target => {
      const key = JSON.stringify([this.workspaceKey(target), target.thread_id || target.source_id]);
      if (seen.has(key)) return false; seen.add(key); return true;
    });
  }
  private sourceTarget(source?: string): TaskTarget | undefined {
    if (!source) return;
    if (source === this.origin?.source_id) {
      const original = this.origin;
      const inferred = CODEX_SOURCE.exec(source)?.[1];
      return original && !original.thread_id && inferred ? { ...original, thread_id: inferred } : original;
    }
    const binding = this.bindings.find(b => b.source_id === source);
    return { source_id: source, thread_id: binding?.thread_id, cwd: binding?.cwd, label: binding?.label || this.sources.find(s => s.id === source)?.label || source };
  }
  private key(target: TaskTarget) { return JSON.stringify([target.source_id, target.thread_id || "", target.cwd || ""]); }
  private choiceSignature(source: string) {
    return JSON.stringify([this.selection, this.origin && this.key(this.origin), this.committedTarget() && this.key(this.committedTarget()!), this.sourceTarget(source) && this.key(this.sourceTarget(source)!)]);
  }
  private async change(source: string) {
    if (!this.editing || !this.selection) return;
    const current = this.committedTarget(), next = this.availableTargets().find(target => target.source_id === source && this.workspaceKey(target) === this.chosenWorkspace());
    if (!next) { this.paint(); return; }
    this.paint();
    if (this.confirmation) return;
    if (source === (current?.source_id || "")) { this.editing = false; this.workspaceChoice = null; this.paint(); return; }
    if (next && (this.origin || current) && next.source_id !== this.origin?.source_id) {
      // Browsing a workspace cannot commit a different recipient.
      this.workspaceChoice = this.workspaceKey(current || this.origin!);
      const signature = this.choiceSignature(source);
      if (!await this.confirmSwitch(this.origin || current!, next, signature)) return;
      if (signature !== this.choiceSignature(source)) return;
    }
    this.manual = source; this.workspaceChoice = this.workspaceKey(next); this.editing = false; this.paint();
    this.select.dispatchEvent(new Event("recipient-change"));
  }
  private confirmSwitch(original: TaskTarget, next: TaskTarget, signature: string): Promise<boolean> {
    return new Promise(resolve => {
      const dialog = document.createElement("dialog"); dialog.className = "board-dialog recipient-confirm";
      dialog.setAttribute("role", "alertdialog"); dialog.setAttribute("aria-labelledby", "recipient-confirm-title"); dialog.setAttribute("aria-describedby", "recipient-confirm-help");
      const title = document.createElement("h2"); title.id = "recipient-confirm-title"; title.textContent = ct("recipientSwitchTitle");
      const help = document.createElement("p"); help.id = "recipient-confirm-help"; help.textContent = ct("recipientSwitchHelp");
      const route = document.createElement("div"); route.className = "recipient-confirm-route";
      for (const [target, label] of [[original, this.status(original)?.status === "deleted" ? ct("originalTaskDeleted") : ct("originalTask")], [next, ct("recipientSwitchTarget")]] as const) {
        const item = document.createElement("section"), caption = document.createElement("small"), name = document.createElement("strong"), detail = document.createElement("small");
        caption.textContent = label; name.textContent = this.status(target)?.label || target.label;
        detail.textContent = [target.cwd, target.thread_id || target.source_id].filter(Boolean).join(" · ");
        item.append(caption, name, detail); route.append(item);
      }
      const actions = document.createElement("div"); actions.className = "recipient-confirm-actions";
      const cancel = document.createElement("button"), confirm = document.createElement("button");
      cancel.type = confirm.type = "button"; cancel.textContent = ct("cancel"); cancel.autofocus = true;
      confirm.textContent = ct("recipientSwitchConfirm"); confirm.className = "primary";
      let settled = false;
      const finish = (accepted: boolean) => {
        if (settled) return; settled = true; this.confirmation = undefined;
        this.editing = false; this.workspaceChoice = null;
        dialog.close(); dialog.remove(); this.paint();
        if (this.selection) this.view.toggle.focus(); resolve(accepted);
      };
      cancel.addEventListener("click", () => finish(false)); confirm.addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
      dialog.addEventListener("close", () => finish(false));
      dialog.addEventListener("keydown", event => event.stopPropagation());
      actions.append(cancel, confirm); dialog.append(title, route, help, actions); document.body.append(dialog);
      this.confirmation = { source: next.source_id, signature, cancel: () => finish(false) }; this.paint();
      try { dialog.showModal(); cancel.focus(); } catch { finish(false); }
    });
  }
  private status(target?: TaskTarget) { return target && this.cache.get(this.key(target))?.value; }
  get switching() { return this.editing || Boolean(this.confirmation); }
  private async check(target: TaskTarget, force = false): Promise<TaskTargetStatus> {
    const key = this.key(target), existing = this.cache.get(key);
    if (existing?.pending) return existing.pending;
    if (!force && existing?.value && Date.now() - existing.at < 30000) return existing.value;
    const entry = { value: existing?.value, at: Date.now(), pending: undefined as Promise<TaskTargetStatus> | undefined };
    this.cache.set(key, entry);
    entry.pending = this.lookup(target).catch((): TaskTargetStatus => ({ source_id: target.source_id, thread_id: target.thread_id, label: target.label, status: "unknown", message: "", checked_at_ms: Date.now() })).then(value => {
      value = { ...value, label: value.label || entry.value?.label || target.label };
      entry.value = value; entry.at = Date.now(); entry.pending = undefined; this.paint(); return value;
    });
    return entry.pending;
  }
  private reconnectThread(target?: TaskTarget): string | undefined {
    if (!target) return;
    const thread = CODEX_SOURCE.exec(target.source_id)?.[1];
    return thread && (!target.thread_id || target.thread_id.toLowerCase() === thread.toLowerCase()) ? thread.toLowerCase() : undefined;
  }
  private async reconnectOriginal() {
    const target = this.target(), thread_id = this.reconnectThread(target);
    if (!target || !thread_id || !this.reconnect || this.reconnecting || this.canReturn(target)) return;
    const key = this.key(target);
    this.reconnecting = true; this.reconnectError = null; this.paint();
    try {
      const checked = await this.check({ ...target, thread_id }, true);
      if (!this.target() || this.key(this.target()!) !== key) return;
      if (checked.status !== "unlinked" && checked.status !== "available") {
        this.reconnectError = ct(`taskTarget.${checked.status}`);
        return;
      }
      const binding = await this.reconnect({ ...target, thread_id });
      this.bindings = [...this.bindings.filter(item => item.source_id !== binding.source_id), binding];
      if (this.board) this.origin = originalTask(this.board, this.selection, this.bindings, this.sources);
      this.cache.clear();
      const current = this.target();
      if (current?.source_id === binding.source_id) void this.check(current, true);
    } catch (error) {
      this.reconnectError = error instanceof Error ? error.message : String(error);
    } finally {
      this.reconnecting = false; this.paint();
    }
  }
  async verify(): Promise<TaskTargetStatus> {
    if (this.switching) throw new Error(ct("recipientSwitchPending"));
    if (!this.selection) throw new Error(ct("noTarget"));
    const target = this.target(); if (!target) throw new Error(ct("noTask"));
    if (!this.canReturn(target)) throw new Error(ct(this.reconnectThread(target) ? "taskTarget.unlinked" : "taskTarget.noReturn"));
    const key = this.key(target), status = await this.check(target, true);
    if (this.switching) throw new Error(ct("recipientSwitchPending"));
    if (!this.target() || this.key(this.target()!) !== key) throw new Error(ct("sendCancelled"));
    if (status.status !== "available") throw new Error(ct(`taskTarget.${status.status}`));
    return status;
  }
  refresh() { const target = this.target(); if (target && this.canReturn(target)) void this.check(target, true); }
  private paint() {
    if (!this.board) return;
    const committed = this.committedTarget(), committedStatus = this.status(committed);
    const original = committed?.source_id === this.origin?.source_id;
    const returnable = this.canReturn(committed);
    const name = committedStatus?.label || committed?.label || ct("noOriginalTask");
    const label = committedStatus?.status === "deleted" ? `${ct(original ? "originalTaskDeleted" : "taskDeleted")} · ${name}` : `${name}${committed && original ? ` · ${ct("originalTask")}` : ""}`;
    this.view.root.hidden = !this.selection;
    this.view.summary.textContent = ct("recipientSummary", { task: label });
    this.view.summary.title = committed?.cwd || "";
    this.view.summary.classList.toggle("is-unavailable", Boolean(this.selection && committed && !returnable));
    this.view.toggle.textContent = this.editing ? ct("recipientCancelChange") : committed ? ct("recipientChange") : ct("recipientChooseTask");
    this.view.toggle.setAttribute("aria-expanded", String(this.editing));
    this.view.toggle.disabled = Boolean(this.confirmation);
    this.view.picker.hidden = !this.selection || !this.editing;
    this.select.hidden = false; this.workspace.hidden = false; this.notice.hidden = true;
    const options = this.availableTargets(), chosen = this.chosenWorkspace();
    const workspaces = new Map(options.map(target => [this.workspaceKey(target), target.cwd || ""]));
    this.workspace.replaceChildren();
    const firstWorkspace = document.createElement("option"); firstWorkspace.value = ""; firstWorkspace.textContent = ct("recipientChooseWorkspace"); this.workspace.append(firstWorkspace);
    for (const [key, cwd] of workspaces) {
      const option = document.createElement("option"); option.value = key; option.textContent = cwd || ct("recipientWorkspaceUnknown"); option.title = cwd; this.workspace.append(option);
    }
    this.workspace.value = workspaces.has(chosen) ? chosen : "";
    this.workspace.title = workspaces.get(chosen) || "";
    const target = this.target(), status = this.status(target);
    const reconnectable = Boolean(this.selection && target && !returnable && this.reconnect && this.reconnectThread(target) && status?.status !== "deleted" && status?.status !== "changed");
    this.reconnectButton.hidden = !reconnectable;
    this.reconnectButton.disabled = this.reconnecting;
    this.reconnectButton.textContent = ct(this.reconnecting ? "taskTarget.reconnecting" : "taskTarget.reconnect");
    const scoped = this.workspace.value ? options.filter(option => this.workspaceKey(option) === this.workspace.value) : [];
    this.select.replaceChildren();
    const blank = document.createElement("option"); blank.value = ""; blank.textContent = ct(!this.workspace.value ? "recipientWorkspaceFirst" : scoped.length ? "recipientChooseTask" : "recipientNoTasks"); this.select.append(blank);
    for (const optionTarget of scoped) {
      const known = this.status(optionTarget), option = document.createElement("option"); option.value = optionTarget.source_id;
      const original = optionTarget.source_id === this.origin?.source_id;
      const label = known?.label || optionTarget.label;
      option.textContent = known?.status === "deleted" ? `${ct(original ? "originalTaskDeleted" : "taskDeleted")} · ${label}` : `${label}${original ? ` · ${ct("originalTask")}` : ""}`;
      option.title = [optionTarget.thread_id, optionTarget.cwd, optionTarget.source_id].filter(Boolean).join("\n");
      option.disabled = known?.status === "deleted" || !this.canReturn(optionTarget); this.select.append(option);
    }
    this.select.value = target?.source_id || "";
    this.select.disabled = !this.selection || !this.workspace.value || !scoped.length || Boolean(this.confirmation);
    this.workspace.disabled = !this.selection || Boolean(this.confirmation);
    if (this.selection && target && this.reconnectError) { this.notice.textContent = this.reconnectError; this.notice.hidden = false; }
    else if (this.selection && target && !this.canReturn(target)) { this.notice.textContent = ct(this.reconnectThread(target) ? "taskTarget.unlinked" : "taskTarget.noReturn"); this.notice.hidden = false; }
    else if (this.selection && status && status.status !== "available") { this.notice.textContent = ct(`taskTarget.${status.status}`); this.notice.hidden = false; }
    this.onState(!this.selection || !target || this.switching || !this.canReturn(target) || status?.status !== "available");
    if (this.selection && target && (this.canReturn(target) || this.reconnectThread(target))) { const entry = this.cache.get(this.key(target)); if (!entry?.pending && (!entry?.value || Date.now() - entry.at > 30000)) void this.check(target); }
  }
  private canReturn(target?: TaskTarget) { return canReturnCanvas(target?.source_id, this.bindings); }
}
