import type { CanvasAnchor, CanvasAnnotation, CanvasContentFields, CanvasLayout, CanvasObject } from "./types";
import { apiBase } from "./api";
import { contentKey } from "./reply-drafts";
import { renderLightText } from "./light-text";
import { textLabel } from "./content-organization";
import { ct } from "./i18n/canvas";
import type { CanvasBinding, CanvasInputSnapshot } from "./canvas-data-types";
import { annotationMarker, imageAnnotations } from "./canvas-annotation-markers";
import "./canvas-native-editor.css";

type NativeContent = Extract<CanvasObject["content"], { type: "text" | "image" | "shape" }>;
type Region = NonNullable<CanvasAnchor["region"]>;
type ImageRect = { left: number; top: number; width: number; height: number };
type NativeDraft = { object_id: string; type: NativeContent["type"]; expected_revision: number; fields: CanvasContentFields };

const DRAFT_KEY = "spellcast.canvas-native-drafts.v1";
const MAX_DRAFT_BYTES = 300_000;

export function isNativeCanvasContent(content: CanvasObject["content"]): content is NativeContent {
  return content.type === "text" || content.type === "image" || content.type === "shape";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

function nativeFields(content: NativeContent): CanvasContentFields {
  switch (content.type) {
    case "text": return { title: content.title, text: content.text };
    case "image": return { title: content.title, src: content.src, alt: content.alt };
    case "shape": return { title: content.title, text: content.text, fill: content.fill };
  }
}

function validFields(value: unknown): value is CanvasContentFields {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => ["title", "text", "src", "alt", "fill"].includes(key) && typeof item === "string"));
}

function fieldsFor(type: NativeContent["type"], fields: CanvasContentFields): CanvasContentFields {
  const allowed = type === "image" ? ["title", "src", "alt"] : type === "shape" ? ["title", "text", "fill"] : ["title", "text"];
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key))) as CanvasContentFields;
}

function readDrafts(): Record<string, NativeDraft> {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return Object.create(null) as Record<string, NativeDraft>;
  if (raw.length > MAX_DRAFT_BYTES) throw new Error("Draft storage is full");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid draft storage");
  for (const [id, value] of Object.entries(parsed)) {
    const draft = value as Partial<NativeDraft> | null;
    if (!draft || draft.object_id !== id || !["text", "image", "shape"].includes(String(draft.type))
      || typeof draft.expected_revision !== "number" || !Number.isSafeInteger(draft.expected_revision) || draft.expected_revision < 0
      || !validFields(draft.fields) || Object.keys(fieldsFor(draft.type!, draft.fields)).length !== Object.keys(draft.fields).length) throw new Error("Invalid draft record");
  }
  return Object.assign(Object.create(null), parsed) as Record<string, NativeDraft>;
}

function storeDraft(draft: NativeDraft | null, id: string, expected: NativeDraft | null): boolean {
  try {
    const entries = readDrafts();
    if (contentKey(entries[id] ?? null) !== contentKey(expected)) return false;
    if (draft) entries[id] = draft; else delete entries[id];
    const next = JSON.stringify(entries);
    if (next.length > MAX_DRAFT_BYTES) return false;
    localStorage.setItem(DRAFT_KEY, next); return true;
  } catch { return false; } // Keep existing bytes and the in-memory draft on failure.
}

function changed(base: CanvasContentFields, next: CanvasContentFields): CanvasContentFields {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== base[key as keyof CanvasContentFields])) as CanvasContentFields;
}

function includesFields(content: NativeContent, fields: CanvasContentFields) {
  const current = nativeFields(content);
  return Object.entries(fields).every(([key, value]) => current[key as keyof CanvasContentFields] === value);
}

export type NativeCanvasHandlers = {
  onPatch(fields: CanvasContentFields): Promise<void>;
  getSourceTitle?(source: CanvasBinding["from"]): string | undefined;
  onSelectionChange(): void;
  onAnnotation?(id: string): void;
  onTitleChange(title: string): void;
  onError(error: unknown): void;
};

