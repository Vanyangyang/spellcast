/**
 * Board replies: renders structured Agent replies (text / comparison / graph /
 * sequence) on the board and routes every user intent back through callbacks.
 *
 * Native forms use text/SVG DOM. Open Web works run in the separate ArtifactFrame
 * sandbox and share the same explicit feedback and versioned editing flow.
 */
import { Graph } from "@antv/x6";
import type { Edge as X6Edge, Node as X6Node } from "@antv/x6";
import { currentLocale, onLocale, type Locale } from "./i18n";
import { ct } from "./i18n/canvas";
import { renderLightText } from "./light-text";
import { imageAnnotations } from "./canvas-annotation-markers";
import { ArtifactFrame } from "./artifacts";
import type { CanvasDataflow } from "./canvas-dataflow";
import type { BoardSnapshot, CanvasAnchor, CanvasLayout } from "./types";
import { artifactChoices, artifactChoiceKey, artifactSnapshot, artifactReferenceState, artifactReferencePreview, artifactText, targetArtifact } from "./reply-artifact";
import { imageChoices, imageSnapshot, imageText, referencePreview, referenceState, targetExists, targetImage } from "./reply-image";
import { replyDrafts, draftKey, contentKey, semanticBlockKey, type DraftRecord } from "./reply-drafts";
import type {
  BoardReply,
  ReplyActionInput,
  ReplyBlock,
  ReplyComparisonBlock,
  ReplyGraphBlock,
  ReplyGraphNode,
  ReplyOption,
  ReplyPatchRequest,
  ReplySequenceBlock,
  ReplyStep,
  ReplyTextBlock,
  ReplyArtifactBlock,
  ReplyImageReference,
  ReplyArtifactReference,
  ReplyTarget,
} from "./reply-types";
import "./replies.css";

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export type ReplySelection = { object_id?: string; reply_id: string; block_id: string; target?: ReplyTarget; region?: CanvasAnchor["region"] };

export type ReplyBoardHandlers = {
  getBoard?(): BoardSnapshot | undefined;
  onAnnotation?(id: string): void;
  onArtifactPresentationChange?(replyId: string, blockId: string, height: number, mode: "compact" | "full", explicit: boolean): void;
  onArtifactWheel?(clientX: number, clientY: number, deltaY: number): void;
  getCanvas?(): CanvasLayout | undefined;
  dataflow?: CanvasDataflow;
  onAction(request: ReplyActionInput): Promise<BoardReply>;
  onPatch(request: ReplyPatchRequest): Promise<BoardReply>;
  onSelect?(selection: ReplySelection | null): void;
  onFocusNotice?(message: string): void;
  onError?(message: string): void;
};

export type ReplyBoardHandle = {
  update(replies: BoardReply[]): void;
  select(replyId: string): void;
  selectBlock(replyId: string, blockId: string, target?: ReplyTarget, region?: CanvasAnchor["region"]): void;
  getSelection(): ReplySelection | null;
  getArtifactAnchor(): CanvasAnchor["artifact"] | undefined;
  prepareFeedback(): Promise<void>;
  restoreDraft(record: DraftRecord): boolean;
  destroy(): void;
};

export function mountReplyBoard(host: HTMLElement, handlers: ReplyBoardHandlers): ReplyBoardHandle {
  const board = new ReplyBoard(host, handlers);
  return {
    update: (replies) => board.update(replies),
    select: (replyId) => board.select(replyId),
    selectBlock: (replyId, blockId, target, region) => board.selectBlock(replyId, blockId, target, region),
    getSelection: () => board.getSelection(),
    getArtifactAnchor: () => board.getArtifactAnchor(),
    prepareFeedback: () => board.prepareFeedback(),
    restoreDraft: (record) => board.restoreDraft(record),
    destroy: () => board.destroy(),
  };
}

/* ------------------------------------------------------------------ */
/* Local dictionary (zh-CN / en / ja)                                  */
/* ------------------------------------------------------------------ */

const MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "nav.label": "板上回复",
    "nav.empty": "板上还没有回复。选中一条采纳的想法，请 Agent 在这里展开。",
    "nav.count": "{n} 条回复",
    "nav.new": "新",
    "nav.updated": "已更新",
    "reply.from": "来自 {source}",
    "reply.updated": "更新于 {time}",
    untitled: "未命名",
    "kind.text": "文字",
    "kind.comparison": "方案对照",
    "kind.graph": "关系图",
    "kind.sequence": "分镜",
    "kind.artifact": "开放作品",
    "block.selected": "当前讨论对象",
    "block.focus": "针对这块讨论",
    "block.focusActive": "✓ 已选中",
    "block.focusHelp": "已选中「{title}」，可在底部输入，继续讨论这一块。",
    "action.ask": "提问",
    "action.edit": "编辑",
    "action.save": "保存",
    "action.saving": "正在保存…",
    "action.cancel": "取消",
    "action.send": "发送",
    "action.sending": "正在发送…",
    "action.retry": "重试",
    "action.discard": "放弃草稿，载入最新内容",
    "action.add": "添加",
    "action.remove": "移除",
    "action.up": "上移",
    "action.down": "下移",
    "action.clear": "清除",
    "ask.label": "就这一块提问",
    "ask.placeholder": "写下你想追问、质疑或补充的内容",
    "ask.context": "关于{label}",
    "ask.failed": "没有发送成功，你写的内容仍保留在这里。",
    "edit.stale": "这条回复在你编辑时有了新版本。继续保存可能不会成功；你也可以放弃草稿，载入最新内容。",
    "edit.failed": "保存没有成功，你的修改仍保留在这里。",
    "edit.conflict": "内容已被其他更新修改，你的修改没有保存。可以放弃草稿载入最新内容，再重新修改。",
    "edit.title": "标题",
    "edit.titleOptional": "标题（可选）",
    "edit.text": "正文",
    "edit.criteria": "对照维度",
    "edit.criterion": "维度 {n}",
    "edit.addCriterion": "添加维度",
    "edit.options": "方案",
    "edit.option": "方案 {n}",
    "edit.addOption": "添加方案",
    "edit.optionTitle": "方案名",
    "edit.optionSummary": "一句话概括",
    "edit.steps": "步骤",
    "edit.step": "第 {n} 步",
    "edit.addStep": "添加步骤",
    "edit.stepTitle": "标题",
    "edit.stepAction": "动作",
    "edit.stepFeedback": "反馈",
    "edit.stepNote": "备注",
    "edit.node": "要编辑的节点",
    "edit.nodeTitle": "节点标题",
    "edit.nodeDetail": "节点说明",
    "edit.noNodes": "这张图还没有节点，只能修改标题。",
    "cmp.choose": "选择这个方案",
    "cmp.chosen": "已选这个方案",
    "cmp.choosing": "正在选择…",
    "cmp.current": "当前选择：",
    "cmp.none": "尚未选择",
    "cmp.failed": "选择没有成功，请再试一次。",
    "cmp.noValue": "—",
    "cmp.extra": "其他",
    "cmp.empty": "这一组还没有方案。",
    "seq.step": "第 {n} 步",
    "seq.action": "动作",
    "seq.feedback": "反馈",
    "seq.note": "备注",
    "seq.focus": "关注这一拍",
    "seq.focused": "关注中",
    "seq.askStep": "就这一拍提问",
    "seq.stepContext": "第 {n} 步「{title}」",
    "seq.empty": "这段分镜还没有步骤。",
    "graph.hint": "拖动节点调整位置；拖动空白处平移；Ctrl + 滚轮缩放。",
    "graph.zoomIn": "放大",
    "graph.zoomOut": "缩小",
    "graph.fit": "适应画布",
    "graph.canvas": "关系图画布",
    "graph.nodes": "节点",
    "graph.detail": "节点说明",
    "graph.edgeDetail": "连线说明",
    "graph.pick": "点击一个节点查看说明。",
    "graph.noDetail": "这个节点还没有说明。",
    "graph.links": "相关连线",
    "graph.linkTo": "{from} → {to}",
    "graph.linkLabel": "{from} → {to}（{label}）",
    "graph.focused": "已选",
    "graph.empty": "这张图还没有节点。",
    "graph.layoutSaving": "正在保存位置…",
    "graph.layoutSaved": "位置已保存",
    "graph.layoutFailed": "位置没有保存成功",
  },
  en: {
    "nav.label": "Replies on the board",
    "nav.empty": "No replies yet. Choose an adopted idea and ask your agent to develop it here.",
    "nav.count": "{n} replies",
    "nav.new": "New",
    "nav.updated": "Updated",
    "reply.from": "From {source}",
    "reply.updated": "Updated {time}",
    untitled: "Untitled",
    "kind.text": "Text",
    "kind.comparison": "Comparison",
    "kind.graph": "Relations",
    "kind.sequence": "Sequence",
    "kind.artifact": "Web work",
    "block.selected": "Current discussion target",
    "block.focus": "Discuss this block",
    "block.focusActive": "✓ Selected",
    "block.focusHelp": "Selected “{title}”. Use the input below to discuss this block.",
    "action.ask": "Ask",
    "action.edit": "Edit",
    "action.save": "Save",
    "action.saving": "Saving…",
    "action.cancel": "Cancel",
    "action.send": "Send",
    "action.sending": "Sending…",
    "action.retry": "Retry",
    "action.discard": "Discard draft and load latest",
    "action.add": "Add",
    "action.remove": "Remove",
    "action.up": "Move up",
    "action.down": "Move down",
    "action.clear": "Clear",
    "ask.label": "Ask about this block",
    "ask.placeholder": "What would you like to question, challenge or add?",
    "ask.context": "About {label}",
    "ask.failed": "Sending failed. Your text is still here.",
    "edit.stale": "This reply changed while you were editing. Saving may not succeed; you can also discard the draft and load the latest version.",
    "edit.failed": "Saving failed. Your changes are still here.",
    "edit.conflict": "The content was changed by another update, so your changes were not saved. Discard the draft to load the latest version and edit again.",
    "edit.title": "Title",
    "edit.titleOptional": "Title (optional)",
    "edit.text": "Body",
    "edit.criteria": "Criteria",
    "edit.criterion": "Criterion {n}",
    "edit.addCriterion": "Add criterion",
    "edit.options": "Options",
    "edit.option": "Option {n}",
    "edit.addOption": "Add option",
    "edit.optionTitle": "Option name",
    "edit.optionSummary": "One-line summary",
    "edit.steps": "Steps",
    "edit.step": "Step {n}",
    "edit.addStep": "Add step",
    "edit.stepTitle": "Title",
    "edit.stepAction": "Action",
    "edit.stepFeedback": "Feedback",
    "edit.stepNote": "Note",
    "edit.node": "Node to edit",
    "edit.nodeTitle": "Node title",
    "edit.nodeDetail": "Node detail",
    "edit.noNodes": "This graph has no nodes yet; only the title can be edited.",
    "cmp.choose": "Choose this option",
    "cmp.chosen": "Chosen",
    "cmp.choosing": "Choosing…",
    "cmp.current": "Current choice:",
    "cmp.none": "Nothing chosen yet",
    "cmp.failed": "The choice did not go through. Please try again.",
    "cmp.noValue": "—",
    "cmp.extra": "Other",
    "cmp.empty": "No options in this comparison yet.",
    "seq.step": "Step {n}",
    "seq.action": "Action",
    "seq.feedback": "Feedback",
    "seq.note": "Note",
    "seq.focus": "Focus this beat",
    "seq.focused": "In focus",
    "seq.askStep": "Ask about this beat",
    "seq.stepContext": "step {n} “{title}”",
    "seq.empty": "This sequence has no steps yet.",
    "graph.hint": "Drag nodes to reposition; drag empty space to pan; Ctrl + wheel to zoom.",
    "graph.zoomIn": "Zoom in",
    "graph.zoomOut": "Zoom out",
    "graph.fit": "Fit to view",
    "graph.canvas": "Relation graph canvas",
    "graph.nodes": "Nodes",
    "graph.detail": "Node detail",
    "graph.edgeDetail": "Edge detail",
    "graph.pick": "Click a node to read its detail.",
    "graph.noDetail": "This node has no detail yet.",
    "graph.links": "Connections",
    "graph.linkTo": "{from} → {to}",
    "graph.linkLabel": "{from} → {to} ({label})",
    "graph.focused": "Selected",
    "graph.empty": "This graph has no nodes yet.",
    "graph.layoutSaving": "Saving positions…",
    "graph.layoutSaved": "Positions saved",
    "graph.layoutFailed": "Positions were not saved",
  },
};

