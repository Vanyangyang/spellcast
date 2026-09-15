import "./canvas-insert.css";
import type { CanvasContent } from "./types";
import type { StructuredAtom } from "./canvas-blocks";
import { currentLocale, type Locale } from "./i18n";

/** Everything the dialog can insert. Shapes are split so the picker stays flat. */
export type InsertKind = "text" | "image" | "rect" | "ellipse" | "comparison" | "graph" | "sequence";
const KINDS: InsertKind[] = ["text", "image", "rect", "ellipse", "comparison", "graph", "sequence"];
const DEFAULT_FILL = "#d8ebe4";
const TITLE_LIMIT = 160;

type Strings = {
  heading: string; help: string; kindLegend: string; kind: Record<InsertKind, string>;
  title: string; titleOptional: string; text: string; shapeText: string; graphDetail: string; stepAction: string;
  src: string; srcHint: string; alt: string; fill: string; cancel: string; add: string; adding: string;
  needTitle: string; needText: string; needSrc: string; badSrc: string; badFill: string; longTitle: string;
  criterion: string; optionA: string; optionB: string; pending: string; firstStep: string; submitHint: string;
};

const STRINGS: Record<Locale, Strings> = {
  "zh-CN": {
    heading: "添加组件", help: "选择一种组件，填好初始内容后加入画布。比较、关系图和步骤会以可编辑的占位内容开始。",
    kindLegend: "组件类型",
    kind: { text: "文字", image: "图片", rect: "矩形", ellipse: "椭圆", comparison: "比较", graph: "关系图", sequence: "步骤" },
    title: "标题", titleOptional: "标题（可选）", text: "正文", shapeText: "图形内文字（可选）", graphDetail: "首个节点说明（可选）", stepAction: "第一步内容（可选）",
    src: "图片地址", srcHint: "支持 http(s) 链接或 /artifacts/… 本地资源路径。", alt: "图片说明（可选）", fill: "填充色",
    cancel: "取消", add: "添加", adding: "正在添加…",
    needTitle: "请填写标题。", needText: "文字组件需要正文。", needSrc: "请填写图片地址。",
    badSrc: "图片地址只支持 http(s) 链接、/artifacts/… 本地资源路径，或 PNG/JPEG/WebP 的 base64 data URL。",
    badFill: "填充色只支持 #RGB 或 #RRGGBB。", longTitle: "标题最多 160 字。",
    criterion: "维度", optionA: "方案 A", optionB: "方案 B", pending: "待填写", firstStep: "第一步",
    submitHint: "Enter 添加，Esc 取消；多行输入中用 Ctrl+Enter 添加。",
  },
  en: {
    heading: "Add a component", help: "Pick a component, fill in its starting content, and add it to the canvas. Comparison, graph and sequence start with editable placeholder content.",
    kindLegend: "Component type",
    kind: { text: "Text", image: "Image", rect: "Rectangle", ellipse: "Ellipse", comparison: "Comparison", graph: "Graph", sequence: "Sequence" },
    title: "Title", titleOptional: "Title (optional)", text: "Body", shapeText: "Text inside the shape (optional)", graphDetail: "First node detail (optional)", stepAction: "First step content (optional)",
    src: "Image address", srcHint: "An http(s) link or a local /artifacts/… resource path.", alt: "Image description (optional)", fill: "Fill color",
    cancel: "Cancel", add: "Add", adding: "Adding…",
    needTitle: "Please enter a title.", needText: "A text component needs a body.", needSrc: "Please enter an image address.",
    badSrc: "Image addresses may be an http(s) link, a local /artifacts/… resource path, or a PNG/JPEG/WebP base64 data URL.",
    badFill: "Fill color must be #RGB or #RRGGBB.", longTitle: "The title may have at most 160 characters.",
    criterion: "Criterion", optionA: "Option A", optionB: "Option B", pending: "To be filled in", firstStep: "Step 1",
    submitHint: "Enter adds, Esc cancels; in multi-line fields use Ctrl+Enter.",
  },
  ja: {
    heading: "コンポーネントを追加", help: "種類を選び、初期内容を入力してキャンバスに追加します。比較・関係図・手順は編集可能なプレースホルダーから始まります。",
    kindLegend: "コンポーネントの種類",
    kind: { text: "テキスト", image: "画像", rect: "長方形", ellipse: "楕円", comparison: "比較", graph: "関係図", sequence: "手順" },
    title: "タイトル", titleOptional: "タイトル（任意）", text: "本文", shapeText: "図形内のテキスト（任意）", graphDetail: "最初のノードの説明（任意）", stepAction: "最初のステップの内容（任意）",
    src: "画像のアドレス", srcHint: "http(s) リンク、または /artifacts/… のローカルリソースパス。", alt: "画像の説明（任意）", fill: "塗り色",
    cancel: "キャンセル", add: "追加", adding: "追加中…",
    needTitle: "タイトルを入力してください。", needText: "テキストには本文が必要です。", needSrc: "画像のアドレスを入力してください。",
    badSrc: "画像のアドレスは http(s) リンク、/artifacts/… のローカルパス、または PNG/JPEG/WebP の base64 data URL のみ使えます。",
    badFill: "塗り色は #RGB または #RRGGBB のみ使えます。", longTitle: "タイトルは 160 文字までです。",
    criterion: "観点", optionA: "案 A", optionB: "案 B", pending: "未記入", firstStep: "ステップ 1",
    submitHint: "Enter で追加、Esc でキャンセル。複数行入力では Ctrl+Enter。",
  },
};