/** A DOM-only renderer for first-class canvas content. It deliberately owns no canvas state. */
export class NativeCanvasContent {
  readonly root = el("div", "canvas-native");
  private object: CanvasObject;
  private content: NativeContent;
  private active = false;
  private editing = false;
  private readonly actions = el("div", "canvas-native-actions");
  private readonly editButton = el("button", "ghost") as HTMLButtonElement;
  private busy = false;
  private conflict = false;
  private draft: NativeDraft | null;
  private persistedDraft: NativeDraft | null = null;
  private draftUnsafe = false;
  private readonly display = el("div", "canvas-native-display");
  private readonly displayTitle = el("h3", "canvas-native-heading");
  private readonly renderedText = el("div", "canvas-native-formatted");
  private renderedSource = "";
  private readonly boundValue = el("output", "canvas-native-bound-value");
  private inputs: CanvasInputSnapshot | null = null;
  private readonly editor = el("dialog", "board-dialog canvas-native-editor");
  private readonly editorTitle = el("h2");
  private readonly editorHint = el("p", "canvas-native-editor-hint");
  private readonly closeEditorButton = el("button", "ghost") as HTMLButtonElement;
  private readonly editorBinding = el("section", "canvas-native-editor-binding");
  private readonly editorBoundLabel = el("small");
  private readonly editorBindingStatus = el("small", "canvas-native-binding-status");
  private readonly editorBoundValue = el("output");
  private readonly controls = el("form", "canvas-native-controls");
  private readonly titleInput = document.createElement("input");
  private readonly textInput = document.createElement("textarea");
  private readonly srcInput = document.createElement("input");
  private readonly altInput = document.createElement("input");
  private readonly fillInput = document.createElement("input");
  private readonly saveButton = el("button", "ghost", "Save") as HTMLButtonElement;
  private readonly useDraftButton = el("button", "ghost", "Use draft") as HTMLButtonElement;
  private readonly notice = el("p", "canvas-native-notice");
  private readonly currentContent = el("pre", "canvas-native-current");
  private readonly shapeText = el("div", "canvas-native-shape-text");
  private saveError = "";
  private readonly labels = new Map<Parameters<typeof ct>[0], HTMLElement>();
  private image: HTMLImageElement | null = null;
  private imageWrap: HTMLElement | null = null;
  private regionBox: HTMLElement | null = null;
  private region: Region | undefined;
  private regionStart: { x: number; y: number } | null = null;
  private resize: ResizeObserver | null = null;
  private imageLoad = 0;
  private annotations: CanvasAnnotation[] = [];
  private readonly annotationMarkers = new Map<string, HTMLButtonElement>();

