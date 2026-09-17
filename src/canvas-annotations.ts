import type { BoardSnapshot, CanvasAnchor, CanvasAnnotation, CanvasBatchRequest, CanvasObject, CanvasRead } from "./types";
import type { ReplyBlock, ReplyArtifactReference } from "./reply-types";
import { currentLocale, onLocale, type Locale } from "./i18n";
import { renderLightText } from "./light-text";
import { referencePreview, referenceState, targetExists } from "./reply-image";
import { artifactReferencePreview } from "./reply-artifact";
import "./canvas-annotations.css";

const TEXT_LIMIT = 8000;
const DRAFT_PREFIX = "spellcast.canvas-annotation-draft.v1:";

type Words = {
  heading: string;
  help: string;
  current: string;
  workspace: string;
  showRemoved: string;
  hideRemoved: string;
  add: string;
  close: string;
  empty: string;
  removedEmpty: string;
  authorYou: string;
  authorAgent: string;
  updated: string;
  removed: string;
  noteRemoved: string;
  unavailable: string;
  original: string;
  annotation: string;
  edit: string;
  view: string;
  discuss: string;
  remove: string;
  restore: string;
  editorNew: string;
  editorEdit: string;
  source: string;
  characters: string;
  cancelEdit: string;
  save: string;
  saving: string;
  selectTarget: string;
  targetRequired: string;
  textRequired: string;
  textTooLong: string;
  sourceConflict: string;
  annotationConflict: string;
  saveFailed: string;
  draftUnsafe: string;
  draftRestored: string;
  artifact: string;
  artifactPreview: string;
  artifactState: string;
  footer: string;
  untitled: string;
  noContent: string;
};