function translate(key: string, vars?: Record<string, string | number>): string {
  const locale = currentLocale();
  let text = MESSAGES[locale]?.[key] ?? MESSAGES.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* DOM helpers (text only, never HTML)                                 */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  const input = el("input");
  input.type = "text";
  input.value = value;
  input.autocomplete = "off";
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

function textArea(value: string, onInput: (v: string) => void, rows = 3): HTMLTextAreaElement {
  const area = el("textarea");
  area.value = value;
  area.rows = rows;
  area.addEventListener("input", () => onInput(area.value));
  return area;
}

function paragraphs(text: string): HTMLElement[] {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((part) => part.replace(/^\s+|\s+$/g, ""))
    .filter((part) => part.length > 0)
    .map((part) => el("p", undefined, part));
}

function displayTitle(title: string | undefined | null): string {
  const trimmed = (title ?? "").trim();
  return trimmed.length > 0 ? trimmed : translate("untitled");
}

function formatTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat(currentLocale(), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

function moveItem<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

/** Turns a thrown value into a short, user-facing sentence without leaking payloads. */
function friendlyError(err: unknown, fallback: string): { user: string; detail: string } {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const detail = raw || fallback;
  const looksTechnical = /[{}\[\]<>]|revision|json|schema|undefined|null|\bat\b .*:\d+/i.test(raw);
  const user = raw && raw.length <= 140 && !looksTechnical ? `${fallback} ${raw}` : fallback;
  return { user, detail };
}

function looksLikeConflict(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /conflict|revision|stale|409|expected/i.test(raw);
}

/* ------------------------------------------------------------------ */
/* Shared context handed to block views                                */
/* ------------------------------------------------------------------ */

interface BoardContext {
  handlers: ReplyBoardHandlers;
  uid(): string;
  mergeReply(reply: BoardReply): void;
  selectBlock(replyId: string, blockId: string, target?: ReplyTarget, region?: CanvasAnchor["region"]): void;
  selection(): ReplySelection | null;
  isBlockSelected(replyId: string, blockId: string): boolean;
  reportError(message: string): void;
}

type EditSession<D> = {
  expectedRevision: number;
  baseBlock: ReplyBlock;
  draftStamp?: number;
  draft: D;
  busy: boolean;
  error: string | null;
  frame: HTMLElement | null;
  form: HTMLElement | null;
  stale: HTMLElement | null;
  errorEl: HTMLElement | null;
  saveBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  statusEl: HTMLElement | null;
};

type AskState = {
  expectedRevision: number;
  draftStamp?: number;
  preserveContext: boolean;
  text: string;
  busy: boolean;
  error: string | null;
  context: DraftRecord["context"];
  frame: HTMLElement | null;
  input: HTMLTextAreaElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  errorEl: HTMLElement | null;
  chipHost: HTMLElement | null;
};

/* ------------------------------------------------------------------ */
/* Block view base                                                     */
/* ------------------------------------------------------------------ */

abstract class BlockView<B extends ReplyBlock, D> {
  readonly root: HTMLElement;
  protected readonly heading: HTMLElement;
  protected readonly kindEl: HTMLElement;
  protected readonly selectedTag: HTMLElement;
  protected readonly titleEl: HTMLElement;
  protected readonly tools: HTMLElement;
  protected readonly body: HTMLElement;
  protected readonly askArea: HTMLElement;
  protected readonly editArea: HTMLElement;
  protected readonly askBtn: HTMLButtonElement;
  protected readonly editBtn: HTMLButtonElement;
  protected readonly focusBtn: HTMLButtonElement;

  reply!: BoardReply;
  block!: B;
  protected edit: EditSession<D> | null = null;
  protected ask: AskState | null = null;
  protected keepBodyWhileEditing = false;
  protected destroyed = false;
  private storageWarned = false;

  constructor(protected readonly ctx: BoardContext, protected readonly kindKey: string) {
    this.root = el("section", "rb-block");
    this.root.tabIndex = -1;

    const head = el("div", "rb-block-head");
    this.heading = el("div", "rb-block-heading");
    this.kindEl = el("span", "rb-block-kind");
    this.selectedTag = el("span", "rb-block-selected-tag");
    this.titleEl = el("h3", "rb-block-title");
    this.heading.append(this.kindEl, this.titleEl);
    this.tools = el("div", "rb-block-tools");
    this.focusBtn = button("", "rb-quiet rb-focus-block", () => {
      this.ctx.selectBlock(this.reply.id, this.block.id);
      this.ctx.handlers.onFocusNotice?.(translate("block.focusHelp", { title: this.block.title?.trim() || translate(this.kindKey) }));
    });
    this.askBtn = button("", "", () => this.toggleAsk());
    this.editBtn = button("", "", () => this.beginEdit());
    this.tools.append(this.focusBtn, this.askBtn, this.editBtn);
    head.append(this.heading, this.tools);

    this.body = el("div", "rb-block-body");
    this.editArea = el("div", "rb-area");
    this.editArea.hidden = true;
    this.askArea = el("div", "rb-area");
    this.askArea.hidden = true;
    this.root.append(head, this.body, this.editArea, this.askArea);

    this.root.addEventListener("focusin", () => {
      if (!this.ctx.isBlockSelected(this.reply.id, this.block.id)) {
        this.ctx.selectBlock(this.reply.id, this.block.id);
      }
    });
    this.root.addEventListener("input", () => this.persistDrafts());
    this.root.addEventListener("change", () => this.persistDrafts());
  }

  /** Re-render with fresh data. Never touches an open editor's inputs or ask draft. */
  render(reply: BoardReply, block: ReplyBlock): void {
    if (this.edit && this.reply && this.edit.expectedRevision === this.reply.revision &&
      (block.type === "artifact" ? semanticBlockKey(this.block) === semanticBlockKey(block) : contentKey(this.block) === contentKey(block))) {
      this.edit.expectedRevision = reply.revision;
    }
    this.reply = reply;
    // The board only hands a view blocks of the type it was created for.
    this.block = block as B;
    this.root.dataset.blockId = block.id;
    this.renderHead();
    if (this.edit) {
      this.updateEditFrame();
      if (this.keepBodyWhileEditing) this.renderView();
    } else {
      this.body.hidden = false;
      this.renderView();
    }
    this.updateAskFrame();
    this.refreshSelection();
  }

  /** Locale changed: rebuild labels, keep drafts. */
  relabel(): void {
    this.renderHead();
    if (this.edit) {
      this.buildEditFrame();
      if (this.keepBodyWhileEditing) this.renderView();
    } else {
      this.renderView();
    }
    if (this.ask) this.buildAskFrame();
    this.refreshSelection();
  }

  refreshSelection(): void {
    const on = this.ctx.isBlockSelected(this.reply.id, this.block.id);
    this.root.classList.toggle("is-selected", on);
    this.focusBtn.setAttribute("aria-pressed", String(on));
    this.focusBtn.textContent = translate(on ? "block.focusActive" : "block.focus");
    this.focusBtn.dataset.focusLabel = translate("block.focus");
    this.focusBtn.title = on ? translate("block.focusHelp", { title: this.block.title?.trim() || translate(this.kindKey) }) : translate("block.focus");
    this.selectedTag.textContent = on ? translate("block.selected") : "";
    if (on && !this.selectedTag.isConnected) this.kindEl.append(this.selectedTag);
    if (!on && this.selectedTag.isConnected) this.selectedTag.remove();
    const target = on ? this.ctx.selection()?.target : undefined;
    this.body.querySelectorAll<HTMLElement>("[data-target-id]").forEach(node => {
      const selected = target?.id === node.dataset.targetId && target?.kind === node.dataset.targetKind;
      node.classList.toggle("is-targeted", selected);
      const button = node.querySelector<HTMLButtonElement>(".rb-target-button");
      if (button) { button.setAttribute("aria-pressed", String(selected)); button.textContent = imageText(selected ? "focused" : "focus"); }
    });
  }

  protected focusTarget(target: ReplyTarget, region?: CanvasAnchor["region"]): void {
    this.ctx.selectBlock(this.reply.id, this.block.id, target, region);
    this.ctx.handlers.onFocusNotice?.(imageText(region ? "regionSelected" : "focused"));
  }

  protected renderImage(image: ReplyImageReference, target: ReplyTarget): HTMLElement {
    const selection = this.ctx.selection();
    const region = selection?.reply_id === this.reply.id && selection.block_id === this.block.id && contentKey(selection.target) === contentKey(target) ? selection.region : undefined;
    const canvas = this.ctx.handlers.getCanvas?.(), owner = this.reply.object_id ?? "";
    return referencePreview(image, referenceState(canvas, owner, image), selected => this.focusTarget(target, selected), region, imageAnnotations(canvas, owner, image.src, this.block.id, target), this.ctx.handlers.onAnnotation);
  }

  protected imageEditor(item: { image?: ReplyImageReference | null }): HTMLElement {
    const wrap = el("div", "rb-image-editor");
    const label = el("label", "rb-field", imageText("image"));
    const select = document.createElement("select"); select.setAttribute("aria-label", imageText("image"));
    select.append(new Option(imageText("none"), ""));
    const layout = this.ctx.handlers.getCanvas?.(), owner = this.reply.object_id ?? "";
    const choices = imageChoices(layout, owner);
    for (const object of choices) {
      const image = imageSnapshot(object), pinned = item.image?.object_id === object.id && item.image.content_revision !== object.content_revision ? item.image : undefined;
      select.append(new Option(pinned ? `${pinned.title || pinned.alt || imageText("image")} · ${imageText("saved")}` : image.title || image.alt || imageText("image"), image.object_id));
    }
    if (item.image && !choices.some(object => object.id === item.image!.object_id)) select.append(new Option(item.image.title || imageText("saved"), item.image.object_id));
    select.value = item.image?.object_id ?? "";
    select.addEventListener("change", () => { const object = choices.find(object => object.id === select.value); item.image = object ? imageSnapshot(object) : undefined; this.rebuildEditor(); });
    label.append(select); wrap.append(label);
    if (item.image) {
      const state = referenceState(layout, owner, item.image);
      wrap.append(referencePreview(item.image, state));
      const current = choices.find(object => object.id === item.image!.object_id);
      if (state === "changed" && current) wrap.append(button(imageText("refresh"), "rb-quiet", () => { item.image = imageSnapshot(current); this.rebuildEditor(); }));
    } else if (!choices.length) wrap.append(el("p", "rb-small", imageText("empty")), el("p", "rb-small", imageText("external")));
    return wrap;
  }

  protected renderArtifact(reference: ReplyArtifactReference): HTMLElement {
    return artifactReferencePreview(reference, artifactReferenceState(this.ctx.handlers.getBoard?.(), this.reply.object_id || "", reference));
  }

  protected artifactEditor(item: { artifact?: ReplyArtifactReference | null }): HTMLElement {
    const wrap = el("div", "rb-image-editor"), label = el("label", "rb-field", artifactText("label"));
    const select = document.createElement("select"); select.setAttribute("aria-label", artifactText("label")); select.append(new Option(artifactText("none"), ""));
    const board = this.ctx.handlers.getBoard?.(), owner = this.reply.object_id || "", choices = artifactChoices(board, owner);
    const key = item.artifact ? JSON.stringify([item.artifact.object_id, item.artifact.block_id]) : "";
    for (const choice of choices) {
      const pinned = key === artifactChoiceKey(choice) && item.artifact;
      const title = pinned ? pinned.title || artifactText("work") : choice.block.title || choice.reply.title || artifactText("work");
      select.append(new Option(pinned ? `${title} · ${artifactText("saved")}` : title, artifactChoiceKey(choice)));
    }
    if (key && !choices.some(c => artifactChoiceKey(c) === key)) select.append(new Option(item.artifact!.title || artifactText("saved"), key));
    select.value = key; select.onchange = () => { const choice = choices.find(c => artifactChoiceKey(c) === select.value); item.artifact = choice ? artifactSnapshot(choice) : undefined; this.rebuildEditor(); };
    label.append(select); wrap.append(label);
    if (item.artifact) {
      const state = artifactReferenceState(board, owner, item.artifact); wrap.append(artifactReferencePreview(item.artifact, state));
      const current = choices.find(c => artifactChoiceKey(c) === key);
      if (state === "changed" && current) wrap.append(button(artifactText("refresh"), "rb-quiet", () => { item.artifact = artifactSnapshot(current); this.rebuildEditor(); }));
    } else if (!choices.length) wrap.append(el("p", "rb-small", artifactText("empty")));
    return wrap;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.persistDrafts();
    this.destroyed = true;
    this.root.remove();
  }

  private draftRef(kind: DraftRecord["kind"], context: DraftRecord["context"] = null) {
    return { source_id: this.reply.source_id, object_id: this.reply.object_id, reply_id: this.reply.id, block_id: this.block.id, block_type: this.block.type, kind, context };
  }

  protected persistDrafts(): void {
    if (!this.reply || !this.block || this.destroyed) return;
    const save = (record: DraftRecord) => {
      const ok = replyDrafts.put(record);
      if (!ok && !this.storageWarned) { this.storageWarned = true; this.ctx.reportError(ct("draftUnsafe")); }
      if (ok) this.storageWarned = false;
      return replyDrafts.get(draftKey(record))?.updated_at;
    };
    if (this.edit) {
      const block = this.draftToBlock(this.edit.draft);
      if (contentKey(block) !== contentKey(this.edit.baseBlock)) {
        this.edit.draftStamp = save({ ...this.draftRef("edit"), reply_title: this.reply.title, expected_revision: this.edit.expectedRevision,
          updated_at: Date.now(), block, base_block: this.edit.baseBlock,
          focus_id: (this.edit.draft as { nodeId?: string | null }).nodeId });
      } else if (this.edit.draftStamp !== undefined) { replyDrafts.remove(draftKey(this.draftRef("edit")), this.edit.draftStamp); }
    }
    if (this.ask && this.ask.text.trim()) {
      this.ask.draftStamp = save({ ...this.draftRef("ask", this.ask.context), reply_title: this.reply.title,
        expected_revision: this.ask.expectedRevision, updated_at: Date.now(), text: this.ask.text });
    } else if (this.ask?.draftStamp !== undefined) { replyDrafts.remove(draftKey(this.draftRef("ask", this.ask.context)), this.ask.draftStamp); }
  }

  restoreDraft(record: DraftRecord): boolean {
    if (this.destroyed || record.source_id !== this.reply.source_id || record.block_type !== this.block.type || this.edit?.busy || this.ask?.busy) return false;
    if (record.kind === "edit") {
      if (!this.edit) this.beginEdit();
      this.edit?.form?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    } else { this.openAsk(record.context ?? null); }
    this.root.scrollIntoView({ block: "nearest" });
    return true;
  }

  protected renderHead(): void {
    this.kindEl.textContent = translate(this.kindKey);
    const title = (this.block.title ?? "").trim();
    this.titleEl.textContent = title;
    this.titleEl.hidden = title.length === 0;
    this.focusBtn.textContent = translate("block.focus");
    this.askBtn.textContent = translate("action.ask");
    this.askBtn.setAttribute("aria-expanded", String(this.ask !== null));
    this.editBtn.textContent = translate("action.edit");
    this.editBtn.setAttribute("aria-expanded", String(this.edit !== null));
  }

  protected abstract renderView(): void;
  protected editingBase(): ReplyBlock { return structuredClone(this.block); }
  protected abstract createDraft(block?: B): D;
  protected abstract renderEditor(form: HTMLElement, draft: D): void;
  protected abstract draftToBlock(draft: D): B;

  /* ---------------- ask ---------------- */

  protected toggleAsk(): void {
    if (this.ask) {
      this.closeAsk();
    } else {
      this.openAsk(null);
    }
  }

  protected openAsk(context: DraftRecord["context"]): void {
    if (this.ask?.busy) return;
    if (!context?.anchors) {
      const selected = this.ctx.selection();
      if (selected?.reply_id === this.reply.id && selected.block_id === this.block.id && selected.target && this.reply.object_id) {
        const image = targetImage(this.block, selected.target);
        const artifact_reference = targetArtifact(this.block, selected.target);
        const object = this.ctx.handlers.getCanvas?.()?.objects.find(object => object.id === this.reply.object_id);
        context = { label: context?.label ?? imageText("focused"), prefix: context?.prefix ?? "", ...context,
          anchors: [{ object_id: this.reply.object_id, content_revision: object?.content_revision ?? this.reply.revision, block_id: this.block.id, target: selected.target, ...(image ? { image } : {}), ...(artifact_reference ? { artifact_reference } : {}), ...(selected.region ? { region: selected.region } : {}) }] };
      }
    }
    if (this.ask && ((this.ask.context?.prefix ?? "") !== (context?.prefix ?? "") ||
      contentKey(this.ask.context?.artifact_context) !== contentKey(context?.artifact_context) || contentKey(this.ask.context?.anchors) !== contentKey(context?.anchors))) this.closeAsk();
    if (!this.ask) {
      const saved = replyDrafts.get(draftKey(this.draftRef("ask", context)));
      this.ask = {
        text: saved?.text ?? "",
        expectedRevision: saved?.expected_revision ?? this.reply.revision,
        draftStamp: saved?.updated_at,
        preserveContext: Boolean(saved),
        busy: false,
        error: null,
        context,
        frame: null,
        input: null,
        sendBtn: null,
        cancelBtn: null,
        errorEl: null,
        chipHost: null,
      };
      this.buildAskFrame();
    } else {
      this.ask.context = context;
      this.renderAskChip();
      this.updateAskFrame();
    }
    this.askBtn.setAttribute("aria-expanded", "true");
    this.ask.input?.focus();
  }

  protected closeAsk(discard = false): void {
    if (this.ask?.busy) return;
    if (discard && this.ask?.draftStamp !== undefined) replyDrafts.remove(draftKey(this.draftRef("ask", this.ask.context)), this.ask.draftStamp);
    else this.persistDrafts();
    this.ask = null;
    this.askArea.hidden = true;
    this.askArea.replaceChildren();
    this.askBtn.setAttribute("aria-expanded", "false");
  }

  private buildAskFrame(): void {
    const ask = this.ask;
    if (!ask) return;
    const frame = el("form", "rb-form");
    frame.noValidate = true;
    frame.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitAsk();
    });

    const field = el("div", "rb-field");
    const id = this.ctx.uid();
    const label = el("label", undefined, translate("ask.label"));
    label.htmlFor = id;
    const chipHost = el("div");
    const input = textArea(ask.text, (v) => {
      ask.text = v;
    });
    input.id = id;
    input.placeholder = translate("ask.placeholder");
    input.maxLength = 4000;
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void this.submitAsk();
      }
    });
    field.append(label, chipHost, input);

    const actions = el("div", "rb-form-actions");
    const sendBtn = el("button", "rb-primary", translate("action.send"));
    sendBtn.type = "submit";
    const cancelBtn = button(translate("action.cancel"), "rb-quiet", () => this.closeAsk(true));
    actions.append(sendBtn, cancelBtn);

    const errorEl = el("p", "rb-error");
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;

    frame.append(field, actions, errorEl);
    Object.assign(ask, { frame, input, sendBtn, cancelBtn, errorEl, chipHost });
    this.askArea.replaceChildren(frame);
    this.askArea.hidden = false;
    this.renderAskChip();
    this.updateAskFrame();
  }

  private renderAskChip(): void {
    const ask = this.ask;
    if (!ask?.chipHost) return;
    ask.chipHost.replaceChildren();
    if (!ask.context) return;
    const chip = el("span", "rb-context-chip");
    chip.append(el("span", undefined, translate("ask.context", { label: ask.context.label })));
    chip.append(
      button(translate("action.clear"), "rb-quiet", () => {
        if (!ask.busy && this.ask) {
          this.openAsk(null);
        }
      }),
    );
    ask.chipHost.append(chip);
  }

  private updateAskFrame(): void {
    const ask = this.ask;
    if (!ask?.frame) return;
    if (ask.input) ask.input.disabled = ask.busy;
    if (ask.sendBtn) {
      ask.sendBtn.disabled = ask.busy;
      ask.sendBtn.textContent = ask.busy ? translate("action.sending") : translate("action.send");
    }
    if (ask.cancelBtn) ask.cancelBtn.disabled = ask.busy;
    if (ask.errorEl) {
      ask.errorEl.hidden = !ask.error;
      ask.errorEl.textContent = ask.error ?? "";
    }
  }

  private async submitAsk(): Promise<void> {
    const ask = this.ask;
    if (!ask || ask.busy) return;
    const trimmed = ask.text.trim();
    if (!trimmed) {
      ask.input?.focus();
      return;
    }
    ask.busy = true;
    this.persistDrafts();
    const storedKey = draftKey(this.draftRef("ask", ask.context));
    const storedStamp = ask.draftStamp;
    ask.error = null;
    this.updateAskFrame();
    try {
      await this.beforeAsk();
      this.persistDrafts();
      const latestKey = draftKey(this.draftRef("ask", ask.context));
      const latestStamp = ask.draftStamp;
      const request: ReplyActionInput = {
        object_id: this.reply.object_id, reply_id: this.reply.id,
        block_id: this.block.id,
        action: "ask",
        text: ask.context ? `${ask.context.prefix}${trimmed}` : trimmed,
        ...(ask.context?.artifact_context ? { artifact_context: ask.context.artifact_context } : {}),
        ...(ask.context?.anchors ? { anchors: ask.context.anchors } : {}),
      };
      const updated = await this.ctx.handlers.onAction(request);
      replyDrafts.remove(storedKey, storedStamp);
      replyDrafts.remove(latestKey, latestStamp);
      if (this.destroyed) return;
      if (this.ask !== ask) return;
      ask.busy = false;
      ask.text = "";
      ask.context = null;
      // The shared composer tracks the real delivery receipt. Do not leave a
      // second, frozen "saved" status beside an already handled request.
      this.closeAsk();
      this.ctx.mergeReply(updated);
      this.askBtn.focus({ preventScroll: true });
    } catch (err) {
      if (this.destroyed) return;
      if (this.ask !== ask) return;
      ask.busy = false;
      const { user, detail } = friendlyError(err, translate("ask.failed"));
      ask.error = user;
      this.updateAskFrame();
      this.ctx.reportError(detail);
    }
  }

  protected async beforeAsk(): Promise<void> {}

  /* ---------------- edit ---------------- */

  protected beginEdit(): void {
    if (this.edit) {
      this.cancelEdit(false);
      return;
    }
    const saved = replyDrafts.get(draftKey(this.draftRef("edit")));
    const draft = this.createDraft(saved?.block as B | undefined);
    if (saved?.focus_id && draft && typeof draft === "object" && "nodeId" in draft) (draft as { nodeId: string }).nodeId = saved.focus_id;
    this.edit = {
      expectedRevision: saved?.base_block && semanticBlockKey(saved.base_block) !== semanticBlockKey(this.block) ? saved.expected_revision : this.reply.revision,
      baseBlock: saved?.base_block ?? this.editingBase(),
      draftStamp: saved?.updated_at,
      draft,
      busy: false,
      error: null,
      frame: null,
      form: null,
      stale: null,
      errorEl: null,
      saveBtn: null,
      cancelBtn: null,
      statusEl: null,
    };
    this.body.hidden = !this.keepBodyWhileEditing;
    this.editBtn.setAttribute("aria-expanded", "true");
    this.buildEditFrame();
    const first = this.edit.form?.querySelector<HTMLElement>("input, textarea, select");
    first?.focus();
  }

  protected cancelEdit(discard = true): void {
    if (this.edit?.busy) return;
    if (discard && this.edit?.draftStamp !== undefined) replyDrafts.remove(draftKey(this.draftRef("edit")), this.edit.draftStamp);
    else this.persistDrafts();
    this.edit = null;
    this.editArea.hidden = true;
    this.editArea.replaceChildren();
    this.body.hidden = false;
    this.editBtn.setAttribute("aria-expanded", "false");
    this.renderView();
    this.editBtn.focus();
  }

  /** Rebuild only the form part from the current draft (structural edits, locale). */
  protected rebuildEditor(): void {
    const edit = this.edit;
    if (!edit?.form) return;
    edit.form.replaceChildren();
    this.renderEditor(edit.form, edit.draft);
    this.persistDrafts();
  }

  private buildEditFrame(): void {
    const edit = this.edit;
    if (!edit) return;
    const frame = el("form", "rb-form");
    frame.noValidate = true;
    frame.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveEdit();
    });

    const stale = el("div", "rb-notice");
    stale.setAttribute("role", "status");
    stale.hidden = true;
    stale.append(el("span", undefined, translate("edit.stale")));
    stale.append(button(translate("action.discard"), "", () => this.discardAndReload()));

    const form = el("div", "rb-form");
    this.renderEditor(form, edit.draft);

    const actions = el("div", "rb-form-actions");
    const saveBtn = el("button", "rb-primary", translate("action.save"));
    saveBtn.type = "submit";
    const cancelBtn = button(translate("action.cancel"), "rb-quiet", () => this.cancelEdit());
    const statusEl = el("span", "rb-status");
    statusEl.setAttribute("aria-live", "polite");
    actions.append(saveBtn, cancelBtn, statusEl);

    const errorEl = el("div", "rb-error");
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;

    frame.append(stale, form, actions, errorEl);
    Object.assign(edit, { frame, form, stale, errorEl, saveBtn, cancelBtn, statusEl });
    this.editArea.replaceChildren(frame);
    this.editArea.hidden = false;
    this.updateEditFrame();
  }

  private updateEditFrame(): void {
    const edit = this.edit;
    if (!edit?.frame) return;
    if (edit.stale) edit.stale.hidden = this.reply.revision === edit.expectedRevision;
    if (edit.saveBtn) {
      edit.saveBtn.disabled = edit.busy;
      edit.saveBtn.textContent = edit.busy ? translate("action.saving") : translate("action.save");
    }
    if (edit.cancelBtn) edit.cancelBtn.disabled = edit.busy;
    if (edit.errorEl) {
      edit.errorEl.hidden = !edit.error;
      edit.errorEl.replaceChildren();
      if (edit.error) {
        edit.errorEl.append(el("p", undefined, edit.error));
        if (this.reply.revision !== edit.expectedRevision) {
          const discard = button(translate("action.discard"), "", () => this.discardAndReload());
          discard.style.marginTop = "8px";
          edit.errorEl.append(discard);
        }
      }
    }
    edit.form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
      "input, textarea, select, button",
    ).forEach((control) => {
      control.disabled = edit.busy;
    });
  }

  private discardAndReload(): void {
    if (this.edit?.busy) return;
    replyDrafts.remove(draftKey(this.draftRef("edit")));
    this.edit = null;
    this.editArea.hidden = true;
    this.editArea.replaceChildren();
    this.body.hidden = false;
    this.editBtn.setAttribute("aria-expanded", "false");
    this.renderView();
    this.editBtn.focus();
  }

  private async saveEdit(): Promise<void> {
    const edit = this.edit;
    if (!edit || edit.busy) return;
    edit.busy = true;
    this.persistDrafts();
    const storedKey = draftKey(this.draftRef("edit"));
    edit.error = null;
    this.updateEditFrame();
    const block = this.draftToBlock(edit.draft);
    const request: ReplyPatchRequest = {
      object_id: this.reply.object_id, reply_id: this.reply.id,
      expected_revision: edit.expectedRevision,
      block,
      layout_only: block.type === "graph" && semanticBlockKey(block) === semanticBlockKey(this.block),
    };
    try {
      const updated = await this.ctx.handlers.onPatch(request);
      replyDrafts.remove(storedKey, edit.draftStamp);
      if (this.destroyed) return;
      if (this.edit !== edit) return;
      this.edit = null;
      this.editArea.hidden = true;
      this.editArea.replaceChildren();
      this.body.hidden = false;
      this.editBtn.setAttribute("aria-expanded", "false");
      this.ctx.mergeReply(updated);
      this.editBtn.focus();
    } catch (err) {
      if (this.destroyed) return;
      if (this.edit !== edit) return;
      edit.busy = false;
      const conflict = looksLikeConflict(err) || this.reply.revision !== edit.expectedRevision;
      const { user, detail } = friendlyError(err, translate(conflict ? "edit.conflict" : "edit.failed"));
      edit.error = conflict ? translate("edit.conflict") : user;
      this.updateEditFrame();
      this.ctx.reportError(detail);
    }
  }

  /* ---------------- small form helpers ---------------- */

  protected labeled(labelText: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): HTMLElement {
    const id = this.ctx.uid();
    control.id = id;
    const wrap = el("div", "rb-field");
    const label = el("label", undefined, labelText);
    label.htmlFor = id;
    wrap.append(label, control);
    return wrap;
  }
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

