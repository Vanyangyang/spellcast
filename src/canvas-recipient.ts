import type { BoardSnapshot, CanvasObject, CodexBinding, HostSessionStatus, TaskTarget, TaskTargetStatus } from "./types";
import type { CanvasSelection } from "./canvas";
import { ct } from "./i18n/canvas";
import { workspaceIdentity } from "./content-origin";
import { hostTarget, canReturnHost, hostPinKey, recentHostTarget } from "./host-routing";

type Source = { id: string; label: string };
type RecipientView = { root: HTMLElement; summary: HTMLElement; toggle: HTMLButtonElement; picker: HTMLElement };
type Reconnect = (target: TaskTarget & { thread_id: string }) => Promise<CodexBinding>;
const CODEX_SOURCE = /^(?:codex:)?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;
function sourceThread(source?: string) { return source && CODEX_SOURCE.exec(source)?.[1].toLowerCase(); }
function sameSource(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && (a === b || sourceThread(a) && sourceThread(a) === sourceThread(b)));
}
function bindingForSource(source: string, bindings: CodexBinding[]): CodexBinding | undefined {
  if (source.startsWith("claude:")) return undefined;
  const thread = sourceThread(source), exact = bindings.find(binding => binding.source_id === source);
  if (exact) return !thread || exact.thread_id.toLowerCase() === thread ? exact : undefined;
  return thread ? bindings.find(binding => sourceThread(binding.source_id) === thread && binding.thread_id.toLowerCase() === thread) : undefined;
}

/** Presentation only: derive the client from existing explicit identities/bindings. */
export function recipientClient(target?: TaskTarget, bindings: CodexBinding[] = []): "codex" | "claude" | undefined {
  if (!target) return;
  if (target.source_id.startsWith("claude:")) {
    const suffix = target.source_id.slice(7), thread = sourceThread(suffix);
    if (!thread || suffix.toLowerCase() !== thread || target.thread_id && target.thread_id.toLowerCase() !== thread) return;
    if (target.host_pin && (target.host_pin.client !== "ccgui" || target.host_pin.engine !== "claude"
      || target.host_pin.source_id !== target.source_id || target.host_pin.native_session_id.toLowerCase() !== thread)) return;
    return "claude";
  }
  if (target.host_pin) return;
  const thread = sourceThread(target.source_id);
  if (thread) return !target.thread_id || target.thread_id.toLowerCase() === thread ? "codex" : undefined;
  const binding = bindingForSource(target.source_id, bindings);
  return binding && sourceThread(binding.thread_id) === binding.thread_id.toLowerCase() && target.thread_id === binding.thread_id ? "codex" : undefined;
}

export function shortProjectName(cwd?: string | null): string {
  return cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "/" : "";
}

export function readableRecipientLabel(target: TaskTarget, label = target.label): string {
  const explicitSuffix = target.source_id.startsWith("claude:") ? target.source_id.slice(7) : undefined;
  const parsedSuffix = sourceThread(explicitSuffix);
  const claudeSuffix = parsedSuffix && explicitSuffix?.toLowerCase() === parsedSuffix ? parsedSuffix : undefined;
  const ids = [target.source_id, target.thread_id, target.host_pin?.native_session_id, sourceThread(target.source_id), claudeSuffix].filter((id): id is string => Boolean(id));
  const aliases = ids.flatMap(id => [id, id.slice(0, 8)].flatMap(value => [value,
    ...["Codex", "Claude", "Claude Code", "CC GUI", "CCGUI", "CC GUI · CC GUI", "Claude / CC GUI"].flatMap(prefix =>
      [" · ", "·", "-", ":", ": ", " "].map(separator => prefix + separator + value))]));
  if (target.cwd && label.trim() === target.cwd.trim()) return "";
  return aliases.some(alias => alias.toLowerCase() === label.trim().toLowerCase()) ? "" : label;
}
function objectTarget(object: CanvasObject, board: BoardSnapshot, bindings: CodexBinding[], sources: Source[]): TaskTarget | undefined {
  const content = object.content;
  const note = content.type === "node" ? board.nodes.find(n => n.id === content.id) : undefined;
  const reply = content.type === "reply" ? board.replies?.find(r => r.id === content.id) : undefined;
  const original = reply?.origin_node_id ? board.nodes.find(n => n.id === reply.origin_node_id && sameSource(n.source_id, reply.source_id)) : undefined;
  const captured = note?.captured_context || original?.captured_context;
  const source_id = note?.source_id || reply?.source_id || object.source_id || object.origin?.source_id || captured?.source_id;
  if (!source_id) return;
  const binding = bindingForSource(source_id, bindings);
  const thread_id = captured?.thread_id || object.origin?.thread_id || sourceThread(source_id) || binding?.thread_id;
  const current = binding && (!thread_id || binding.thread_id === thread_id) ? binding : undefined;
  return { source_id, thread_id, cwd: captured?.cwd || object.origin?.cwd || current?.cwd,
    label: current?.label || object.origin?.label || captured?.goal || reply?.source_label || sources.find(s => s.id === source_id)?.label || source_id };
}