function strings(): Strings { return STRINGS[currentLocale()] ?? STRINGS.en; }

/** The user's typed values. They survive kind changes and failed submissions. */
export type InsertDraft = { kind: InsertKind; title: string; text: string; src: string; alt: string; fill: string };

function chars(value: string) { return [...value].length; }

/** Mirrors the core's `validate_image_src` closely enough to reject obvious mistakes before a round trip. */
export function validImageSrc(src: string): boolean {
  if (!src || /[\s\p{Cc}]/u.test(src)) return false;
  if (/^https?:\/\/\S+$/i.test(src)) return true;
  if (/^\/artifacts\/[^/]+\/.+/.test(src)) return true;
  const data = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  return Boolean(data && data[2].length % 4 === 0);
}

export function validFill(fill: string): boolean { return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(fill); }

function placeholderAtom(kind: "comparison" | "graph" | "sequence", title: string, text: string, s: Strings): StructuredAtom {
  const id = crypto.randomUUID();
  switch (kind) {
    case "comparison": return { type: "comparison", id, title, criteria: [s.criterion], options: [
      { id: crypto.randomUUID(), title: s.optionA, summary: "", values: [s.pending] },
      { id: crypto.randomUUID(), title: s.optionB, summary: "", values: [s.pending] },
    ] };
    case "graph": return { type: "graph", id, title, nodes: [{ id: crypto.randomUUID(), title, detail: text }], edges: [] };
    case "sequence": return { type: "sequence", id, title, steps: [{ id: crypto.randomUUID(), title: s.firstStep, action: text || s.pending, feedback: "", note: "" }] };
  }
}