const WORDS: Record<Locale, Words> = {
  "zh-CN": {
    heading: "注释", help: "注释会保留当前内容的快照。保存只更新画布，不会启动任务。",
    current: "当前内容", workspace: "工作区全部", showRemoved: "显示已移除注释", hideRemoved: "隐藏已移除注释",
    add: "添加注释", close: "关闭", empty: "这里还没有注释。", removedEmpty: "没有已移除的注释。",
    authorYou: "你", authorAgent: "Agent", updated: "来源已更新", removed: "来源已移除", unavailable: "来源暂不可用",
    original: "原内容", annotation: "注释", noteRemoved: "注释已移除", edit: "编辑", view: "查看指向", discuss: "讨论这条注释",
    remove: "移除", restore: "恢复", editorNew: "添加注释", editorEdit: "编辑注释", source: "指向",
    characters: "字符", cancelEdit: "收起", save: "保存到画布", saving: "正在保存…", selectTarget: "重新选择目标",
    targetRequired: "请先在画布中选择一个内容。", textRequired: "请填写注释内容。", textTooLong: "注释最多 8000 个字符。",
    sourceConflict: "来源版本已变化。请明确重新选择目标后再保存；草稿已保留。",
    annotationConflict: "这条注释已被更新。草稿已保留，请查看最新内容后决定如何继续。",
    saveFailed: "保存失败", draftUnsafe: "无法写入本地草稿；当前文本仍保留在面板中。",
    draftRestored: "已恢复未保存草稿。", artifact: "作品状态快照", artifactPreview: "作品预览", artifactState: "已保留的状态说明",
    footer: "保存不会启动任务；最后点击 Canvas 的发送按钮，才会交给原任务。", untitled: "未命名内容", noContent: "未保存可显示的原文。",
  },
  en: {
    heading: "Annotations", help: "Annotations keep a snapshot of the selected content. Saving only updates the canvas; it does not start a task.",
    current: "Current content", workspace: "Entire workspace", showRemoved: "Show removed annotations", hideRemoved: "Hide removed annotations",
    add: "Add annotation", close: "Close", empty: "There are no annotations here yet.", removedEmpty: "There are no removed annotations.",
    authorYou: "You", authorAgent: "Agent", updated: "Source updated", removed: "Source removed", unavailable: "Source unavailable",
    original: "Original content", annotation: "Annotation", noteRemoved: "Annotation removed", edit: "Edit", view: "View target", discuss: "Discuss this annotation",
    remove: "Remove", restore: "Restore", editorNew: "Add annotation", editorEdit: "Edit annotation", source: "Target",
    characters: "characters", cancelEdit: "Collapse", save: "Save to canvas", saving: "Saving…", selectTarget: "Select target again",
    targetRequired: "Select one item on the canvas first.", textRequired: "Enter annotation text.", textTooLong: "Annotations may contain at most 8,000 characters.",
    sourceConflict: "The source version changed. Explicitly select the target again before saving; the draft is preserved.",
    annotationConflict: "This annotation changed. The draft is preserved; inspect the latest content before deciding how to continue.",
    saveFailed: "Save failed", draftUnsafe: "The local draft could not be written; the current text remains in this panel.",
    draftRestored: "An unsaved draft was restored.", artifact: "Artifact state snapshot", artifactPreview: "Artifact preview", artifactState: "Preserved state note",
    footer: "Saving does not start a task. Only the final Canvas Send action passes it to the original task.", untitled: "Untitled content", noContent: "No displayable original text was saved.",
  },
  ja: {
    heading: "注釈", help: "注釈には選択中コンテンツのスナップショットが残ります。保存はキャンバスだけを更新し、タスクは開始しません。",
    current: "現在の内容", workspace: "ワークスペース全体", showRemoved: "削除済みの注釈を表示", hideRemoved: "削除済みの注釈を隠す",
    add: "注釈を追加", close: "閉じる", empty: "ここにはまだ注釈がありません。", removedEmpty: "削除済みの注釈はありません。",
    authorYou: "あなた", authorAgent: "Agent", updated: "元の内容が更新済み", removed: "元の内容が削除済み", unavailable: "元の内容を利用できません",
    original: "元の内容", annotation: "注釈", noteRemoved: "注釈は削除済み", edit: "編集", view: "対象を表示", discuss: "この注釈を話題にする",
    remove: "削除", restore: "復元", editorNew: "注釈を追加", editorEdit: "注釈を編集", source: "対象",
    characters: "文字", cancelEdit: "閉じる", save: "キャンバスに保存", saving: "保存中…", selectTarget: "対象を選び直す",
    targetRequired: "最初にキャンバス上で 1 つの項目を選択してください。", textRequired: "注釈の本文を入力してください。", textTooLong: "注釈は 8,000 文字までです。",
    sourceConflict: "元の内容の版が変わりました。対象を明示的に選び直してから保存してください。下書きは保持されています。",
    annotationConflict: "この注釈は更新されました。下書きは保持されています。最新内容を確認してから続け方を決めてください。",
    saveFailed: "保存に失敗しました", draftUnsafe: "ローカル下書きを書き込めませんでした。現在のテキストはこのパネルに残っています。",
    draftRestored: "未保存の下書きを復元しました。", artifact: "作品状態のスナップショット", artifactPreview: "作品プレビュー", artifactState: "保持された状態メモ",
    footer: "保存してもタスクは開始しません。最後に Canvas の送信を押したときだけ、元のタスクへ渡されます。", untitled: "無題の内容", noContent: "表示できる元のテキストは保存されていません。",
  },
};

type SourceState = "available" | "updated" | "removed" | "unavailable";
type Scope = "current" | "workspace";
type AnnotationDraft = {
  version: 1;
  kind: "new" | "edit";
  target_id: string;
  annotation_id: string;
  expected_revision: number;
  anchor: CanvasAnchor;
  text: string;
  request_id?: string;
  needs_reselect?: boolean;
  updated_at: number;
};

export type CanvasAnnotationsHandlers = {
  getBoard(): BoardSnapshot | undefined;
  /** Already scoped to the current workspace/task. This panel must never read layout.annotations directly. */
  getAnnotations(): CanvasAnnotation[];
  /** Flushes and captures one selected target with its annotation IDs removed. */
  capture(): Promise<CanvasAnchor | null>;
  save(request: CanvasBatchRequest): Promise<void>;
  focus(annotation: CanvasAnnotation): void;
  discuss(annotation: CanvasAnnotation): void;
};

export type CanvasAnnotationsPanel = {
  show(objectId?: string, annotationId?: string): Promise<void>;
  refresh(): void;
  destroy(): void;
};

