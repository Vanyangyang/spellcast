import { zipSync, strToU8 } from "fflate";
import { apiBase, fetchBoard, fetchArtifact, fetchArtifactHistory, saveArtifactState, editArtifactFile } from "./api";
import type { ArtifactBundle, ArtifactStatePreview, BoardReply, ReplyArtifactBlock } from "./reply-types";
import { CanvasDataflow, type CanvasFrameToken } from "./canvas-dataflow";
import { currentLocale } from "./i18n";
import { contentKey } from "./reply-drafts";
import "./artifacts.css";

const words = {
  "zh-CN": { run: "运行", stop: "停止", reload: "重新运行", export: "导出作品", source: "源码与版本", restore: "恢复这个版本", save: "保存源码", loading: "正在打开作品…", ready: "运行中", stopped: "已停止", saving: "正在保存参数…", saved: "参数已保存", selection: "当前选择", none: "未选择对象", retry: "重试保存", recover: "查看未保存的参数", conflict: "有未保存的参数，保留在本机。请核对最新状态后再重试。", file: "资源文件", current: "当前版本", version: "历史版本", edit: "可直接修改 HTML、CSS、JavaScript 和数据。构建源文件需在宿主重建后重新发布。", pending: "源文件草稿已保留", download: "下载此文件", operations: "作品操作", compact: "紧凑显示", full: "完整显示", snapshot: "保存当前状态画面", capturing: "正在捕获当前状态画面…", noSnapshot: "作品没有提供画面捕获；仍可引用已保存的参数。", snapshotStopped: "画面捕获在作品停止前未完成。", snapshotChanged: "参数在画面捕获期间变化，未保存旧画面。", snapshotInvalid: "画面格式或大小不符合保存要求。", snapshotMissing: "保存后的作品已不包含此作品块。" },
  en: { run: "Run", stop: "Stop", reload: "Restart", export: "Export work", source: "Source and versions", restore: "Restore this version", save: "Save source", loading: "Opening work…", ready: "Running", stopped: "Stopped", saving: "Saving parameters…", saved: "Parameters saved", selection: "Selection", none: "No object selected", retry: "Retry save", recover: "Inspect unsaved parameters", conflict: "Unsaved parameters are kept locally. Compare the latest state before retrying.", file: "Asset file", current: "Current version", version: "Past version", edit: "Edit HTML, CSS, JavaScript and data directly. Rebuild original build sources in the host and publish again.", pending: "Source draft preserved", download: "Download file", operations: "Work actions", compact: "Compact display", full: "Full display", snapshot: "Save current state image", capturing: "Capturing the current state image…", noSnapshot: "This work has no image capture handler. Its saved parameters can still be referenced.", snapshotStopped: "The image capture did not finish before the work stopped.", snapshotChanged: "Parameters changed while the image was captured, so the old image was not saved.", snapshotInvalid: "The captured image format or size cannot be saved.", snapshotMissing: "The saved work no longer contains this artifact." },};
type Word = keyof typeof words.en;
let framePolicy: Promise<void> | null = null;
function constrainFrames() {
  framePolicy ??= apiBase().then(base => {
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    // The child policy covers resources; the parent policy also covers frame navigations.
    policy.content = `frame-src ${new URL(base).origin}/artifacts/;`;
    document.head.append(policy);
  }).catch(error => { framePolicy = null; throw error; });
  return framePolicy;
}
function t(key: Word) { return words[currentLocale()][key]; }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const e = document.createElement(tag); e.className = cls; e.textContent = text; return e;
}
function button(label: string, action: () => void) { const b = el("button", "", label); b.type = "button"; b.onclick = action; return b; }
function download(bytes: Uint8Array | string, name: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], { type }));
  const a = el("a"); a.href = url; a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stateObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= 64_000; } catch { return false; }
}

const MAX_PREVIEW_BYTES = 256 * 1024;
function previewObject(value: unknown): value is ArtifactStatePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Partial<ArtifactStatePreview>;
  if (typeof preview.src !== "string" || typeof preview.alt !== "string" || preview.alt.length > 2000) return false;
  if (new TextEncoder().encode(preview.src).length > MAX_PREVIEW_BYTES) return false;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/i.test(preview.src) || preview.src.startsWith("/artifacts/");
}

type SnapshotResult = { state: Record<string, unknown>; preview: ArtifactStatePreview | null };
type SnapshotWaiter = {
  requestId: string;
  timer: number;
  resolve: (result: SnapshotResult) => void;
  reject: (error: Error) => void;
};