type TextDraft = { title: string; text: string };

class ArtifactView extends BlockView<ReplyArtifactBlock, TextDraft> {
  private artifact: ArtifactFrame | null = null;
  private management: HTMLDialogElement | null = null;
  constructor(ctx: BoardContext) { super(ctx, "kind.artifact"); this.keepBodyWhileEditing = true; }
  protected renderHead(): void {
    super.renderHead();
    if (this.block.title?.trim() === this.reply.title.trim()) this.titleEl.hidden = true;
  }
  protected renderView(): void {
    this.artifact ??= new ArtifactFrame(this.body, reply => this.ctx.mergeReply(reply), error => this.ctx.reportError(error), async bundle_id => {
      const reply = await this.ctx.handlers.onPatch({ object_id: this.reply.object_id, reply_id: this.reply.id, expected_revision: this.reply.revision, block: { ...this.block, bundle_id } });
      this.ctx.mergeReply(reply);
    }, this.ctx.handlers.dataflow, (height, mode, explicit) => this.ctx.handlers.onArtifactPresentationChange?.(this.reply.id, this.block.id, height, mode, explicit), this.ctx.handlers.onArtifactWheel);
    this.manageCanvasWork();
    this.artifact.update(this.reply, this.block);
  }
  private manageCanvasWork() {
    const standalone = Boolean(this.ctx.handlers.onArtifactPresentationChange) && this.reply.blocks.length === 1;
    this.root.classList.toggle("rb-work-block", standalone);
    if (standalone && !this.management) {
      const dialog = el("dialog", "board-dialog artifact-management");
      const header = el("header"), title = el("h2", "", ct("workSettings"));
      header.append(title, button(ct("close"), "ghost", () => dialog.close()));
      dialog.setAttribute("aria-label", ct("workSettings"));
      const head = this.root.querySelector<HTMLElement>(".rb-block-head")!;
      dialog.append(header, head, this.editArea, this.askArea);
      this.artifact!.manageIn(dialog);
      this.root.append(dialog); this.management = dialog;
    } else if (!standalone && this.management) {
      if (this.management.open) this.management.close();
      this.root.prepend(this.management.querySelector<HTMLElement>(".rb-block-head")!);
      this.root.append(this.editArea, this.askArea); this.artifact!.manageIn(null);
      this.management.remove(); this.management = null;
    }
    if (this.management) {
      this.management.setAttribute("aria-label", ct("workSettings"));
      this.management.querySelector("h2")!.textContent = ct("workSettings");
      this.management.querySelector("header > button")!.textContent = ct("close");
    }
  }
  protected toggleAsk(): void { if (this.ask) this.closeAsk(); else this.openAsk(this.artifact?.context() ?? null); }
  protected async beforeAsk(): Promise<void> {
    await this.artifact?.flush();
    if (this.ask && !this.ask.preserveContext) this.ask.context = this.artifact?.context() ?? null;
  }
  canvasAnchor() { return this.artifact?.canvasAnchor(); }
  async prepareFeedback() { await this.artifact?.flush(); }
  protected createDraft(block = this.block): TextDraft { return { title: block.title ?? "", text: block.description }; }
  protected renderEditor(form: HTMLElement, draft: TextDraft): void {
    form.append(this.labeled(translate("edit.titleOptional"), textInput(draft.title, v => { draft.title = v; })),
      this.labeled(translate("edit.text"), textArea(draft.text, v => { draft.text = v; })));
  }
  protected draftToBlock(draft: TextDraft): ReplyArtifactBlock { return { ...this.block, title: draft.title, description: draft.text }; }
  destroy() { this.artifact?.destroy(); this.artifact = null; super.destroy(); }
}