function words(): Words { return WORDS[currentLocale()] ?? WORDS.en; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validAnchor(value: unknown): value is CanvasAnchor {
  const anchor = plainRecord(value);
  return Boolean(anchor && typeof anchor.object_id === "string" && anchor.object_id
    && typeof anchor.content_revision === "number" && Number.isSafeInteger(anchor.content_revision) && anchor.content_revision >= 0);
}

function validDraft(value: unknown): value is AnnotationDraft {
  const draft = plainRecord(value);
  return Boolean(draft && draft.version === 1 && (draft.kind === "new" || draft.kind === "edit")
    && typeof draft.target_id === "string" && typeof draft.annotation_id === "string"
    && typeof draft.expected_revision === "number" && Number.isSafeInteger(draft.expected_revision) && draft.expected_revision >= 0
    && validAnchor(draft.anchor) && typeof draft.text === "string" && typeof draft.updated_at === "number"
    && (draft.request_id == null || typeof draft.request_id === "string")
    && (draft.needs_reselect == null || typeof draft.needs_reselect === "boolean"));
}

function copyAnchor(anchor: CanvasAnchor): CanvasAnchor {
  try { return structuredClone(anchor); }
  catch { return anchor; } // Anchors are only read after capture; never mutate a nested field here.
}

function draftKey(targetId: string, annotationId: string) {
  return `${DRAFT_PREFIX}${encodeURIComponent(targetId)}:${encodeURIComponent(annotationId)}`;
}

function readDraft(targetId: string, annotationId: string): AnnotationDraft | undefined {
  try {
    const raw = localStorage.getItem(draftKey(targetId, annotationId));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!validDraft(parsed) || parsed.target_id !== targetId || parsed.annotation_id !== annotationId) return undefined;
    return { ...parsed, anchor: copyAnchor(parsed.anchor) };
  } catch { return undefined; }
}

function writeDraft(draft: AnnotationDraft): boolean {
  try {
    localStorage.setItem(draftKey(draft.target_id, draft.annotation_id), JSON.stringify(draft));
    return true;
  } catch { return false; }
}

function clearDraft(draft: AnnotationDraft) {
  try { localStorage.removeItem(draftKey(draft.target_id, draft.annotation_id)); }
  catch { /* The server result remains authoritative when local cleanup is unavailable. */ }
}

function mostRecentNewDraft(targetId: string): AnnotationDraft | undefined {
  let latest: AnnotationDraft | undefined;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!validDraft(parsed) || parsed.kind !== "new" || parsed.target_id !== targetId) continue;
      if (!latest || parsed.updated_at > latest.updated_at) latest = { ...parsed, anchor: copyAnchor(parsed.anchor) };
    }
  } catch { /* Recovery is optional; the in-memory draft is still retained. */ }
  return latest;
}

function characterCount(value: string) { return [...value].length; }

function clip(value: string, limit: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  const chars = [...compact];
  return chars.length > limit ? `${chars.slice(0, Math.max(1, limit - 1)).join("")}…` : compact;
}

const SNAPSHOT_TEXT_KEYS = ["title", "text", "body", "summary", "action", "description", "detail", "alt", "label", "note", "feedback"];
const SNAPSHOT_CHILD_KEYS = ["content", "block", "option", "step", "node", "item", "state", "preview", "options", "steps", "nodes"];

function snapshotValues(value: unknown, limit = 8): string[] {
  const values: string[] = [];
  const seen = new Set<object>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const text = clip(candidate, 180);
    if (text && !values.includes(text) && values.length < limit) values.push(text);
  };
  const visit = (candidate: unknown, depth: number) => {
    if (values.length >= limit || depth > 3 || candidate == null) return;
    if (typeof candidate === "string") { add(candidate); return; }
    if (Array.isArray(candidate)) { for (const item of candidate.slice(0, 3)) visit(item, depth + 1); return; }
    const record = plainRecord(candidate);
    if (!record || seen.has(record)) return;
    seen.add(record);
    for (const key of SNAPSHOT_TEXT_KEYS) add(record[key]);
    for (const key of SNAPSHOT_CHILD_KEYS) visit(record[key], depth + 1);
  };
  visit(value, 0);
  return values;
}

function snapshotInfo(value: unknown) {
  const values = snapshotValues(value);
  return { title: values[0] || "", text: values.slice(1).join(" · ") };
}

function objectTitle(board: BoardSnapshot, object: CanvasObject): string {
  const content = object.content;
  switch (content.type) {
    case "node": return board.nodes.find(node => node.id === content.id)?.title || "";
    case "reply": return board.replies?.find(reply => reply.id === content.id)?.title || "";
    case "block": return content.block.title || "";
    case "text": case "image": case "shape": return content.title;
  }
}