/** A frame reports its own data and unused wheel input. Neither can enqueue model work. */
export class ArtifactFrame {
  private reply!: BoardReply;
  private block!: ReplyArtifactBlock;
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private bundle: ArtifactBundle | null = null;
  private epoch = 0;
  private dead = false;
  private running = true;
  private timer = 0;
  private saving: Promise<void> | null = null;
  private pending: Record<string, unknown> | null = null;
  private local: Record<string, unknown> = {};
  private stateRevision = 0;
  private storageKey = "";
  private legacyStorageKey = "";
  private presentationKey = "";
  private presentation: "compact" | "full" = "full";
  private presentationExplicit = false;
  private naturalHeight = 480;
  private presentationTicket = 0;
  private failed = false;
  private conflict = false;
  private sourceEpoch = 0;
  private sourceDirty = false;
  private sourceMode: "files" | "state" = "files";
  private dataToken: CanvasFrameToken | null = null;
  private readonly unsubscribeData: (() => void) | null;
  private deliveredInputRevision = -1;
  private stateGeneration = 0;
  private outputCandidate: { generation: number; revision: number; values: unknown } | null = null;
  private captureAttempt: Promise<void> | null = null;
  private captureSaving: Promise<void> | null = null;
  private snapshotWaiter: SnapshotWaiter | null = null;
  private readonly shell = el("section", "artifact-shell is-full");
  private readonly view = el("div", "artifact-viewport");
  private readonly status = el("span", "artifact-status");
  private readonly notice = el("div", "artifact-inline-notice");
  private readonly noticeText = el("span");
  private readonly resume = button(t("run"), () => void this.start().catch(e => this.fail(e)));
  private readonly selection = el("p", "artifact-selection");
  private readonly description = el("p", "artifact-description");
  private readonly controls = el("div", "artifact-controls");
  private readonly operations = el("details", "artifact-operations");
  private readonly operationBody = el("div", "artifact-operation-body");
  private readonly sources = el("details", "artifact-sources");
  private readonly sourceBody = el("div", "artifact-source-body");
  private readonly toggle = button(t("stop"), () => { if (this.running) this.stop(); else void this.start().catch(e => this.fail(e)); });
  private readonly reload = button(t("reload"), () => { this.stop(); void this.start().catch(e => this.fail(e)); });
  private readonly exportWork = button(t("export"), () => void this.export().catch(e => this.fail(e)));
  private readonly snapshot = button(t("snapshot"), () => void this.captureSnapshot().catch(e => this.fail(e)));
  private readonly presentationToggle = button(t("compact"), () => this.setPresentation(this.presentation === "compact" ? "full" : "compact", true));
  private readonly retry = button(t("retry"), () => { this.failed = false; void this.flush().catch(e => this.fail(e)); });
  private readonly recover = button(t("recover"), () => void this.inspectState().catch(e => this.fail(e)));
  private readonly ready = (event: MessageEvent) => {
    if (!this.frame || event.source !== this.frame.contentWindow || event.data?.type !== "spellcast:ready") return;
    this.abortSnapshot(t("snapshotStopped"));
    this.port?.close();
    const channel = new MessageChannel();
    const epoch = this.epoch;
    this.port = channel.port1;
    channel.port1.onmessage = event => { if (!this.dead && epoch === this.epoch) this.receive(event.data); };
    const inputs = this.inputs();
    this.deliveredInputRevision = inputs.revision;
    this.frame.contentWindow!.postMessage({ type: "spellcast:init", state: this.local, inputs, canvasWheel: Boolean(this.onCanvasWheel) }, "*", [channel.port2]);
    channel.port1.start();
  };

  constructor(private host: HTMLElement, private onReply: (reply: BoardReply) => void, private onError: (message: string) => void,
    private restore: (bundle: string) => Promise<void>, private dataflow?: CanvasDataflow,
    private onPresentationChange?: (height: number, mode: "compact" | "full", explicit: boolean) => void,
    private onCanvasWheel?: (clientX: number, clientY: number, deltaY: number) => void) {
    this.status.setAttribute("role", "status");
    this.notice.setAttribute("role", "status"); this.notice.hidden = true;
    this.notice.append(this.noticeText, this.resume);
    this.controls.append(this.toggle, this.status, this.presentationToggle);
    this.retry.hidden = this.recover.hidden = true;
    this.selection.setAttribute("aria-live", "polite");
    this.sources.append(el("summary", "", t("source")), this.sourceBody);
    this.sources.addEventListener("toggle", () => { if (this.sources.open && !this.sourceBody.childElementCount) void this.showSources().catch(e => this.fail(e)); });
    this.operations.append(el("summary", "", t("operations")), this.operationBody);
    this.operationBody.append(this.reload, this.exportWork, this.snapshot, this.retry, this.recover, this.sources);
    this.shell.append(this.description, this.controls, this.view, this.selection, this.operations, this.notice);
    this.host.append(this.shell);
    window.addEventListener("message", this.ready);
    this.unsubscribeData = this.dataflow?.subscribe(() => this.deliverInputs()) ?? null;
  }

  /** Only controls move into management; the live iframe stays in its original DOM position. */
  manageIn(host: HTMLElement | null) {
    if (host) host.append(this.description, this.controls, this.selection, this.operations);
    else { this.shell.prepend(this.description, this.controls); this.shell.append(this.selection, this.operations); }
  }

  private setStatus(message: string, attention = false) {
    this.status.textContent = message;
    this.notice.hidden = !attention && this.running;
    this.noticeText.textContent = !this.running && !attention ? t("stopped") : message;
    this.resume.hidden = this.running || this.conflict;
  }