/** Turns a draft into a `CanvasContent` payload or a localized error. Pure, so the check script can drive it directly. */
export function buildInsertContent(draft: InsertDraft, locale: Locale = currentLocale()): { content: CanvasContent } | { error: string } {
  const s = STRINGS[locale] ?? STRINGS.en;
  const title = draft.title.trim(), text = draft.text.trim(), src = draft.src.trim(), alt = draft.alt.trim(), fill = draft.fill.trim();
  if (chars(title) > TITLE_LIMIT) return { error: s.longTitle };
  switch (draft.kind) {
    case "text":
      if (!text) return { error: s.needText };
      return { content: { type: "text", title, text } };
    case "image":
      if (!src) return { error: s.needSrc };
      if (!validImageSrc(src)) return { error: s.badSrc };
      return { content: { type: "image", title, src, alt } };
    case "rect": case "ellipse":
      if (!validFill(fill)) return { error: s.badFill };
      return { content: { type: "shape", title, shape: draft.kind, fill, text } };
    case "comparison": case "graph": case "sequence":
      if (!title) return { error: s.needTitle };
      return { content: { type: "block", block: placeholderAtom(draft.kind, title, text, s) } };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}

export type CanvasInsertDialog = { show(): void; destroy(): void };

/** A bounded insert dialog: it owns its `<dialog>`, keeps drafts across kind changes and failures, and only calls `onInsert` once per submit. */
export function canvasInsert(onInsert: (content: CanvasContent) => Promise<void>): CanvasInsertDialog {
  const uid = `canvas-insert-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = el("dialog", "board-dialog canvas-insert");
  dialog.setAttribute("aria-labelledby", `${uid}-heading`);
  document.body.append(dialog);

  const heading = el("h2", "", ""); heading.id = `${uid}-heading`;
  const close = el("button", "ghost canvas-insert-close"); close.type = "button"; close.setAttribute("aria-label", "");
  close.textContent = "×";
  const header = el("header"); header.append(heading, close);
  const help = el("p", "canvas-insert-help");

  const form = el("form", "canvas-insert-form"); form.noValidate = true;
  const picker = el("fieldset", "canvas-insert-kinds"); const legend = el("legend"); picker.append(legend);
  const radios = new Map<InsertKind, { input: HTMLInputElement; label: HTMLLabelElement }>();
  for (const kind of KINDS) {
    const input = el("input"); input.type = "radio"; input.name = `${uid}-kind`; input.value = kind; input.id = `${uid}-kind-${kind}`;
    const label = el("label", "canvas-insert-kind"); label.htmlFor = input.id; label.dataset.kind = kind;
    picker.append(input, label); radios.set(kind, { input, label });
  }

  function field<K extends "input" | "textarea">(tag: K, name: string): { wrap: HTMLDivElement; label: HTMLLabelElement; control: HTMLElementTagNameMap[K]; hint: HTMLElement } {
    const wrap = el("div", `canvas-insert-field canvas-insert-${name}`);
    const control = el(tag); control.id = `${uid}-${name}`; control.name = name;
    const label = el("label"); label.htmlFor = control.id;
    const hint = el("small", "canvas-insert-hint"); hint.id = `${uid}-${name}-hint`; hint.hidden = true;
    wrap.append(label, control, hint);
    return { wrap, label, control, hint };
  }
  const title = field("input", "title"); title.control.type = "text"; title.control.maxLength = 400; title.control.autocomplete = "off";
  const text = field("textarea", "text"); text.control.rows = 4;
  const src = field("input", "src"); src.control.type = "text"; src.control.autocomplete = "off"; src.control.spellcheck = false;
  src.control.setAttribute("aria-describedby", src.hint.id); src.hint.hidden = false;
  const alt = field("input", "alt"); alt.control.type = "text"; alt.control.autocomplete = "off";
  const fill = field("input", "fill"); fill.control.type = "color"; fill.control.value = DEFAULT_FILL;

  const error = el("p", "canvas-insert-error"); error.setAttribute("role", "alert"); error.id = `${uid}-error`; error.hidden = true;
  const submitHint = el("small", "canvas-insert-submit-hint");
  const cancel = el("button", "canvas-insert-cancel"); cancel.type = "button";
  const submit = el("button", "primary canvas-insert-submit"); submit.type = "submit";
  const actions = el("div", "canvas-insert-actions"); actions.append(submitHint, cancel, submit);
  form.append(picker, title.wrap, text.wrap, src.wrap, alt.wrap, fill.wrap, error, actions);
  dialog.append(header, help, form);

  let kind: InsertKind = "text";
  let busy = false, destroyed = false, epoch = 0;

  function applyStrings() {
    const s = strings();
    heading.textContent = s.heading; help.textContent = s.help; legend.textContent = s.kindLegend;
    close.setAttribute("aria-label", s.cancel); close.title = s.cancel;
    for (const [k, { label }] of radios) label.textContent = s.kind[k];
    const block = kind === "comparison" || kind === "graph" || kind === "sequence";
    title.label.textContent = block ? s.title : s.titleOptional;
    text.label.textContent = kind === "rect" || kind === "ellipse" ? s.shapeText : kind === "graph" ? s.graphDetail : kind === "sequence" ? s.stepAction : s.text;
    src.label.textContent = s.src; src.hint.textContent = s.srcHint; alt.label.textContent = s.alt; fill.label.textContent = s.fill;
    cancel.textContent = s.cancel; submit.textContent = busy ? s.adding : s.add; submitHint.textContent = s.submitHint;
  }

  function applyKind(next: InsertKind) {
    kind = next;
    for (const [k, { input, label }] of radios) { input.checked = k === kind; label.classList.toggle("is-on", k === kind); }
    dialog.dataset.kind = kind;
    const shape = kind === "rect" || kind === "ellipse";
    title.wrap.hidden = false;
    text.wrap.hidden = kind === "image" || kind === "comparison";
    src.wrap.hidden = kind !== "image"; alt.wrap.hidden = kind !== "image";
    fill.wrap.hidden = !shape;
    title.control.required = kind === "comparison" || kind === "graph" || kind === "sequence";
    text.control.required = kind === "text"; src.control.required = kind === "image";
    applyStrings();
  }

  function draft(): InsertDraft {
    return { kind, title: title.control.value, text: text.control.value, src: src.control.value, alt: alt.control.value, fill: fill.control.value };
  }

  function showError(message: string) {
    error.textContent = message; error.hidden = !message;
    for (const control of [title.control, text.control, src.control, fill.control]) {
      if (message) control.setAttribute("aria-describedby", error.id); else control.removeAttribute("aria-describedby");
    }
    src.control.setAttribute("aria-describedby", message ? `${src.hint.id} ${error.id}` : src.hint.id);
  }

  function focusFor(message: string) {
    const s = strings();
    if (message === s.needTitle || message === s.longTitle) return title.control;
    if (message === s.needText) return text.control;
    if (message === s.needSrc || message === s.badSrc) return src.control;
    if (message === s.badFill) return fill.control;
    return submit;
  }

  function setBusy(next: boolean) {
    busy = next; dialog.setAttribute("aria-busy", String(next)); dialog.classList.toggle("is-busy", next);
    submit.disabled = next; cancel.disabled = next; close.disabled = next;
    for (const { input } of radios.values()) input.disabled = next;
    for (const control of [title.control, text.control, src.control, alt.control]) control.readOnly = next;
    fill.control.disabled = next; // Color inputs ignore readOnly; disabled still keeps the chosen value.
    submit.textContent = next ? strings().adding : strings().add;
  }

  function reset() {
    title.control.value = ""; text.control.value = ""; src.control.value = ""; alt.control.value = ""; fill.control.value = DEFAULT_FILL;
    showError("");
  }

  async function submitDraft() {
    if (busy || destroyed) return;
    const result = buildInsertContent(draft());
    if ("error" in result) { showError(result.error); focusFor(result.error).focus(); return; }
    const own = epoch;
    showError(""); setBusy(true);
    try {
      await onInsert(result.content);
      if (destroyed || own !== epoch) return;
      setBusy(false); reset();
      if (dialog.open) dialog.close("inserted");
    } catch (failure) {
      if (destroyed || own !== epoch) return;
      setBusy(false);
      showError(failure instanceof Error && failure.message ? failure.message : String(failure));
      submit.focus();
    }
  }

  picker.addEventListener("change", () => {
    const picked = [...radios.entries()].find(([, { input }]) => input.checked)?.[0];
    if (picked && picked !== kind) { applyKind(picked); showError(""); }
  });
  form.addEventListener("submit", event => { event.preventDefault(); void submitDraft(); });
  text.control.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submitDraft(); }
  });
  cancel.addEventListener("click", () => { if (!busy) dialog.close("cancel"); });
  close.addEventListener("click", () => { if (!busy) dialog.close("cancel"); });
  // Escape must not abandon an in-flight submission; the result would land on a closed dialog.
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { epoch++; if (busy) setBusy(false); });

  applyKind(kind);

  return {
    show() {
      if (destroyed) return;
      applyStrings(); showError("");
      if (!dialog.open) dialog.showModal();
      title.control.focus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; epoch++;
      if (dialog.open) dialog.close("destroyed");
      dialog.remove();
    },
  };
}
