/**
 * Board replies: renders structured Agent replies (text / comparison / graph /
 * sequence) on the board and routes every user intent back through callbacks.
 *
 * Pure input + callbacks. No fetch, no model calls, no timers pretending to be
 * an Agent. All content is inserted as text (textContent / SVG text), never as
 * HTML.
 */
import { Graph } from "@antv/x6";
import type { Edge as X6Edge, Node as X6Node } from "@antv/x6";
import { currentLocale, onLocale, type Locale } from "./i18n";
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
} from "./reply-types";
import "./replies.css";

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export type ReplySelection = { reply_id: string; block_id: string };

export type ReplyBoardHandlers = {
  onAction(request: ReplyActionInput): Promise<BoardReply>;
  onPatch(request: ReplyPatchRequest): Promise<BoardReply>;
  onSelect?(selection: ReplySelection | null): void;
  onError?(message: string): void;
};

export type ReplyBoardHandle = {
  update(replies: BoardReply[]): void;
  select(replyId: string): void;
  getSelection(): ReplySelection | null;
  destroy(): void;
};

export function mountReplyBoard(host: HTMLElement, handlers: ReplyBoardHandlers): ReplyBoardHandle {
  const board = new ReplyBoard(host, handlers);
  return {
    update: (replies) => board.update(replies),
    select: (replyId) => board.select(replyId),
    getSelection: () => board.getSelection(),
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
    "block.selected": "当前关注",
    "block.focus": "关注这一块",
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
    "ask.done": "已保存，等待原任务接手。",
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
    "block.selected": "In focus",
    "block.focus": "Focus this block",
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
    "ask.done": "Saved, waiting for the originating task.",
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
  ja: {
    "nav.label": "ボード上の返信",
    "nav.empty": "まだ返信はありません。採用したアイデアを選び、Agent に展開を依頼できます。",
    "nav.count": "{n} 件の返信",
    "nav.new": "新着",
    "nav.updated": "更新",
    "reply.from": "{source} から",
    "reply.updated": "{time} に更新",
    untitled: "無題",
    "kind.text": "テキスト",
    "kind.comparison": "案の比較",
    "kind.graph": "関係図",
    "kind.sequence": "シーケンス",
    "block.selected": "注目中",
    "block.focus": "このブロックに注目",
    "action.ask": "質問",
    "action.edit": "編集",
    "action.save": "保存",
    "action.saving": "保存中…",
    "action.cancel": "キャンセル",
    "action.send": "送信",
    "action.sending": "送信中…",
    "action.retry": "再試行",
    "action.discard": "下書きを破棄して最新を読み込む",
    "action.add": "追加",
    "action.remove": "削除",
    "action.up": "上へ",
    "action.down": "下へ",
    "action.clear": "解除",
    "ask.label": "このブロックについて質問する",
    "ask.placeholder": "確認したいこと、疑問、補足を書いてください",
    "ask.context": "{label} について",
    "ask.done": "保存しました。元のタスクでの処理を待っています。",
    "ask.failed": "送信できませんでした。入力内容はそのまま残っています。",
    "edit.stale": "編集中にこの返信が更新されました。保存できない場合があります。下書きを破棄して最新を読み込むこともできます。",
    "edit.failed": "保存できませんでした。変更内容はそのまま残っています。",
    "edit.conflict": "別の更新によって内容が変わったため、保存されませんでした。下書きを破棄して最新を読み込み、もう一度編集してください。",
    "edit.title": "タイトル",
    "edit.titleOptional": "タイトル（任意）",
    "edit.text": "本文",
    "edit.criteria": "比較の観点",
    "edit.criterion": "観点 {n}",
    "edit.addCriterion": "観点を追加",
    "edit.options": "案",
    "edit.option": "案 {n}",
    "edit.addOption": "案を追加",
    "edit.optionTitle": "案の名前",
    "edit.optionSummary": "一行の要約",
    "edit.steps": "ステップ",
    "edit.step": "ステップ {n}",
    "edit.addStep": "ステップを追加",
    "edit.stepTitle": "タイトル",
    "edit.stepAction": "アクション",
    "edit.stepFeedback": "フィードバック",
    "edit.stepNote": "メモ",
    "edit.node": "編集するノード",
    "edit.nodeTitle": "ノードのタイトル",
    "edit.nodeDetail": "ノードの説明",
    "edit.noNodes": "この図にはまだノードがありません。タイトルのみ編集できます。",
    "cmp.choose": "この案を選ぶ",
    "cmp.chosen": "選択中",
    "cmp.choosing": "選択中…",
    "cmp.current": "現在の選択：",
    "cmp.none": "まだ選択されていません",
    "cmp.failed": "選択できませんでした。もう一度お試しください。",
    "cmp.noValue": "—",
    "cmp.extra": "その他",
    "cmp.empty": "この比較にはまだ案がありません。",
    "seq.step": "ステップ {n}",
    "seq.action": "アクション",
    "seq.feedback": "フィードバック",
    "seq.note": "メモ",
    "seq.focus": "このステップに注目",
    "seq.focused": "注目中",
    "seq.askStep": "このステップについて質問",
    "seq.stepContext": "ステップ {n}「{title}」",
    "seq.empty": "このシーケンスにはまだステップがありません。",
    "graph.hint": "ノードをドラッグして配置、空白をドラッグして移動、Ctrl + ホイールで拡大縮小。",
    "graph.zoomIn": "拡大",
    "graph.zoomOut": "縮小",
    "graph.fit": "全体を表示",
    "graph.canvas": "関係図のキャンバス",
    "graph.nodes": "ノード",
    "graph.detail": "ノードの説明",
    "graph.pick": "ノードをクリックすると説明が表示されます。",
    "graph.noDetail": "このノードにはまだ説明がありません。",
    "graph.links": "関連する接続",
    "graph.linkTo": "{from} → {to}",
    "graph.linkLabel": "{from} → {to}（{label}）",
    "graph.focused": "選択中",
    "graph.empty": "この図にはまだノードがありません。",
    "graph.layoutSaving": "配置を保存中…",
    "graph.layoutSaved": "配置を保存しました",
    "graph.layoutFailed": "配置を保存できませんでした",
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
  selectBlock(replyId: string, blockId: string): void;
  isBlockSelected(replyId: string, blockId: string): boolean;
  reportError(message: string): void;
}

type EditSession<D> = {
  expectedRevision: number;
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
  text: string;
  busy: boolean;
  error: string | null;
  done: boolean;
  context: { label: string; prefix: string } | null;
  frame: HTMLElement | null;
  input: HTMLTextAreaElement | null;
  sendBtn: HTMLButtonElement | null;
  cancelBtn: HTMLButtonElement | null;
  errorEl: HTMLElement | null;
  statusEl: HTMLElement | null;
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
    this.focusBtn = button("", "rb-quiet", () => this.ctx.selectBlock(this.reply.id, this.block.id));
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
  }

  /** Re-render with fresh data. Never touches an open editor's inputs or ask draft. */
  render(reply: BoardReply, block: ReplyBlock): void {
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
    this.selectedTag.textContent = on ? translate("block.selected") : "";
    if (on && !this.selectedTag.isConnected) this.kindEl.append(this.selectedTag);
    if (!on && this.selectedTag.isConnected) this.selectedTag.remove();
  }

  destroy(): void {
    this.root.remove();
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
  protected abstract createDraft(): D;
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

  protected openAsk(context: { label: string; prefix: string } | null): void {
    if (!this.ask) {
      this.ask = {
        text: "",
        busy: false,
        error: null,
        done: false,
        context,
        frame: null,
        input: null,
        sendBtn: null,
        cancelBtn: null,
        errorEl: null,
        statusEl: null,
        chipHost: null,
      };
      this.buildAskFrame();
    } else {
      this.ask.context = context;
      this.ask.done = false;
      this.renderAskChip();
      this.updateAskFrame();
    }
    this.askBtn.setAttribute("aria-expanded", "true");
    this.ask.input?.focus();
  }

  protected closeAsk(): void {
    if (this.ask?.busy) return;
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
      ask.done = false;
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
    const cancelBtn = button(translate("action.cancel"), "rb-quiet", () => this.closeAsk());
    const statusEl = el("span", "rb-status");
    statusEl.setAttribute("aria-live", "polite");
    actions.append(sendBtn, cancelBtn, statusEl);

    const errorEl = el("p", "rb-error");
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;

    frame.append(field, actions, errorEl);
    Object.assign(ask, { frame, input, sendBtn, cancelBtn, errorEl, statusEl, chipHost });
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
          this.ask.context = null;
          this.renderAskChip();
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
    if (ask.statusEl) {
      ask.statusEl.textContent = ask.done ? translate("ask.done") : "";
      ask.statusEl.classList.toggle("is-ok", ask.done);
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
    ask.error = null;
    ask.done = false;
    this.updateAskFrame();
    const request: ReplyActionInput = {
      reply_id: this.reply.id,
      block_id: this.block.id,
      action: "ask",
      text: ask.context ? `${ask.context.prefix}${trimmed}` : trimmed,
    };
    try {
      const updated = await this.ctx.handlers.onAction(request);
      if (this.ask !== ask) return;
      ask.busy = false;
      ask.text = "";
      ask.context = null;
      ask.done = true;
      if (ask.input) ask.input.value = "";
      this.renderAskChip();
      this.updateAskFrame();
      this.ctx.mergeReply(updated);
    } catch (err) {
      if (this.ask !== ask) return;
      ask.busy = false;
      const { user, detail } = friendlyError(err, translate("ask.failed"));
      ask.error = user;
      this.updateAskFrame();
      this.ctx.reportError(detail);
    }
  }

  /* ---------------- edit ---------------- */

  protected beginEdit(): void {
    if (this.edit) {
      this.cancelEdit();
      return;
    }
    this.edit = {
      expectedRevision: this.reply.revision,
      draft: this.createDraft(),
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

  protected cancelEdit(): void {
    if (this.edit?.busy) return;
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
    edit.error = null;
    this.updateEditFrame();
    const request: ReplyPatchRequest = {
      reply_id: this.reply.id,
      expected_revision: edit.expectedRevision,
      block: this.draftToBlock(edit.draft),
      layout_only: false,
    };
    try {
      const updated = await this.ctx.handlers.onPatch(request);
      if (this.edit !== edit) return;
      this.edit = null;
      this.editArea.hidden = true;
      this.editArea.replaceChildren();
      this.body.hidden = false;
      this.editBtn.setAttribute("aria-expanded", "false");
      this.ctx.mergeReply(updated);
      this.editBtn.focus();
    } catch (err) {
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

class TextView extends BlockView<ReplyTextBlock, TextDraft> {
  constructor(ctx: BoardContext) {
    super(ctx, "kind.text");
  }

  protected renderView(): void {
    const wrap = el("div", "rb-text");
    const parts = paragraphs(this.block.text);
    if (parts.length === 0 && this.block.text.length > 0) parts.push(el("p", undefined, this.block.text));
    wrap.append(...parts);
    this.body.replaceChildren(wrap);
  }

  protected createDraft(): TextDraft {
    return { title: this.block.title ?? "", text: this.block.text };
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
        const isChosen = option.id === block.selected_id;
        card.classList.toggle("is-selected", isChosen);

        const head = el("div", "rb-cmp-card-head");
        head.append(el("span", "rb-small", translate("edit.option", { n: index + 1 })));
        if (isChosen) head.append(el("span", "rb-small rb-block-selected-tag", translate("cmp.chosen")));
        card.append(head);
        card.append(el("h4", undefined, displayTitle(option.title)));
        if (option.summary.trim()) card.append(el("p", "rb-cmp-summary", option.summary));

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
  }

  private async pick(optionId: string): Promise<void> {
    if (this.pickingId) return;
    this.pickingId = optionId;
    this.pickError = null;
    this.renderView();
    const request: ReplyActionInput = {
      reply_id: this.reply.id,
      block_id: this.block.id,
      action: "select",
      option_id: optionId,
    };
    try {
      const updated = await this.ctx.handlers.onAction(request);
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

  protected createDraft(): ComparisonDraft {
    return {
      title: this.block.title ?? "",
      criteria: [...this.block.criteria],
      options: this.block.options.map((o) => ({ ...o, values: [...o.values] })),
      selected_id: this.block.selected_id ?? null,
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
      const focused = step.id === this.focusedStepId;
      item.classList.toggle("is-focused", focused);

      const toggle = button("", "rb-seq-toggle", () => {
        this.focusedStepId = focused ? null : step.id;
        this.ctx.selectBlock(this.reply.id, this.block.id);
        this.renderView();
      });
      toggle.setAttribute("aria-pressed", String(focused));
      const head = el("div", "rb-seq-head");
      head.append(el("span", "rb-seq-index", translate("seq.step", { n })));
      if (focused) head.append(el("span", "rb-small rb-block-selected-tag", translate("seq.focused")));
      toggle.append(head, el("span", "rb-seq-title", displayTitle(step.title)));
      item.append(toggle);

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
          this.ctx.selectBlock(this.reply.id, this.block.id);
          this.renderView();
          const label = translate("seq.stepContext", { n, title: displayTitle(step.title) });
          this.openAsk({ label, prefix: `[${label}] ` });
        }),
      );
      item.append(foot);
      list.append(item);
    });
    this.body.replaceChildren(list);
  }

  protected createDraft(): SequenceDraft {
    return { title: this.block.title ?? "", steps: this.block.steps.map((s) => ({ ...s })) };
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
  body: { fill: "#14161d", stroke: "rgba(244, 241, 234, 0.24)", strokeWidth: 1, rx: 12, ry: 12 },
  label: {
    fill: "#f4f1ea",
    fontSize: 13,
    fontFamily: GRAPH_FONT,
    textWrap: { width: -24, height: -16, ellipsis: true },
  },
};

const NODE_FOCUS_BODY = { fill: "rgba(212, 179, 255, 0.14)", stroke: "#d4b3ff", strokeWidth: 2 };

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

type GraphDraft = { title: string; nodeId: string | null; nodes: ReplyGraphNode[] };

class GraphView extends BlockView<ReplyGraphBlock, GraphDraft> {
  private graph: Graph | null = null;
  private structureKey = "";
  private pendingFit = true;
  private focusedNodeId: string | null = null;
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
    if (this.focusedNodeId && !this.block.nodes.some((n) => n.id === this.focusedNodeId)) this.focusedNodeId = null;
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
    graph.on("node:move", () => {
      this.dragging = true;
    });
    graph.on("node:moved", () => {
      this.dragging = false;
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

  private edgeLabels(label: string) {
    const text = label.trim();
    if (!text) return [];
    return [
      {
        attrs: {
          text: { text, fill: "#f4f1ea", fontSize: 12, fontFamily: GRAPH_FONT },
          rect: {
            fill: "#0f1117",
            stroke: "rgba(244, 241, 234, 0.18)",
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
    const block = this.block;
    const key = this.structureOf(block);
    const layoutPending = this.dragging || this.layoutTimer !== null || this.layoutInFlight || this.layoutQueued;

    if (key !== this.structureKey) {
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
          attrs: {
            line: {
              stroke: "rgba(244, 241, 234, 0.45)",
              strokeWidth: 1.3,
              targetMarker: { name: "block", width: 9, height: 7 },
            },
          },
          labels: this.edgeLabels(edge.label),
        });
      });
      this.structureKey = key;
      this.pendingFit = true;
      this.fit();
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
      (cell as X6Edge).setLabels(this.edgeLabels(edge.label));
    });
  }

  private focusNode(id: string | null): void {
    this.focusedNodeId = id;
    this.ctx.selectBlock(this.reply.id, this.block.id);
    const g = this.graph;
    if (g) {
      this.block.nodes.forEach((node) => {
        const cell = g.getCellById(node.id);
        if (cell && cell.isNode()) (cell as X6Node).setAttrs(this.nodeAttrs(node));
      });
    }
    this.renderNodeList();
    this.renderDetail();
    if (this.edit && this.edit.draft.nodeId !== id && id) {
      this.edit.draft.nodeId = id;
      this.rebuildEditor();
    }
  }

  private renderNodeList(): void {
    this.nodeListWrap.replaceChildren();
    const nodes = this.block.nodes;
    if (nodes.length === 0) {
      this.nodeListWrap.append(el("p", "rb-mute", translate("graph.empty")));
      return;
    }
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

  private renderDetail(): void {
    this.detailWrap.replaceChildren();
    const node = this.block.nodes.find((n) => n.id === this.focusedNodeId) ?? null;
    this.detailWrap.append(el("span", "rb-kicker", translate("graph.detail")));
    if (!node) {
      this.detailWrap.append(el("p", "rb-mute", translate(this.block.nodes.length ? "graph.pick" : "graph.empty")));
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
    const titleOf = (id: string) => displayTitle(this.block.nodes.find((n) => n.id === id)?.title ?? id);
    const related = this.block.edges.filter((e) => e.from === node.id || e.to === node.id);
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
    return this.block.nodes.map((node) => {
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
    if (this.layoutInFlight) {
      this.layoutQueued = true;
      return;
    }
    this.layoutInFlight = true;
    this.layoutState = "saving";
    this.renderStatus();
    const request: ReplyPatchRequest = {
      reply_id: this.reply.id,
      expected_revision: this.reply.revision,
      block: { ...this.block, nodes: this.currentNodes() },
      layout_only: true,
    };
    try {
      const updated = await this.ctx.handlers.onPatch(request);
      this.layoutInFlight = false;
      this.layoutState = "saved";
      // An open node editor already reads live positions, so it may follow this revision.
      if (this.edit && this.edit.expectedRevision === request.expected_revision) {
        this.edit.expectedRevision = updated.revision;
      }
      this.ctx.mergeReply(updated);
      this.scheduleStatusClear();
    } catch (err) {
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

  protected createDraft(): GraphDraft {
    const nodes = this.block.nodes.map((n) => ({ ...n }));
    const nodeId = this.focusedNodeId ?? nodes[0]?.id ?? null;
    return { title: this.block.title ?? "", nodeId, nodes };
  }

  protected renderEditor(form: HTMLElement, draft: GraphDraft): void {
    form.append(this.labeled(translate("edit.titleOptional"), textInput(draft.title, (v) => (draft.title = v))));
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
    form.append(this.labeled(translate("edit.nodeTitle"), textInput(node.title, (v) => (node.title = v))));
    form.append(this.labeled(translate("edit.nodeDetail"), textArea(node.detail ?? "", (v) => (node.detail = v), 4)));
  }

  protected draftToBlock(draft: GraphDraft): ReplyGraphBlock {
    const title = draft.title.trim();
    const current = new Map(this.currentNodes().map((n) => [n.id, n]));
    const nodes = draft.nodes.map((n) => {
      const pos = current.get(n.id);
      const detail = (n.detail ?? "").trim();
      return {
        id: n.id,
        title: n.title.trim(),
        ...(detail ? { detail } : {}),
        x: pos?.x ?? n.x ?? null,
        y: pos?.y ?? n.y ?? null,
      };
    });
    return { id: this.block.id, type: "graph", ...(title ? { title } : {}), nodes, edges: this.block.edges.map((e) => ({ ...e })) };
  }

  destroy(): void {
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.graph?.dispose();
    this.graph = null;
    super.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

type AnyBlockView = TextView | ComparisonView | SequenceView | GraphView;

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
      selectBlock: (replyId, blockId) => this.selectBlock(replyId, blockId),
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
        return held && held.revision > incoming.revision && held.updated_at_ms >= incoming.updated_at_ms
          ? held
          : incoming;
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
    return this.selection ? { ...this.selection } : null;
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
      (prev !== null && next !== null && prev.reply_id === next.reply_id && prev.block_id === next.block_id);
    this.selection = next ? { ...next } : null;
    if (next) this.lastBlockByReply.set(next.reply_id, next.block_id);
    this.panels.forEach((panel) => panel.views.forEach((v) => v.refreshSelection()));
    if (!same) this.handlers.onSelect?.(this.getSelection());
  }

  private selectBlock(replyId: string, blockId: string): void {
    if (replyId !== this.activeId) {
      this.activeId = replyId;
      this.badges.delete(replyId);
      this.renderNav();
      this.refreshPanelVisibility();
    }
    this.setSelection({ reply_id: replyId, block_id: blockId });
  }

  private mergeReply(reply: BoardReply): void {
    if (this.destroyed) return;
    const index = this.replies.findIndex((r) => r.id === reply.id);
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
    }
  }

  private refreshPanelVisibility(): void {
    this.panels.forEach((panel, id) => {
      panel.el.hidden = id !== this.activeId;
    });
  }
}
