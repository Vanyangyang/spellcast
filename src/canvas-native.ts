import type { CanvasAnchor, CanvasContentFields, CanvasObject } from "./types";
import { apiBase } from "./api";
import { contentKey } from "./reply-drafts";
import { ct } from "./i18n/canvas";
import type { CanvasInputSnapshot } from "./canvas-data-types";

type NativeContent = Extract<CanvasObject["content"], { type: "text" | "image" | "shape" }>;
type Region = NonNullable<CanvasAnchor["region"]>;
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
  onSelectionChange(): void;
  onTitleChange(title: string): void;
  onError(error: unknown): void;
};

/** A DOM-only renderer for first-class canvas content. It deliberately owns no canvas state. */
export class NativeCanvasContent {
  readonly root = el("div", "canvas-native");
  private object: CanvasObject;
  private content: NativeContent;
  private active = false;
  private busy = false;
  private conflict = false;
  private draft: NativeDraft | null;
  private persistedDraft: NativeDraft | null = null;
  private draftUnsafe = false;
  private readonly display = el("div", "canvas-native-display");
  private readonly displayTitle = el("h3", "canvas-native-heading");
  private readonly boundValue = el("output", "canvas-native-bound-value");
  private readonly fallbackHint = el("small", "canvas-native-fallback");
  private inputs: CanvasInputSnapshot | null = null;
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
  private readonly labels = new Map<Parameters<typeof ct>[0], HTMLElement>();
  private image: HTMLImageElement | null = null;
  private imageWrap: HTMLElement | null = null;
  private regionBox: HTMLElement | null = null;
  private region: Region | undefined;
  private regionStart: { x: number; y: number } | null = null;
  private resize: ResizeObserver | null = null;
  private imageLoad = 0;

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
    this.saveButton.type = "submit"; this.useDraftButton.type = "button";
    const titleField = this.labeled("nativeTitle", this.titleInput), srcField = this.labeled("nativeImageSource", this.srcInput);
    const altField = this.labeled("nativeAlt", this.altInput), fillField = this.labeled("nativeFill", this.fillInput);
    srcField.hidden = altField.hidden = object.content.type !== "image"; fillField.hidden = object.content.type !== "shape";
    this.controls.append(titleField, srcField, altField, fillField, this.notice, this.currentContent, this.useDraftButton, this.saveButton);
    this.root.append(this.display, this.controls); host.append(this.root);
    this.buildDisplay();
    this.renderValues({ ...nativeFields(this.content), ...(this.draft?.fields ?? {}) });
    for (const input of [this.titleInput, this.textInput, this.srcInput, this.altInput, this.fillInput]) input.addEventListener("input", () => this.onInput());
    this.controls.addEventListener("submit", event => { event.preventDefault(); void this.save(); });
    this.useDraftButton.addEventListener("click", () => this.rebaseDraft());
    this.setActive(false);
  }

  title() { return this.titleInput.value || this.content.title; }
  setInputs(inputs: CanvasInputSnapshot) { this.inputs = inputs; this.paintBinding(); }
  get hasUnpersistedDraft() { return Boolean(this.draft && this.draftUnsafe); }
  prepareFeedback() { if (this.draft) throw new Error(ct("nativeSaveBeforeFeedback")); }
  getRegion() { return this.region ? { ...this.region } : undefined; }
  setRegion(region: Region | undefined) {
    this.region = region && this.content.type === "image" && region.resource === this.content.src ? { ...region } : undefined;
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
    this.active = active; this.root.classList.toggle("is-active", active); this.controls.hidden = !active;
    this.textInput.readOnly = !active;
    this.titleInput.readOnly = !active; this.srcInput.readOnly = !active; this.altInput.readOnly = !active; this.fillInput.disabled = !active;
    this.refreshControls(); this.paintRegion();
    this.paintBinding();
  }
  refreshLabels() {
    for (const [key, node] of this.labels) node.textContent = ct(key);
    this.textInput.setAttribute("aria-label", ct("nativeText"));
    this.refreshControls();
    this.paintBinding();
  }

  destroy() { this.resize?.disconnect(); this.root.remove(); }

  private labeled(key: Parameters<typeof ct>[0], input: HTMLElement) {
    const wrap = el("label", "canvas-native-field"), label = el("span", "", ct(key));
    this.labels.set(key, label); wrap.append(label, input); return wrap;
  }

  private buildDisplay() {
    this.display.replaceChildren(); this.resize?.disconnect(); this.resize = null;
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
      shape.append(this.textInput); this.display.append(shape);
    } else {
      this.boundValue.setAttribute("aria-live", "polite");
      this.boundValue.setAttribute("aria-label", ct("boundValue"));
      this.display.append(this.displayTitle, this.boundValue, this.fallbackHint, this.textInput);
      this.paintBinding();
    }
  }

  private paintBinding() {
    const bound = this.content.type === "text" && this.object.bindings?.some(binding => !binding.to.block_id && binding.to.port === "text");
    this.boundValue.hidden = !bound; this.fallbackHint.hidden = !bound || !this.active;
    this.textInput.hidden = Boolean(bound && !this.active);
    this.fallbackHint.textContent = ct("bindingFallback");
    this.boundValue.setAttribute("aria-label", ct("boundValue"));
    if (!bound) return;
    const input = this.inputs?.ports.text;
    this.boundValue.dataset.state = input?.status ?? "unavailable";
    this.boundValue.textContent = input?.status === "available" ? String(input.value) : ct("inputUnavailable");
    this.boundValue.title = input?.reason ?? "";
  }

  private renderValues(fields: CanvasContentFields) {
    for (const [input, value] of [[this.titleInput, fields.title], [this.textInput, fields.text], [this.srcInput, fields.src], [this.altInput, fields.alt], [this.fillInput, fields.fill]] as const) {
      if (input.value !== (value ?? "")) input.value = value ?? "";
    }
    this.previewValues(fields);
  }

  private previewValues(fields: CanvasContentFields) {
    this.displayTitle.textContent = fields.title ?? ""; this.displayTitle.hidden = !fields.title;
    if (this.image) {
      if (this.image.dataset.source !== (fields.src ?? "")) { this.image.dataset.source = fields.src ?? ""; this.setImageSource(fields.src ?? ""); this.region = undefined; }
      this.image.alt = fields.alt ?? "";
    }
    const shape = this.display.querySelector<HTMLElement>(".canvas-native-shape");
    if (shape) shape.style.backgroundColor = fields.fill ?? "";
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
    if (!this.active || this.busy || this.conflict) return;
    const patch = changed(nativeFields(this.content), this.values());
    if (!Object.keys(patch).length) { this.draft = null; this.persistDraft(null); this.refreshControls(); return; }
    this.busy = true; this.refreshControls();
    try { await this.handlers.onPatch(patch); }
    catch (error) { this.handlers.onError(error); }
    finally { this.busy = false; this.refreshControls(); }
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
    this.saveButton.disabled = !this.active || !dirty || this.busy || this.conflict;
    this.saveButton.textContent = this.busy ? ct("nativeSaving") : ct("nativeSave");
    this.useDraftButton.hidden = !this.conflict; this.useDraftButton.disabled = !this.active;
    this.useDraftButton.textContent = ct("nativeUseDraft");
    this.notice.textContent = this.draftUnsafe ? ct("draftUnsafe") : this.conflict ? ct("nativeConflict") : dirty ? ct("nativeDraft") : "";
    this.currentContent.hidden = !this.conflict;
    this.currentContent.setAttribute("aria-label", ct("proposalCurrent"));
    const labels = { title: "nativeTitle", text: "nativeText", src: "nativeImageSource", alt: "nativeAlt", fill: "nativeFill" } as const;
    this.currentContent.textContent = this.conflict ? Object.entries(nativeFields(this.content)).filter(([key]) => key in (this.draft?.fields ?? {}))
      .map(([key, value]) => `${ct(labels[key as keyof typeof labels])}: ${value}`).join("\n\n") : "";
  }

  private imageContentRect() {
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

  private paintRegion() {
    if (!this.regionBox) return;
    const rect = this.imageContentRect(), wrap = this.imageWrap?.getBoundingClientRect();
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