  constructor(host: HTMLElement, object: CanvasObject, private readonly handlers: NativeCanvasHandlers) {
    if (!isNativeCanvasContent(object.content)) throw new Error("Native canvas content required");
    this.object = object; this.content = object.content;
    this.draft = null;
    try {
      const saved = readDrafts()[object.id];
      if (saved && saved.type !== object.content.type) throw new Error("Draft content type changed");
      this.draft = saved ?? null; this.persistedDraft = this.draft ? structuredClone(this.draft) : null;
    } catch { this.draftUnsafe = true; }
    this.conflict = Boolean(this.draft && this.draft.expected_revision !== object.content_revision && !includesFields(object.content, this.draft.fields));
    this.titleInput.type = "text"; this.titleInput.className = "canvas-native-title";
    this.srcInput.type = "text"; this.srcInput.className = "canvas-native-src";
    this.altInput.type = "text"; this.altInput.className = "canvas-native-alt";
    this.fillInput.type = "text"; this.fillInput.className = "canvas-native-fill";
    this.textInput.className = "canvas-native-text";
    this.textInput.setAttribute("aria-label", ct("nativeText"));
    this.saveButton.type = "submit"; this.saveButton.classList.add("primary"); this.useDraftButton.type = "button";
    const titleField = this.labeled("nativeTitle", this.titleInput), srcField = this.labeled("nativeImageSource", this.srcInput);
    const altField = this.labeled("nativeAlt", this.altInput), fillField = this.labeled("nativeFill", this.fillInput);
    const textField = this.labeled("nativeText", this.textInput); textField.classList.add("canvas-native-editor-text");
    srcField.hidden = altField.hidden = object.content.type !== "image"; fillField.hidden = object.content.type !== "shape";
    textField.hidden = object.content.type === "image";
    this.editor.dataset.objectId = object.id;
    this.editorTitle.id = `native-editor-${crypto.randomUUID()}`;
    this.editor.id = `${this.editorTitle.id}-dialog`;
    this.editor.setAttribute("aria-labelledby", this.editorTitle.id);
    this.editButton.setAttribute("aria-haspopup", "dialog"); this.editButton.setAttribute("aria-controls", this.editor.id);
    const editorHead = el("header"), editorHeading = el("div"), fields = el("div", "canvas-native-editor-fields");
    const footer = el("footer", "canvas-native-editor-footer");
    this.closeEditorButton.type = "button";
    this.notice.setAttribute("role", "status"); this.notice.setAttribute("aria-live", "polite");
    editorHeading.append(this.editorTitle, this.editorHint); editorHead.append(editorHeading, this.closeEditorButton);
    const bindingHead = el("div", "canvas-native-binding-head");
    bindingHead.append(this.editorBoundLabel, this.editorBindingStatus);
    this.editorBinding.append(bindingHead, this.editorBoundValue);
    fields.append(titleField, srcField, altField, fillField, this.editorBinding, textField, this.currentContent);
    footer.append(this.notice, this.useDraftButton, this.saveButton);
    this.controls.append(fields, footer); this.editor.append(editorHead, this.controls); document.body.append(this.editor);
    this.editButton.type = "button"; this.actions.append(this.editButton);
    this.root.append(this.actions, this.display); host.append(this.root);
    this.buildDisplay();
    this.renderValues({ ...nativeFields(this.content), ...(this.draft?.fields ?? {}) });
    for (const input of [this.titleInput, this.textInput, this.srcInput, this.altInput, this.fillInput]) input.addEventListener("input", () => this.onInput());
    this.controls.addEventListener("submit", event => { event.preventDefault(); void this.save(); });
    this.useDraftButton.addEventListener("click", () => this.rebaseDraft());
    this.editButton.addEventListener("click", () => this.openEditor());
    this.closeEditorButton.addEventListener("click", () => this.closeEditor());
    this.editor.addEventListener("cancel", event => { event.preventDefault(); this.closeEditor(); });
    this.editor.addEventListener("close", () => {
      if (!this.editor.open) {
        this.editing = false; this.setActive(this.active);
        if (this.active && this.editButton.isConnected) this.editButton.focus({ preventScroll: true });
      }
    });
    this.editor.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing) {
        event.preventDefault(); if (!event.repeat && !this.saveButton.disabled) this.controls.requestSubmit();
      }
    });
    this.refreshLabels();
    this.setActive(false);
  }

  title() { return this.titleInput.value || (this.content.type === "text" ? textLabel(this.textInput.value) : this.content.title) || ct("untitledBlock"); }
  setInputs(inputs: CanvasInputSnapshot) { this.inputs = inputs; this.paintBinding(); }
  get hasUnpersistedDraft() { return Boolean(this.draft && this.draftUnsafe); }
  prepareFeedback() { if (this.draft) throw new Error(ct("nativeSaveBeforeFeedback")); }
  getRegion() { return this.region ? { ...this.region } : undefined; }
  setRegion(region: Region | undefined) {
    this.region = region && this.content.type === "image" && region.resource === this.content.src ? { ...region } : undefined;
    this.paintRegion();
  }
  setAnnotations(notes: CanvasAnnotation[]) {
    this.annotations = notes;
    this.paintRegion();
  }

  update(object: CanvasObject) {
    if (!isNativeCanvasContent(object.content) || object.id !== this.object.id) return;
    this.object = object; this.content = object.content;
    if (this.draft && includesFields(this.content, this.draft.fields)) {
      this.draft = null; this.conflict = false; this.persistDraft(null);
    } else if (this.draft) {
      this.conflict = this.draft.expected_revision !== object.content_revision;
    }
    this.renderValues({ ...nativeFields(this.content), ...(this.draft?.fields ?? {}) });
    this.refreshControls();
    this.paintBinding();
  }

  setActive(active: boolean) {
    this.active = active; if (!active) this.editing = false;
    const editing = active && this.editing;
    this.root.classList.toggle("is-active", active); this.root.classList.toggle("is-editing", editing);
    this.actions.hidden = !active; this.controls.hidden = !editing;
    if (!editing && this.editor.open) this.editor.close();
    this.refreshControls(); this.paintRegion();
    this.paintBinding();
  }
  refreshLabels() {
    for (const [key, node] of this.labels) node.textContent = ct(key);
    this.editorTitle.textContent = ct("nativeEditorTitle"); this.editorHint.textContent = ct("nativeEditorHint");
    this.closeEditorButton.textContent = ct("nativeBack");
    this.titleInput.placeholder = ct("nativeOptionalTitle");
    this.refreshControls();
    this.paintBinding();
  }

  destroy() { this.resize?.disconnect(); if (this.editor.open) this.editor.close(); this.editor.remove(); this.root.remove(); }

  private openEditor() {
    if (!this.active || this.busy || this.editor.open) return;
    this.editing = true; this.setActive(true); this.editor.showModal();
    const input = this.content.type === "image" ? this.titleInput : this.textInput;
    input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
  }

  private closeEditor() {
    if (this.busy) return;
    this.editing = false; this.setActive(this.active);
  }

  private labeled(key: Parameters<typeof ct>[0], input: HTMLElement) {
    const wrap = el("label", "canvas-native-field"), label = el("span", "", ct(key));
    this.labels.set(key, label); wrap.append(label, input); return wrap;
  }

  private buildDisplay() {
    this.display.replaceChildren(); this.resize?.disconnect(); this.resize = null;
    this.annotationMarkers.clear();
    this.display.classList.toggle("is-text", this.content.type === "text");
    if (this.content.type === "image") {
      this.imageWrap = el("div", "canvas-native-image-wrap");
      this.image = document.createElement("img"); this.image.className = "canvas-native-image";
      this.regionBox = el("div", "canvas-native-region");
      this.imageWrap.append(this.image, this.regionBox); this.display.append(this.imageWrap);
      this.image.addEventListener("load", () => this.paintRegion());
      this.image.addEventListener("pointerdown", event => this.beginRegion(event));
      this.image.addEventListener("pointermove", event => this.moveRegion(event));
      this.image.addEventListener("pointerup", event => this.finishRegion(event));
      this.image.addEventListener("pointercancel", event => this.finishRegion(event));
      this.resize = new ResizeObserver(() => this.paintRegion()); this.resize.observe(this.imageWrap);
    } else if (this.content.type === "shape") {
      const shape = el("div", `canvas-native-shape is-${this.content.shape}`);
      shape.append(this.shapeText); this.display.append(shape);
    } else {
      this.boundValue.setAttribute("aria-live", "polite");
      this.boundValue.setAttribute("aria-label", ct("boundValue"));
      this.display.append(this.displayTitle, this.boundValue, this.renderedText);
      this.paintBinding();
    }
  }

  private textBinding() {
    return this.content.type === "text" ? this.object.bindings?.find(binding => !binding.to.block_id && binding.to.port === "text") : undefined;
  }

  private paintBinding() {
    const binding = this.textBinding(), bound = Boolean(binding);
    this.boundValue.hidden = !bound; this.editorBinding.hidden = !bound;
    this.renderedText.hidden = Boolean(bound);
    const textLabel = ct(bound ? "bindingFallback" : "nativeText");
    this.labels.get("nativeText")!.textContent = textLabel;
    this.textInput.setAttribute("aria-label", textLabel);
    const source = binding && this.handlers.getSourceTitle?.(binding.from);
    const sourceLabel = source ? ct("bindingContentFrom", { source }) : ct("boundValue");
    this.editorBoundLabel.textContent = sourceLabel; this.editorBoundLabel.title = sourceLabel;
    this.boundValue.setAttribute("aria-label", sourceLabel);
    this.editorBoundValue.setAttribute("aria-label", sourceLabel);
    if (!binding) return;
    const input = this.inputs?.ports.text;
    this.editorBinding.dataset.state = input?.status ?? "unavailable";
    this.editorBindingStatus.textContent = ct(input?.status === "available" ? "bindingLive" : "bindingUnavailable");
    this.boundValue.dataset.state = input?.status ?? "unavailable";
    this.boundValue.classList.toggle("is-number", input?.status === "available" && typeof input.value === "number");
    this.boundValue.textContent = input?.status === "available" ? String(input.value) : ct("bindingContentUnavailable");
    this.boundValue.title = sourceLabel;
    this.editorBoundValue.textContent = this.boundValue.textContent;
  }

  private renderValues(fields: CanvasContentFields) {
    for (const [input, value] of [[this.titleInput, fields.title], [this.textInput, fields.text], [this.srcInput, fields.src], [this.altInput, fields.alt], [this.fillInput, fields.fill]] as const) {
      if (input.value !== (value ?? "")) input.value = value ?? "";
    }
    this.previewValues(fields);
  }

  private previewValues(fields: CanvasContentFields) {
    this.displayTitle.textContent = fields.title ?? ""; this.displayTitle.hidden = !fields.title;
    this.root.classList.toggle("is-short-thought", this.content.type === "text" && !fields.title && Boolean(fields.text?.trim()) && (fields.text?.length ?? 0) <= 100 && !fields.text?.includes("\n"));
    if (this.content.type === "text" && this.renderedSource !== fields.text) {
      this.renderedSource = fields.text || ""; renderLightText(this.renderedText, this.renderedSource);
    }
    if (this.image) {
      if (this.image.dataset.source !== (fields.src ?? "")) { this.image.dataset.source = fields.src ?? ""; this.setImageSource(fields.src ?? ""); this.region = undefined; }
      this.image.alt = fields.alt ?? "";
    }
    const shape = this.display.querySelector<HTMLElement>(".canvas-native-shape");
    if (shape) { shape.style.backgroundColor = fields.fill ?? ""; this.shapeText.textContent = fields.text ?? ""; }
    this.handlers.onTitleChange(this.title()); this.paintRegion();
  }

  private values(): CanvasContentFields {
    switch (this.content.type) {
      case "text": return { title: this.titleInput.value, text: this.textInput.value };
      case "image": return { title: this.titleInput.value, src: this.srcInput.value, alt: this.altInput.value };
      case "shape": return { title: this.titleInput.value, text: this.textInput.value, fill: this.fillInput.value };
    }
  }

  private onInput() {
    this.saveError = "";
    const fields = this.values();
    this.previewValues(fields);
    const patch = changed(nativeFields(this.content), fields);
    if (!Object.keys(patch).length) { this.draft = null; this.conflict = false; this.persistDraft(null); }
    else {
      this.draft = { object_id: this.object.id, type: this.content.type, expected_revision: this.draft?.expected_revision ?? this.object.content_revision, fields: patch };
      this.persistDraft(this.draft);
    }
    this.refreshControls();
  }

  private async save() {
    if (!this.active || !this.editing || this.busy || this.conflict) return;
    const patch = changed(nativeFields(this.content), this.values());
    if (!Object.keys(patch).length) { this.draft = null; this.persistDraft(null); this.refreshControls(); return; }
    this.busy = true; this.saveError = ""; this.refreshControls();
    try { await this.handlers.onPatch(patch); }
    catch (error) { this.saveError = error instanceof Error ? error.message : String(error); this.handlers.onError(error); }
    finally { this.busy = false; if (!this.draft) { this.editing = false; this.setActive(this.active); } this.refreshControls(); }
  }

  private rebaseDraft() {
    if (!this.draft) return;
    this.draft.expected_revision = this.object.content_revision; this.conflict = false;
    this.persistDraft(this.draft); this.refreshControls();
  }

  private persistDraft(draft: NativeDraft | null) {
    this.draftUnsafe = !storeDraft(draft, this.object.id, this.persistedDraft);
    if (!this.draftUnsafe) this.persistedDraft = draft ? structuredClone(draft) : null;
  }

  private refreshControls() {
    const dirty = Boolean(this.draft);
    this.editButton.textContent = this.editing ? ct("nativeBack") : dirty ? `${ct("edit")} · ${ct("nativeDraft")}` : ct("edit");
    this.editButton.setAttribute("aria-expanded", String(this.editing));
    this.editButton.disabled = this.busy;
    this.closeEditorButton.disabled = this.busy;
    for (const input of [this.titleInput, this.textInput, this.srcInput, this.altInput, this.fillInput]) input.readOnly = !this.active || !this.editing || this.busy;
    this.saveButton.disabled = !this.active || !dirty || this.busy || this.conflict;
    this.saveButton.textContent = this.busy ? ct("nativeSaving") : ct("nativeSave");
    this.useDraftButton.hidden = !this.conflict; this.useDraftButton.disabled = !this.active || this.busy;
    this.useDraftButton.textContent = ct("nativeUseDraft");
    const saveHelp = this.textBinding() ? ct(dirty ? "bindingDraftHelp" : "bindingSaveHelp") : dirty ? ct("nativeDraft") : "";
    this.notice.textContent = this.draftUnsafe ? ct("draftUnsafe") : this.conflict ? ct("nativeConflict") : this.saveError || saveHelp;
    this.notice.classList.toggle("has-error", Boolean(this.saveError || this.draftUnsafe || this.conflict));
    this.currentContent.hidden = !this.conflict;
    this.currentContent.setAttribute("aria-label", ct("proposalCurrent"));
    const labels = { title: "nativeTitle", text: "nativeText", src: "nativeImageSource", alt: "nativeAlt", fill: "nativeFill" } as const;
    this.currentContent.textContent = this.conflict ? Object.entries(nativeFields(this.content)).filter(([key]) => key in (this.draft?.fields ?? {}))
      .map(([key, value]) => `${ct(labels[key as keyof typeof labels])}: ${value}`).join("\n\n") : "";
  }

  private imageContentRect(): ImageRect | null {
    if (!this.image || !this.imageWrap || !this.image.naturalWidth || !this.image.naturalHeight) return null;
    const box = this.image.getBoundingClientRect(), ratio = this.image.naturalWidth / this.image.naturalHeight;
    if (!box.width || !box.height) return null;
    if (box.width / box.height > ratio) {
      const width = box.height * ratio; return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
    }
    const height = box.width / ratio; return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height };
  }

  private setImageSource(source: string) {
    const image = this.image; if (!image) return;
    const token = ++this.imageLoad;
    if (/^\/artifacts\/[^\s]+$/i.test(source)) {
      void apiBase().then(base => {
        if (token === this.imageLoad && this.image) this.image.src = new URL(source, base).toString();
      }).catch(() => { if (token === this.imageLoad && this.image) this.image.removeAttribute("src"); });
      return;
    }
    image.src = /^(https?:|data:image\/(?:png|jpeg|webp);base64,)/i.test(source) ? source : "";
  }

  private point(event: PointerEvent, clamp = false) {
    const rect = this.imageContentRect(); if (!rect) return null;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    const inside = event.clientX >= rect.left && event.clientX <= rect.left + rect.width && event.clientY >= rect.top && event.clientY <= rect.top + rect.height;
    return inside || clamp ? { x, y } : null;
  }

  private beginRegion(event: PointerEvent) {
    if (!this.active || event.button !== 0 || this.content.type !== "image" || this.srcInput.value !== this.content.src) return;
    const point = this.point(event); if (!point) return;
    event.preventDefault(); event.stopPropagation(); this.regionStart = point; this.region = { resource: this.content.src, unit: "normalized", x: point.x, y: point.y, width: 0, height: 0 };
    this.image?.setPointerCapture(event.pointerId); this.paintRegion();
  }

  private moveRegion(event: PointerEvent) {
    if (!this.regionStart || this.content.type !== "image") return;
    const point = this.point(event, true); if (!point) return;
    const x = Math.min(this.regionStart.x, point.x), y = Math.min(this.regionStart.y, point.y);
    this.region = { resource: this.content.src, unit: "normalized", x, y, width: Math.abs(point.x - this.regionStart.x), height: Math.abs(point.y - this.regionStart.y) };
    this.paintRegion();
  }

  private finishRegion(event: PointerEvent) {
    if (!this.regionStart) return;
    this.moveRegion(event); this.regionStart = null;
    if (this.region && (!this.region.width || !this.region.height)) this.region = undefined;
    if (this.image?.hasPointerCapture(event.pointerId)) this.image.releasePointerCapture(event.pointerId);
    this.handlers.onSelectionChange();
  }

  private paintAnnotations(rect: ImageRect | null, wrap: DOMRect | undefined) {
    const notes = this.content.type === "image" ? imageAnnotations({ revision: 0, objects: [], items: [], annotations: this.annotations } satisfies CanvasLayout,
      this.object.id, this.content.src) : [];
    const seen = new Set(notes.map(note => note.id));
    for (const [id, marker] of this.annotationMarkers) {
      if (!seen.has(id)) { marker.remove(); this.annotationMarkers.delete(id); }
    }
    for (const [index, note] of notes.entries()) {
      const signature = `${index}\u0000${note.text}`;
      let marker = this.annotationMarkers.get(note.id);
      if (!marker || marker.dataset.annotationSignature !== signature) {
        const next = annotationMarker(note, index, id => this.handlers.onAnnotation?.(id));
        next.dataset.annotationSignature = signature;
        marker?.replaceWith(next); this.annotationMarkers.set(note.id, next); marker = next;
      }
      if (!marker) continue;
      this.imageWrap?.append(marker);
      const visible = Boolean(rect && wrap && this.imageWrap);
      marker.hidden = !visible;
      if (!visible || !rect || !wrap || !this.imageWrap) continue;
      const scaleX = wrap.width / this.imageWrap.offsetWidth, scaleY = wrap.height / this.imageWrap.offsetHeight;
      Object.assign(marker.style, {
        left: `${(rect.left - wrap.left + note.region.x * rect.width) / scaleX}px`,
        top: `${(rect.top - wrap.top + note.region.y * rect.height) / scaleY}px`,
        width: `${note.region.width * rect.width / scaleX}px`,
        height: `${note.region.height * rect.height / scaleY}px`,
      });
    }
  }

  private paintRegion() {
    const rect = this.imageContentRect(), wrap = this.imageWrap?.getBoundingClientRect();
    this.paintAnnotations(rect, wrap);
    if (!this.regionBox) return;
    const visible = Boolean(this.active && this.region && rect && wrap);
    this.regionBox.hidden = !visible;
    if (!visible || !this.region || !rect || !wrap) return;
    const scaleX = wrap.width / this.imageWrap!.offsetWidth, scaleY = wrap.height / this.imageWrap!.offsetHeight;
    this.regionBox.style.left = `${(rect.left - wrap.left + this.region.x * rect.width) / scaleX}px`;
    this.regionBox.style.top = `${(rect.top - wrap.top + this.region.y * rect.height) / scaleY}px`;
    this.regionBox.style.width = `${this.region.width * rect.width / scaleX}px`;
    this.regionBox.style.height = `${this.region.height * rect.height / scaleY}px`;
  }
}