function anchoredBlock(board: BoardSnapshot, object: CanvasObject, blockId: string | undefined): ReplyBlock | undefined {
  if (!blockId) return undefined;
  const content = object.content;
  if (content.type === "block") return content.block.id === blockId ? content.block : undefined;
  if (content.type !== "reply") return undefined;
  return board.replies?.find(reply => reply.id === content.id)?.blocks.find(block => block.id === blockId);
}

function sourceState(board: BoardSnapshot | undefined, annotation: CanvasAnnotation): SourceState {
  if (!board?.canvas) return "unavailable";
  const object = board.canvas.objects.find(item => item.id === annotation.anchor.object_id);
  if (!object) return "removed";
  if (board.canvas.items.find(item => item.item_id === object.id)?.removed) return "removed";
  const block = anchoredBlock(board, object, annotation.anchor.block_id);
  if (annotation.anchor.block_id && !block && !(object.content.type === "node" && annotation.anchor.block_id === "text")) return "removed";
  if (annotation.anchor.target && block && !targetExists(block, annotation.anchor.target)) return "removed";
  return object.content_revision === annotation.anchor.content_revision ? "available" : "updated";
}

function sourceLabel(board: BoardSnapshot | undefined, annotation: CanvasAnnotation, fallback: string) {
  if (!board?.canvas) return fallback;
  const object = board.canvas.objects.find(item => item.id === annotation.anchor.object_id);
  if (!object) return fallback;
  const title = objectTitle(board, object);
  const block = anchoredBlock(board, object, annotation.anchor.block_id);
  return [title, block?.title].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index).join(" / ") || fallback;
}

function sourceReads(anchor: CanvasAnchor): CanvasRead[] {
  const reads: CanvasRead[] = [{ kind: "content", id: anchor.object_id, revision: anchor.content_revision }];
  for (const composition of anchor.compositions ?? []) {
    if (typeof composition.id === "string" && Number.isSafeInteger(composition.revision) && composition.revision >= 0) {
      reads.push({ kind: "composition", id: composition.id, revision: composition.revision });
    }
  }
  return [...new Map(reads.map(read => [`${read.kind}:${read.id}`, read])).values()];
}

function failureText(failure: unknown) {
  if (failure instanceof Error) return failure.message || failure.name;
  if (typeof failure === "string") return failure;
  try { return JSON.stringify(failure); }
  catch { return String(failure); }
}

function isConflict(failure: unknown) {
  return /conflict|revision|version|stale|changed|mismatch|expected/i.test(failureText(failure));
}

function artifactSummary(anchor: CanvasAnchor, copy: Words): string {
  const parts: string[] = [];
  const reference = anchor.artifact_reference;
  if (reference) {
    parts.push(reference.title ? `${copy.artifact}: ${reference.title}` : copy.artifact);
    if (reference.preview?.alt) parts.push(`${copy.artifactPreview}: ${clip(reference.preview.alt, 140)}`);
    const state = snapshotInfo(reference.state);
    if (state.title || state.text) parts.push(`${copy.artifactState}: ${clip([state.title, state.text].filter(Boolean).join(" · "), 240)}`);
  }
  if (anchor.artifact) {
    const state = snapshotInfo(anchor.artifact.state);
    const revision = Number.isSafeInteger(anchor.artifact.state_revision) ? ` #${anchor.artifact.state_revision}` : "";
    const detail = [state.title, state.text].filter(Boolean).join(" · ");
    parts.push(`${copy.artifact}${revision}${detail ? `: ${clip(detail, 240)}` : ""}`);
  }
  return [...new Set(parts)].join("\n");
}

/**
 * A persistent, canvas-only annotation panel. The caller owns scope filtering,
 * anchoring, board updates, and all transitions to the main discussion input.
 */