class TextView extends BlockView<ReplyTextBlock, TextDraft> {
  constructor(ctx: BoardContext) {
    super(ctx, "kind.text");
  }

  protected renderView(): void {
    const wrap = el("div", "rb-text");
    renderLightText(wrap, this.block.text);
    this.body.replaceChildren(wrap);
  }

  protected createDraft(block = this.block): TextDraft {
    return { title: block.title ?? "", text: block.text };
  }

  protected renderEditor(form: HTMLElement, draft: TextDraft): void {
    form.append(this.labeled(translate("edit.titleOptional"), textInput(draft.title, (v) => (draft.title = v))));
    const rows = Math.min(18, Math.max(4, draft.text.split("\n").length + 1));
    form.append(this.labeled(translate("edit.text"), textArea(draft.text, (v) => (draft.text = v), rows)));
  }

  protected draftToBlock(draft: TextDraft): ReplyTextBlock {
    const title = draft.title.trim();
    return { id: this.block.id, type: "text", ...(title ? { title } : {}), text: draft.text };
  }
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

type ComparisonDraft = {
  title: string;
  criteria: string[];
  options: ReplyOption[];
  selected_id: string | null;
};

class ComparisonView extends BlockView<ReplyComparisonBlock, ComparisonDraft> {
  private pickingId: string | null = null;
  private pickError: string | null = null;

  constructor(ctx: BoardContext) {
    super(ctx, "kind.comparison");
  }

  protected renderView(): void {
    const block = this.block;
    const frag: Node[] = [];
    const selected = block.options.find((o) => o.id === block.selected_id) ?? null;

    if (block.options.length === 0) {
      frag.push(el("p", "rb-mute", translate("cmp.empty")));
    } else {
      const grid = el("div", "rb-cmp-grid");
      grid.setAttribute("role", "group");
      block.options.forEach((option, index) => {
        const card = el("article", "rb-cmp-card");
        card.dataset.targetId = option.id; card.dataset.targetKind = "option";
        const isChosen = option.id === block.selected_id;
        card.classList.toggle("is-selected", isChosen);

        const head = el("div", "rb-cmp-card-head");
        head.append(el("span", "rb-small", translate("edit.option", { n: index + 1 })));
        if (isChosen) head.append(el("span", "rb-small rb-block-selected-tag", translate("cmp.chosen")));
        card.append(head);
        card.append(el("h4", undefined, displayTitle(option.title)));
        if (option.summary.trim()) card.append(el("p", "rb-cmp-summary", option.summary));
        if (option.image) card.append(this.renderImage(option.image, { kind: "option", id: option.id }));
        if (option.artifact) card.append(this.renderArtifact(option.artifact));

        const dl = el("dl");
        const rows = Math.max(block.criteria.length, option.values.length);
        for (let i = 0; i < rows; i += 1) {
          const criterion = block.criteria[i];
          const dt = el("dt", undefined, criterion !== undefined ? criterion : translate("cmp.extra"));
          const value = option.values[i];
          const dd = el("dd", undefined, value !== undefined && value.trim() ? value : translate("cmp.noValue"));
          dl.append(dt, dd);
        }
        card.append(dl);

        const pick = button(
          this.pickingId === option.id
            ? translate("cmp.choosing")
            : isChosen
              ? translate("cmp.chosen")
              : translate("cmp.choose"),
          "rb-pick",
          () => void this.pick(option.id),
        );
        pick.setAttribute("aria-pressed", String(isChosen));
        pick.disabled = this.pickingId !== null;
        card.append(pick);
        card.append(button(imageText("focus"), "rb-quiet rb-target-button", () => this.focusTarget({ kind: "option", id: option.id })));
        grid.append(card);
      });
      frag.push(grid);

      const current = el("p", "rb-cmp-current");
      current.setAttribute("aria-live", "polite");
      current.append(document.createTextNode(translate("cmp.current") + " "));
      current.append(el("strong", undefined, selected ? displayTitle(selected.title) : translate("cmp.none")));
      frag.push(current);
    }

    if (this.pickError) {
      const err = el("p", "rb-error", this.pickError);
      err.setAttribute("role", "alert");
      frag.push(err);
    }
    this.body.replaceChildren(...frag);
    this.refreshSelection();
  }

  private async pick(optionId: string): Promise<void> {
    if (this.pickingId) return;
    this.pickingId = optionId;
    this.pickError = null;
    this.renderView();
    const request: ReplyActionInput = {
      object_id: this.reply.object_id, reply_id: this.reply.id,
      block_id: this.block.id,
      action: "select",
      option_id: optionId,
    };
    try {
      const updated = await this.ctx.handlers.onAction(request);
      if (this.destroyed) return;
      this.pickingId = null;
      this.ctx.mergeReply(updated);
      if (!this.edit) this.renderView();
    } catch (err) {
      this.pickingId = null;
      const { user, detail } = friendlyError(err, translate("cmp.failed"));
      this.pickError = user;
      if (!this.edit) this.renderView();
      this.ctx.reportError(detail);
    }
  }

  protected createDraft(block = this.block): ComparisonDraft {
    return {
      title: block.title ?? "",
      criteria: [...block.criteria],
      options: block.options.map((o) => ({ ...o, values: [...o.values] })),
      selected_id: block.selected_id ?? null,
    };
  }