  update(reply: BoardReply, block: ReplyArtifactBlock) {
    const changed = this.block?.bundle_id !== block.bundle_id;
    this.reply = reply; this.block = block;
    this.description.textContent = block.description; this.description.hidden = !block.description.trim();
    this.legacyStorageKey = `spellcast.artifact-state.${JSON.stringify([reply.source_id, reply.id, block.id])}`;
    this.storageKey = reply.object_id ? `spellcast.artifact-state.${JSON.stringify([reply.object_id, block.id])}` : this.legacyStorageKey;
    const nextPresentationKey = `spellcast.artifact-presentation.${JSON.stringify([reply.object_id ? "object" : "reply", reply.object_id ?? reply.id, block.id])}`;
    if (this.presentationKey !== nextPresentationKey) {
      this.presentationKey = nextPresentationKey;
      this.restorePresentation();
    }
    let legacyConflict = false;
    try {
      if (this.storageKey !== this.legacyStorageKey) {
        const old = localStorage.getItem(this.legacyStorageKey), current = localStorage.getItem(this.storageKey);
        if (old && (!current || current === old)) {
          if (!current) localStorage.setItem(this.storageKey, old);
          if (localStorage.getItem(this.legacyStorageKey) === old) localStorage.removeItem(this.legacyStorageKey);
        } else legacyConflict = Boolean(old && current);
      }
    } catch { legacyConflict = true; }
    if (changed) {
      this.stopFrame(); this.bundle = null;
      this.local = structuredClone(block.state ?? {}); this.stateRevision = block.state_revision;
      this.pending = null; this.failed = false; this.conflict = false;
      try {
        const saved = JSON.parse(localStorage.getItem(this.storageKey) ?? "null");
        if (saved && stateObject(saved.state)) {
          if (saved.bundle === block.bundle_id && saved.revision === block.state_revision && !saved.merge_draft) {
            this.pending = this.local = saved.state;
          } else { this.failed = this.conflict = true; this.running = false; this.toggle.textContent = t("run"); this.setStatus(t("conflict"), true); this.recover.hidden = false; }
        }
      } catch (e) { this.failed = this.conflict = true; this.running = false; this.toggle.textContent = t("run"); this.recover.hidden = false; this.fail(e); }
      this.sourceEpoch++;
      if (!this.sources.open) this.sourceBody.replaceChildren();
      else if (this.sourceMode === "files") {
        if (!this.sourceDirty) void this.showSources().catch(e => this.fail(e));
        else if (!this.sourceBody.querySelector(".artifact-source-stale")) {
          const notice = el("div", "artifact-source-stale");
          notice.append(el("p", "", currentLocale() === "zh-CN" ? "作品已更新，正在保留旧版源码草稿。" : "The work changed. Your previous source draft is preserved."),
            button(currentLocale() === "zh-CN" ? "查看最新源码" : "Open latest source", () => { this.sourceDirty = false; void this.showSources().catch(e => this.fail(e)); }));
          this.sourceBody.prepend(notice);
          this.sourceBody.querySelector<HTMLButtonElement>("[data-source-save]")?.setAttribute("disabled", "");
          this.sourceBody.querySelectorAll<HTMLOptionElement>("option[data-version-label]").forEach(option => { option.textContent = option.dataset.versionLabel ?? option.textContent; });
        }
      }
      if (this.running) void this.start().catch(e => this.fail(e));
    } else if (!this.pending && !this.saving && block.state_revision > this.stateRevision) {
      this.stateGeneration++; this.outputCandidate = null;
      this.stateRevision = block.state_revision; this.local = structuredClone(block.state ?? {});
      this.port?.postMessage({ type: "restore", value: this.local });
      if (this.dataToken) this.dataflow?.invalidate(this.dataToken, "work state changed");
    }
    if (legacyConflict) {
      this.failed = this.conflict = true; this.running = false; this.stopFrame();
      this.toggle.textContent = t("run"); this.setStatus(t("conflict"), true); this.recover.hidden = false;
    }
    this.paintSelection();
  }

  private restorePresentation() {
    this.presentationExplicit = false;
    let saved: string | null = null;
    try { saved = localStorage.getItem(this.presentationKey); } catch { /* Natural sizing is safe when local storage is unavailable. */ }
    if (saved === "compact" || saved === "full") {
      this.presentationExplicit = true;
      this.presentation = saved;
      this.applyPresentation();
      this.reportPresentation(false);
      return;
    }
    this.setPresentation(this.naturalHeight <= 280 ? "compact" : "full", false);
  }

  private setPresentation(mode: "compact" | "full", explicit: boolean) {
    if (!explicit && this.presentationExplicit) return;
    if (explicit) {
      this.presentationExplicit = true;
      try { localStorage.setItem(this.presentationKey, mode); } catch { /* This affects only display preference. */ }
    }
    const changed = this.presentation !== mode;
    this.presentation = mode;
    this.applyPresentation();
    if (changed || explicit) this.reportPresentation(explicit);
  }

  private applyPresentation() {
    this.shell.classList.toggle("is-compact", this.presentation === "compact");
    this.shell.classList.toggle("is-full", this.presentation === "full");
    this.presentationToggle.textContent = this.presentation === "compact" ? t("full") : t("compact");
    if (this.presentation === "compact") this.operations.open = false;
    this.applyFrameHeight();
  }

  private applyFrameHeight() {
    if (!this.frame) return;
    const min = this.presentation === "compact" ? 80 : 360;
    this.frame.style.height = `${Math.max(min, Math.min(2400, Math.ceil(this.naturalHeight)))}px`;
  }

