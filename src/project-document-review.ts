import { currentLocale } from "./i18n";
import { gh } from "./i18n/game-home";
import { pt } from "./i18n/projects";
import { createGoal, fetchGameDocument, fetchGoals, sendGoal, type GameDocument, type Goal } from "./project-game-home-api";
import { decideProjectAccess, fetchProjectAccess, fetchProjectHistory, fetchProjectRecords, mutateProject, type ProjectAccess, type RecordActor, type RecordFields, type WorkRecord } from "./project-record-api";
import type { CodexBinding } from "./types";
import { lineOfOffset, mergeTextRanges, parseRangeFragment, rangeFragment, removeTextRange, type TextRange } from "./project-document-selection";
import "./project-document-review.css";

export const DOCUMENT_REVIEW_SCOPE = "spellcast.document-review.v1";
export const DOCUMENT_DECISION_SCOPE = "spellcast.document-decision.v1";
export const DOCUMENT_SELECTION_SCOPE = "spellcast.document-selection.v1";
export type DocumentMark = "keep" | "candidate";
export type DocumentMarks = Record<string, DocumentMark>;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
};
const button = (text: string, action: () => void, name: string) => {
  const node = el("button", text); node.type = "button"; node.dataset.ghAction = name; node.addEventListener("click", action); return node;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (hash: string) => hash ? hash.slice(0, 8) : "—";
const noFragment = (uri: string) => uri.split("#", 1)[0];

/** Use one canonical absolute URI. A fragment identifies lines, never a different document. */
export function documentFileUri(root: string, path: string): string {
  const full = `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[/\\]+/, "")}`.replaceAll("\\", "/");
  const absolute = full.startsWith("/") ? full : `/${full}`;
  return `file://${encodeURI(absolute).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
}

export function documentReviewRecords(records: WorkRecord[], uri: string): WorkRecord[] {
  return records.filter(record => !record.archived && record.scope === DOCUMENT_REVIEW_SCOPE &&
    record.references?.[0] && noFragment(record.references[0].uri) === uri);
}

export function documentDecisionState(records: WorkRecord[], uri: string, hash: string, fallback?: DocumentMark): { value: DocumentMark | ""; stale: boolean; record?: WorkRecord } {
  const record = records.find(item => !item.archived && item.scope === DOCUMENT_DECISION_SCOPE && item.references?.[0] && noFragment(item.references[0].uri) === uri);
  if (!record) return { value: fallback || "", stale: false };
  if (record.references?.[0]?.version !== hash) return { value: "", stale: true, record };
  return { value: record.result === "keep" || record.result === "candidate" ? record.result : "", stale: false, record };
}

type Draft = { text: string; quote: string; start: number; end: number; parentId: string; sourceHash?: string; pending?: { id: string; requestId: string; fingerprint: string } };
type QuestionDraft = { text: string; target: string; ranges: TextRange[]; hash: string; pending?: { id: string; fingerprint: string } };
type Options = {
  dialog: HTMLDialogElement;
  projectId: string;
  root: string;
  documents: GameDocument[];
  records: () => WorkRecord[];
  onRecords: (records: WorkRecord[]) => void;
  marks: DocumentMarks;
  onNotice: (notice: string) => void;
  bindings: () => CodexBinding[];
  goals: () => Goal[];
  onGoals: (goals: Goal[]) => void;
};

export function createDocumentReview(options: Options) {
  const { dialog, projectId, documents } = options;
  let activePath = "", serial = 0, disposed = false, source: (GameDocument & { text: string }) | undefined;
  let selectionRanges: TextRange[] = [], appendSelection = false, selectionBusy = false;
  let selectedDiscard: TextRange | null = null;
  let question: QuestionDraft = { text: "", target: "", ranges: [], hash: "" }, questionOpen = false, questionBusy = false;
  let latestRect: DOMRect | null = null;
  const originActors = new Map<string, RecordActor | null>(), loadingOrigins = new Set<string>();
  const draftKey = (path: string) => `spellcast.document-review.v1.${projectId}.${path}.draft`;
  const questionKey = (path: string) => `spellcast.document-question.v1.${projectId}.${path}.draft`;
  const defaultDraft = (): Draft => ({ text: "", quote: "", start: 0, end: 0, parentId: "" });
  let draft = defaultDraft();
  const readDraft = (path: string): Draft => { try { return { ...defaultDraft(), ...JSON.parse(localStorage.getItem(draftKey(path)) || "{}") }; } catch { return defaultDraft(); } };
  const saveDraft = () => { try { localStorage.setItem(draftKey(activePath), JSON.stringify(draft)); } catch { /* The open editor still retains the draft. */ } };
  const readQuestion = (path: string): QuestionDraft => { try { const value = JSON.parse(localStorage.getItem(questionKey(path)) || "{}"); return { text: value.text || "", target: value.target || "", ranges: Array.isArray(value.ranges) ? value.ranges : [], hash: value.hash || "", pending: value.pending }; } catch { return { text: "", target: "", ranges: [], hash: "" }; } };
  const saveQuestion = () => { try { localStorage.setItem(questionKey(activePath), JSON.stringify(question)); } catch { /* Keep the live draft. */ } };
  const lineFragment = () => draft.start > 0 ? `#L${draft.start}-L${draft.end || draft.start}` : "";
  const currentUri = () => documentFileUri(options.root, activePath);
  const currentRecords = () => documentReviewRecords(options.records(), currentUri());
  const selectionRecord = () => options.records().find(record => !record.archived && record.scope === DOCUMENT_SELECTION_SCOPE && record.result === "discard" && record.references?.[0] && noFragment(record.references[0].uri) === currentUri() && record.references[0].version === source?.hash);
  const discardedRanges = () => source && selectionRecord()?.status === "active" ? mergeTextRanges((selectionRecord()?.references || []).map(ref => parseRangeFragment(ref.uri)).filter((range): range is TextRange => !!range), source.text.length) : [];
  const staleSelections = () => options.records().filter(record => !record.archived && record.scope === DOCUMENT_SELECTION_SCOPE && record.result === "discard" && record.status === "active" && record.references?.[0] && noFragment(record.references[0].uri) === currentUri() && record.references[0].version !== source?.hash);
  const notice = (text: string) => { if (disposed) return; options.onNotice(text); const line = dialog.querySelector<HTMLElement>("[data-gh-review-notice]"); if (line) line.textContent = text; };
  const draftPayload = (value: Draft) => JSON.stringify({ text: value.text, quote: value.quote, start: value.start, end: value.end, parentId: value.parentId, sourceHash: value.sourceHash });
  const authorText = (record: WorkRecord, origin: RecordActor | null) => {
    const actor = origin?.label || gh("documentOriginalUnknown");
    const kind = origin?.kind === "agent" ? gh("documentAiReview") : origin?.kind === "user" ? gh("documentUserReview") : gh("documentOriginalUnknown");
    const edited = record.revision > 1 ? ` · ${gh("documentUpdatedBy", { label: record.updated_by?.label || gh("documentUnknownAuthor") })}` : "";
    return `${kind} · ${actor} · ${new Date(record.created_at_ms).toLocaleString(currentLocale() as string)} · ${record.status === "done" ? gh("documentResolved") : gh("documentOpenComment")}${edited}`;
  };
  function originalActor(record: WorkRecord): RecordActor | null {
    if (record.revision <= 1) return record.updated_by;
    if (originActors.has(record.id)) return originActors.get(record.id) || null;
    if (!loadingOrigins.has(record.id)) {
      loadingOrigins.add(record.id);
      void fetchProjectHistory(projectId, "record", record.id).then(history => {
        originActors.set(record.id, history.find(entry => entry.revision === 1)?.actor || null);
      }).catch(() => originActors.set(record.id, null)).finally(() => {
        loadingOrigins.delete(record.id);
        if (disposed || !dialog.open) return;
        const current = options.records().find(item => item.id === record.id);
        const card = [...dialog.querySelectorAll<HTMLElement>("[data-gh-review-record]")].find(item => item.dataset.ghReviewRecord === record.id);
        const label = card?.querySelector<HTMLElement>("[data-gh-review-author]");
        if (current && label) label.textContent = authorText(current, originActors.get(record.id) || null);
      });
    }
    return null;
  }

  function selectedRange(): TextRange | null {
    const selection = window.getSelection(), pre = dialog.querySelector<HTMLElement>("[data-gh-document-text]");
    if (!selection || selection.isCollapsed || !pre || !source || !pre.contains(selection.anchorNode) || !pre.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0);
    const offset = (node: Node, position: number) => { const before = document.createRange(); before.selectNodeContents(pre); before.setEnd(node, position); return before.toString().length; };
    const start = offset(range.startContainer, range.startOffset), end = offset(range.endContainer, range.endOffset);
    return end > start && source.text.slice(start, end).trim() ? { start, end } : null;
  }

  function showSelectionToolbar(rect: DOMRect | null) {
    const toolbar = dialog.querySelector<HTMLElement>("[data-gh-selection-toolbar]");
    const reading = dialog.querySelector<HTMLElement>(".gh-review-reading");
    if (!toolbar || !reading) return;
    toolbar.hidden = selectionRanges.length === 0 && !selectedDiscard;
    if (toolbar.hidden) return;
    toolbar.querySelector<HTMLElement>("[data-gh-selection-count]")!.textContent = gh("documentSelectedCount", { count: selectionRanges.length || 1 });
    const append = toolbar.querySelector<HTMLButtonElement>("[data-gh-action=toggle-append-selection]");
    if (append) { append.setAttribute("aria-pressed", String(appendSelection)); append.textContent = appendSelection ? gh("documentAppendOn") : gh("documentAppendSelection"); }
    if (rect) latestRect = rect;
    const anchor = latestRect || reading.getBoundingClientRect();
    const bounds = reading.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(anchor.left - bounds.left + reading.scrollLeft, reading.clientWidth - toolbar.offsetWidth - 8))}px`;
    const below = anchor.bottom - bounds.top + reading.scrollTop + 6;
    const above = anchor.top - bounds.top + reading.scrollTop - toolbar.offsetHeight - 6;
    const desired = below + toolbar.offsetHeight <= reading.scrollTop + reading.clientHeight - 8 ? below : above;
    toolbar.style.top = `${Math.max(reading.scrollTop + 8, Math.min(desired, reading.scrollTop + reading.clientHeight - toolbar.offsetHeight - 8))}px`;
    const undo = toolbar.querySelector<HTMLButtonElement>("[data-gh-action=undo-discard]"); if (undo) undo.hidden = !selectedDiscard;
    const discard = toolbar.querySelector<HTMLButtonElement>("[data-gh-action=discard-selection]"); if (discard) discard.hidden = !!selectedDiscard;
  }

  function captureSelection(event?: MouseEvent | KeyboardEvent) {
    if (!source || selectionBusy) return;
    const range = selectedRange();
    if (!range) {
      if (!appendSelection && !(event instanceof MouseEvent && (event.ctrlKey || event.metaKey))) { selectionRanges = []; selectedDiscard = null; renderSelectionList(); showSelectionToolbar(null); }
      return;
    }
    selectedDiscard = null;
    selectionRanges = mergeTextRanges(appendSelection || (event instanceof MouseEvent && (event.ctrlKey || event.metaKey)) ? [...selectionRanges, range] : [range], source.text.length);
    const native = window.getSelection(); const rect = native?.rangeCount ? native.getRangeAt(0).getBoundingClientRect() : null;
    renderSelectionList(); showSelectionToolbar(rect);
  }

  function updateTemporaryHighlights() {
    const registry = (CSS as unknown as { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }).highlights;
    const constructor = (window as Window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const pre = dialog.querySelector<HTMLElement>("[data-gh-document-text]");
    if (!registry) return;
    registry.delete("gh-temp-selection");
    if (!constructor || !pre || !selectionRanges.length) return;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
    let node: Node | null; while ((node = walker.nextNode())) nodes.push(node as Text);
    const point = (offset: number): [Node, number] => {
      let remaining = offset;
      for (const text of nodes) { if (remaining <= text.length) return [text, remaining]; remaining -= text.length; }
      const last = nodes.at(-1); return last ? [last, last.length] : [pre, 0];
    };
    const ranges = selectionRanges.map(item => { const range = document.createRange(); range.setStart(...point(item.start)); range.setEnd(...point(item.end)); return range; });
    registry.set("gh-temp-selection", new constructor(...ranges));
  }

  function renderSelectionList() {
    const list = dialog.querySelector<HTMLElement>("[data-gh-selection-list]"); if (!list || !source) return;
    list.replaceChildren();
    for (const range of selectionRanges) {
      const row = el("div", "", "gh-selection-row");
      const quote = source.text.slice(range.start, range.end).trim();
      row.append(el("small", `${gh("documentLineRange", { start: lineOfOffset(source.text, range.start), end: lineOfOffset(source.text, range.end - 1) })} · ${quote.length > 100 ? `${quote.slice(0, 100)}…` : quote}`));
      const remove = button(gh("documentRemoveSelection"), () => { selectionRanges = selectionRanges.filter(item => item !== range); renderSelectionList(); showSelectionToolbar(null); }, "remove-selection-range");
      row.append(remove); list.append(row);
    }
    const clear = dialog.querySelector<HTMLButtonElement>("[data-gh-action=clear-selection-ranges]"); if (clear) clear.hidden = !selectionRanges.length;
    updateTemporaryHighlights();
  }

  async function persistDiscard(nextRanges: TextRange[]) {
    if (!source || selectionBusy) return;
    const path = activePath, hash = source.hash, text = source.text, uri = currentUri();
    const current = selectionRecord();
    const ranges = mergeTextRanges(nextRanges, text.length);
    const title = source.title || path.split("/").at(-1) || path;
    const references = ranges.length ? ranges.map(range => ({ label: title, uri: `${uri}${rangeFragment(text, range)}`, version: hash })) : [{ label: title, uri, version: hash }];
    const fields: RecordFields = { title: `${title.slice(0, 70)} · discarded passages`, scope: DOCUMENT_SELECTION_SCOPE, result: "discard",
      status: ranges.length ? "active" : "cancelled", goal: ranges.map(range => text.slice(range.start, range.end)).join("\n\n——\n\n"), references };
    selectionBusy = true;
    const action = dialog.querySelector<HTMLButtonElement>("[data-gh-action=discard-selection]"); if (action) action.disabled = true;
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${uri}@${hash}`));
      const id = current?.id || `doc-discard-${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
      const result = await mutateProject({ op: "put_record", project_id: projectId, request_id: crypto.randomUUID(), id, expected_revision: current?.revision || 0, fields });
      const records = await fetchProjectRecords(projectId).catch(() => result.record ? [...options.records().filter(record => record.id !== id), result.record] : options.records());
      if (!disposed) options.onRecords(records);
      if (!disposed && path === activePath && source?.hash === hash) { selectedDiscard = null; selectionRanges = []; renderSourceText(); renderSelectionList(); showSelectionToolbar(null); notice(gh("decisionSaved")); }
    } catch (error) {
      const records = await fetchProjectRecords(projectId).catch(() => options.records()); if (!disposed) options.onRecords(records);
      if (!disposed && path === activePath) notice(`${gh("error")}：${errorText(error)}`);
    } finally { selectionBusy = false; if (action?.isConnected) action.disabled = false; }
  }

  function questionText(): string {
    if (!source || question.hash !== source.hash) return "";
    const uri = currentUri();
    return `${question.text.trim()}\n\n${question.ranges.map((range, i) => `【${i + 1}】${uri}${rangeFragment(source!.text, range)}\n${source!.text.slice(range.start, range.end)}`).join("\n\n")}`;
  }

  async function submitQuestion() {
    if (!source || !question.text.trim() || !question.ranges.length || questionBusy) return;
    if (question.hash !== source.hash) { notice(gh("documentQuestionReanchor")); return; }
    const text = questionText();
    if ([...text].length > 4000) { notice(gh("documentQuestionTooLong")); return; }
    const path = activePath, hash = source.hash, target = options.bindings().find(binding => binding.source_id === question.target);
    const context = { scale: "overview" as const, zone_id: "", location_id: "", entity_kind: "document_question", entity_id: path,
      label: source.title || path.split("/").at(-1) || path, source_revision: hash, sources: [{ path, hash }] };
    const fingerprint = JSON.stringify({ text, context });
    if (question.pending?.fingerprint !== fingerprint) question.pending = { id: crypto.randomUUID(), fingerprint };
    saveQuestion(); const id = question.pending.id;
    questionBusy = true;
    const action = dialog.querySelector<HTMLButtonElement>("[data-gh-action=send-document-question]"); if (action) action.disabled = true;
    try {
      await createGoal(projectId, { id, text, context });
      if (target) {
        try { await sendGoal(projectId, id, { source_id: target.source_id, thread_id: target.thread_id }); notice(gh("goalQueued", { label: target.label })); }
        catch (error) { notice(`${gh("unsent")}：${errorText(error)}`); }
      } else notice(gh("documentQuestionUnsent"));
      const goals = await fetchGoals(projectId).catch(() => options.goals()); if (!disposed) options.onGoals(goals);
      if (!disposed && path === activePath && source?.hash === hash && question.pending?.id === id && questionText() === text) { question = { text: "", target: question.target, ranges: [], hash }; saveQuestion(); questionOpen = false; renderQuestionPanel(); renderGoalAnswers(); }
    } catch (error) { notice(`${gh("error")}：${errorText(error)}`); }
    finally { questionBusy = false; if (action?.isConnected) action.disabled = false; }
  }

  function jump(record: WorkRecord) {
    if (!source || record.references?.[0]?.version !== source.hash) { notice(gh("documentStaleReference")); return; }
    const match = record.references?.[0]?.uri.match(/#L(\d+)(?:-L(\d+))?$/);
    if (!match) { dialog.querySelector<HTMLElement>(".gh-review-reading")?.scrollTo({ top: 0, behavior: "smooth" }); return; }
    const line = dialog.querySelector<HTMLElement>(`[data-gh-document-line="${match[1]}"]`);
    line?.scrollIntoView({ behavior: "smooth", block: "center" });
    line?.classList.add("gh-document-line-active");
    window.setTimeout(() => line?.classList.remove("gh-document-line-active"), 1800);
  }

  async function saveComment() {
    if (!source || !draft.text.trim()) return;
    if ((draft.quote || draft.start) && draft.sourceHash !== source.hash) { notice(gh("documentCommentReanchor")); return; }
    const path = activePath;
    const submittedPayload = draftPayload(draft);
    const text = draft.text.trim();
    const references = [{ label: source.title || path.split("/").at(-1) || path, uri: `${currentUri()}${lineFragment()}`, version: source.hash }];
    if (draft.parentId) references.push({ label: gh("documentReply"), uri: `spellcast://project/${projectId}/record/${draft.parentId}`, version: "" });
    const fields: RecordFields = { title: text.split(/\r?\n/, 1)[0].slice(0, 80), result: text, goal: draft.quote, scope: DOCUMENT_REVIEW_SCOPE, status: "active", references };
    const fingerprint = JSON.stringify(fields);
    if (draft.pending?.fingerprint !== fingerprint) draft.pending = { id: crypto.randomUUID(), requestId: crypto.randomUUID(), fingerprint };
    saveDraft();
    const pending = draft.pending;
    const save = dialog.querySelector<HTMLButtonElement>("[data-gh-action=save-review-comment]"); if (save) save.disabled = true;
    try {
      const result = await mutateProject({ op: "put_record", project_id: projectId, request_id: pending.requestId, id: pending.id, expected_revision: 0, fields });
      const records = await fetchProjectRecords(projectId).catch(() => result.record ? [...options.records(), result.record] : options.records());
      if (!disposed) options.onRecords(records);
      if (!disposed && path === activePath) {
        if (draftPayload(draft) === submittedPayload && draft.pending?.id === pending.id) { draft = defaultDraft(); saveDraft(); }
      } else {
        const stored = readDraft(path);
        if (draftPayload(stored) === submittedPayload && stored.pending?.id === pending.id) {
          try { localStorage.removeItem(draftKey(path)); } catch { /* Local draft storage is best effort. */ }
        }
      }
      if (!disposed && source && dialog.open) { render(); notice(gh("documentCommentSaved")); }
    } catch (error) { notice(`${gh("error")}：${errorText(error)}`); if (save) save.disabled = false; }
  }

  async function setResolved(record: WorkRecord) {
    const fields: RecordFields = { object_id: record.object_id, title: record.title, goal: record.goal, scope: record.scope,
      status: record.status === "done" ? "active" : "done", result: record.result, boundaries: record.boundaries,
      next_step: record.next_step, references: record.references };
    try {
      await mutateProject({ op: "put_record", project_id: projectId, request_id: crypto.randomUUID(), id: record.id, expected_revision: record.revision, fields });
      const refreshed = await fetchProjectRecords(projectId); if (!disposed) { options.onRecords(refreshed); render(); notice(gh("decisionSaved")); }
    } catch (error) {
      const refreshed = await fetchProjectRecords(projectId).catch(() => options.records());
      if (!disposed) { options.onRecords(refreshed); render(); notice(`${gh("error")}：${errorText(error)}`); }
    }
  }

  function renderSourceText() {
    const pre = dialog.querySelector<HTMLElement>("[data-gh-document-text]"); if (!pre || !source) return;
    const reading = pre.parentElement;
    const top = reading?.scrollTop || 0, left = reading?.scrollLeft || 0, text = source.text, discarded = discardedRanges();
    pre.replaceChildren(); let offset = 0;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const start = offset, end = start + line.length, span = el("span", "", "gh-document-line");
      span.dataset.ghDocumentLine = String(i + 1); span.id = `gh-doc-L${i + 1}`;
      const cuts = new Set([start, end]);
      for (const range of discarded) if (range.start < end && range.end > start) { cuts.add(Math.max(start, range.start)); cuts.add(Math.min(end, range.end)); }
      const positions = [...cuts].sort((a, b) => a - b);
      for (let p = 0; p < positions.length - 1; p++) {
        const a = positions[p], b = positions[p + 1], segment = text.slice(a, b);
        const discard = discarded.find(range => range.start <= a && range.end >= b);
        if (discard) {
          const mark = el("span", segment, "gh-document-discarded"); mark.dataset.ghDiscardedRange = `${discard.start}-${discard.end}`;
          mark.addEventListener("click", event => { if (selectedRange()) return; selectedDiscard = discard; selectionRanges = []; showSelectionToolbar(new DOMRect(event.clientX, event.clientY, 0, 0)); renderSelectionList(); });
          span.append(mark);
        } else span.append(document.createTextNode(segment));
      }
      if (!line) span.append(document.createTextNode(""));
      pre.append(span); if (i < lines.length - 1) pre.append(document.createTextNode("\n")); offset = end + 1;
    });
    if (reading) { reading.scrollTop = top; reading.scrollLeft = left; }
  }

  function renderQuestionPanel() {
    const panel = dialog.querySelector<HTMLElement>("[data-gh-question-panel]"); if (!panel || !source) return;
    panel.hidden = !questionOpen;
    if (!questionOpen) return;
    const selected = panel.querySelector<HTMLElement>("[data-gh-question-selection]");
    if (selected) selected.textContent = gh("documentSelectedCount", { count: question.ranges.length });
    const textarea = panel.querySelector<HTMLTextAreaElement>("[data-gh-question-draft]"); if (textarea && textarea.value !== question.text) textarea.value = question.text;
    const target = panel.querySelector<HTMLSelectElement>("[data-gh-question-target]");
    if (target) {
      const previous = target.value || question.target; target.replaceChildren();
      const empty = el("option", gh("noTarget")); empty.value = ""; target.append(empty);
      for (const binding of options.bindings()) { const choice = el("option", gh("taskLabel", { label: binding.label || binding.source_id, thread: binding.thread_id.slice(0, 8) })); choice.value = binding.source_id; target.append(choice); }
      target.value = options.bindings().some(binding => binding.source_id === previous) ? previous : "";
      question.target = target.value;
    }
    const action = panel.querySelector<HTMLButtonElement>("[data-gh-action=send-document-question]");
    if (action) { action.disabled = questionBusy || !question.text.trim() || !question.ranges.length; action.textContent = question.target ? gh("documentSendQuestion") : gh("documentSaveQuestion"); }
  }

  let accesses: ProjectAccess[] = [];
  async function sendSavedQuestion(goal: Goal, targetId: string) {
    const target = options.bindings().find(binding => binding.source_id === targetId);
    if (!target || goal.status !== "unsent") return;
    try { await sendGoal(projectId, goal.id, { source_id: target.source_id, thread_id: target.thread_id }); notice(gh("goalQueued", { label: target.label })); await refreshQuestionState(); }
    catch (error) { notice(`${gh("unsent")}：${errorText(error)}`); }
  }
  function renderGoalAnswers() {
    const box = dialog.querySelector<HTMLElement>("[data-gh-question-results]"); if (!box || !source) return;
    box.replaceChildren();
    const mine = options.goals().filter(goal => goal.context.entity_kind === "document_question" && goal.context.entity_id === activePath && goal.context.source_revision === source?.hash);
    for (const goal of mine) {
      const card = el("article", "", "gh-review-comment"); card.dataset.ghQuestionGoal = goal.id;
      const status = goal.status === "unsent" ? gh("unsent") : goal.delivery?.phase === "failed" ? gh("failed", { error: goal.delivery.error || "—" })
        : goal.delivery?.phase === "unanswered" ? gh("unanswered") : goal.delivery?.phase === "responded" ? gh("respondedDocument")
        : goal.delivery?.phase === "handled" ? gh("handled") : goal.delivery?.phase === "unknown" ? gh("unknown", { error: goal.delivery.error || "—" })
        : goal.delivery?.phase === "received" ? gh("received") : goal.delivery?.phase === "submitted" ? gh("submitted") : goal.delivery?.phase === "dispatching" ? gh("dispatching") : gh("waiting", { label: goal.target?.label || "Codex" });
      const statusLine = el("small", status, "gh-muted"); statusLine.dataset.ghQuestionStatus = goal.delivery?.phase || goal.status;
      card.append(statusLine, el("p", goal.text.split("\n\n", 1)[0]));
      const responseIds = (goal as Goal & { response_record_ids?: string[] }).response_record_ids || [];
      const answers = options.records().filter(record => responseIds.includes(record.id) && record.scope === DOCUMENT_REVIEW_SCOPE && record.references?.some(ref => ref.uri === `spellcast://project/${projectId}/goal/${goal.id}`));
      for (const answer of answers) { const reply = el("div", "", "gh-document-answer"); reply.dataset.ghDocumentAnswer = answer.id; reply.append(el("small", answer.updated_by.label, "gh-muted"), el("p", answer.result || answer.title)); card.append(reply); }
      if (goal.status === "unsent") {
        const row = el("div", "", "gh-actions");
        const target = el("select"); target.dataset.ghSavedQuestionTarget = goal.id; target.setAttribute("aria-label", gh("target"));
        const empty = el("option", gh("noTarget")); empty.value = ""; target.append(empty);
        for (const binding of options.bindings()) { const option = el("option", gh("taskLabel", { label: binding.label || binding.source_id, thread: binding.thread_id.slice(0, 8) })); option.value = binding.source_id; target.append(option); }
        const send = button(gh("documentSendQuestion"), () => void sendSavedQuestion(goal, target.value), "send-saved-document-question"); send.disabled = true;
        target.addEventListener("change", () => { send.disabled = !target.value; }); row.append(target, send); card.append(row);
      }
      const pending = goal.target && accesses.find(access => access.thread_id === goal.target!.thread_id && access.state === "pending");
      if (pending) card.append(button(gh("documentAllowAnswer"), () => void decideProjectAccess(projectId, pending.id, pending.revision, "approved")
        .then(async () => { accesses = await fetchProjectAccess(projectId); renderGoalAnswers(); notice(gh("decisionSaved")); })
        .catch(error => notice(`${gh("error")}：${errorText(error)}`)), "allow-document-answer"));
      box.append(card);
    }
  }

  async function refreshQuestionState() {
    if (disposed || !dialog.open) return;
    const path = activePath, token = serial;
    const [goals, records, access] = await Promise.allSettled([fetchGoals(projectId), fetchProjectRecords(projectId), fetchProjectAccess(projectId)]);
    if (disposed || token !== serial || path !== activePath) return;
    if (goals.status === "fulfilled") options.onGoals(goals.value);
    if (records.status === "fulfilled") options.onRecords(records.value);
    if (access.status === "fulfilled") accesses = access.value;
    renderGoalAnswers();
  }

  function render() {
    if (!source || disposed) return;
    const path = activePath, index = documents.findIndex(item => item.path === path);
    const head = el("header", "", "gh-review-head");
    head.append(el("h3", source.title || path.split("/").at(-1) || path), button(pt("close"), () => dialog.close(), "close-source"));
    const toolbar = el("div", "", "gh-review-toolbar");
    const prev = button(gh("documentPrevious"), () => { if (index > 0) void open(documents[index - 1].path); }, "previous-document"); prev.disabled = index <= 0;
    const next = button(gh("documentNext"), () => { if (index < documents.length - 1) void open(documents[index + 1].path); }, "next-document"); next.disabled = index < 0 || index >= documents.length - 1;
    toolbar.append(prev, next, button(gh("copyPath"), () => void navigator.clipboard.writeText(`${options.root.replace(/[\\/]+$/, "")}/${path}`).then(() => notice(gh("copied"))).catch(error => notice(errorText(error))), "copy-document-path"));
    const meta = el("small", `${path} · SHA-256 ${source.hash}`, "gh-muted");
    if (staleSelections().length) meta.append(document.createTextNode(` · ${gh("documentDiscardStale")}`));
    const layout = el("div", "", "gh-review-layout");
    const reading = el("div", "", "gh-review-reading");
    const sourcePre = el("pre", "", "gh-review-source"); sourcePre.dataset.ghDocumentText = "true";
    sourcePre.tabIndex = 0;
    sourcePre.addEventListener("mouseup", captureSelection);
    sourcePre.addEventListener("keyup", captureSelection);
    const selectionToolbar = el("div", "", "gh-selection-toolbar"); selectionToolbar.dataset.ghSelectionToolbar = "true"; selectionToolbar.hidden = true;
    selectionToolbar.addEventListener("pointerdown", event => event.preventDefault());
    const selectionCount = el("small", "", "gh-muted"); selectionCount.dataset.ghSelectionCount = "true";
    selectionToolbar.append(selectionCount,
      button(gh("documentAskSelection"), () => { question.ranges = selectionRanges.length ? [...selectionRanges] : selectedDiscard ? [selectedDiscard] : []; question.hash = source!.hash; saveQuestion(); questionOpen = true; renderQuestionPanel(); dialog.querySelector<HTMLTextAreaElement>("[data-gh-question-draft]")?.focus(); }, "ask-selection"),
      button(gh("documentDiscardSelection"), () => void persistDiscard([...discardedRanges(), ...selectionRanges]), "discard-selection"),
      button(gh("documentUndoDiscard"), () => { if (selectedDiscard) void persistDiscard(removeTextRange(discardedRanges(), selectedDiscard, source!.text.length)); }, "undo-discard"),
      button(gh("documentAppendSelection"), () => { appendSelection = !appendSelection; showSelectionToolbar(null); }, "toggle-append-selection"));
    const selectionList = el("div", "", "gh-selection-list"); selectionList.dataset.ghSelectionList = "true"; selectionToolbar.append(selectionList);
    selectionToolbar.append(button(gh("documentClearSelection"), () => { selectionRanges = []; selectedDiscard = null; renderSelectionList(); showSelectionToolbar(null); window.getSelection()?.removeAllRanges(); }, "clear-selection-ranges"));
    reading.append(sourcePre, selectionToolbar);
    const aside = el("aside", "", "gh-review-aside");
    aside.append(el("h4", gh("documentComments", { count: currentRecords().length })));
    const comments = el("div", "", "gh-review-comments");
    const all = currentRecords(); const byParent = new Map<string, WorkRecord[]>();
    const parentOf = (record: WorkRecord) => record.references?.slice(1).find(ref => ref.uri.startsWith(`spellcast://project/${projectId}/record/`))?.uri.split("/").at(-1) || "";
    for (const record of all) { const parent = parentOf(record); const key = all.some(item => item.id === parent) ? parent : "";
      const bucket = byParent.get(key) || []; bucket.push(record); byParent.set(key, bucket); }
    const seen = new Set<string>();
    const add = (parent: string, depth: number) => {
      for (const record of byParent.get(parent) || []) {
        if (seen.has(record.id)) continue; seen.add(record.id);
        const card = el("article", "", "gh-review-comment"); card.dataset.ghReviewRecord = record.id; card.style.setProperty("--gh-review-depth", String(Math.min(depth, 3)));
        const sourceRef = record.references?.[0], stale = sourceRef?.version !== source!.hash;
        const origin = originalActor(record), author = el("small", authorText(record, origin), "gh-muted"); author.dataset.ghReviewAuthor = "true"; card.append(author);
        card.append(el("p", record.result || record.title));
        if (record.goal) card.append(el("blockquote", record.goal));
        if (stale) card.append(el("small", `${gh("documentStaleReference")} · ${short(sourceRef?.version || "")}`, "gh-warning"));
        const evidence = (record.references || []).slice(1).filter(ref => !ref.uri.startsWith(`spellcast://project/${projectId}/record/`));
        if (evidence.length) {
          const details = el("details", "", "gh-review-evidence"); details.append(el("summary", gh("documentEvidence", { count: evidence.length })));
          for (const ref of evidence) {
            const row = el("div", "", "gh-review-evidence-row");
            row.append(el("strong", ref.label || ref.uri), el("code", ref.uri), el("small", `SHA-256 ${ref.version || "—"}`, "gh-muted"));
            const actions = el("div", "", "gh-actions");
            actions.append(button(gh("copyPath"), () => void navigator.clipboard.writeText(ref.uri).then(() => notice(gh("copied"))).catch(error => notice(errorText(error))), "copy-review-evidence"));
            const linked = documents.find(item => documentFileUri(options.root, item.path) === noFragment(ref.uri));
            if (linked) actions.append(button(gh("documentReadEvidence"), () => void open(linked.path), "read-review-evidence"));
            row.append(actions); details.append(row);
          }
          card.append(details);
        }
        const actions = el("div", "", "gh-actions");
        const jumpButton = button(sourceRef?.uri.includes("#L") ? gh("documentJumpToLine") : gh("documentJumpToTop"), () => jump(record), "jump-comment"); jumpButton.disabled = stale;
        actions.append(jumpButton, button(gh("documentReply"), () => { draft.parentId = record.id; draft.quote = ""; draft.start = 0; draft.end = 0; saveDraft(); render(); dialog.querySelector<HTMLTextAreaElement>("[data-gh-review-draft]")?.focus(); }, "reply-comment"),
          button(record.status === "done" ? gh("documentReopen") : gh("documentResolve"), () => void setResolved(record), "toggle-comment-resolved"));
        card.append(actions); comments.append(card); add(record.id, depth + 1);
      }
    };
    add("", 0); aside.append(comments);
    const questionPanel = el("section", "", "gh-review-editor gh-question-panel"); questionPanel.dataset.ghQuestionPanel = "true"; questionPanel.hidden = true;
    questionPanel.append(el("h4", gh("documentAskSelection")));
    const questionSelection = el("small", "", "gh-muted"); questionSelection.dataset.ghQuestionSelection = "true"; questionPanel.append(questionSelection);
    const questionInput = el("textarea"); questionInput.dataset.ghQuestionDraft = "true"; questionInput.placeholder = gh("documentQuestionPlaceholder"); questionInput.setAttribute("aria-label", gh("documentQuestionPlaceholder"));
    questionInput.addEventListener("input", () => { question.text = questionInput.value; saveQuestion(); renderQuestionPanel(); }); questionPanel.append(questionInput);
    const questionTarget = el("select"); questionTarget.dataset.ghQuestionTarget = "true"; questionTarget.setAttribute("aria-label", gh("target"));
    questionTarget.addEventListener("change", () => { question.target = questionTarget.value; saveQuestion(); renderQuestionPanel(); }); questionPanel.append(questionTarget);
    const questionSend = button(gh("documentSendQuestion"), () => void submitQuestion(), "send-document-question"); questionPanel.append(questionSend);
    questionPanel.append(button(gh("cancel"), () => { questionOpen = false; renderQuestionPanel(); }, "close-document-question"));
    aside.append(questionPanel);
    const questionResults = el("section", "", "gh-question-results"); questionResults.dataset.ghQuestionResults = "true"; aside.append(questionResults);
    const editor = el("div", "", "gh-review-editor");
    editor.append(el("h4", draft.parentId ? gh("documentReply") : gh("documentNewComment")));
    if (draft.quote) editor.append(el("blockquote", draft.quote));
    const reference = el("small", draft.parentId ? gh("documentReplyTo") : draft.start ? gh("documentLineRange", { start: draft.start, end: draft.end }) : gh("documentWholeDocument"), "gh-muted");
    const textarea = el("textarea"); textarea.dataset.ghReviewDraft = "true"; textarea.value = draft.text; textarea.placeholder = gh("documentCommentPlaceholder"); textarea.setAttribute("aria-label", gh("documentNewComment"));
    textarea.addEventListener("input", () => { draft.text = textarea.value; saveDraft(); });
    editor.append(reference, textarea);
    const editorActions = el("div", "", "gh-actions");
    editorActions.append(button(gh("documentWholeDocument"), () => { draft = { ...draft, quote: "", start: 0, end: 0, parentId: "" }; saveDraft(); render(); }, "whole-document-comment"),
      button(gh("documentClearDraft"), () => { draft = defaultDraft(); saveDraft(); render(); }, "clear-review-draft"),
      button(gh("documentSaveComment"), () => void saveComment(), "save-review-comment"));
    editor.append(editorActions); aside.append(editor);
    layout.append(reading, aside);
    const note = el("p", "", "gh-review-notice"); note.dataset.ghReviewNotice = "true"; note.setAttribute("role", "status");
    dialog.replaceChildren(head, toolbar, meta, layout, note);
    renderSourceText(); renderSelectionList(); showSelectionToolbar(null); renderQuestionPanel(); renderGoalAnswers();
  }

  async function open(path: string) {
    if (disposed) return;
    const token = ++serial; activePath = path; source = undefined; selectionRanges = []; selectedDiscard = null; latestRect = null; draft = readDraft(path); question = readQuestion(path); questionOpen = !!question.text || !!question.ranges.length;
    (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights?.delete("gh-temp-selection");
    dialog.replaceChildren(el("p", gh("loading"))); if (!dialog.open) dialog.showModal();
    try {
      const next = await fetchGameDocument(projectId, path); if (disposed || token !== serial) return; source = next;
      const staleQuestion = question.ranges.length > 0 && question.hash !== next.hash;
      if (staleQuestion) { question.ranges = []; question.hash = next.hash; question.pending = undefined; saveQuestion(); questionOpen = true; }
      render();
      if (staleQuestion) notice(gh("documentQuestionReanchor"));
      else if ((draft.quote || draft.start) && draft.sourceHash !== next.hash) notice(gh("documentCommentReanchor"));
      void refreshQuestionState();
    }
    catch (error) { if (!disposed && token === serial) dialog.replaceChildren(el("p", errorText(error)), button(pt("close"), () => dialog.close(), "close-source")); }
  }
  const handleResize = () => {
    const toolbar = dialog.querySelector<HTMLElement>("[data-gh-selection-toolbar]");
    if (disposed || !dialog.open || !toolbar || toolbar.hidden) return;
    const pre = dialog.querySelector<HTMLElement>("[data-gh-document-text]"), selection = window.getSelection();
    const rect = selection && !selection.isCollapsed && selection.rangeCount && pre?.contains(selection.anchorNode) && pre.contains(selection.focusNode)
      ? selection.getRangeAt(0).getBoundingClientRect() : null;
    latestRect = null;
    showSelectionToolbar(rect);
  };
  window.addEventListener("resize", handleResize);
  return { open, refresh: refreshQuestionState, dispose: () => { disposed = true; ++serial; window.removeEventListener("resize", handleResize); (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights?.delete("gh-temp-selection"); } };
}