  protected renderEditor(form: HTMLElement, draft: ComparisonDraft): void {
    form.append(this.labeled(translate("edit.titleOptional"), textInput(draft.title, (v) => (draft.title = v))));

    // Criteria
    const criteria = el("fieldset", "rb-fieldset");
    criteria.append(el("legend", undefined, translate("edit.criteria")));
    draft.criteria.forEach((criterion, index) => {
      const row = el("div", "rb-inline");
      const input = textInput(criterion, (v) => (draft.criteria[index] = v));
      input.setAttribute("aria-label", translate("edit.criterion", { n: index + 1 }));
      const tools = el("div", "rb-row-tools");
      tools.append(
        button(translate("action.up"), "rb-quiet", () => {
          moveItem(draft.criteria, index, index - 1);
          draft.options.forEach((o) => moveItem(o.values, index, index - 1));
          this.rebuildEditor();
        }),
        button(translate("action.down"), "rb-quiet", () => {
          moveItem(draft.criteria, index, index + 1);
          draft.options.forEach((o) => moveItem(o.values, index, index + 1));
          this.rebuildEditor();
        }),
        button(translate("action.remove"), "rb-quiet", () => {
          draft.criteria.splice(index, 1);
          draft.options.forEach((o) => o.values.splice(index, 1));
          this.rebuildEditor();
        }),
      );
      row.append(input, tools);
      criteria.append(row);
    });
    criteria.append(
      button(translate("edit.addCriterion"), "", () => {
        draft.criteria.push("");
        draft.options.forEach((o) => {
          while (o.values.length < draft.criteria.length) o.values.push("");
        });
        this.rebuildEditor();
      }),
    );
    form.append(criteria);

    // Options
    const options = el("div", "rb-grid-2");
    draft.options.forEach((option, index) => {
      const set = el("fieldset", "rb-fieldset");
      set.append(el("legend", undefined, translate("edit.option", { n: index + 1 })));
      const head = el("div", "rb-fieldset-head");
      head.append(
        el("span", "rb-small", option.id === draft.selected_id ? translate("cmp.chosen") : ""),
        button(translate("action.up"), "rb-quiet", () => {
          moveItem(draft.options, index, index - 1);
          this.rebuildEditor();
        }),
        button(translate("action.down"), "rb-quiet", () => {
          moveItem(draft.options, index, index + 1);
          this.rebuildEditor();
        }),
        button(translate("action.remove"), "rb-quiet", () => {
          draft.options.splice(index, 1);
          if (draft.selected_id === option.id) draft.selected_id = null;
          this.rebuildEditor();
        }),
      );
      set.append(head);
      set.append(this.labeled(translate("edit.optionTitle"), textInput(option.title, (v) => (option.title = v))));
      set.append(this.imageEditor(option), this.artifactEditor(option));
      set.append(
        this.labeled(translate("edit.optionSummary"), textArea(option.summary, (v) => (option.summary = v), 2)),
      );
      draft.criteria.forEach((criterion, ci) => {
        while (option.values.length <= ci) option.values.push("");
        const label = criterion.trim() || translate("edit.criterion", { n: ci + 1 });
        set.append(this.labeled(label, textArea(option.values[ci], (v) => (option.values[ci] = v), 2)));
      });
      options.append(set);
    });
    form.append(options);
    form.append(
      button(translate("edit.addOption"), "", () => {
        draft.options.push({
          id: newId("option"),
          title: "",
          summary: "",
          values: draft.criteria.map(() => ""),
        });
        this.rebuildEditor();
      }),
    );
  }