  private reportPresentation(explicit: boolean) {
    if (!this.onPresentationChange) return;
    const ticket = ++this.presentationTicket;
    window.requestAnimationFrame(() => {
      if (this.dead || ticket !== this.presentationTicket || !this.onPresentationChange) return;
      if (this.shell.closest(".rb-work-block")) {
        // Canvas coordinates must not include screen zoom or the component's visual scale.
        this.onPresentationChange(Math.max(this.presentation === "compact" ? 80 : 360, Math.min(2400, this.naturalHeight)), this.presentation, explicit);
        return;
      }
      const shell = Math.ceil(this.shell.getBoundingClientRect().height);
      const frame = Math.ceil(this.frame?.getBoundingClientRect().height ?? 0);
      const fallback = Math.max(80, Math.min(2400, this.naturalHeight + 112));
      const height = Math.max(80, Math.min(2400, shell || (frame ? frame + 112 : fallback)));
      this.onPresentationChange(height, this.presentation, explicit);
    });
  }

  private fail(error: unknown) {
    if (this.dead) return;
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(message, true); this.onError(message);
  }

  private receive(message: unknown) {
    if (!message || typeof message !== "object") return;
    const data = message as { type: string; value: unknown };
    if (data.type === "wheel") {
      const wheel = data.value as { x?: unknown; y?: unknown; deltaY?: unknown } | null;
      if (!this.onCanvasWheel || !this.frame?.matches(":hover") || !this.shell.closest(".canvas-frame.is-active") || document.querySelector("dialog[open]")) return;
      if (!wheel || typeof wheel.x !== "number" || !Number.isFinite(wheel.x) || wheel.x < 0 || wheel.x > 1 ||
        typeof wheel.y !== "number" || !Number.isFinite(wheel.y) || wheel.y < 0 || wheel.y > 1 || (wheel.deltaY !== -1 && wheel.deltaY !== 1)) return;
      const rect = this.frame.getBoundingClientRect();
      if (rect.width && rect.height) this.onCanvasWheel(rect.left + wheel.x * rect.width, rect.top + wheel.y * rect.height, wheel.deltaY);
      return;
    }
    if (data.type === "size" && typeof data.value === "number" && Number.isFinite(data.value)) {
      this.naturalHeight = Math.max(0, Math.ceil(data.value));
      if (!this.presentationExplicit) this.setPresentation(this.naturalHeight <= 280 ? "compact" : "full", false);
      this.applyFrameHeight();
      return;
    }
    if (data.type === "ready") { if (this.dataToken) this.dataflow?.ready(this.dataToken); if (!this.failed) this.setStatus(t("ready")); return; }
    if (data.type === "snapshot") {
      const value = data.value as { request_id?: unknown; state?: unknown; preview?: unknown } | null;
      const waiter = this.snapshotWaiter;
      if (!waiter || !value || value.request_id !== waiter.requestId) return;
      this.clearSnapshotWaiter(waiter);
      if (!stateObject(value.state)) { waiter.reject(new Error(t("snapshotInvalid"))); return; }
      waiter.resolve({ state: value.state, preview: value.preview === null ? null : value.preview as ArtifactStatePreview });
      return;
    }
    if (data.type === "error") {
      const value = data.value as { request_id?: unknown; message?: unknown } | null;
      const waiter = this.snapshotWaiter;
      if (waiter && value && value.request_id === waiter.requestId && typeof value.message === "string") {
        this.clearSnapshotWaiter(waiter);
        waiter.reject(new Error(value.message === "State changed before the snapshot completed." ? t("snapshotChanged") : value.message.slice(0, 2000)));
        return;
      }
      if (typeof data.value === "string") {
        if (this.dataToken) this.dataflow?.error(this.dataToken, data.value);
        this.fail(data.value.slice(0, 2000));
      }
      return;
    }
    if (data.type === "outputs") {
      const output = data.value as { revision?: unknown; values?: unknown } | null;
      if (!output || !Number.isSafeInteger(output.revision) || (output.revision as number) < 0) return;
      const candidate = { generation: this.stateGeneration, revision: output.revision as number, values: output.values };
      if (this.pending || this.saving || this.captureSaving) this.outputCandidate = candidate;
      else if (this.dataToken) this.dataflow?.publish(this.dataToken, candidate.revision, candidate.values);
      return;
    }
    if (data.type !== "state" || !stateObject(data.value)) return;
    this.abortSnapshot(t("snapshotChanged"));
    this.stateGeneration++; this.outputCandidate = null;
    if (this.dataToken) this.dataflow?.invalidate(this.dataToken, "work state changed");
    this.local = structuredClone(data.value); this.pending = this.local; this.paintSelection();
    try { localStorage.setItem(this.storageKey, JSON.stringify({ bundle: this.block.bundle_id, revision: this.stateRevision, state: this.pending })); }
    catch { this.fail("Cannot preserve parameters locally. Keep this window open until saving succeeds."); }
    if (this.failed) { this.retry.hidden = false; this.recover.hidden = false; return; }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush().catch(e => this.fail(e)), 250);
  }

  async flush(): Promise<void> {
    window.clearTimeout(this.timer);
    if (this.conflict) throw new Error(t("conflict"));
    if (this.captureSaving) { await this.captureSaving; if (this.pending) await this.flush(); return; }
    if (this.saving) { await this.saving; if (this.pending) await this.flush(); return; }
    if (!this.pending) { if (this.failed) throw new Error(t("conflict")); return; }
    const state = this.pending, block = this.block, reply = this.reply, key = this.storageKey, generation = this.stateGeneration;
    this.setStatus(t("saving"));
    this.saving = (async () => {
      try {
        const result = await saveArtifactState({ object_id: reply.object_id, reply_id: reply.id, block_id: block.id, bundle_id: block.bundle_id,
          expected_state_revision: this.stateRevision, state });
        const updated = result.blocks.find(b => b.id === block.id) as ReplyArtifactBlock;
        if (this.block.bundle_id !== block.bundle_id) return;
        this.stateRevision = updated.state_revision;
        if (this.dataToken) this.dataflow?.commit(this.dataToken, this.stateRevision);
        if (this.pending === state) {
          this.pending = null;
          try { const saved = JSON.parse(localStorage.getItem(key) ?? "null"); if (saved?.bundle === block.bundle_id && contentKey(saved.state) === contentKey(state)) localStorage.removeItem(key); } catch { /* An uncleared recovery record is safer than dropping input. */ }
        } else if (this.pending) {
          try { localStorage.setItem(key, JSON.stringify({ bundle: block.bundle_id, revision: this.stateRevision, state: this.pending })); } catch { /* The most recent in-memory parameters remain available. */ }
        }
        this.failed = false; this.retry.hidden = this.recover.hidden = true;
        this.setStatus(t("saved")); this.onReply(result);
        const candidate = this.outputCandidate;
        if (!this.pending && candidate?.generation === generation && this.dataToken &&
          this.dataflow?.publish(this.dataToken, candidate.revision, candidate.values)) this.outputCandidate = null;
      } catch (error) {
        this.failed = true; this.retry.hidden = false; this.recover.hidden = false;
        throw error;
      } finally { this.saving = null; }
    })();
    await this.saving;
    if (this.pending && !this.failed) await this.flush();
  }

  private captureSnapshot(): Promise<void> {
    if (this.captureAttempt) return this.captureAttempt;
    const attempt = this.captureSnapshotNow();
    this.captureAttempt = attempt;
    const clear = () => { if (this.captureAttempt === attempt) this.captureAttempt = null; };
    void attempt.then(clear, clear);
    return attempt;
  }

  private async captureSnapshotNow(): Promise<void> {
    await this.flush();
    if (this.dead || !this.running || !this.frame || !this.port) throw new Error(t("snapshotStopped"));
    const captured = { bundle: this.block.bundle_id, revision: this.stateRevision, generation: this.stateGeneration };
    const work = (async () => {
      this.setStatus(t("capturing"));
      const result = await this.requestSnapshot();
      if (result.preview === null) { this.setStatus(t("noSnapshot")); return; }
      if (!previewObject(result.preview)) throw new Error(t("snapshotInvalid"));
      if (this.dead || this.block.bundle_id !== captured.bundle || this.stateRevision !== captured.revision ||
        this.stateGeneration !== captured.generation || this.pending || this.saving || contentKey(result.state) !== contentKey(this.local)) {
        throw new Error(t("snapshotChanged"));
      }
      this.setStatus(t("saving"));
      const reply = await saveArtifactState({ object_id: this.reply.object_id, reply_id: this.reply.id, block_id: this.block.id,
        bundle_id: captured.bundle, expected_state_revision: captured.revision, state: result.state, preview: result.preview });
      if (this.dead || this.block.bundle_id !== captured.bundle) return;
      const updated = reply.blocks.find((block): block is ReplyArtifactBlock => block.id === this.block.id && block.type === "artifact");
      if (!updated) throw new Error(t("snapshotMissing"));
      this.stateRevision = updated.state_revision;
      if (this.dataToken) this.dataflow?.commit(this.dataToken, this.stateRevision);
      if (this.pending) {
        try { localStorage.setItem(this.storageKey, JSON.stringify({ bundle: captured.bundle, revision: this.stateRevision, state: this.pending })); }
        catch { /* The latest parameters are still held in memory. */ }
      }
      this.setStatus(t("saved"));
      this.onReply(reply);
    })();
    this.captureSaving = work;
    try {
      await work;
    } finally {
      if (this.captureSaving === work) this.captureSaving = null;
      if (this.pending && !this.failed && !this.dead) void this.flush().catch(error => this.fail(error));
    }
  }

  private requestSnapshot(): Promise<SnapshotResult> {
    const port = this.port;
    if (!port) return Promise.reject(new Error(t("snapshotStopped")));
    const requestId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<SnapshotResult>((resolve, reject) => {
      const waiter: SnapshotWaiter = {
        requestId,
        timer: window.setTimeout(() => {
          if (this.snapshotWaiter === waiter) {
            this.snapshotWaiter = null;
            reject(new Error(t("snapshotStopped")));
          }
        }, 12_000),
        resolve,
        reject,
      };
      this.snapshotWaiter = waiter;
      try { port.postMessage({ type: "snapshot", request_id: requestId }); }
      catch (error) { this.clearSnapshotWaiter(waiter); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private clearSnapshotWaiter(waiter: SnapshotWaiter) {
    window.clearTimeout(waiter.timer);
    if (this.snapshotWaiter === waiter) this.snapshotWaiter = null;
  }

  private abortSnapshot(message: string) {
    const waiter = this.snapshotWaiter;
    if (!waiter) return;
    this.clearSnapshotWaiter(waiter);
    waiter.reject(new Error(message));
  }

  private paintSelection() {
    const selected = this.local.selection;
    const label = selected && typeof selected === "object" && "label" in selected ? String(selected.label) : selected ? JSON.stringify(selected) : t("none");
    this.selection.textContent = `${t("selection")}: ${label.slice(0, 500)}`;
  }

  context() {
    const state = structuredClone(this.local);
    const chosen = state.selection;
    const label = chosen && typeof chosen === "object" && "label" in chosen ? String(chosen.label) : this.block.title?.trim() || this.reply.title || "Artifact";
    const inputs = this.inputs();
    return { label, prefix: "",
      artifact_context: { bundle_id: this.block.bundle_id, state_revision: this.stateRevision, state,
        ...(Object.keys(inputs.ports).length ? { inputs } : {}) } };
  }

  canvasAnchor() {
    const state = structuredClone(this.local);
    return { bundle_id: this.block.bundle_id, state_revision: this.stateRevision, state, ...(state.selection === undefined ? {} : { selection: state.selection }) };
  }

  private async start() {
    if (this.dead || !this.block) return;
    if (this.conflict) throw new Error(t("conflict"));
    this.stopFrame(); this.running = true; this.toggle.textContent = t("stop");
    if (!this.failed) this.setStatus(t("loading"));
    const epoch = this.epoch, id = this.block.bundle_id;
    const [bundle, base] = await Promise.all([fetchArtifact(id), apiBase(), constrainFrames()]);
    if (this.dead || epoch !== this.epoch || id !== this.block.bundle_id) return;
    this.bundle = bundle;
    if (this.dataflow && this.reply.object_id) this.dataToken = this.dataflow.register(this.reply.object_id, this.block.id, bundle, this.stateRevision);
    const frame = el("iframe", "artifact-frame");
    frame.title = this.block.title?.trim() || this.reply.title || "Canvas work";
    frame.sandbox.add("allow-scripts", "allow-forms", "allow-downloads");
    frame.referrerPolicy = "no-referrer";
    frame.allow = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'";
    frame.src = `${base}/artifacts/${encodeURIComponent(id)}/${bundle.entry.split("/").map(encodeURIComponent).join("/")}?__spellcast_shell=wheel-1`;
    this.frame = frame; this.view.replaceChildren(frame); this.applyFrameHeight();
    if (this.pending && !this.failed) void this.flush().catch(e => this.fail(e));
  }

  private stopFrame() {
    this.abortSnapshot(t("snapshotStopped"));
    if (this.dataToken) this.dataflow?.unregister(this.dataToken);
    this.dataToken = null; this.deliveredInputRevision = -1; this.outputCandidate = null;
    this.epoch++; this.port?.close(); this.port = null;
    this.frame?.remove(); this.frame = null;
  }

  private stop() {
    this.running = false; this.stopFrame(); this.toggle.textContent = t("run"); this.setStatus(t("stopped"), true);
    if (this.pending && !this.failed) void this.flush().catch(e => this.fail(e));
  }

  private inputs() {
    return this.dataflow && this.reply.object_id ? this.dataflow.snapshot(this.reply.object_id, this.block.id) : { revision: 0, ports: {} };
  }

  private deliverInputs() {
    if (!this.port || !this.dataToken) return;
    const inputs = this.inputs();
    if (inputs.revision === this.deliveredInputRevision) return;
    this.deliveredInputRevision = inputs.revision;
    if (this.outputCandidate?.revision !== inputs.revision) this.outputCandidate = null;
    this.port.postMessage({ type: "inputs", value: inputs });
  }

  private async inspectState() {
    this.stop();
    this.sourceMode = "state"; this.sourceEpoch++;
    this.sources.querySelector("summary")!.textContent = t("recover");
    this.sources.open = true;
    this.sourceBody.replaceChildren(el("p", "", t("loading")));
    if (this.saving) await this.saving.catch(() => {});
    const board = await fetchBoard();
    const content = this.reply.object_id ? board.canvas?.objects.find(object => object.id === this.reply.object_id)?.content : null;
    const reply = board.replies?.find(reply => this.reply.object_id ? content?.type === "reply" && reply.id === content.id : reply.id === this.reply.id);
    const block = reply?.blocks.find(block => block.id === this.block.id);
    if (!reply || block?.type !== "artifact") throw new Error("The original work is no longer available. Copy the unsaved parameters before leaving.");
    let raw = localStorage.getItem(this.storageKey);
    let record: { state?: Record<string, unknown>; merge_draft?: string } | null = null;
    try { record = JSON.parse(raw ?? "null"); } catch { /* Keep corrupt bytes visible so they can be copied or repaired. */ }
    const text = el("textarea"); text.rows = 12; text.value = record?.merge_draft ?? (record ? JSON.stringify(record.state ?? this.pending ?? this.local, null, 2) : raw ?? JSON.stringify(this.pending ?? this.local, null, 2));
    text.setAttribute("aria-label", t("recover"));
    text.oninput = () => {
      try {
        const previous = localStorage.getItem(this.storageKey);
        if (previous !== raw) throw new Error("Another window changed this recovery draft. Copy your merged text before continuing.");
        const next = JSON.stringify({ bundle: block.bundle_id, revision: block.state_revision, state: record?.state ?? this.pending ?? this.local, merge_draft: text.value });
        localStorage.setItem(this.storageKey, next); raw = next;
      } catch (e) { this.fail(e); }
    };
    const current = el("details"), currentText = el("pre", "artifact-state-json", JSON.stringify(block.state, null, 2));
    current.append(el("summary", "", currentLocale() === "zh-CN" ? "查看当前保存的参数" : "Compare saved parameters"), currentText);
    const apply = button(currentLocale() === "zh-CN" ? "保存合并后的参数" : "Save merged parameters", () => {
      if (this.legacyStorageKey !== this.storageKey && localStorage.getItem(this.legacyStorageKey)) { this.fail("Copy or merge the separate legacy draft, then discard that legacy draft before saving."); return; }
      let state: unknown; try { state = JSON.parse(text.value); if (!stateObject(state)) throw new Error("Parameters must be a JSON object under 64 KB."); } catch (e) { this.fail(e); return; }
      apply.disabled = true;
      void saveArtifactState({ object_id: this.reply.object_id, reply_id: reply.id, block_id: block.id, bundle_id: block.bundle_id, expected_state_revision: block.state_revision, state })
        .then(next => {
          if (localStorage.getItem(this.storageKey) === raw) localStorage.removeItem(this.storageKey);
          this.failed = this.conflict = false; this.pending = null;
          const updated = next.blocks.find(b => b.id === block.id) as ReplyArtifactBlock;
          this.local = structuredClone(updated.state ?? {}); this.stateRevision = updated.state_revision;
          this.retry.hidden = this.recover.hidden = true; this.setStatus(t("saved")); this.sourceBody.replaceChildren(); this.sources.open = false; this.sourceMode = "files"; this.sources.querySelector("summary")!.textContent = t("source"); this.onReply(next);
        }).catch(e => this.fail(e)).finally(() => { apply.disabled = false; });
    });
    this.sourceBody.replaceChildren(el("p", "", t("conflict")), current, text, apply, button(t("download"), () => download(text.value, "unsaved-parameters.json", "application/json")));
    const legacyRaw = this.legacyStorageKey !== this.storageKey ? localStorage.getItem(this.legacyStorageKey) : null;
    if (legacyRaw) {
      apply.disabled = true;
      const legacy = el("details");
      legacy.append(el("summary", "", currentLocale() === "zh-CN" ? "另有一份旧版参数草稿（已保留）" : "A separate legacy parameter draft is preserved"),
        el("p", "", currentLocale() === "zh-CN" ? "先复制或合并这份内容，再放弃旧草稿，即可保存合并结果。" : "Copy or merge this content, then discard the legacy draft to save the merged result."), el("pre", "artifact-state-json", legacyRaw),
        button(t("download"), () => download(legacyRaw, "legacy-parameters.json", "application/json")),
        button(currentLocale() === "zh-CN" ? "放弃这份旧草稿" : "Discard this legacy draft", () => {
          if (localStorage.getItem(this.legacyStorageKey) !== legacyRaw) { this.fail("Another window changed this draft. Reopen recovery before discarding it."); return; }
          localStorage.removeItem(this.legacyStorageKey); legacy.remove(); apply.disabled = false;
        }));
      this.sourceBody.prepend(legacy);
    }
  }

  private async raw(bundle: string, name: string): Promise<Uint8Array> {
    const response = await fetch(`${await apiBase()}/api/artifacts/${encodeURIComponent(bundle)}/file?name=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Cannot read ${name}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async showSources() {
    this.sourceMode = "files"; this.sources.querySelector("summary")!.textContent = t("source");
    const id = this.block.bundle_id, replyRevision = this.reply.revision, epoch = ++this.sourceEpoch;
    this.sourceBody.replaceChildren(el("p", "", t("loading")));
    const [bundle, versions] = await Promise.all([fetchArtifact(id), fetchArtifactHistory(id)]);
    if (this.dead || this.sourceEpoch !== epoch || this.block.bundle_id !== id) return;
    const history = el("select"); history.setAttribute("aria-label", t("version"));
    for (const item of versions) { const label = new Date(item.created_at_ms).toLocaleString(); const option = el("option", "", `${label}${item.id === this.block.bundle_id ? ` · ${t("current")}` : ""}`); option.dataset.versionLabel = label; option.value = item.id; history.append(option); }
    history.value = this.block.bundle_id;
    const restore = button(t("restore"), () => { if (history.value !== this.block.bundle_id) void this.restore(history.value).catch(e => this.fail(e)); });
    const files = el("select"); files.setAttribute("aria-label", t("file"));
    for (const file of bundle.files) { const option = el("option", "", `${file.name} · ${Math.ceil(file.bytes / 1024)} KB`); option.value = file.name; files.append(option); }
    files.value = bundle.entry;
    const editor = el("textarea", "artifact-source-editor"); editor.rows = 14; editor.spellcheck = false; editor.setAttribute("aria-label", t("source"));
    let loadedName = "", baseline = "", loading = true;
    const save = button(t("save"), () => {
      if (loading || !loadedName || this.sourceEpoch !== epoch) return;
      const name = loadedName, text = editor.value, draftKey = `spellcast.artifact-source.${bundle.id}.${name}`;
      save.disabled = files.disabled = history.disabled = editor.disabled = restore.disabled = true;
      void editArtifactFile({ object_id: this.reply.object_id, reply_id: this.reply.id, block_id: this.block.id, bundle_id: bundle.id, expected_revision: replyRevision, name, text })
        .then(reply => { try { if (localStorage.getItem(draftKey) === text) localStorage.removeItem(draftKey); } catch {} if (this.dead) return; this.sourceDirty = false; this.sourceBody.replaceChildren(); this.onReply(reply); if (!this.sourceBody.childElementCount) void this.showSources().catch(e => this.fail(e)); })
        .catch(e => this.fail(e)).finally(() => { files.disabled = history.disabled = editor.disabled = restore.disabled = false; if (this.sourceEpoch === epoch) save.disabled = false; });
    });
    save.dataset.sourceSave = "true";
    const getFile = button(t("download"), () => { const name = loadedName; if (name && !loading) void this.raw(bundle.id, name).then(bytes => download(bytes, name.split("/").pop()!)).catch(e => this.fail(e)); });
    let fileEpoch = 0;
    const load = async () => {
      const name = files.value, fileTicket = ++fileEpoch, info = bundle.files.find(f => f.name === name)!;
      loading = true; loadedName = ""; this.sourceDirty = false; editor.value = ""; editor.disabled = true; save.disabled = getFile.disabled = true;
      const editable = /\.(html?|css|[cm]?js|json|svg|txt|md)$/i.test(name) && name !== "__spellcast.js" && info.bytes <= 2 * 1024 * 1024;
      editor.readOnly = !editable; save.hidden = !editable;
      if (info.bytes > 2 * 1024 * 1024 || !/^(text\/|application\/json|image\/svg)/.test(info.media_type)) {
        editor.value = `${info.media_type} · ${info.bytes} bytes`; loadedName = name; loading = false; getFile.disabled = false; return;
      }
      const bytes = await this.raw(bundle.id, name);
      if (this.dead || fileEpoch !== fileTicket || this.sourceEpoch !== epoch) return;
      baseline = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      editor.value = localStorage.getItem(`spellcast.artifact-source.${bundle.id}.${name}`) ?? baseline;
      this.sourceDirty = editor.value !== baseline; loadedName = name; loading = false; editor.disabled = false; save.disabled = getFile.disabled = false;
    };
    editor.addEventListener("input", () => { if (!loadedName || loading) return; this.sourceDirty = editor.value !== baseline; try { localStorage.setItem(`spellcast.artifact-source.${bundle.id}.${loadedName}`, editor.value); } catch (e) { this.fail(e); } });
    files.onchange = () => void load().catch(e => this.fail(e));
    this.sourceBody.replaceChildren(history, restore, el("p", "", t("edit")), files, editor, save, getFile);
    await load();
  }

  private async export() {
    await this.flush();
    const id = this.block.bundle_id, state = structuredClone(this.local), title = this.reply.title;
    const bundle = this.bundle?.id === id ? this.bundle : await fetchArtifact(id);
    const files: Record<string, Uint8Array> = {};
    for (const file of bundle.files) files[file.name] = await this.raw(bundle.id, file.name);
    if (Object.keys(files).some(name => name === "__spellcast-export" || name.startsWith("__spellcast-export/"))) throw new Error("The work contains the reserved __spellcast-export path. Its files were not overwritten.");
    files["__spellcast-export/original-entry.html"] = files[bundle.entry];
    const bootstrap = `<script>window.__SPELLCAST_ARTIFACT_ID__=${JSON.stringify(bundle.id)};window.__SPELLCAST_STATE__=${JSON.stringify(state).replaceAll("<", "\\u003c")}</script><script src="${"../".repeat(bundle.entry.split("/").length - 1)}__spellcast.js"></script>\n`;
    const source = new TextDecoder().decode(files[bundle.entry]).replace(/^\s*<!doctype[^>]*>/i, "");
    const head = /<head(?:\s[^>]*)?>/i;
    files[bundle.entry] = strToU8("<!doctype html>" + (head.test(source) ? source.replace(head, tag => tag + bootstrap) : bootstrap + source));
    files["__spellcast-export/manifest.json"] = strToU8(JSON.stringify(bundle, null, 2));
    files["__spellcast-export/state.json"] = strToU8(JSON.stringify(state, null, 2));
    // ponytail: bounded in-memory ZIP, streaming export if 256 MiB works prove too expensive.
    download(zipSync(files, { level: 0 }), `${title.replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 80)}.zip`, "application/zip");
  }

  destroy() {
    if (this.dead) return;
    this.dead = true; window.clearTimeout(this.timer); window.removeEventListener("message", this.ready); this.unsubscribeData?.(); this.stopFrame();
    this.host.replaceChildren();
  }
}