/** Canvas send-back currently needs a bound desktop task. MCP-only hosts stay visible but cannot receive it yet. */
export function canReturnCanvas(sourceId: string | undefined, bindings: CodexBinding[]): boolean {
  return Boolean(sourceId && bindingForSource(sourceId, bindings));
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
    const binding = bindingForSource(owner, bindings);
    return { source_id: owner, thread_id: sourceThread(owner) || binding?.thread_id, cwd: binding?.cwd, label: binding?.label || sources.find(s => s.id === owner)?.label || owner };
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
  private hosts: HostSessionStatus[] = [];
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
  private pinned: string | null = null;
  private pinButton = document.createElement("button");
  private recipientDetails = document.createElement("details");
  private recipientDetailsTitle = document.createElement("summary");
  private recipientDetailsBody = document.createElement("div");
  constructor(private select: HTMLSelectElement, private workspace: HTMLSelectElement, private notice: HTMLElement, private lookup: (target: TaskTarget) => Promise<TaskTargetStatus>, private onState: (blocked: boolean) => void, private view: RecipientView, private reconnect?: Reconnect) {
    try { this.pinned = localStorage.getItem("spellcast.canvas.recipient.pin.v1"); } catch { /* Optional local preference. */ }
    this.pinButton.type = "button"; this.pinButton.className = "ghost recipient-pin";
    view.toggle.after(this.pinButton);
    this.recipientDetails.className = "recipient-diagnostics";
    this.recipientDetails.dataset.recipientDiagnostics = "true";
    this.recipientDetails.append(this.recipientDetailsTitle, this.recipientDetailsBody); view.picker.append(this.recipientDetails);
    this.pinButton.addEventListener("click", () => {
      if (this.origin || this.switching) return;
      this.pinned = this.pinned ? null : this.target()?.source_id || null;
      this.manual = null;
      try { if (this.pinned) localStorage.setItem("spellcast.canvas.recipient.pin.v1", this.pinned); else localStorage.removeItem("spellcast.canvas.recipient.pin.v1"); } catch { /* Current window retains the choice. */ }
      this.paint(); this.select.dispatchEvent(new Event("recipient-change"));
    });
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
  update(board: BoardSnapshot, selection: CanvasSelection | null, bindings: CodexBinding[], sources: Source[], hosts: HostSessionStatus[] = []) {
    if (this.selection?.object_id !== selection?.object_id) this.reconnectError = null;
    this.board = board; this.selection = selection; this.bindings = bindings; this.sources = sources; this.hosts = hosts;
    if (!selection) { this.editing = false; this.workspaceChoice = null; }
    this.origin = originalTask(board, selection, bindings, sources);
    if (this.origin?.source_id.startsWith("claude:")) this.origin = hostTarget(this.origin.source_id, hosts, this.origin) || this.origin;
    this.paint();
    if (this.confirmation && this.confirmation.signature !== this.choiceSignature(this.confirmation.source)) this.confirmation.cancel();
  }
  target(): TaskTarget | undefined {
    const target = this.committedTarget();
    return target && this.workspaceKey(target) === this.chosenWorkspace() ? target : undefined;
  }
  private committedTarget() {
    if (!this.selection) return undefined;
    const source = this.manual ?? this.origin?.source_id ?? this.pinned;
    return source ? this.sourceTarget(source) : recentHostTarget(this.hosts);
  }
  private workspaceKey(target: TaskTarget) { return workspaceIdentity(target.cwd || ""); }
  private chosenWorkspace() { const target = this.committedTarget(); return this.workspaceChoice ?? (target ? this.workspaceKey(target) : ""); }
  private availableTargets() {
    const targets = new Map<string, TaskTarget>();
    const committed = this.committedTarget();
    if (this.manual && committed && sameSource(committed.source_id, this.origin?.source_id)) targets.set(committed.source_id, committed);
    if (this.origin) targets.set(this.origin.source_id, this.origin);
    if (committed) targets.set(committed.source_id, committed);
    for (const binding of this.bindings) if (!binding.source_id.startsWith("claude:") && !targets.has(binding.source_id) && workspaceIdentity(binding.cwd) !== "unsorted") targets.set(binding.source_id, { ...binding });
    for (const host of this.hosts) {
      const source = host.host_pin.source_id;
      if (!targets.has(source)) { const target = hostTarget(source, this.hosts); if (target) targets.set(source, target); }
    }
    // Prefer the original or explicit source when one task has several sources.
    const seen = new Set<string>();
    return [...targets.values()].filter(target => {
      const namespace = target.host_pin?.engine || (target.source_id.startsWith("claude:") ? "claude" : bindingForSource(target.source_id, this.bindings) || sourceThread(target.source_id) ? "codex" : target.source_id);
      const key = JSON.stringify([this.workspaceKey(target), namespace, target.thread_id || target.source_id]);
      if (seen.has(key)) return false; seen.add(key); return true;
    });
  }
  private sourceTarget(source?: string): TaskTarget | undefined {
    if (!source) return;
    if (sameSource(source, this.origin?.source_id)) {
      const original = this.origin && { ...this.origin, source_id: source };
      const inferred = sourceThread(source);
      return original && !original.thread_id && inferred ? { ...original, thread_id: inferred } : original;
    }
    const host = hostTarget(source, this.hosts);
    if (host) return host;
    const binding = bindingForSource(source, this.bindings);
    return { source_id: source, thread_id: sourceThread(source) || binding?.thread_id, cwd: binding?.cwd, label: binding?.label || this.sources.find(s => s.id === source)?.label || source };
  }
  private key(target: TaskTarget) { return JSON.stringify([target.source_id, target.thread_id || "", target.cwd || "", hostPinKey(target.host_pin)]); }
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
    if (next && (this.origin || current) && !sameSource(next.source_id, this.origin?.source_id)) {
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
        const client = recipientClient(target, this.bindings);
        caption.textContent = label; name.textContent = [ct(client === "codex" ? "recipientCodex" : client === "claude" ? "recipientClaude" : "recipientUnknownClient"),
          readableRecipientLabel(target, this.status(target)?.label || target.label) || ct("hostLinkConversation")].join(" · ");
        detail.textContent = shortProjectName(target.cwd);
        const identity = document.createElement("details"), identityTitle = document.createElement("summary"), identityBody = document.createElement("code");
        identity.className = "recipient-diagnostics"; identityTitle.textContent = ct("recipientDetails");
        identityBody.textContent = [target.source_id, target.thread_id, target.cwd].filter(Boolean).join("\n"); identity.append(identityTitle, identityBody);
        item.append(caption, name, detail, identity); route.append(item);
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
    const thread = sourceThread(target.source_id);
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
  matches(status: TaskTargetStatus) {
    const target = this.target();
    return Boolean(target && target.source_id === status.source_id && target.thread_id === status.thread_id && hostPinKey(target.host_pin) === hostPinKey(status.host_pin));
  }
  private paint() {
    if (!this.board) return;
    const committed = this.committedTarget(), committedStatus = this.status(committed);
    const original = sameSource(committed?.source_id, this.origin?.source_id);
    const returnable = this.canReturn(committed);
    const client = recipientClient(committed, this.bindings);
    const chat = committed && readableRecipientLabel(committed, committedStatus?.label || committed.label);
    const name = committed ? [ct(client === "codex" ? "recipientCodex" : client === "claude" ? "recipientClaude" : "recipientUnknownClient"),
      chat, shortProjectName(committed.cwd)].filter(Boolean).join(" · ") : ct("noOriginalTask");
    const mode = original ? ct("originalTask") : !this.origin && this.pinned ? ct("recipientPinned") : !this.origin && !this.manual && committed?.host_pin ? ct("recipientFollowing") : "";
    const label = committedStatus?.status === "deleted" ? `${ct(original ? "originalTaskDeleted" : "taskDeleted")} · ${name}` : `${name}${committed && mode ? ` · ${mode}` : ""}`;
    this.view.root.hidden = !this.selection;
    this.view.summary.textContent = ct("recipientSummary", { task: label });
    this.view.summary.title = label;
    this.view.summary.classList.toggle("is-unavailable", Boolean(this.selection && committed && !returnable));
    this.view.toggle.textContent = this.editing ? ct("recipientCancelChange") : committed ? ct("recipientChange") : ct("recipientChooseTask");
    this.view.toggle.setAttribute("aria-expanded", String(this.editing));
    this.view.toggle.disabled = Boolean(this.confirmation);
    this.pinButton.hidden = !this.selection || Boolean(this.origin);
    this.pinButton.textContent = ct(this.pinned ? "recipientUnpin" : "recipientPin");
    this.pinButton.disabled = this.switching || (!this.pinned && !committed);
    this.view.picker.hidden = !this.selection || !this.editing;
    this.select.hidden = false; this.workspace.hidden = false; this.notice.hidden = true;
    const options = this.availableTargets(), chosen = this.chosenWorkspace();
    const workspaces = new Map(options.map(target => [this.workspaceKey(target), target.cwd || ""]));
    this.workspace.replaceChildren();
    const firstWorkspace = document.createElement("option"); firstWorkspace.value = ""; firstWorkspace.textContent = ct("recipientChooseWorkspace"); this.workspace.append(firstWorkspace);
    const workspaceLabels = new Map<string, string>();
    for (const [key, cwd] of workspaces) {
      const short = shortProjectName(cwd) || ct("recipientWorkspaceUnknown");
      const duplicate = [...workspaces.values()].filter(path => shortProjectName(path) === short).length > 1;
      const parent = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0];
      const readable = duplicate && parent ? `${short} · ${parent}` : short;
      workspaceLabels.set(key, readable);
      const option = document.createElement("option"); option.value = key; option.textContent = readable; option.title = readable; this.workspace.append(option);
    }
    this.workspace.value = workspaces.has(chosen) ? chosen : "";
    this.workspace.title = workspaceLabels.get(chosen) || "";
    const target = this.target(), status = this.status(target);
    const reconnectable = Boolean(this.selection && target && !returnable && this.reconnect && this.reconnectThread(target) && status?.status !== "deleted" && status?.status !== "changed");
    this.reconnectButton.hidden = !reconnectable;
    this.reconnectButton.disabled = this.reconnecting;
    this.reconnectButton.textContent = ct(this.reconnecting ? "taskTarget.reconnecting" : "taskTarget.reconnect");
    const scoped = this.workspace.value ? options.filter(option => this.workspaceKey(option) === this.workspace.value) : [];
    this.select.replaceChildren();
    const blank = document.createElement("option"); blank.value = ""; blank.textContent = ct(!this.workspace.value ? "recipientWorkspaceFirst" : scoped.length ? "recipientChooseTask" : "recipientNoTasks"); this.select.append(blank);
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const key of ["codex", "claude", "unknown"]) {
      const group = document.createElement("optgroup"); group.label = ct(key === "codex" ? "recipientCodex" : key === "claude" ? "recipientClaude" : "recipientUnknownClient"); groups.set(key, group);
    }
    for (const optionTarget of scoped) {
      const known = this.status(optionTarget), option = document.createElement("option"); option.value = optionTarget.source_id;
      const original = sameSource(optionTarget.source_id, this.origin?.source_id);
      const label = readableRecipientLabel(optionTarget, known?.label || optionTarget.label) || ct("hostLinkConversation");
      option.textContent = known?.status === "deleted" ? `${ct(original ? "originalTaskDeleted" : "taskDeleted")} · ${label}` : `${label}${original ? ` · ${ct("originalTask")}` : ""}`;
      option.title = [label, shortProjectName(optionTarget.cwd)].filter(Boolean).join(" · ");
      option.disabled = known?.status === "deleted" || !this.canReturn(optionTarget);
      groups.get(recipientClient(optionTarget, this.bindings) || "unknown")!.append(option);
    }
    for (const group of groups.values()) if (group.childElementCount) this.select.append(group);
    this.recipientDetailsTitle.textContent = ct("recipientDetails");
    this.recipientDetailsBody.replaceChildren(...options.map(optionTarget => {
      const row = document.createElement("section"), name = document.createElement("strong"), body = document.createElement("code");
      const client = recipientClient(optionTarget, this.bindings);
      name.textContent = [ct(client === "codex" ? "recipientCodex" : client === "claude" ? "recipientClaude" : "recipientUnknownClient"),
        readableRecipientLabel(optionTarget, this.status(optionTarget)?.label || optionTarget.label) || ct("hostLinkConversation"), shortProjectName(optionTarget.cwd)].filter(Boolean).join(" · ");
      body.textContent = [optionTarget.source_id, optionTarget.thread_id, optionTarget.cwd,
        optionTarget.host_pin?.window_id].filter(Boolean).join("\n"); row.append(name, body); return row;
    }));
    this.recipientDetails.hidden = !options.length;
    this.select.value = target?.source_id || "";
    this.select.disabled = !this.selection || !this.workspace.value || !scoped.length || Boolean(this.confirmation);
    this.workspace.disabled = !this.selection || Boolean(this.confirmation);
    if (this.selection && target && this.reconnectError) { this.notice.textContent = this.reconnectError; this.notice.hidden = false; }
    else if (this.selection && status && status.status !== "available") { this.notice.textContent = ct(`taskTarget.${status.status}`); this.notice.hidden = false; }
    else if (this.selection && target && !this.canReturn(target)) { this.notice.textContent = ct(this.reconnectThread(target) ? "taskTarget.unlinked" : "taskTarget.noReturn"); this.notice.hidden = false; }
    this.onState(!this.selection || !target || this.switching || !this.canReturn(target) || status?.status !== "available");
    window.dispatchEvent(new CustomEvent("spellcast:recipient-evidence", { detail: {
      bindings: this.bindings, target: committed, status: committedStatus,
      confirmed: !this.switching, canReturn: this.canReturn(committed),
    } }));
    if (this.selection && target && (this.canReturn(target) || this.reconnectThread(target))) { const entry = this.cache.get(this.key(target)); if (!entry?.pending && (!entry?.value || Date.now() - entry.at > 30000)) void this.check(target); }
  }
  private canReturn(target?: TaskTarget) {
    if (target?.host_pin || target?.source_id.startsWith("claude:")) return canReturnHost(target, this.hosts);
    return canReturnCanvas(target?.source_id, this.bindings);
  }
}