export function canvasAnnotations(handlers: CanvasAnnotationsHandlers): CanvasAnnotationsPanel {
  const dialog = element("dialog", "board-dialog canvas-annotations");
  const header = element("header", "canvas-annotations-head");
  const heading = element("h2");
  const close = element("button", "canvas-annotations-close", "×") as HTMLButtonElement;
  close.type = "button";
  header.append(heading, close);
  const help = element("p", "canvas-annotations-help");
  const controls = element("div", "canvas-annotations-controls");
  const currentScope = element("button", "canvas-annotations-scope") as HTMLButtonElement;
  const workspaceScope = element("button", "canvas-annotations-scope") as HTMLButtonElement;
  const removedToggle = element("button", "canvas-annotations-secondary") as HTMLButtonElement;
  const add = element("button", "canvas-annotations-add") as HTMLButtonElement;
  for (const button of [currentScope, workspaceScope, removedToggle, add]) button.type = "button";
  controls.append(currentScope, workspaceScope, removedToggle, add);
  const list = element("div", "canvas-annotations-list"); list.setAttribute("role", "region");
  const editor = element("form", "canvas-annotation-editor"); editor.noValidate = true;
  const editorHeading = element("h3");
  const target = element("p", "canvas-annotation-target");
  const text = document.createElement("textarea"); text.className = "canvas-annotation-input"; text.rows = 5; text.maxLength = TEXT_LIMIT;
  const count = element("small", "canvas-annotation-count");
  const error = element("p", "canvas-annotation-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const editorActions = element("div", "canvas-annotation-editor-actions");
  const collapse = element("button", "canvas-annotations-secondary") as HTMLButtonElement;
  const reselect = element("button", "canvas-annotations-secondary") as HTMLButtonElement;
  const save = element("button", "canvas-annotations-save") as HTMLButtonElement;
  for (const button of [collapse, reselect, save]) button.type = "button";
  save.type = "submit";
  editorActions.append(collapse, reselect, save);
  editor.append(editorHeading, target, text, count, error, editorActions);
  const footer = element("p", "canvas-annotations-footer");
  dialog.append(header, help, controls, list, editor, footer);
  document.body.append(dialog);

  let destroyed = false;
  let busy = false;
  let scope: Scope = "workspace";
  let targetObjectId: string | undefined;
  let showRemoved = false;
  let draft: AnnotationDraft | undefined;
  let errorMessage = "";
  let draftUnsafe = false;
  let pendingAnnotationId: string | undefined;

  const persist = (value: AnnotationDraft) => {
    value.updated_at = Date.now();
    draftUnsafe = !writeDraft(value);
    if (draftUnsafe) errorMessage = words().draftUnsafe;
  };

  const currentAnnotation = (id: string) => handlers.getAnnotations().find(annotation => annotation.id === id);

  function sourceFor(annotation: CanvasAnnotation, board: BoardSnapshot | undefined) {
    const snapshot = snapshotInfo(annotation.snapshot);
    const fallback = snapshot.title || words().untitled;
    return { snapshot, title: sourceLabel(board, annotation, fallback), state: sourceState(board, annotation) };
  }

  function setError(message = "") { errorMessage = message; }

  function renderArtifact(anchor: CanvasAnchor, copy: Words) {
    const summary = artifactSummary(anchor, copy);
    if (!summary) return undefined;
    const detail = element("p", "canvas-annotation-artifact", summary);
    return detail;
  }

  function action(label: string, callback: () => void, className = "") {
    const button = element("button", className, label) as HTMLButtonElement;
    button.type = "button"; button.disabled = busy; button.addEventListener("click", callback);
    return button;
  }

  function renderCard(annotation: CanvasAnnotation, board: BoardSnapshot | undefined, copy: Words) {
    const card = element("article", "canvas-annotation-card");
    card.dataset.annotationId = annotation.id;
    if (annotation.removed) card.classList.add("is-removed");
    if (draft?.annotation_id === annotation.id) card.classList.add("is-editing");
    const source = sourceFor(annotation, board);
    const head = element("header", "canvas-annotation-card-head");
    const name = element("h3", "canvas-annotation-source", source.title);
    const meta = element("div", "canvas-annotation-meta");
    const author = element("span", "canvas-annotation-author", annotation.source_id ? copy.authorAgent : copy.authorYou);
    meta.append(author);
    if (source.state !== "available") meta.append(element("span", `canvas-annotation-state is-${source.state}`, copy[source.state]));
    if (annotation.removed) meta.append(element("span", "canvas-annotation-state is-removed", copy.noteRemoved));
    head.append(name, meta); card.append(head);

    const original = element("section", "canvas-annotation-original");
    original.append(element("small", "canvas-annotation-kicker", copy.original));
    original.append(element("p", "canvas-annotation-original-text", source.snapshot.text || source.snapshot.title || copy.noContent));
    card.append(original);

    const body = element("section", "canvas-annotation-body");
    body.append(element("small", "canvas-annotation-kicker", copy.annotation));
    const rendered = element("div", "canvas-annotation-rendered"); renderLightText(rendered, annotation.text); body.append(rendered); card.append(body);

    const media = element("div", "canvas-annotation-media");
    if (annotation.anchor.image) media.append(referencePreview(annotation.anchor.image, referenceState(board?.canvas, annotation.anchor.object_id, annotation.anchor.image), undefined, annotation.anchor.region));
    const snapshot = plainRecord(annotation.snapshot);
    if (!annotation.anchor.image && snapshot?.type === "image" && typeof snapshot.src === "string") {
      media.append(referencePreview({ object_id: annotation.anchor.object_id, content_revision: annotation.anchor.content_revision, src: snapshot.src, alt: typeof snapshot.alt === "string" ? snapshot.alt : "", title: typeof snapshot.title === "string" ? snapshot.title : "" }, source.state === "available" ? "saved" : "changed", undefined, annotation.anchor.region));
    }
    let work: ReplyArtifactReference | undefined = annotation.anchor.artifact_reference;
    if (!work && snapshot?.type === "artifact" && typeof snapshot.bundle_id === "string" && typeof snapshot.id === "string") {
      work = { object_id: annotation.anchor.object_id, content_revision: annotation.anchor.content_revision, block_id: snapshot.id, bundle_id: snapshot.bundle_id,
        state_revision: typeof snapshot.state_revision === "number" ? snapshot.state_revision : 0, title: typeof snapshot.title === "string" ? snapshot.title : "", state: plainRecord(snapshot.state) || {},
        ...(snapshot.state_preview ? { preview: snapshot.state_preview as ReplyArtifactReference["preview"] } : {}) };
    }
    if (work) media.append(artifactReferencePreview(work, "saved"));
    const artifact = renderArtifact(annotation.anchor, copy); if (artifact) media.append(artifact);
    if (media.childElementCount) card.append(media);

    const actions = element("div", "canvas-annotation-actions");
    if (!annotation.removed) {
      actions.append(action(copy.edit, () => beginEdit(annotation)), action(copy.view, () => focus(annotation)), action(copy.discuss, () => discuss(annotation), "canvas-annotation-discuss"), action(copy.remove, () => void setRemoved(annotation, true), "canvas-annotation-danger"));
    } else {
      actions.append(action(copy.restore, () => void setRemoved(annotation, false)));
    }
    card.append(actions);
    return card;
  }

  function renderEditor(copy: Words) {
    const active = draft;
    editor.hidden = !active;
    if (!active) return;
    const annotation = active.kind === "edit" ? currentAnnotation(active.annotation_id) : undefined;
    const snapshot = annotation ? snapshotInfo(annotation.snapshot) : { title: "", text: "" };
    const name = sourceLabel(handlers.getBoard(), { ...(annotation ?? { id: active.annotation_id, revision: active.expected_revision, snapshot: null, removed: false, text: active.text }), anchor: active.anchor } as CanvasAnnotation, snapshot.title || words().untitled);
    editorHeading.textContent = active.kind === "new" ? copy.editorNew : copy.editorEdit;
    target.textContent = `${copy.source}: ${name}`;
    if (text.value !== active.text) text.value = active.text;
    text.readOnly = busy || Boolean(active.needs_reselect);
    text.setAttribute("aria-label", copy.annotation);
    count.textContent = `${characterCount(active.text)} / ${TEXT_LIMIT} ${copy.characters}`;
    error.textContent = errorMessage; error.hidden = !errorMessage;
    collapse.textContent = copy.cancelEdit; collapse.disabled = busy;
    reselect.textContent = copy.selectTarget; reselect.hidden = !active.needs_reselect; reselect.disabled = busy;
    save.textContent = busy ? copy.saving : copy.save; save.disabled = busy || Boolean(active.needs_reselect);
  }

  function render() {
    if (destroyed) return;
    const copy = words();
    dialog.lang = currentLocale();
    heading.textContent = copy.heading; close.setAttribute("aria-label", copy.close); close.title = copy.close;
    help.textContent = copy.help; footer.textContent = copy.footer;
    currentScope.textContent = copy.current; workspaceScope.textContent = copy.workspace;
    currentScope.hidden = !targetObjectId;
    workspaceScope.hidden = !targetObjectId;
    currentScope.setAttribute("aria-pressed", String(scope === "current"));
    workspaceScope.setAttribute("aria-pressed", String(scope === "workspace"));
    currentScope.disabled = busy; workspaceScope.disabled = busy;
    removedToggle.textContent = showRemoved ? copy.hideRemoved : copy.showRemoved; removedToggle.disabled = busy;
    add.textContent = copy.add; add.disabled = busy || Boolean(draft);

    const board = handlers.getBoard();
    let annotations = handlers.getAnnotations();
    if (scope === "current" && targetObjectId) annotations = annotations.filter(annotation => annotation.anchor.object_id === targetObjectId);
    if (!showRemoved) annotations = annotations.filter(annotation => !annotation.removed);
    list.replaceChildren();
    if (!annotations.length) list.append(element("p", "canvas-annotations-empty", showRemoved ? copy.removedEmpty : copy.empty));
    else list.append(...annotations.map(annotation => renderCard(annotation, board, copy)));
    renderEditor(copy);
  }

  function locatePendingAnnotation() {
    const id = pendingAnnotationId;
    if (!id || !dialog.open) return;
    const card = [...list.querySelectorAll<HTMLElement>("[data-annotation-id]")].find(node => node.dataset.annotationId === id);
    if (!card) return;
    pendingAnnotationId = undefined;
    card.classList.remove("is-located");
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // Restarting the class makes repeated image-marker clicks visible as well.
    window.requestAnimationFrame(() => {
      card.classList.add("is-located");
      window.setTimeout(() => card.classList.remove("is-located"), 1800);
    });
  }

  function draftFrom(annotation: CanvasAnnotation): AnnotationDraft {
    const saved = readDraft(annotation.anchor.object_id, annotation.id);
    if (saved?.kind === "edit") return saved;
    return { version: 1, kind: "edit", target_id: annotation.anchor.object_id, annotation_id: annotation.id, expected_revision: annotation.revision, anchor: copyAnchor(annotation.anchor), text: annotation.text, updated_at: Date.now() };
  }

  function beginEdit(annotation: CanvasAnnotation) {
    if (busy) return;
    draft = draftFrom(annotation); draftUnsafe = false; setError(""); render();
    window.setTimeout(() => text.focus(), 0);
  }

  async function beginNew() {
    if (busy || draft) return;
    busy = true; setError(""); render();
    try {
      const anchor = await handlers.capture();
      if (!anchor) { setError(words().targetRequired); return; }
      draft = { version: 1, kind: "new", target_id: anchor.object_id, annotation_id: crypto.randomUUID(), expected_revision: 0, anchor: copyAnchor(anchor), text: "", updated_at: Date.now() };
      persist(draft);
    } catch (failure) { setError(`${words().targetRequired} ${clip(failureText(failure), 220)}`); }
    finally { busy = false; render(); if (draft) window.setTimeout(() => text.focus(), 0); }
  }

  async function reselectTarget() {
    const active = draft;
    if (!active || active.kind !== "new" || busy) return;
    busy = true; setError(""); render();
    try {
      const anchor = await handlers.capture();
      if (!anchor) { setError(words().targetRequired); return; }
      const previousKey = draftKey(active.target_id, active.annotation_id);
      const next: AnnotationDraft = { ...active, target_id: anchor.object_id, anchor: copyAnchor(anchor), expected_revision: 0, request_id: undefined, needs_reselect: false, updated_at: Date.now() };
      const saved = writeDraft(next);
      if (saved) draftUnsafe = false;
      if (saved && previousKey !== draftKey(next.target_id, next.annotation_id)) {
        try { localStorage.removeItem(previousKey); } catch { /* The copied record remains recoverable. */ }
      } else if (!saved) {
        draftUnsafe = true; setError(words().draftUnsafe);
      }
      draft = next;
    } catch (failure) { setError(`${words().targetRequired} ${clip(failureText(failure), 220)}`); }
    finally { busy = false; render(); }
  }

  function requestFor(active: AnnotationDraft): CanvasBatchRequest {
    const requestId = active.request_id ?? crypto.randomUUID();
    active.request_id = requestId;
    const reads = active.kind === "new"
      ? sourceReads(active.anchor)
      : [{ kind: "annotation", id: active.annotation_id, revision: active.expected_revision } satisfies CanvasRead];
    return {
      request_id: requestId,
      reads,
      operations: [{ op: "annotate", id: active.annotation_id, expected_revision: active.expected_revision, anchor: copyAnchor(active.anchor), text: active.text.trim() }],
    };
  }

  async function saveDraft() {
    const active = draft;
    if (!active || busy) return;
    const count = characterCount(active.text);
    if (!active.text.trim()) { setError(words().textRequired); render(); return; }
    if (count > TEXT_LIMIT) { setError(words().textTooLong); render(); return; }
    if (active.needs_reselect) { setError(words().sourceConflict); render(); return; }
    const current = active.kind === "edit" ? currentAnnotation(active.annotation_id) : undefined;
    if (active.kind === "edit" && current && current.revision === active.expected_revision && current.text === active.text) {
      clearDraft(active); draft = undefined; draftUnsafe = false; setError(""); render(); return;
    }
    const request = requestFor(active); persist(active);
    busy = true; setError(""); render();
    try {
      await handlers.save(request);
      if (destroyed || draft !== active) return;
      clearDraft(active); draft = undefined; draftUnsafe = false; setError("");
    } catch (failure) {
      if (destroyed || draft !== active) return;
      if (active.kind === "new" && isConflict(failure)) {
        active.needs_reselect = true; persist(active); setError(words().sourceConflict);
      } else if (active.kind === "edit" && isConflict(failure)) {
        setError(words().annotationConflict);
      } else {
        setError(`${words().saveFailed}: ${clip(failureText(failure), 320)}`);
      }
    } finally { busy = false; render(); }
  }

  async function setRemoved(annotation: CanvasAnnotation, removed: boolean) {
    if (busy) return;
    busy = true; setError(""); render();
    const request: CanvasBatchRequest = {
      request_id: crypto.randomUUID(), reads: [{ kind: "annotation", id: annotation.id, revision: annotation.revision }],
      operations: [{ op: "remove_annotation", id: annotation.id, expected_revision: annotation.revision, removed }],
    };
    try { await handlers.save(request); }
    catch (failure) { setError(`${words().saveFailed}: ${clip(failureText(failure), 320)}`); }
    finally { busy = false; render(); }
  }

  function focus(annotation: CanvasAnnotation) {
    if (busy) return;
    try { handlers.focus(annotation); dialog.close("focus"); }
    catch (failure) { setError(clip(failureText(failure), 320)); render(); }
  }

  function discuss(annotation: CanvasAnnotation) {
    if (busy) return;
    try {
      handlers.discuss(annotation);
      if (dialog.open) dialog.close("discuss");
    } catch (failure) { setError(clip(failureText(failure), 320)); render(); }
  }

  currentScope.addEventListener("click", () => { if (targetObjectId && !busy) { scope = "current"; render(); } });
  workspaceScope.addEventListener("click", () => { if (!busy) { scope = "workspace"; render(); } });
  removedToggle.addEventListener("click", () => { if (!busy) { showRemoved = !showRemoved; render(); } });
  add.addEventListener("click", () => { void beginNew(); });
  close.addEventListener("click", () => { if (!busy) dialog.close("close"); });
  collapse.addEventListener("click", () => { if (!busy) { draft = undefined; setError(""); render(); } });
  reselect.addEventListener("click", () => { void reselectTarget(); });
  editor.addEventListener("submit", event => { event.preventDefault(); void saveDraft(); });
  text.addEventListener("input", () => {
    if (!draft || busy) return;
    draft.text = text.value; draft.request_id = undefined; persist(draft); render();
  });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  const unlistenLocale = onLocale(() => render());

  return {
    async show(objectId?: string, annotationId?: string) {
      if (destroyed) return;
      targetObjectId = objectId;
      scope = objectId ? "current" : "workspace";
      pendingAnnotationId = annotationId;
      showRemoved = Boolean(annotationId && handlers.getAnnotations().find(annotation => annotation.id === annotationId)?.removed);
      setError("");
      if (draft && objectId && draft.target_id !== objectId) draft = undefined;
      if (!draft && objectId) {
        const recovered = mostRecentNewDraft(objectId);
        if (recovered) { draft = recovered; setError(words().draftRestored); }
      }
      render();
      if (!dialog.open) dialog.showModal();
      window.requestAnimationFrame(() => locatePendingAnnotation());
    },
    refresh() { render(); },
    destroy() {
      if (destroyed) return;
      destroyed = true; unlistenLocale();
      if (dialog.open) dialog.close("destroy");
      dialog.remove();
    },
  };
}