  protected draftToBlock(draft: ComparisonDraft): ReplyComparisonBlock {
    const title = draft.title.trim();
    const criteria = draft.criteria.map((c) => c.trim());
    const options = draft.options.map((o) => ({
      id: o.id,
      title: o.title.trim(),
      summary: o.summary.trim(),
      values: criteria.map((_, i) => (o.values[i] ?? "").trim()),
      ...(o.image ? { image: o.image } : {}),
      ...(o.artifact ? { artifact: o.artifact } : {}),
    }));
    const selected = options.some((o) => o.id === draft.selected_id) ? draft.selected_id : null;
    return {
      id: this.block.id,
      type: "comparison",
      ...(title ? { title } : {}),
      criteria,
      options,
      selected_id: selected,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Sequence                                                            */
/* ------------------------------------------------------------------ */

type SequenceDraft = { title: string; steps: ReplyStep[] };

class SequenceView extends BlockView<ReplySequenceBlock, SequenceDraft> {
  private focusedStepId: string | null = null;

  constructor(ctx: BoardContext) {
    super(ctx, "kind.sequence");
  }

  protected renderView(): void {
    const steps = this.block.steps;
    if (steps.length === 0) {
      this.body.replaceChildren(el("p", "rb-mute", translate("seq.empty")));
      return;
    }
    if (this.focusedStepId && !steps.some((s) => s.id === this.focusedStepId)) this.focusedStepId = null;

    const list = el("ol", "rb-seq");
    steps.forEach((step, index) => {
      const n = index + 1;
      const item = el("li", "rb-seq-item");
      item.dataset.targetId = step.id; item.dataset.targetKind = "step";
      const focused = step.id === this.focusedStepId;
      item.classList.toggle("is-focused", focused);

      const toggle = button("", "rb-seq-toggle", () => {
        this.focusedStepId = focused ? null : step.id;
        this.ctx.selectBlock(this.reply.id, this.block.id, this.focusedStepId ? { kind: "step", id: this.focusedStepId } : undefined);
        this.renderView();
      });
      toggle.setAttribute("aria-pressed", String(focused));
      const head = el("div", "rb-seq-head");
      head.append(el("span", "rb-seq-index", translate("seq.step", { n })));
      if (focused) head.append(el("span", "rb-small rb-block-selected-tag", translate("seq.focused")));
      toggle.append(head, el("span", "rb-seq-title", displayTitle(step.title)));
      item.append(toggle);
      if (step.image) item.append(this.renderImage(step.image, { kind: "step", id: step.id }));
      if (step.artifact) item.append(this.renderArtifact(step.artifact));

      const body = el("dl", "rb-seq-body");
      const addField = (labelKey: string, value: string | undefined, cls: string) => {
        if (!value || !value.trim()) return;
        const field = el("div", `rb-seq-field ${cls}`);
        field.append(el("dt", undefined, translate(labelKey)));
        const dd = el("dd");
        dd.style.margin = "0";
        const parts = paragraphs(value);
        dd.append(...(parts.length ? parts : [el("p", undefined, value)]));
        field.append(dd);
        body.append(field);
      };
      addField("seq.action", step.action, "is-action");
      addField("seq.feedback", step.feedback, "is-feedback");
      addField("seq.note", step.note, "is-note");
      item.append(body);

      const foot = el("div", "rb-seq-foot");
      foot.append(
        button(translate("seq.askStep"), "rb-quiet", () => {
          this.focusedStepId = step.id;
          this.focusTarget({ kind: "step", id: step.id });
          this.renderView();
          const label = translate("seq.stepContext", { n, title: displayTitle(step.title) });
          this.openAsk({ label, prefix: "" });
        }),
      );
      item.append(foot);
      list.append(item);
    });
    this.body.replaceChildren(list);
    this.refreshSelection();
  }

  protected createDraft(block = this.block): SequenceDraft {
    return { title: block.title ?? "", steps: block.steps.map((s) => ({ ...s })) };
  }

  protected renderEditor(form: HTMLElement, draft: SequenceDraft): void {
    form.append(this.labeled(translate("edit.titleOptional"), textInput(draft.title, (v) => (draft.title = v))));
    const grid = el("div", "rb-grid-2");
    draft.steps.forEach((step, index) => {
      const set = el("fieldset", "rb-fieldset");
      set.append(el("legend", undefined, translate("edit.step", { n: index + 1 })));
      const head = el("div", "rb-fieldset-head");
      head.append(
        el("span", "rb-small", ""),
        button(translate("action.up"), "rb-quiet", () => {
          moveItem(draft.steps, index, index - 1);
          this.rebuildEditor();
        }),
        button(translate("action.down"), "rb-quiet", () => {
          moveItem(draft.steps, index, index + 1);
          this.rebuildEditor();
        }),
        button(translate("action.remove"), "rb-quiet", () => {
          draft.steps.splice(index, 1);
          this.rebuildEditor();
        }),
      );
      set.append(head);
      set.append(this.labeled(translate("edit.stepTitle"), textInput(step.title, (v) => (step.title = v))));
      set.append(this.imageEditor(step), this.artifactEditor(step));
      set.append(this.labeled(translate("edit.stepAction"), textArea(step.action, (v) => (step.action = v), 3)));
      set.append(
        this.labeled(translate("edit.stepFeedback"), textArea(step.feedback ?? "", (v) => (step.feedback = v), 2)),
      );
      set.append(this.labeled(translate("edit.stepNote"), textArea(step.note ?? "", (v) => (step.note = v), 2)));
      grid.append(set);
    });
    form.append(grid);
    form.append(
      button(translate("edit.addStep"), "", () => {
        draft.steps.push({ id: newId("step"), title: "", action: "" });
        this.rebuildEditor();
      }),
    );
  }

  protected draftToBlock(draft: SequenceDraft): ReplySequenceBlock {
    const title = draft.title.trim();
    const steps = draft.steps.map((s) => {
      const feedback = (s.feedback ?? "").trim();
      const note = (s.note ?? "").trim();
      return {
        id: s.id,
        title: s.title.trim(),
        action: s.action.trim(),
        ...(feedback ? { feedback } : {}),
        ...(note ? { note } : {}),
        ...(s.image ? { image: s.image } : {}),
        ...(s.artifact ? { artifact: s.artifact } : {}),
      };
    });
    return { id: this.block.id, type: "sequence", ...(title ? { title } : {}), steps };
  }
}

/* ------------------------------------------------------------------ */
/* Graph (X6)                                                          */
/* ------------------------------------------------------------------ */

const NODE_W = 200;
const NODE_H = 72;
const LAYOUT_GAP_X = 48;
const LAYOUT_GAP_Y = 72;
const GRAPH_FONT = '"IBM Plex Sans", "Noto Sans SC", "Noto Sans JP", sans-serif';

const NODE_BASE_ATTRS = {
  body: { fill: "var(--rb-node-fill, #14161d)", stroke: "var(--rb-node-stroke, rgba(244, 241, 234, 0.24))", strokeWidth: 1, rx: 12, ry: 12 },
  label: {
    fill: "var(--rb-node-text, #f4f1ea)",
    fontSize: 13,
    fontFamily: GRAPH_FONT,
    textWrap: { width: -24, height: -16, ellipsis: true },
  },
};

const NODE_FOCUS_BODY = { fill: "var(--rb-node-focus, rgba(212, 179, 255, 0.14))", stroke: "var(--rb-node-focus-stroke, #d4b3ff)", strokeWidth: 2 };
const EDGE_BASE_LINE = { stroke: "var(--rb-edge-stroke, rgba(244, 241, 234, 0.45))", strokeWidth: 1.3, targetMarker: { name: "block", width: 9, height: 7 } };
const EDGE_FOCUS_LINE = { stroke: "var(--rb-node-focus-stroke, #d4b3ff)", strokeWidth: 2.5 };

function hasCoords(node: ReplyGraphNode): node is ReplyGraphNode & { x: number; y: number } {
  return typeof node.x === "number" && Number.isFinite(node.x) && typeof node.y === "number" && Number.isFinite(node.y);
}

/** Layered top-down placement for nodes lacking coordinates. */
function autoLayout(block: ReplyGraphBlock): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const ids = new Set(block.nodes.map((n) => n.id));
  const positioned = block.nodes.filter(hasCoords);
  const loose = block.nodes.filter((n) => !hasCoords(n));
  positioned.forEach((n) => result.set(n.id, { x: n.x, y: n.y }));
  if (loose.length === 0) return result;

  const looseIds = new Set(loose.map((n) => n.id));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  loose.forEach((n) => {
    indeg.set(n.id, 0);
    out.set(n.id, []);
  });
  block.edges.forEach((e) => {
    if (!looseIds.has(e.from) || !looseIds.has(e.to) || e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) return;
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  });
  const level = new Map<string, number>();
  const queue = loose.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  queue.forEach((id) => level.set(id, 0));
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of out.get(u) ?? []) {
      level.set(v, Math.max(level.get(v) ?? 0, (level.get(u) ?? 0) + 1));
      indeg.set(v, (indeg.get(v) ?? 1) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  loose.forEach((n) => {
    if (!level.has(n.id)) level.set(n.id, 0);
  });

  const rows = new Map<number, string[]>();
  loose.forEach((n) => {
    const l = level.get(n.id)!;
    if (!rows.has(l)) rows.set(l, []);
    rows.get(l)!.push(n.id);
  });
  const widest = Math.max(...[...rows.values()].map((r) => r.length));
  const totalWidth = widest * NODE_W + (widest - 1) * LAYOUT_GAP_X;
  let offsetX = 0;
  let offsetY = 0;
  if (positioned.length) {
    offsetX = Math.max(...positioned.map((n) => n.x)) + NODE_W + LAYOUT_GAP_X * 2;
    offsetY = Math.min(...positioned.map((n) => n.y));
  }
  [...rows.keys()]
    .sort((a, b) => a - b)
    .forEach((l) => {
      const row = rows.get(l)!;
      const rowWidth = row.length * NODE_W + (row.length - 1) * LAYOUT_GAP_X;
      const start = (totalWidth - rowWidth) / 2;
      row.forEach((id, i) => {
        result.set(id, {
          x: Math.round(offsetX + start + i * (NODE_W + LAYOUT_GAP_X)),
          y: Math.round(offsetY + l * (NODE_H + LAYOUT_GAP_Y)),
        });
      });
    });
  return result;
}

type GraphDraft = { title: string; nodeId: string | null; nodes: ReplyGraphNode[]; edges: ReplyGraphBlock["edges"] };

class GraphView extends BlockView<ReplyGraphBlock, GraphDraft> {
  private graph: Graph | null = null;
  private structureKey = "";
  private pendingFit = true;
  private focusedNodeId: string | null = null;
  private focusedEdgeId: string | null = null;
  private dragging = false;
  private layoutTimer: number | null = null;
  private statusTimer: number | null = null;
  private layoutInFlight = false;
  private layoutQueued = false;
  private layoutState: "idle" | "saving" | "saved" | "error" = "idle";

  private readonly toolsBar: HTMLElement;
  private readonly hintEl: HTMLElement;
  /** CSS-sized frame; X6 gets the inner host because it writes inline px sizes on its container. */
  private readonly canvas: HTMLElement;
  private readonly graphHost: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly below: HTMLElement;
  private readonly nodeListWrap: HTMLElement;
  private readonly detailWrap: HTMLElement;

  private shownBlock(): ReplyGraphBlock { return this.edit ? this.draftToBlock(this.edit.draft) : this.block; }
  protected editingBase(): ReplyBlock { return { ...this.block, nodes: this.currentNodes() }; }

  constructor(ctx: BoardContext) {
    super(ctx, "kind.graph");
    this.keepBodyWhileEditing = true;

    this.toolsBar = el("div", "rb-graph-tools");
    this.hintEl = el("span", "rb-small");
    this.canvas = el("div", "rb-graph-canvas");
    this.canvas.setAttribute("role", "img");
    this.graphHost = el("div", "rb-graph-host");
    this.canvas.append(this.graphHost);
    this.statusEl = el("div", "rb-graph-status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.hidden = true;
    this.below = el("div", "rb-graph-below");
    this.nodeListWrap = el("div");
    this.detailWrap = el("div", "rb-graph-detail");
    this.below.append(this.nodeListWrap, this.detailWrap);

    const canvasWrap = el("div");
    canvasWrap.style.position = "relative";
    canvasWrap.append(this.canvas, this.statusEl);
    this.body.append(this.toolsBar, canvasWrap, this.below);
  }

  protected renderView(): void {
    this.renderTools();
    this.canvas.setAttribute("aria-label", `${translate("graph.canvas")}: ${displayTitle(this.block.title)}`);
    this.syncFocusFromSelection();
    if (!this.focusedEdgeId && !this.focusedNodeId && this.edit?.draft.nodeId) this.focusedNodeId = this.edit.draft.nodeId;
    if (this.focusedNodeId && !this.shownBlock().nodes.some((n) => n.id === this.focusedNodeId)) this.focusedNodeId = null;
    if (this.focusedEdgeId && !this.shownBlock().edges.some((edge) => edge.id === this.focusedEdgeId)) this.focusedEdgeId = null;
    this.ensureGraph();
    this.syncGraph();
    this.renderNodeList();
    this.renderDetail();
    this.renderStatus();
  }

  private renderTools(): void {
    this.toolsBar.replaceChildren(
      button(translate("graph.zoomOut"), "", () => this.graph?.zoom(-0.15, { minScale: 0.3 })),
      button(translate("graph.zoomIn"), "", () => this.graph?.zoom(0.15, { maxScale: 2.5 })),
      button(translate("graph.fit"), "", () => this.fit()),
      this.hintEl,
    );
    this.hintEl.textContent = translate("graph.hint");
  }

  private ensureGraph(): void {
    if (this.graph) return;
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 380;
    const graph = new Graph({
      container: this.graphHost,
      width,
      height,
      // Edit/save reuses stable cell IDs. Flush removals before those IDs are added again.
      async: false,
      // X6 observes the host's parent (our CSS-sized canvas) and resizes itself.
      autoResize: true,
      background: false,
      grid: false,
      panning: { enabled: true, eventTypes: ["leftMouseDown"] },
      mousewheel: { enabled: true, modifiers: ["ctrl", "meta"], minScale: 0.3, maxScale: 2.5, zoomAtMousePosition: true },
      scaling: { min: 0.3, max: 2.5 },
      embedding: false,
      connecting: { allowBlank: false, allowLoop: false, allowNode: false, allowEdge: false, allowPort: false },
      interacting: {
        nodeMovable: true,
        edgeMovable: false,
        edgeLabelMovable: false,
        arrowheadMovable: false,
        vertexMovable: false,
        vertexAddable: false,
        vertexDeletable: false,
        magnetConnectable: false,
      },
      preventDefaultContextMenu: false,
    });
    graph.on("node:click", ({ node }) => this.focusNode(node.id));
    graph.on("edge:click", ({ edge }) => this.focusEdge(edge.id));
    graph.on("node:move", () => {
      this.dragging = true;
    });
    graph.on("node:moved", ({ node }) => {
      this.dragging = false;
      const draftNode = this.edit?.draft.nodes.find(item => item.id === node.id);
      if (draftNode) { const pos = node.getPosition(); draftNode.x = Math.round(pos.x); draftNode.y = Math.round(pos.y); }
      this.scheduleLayoutSave();
    });
    // Fires after X6's own resize (including the first time a hidden panel becomes visible).
    graph.on("resize", () => {
      if (this.pendingFit) this.fit();
    });
    this.graph = graph;
  }

  private fit(): void {
    const g = this.graph;
    if (!g || this.canvas.clientWidth <= 0) return;
    if (g.getNodes().length === 0) return;
    g.zoomToFit({ padding: 28, maxScale: 1, minScale: 0.3 });
    g.centerContent();
    this.pendingFit = false;
  }

  private structureOf(block: ReplyGraphBlock): string {
    return [
      block.nodes.map((n) => n.id).join("\u0001"),
      block.edges.map((e) => `${e.id}\u0002${e.from}\u0002${e.to}`).join("\u0001"),
    ].join("\u0003");
  }

  private nodeAttrs(node: ReplyGraphNode) {
    const focused = node.id === this.focusedNodeId;
    return {
      body: { ...NODE_BASE_ATTRS.body, ...(focused ? NODE_FOCUS_BODY : {}) },
      label: { ...NODE_BASE_ATTRS.label, text: displayTitle(node.title) },
    };
  }

  private edgeAttrs(edge: ReplyGraphBlock["edges"][number]) {
    return { line: { ...EDGE_BASE_LINE, ...(edge.id === this.focusedEdgeId ? EDGE_FOCUS_LINE : {}) } };
  }

  private edgeLabels(label: string) {
    const text = label.trim();
    if (!text) return [];
    return [
      {
        attrs: {
          text: { text, fill: "var(--rb-node-text, #f4f1ea)", fontSize: 12, fontFamily: GRAPH_FONT },
          rect: {
            fill: "var(--rb-node-fill, #0f1117)",
            stroke: "var(--rb-node-stroke, rgba(244, 241, 234, 0.18))",
            strokeWidth: 1,
            rx: 6,
            ry: 6,
            // Pad the default label box (which hugs the text) by 7px / 3px.
            refWidth2: 14,
            refHeight2: 6,
            refX: -7,
            refY: -3,
          },
        },
        position: { distance: 0.5 },
      },
    ];
  }

  private syncGraph(): void {
    const g = this.graph;
    if (!g) return;
    const block = this.shownBlock();
    const key = (this.edit ? "draft:" : "saved:") + this.structureOf(block);
    const layoutPending = this.dragging || this.layoutTimer !== null || this.layoutInFlight || this.layoutQueued;

    if (key !== this.structureKey) {
      const firstRender = !this.structureKey;
      g.clearCells();
      const positions = autoLayout(block);
      const ids = new Set(block.nodes.map((n) => n.id));
      block.nodes.forEach((node) => {
        const pos = positions.get(node.id) ?? { x: 0, y: 0 };
        g.addNode({
          id: node.id,
          shape: "rect",
          x: pos.x,
          y: pos.y,
          width: NODE_W,
          height: NODE_H,
          attrs: this.nodeAttrs(node),
        });
      });
      block.edges.forEach((edge) => {
        if (!ids.has(edge.from) || !ids.has(edge.to)) return;
        g.addEdge({
          id: edge.id,
          source: { cell: edge.from },
          target: { cell: edge.to },
          connector: { name: "smooth" },
          attrs: this.edgeAttrs(edge),
          labels: this.edgeLabels(edge.label),
        });
      });
      this.structureKey = key;
      if (firstRender) { this.pendingFit = true; this.fit(); }
      return;
    }

    block.nodes.forEach((node) => {
      const cell = g.getCellById(node.id);
      if (!cell || !cell.isNode()) return;
      const x6node = cell as X6Node;
      x6node.setAttrs(this.nodeAttrs(node));
      if (!layoutPending && hasCoords(node)) {
        const current = x6node.getPosition();
        if (Math.abs(current.x - node.x) >= 1 || Math.abs(current.y - node.y) >= 1) {
          x6node.setPosition(node.x, node.y);
        }
      }
    });
    block.edges.forEach((edge) => {
      const cell = g.getCellById(edge.id);
      if (!cell || !cell.isEdge()) return;
      const x6edge = cell as X6Edge;
      x6edge.setAttrs(this.edgeAttrs(edge));
      x6edge.setLabels(this.edgeLabels(edge.label));
    });
  }

  refreshSelection(): void {
    super.refreshSelection();
    this.syncFocusFromSelection();
    this.syncGraph();
    this.renderNodeList();
    this.renderDetail();
  }

  private syncFocusFromSelection(): void {
    const selection = this.ctx.selection();
    if (!selection || selection.reply_id !== this.reply.id || selection.block_id !== this.block.id) {
      this.focusedNodeId = null;
      this.focusedEdgeId = null;
      return;
    }
    const target = selection.target, block = this.shownBlock();
    if (target?.kind === "graph_node" && block.nodes.some(node => node.id === target.id)) {
      this.focusedNodeId = target.id;
      this.focusedEdgeId = null;
      return;
    }
    if (target?.kind === "graph_edge" && block.edges.some(edge => edge.id === target.id)) {
      this.focusedNodeId = null;
      this.focusedEdgeId = target.id;
      return;
    }
    this.focusedNodeId = null;
    this.focusedEdgeId = null;
  }

  private focusNode(id: string | null): void {
    const nodeId = id && this.shownBlock().nodes.some(node => node.id === id) ? id : null;
    this.focusedNodeId = nodeId;
    this.focusedEdgeId = null;
    this.ctx.selectBlock(this.reply.id, this.block.id, nodeId ? { kind: "graph_node", id: nodeId } : undefined);
    this.syncGraph();
    this.renderNodeList();
    this.renderDetail();
    if (this.edit && this.edit.draft.nodeId !== nodeId && nodeId) {
      this.edit.draft.nodeId = nodeId;
      this.rebuildEditor();
    }
  }

  private focusEdge(id: string | null): void {
    const edgeId = id && this.shownBlock().edges.some(edge => edge.id === id) ? id : null;
    this.focusedNodeId = null;
    this.focusedEdgeId = edgeId;
    this.ctx.selectBlock(this.reply.id, this.block.id, edgeId ? { kind: "graph_edge", id: edgeId } : undefined);
    this.syncGraph();
    this.renderNodeList();
    this.renderDetail();
  }

  private renderNodeList(): void {
    this.nodeListWrap.replaceChildren();
    const block = this.shownBlock(), nodes = block.nodes;
    if (nodes.length === 0 && block.edges.length === 0) {
      this.nodeListWrap.append(el("p", "rb-mute", translate("graph.empty")));
      return;
    }
    if (nodes.length) {
      this.nodeListWrap.append(el("span", "rb-kicker", translate("graph.nodes")));
      const list = el("ul", "rb-graph-nodes");
      nodes.forEach((node) => {
        const item = el("li");
        const focused = node.id === this.focusedNodeId;
        const b = button("", "", () => this.focusNode(focused ? null : node.id));
        b.setAttribute("aria-pressed", String(focused));
        b.append(el("span", undefined, displayTitle(node.title)));
        if (focused) b.append(el("span", "rb-small rb-block-selected-tag", translate("graph.focused")));
        item.append(b);
        list.append(item);
      });
      this.nodeListWrap.append(list);
    }
    if (block.edges.length) {
      this.nodeListWrap.append(el("span", "rb-kicker", translate("graph.links")));
      const list = el("ul", "rb-graph-nodes");
      const titleOf = (id: string) => displayTitle(block.nodes.find(node => node.id === id)?.title ?? id);
      block.edges.forEach((edge) => {
        const item = el("li");
        item.dataset.targetId = edge.id;
        item.dataset.targetKind = "graph_edge";
        const focused = edge.id === this.focusedEdgeId;
        const label = edge.label.trim();
        const text = label ? translate("graph.linkLabel", { from: titleOf(edge.from), to: titleOf(edge.to), label }) : translate("graph.linkTo", { from: titleOf(edge.from), to: titleOf(edge.to) });
        const b = button("", "", () => this.focusEdge(focused ? null : edge.id));
        b.setAttribute("aria-pressed", String(focused));
        b.setAttribute("aria-label", text);
        b.append(el("span", undefined, text));
        if (focused) b.append(el("span", "rb-small rb-block-selected-tag", translate("graph.focused")));
        item.append(b);
        list.append(item);
      });
      this.nodeListWrap.append(list);
    }
  }

  private renderDetail(): void {
    this.detailWrap.replaceChildren();
    const block = this.shownBlock();
    const edge = block.edges.find((item) => item.id === this.focusedEdgeId) ?? null;
    if (edge) {
      const titleOf = (id: string) => displayTitle(block.nodes.find((node) => node.id === id)?.title ?? id);
      const endpoints = translate("graph.linkTo", { from: titleOf(edge.from), to: titleOf(edge.to) });
      this.detailWrap.append(el("span", "rb-kicker", translate("graph.edgeDetail")), el("h4", undefined, edge.label.trim() || endpoints));
      if (edge.label.trim()) this.detailWrap.append(el("p", "rb-mute", endpoints));
      return;
    }
    const node = block.nodes.find((n) => n.id === this.focusedNodeId) ?? null;
    this.detailWrap.append(el("span", "rb-kicker", translate("graph.detail")));
    if (!node) {
      this.detailWrap.append(el("p", "rb-mute", translate(block.nodes.length ? "graph.pick" : "graph.empty")));
      return;
    }
    this.detailWrap.append(el("h4", undefined, displayTitle(node.title)));
    const detail = (node.detail ?? "").trim();
    if (detail) {
      const parts = paragraphs(detail);
      this.detailWrap.append(...(parts.length ? parts : [el("p", undefined, detail)]));
    } else {
      this.detailWrap.append(el("p", "rb-mute", translate("graph.noDetail")));
    }
    const titleOf = (id: string) => displayTitle(block.nodes.find((n) => n.id === id)?.title ?? id);
    const related = block.edges.filter((e) => e.from === node.id || e.to === node.id);
    if (related.length) {
      const links = el("ul", "rb-graph-links");
      links.setAttribute("aria-label", translate("graph.links"));
      related.forEach((e) => {
        const li = el("li");
        const from = el("em", undefined, titleOf(e.from));
        const to = el("em", undefined, titleOf(e.to));
        const label = e.label.trim();
        li.append(from, document.createTextNode(label ? ` → ${label} → ` : " → "), to);
        links.append(li);
      });
      this.detailWrap.append(links);
    }
  }

  private renderStatus(): void {
    const s = this.statusEl;
    s.replaceChildren();
    s.classList.remove("is-error", "is-ok");
    if (this.layoutState === "idle") {
      s.hidden = true;
      return;
    }
    s.hidden = false;
    if (this.layoutState === "saving") {
      s.append(el("span", undefined, translate("graph.layoutSaving")));
    } else if (this.layoutState === "saved") {
      s.classList.add("is-ok");
      s.append(el("span", undefined, translate("graph.layoutSaved")));
    } else {
      s.classList.add("is-error");
      s.append(el("span", undefined, translate("graph.layoutFailed")));
      s.append(button(translate("action.retry"), "", () => void this.saveLayout()));
    }
  }

  private currentNodes(): ReplyGraphNode[] {
    const g = this.graph;
    return (this.edit?.draft.nodes ?? this.block.nodes).map((node) => {
      const cell = g?.getCellById(node.id);
      if (cell && cell.isNode()) {
        const pos = (cell as X6Node).getPosition();
        return { ...node, x: Math.round(pos.x), y: Math.round(pos.y) };
      }
      return { ...node };
    });
  }

  /** Let the "saved" pill fade after a moment; errors stay until retried. */
  private scheduleStatusClear(): void {
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = null;
      if (this.layoutState === "saved") {
        this.layoutState = "idle";
        this.renderStatus();
      }
    }, 2500);
  }

  private scheduleLayoutSave(): void {
    if (this.edit) { this.persistDrafts(); return; }
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => {
      this.layoutTimer = null;
      void this.saveLayout();
    }, 350);
  }

  private async saveLayout(): Promise<void> {
    if (this.destroyed) return;
    if (this.edit) { this.persistDrafts(); return; }
    if (this.layoutInFlight) {
      this.layoutQueued = true;
      return;
    }
    this.layoutInFlight = true;
    this.layoutState = "saving";
    this.renderStatus();
    const request: ReplyPatchRequest = {
      object_id: this.reply.object_id, reply_id: this.reply.id,
      expected_revision: this.reply.revision,
      block: { ...this.block, nodes: this.currentNodes() },
      layout_only: true,
    };
    try {
      const updated = await this.ctx.handlers.onPatch(request);
      if (this.destroyed) return;
      this.layoutInFlight = false;
      this.layoutState = "saved";
      // An open node editor already reads live positions, so it may follow this revision.
      const activeEdit = this.edit as EditSession<GraphDraft> | null;
      if (activeEdit && activeEdit.expectedRevision === request.expected_revision) {
        activeEdit.expectedRevision = updated.revision;
      }
      this.ctx.mergeReply(updated);
      this.scheduleStatusClear();
    } catch (err) {
      if (this.destroyed) return;
      this.layoutInFlight = false;
      this.layoutState = "error";
      const { detail } = friendlyError(err, translate("graph.layoutFailed"));
      this.ctx.reportError(detail);
    }
    this.renderStatus();
    if (this.layoutQueued) {
      this.layoutQueued = false;
      void this.saveLayout();
    }
  }

  protected createDraft(block = this.block): GraphDraft {
    const nodes = block === this.block ? this.currentNodes() : block.nodes.map((n) => ({ ...n }));
    const nodeId = this.focusedNodeId ?? nodes[0]?.id ?? null;
    return { title: block.title ?? "", nodeId, nodes, edges: block.edges.map(e => ({ ...e })) };
  }

  protected rebuildEditor(): void { super.rebuildEditor(); if (this.graph) this.renderView(); }

  protected renderEditor(form: HTMLElement, draft: GraphDraft): void {
    form.append(this.labeled(translate("edit.titleOptional"), textInput(draft.title, (v) => (draft.title = v))));
    form.append(button(ct("graphAddNode"), "", () => {
      const node = { id: newId("node"), title: ct("graphNewNode") };
      draft.nodes.push(node); draft.nodeId = node.id; this.rebuildEditor();
    }));
    if (draft.nodes.length === 0) {
      form.append(el("p", "rb-small", translate("edit.noNodes")));
      return;
    }
    if (!draft.nodes.some((n) => n.id === draft.nodeId)) draft.nodeId = draft.nodes[0].id;
    const select = el("select");
    draft.nodes.forEach((n) => {
      const opt = el("option", undefined, displayTitle(n.title));
      opt.value = n.id;
      opt.selected = n.id === draft.nodeId;
      select.append(opt);
    });
    select.addEventListener("change", () => {
      draft.nodeId = select.value;
      this.focusNode(select.value);
      this.rebuildEditor();
    });
    form.append(this.labeled(translate("edit.node"), select));
    const node = draft.nodes.find((n) => n.id === draft.nodeId)!;
    form.append(this.labeled(translate("edit.nodeTitle"), textInput(node.title, (v) => { node.title = v; this.syncGraph(); this.renderNodeList(); this.renderDetail(); })));
    form.append(this.labeled(translate("edit.nodeDetail"), textArea(node.detail ?? "", (v) => { node.detail = v; this.renderDetail(); }, 4)));
    form.append(button(ct("graphDeleteNode"), "rb-quiet", () => {
      draft.nodes = draft.nodes.filter(n => n.id !== node.id);
      draft.edges = draft.edges.filter(edge => edge.from !== node.id && edge.to !== node.id);
      draft.nodeId = draft.nodes[0]?.id ?? null;
      this.rebuildEditor();
    }));
    const relations = el("fieldset", "rb-fieldset");
    relations.append(el("legend", undefined, ct("graphConnections")));
    for (const edge of draft.edges) {
      const row = el("div", "rb-relation-edit");
      const endpoint = (side: "from" | "to") => {
        const choice = el("select");
        for (const node of draft.nodes) {
          const option = el("option", undefined, displayTitle(node.title)); option.value = node.id; option.selected = edge[side] === node.id; choice.append(option);
        }
        choice.addEventListener("change", () => { edge[side] = choice.value; this.persistDrafts(); this.renderView(); });
        return this.labeled(ct(side === "from" ? "graphFrom" : "graphTo"), choice);
      };
      const label = textInput(edge.label, value => { edge.label = value; this.syncGraph(); });
      label.placeholder = ct("graphLabelHint");
      row.append(endpoint("from"), endpoint("to"), this.labeled(ct("graphLabel"), label), button(ct("graphRemoveEdge"), "rb-quiet", () => { draft.edges = draft.edges.filter(e => e.id !== edge.id); this.rebuildEditor(); }));
      relations.append(row);
    }
    const addEdge = button(ct("graphAddEdge"), "", () => {
      if (draft.nodes.length < 2) return;
      draft.edges.push({ id: newId("edge"), from: draft.nodes[0].id, to: draft.nodes[1].id, label: "" });
      this.rebuildEditor();
    });
    addEdge.disabled = draft.nodes.length < 2;
    relations.append(addEdge); form.append(relations);
  }

  protected draftToBlock(draft: GraphDraft): ReplyGraphBlock {
    const title = draft.title.trim();
    const nodes = draft.nodes.map((n) => {
      const detail = (n.detail ?? "").trim();
      return {
        id: n.id,
        title: n.title.trim(),
        ...(detail ? { detail } : {}),
        x: n.x ?? null,
        y: n.y ?? null,
      };
    });
    return { id: this.block.id, type: "graph", ...(title ? { title } : {}), nodes, edges: draft.edges.map((e) => ({ ...e, label: e.label.trim() })) };
  }

  destroy(): void {
    super.destroy();
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.graph?.dispose();
    this.graph = null;
  }
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

type AnyBlockView = TextView | ComparisonView | SequenceView | GraphView | ArtifactView;

type ReplyPanel = {
  el: HTMLElement;
  head: HTMLElement;
  blocks: HTMLElement;
  views: Map<string, AnyBlockView>;
};

class ReplyBoard {
  private readonly root: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly navLabel: HTMLElement;
  private readonly navCount: HTMLElement;
  private readonly doc: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly panels = new Map<string, ReplyPanel>();
  private readonly ctx: BoardContext;
  private readonly unsubscribeLocale: () => void;

  private replies: BoardReply[] = [];
  private activeId: string | null = null;
  private selection: ReplySelection | null = null;
  private readonly lastBlockByReply = new Map<string, string>();
  private readonly seenUpdatedAt = new Map<string, number>();
  private readonly badges = new Map<string, "new" | "updated">();
  private hasLoaded = false;
  private uidCounter = 0;
  private destroyed = false;

  constructor(host: HTMLElement, private readonly handlers: ReplyBoardHandlers) {
    this.root = el("div", "rb-root");
    this.root.lang = currentLocale();
    this.nav = el("nav", "rb-nav");
    this.navLabel = el("span", "rb-nav-label");
    this.tabs = el("div", "rb-tabs");
    this.tabs.setAttribute("role", "tablist");
    this.tabs.addEventListener("keydown", (event) => this.onTabKey(event));
    this.navCount = el("span", "rb-nav-count");
    this.nav.append(this.navLabel, this.tabs, this.navCount);
    this.doc = el("div", "rb-doc");
    this.empty = el("p", "rb-empty");
    this.doc.append(this.empty);
    this.root.append(this.nav, this.doc);
    host.append(this.root);

    const uidPrefix = `rb${Math.random().toString(36).slice(2, 7)}`;
    this.ctx = {
      handlers,
      uid: () => `${uidPrefix}-${(this.uidCounter += 1)}`,
      mergeReply: (reply) => this.mergeReply(reply),
      selectBlock: (replyId, blockId, target, region) => this.selectBlock(replyId, blockId, target, region),
      selection: () => this.getSelection(),
      isBlockSelected: (replyId, blockId) =>
        this.selection !== null && this.selection.reply_id === replyId && this.selection.block_id === blockId,
      reportError: (message) => this.handlers.onError?.(message),
    };

    this.unsubscribeLocale = onLocale(() => {
      if (this.destroyed) return;
      this.root.lang = currentLocale();
      this.renderNav();
      this.panels.forEach((panel, id) => {
        const reply = this.replies.find((r) => r.id === id);
        if (reply) this.renderPanelHead(panel, reply);
        panel.views.forEach((view) => view.relabel());
      });
      this.renderEmpty();
    });
    this.renderNav();
    this.renderEmpty();
  }

  /* ---------------- public ---------------- */

  update(replies: BoardReply[]): void {
    if (this.destroyed) return;
    // A callback response may already have given us a newer revision than a
    // list fetched slightly earlier; keep the newer one so the UI does not flip back.
    const ordered = replies
      .map((incoming) => {
        const held = this.replies.find((r) => r.id === incoming.id);
        const current = held && held.revision > incoming.revision && held.updated_at_ms >= incoming.updated_at_ms
          ? held
          : incoming;
        return { ...current, object_id: incoming.object_id ?? held?.object_id };
      })
      .sort((a, b) => a.created_at_ms - b.created_at_ms);
    const incomingIds = new Set(ordered.map((r) => r.id));

    ordered.forEach((reply) => {
      const seen = this.seenUpdatedAt.get(reply.id);
      if (reply.id === this.activeId) {
        this.seenUpdatedAt.set(reply.id, reply.updated_at_ms);
        this.badges.delete(reply.id);
      } else if (seen === undefined) {
        if (this.hasLoaded) this.badges.set(reply.id, "new");
        this.seenUpdatedAt.set(reply.id, this.hasLoaded ? -1 : reply.updated_at_ms);
      } else if (seen >= 0 && reply.updated_at_ms > seen && !this.badges.has(reply.id)) {
        this.badges.set(reply.id, "updated");
      }
    });
    [...this.seenUpdatedAt.keys()].forEach((id) => {
      if (!incomingIds.has(id)) {
        this.seenUpdatedAt.delete(id);
        this.badges.delete(id);
        this.lastBlockByReply.delete(id);
      }
    });

    this.replies = ordered;
    this.hasLoaded = true;

    // Keep the reply the user is reading; only pick automatically when nothing is active.
    if (this.activeId === null || !incomingIds.has(this.activeId)) {
      const next = ordered.length ? ordered[ordered.length - 1].id : null;
      this.setActive(next, false);
    }
    if (this.selection) {
      const owner = ordered.find((r) => r.id === this.selection!.reply_id);
      if (!owner || !owner.blocks.some((b) => b.id === this.selection!.block_id)) this.setSelection(null);
      else if (this.selection.target) {
        const block = owner.blocks.find(b => b.id === this.selection!.block_id)!;
        if (!targetExists(block, this.selection.target)) this.setSelection({ reply_id: owner.id, block_id: block.id });
        else if (this.selection.region && targetImage(block, this.selection.target)?.src !== this.selection.region.resource) this.setSelection({ ...this.selection, region: undefined });
      }
    }

    // Remove panels of vanished replies.
    [...this.panels.keys()].forEach((id) => {
      if (!incomingIds.has(id)) {
        const panel = this.panels.get(id)!;
        panel.views.forEach((v) => v.destroy());
        panel.el.remove();
        this.panels.delete(id);
      }
    });

    ordered.forEach((reply) => this.renderPanel(reply));
    this.renderNav();
    this.renderEmpty();
    this.refreshPanelVisibility();
  }

  select(replyId: string): void {
    if (this.destroyed) return;
    if (!this.replies.some((r) => r.id === replyId)) return;
    this.setActive(replyId, true);
    this.renderNav();
    this.refreshPanelVisibility();
  }

  getSelection(): ReplySelection | null {
    return this.selection ? { ...this.selection, object_id: this.replies.find(reply => reply.id === this.selection!.reply_id)?.object_id } : null;
  }

  getArtifactAnchor(): CanvasAnchor["artifact"] | undefined {
    const panel = this.activeId ? this.panels.get(this.activeId) : undefined;
    const view = this.selection ? panel?.views.get(this.selection.block_id) : [...(panel?.views.values() ?? [])].find(view => view instanceof ArtifactView);
    return view instanceof ArtifactView ? view.canvasAnchor() : undefined;
  }

  async prepareFeedback() {
    const panel = this.activeId ? this.panels.get(this.activeId) : undefined;
    await Promise.all([...(panel?.views.values() ?? [])].filter((view): view is ArtifactView => view instanceof ArtifactView).map(view => view.prepareFeedback()));
  }

  restoreDraft(record: DraftRecord): boolean {
    const reply = this.replies.find(r => (record.object_id ? r.object_id === record.object_id : r.id === record.reply_id) && r.source_id === record.source_id);
    if (!reply) return false;
    this.select(reply.id);
    return this.panels.get(reply.id)?.views.get(record.block_id)?.restoreDraft(record) ?? false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeLocale();
    this.panels.forEach((panel) => {
      panel.views.forEach((v) => v.destroy());
      panel.el.remove();
    });
    this.panels.clear();
    this.root.remove();
  }

  /* ---------------- state ---------------- */

  private setActive(replyId: string | null, restoreSelection: boolean): void {
    this.activeId = replyId;
    if (replyId) {
      this.badges.delete(replyId);
      const reply = this.replies.find((r) => r.id === replyId);
      if (reply) this.seenUpdatedAt.set(replyId, reply.updated_at_ms);
    }
    if (!restoreSelection) {
      const first = this.replies.find((r) => r.id === replyId)?.blocks[0];
      this.setSelection(replyId && first ? { reply_id: replyId, block_id: first.id } : null);
      return;
    }
    const remembered = replyId ? this.lastBlockByReply.get(replyId) : undefined;
    const reply = this.replies.find((r) => r.id === replyId);
    if (replyId && remembered && reply?.blocks.some((b) => b.id === remembered)) {
      this.setSelection({ reply_id: replyId, block_id: remembered });
    } else {
      const first = reply?.blocks[0];
      this.setSelection(replyId && first ? { reply_id: replyId, block_id: first.id } : null);
    }
  }

  private setSelection(next: ReplySelection | null): void {
    const prev = this.selection;
    const same =
      (prev === null && next === null) ||
      (prev !== null && next !== null && contentKey(prev) === contentKey(next));
    this.selection = next ? { ...next } : null;
    if (next) this.lastBlockByReply.set(next.reply_id, next.block_id);
    this.panels.forEach((panel) => panel.views.forEach((v) => v.refreshSelection()));
    if (!same) this.handlers.onSelect?.(this.getSelection());
  }

  selectBlock(replyId: string, blockId: string, target?: ReplyTarget, region?: CanvasAnchor["region"]): void {
    if (!this.replies.some(reply => reply.id === replyId && reply.blocks.some(block => block.id === blockId))) return;
    if (replyId !== this.activeId) {
      this.activeId = replyId;
      this.badges.delete(replyId);
      this.renderNav();
      this.refreshPanelVisibility();
    }
    this.setSelection({ reply_id: replyId, block_id: blockId, ...(target ? { target } : {}), ...(region ? { region } : {}) });
  }

  private mergeReply(reply: BoardReply): void {
    if (this.destroyed) return;
    const index = this.replies.findIndex((r) => r.id === reply.id);
    const previous = this.replies[index];
    if (previous && previous.revision > reply.revision) return;
    if (previous) reply = { ...reply, object_id: reply.object_id ?? previous.object_id, blocks: reply.blocks.map(block => {
      const old = previous.blocks.find(b => b.id === block.id);
      return block.type === "artifact" && old?.type === "artifact" && old.state_revision > block.state_revision
        ? { ...block, state: old.state, state_revision: old.state_revision } : block;
    }) };
    const next = [...this.replies];
    if (index >= 0) next[index] = reply;
    else next.push(reply);
    this.update(next);
  }

  /* ---------------- rendering ---------------- */

  private renderEmpty(): void {
    this.empty.textContent = translate("nav.empty");
    this.empty.hidden = this.replies.length > 0;
  }

  private renderNav(): void {
    this.navLabel.textContent = translate("nav.label");
    this.navCount.textContent = currentLocale() === "en" && this.replies.length === 1
      ? "1 reply" : translate("nav.count", { n: this.replies.length });
    this.nav.hidden = this.replies.length === 0;
    const hadFocus = this.tabs.contains(document.activeElement);
    this.tabs.replaceChildren();
    this.replies.forEach((reply) => {
      const active = reply.id === this.activeId;
      const tab = button("", "", () => this.select(reply.id));
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.dataset.replyId = reply.id;
      const panelId = this.panels.get(reply.id)?.el.id;
      if (panelId) tab.setAttribute("aria-controls", panelId);
      tab.append(el("span", "rb-tab-title", displayTitle(reply.title)));
      if (reply.source_label.trim()) tab.append(el("span", "rb-tab-source", reply.source_label));
      const badge = this.badges.get(reply.id);
      if (badge && !active) tab.append(el("span", "rb-tab-badge", translate(badge === "new" ? "nav.new" : "nav.updated")));
      this.tabs.append(tab);
    });
    if (hadFocus) this.tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }

  private onTabKey(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const ids = this.replies.map((r) => r.id);
    if (ids.length === 0) return;
    const current = Math.max(0, ids.indexOf(this.activeId ?? ""));
    let next = current;
    if (event.key === "ArrowLeft") next = (current - 1 + ids.length) % ids.length;
    if (event.key === "ArrowRight") next = (current + 1) % ids.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = ids.length - 1;
    event.preventDefault();
    this.select(ids[next]);
  }

  private renderPanel(reply: BoardReply): void {
    let panel = this.panels.get(reply.id);
    if (!panel) {
      const wrap = el("article", "rb-panel");
      wrap.setAttribute("role", "tabpanel");
      wrap.id = this.ctx.uid();
      wrap.hidden = reply.id !== this.activeId;
      const head = el("header", "rb-reply-head");
      const blocks = el("div", "rb-blocks");
      wrap.append(head, blocks);
      this.doc.append(wrap);
      panel = { el: wrap, head, blocks, views: new Map() };
      this.panels.set(reply.id, panel);
    }
    this.renderPanelHead(panel, reply);

    const seen = new Set<string>();
    reply.blocks.forEach((block, index) => {
      seen.add(block.id);
      let view = panel!.views.get(block.id);
      if (view && view.block.type !== block.type) {
        view.destroy();
        view = undefined;
        panel!.views.delete(block.id);
      }
      if (!view) {
        view = this.createView(block);
        panel!.views.set(block.id, view);
      }
      view.render(reply, block);
      const at = panel!.blocks.children[index] ?? null;
      if (at !== view.root) panel!.blocks.insertBefore(view.root, at);
    });
    [...panel.views.keys()].forEach((id) => {
      if (!seen.has(id)) {
        panel!.views.get(id)!.destroy();
        panel!.views.delete(id);
      }
    });
  }

  private renderPanelHead(panel: ReplyPanel, reply: BoardReply): void {
    panel.head.replaceChildren();
    const title = el("h2", "rb-reply-title", displayTitle(reply.title));
    const meta = el("div", "rb-reply-meta");
    if (reply.source_label.trim()) meta.append(el("span", undefined, translate("reply.from", { source: reply.source_label })));
    meta.append(el("span", undefined, translate("reply.updated", { time: formatTime(reply.updated_at_ms) })));
    panel.head.append(title, meta);
    panel.el.setAttribute("aria-label", displayTitle(reply.title));
  }

  private createView(block: ReplyBlock): AnyBlockView {
    switch (block.type) {
      case "text":
        return new TextView(this.ctx);
      case "comparison":
        return new ComparisonView(this.ctx);
      case "graph":
        return new GraphView(this.ctx);
      case "sequence":
        return new SequenceView(this.ctx);
      case "artifact":
        return new ArtifactView(this.ctx);
    }
  }

  private refreshPanelVisibility(): void {
    this.panels.forEach((panel, id) => {
      panel.el.hidden = id !== this.activeId;
    });
  }
}
