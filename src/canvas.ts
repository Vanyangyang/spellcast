import { Graph, Shape, Transform, History, type Node } from "@antv/x6";
import { mountReplyBoard, type ReplyBoardHandle, type ReplyBoardHandlers } from "./replies";
import type { BoardReply, ReplyBlock, ReplyPatchRequest, ReplyActionInput } from "./reply-types";
import type { BoardNode, BoardSnapshot, CanvasAnchor, CanvasBatchRequest, CanvasComposition, CanvasContent, CanvasContentFields, CanvasLayout, CanvasObject, CanvasPlacement, CanvasProposal, CanvasRead, CodexBinding } from "./types";
import { filterOverviewItems, overviewItemFromObject, overviewPaintKey } from "./content-organization";
import { originForObject, originMatches, type ContentOrigin } from "./content-origin";
import { blockReply } from "./canvas-blocks";
import { canvasInsert } from "./canvas-insert";
import { canvasIdea, type IdeaMember } from "./canvas-idea";
import { replyDrafts, draftKey, draftText, contentKey, type DraftRecord } from "./reply-drafts";
import { isNativeCanvasContent, NativeCanvasContent } from "./canvas-native";
import { ct } from "./i18n/canvas";
import { onLocale } from "./i18n";
import { apiBase } from "./api";
import { CanvasDataflow } from "./canvas-dataflow";
import { canvasConnections } from "./canvas-connections";
import { initialFocusKey, type LocateIntent } from "./canvas-nav";
import { savedViewIsPlausible, viewShouldRecover, viewportIsUsable } from "./canvas-view";
import "./canvas.css";

/** object_id is the canonical canvas identity; reply/block/node ids stay for existing callers. */
export type CanvasSelection = { object_id?: string; object_ids?: string[]; composition_id?: string; anchors?: CanvasAnchor[]; reply_id?: string; block_id?: string; node_id?: string };
type Handlers = Omit<ReplyBoardHandlers, "onSelect"> & {
  onSelect(selection: CanvasSelection | null): void;
  /** Pointer/keyboard canvas choice, not update() or selectNode. */
  onHumanSelect?(): void;
  onNodePatch(id: string, request: ReplyPatchRequest): Promise<BoardNode>;
  onNodeAsk(id: string, text: string): Promise<void>;
  onBlockAction(id: string, request: ReplyActionInput, expectedRevision: number): Promise<BoardSnapshot>;
  onCreate(): Promise<BoardNode>;
  /** Removes one presentation: itemId is the object ID, expectedRevision its presentation revision. Content is kept. */
  onDelete(itemId: string, expectedRevision: number): Promise<BoardSnapshot>;
  /** Puts a removed presentation back at its recorded position and size. */
  onRestore(itemId: string, expectedRevision: number): Promise<BoardSnapshot>;
  /** New callers pass undefined; each placement carries its own revision. */
  onLayout(revision: number | undefined, items: CanvasPlacement[]): Promise<CanvasLayout>;
  onBatch(request: CanvasBatchRequest): Promise<BoardSnapshot>;
  onProposal(requestId: string, action: "apply" | "dismiss", current: CanvasRead[]): Promise<BoardSnapshot>;
  onReload(): Promise<BoardSnapshot>;
  onRestoreComposer(record: DraftRecord): void;
};
type Content = CanvasObject["content"];
type LegacyContent = Extract<Content, { type: "node" | "reply" }>;
type Entry = { object: CanvasObject; placement: CanvasPlacement; reply?: BoardReply; note?: BoardNode };
type Frame = {
  object: CanvasObject; root: HTMLElement; head: HTMLElement; title: HTMLElement; source: HTMLElement; provenance: HTMLElement; content: HTMLElement;
  activateButton: HTMLButtonElement; openButton: HTMLButtonElement; cell: Node; editor?: ReplyBoardHandle; native?: NativeCanvasContent;
  reply?: BoardReply; placement: CanvasPlacement; note?: BoardNode;
};
const MIN_SIZE = 48, MAX_SIZE = 2400, EDGE_Z = -2_000_000;
const isLegacyContent = (content: Content): content is LegacyContent => content.type === "node" || content.type === "reply";
const legacyKey = (content: Content) => isLegacyContent(content) ? `${content.type}:${content.id}` : content.type;
const titleFor = (object: CanvasObject, reply?: BoardReply) => reply?.title ?? (isNativeCanvasContent(object.content) ? object.content.title : "");

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function button(text: string, action: () => void, title = text) {
  const node = element("button", "ghost", text); node.type = "button"; node.title = title;
  node.setAttribute("aria-label", title); node.addEventListener("click", action); return node;
}
function noteReply(note: BoardNode, object_id: string): BoardReply {
  return { id: `node:${note.id}`, object_id, source_id: `node:${note.id}`, source_label: "", title: note.title,
    revision: note.revision ?? 0, created_at_ms: 0, updated_at_ms: note.revision ?? 0,
    blocks: [{ id: "text", type: "text", title: note.title, text: note.body }] };
}

export function mountCanvas(host: HTMLElement, handlers: Handlers) {
  const root = element("section", "canvas-workspace");
  const toolbar = element("nav", "canvas-toolbar"); toolbar.setAttribute("aria-label", "Canvas");
  const scopeBar = element("nav", "canvas-scope");
  const workspaceSelect = element("select"); workspaceSelect.id = "canvas-workspace-select";
  const taskSelect = element("select"); taskSelect.id = "canvas-task-select";
  scopeBar.append(workspaceSelect, taskSelect);
  let scopeWorkspace = "", scopeTask = "all";
  try { const saved = JSON.parse(localStorage.getItem("spellcast.canvas-scope") ?? "null"); if (typeof saved?.workspace === "string") { scopeWorkspace = saved.workspace; scopeTask = typeof saved.task === "string" ? saved.task : "all"; } } catch { /* A missing preference does not change content. */ }
  const visibleFrames = new Set<string>();
  const viewport = element("div", "canvas-viewport");
  const graphHost = element("div", "canvas-graph"); graphHost.tabIndex = 0; viewport.append(graphHost);
  graphHost.addEventListener("pointerdown", event => { if (!(event.target as Element).closest(".canvas-frame-head")) graphHost.focus({ preventScroll: true }); });
  const SAFE_LEFT = 88, SAFE_TOP = 56, FIT_PAD = 48;
  const graphBox = () => ({ width: graphHost.clientWidth, height: graphHost.clientHeight });
  const usableBox = () => {
    const { width, height } = graphBox();
    return { width, height, left: SAFE_LEFT, top: SAFE_TOP, usableWidth: Math.max(1, width - SAFE_LEFT), usableHeight: Math.max(1, height - SAFE_TOP) };
  };
  const hostFocus = () => {
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest("input, textarea, select, [contenteditable], .composer, dialog, .top-more, .canvas-toolbar")) return;
    graphHost.focus({ preventScroll: true });
  };
  const empty = element("div", "canvas-empty");
  const emptyTitle = element("p", "canvas-empty-title");
  const emptyHelp = element("p", "canvas-empty-help");
  empty.append(emptyTitle, emptyHelp);
  viewport.append(empty);
  const navigationHelp = element("p", "canvas-navigation-help");
  const status = element("span", "canvas-status"); status.setAttribute("role", "status");
  root.append(viewport, toolbar, scopeBar); host.append(root);
  const frames = new Map<string, Frame>();
  const dataflow = new CanvasDataflow();
  let dataQueued = false;
  function paintData() {
    for (const frame of frames.values()) frame.native?.setInputs(dataflow.snapshot(frame.object.id));
  }
  const unsubscribeData = dataflow.subscribe(() => {
    if (dataQueued) return; dataQueued = true;
    queueMicrotask(() => { dataQueued = false; if (destroyed) return; paintData(); if (selectedUnits.size) handlers.onSelect(getSelection()); });
  });
  const html = new Map<string, HTMLElement>();
  const shape = `spellcast-frame-${crypto.randomUUID()}`;
  Shape.HTML.register({ shape, html: cell => html.get(cell.id)!, effect: [], markup: [
    { tagName: "rect", selector: "body" },
    { tagName: "foreignObject", selector: "fo", children: [{ ns: "http://www.w3.org/1999/xhtml", tagName: "div", selector: "foContent", style: { width: "100%", height: "100%" } }] },
  ] });
  let hand = false, space = false, middle = false;
  const panning = () => hand || space || middle;
  const graph = new Graph({ container: graphHost, autoResize: true,
    grid: { visible: true, type: "dot", size: 24, args: { color: "#c9c4b8", thickness: 1.15 } }, background: { color: "#f7f6f2" },
    panning: { enabled: true, eventTypes: ["leftMouseDown", "rightMouseDown", "mouseWheelDown"] },
    scaling: { min: 0.01, max: 1.5 },
    mousewheel: { enabled: true, zoomAtMousePosition: true },
    connecting: { allowBlank: false, allowNode: false, allowEdge: false },
    interacting: () => ({ nodeMovable: !panning(), edgeMovable: false, edgeLabelMovable: false }), preventDefaultContextMenu: false,
  });
  Object.defineProperty(graphHost, "__spellcastEdgeModelIds", { configurable: true, get: () => graph.getEdges().map(edge => edge.id) });
  graph.use(new Transform({ resizing: { enabled: true, minWidth: MIN_SIZE, minHeight: MIN_SIZE, maxWidth: MAX_SIZE, maxHeight: MAX_SIZE }, rotating: false }));
  const history = new History({ stackSize: 40, ignoreAdd: true, ignoreRemove: true,
    beforeAddCommand: (_event, args) => {
      const change = args as { key?: string; options?: { remote?: boolean } } | null;
      return ["position", "size"].includes(change?.key ?? "") && !change?.options?.remote;
    } });
  graph.use(history);
  /** Selected units may include composition ids; rendered frames remain object keyed. */
  let selection: string | null = null;
  const selectedUnits = new Set<string>();
  /** Object whose content currently receives input in place. */
  let active: string | null = null;
  let deleting = false, restoring = false;
  let revision = 0;
  let savedLayout: CanvasLayout = { revision: 0, objects: [], items: [] };
  let board: BoardSnapshot | null = null;
  let removedEntries: Entry[] = [];
  const dirty = new Map<string, CanvasPlacement>();
  const groupLocal = new Map<string, CanvasPlacement>();
  const nativeRequestIds = new Map<string, { fields: string; requestId: string }>();
  let groupMove: { request: CanvasBatchRequest; positions: Map<string, CanvasPlacement> } | null = null;
  let groupSaving: Promise<void> | null = null;
  let groupHistoryOpen = false;
  let saving: Promise<void> | null = null;
  let saveTimer = 0;
  let destroyed = false;
  let initialView = false;
  let viewReady = false, viewTimer = 0;
  let viewWidth = viewport.clientWidth, viewHeight = viewport.clientHeight;
  let locateIntent: LocateIntent = { kind: "auto" };
  const viewResize = new ResizeObserver(() => {
    const { width, height } = graphBox();
    if (!width || !height) return;
    if (!initialView && frames.size) {
      applyInitialView();
      return;
    }
    const dx = (width - viewWidth) / 2, dy = (height - viewHeight) / 2;
    const preserveCenter = viewReady && viewWidth > 0 && viewHeight > 0;
    viewWidth = width; viewHeight = height;
    if (preserveCenter && (dx || dy)) { const { tx, ty } = graph.translate(); graph.translate(tx + dx, ty + dy); }
  });
  viewResize.observe(graphHost);
  let edgeKey = "";
  let jumpKey = "";
  let layoutMessage: "layoutSaving" | "layoutSaved" | "layoutFailed" | null = null;
  let readingKey: string | null = null;

  /* ---------- identity mapping: object ids are canonical, legacy keys only resolve through the layout ---------- */
  const objectById = (id: string) => savedLayout.objects.find(object => object.id === id);
  const objectForContent = (type: LegacyContent["type"], id: string) => savedLayout.objects.find(object => isLegacyContent(object.content) && object.content.type === type && object.content.id === id);
  const resolveObject = (id: string) => objectById(id) ?? savedLayout.objects.find(object => legacyKey(object.content) === id);
  const compositionById = (id: string) => savedLayout.compositions?.find(composition => composition.id === id);
  const isComposition = (id: string) => Boolean(compositionById(id));
  function compositionMembers(id: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const composition = compositionById(id); if (!composition) return [];
    return composition.members.flatMap(member => compositionById(member) ? compositionMembers(member, seen) : [member]);
  }
  function selectedObjectIds() {
    const ids = new Set<string>();
    for (const unit of selectedUnits) {
      if (objectById(unit)) ids.add(unit);
      else for (const member of compositionMembers(unit)) if (objectById(member)) ids.add(member);
    }
    return [...ids].filter(id => frames.has(id) && visibleFrames.has(id));
  }
  const primaryFrame = () => selection && frames.has(selection) ? frames.get(selection) : selectedObjectIds().map(id => frames.get(id)).find(Boolean);
  /** Drafts prefer object_id; drafts written before object ids existed resolve through their legacy reply/node id. */
  function draftObject(record: DraftRecord): CanvasObject | undefined {
    const object = record.object_id ? objectById(record.object_id)
      : record.reply_id.startsWith("node:") ? objectForContent("node", record.reply_id.slice(5)) : objectForContent("reply", record.reply_id);
    if (!object) return;
    const content = object.content;
    if (content.type === "block") return record.reply_id === object.id && record.block_id === content.block.id ? object : undefined;
    if (!isLegacyContent(content)) return undefined;
    if (content.type === "node") return record.reply_id === `node:${content.id}` && record.source_id === record.reply_id ? object : undefined;
    return board?.replies?.some(reply => reply.id === content.id && reply.id === record.reply_id && reply.source_id === record.source_id) ? object : undefined;
  }

  /* ---------- presentation state ---------- */
  const currentPlacement = (frame: Frame) => dirty.get(frame.object.id) ?? groupLocal.get(frame.object.id) ?? frame.placement;
  const shapeKey = (p?: CanvasPlacement) => p ? contentKey({ ...p, revision: 0, user_modified: p.user_modified ?? false }) : "";
  function placement(cell: Node): CanvasPlacement {
    const frame = frames.get(cell.id); const base = frame ? currentPlacement(frame) : undefined;
    return { item_id: cell.id, revision: frame?.placement.revision ?? 0, z: base?.z ?? 0, removed: false, appearance: base?.appearance ?? "plain", user_modified: base?.user_modified, ...cell.getPosition(), ...cell.getSize() };
  }
  function applyAppearance(frame: Frame, p: CanvasPlacement) {
    frame.root.classList.toggle("is-card", p.appearance === "card");
    frame.root.classList.toggle("is-plain", p.appearance !== "card");
    frame.root.classList.toggle("is-idea-note", frame.object.content.type === "node");
    frame.root.classList.toggle("is-structured-atom", frame.object.content.type === "block");
    if (frame.cell.getZIndex() !== p.z) frame.cell.setZIndex(p.z, { remote: true });
    if (selectedObjectIds().includes(frame.object.id)) paintSelectionTools();
  }

  const reader = element("dialog", "board-dialog canvas-reader");
  const readerHead = element("header"); const readerTitle = element("h2");
  const readerSource = element("small", "canvas-frame-source");
  const readerClose = button(ct("close"), () => reader.close());
  readerHead.append(readerTitle, readerSource, readerClose); reader.append(readerHead); document.body.append(reader);
  reader.addEventListener("close", () => {
    const content = reader.querySelector<HTMLElement>(".canvas-frame-content");
    const frame = readingKey ? frames.get(readingKey) : null;
    if (content && frame) { content.inert = true; frame.native?.setActive(false); frame.root.insertBefore(content, frame.root.querySelector(".canvas-card-drag")); } else content?.remove();
    readingKey = null;
  });
  /** The reader stays as an optional expanded view; in-place activation is the primary way to work with content. */
  function openReader(key: string) {
    const frame = frames.get(key); if (!frame || reader.open) return;
    deactivate(false); choose(key, false, true); readingKey = key; readerTitle.textContent = frame.title.textContent;
    readerSource.textContent = frame.source.textContent;
    frame.content.inert = false; frame.native?.setActive(true); reader.append(frame.content); reader.showModal();
  }
  const fail = (error: unknown) => handlers.onError?.(error instanceof Error ? error.message : String(error));
  function worldBox(cells: Node[]) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const cell of cells) {
      const position = cell.getPosition(), size = cell.getSize();
      x1 = Math.min(x1, position.x); y1 = Math.min(y1, position.y);
      x2 = Math.max(x2, position.x + size.width); y2 = Math.max(y2, position.y + size.height);
    }
    if (!Number.isFinite(x1)) return null;
    return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
  }
  function showWorld(area: { x: number; y: number; width: number; height: number }, minScale: number, maxScale: number) {
    const box = usableBox();
    graph.resize(box.width, box.height);
    const scale = Math.max(minScale, Math.min(maxScale, (box.usableWidth - FIT_PAD * 2) / area.width, (box.usableHeight - FIT_PAD * 2) / area.height));
    graph.zoomTo(scale);
    graph.translate(box.left + box.usableWidth / 2 - (area.x + area.width / 2) * scale, box.top + box.usableHeight / 2 - (area.y + area.height / 2) * scale);
  }
  const fit = () => {
    const area = worldBox([...frames.values()].filter(frame => visibleFrames.has(frame.object.id)).map(frame => frame.cell));
    if (area && usableBox().height > 0) showWorld(area, 0.01, 1);
  };
  function focus(key: string, fromUser = false) {
    const frame = frames.get(key); if (!frame) return;
    if (!visibleFrames.has(key) && board) {
      const origin = originForObject(frame.object, board, overviewMeta.bindings);
      changeScope(origin.workspaceKey, "all", false);
    }
    choose(key, false, fromUser);
    const size = frame.cell.getSize(), position = frame.cell.getPosition();
    showWorld({ x: position.x, y: position.y, width: size.width, height: size.height }, 0.2, 1);
  }
  function focusSelection() {
    const cells = selectedObjectIds().map(id => frames.get(id)?.cell).filter((cell): cell is Node => Boolean(cell));
    const area = worldBox(cells); if (!area) return;
    showWorld(area, 0.01, 1);
  }
  function persistView() {
    const box = usableBox();
    if (!viewReady || destroyed || !box.width || !box.height) return;
    const scale = graph.zoom(), { tx, ty } = graph.translate();
    try { localStorage.setItem(viewStorageKey(), JSON.stringify({ scale, x: (box.left + box.usableWidth / 2 - tx) / scale, y: (box.top + box.usableHeight / 2 - ty) / scale })); } catch { /* Navigation remains usable without local storage. */ }
  }
  function rememberView() { window.clearTimeout(viewTimer); viewTimer = window.setTimeout(persistView, 120); }
  function frameWorldBoxes() {
    return [...frames.values()].filter(frame => visibleFrames.has(frame.object.id)).map((frame) => {
      const position = frame.cell.getPosition(), size = frame.cell.getSize();
      return { x: position.x, y: position.y, width: size.width, height: size.height };
    });
  }
  function restoreView() {
    try {
      const saved = JSON.parse(localStorage.getItem(viewStorageKey()) ?? localStorage.getItem("spellcast.canvas-view") ?? "null");
      if (!saved || !savedViewIsPlausible(saved)) return false;
      const box = usableBox();
      if (!viewportIsUsable(box.usableWidth, box.usableHeight) || box.height < 32) return false;
      graph.resize(box.width, box.height);
      graph.zoomTo(saved.scale);
      graph.translate(box.left + box.usableWidth / 2 - saved.x * saved.scale, box.top + box.usableHeight / 2 - saved.y * saved.scale);
      if (viewShouldRecover(saved, frameWorldBoxes(), box.usableWidth, box.usableHeight)) fit();
      return true;
    } catch { return false; }
  }
  function applyInitialView() {
    if (destroyed || initialView || !frames.size) return false;
    const box = graphBox();
    if (!box.width || box.height < 32) return false;
    initialView = true;
    viewWidth = box.width; viewHeight = box.height;
    graph.resize(box.width, box.height);
    const candidates = locateIntent.kind === "auto" ? [...visibleFrames] : [...frames.keys()];
    const key = initialFocusKey(locateIntent, candidates, candidates.at(-1));
    if (locateIntent.kind === "auto") {
      if (!restoreView() && key) focus(key);
    } else if (key) {
      focus(key);
    } else {
      choose(null);
    }
    viewReady = true; rememberView();
    return true;
  }
  function tidy() {
    const cards = [...frames.values()].filter(frame => visibleFrames.has(frame.object.id)); if (!cards.length) return;
    const columns = Math.ceil(Math.sqrt(cards.length));
    const width = Math.max(...cards.map(f => f.cell.getSize().width)) + 64;
    const height = Math.max(...cards.map(f => f.cell.getSize().height)) + 64;
    graph.model.startBatch("layout");
    try { cards.forEach((frame, i) => frame.cell.position(48 + (i % columns) * width, 48 + Math.floor(i / columns) * height)); }
    finally { graph.model.stopBatch("layout"); }
    for (const frame of cards) if (dirty.has(frame.cell.id)) mark(frame.cell);
    focus(cards[0].cell.id, true);
  }

  /* ---------- selection vs. activation ---------- */
  function choose(key: string | null, additive = false, fromUser = false) {
    if (key && isComposition(key) && compositionMembers(key).some(id => frames.has(id) && !visibleFrames.has(id))) {
      // An explicitly chosen whole idea must not silently send only its visible members.
      scopeWorkspace = "all"; scopeTask = "all"; applyScope();
    }
    if (key === null) { selectedUnits.clear(); selection = null; }
    else if (additive) {
      if (selectedUnits.has(key)) selectedUnits.delete(key); else selectedUnits.add(key);
      selection = selectedUnits.has(key) ? key : [...selectedUnits].at(-1) ?? null;
    } else { selectedUnits.clear(); selectedUnits.add(key); selection = key; }
    if (fromUser) {
      locateIntent = key ? { kind: "object", id: key } : { kind: "none" };
      handlers.onHumanSelect?.();
    }
    if (active && !selectedObjectIds().includes(active)) deactivate(false);
    const visual = new Set(selectedObjectIds());
    for (const [id, frame] of frames) frame.root.classList.toggle("is-selected", visual.has(id));
    paintSelectionTools();
    hostFocus();
    handlers.onSelect(getSelection());
  }
  function anchorFor(object: CanvasObject, frame?: Frame): CanvasAnchor {
    const anchor: CanvasAnchor = { object_id: object.id, content_revision: object.content_revision };
    if (object.content.type === "block") return { ...anchor, block_id: object.content.block.id };
    if (isNativeCanvasContent(object.content)) {
      const region = frame?.native?.getRegion(); if (region) anchor.region = region;
      if (object.bindings?.length) anchor.inputs = dataflow.snapshot(object.id);
      return anchor;
    }
    const selected = frame?.editor?.getSelection();
    if (selected?.block_id) anchor.block_id = selected.block_id;
    const block = (selected?.block_id ? frame?.reply?.blocks.find(item => item.id === selected.block_id) : undefined)
      ?? frame?.reply?.blocks.find(item => item.type === "artifact");
    if (block?.type === "artifact") { anchor.block_id ??= block.id; anchor.artifact = frame?.editor?.getArtifactAnchor() ?? { bundle_id: block.bundle_id, state_revision: block.state_revision, state: block.state }; }
    if (block?.type === "artifact") anchor.inputs = dataflow.snapshot(object.id, block.id);
    return anchor;
  }
  function getSelection(): CanvasSelection | null {
    const object_ids = selectedObjectIds(); if (!object_ids.length) return null;
    const frame = primaryFrame(); const object = frame?.object ?? objectById(object_ids[0]); if (!object) return null;
    const inner: CanvasSelection = object.content.type === "block" ? { block_id: object.content.block.id } : frame?.note ? { node_id: frame.note.id }
      : frame?.editor?.getSelection() ?? (frame?.reply ? { reply_id: frame.reply.id } : {});
    return { object_id: object.id, object_ids, ...(selection && isComposition(selection) && selectedUnits.size === 1 ? { composition_id: selection } : {}), anchors: object_ids.map(id => {
      const selected = frames.get(id), anchor = anchorFor(selected?.object ?? objectById(id)!, selected);
      const compositions = compositionDependencies().filter(group => compositionContains(group, id)).map(group => ({ id: group, revision: compositionById(group)!.revision }));
      return { ...anchor, ...(compositions.length ? { compositions } : {}) };
    }), ...inner };
  }
  /** Activation hands input to the content in place; the host keeps selection and the way back. */
  function activate(key: string) {
    const frame = frames.get(key); if (!frame || reader.open) return;
    if (active !== key) {
      deactivate(false); choose(key, false, true);
      active = key; frame.root.classList.add("is-active"); frame.content.inert = false; frame.native?.setActive(true);
    }
    const target = frame.content.querySelector<HTMLElement>("input, textarea, select, iframe, button:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? frame.content;
    target.focus({ preventScroll: true });
    paintMode();
  }
  function deactivate(refocus = true) {
    const frame = active ? frames.get(active) : null; active = null;
    if (frame) {
      frame.root.classList.remove("is-active");
      if (readingKey !== frame.object.id) frame.content.inert = true;
      frame.native?.setActive(false);
      if (refocus) graphHost.focus({ preventScroll: true });
    }
    paintMode();
  }
  function paintMode() {
    root.classList.toggle("has-active", Boolean(active));
    const modeLabel = ct(active ? "done" : "activate");
    workButton.textContent = modeLabel; workButton.title = modeLabel; workButton.setAttribute("aria-label", modeLabel);
    workButton.setAttribute("aria-pressed", String(Boolean(active))); workButton.disabled = !primaryFrame();
    for (const [id, frame] of frames) {
      const on = id === active; const label = ct(on ? "done" : "activate");
      frame.activateButton.textContent = label; frame.activateButton.title = label; frame.activateButton.setAttribute("aria-label", label);
      frame.activateButton.setAttribute("aria-pressed", String(on));
    }
    navigationHelp.textContent = ct(active ? "activeHelp" : "navigationHelp");
    placeSelectionTools();
  }

  /* ---------- removal and restore of presentations (content is never deleted here) ---------- */
  function compositionDependencies() {
    const ids = new Set<string>();
    const visit = (id: string) => {
      const composition = compositionById(id); if (!composition || ids.has(id)) return;
      ids.add(id); composition.members.forEach(member => visit(member));
    };
    selectedUnits.forEach(visit); return [...ids];
  }
  function moveSet(key: string) {
    const members = selectedObjectIds();
    return members.length > 1 && members.includes(key) ? { members, compositions: compositionDependencies() } : null;
  }
  function currentRead(kind: CanvasRead["kind"], id: string): CanvasRead | null {
    if (kind === "content") { const object = objectById(id); return object ? { kind, id, revision: object.content_revision } : null; }
    if (kind === "presentation") { const item = savedLayout.items.find(entry => entry.item_id === id); return item ? { kind, id, revision: item.revision } : null; }
    const composition = compositionById(id); return composition ? { kind, id, revision: composition.revision } : null;
  }
  function queueGroupMove(key: string) {
    const move = moveSet(key); const moved = frames.get(key); if (!move || !moved) return false;
    const before = currentPlacement(moved), after = placement(moved.cell);
    const dx = after.x - before.x, dy = after.y - before.y; if (!dx && !dy) return true;
    for (const id of move.members) {
      const frame = frames.get(id); if (!frame) continue;
      const base = currentPlacement(frame), next = { ...base, x: base.x + dx, y: base.y + dy };
      groupLocal.set(id, next);
      if (id !== key) frame.cell.position(next.x, next.y);
    }
    const positions = new Map(move.members.map(id => [id, { ...groupLocal.get(id)! }]));
    groupMove = { positions, request: { request_id: crypto.randomUUID(),
      reads: [...move.compositions.map(id => currentRead("composition", id)), ...move.members.map(id => currentRead("presentation", id))].filter((read): read is CanvasRead => Boolean(read)),
      operations: move.members.map(id => ({ op: "place", id, expected_revision: frames.get(id)!.placement.revision, fields: { x: positions.get(id)!.x, y: positions.get(id)!.y } })),
    } };
    layoutMessage = "layoutSaving"; paintStatus(); window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void saveGroupMove(); }, 220);
    return true;
  }
  async function persistGroupMove() {
    const move = groupMove; if (!move) return;
    groupMove = null;
    const positions = move.positions;
    try {
      const snapshot = await handlers.onBatch(move.request);
      for (const [id, position] of positions) if (contentKey(groupLocal.get(id)) === contentKey(position)) groupLocal.delete(id);
      update(snapshot); layoutMessage = groupLocal.size || groupMove ? "layoutSaving" : "layoutSaved";
    } catch (error) {
      // Keep local positions for explicit retry; a failed batch must not snap members back independently.
      if (!groupMove) groupMove = move;
      try { update(await handlers.onReload()); } catch { /* A disconnected bridge cannot provide the pending proposal. */ }
      layoutMessage = "layoutFailed"; fail(error);
    } finally { paintStatus(); }
  }
  function saveGroupMove(): Promise<void> {
    if (!groupMove) return groupSaving ?? Promise.resolve();
    if (groupSaving) return groupSaving;
    groupSaving = persistGroupMove().finally(() => { groupSaving = null; if (groupMove && layoutMessage !== "layoutFailed") void saveGroupMove(); });
    return groupSaving;
  }
  async function flushLayout() {
    window.clearTimeout(saveTimer);
    if (saving) await saving;
    if (groupSaving) await groupSaving;
    if (groupMove && layoutMessage !== "layoutFailed") await saveGroupMove();
    if (dirty.size && layoutMessage !== "layoutFailed") await saveLayout();
  }
  async function removeSelection() {
    const frame = primaryFrame(), key = frame?.object.id ?? null;
    if (!key || !frame || deleting || active === key) return;
    const ids = selectedObjectIds();
    deleting = true;
    try {
      if (ids.some(id => frames.get(id)?.native?.hasUnpersistedDraft)) throw new Error(ct("draftUnsafe"));
      if (ids.some(id => dirty.has(id) || groupLocal.has(id))) {
        await flushLayout();
        if (ids.some(id => dirty.has(id) || groupLocal.has(id))) throw new Error(ct("layoutFailed"));
      }
      const held = frames.get(key); if (!held) return;
      if (ids.length === 1 && !compositionDependencies().length) update(await handlers.onDelete(key, held.placement.revision));
      else update(await handlers.onBatch({ request_id: crypto.randomUUID(), reads: compositionDependencies().map(id => currentRead("composition", id)!).filter(Boolean),
        operations: ids.map(id => ({ op: "place", id, expected_revision: frames.get(id)!.placement.revision, fields: { removed: true } })) }));
    } catch (error) { try { update(await handlers.onReload()); } catch { /* Keep the presentation when removal cannot be confirmed. */ } fail(error); }
    finally { deleting = false; paintStatus(); }
  }
  async function restoreItem(key: string): Promise<boolean> {
    const entry = removedEntries.find(item => item.object.id === key);
    if (!entry || restoring) return false;
    restoring = true;
    try {
      update(await handlers.onRestore(key, entry.placement.revision));
      const held = frames.get(key); if (!held) return false;
      mountHtml(held.cell, held.root, held.native);
      requestAnimationFrame(() => {
        if (destroyed) return;
        const current = frames.get(key);
        if (current && current.root === held.root && current.cell === held.cell) mountHtml(current.cell, current.root, current.native);
      });
      focus(key, true); return true;
    } catch (error) { try { update(await handlers.onReload()); } catch { /* The removed list keeps its entry until a reload confirms otherwise. */ } fail(error); return false; }
    finally { restoring = false; }
  }

  /* ---------- layout persistence with per-presentation revisions ---------- */
  function mark(cell: Node) {
    dirty.set(cell.id, placement(cell)); layoutMessage = "layoutSaving"; paintStatus();
    window.clearTimeout(saveTimer); saveTimer = window.setTimeout(() => void saveLayout(), 350);
  }
  function paintStatus() { status.textContent = layoutMessage ? ct(layoutMessage) : ""; retry.hidden = layoutMessage !== "layoutFailed"; undo.disabled = !history.canUndo(); redo.disabled = !history.canRedo(); }
  function saveLayout(): Promise<void> {
    if (destroyed || !dirty.size) return Promise.resolve();
    if (saving) return saving;
    saving = persistLayout().finally(() => {
      saving = null;
      if (!destroyed) { paintStatus(); if (dirty.size && layoutMessage !== "layoutFailed") void saveLayout(); }
    });
    return saving;
  }
  async function persistLayout() {
    // Each item carries the revision of the presentation it was derived from; there is no board-wide lock.
    const batch = [...dirty.values()].slice(0, 64).map(item => ({ ...item, revision: frames.get(item.item_id)?.placement.revision ?? item.revision, removed: false }));
    try {
      const result = await handlers.onLayout(undefined, batch);
      if (destroyed) return;
      // Only the confirmed shape leaves the dirty set; later edits stay and use the confirmed revision.
      for (const item of batch) if (shapeKey(dirty.get(item.item_id)) === shapeKey(item)) dirty.delete(item.item_id);
      if (board) update({ ...board, canvas: result }); else adoptLayout(result);
      layoutMessage = dirty.size ? "layoutSaving" : "layoutSaved";
    } catch (error) {
      if (destroyed) return;
      // Keep the local placement through a conflict; a visible Retry uses the refreshed presentation revisions.
      try { update(await handlers.onReload()); } catch { /* A disconnected bridge cannot provide newer revisions. */ }
      layoutMessage = "layoutFailed"; fail(error);
    }
  }
  function adoptLayout(layout: CanvasLayout) {
    if (layout.revision < revision) return;
    revision = layout.revision;
    savedLayout = { ...savedLayout, ...layout, compositions: layout.compositions ?? savedLayout.compositions ?? [], proposals: layout.proposals ?? savedLayout.proposals ?? [] };
    for (const frame of frames.values()) { const p = layout.items.find(item => item.item_id === frame.object.id); if (p) frame.placement = p; }
  }
  const zoomOut = button("−", () => graph.zoom(-0.15), ct("zoomOut"));
  const zoomIn = button("+", () => graph.zoom(0.15), ct("zoomIn"));
  const actual = button("100%", () => { graph.zoomTo(1); rememberView(); }, ct("actualSize"));
  graph.on("scale", ({ sx }) => { actual.textContent = `${Math.round(sx * 100)}%`; rememberView(); });
  graph.on("translate", rememberView);
  const fitButton = button(ct("fit"), fit);
  const overviewButton = button(ct("overview"), () => { paintOverview(); overview.showModal(); });
  const tidyButton = button(ct("arrange"), tidy);
  const handButton = button(ct("pan"), () => { hand = !hand; paintPan(); });
  const workButton = button(ct("activate"), () => { const frame = primaryFrame(); if (active) deactivate(); else if (frame) activate(frame.object.id); });
  const focusButton = button(ct("focusSelection"), () => focusSelection(), ct("focusSelectionHint"));
  function paintPan() { root.classList.toggle("is-panning", panning()); handButton.setAttribute("aria-pressed", String(hand)); }
  /** z and appearance are presentation fields saved through the same layout path. */
  function restyle(patch: Partial<Pick<CanvasPlacement, "z" | "appearance">>) {
    const frame = primaryFrame(); if (!frame) return;
    const next = { ...placement(frame.cell), ...patch };
    dirty.set(frame.object.id, next); applyAppearance(frame, next); mark(frame.cell);
  }
  const zValues = () => [...frames.values()].map(frame => currentPlacement(frame).z);
  const frontButton = button(ct("toFront"), () => restyle({ z: Math.max(0, ...zValues()) + 1 }));
  const backButton = button(ct("toBack"), () => restyle({ z: Math.min(0, ...zValues()) - 1 }));
  const cardButton = button(ct("cardStyle"), () => { const frame = primaryFrame(); if (frame) restyle({ appearance: currentPlacement(frame).appearance === "card" ? "plain" : "card" }); });
  function compositionContains(id: string, member: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false; seen.add(id);
    const composition = compositionById(id); return Boolean(composition?.members.some(item => item === member || compositionContains(item, member, seen)));
  }
  function composeMembers() {
    const units = [...selectedUnits];
    return units.filter(unit => !units.some(other => other !== unit && isComposition(other) && compositionContains(other, unit)));
  }
  function readsForUnit(unit: string): CanvasRead[] {
    if (isComposition(unit)) { const read = currentRead("composition", unit); return read ? [read] : []; }
    return (["content", "presentation"] as const).map(kind => currentRead(kind, unit)).filter((read): read is CanvasRead => Boolean(read));
  }
  function uniqueReads(reads: CanvasRead[]) {
    return [...new Map(reads.map(read => [`${read.kind}:${read.id}`, read])).values()];
  }
  async function runBatch(request: CanvasBatchRequest) {
    try { update(await handlers.onBatch(request)); }
    catch (error) { try { update(await handlers.onReload()); } catch { /* The server result may be unavailable while local selection remains usable. */ } fail(error); }
  }
  async function composeSelected() {
    const members = composeMembers(); if (members.length < 2) return;
    const draftKey = `spellcast.idea-new:${JSON.stringify([...members].sort())}`;
    let pending: string | null = null;
    try { pending = localStorage.getItem(draftKey); } catch { /* The dialog still supports in-window edits. */ }
    ideaId = pending && /^[0-9a-f-]{36}$/.test(pending) ? pending : crypto.randomUUID();
    try { localStorage.setItem(draftKey, ideaId); } catch { /* The draft dialog reports storage failures. */ }
    ideaMembers = members; ideaEditor.show(ideaInput());
  }
  let ideaId = "", ideaMembers: string[] = [];
  function ideaInput() {
    const group = compositionById(ideaId);
    const members = group?.members || ideaMembers;
    const candidates: IdeaMember[] = [];
    for (const object of savedLayout.objects) {
      const parent = savedLayout.compositions?.find(c => c.members.includes(object.id));
      if (parent && parent.id !== ideaId && !members.includes(object.id)) continue;
      if (!visibleFrames.has(object.id) && !members.includes(object.id)) continue;
      const frame = frames.get(object.id);
      candidates.push({ id: object.id, title: frame?.title.textContent || object.id, detail: frame?.provenance.textContent || ct("overviewUnsorted"), reads: readsForUnit(object.id) });
    }
    for (const composition of savedLayout.compositions || []) {
      if (composition.id === ideaId || compositionContains(composition.id, ideaId)) continue;
      const parent = savedLayout.compositions?.find(c => c.members.includes(composition.id));
      if (parent && parent.id !== ideaId && !members.includes(composition.id)) continue;
      if (!compositionMembers(composition.id).some(id => visibleFrames.has(id)) && !members.includes(composition.id)) continue;
      candidates.push({ id: composition.id, title: composition.title || ct("groupTitle"), detail: ct("layerMembers", { n: composition.members.length }), reads: readsForUnit(composition.id) });
    }
    return { id: ideaId, group, members, candidates };
  }
  const ideaEditor = canvasIdea(async request => {
    update(await handlers.onBatch(request));
    if (compositionById(ideaId)) choose(ideaId, false, true);
  }, async () => { update(await handlers.onReload()); return ideaInput(); });
  const ideaButton = button(ct("ideaEdit"), () => {
    if (!selection || !isComposition(selection)) return;
    ideaId = selection; ideaMembers = [...compositionById(selection)!.members]; ideaEditor.show(ideaInput());
  });
  async function ungroupSelected() {
    const id = selection; if (!id || !isComposition(id)) return;
    const composition = compositionById(id); if (!composition) return;
    const parent = savedLayout.compositions?.find(group => group.members.includes(id));
    await runBatch({ request_id: crypto.randomUUID(), reads: [{ kind: "composition", id, revision: composition.revision }, ...(parent ? [{ kind: "composition" as const, id: parent.id, revision: parent.revision }] : [])],
      operations: [{ op: "ungroup", id, expected_revision: composition.revision }] });
  }
  const groupButton = button(ct("group"), () => { void composeSelected(); });
  const ungroupButton = button(ct("ungroup"), () => { void ungroupSelected(); });
  const connections = canvasConnections(async request => {
    try { update(await handlers.onBatch(request)); }
    catch (error) { try { update(await handlers.onReload()); } catch { /* Keep the reviewed connection request while disconnected. */ } throw error; }
  });
  const connectionsButton = button(ct("dataConnections"), () => { const frame = primaryFrame(); if (frame && board) void connections.show(board, frame.object.id); });
  function paintSelectionTools() {
    const frame = primaryFrame();
    for (const node of [frontButton, backButton, cardButton]) node.disabled = !frame;
    groupButton.disabled = composeMembers().length < 2;
    ungroupButton.disabled = !selection || !isComposition(selection);
    ideaButton.hidden = !selection || !isComposition(selection);
    workButton.disabled = !frame;
    focusButton.disabled = !selectedObjectIds().length;
    connectionsButton.disabled = !frame || (frame.object.content.type !== "text" && !frame.reply?.blocks.some(block => block.type === "artifact"));
    cardButton.setAttribute("aria-pressed", String(frame ? currentPlacement(frame).appearance === "card" : false));
    placeSelectionTools();
  }
  function moveSelected(event: KeyboardEvent, frame: Frame) {
    const step = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!step) return false; event.preventDefault();
    const cell = frame.cell; const pos = cell.getPosition(); const size = cell.getSize();
    if (event.shiftKey) { cell.resize(Math.min(MAX_SIZE, Math.max(MIN_SIZE, size.width + step[0])), Math.min(MAX_SIZE, Math.max(MIN_SIZE, size.height + step[1]))); mark(cell); }
    else {
      graph.model.startBatch("layout");
      try { cell.position(pos.x + step[0], pos.y + step[1]); if (!queueGroupMove(frame.object.id)) mark(cell); }
      finally { graph.model.stopBatch("layout"); }
    }
    return true;
  }
  function keyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || event.isComposing || !root.getClientRects().length || document.querySelector("dialog[open]")) return;
    const moreMenu = root.querySelector<HTMLDetailsElement>(".canvas-tool-more");
    if (event.key === "Escape" && moreMenu?.open) {
      event.preventDefault(); moreMenu.open = false;
      moreMenu.querySelector("summary")?.focus();
      return;
    }
    const activeFrame = active ? frames.get(active) : null;
    const modifier = event.ctrlKey || event.metaKey || event.altKey;
    // Activated content owns its keys (Delete, Backspace, WASD, Space…). Escape is the only host key while inside;
    // a focused iframe never delivers it here, which is why every frame also has a visible "done" button.
    if (activeFrame && target && activeFrame.content.contains(target)) {
      if (event.key === "Escape" && !modifier) { event.preventDefault(); deactivate(); }
      return;
    }
    if (modifier || target?.closest("input, textarea, select, [role=textbox]") || target?.isContentEditable) return;
    const frame = primaryFrame();
    const onHost = target === graphHost || Boolean(frame && target === frame.head);
    if (event.key === "Escape") { if (active) { event.preventDefault(); deactivate(); } else if (onHost && selection) { event.preventDefault(); choose(null, false, true); } return; }
    if (event.key === "Enter" && onHost && frame) { event.preventDefault(); if (!event.repeat) activate(frame.object.id); return; }
    if (onHost && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); if (!event.repeat) void removeSelection(); return; }
    if (onHost && frame && moveSelected(event, frame)) return;
    const step = { KeyW: [0, 48], KeyA: [48, 0], KeyS: [0, -48], KeyD: [-48, 0] }[event.code];
    if (onHost && step) { event.preventDefault(); const { tx, ty } = graph.translate(); graph.translate(tx + step[0], ty + step[1]); return; }
    if (event.code !== "Space" || (target?.closest("button") && !graphHost.matches(":hover"))) return;
    event.preventDefault(); space = true; paintPan();
  }
  function keyUp(event: KeyboardEvent) { if (event.code === "Space") { space = false; paintPan(); } }
  function releasePan() { space = middle = false; if (groupHistoryOpen) { graph.model.stopBatch("layout"); groupHistoryOpen = false; } paintPan(); }
  function middleDown(event: MouseEvent) { if (event.button === 1) { event.preventDefault(); middle = true; paintPan(); } }
  function middleUp() { middle = false; paintPan(); }
  window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", releasePan);
  graphHost.addEventListener("mousedown", middleDown, true); window.addEventListener("mouseup", middleUp, true);
  window.addEventListener("pagehide", persistView);
  const undo = button(ct("undo"), () => history.undo());
  const redo = button(ct("redo"), () => history.redo());
  let insertPending: { content: string; request: CanvasBatchRequest; id: string } | undefined;
  const insert = canvasInsert(async (content: CanvasContent) => {
    // The dialog regenerates placeholder IDs on a retry; that is still the same insert.
    const encoded = JSON.stringify(content, (key, value) => key === "id" ? undefined : value);
    if (!insertPending || insertPending.content !== encoded) {
      const id = crypto.randomUUID(), box = usableBox(), { tx, ty } = graph.translate(), scale = graph.zoom();
      const width = content.type === "block" ? 600 : 380, height = content.type === "block" ? 420 : 280;
      const center = { x: (box.left + box.usableWidth / 2 - tx) / scale - width / 2, y: (box.top + box.usableHeight / 2 - ty) / scale - height / 2 };
      const occupied = [...frames.values()].filter(frame => visibleFrames.has(frame.object.id)).map(currentPlacement);
      let position = center;
      for (let index = 0; index < 4096; index++) {
        position = { x: center.x + index % 8 * (width + 48), y: center.y + Math.floor(index / 8) * (height + 48) };
        if (!occupied.some(item => position.x < item.x + item.width + 24 && position.x + width + 24 > item.x && position.y < item.y + item.height + 24 && position.y + height + 24 > item.y)) break;
      }
      const scoped = scopeWorkspace !== "all" && board && savedLayout.objects.map(object => ({ object, origin: originForObject(object, board!, overviewMeta.bindings) })).find(({ origin }) => originMatches(origin, scopeWorkspace, scopeTask));
      const task = scopeTask !== "all" ? overviewMeta.bindings.find(binding => `thread:${binding.thread_id}` === scopeTask || `source:${binding.source_id}` === scopeTask) : undefined;
      const origin = scoped && scoped.origin.cwd ? { cwd: scoped.origin.cwd, ...(task ? { thread_id: task.thread_id, source_id: task.source_id, label: task.label || "" } : {}) } : undefined;
      insertPending = { content: encoded, id, request: { request_id: crypto.randomUUID(), reads: [], operations: [{ op: "create", id, content,
        ...(origin ? { origin } : {}),
        placement: { ...position, width, height, appearance: "plain" } }] } };
    }
    const held = insertPending;
    update(await handlers.onBatch(held.request)); insertPending = undefined;
    focus(held.id, true);
  });
  const add = button(ct("addComponent"), () => insert.show());
  add.classList.add("canvas-tool-icon");
  const retry = button(ct("retry"), () => { layoutMessage = "layoutSaving"; void (groupMove ? saveGroupMove() : saveLayout()); }); retry.hidden = true;
  const draftsButton = button(ct("drafts"), () => { paintDrafts(); drafts.showModal(); });
  const removedButton = button(ct("removed"), () => { paintRemovedList(); removedDialog.showModal(); });
  const layersButton = button(ct("layers"), () => { paintLayers(); layers.showModal(); });
  const proposalsButton = button(ct("proposals"), () => { reviewedProposals.clear(); paintProposals(); proposals.showModal(); void refreshProposals(); });
  const jump = element("select", "canvas-jump"); jump.setAttribute("aria-label", ct("openItem"));
  jump.addEventListener("change", () => { const key = jump.value; jump.value = ""; if (key) openReader(key); });
  const toolGroup = (...nodes: HTMLElement[]) => { const wrap = element("div", "canvas-tool-group"); wrap.append(...nodes); return wrap; };
  const more = element("details", "canvas-tool-more");
  const moreSummary = element("summary"); moreSummary.textContent = ct("more"); moreSummary.setAttribute("aria-label", ct("moreMenu"));
  const moreMenu = element("div", "canvas-tool-menu");
  let showLegacyEdges = false;
  try { showLegacyEdges = localStorage.getItem("spellcast.canvas-legacy-edges") === "1"; } catch { /* View preference is optional. */ }
  const legacyEdgesButton = button(ct("showLegacyEdges"), () => {
    showLegacyEdges = !showLegacyEdges;
    try { localStorage.setItem("spellcast.canvas-legacy-edges", showLegacyEdges ? "1" : "0"); } catch { /* The toggle still applies in this session. */ }
    edgeKey = "";
    if (board) update(board);
    paintLegacyEdges();
  });
  moreMenu.append(jump, groupButton, ungroupButton, proposalsButton, tidyButton, undo, redo, frontButton, backButton, cardButton, draftsButton, removedButton, legacyEdgesButton);
  more.append(moreSummary, moreMenu);
  function paintLegacyEdges() {
    const hasLegacy = (board?.edges ?? []).some((edge) => (edge.relation ?? "unconfirmed") !== "parent");
    legacyEdgesButton.hidden = !hasLegacy;
    legacyEdgesButton.setAttribute("aria-pressed", String(showLegacyEdges && hasLegacy));
    legacyEdgesButton.textContent = ct(showLegacyEdges ? "hideLegacyEdges" : "showLegacyEdges");
    legacyEdgesButton.title = ct("showLegacyEdges");
    legacyEdgesButton.setAttribute("aria-label", ct("showLegacyEdges"));
  }
  paintLegacyEdges();
  function placeMore() {
    const rootBox = root.getBoundingClientRect(), summaryBox = moreSummary.getBoundingClientRect();
    moreMenu.style.maxHeight = `${Math.max(120, Math.floor(rootBox.bottom - summaryBox.bottom - 8))}px`;
  }
  more.addEventListener("toggle", () => {
    moreSummary.setAttribute("aria-expanded", String(more.open));
    if (more.open) placeMore();
  });
  moreMenu.addEventListener("click", event => { if ((event.target as HTMLElement | null)?.closest("button")) more.open = false; });
  const closeMore = (event: PointerEvent) => {
    const target = event.target;
    if (more.open && target instanceof Element && !more.contains(target)) more.open = false;
  };
  window.addEventListener("pointerdown", closeMore, true);
  actual.classList.add("canvas-zoom-value");
  workButton.classList.add("canvas-tool-primary");
  const rail = toolGroup(add, overviewButton, layersButton, handButton, more);
  rail.classList.add("canvas-tool-rail");
  const selectionTitle = element("span", "canvas-tool-selection-title");
  const selectionDock = toolGroup(selectionTitle, ideaButton, workButton, connectionsButton, focusButton);
  selectionDock.classList.add("canvas-tool-selection");
  const camera = toolGroup(fitButton, zoomOut, actual, zoomIn);
  camera.classList.add("canvas-tool-camera");
  function placeSelectionTools() {
    const ids = selectedObjectIds();
    selectionDock.hidden = !ids.length;
    const frame = primaryFrame();
    const composition = selection ? compositionById(selection) : undefined;
    selectionTitle.textContent = composition?.title
      || frame?.title.textContent
      || (ids.length > 1 ? String(ids.length) : "");
  }
  const icon = (path: string) => `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">${path}</svg>`;
  const iconButtons = new Map<HTMLElement, string>([
    [add, icon('<path d="M9 3.5 V14.5 M3.5 9 H14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>')],
    [overviewButton, icon('<rect x="3.2" y="3.2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="9.8" y="3.2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="3.2" y="9.8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="9.8" y="9.8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.6"/>')],
    [layersButton, icon('<path d="M3 12.2 L9 15.2 L15 12.2 M3 9 L9 12 L15 9 M3 5.8 L9 8.8 L15 5.8 L9 2.8 Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>')],
    [handButton, icon('<path d="M9 3.2 V14.8 M3.2 9 H14.8 M5.2 5.2 L9 3.2 L12.8 5.2 M5.2 12.8 L9 14.8 L12.8 12.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')],
    [zoomOut, icon('<path d="M3.5 9 H14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>')],
    [zoomIn, icon('<path d="M3.5 9 H14.5 M9 3.5 V14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>')],
    [moreSummary, icon('<circle cx="9" cy="4.5" r="1.2" fill="currentColor"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor"/>')],
  ]);
  function paintIcons() {
    for (const [node, svg] of iconButtons) { node.classList.add("canvas-tool-icon"); node.innerHTML = svg; }
  }
  camera.append(retry);
  toolbar.append(rail, selectionDock, camera, status, navigationHelp);
  paintIcons();
  placeSelectionTools();
  window.addEventListener("resize", placeSelectionTools);
  graph.on("node:move", ({ node }) => { if (moveSet(node.id)) { graph.model.startBatch("layout"); groupHistoryOpen = true; } });
  graph.on("node:moved", ({ node }) => {
    if (!queueGroupMove(node.id)) mark(node);
    if (groupHistoryOpen) { graph.model.stopBatch("layout"); groupHistoryOpen = false; }
  });
  graph.on("node:resized", ({ node }) => mark(node));
  for (const name of ["node:change:position", "node:change:size"] as const) graph.on(name, ({ node, options }: { node: Node; options: { remote?: boolean } }) => {
    if (!options.remote && (name !== "node:change:position" || !moveSet(node.id))) dirty.set(node.id, placement(node));
  });
  history.on("undo", () => { for (const frame of frames.values()) if (dirty.has(frame.cell.id) || shapeKey(placement(frame.cell)) !== shapeKey(frame.placement)) mark(frame.cell); paintStatus(); });
  history.on("redo", () => { for (const frame of frames.values()) mark(frame.cell); paintStatus(); });
  history.on("change", paintStatus);
  graph.on("blank:click", () => choose(null, false, true));
  graph.on("node:click", ({ node, e }: { node: Node; e?: MouseEvent }) => choose(node.id, Boolean(e?.shiftKey), true));
  graph.on("node:dblclick", ({ node }) => { if (!panning()) activate(node.id); });

  const overview = element("dialog", "board-dialog canvas-overview");
  const overviewHead = element("header"), overviewTitle = element("h2"), overviewHelp = element("p");
  const overviewClose = button(ct("close"), () => overview.close());
  const overviewTools = element("div", "canvas-overview-tools");
  const overviewSearch = document.createElement("input"); overviewSearch.type = "search"; overviewSearch.id = "canvas-overview-search";
  const overviewProject = document.createElement("select"); overviewProject.id = "canvas-overview-project";
  const overviewGrid = element("div", "canvas-overview-grid");
  let overviewKey = "";
  let overviewMeta: { bindings: CodexBinding[] } = { bindings: [] };
  const viewStorageKey = () => `spellcast.canvas-view:${encodeURIComponent(scopeWorkspace)}:${encodeURIComponent(scopeTask)}`;
  function originText(origin: ContentOrigin) {
    return [origin.workspaceLabel || ct("overviewUnsorted"), origin.taskLabel].filter(Boolean).join(" · ");
  }
  function paintOrigin(frame: Frame) {
    if (!board) return;
    const origin = originForObject(frame.object, board, overviewMeta.bindings);
    const caption = originText(origin), detail = [origin.cwd, origin.taskLabel, origin.project].filter(Boolean).join("\n");
    frame.source.textContent = caption; frame.source.title = detail;
    frame.provenance.textContent = caption; frame.provenance.title = detail;
    frame.root.dataset.workspace = origin.workspaceKey; frame.root.dataset.task = origin.taskKey;
  }
  function applyScope() {
    if (!board) return;
    const entries = [...frames.values()].map(frame => ({ frame, origin: originForObject(frame.object, board!, overviewMeta.bindings) }));
    const workspaces = [...new Map(entries.map(({ origin }) => [origin.workspaceKey, origin])).values()].sort((a, b) => a.cwd.localeCompare(b.cwd));
    if (scopeWorkspace !== "all" && !workspaces.some(origin => origin.workspaceKey === scopeWorkspace)) {
      scopeWorkspace = workspaces.find(origin => origin.cwd)?.workspaceKey || "unsorted";
      scopeTask = "all";
    }
    const option = (value: string, text: string) => { const node = element("option", "", text); node.value = value; return node; };
    workspaceSelect.replaceChildren(option("all", ct("allWorkspaces")), ...workspaces.map(origin => option(origin.workspaceKey, origin.cwd || ct("overviewUnsorted"))));
    workspaceSelect.value = scopeWorkspace;
    const tasks = [...new Map(entries.filter(({ origin }) => scopeWorkspace === "all" || origin.workspaceKey === scopeWorkspace).map(({ origin }) => [origin.taskKey, origin])).values()];
    if (scopeTask !== "all" && !tasks.some(origin => origin.taskKey === scopeTask)) scopeTask = "all";
    taskSelect.replaceChildren(option("all", ct("allTasks")), ...tasks.map(origin => option(origin.taskKey, origin.taskLabel || ct("taskUnknown"))));
    taskSelect.value = scopeTask;
    visibleFrames.clear();
    for (const { frame, origin } of entries) {
      const visible = originMatches(origin, scopeWorkspace, scopeTask);
      if (visible) visibleFrames.add(frame.object.id);
      frame.cell.setVisible(visible, { remote: true });
      paintOrigin(frame);
    }
    for (const edge of graph.getEdges()) edge.setVisible(visibleFrames.has(edge.getSourceCellId()) && visibleFrames.has(edge.getTargetCellId()), { remote: true });
    if (active && !visibleFrames.has(active)) deactivate(false);
    if (readingKey && !visibleFrames.has(readingKey)) reader.close();
    if (selectedUnits.size && !selectedObjectIds().length) choose(null);
    empty.hidden = visibleFrames.size > 0;
    scopeBar.setAttribute("aria-label", ct("workspaceScope"));
    workspaceSelect.setAttribute("aria-label", ct("workspaceScope")); taskSelect.setAttribute("aria-label", ct("taskScope"));
    try { localStorage.setItem("spellcast.canvas-scope", JSON.stringify({ workspace: scopeWorkspace, task: scopeTask })); } catch { /* View selection remains usable. */ }
  }
  function changeScope(workspace: string, task: string, navigate = true) {
    persistView(); scopeWorkspace = workspace; scopeTask = task;
    deactivate(false); choose(null); applyScope();
    if (navigate && !restoreView()) fit();
    if (overview.open) paintOverview(); if (layers.open) paintLayers();
  }
  workspaceSelect.addEventListener("change", () => changeScope(workspaceSelect.value, "all"));
  taskSelect.addEventListener("change", () => changeScope(scopeWorkspace, taskSelect.value));
  overviewHead.append(overviewTitle, overviewClose);
  overviewTools.append(overviewSearch, overviewProject);
  overview.append(overviewHead, overviewHelp, overviewTools, overviewGrid); document.body.append(overview);
  function setOverviewMeta(meta: { bindings: CodexBinding[] }) {
    overviewMeta = { bindings: meta.bindings ?? [] };
    applyScope();
    if (overview.open) paintOverview();
  }
  function paintOverview() {
    overviewTitle.textContent = ct("overview"); overviewHelp.textContent = ct("overviewHelp");
    overviewSearch.placeholder = ct("overviewSearch");
    if (!board) return;
    const snapshot = board;
    const items = [...frames.values()].map((frame) => overviewItemFromObject(frame.object, snapshot, overviewMeta.bindings));
    const projects = [...new Map(items.map((item) => [item.project.key, item.project])).values()];
    const previous = overviewProject.value || "all";
    overviewProject.replaceChildren();
    const all = document.createElement("option"); all.value = "all"; all.textContent = ct("overviewAll"); overviewProject.append(all);
    for (const project of projects) {
      const option = document.createElement("option"); option.value = project.key;
      option.textContent = project.kind === "captured" ? ct("overviewCaptured", { label: project.label })
        : project.kind === "associated" ? ct("overviewLinked", { label: project.label })
        : ct("overviewUnsorted");
      overviewProject.append(option);
    }
    if ([...overviewProject.options].some((option) => option.value === previous)) overviewProject.value = previous;
    else overviewProject.value = "all";
    const visible = filterOverviewItems(items, overviewSearch.value, overviewProject.value);
    const nextKey = overviewPaintKey(visible, overviewSearch.value, overviewProject.value);
    if (overviewKey === nextKey) return;
    overviewKey = nextKey;
    overviewGrid.replaceChildren();
    if (!visible.length) overviewGrid.append(element("p", "", ct("overviewEmptyFilter")));
    for (const item of visible) {
      const card = element("article", "canvas-overview-card"); card.dataset.itemId = item.objectId;
      const open = button(item.title, () => { overview.close(); openReader(item.objectId); });
      open.classList.add("canvas-overview-open");
      const caption = item.project.kind === "captured" ? ct("overviewCaptured", { label: item.project.label })
        : item.project.kind === "associated" ? ct("overviewLinked", { label: item.project.label })
        : ct("overviewUnsorted");
      const metaParts = [caption, item.origin.taskLabel, item.background].filter((value, index, list) => value && list.indexOf(value) === index);
      const meta = element("small", "canvas-overview-meta", metaParts.join(" · "));
      card.append(open, meta);
      if (item.excerpt && !metaParts.includes(item.excerpt)) card.append(element("p", "canvas-overview-excerpt", item.excerpt));
      card.append(button(ct("locate"), () => { overview.close(); focus(item.objectId, true); }));
      overviewGrid.append(card);
    }
  }
  overviewSearch.addEventListener("input", () => paintOverview());
  overviewProject.addEventListener("change", () => paintOverview());

  const layers = element("dialog", "board-dialog canvas-layers");
  const layersHead = element("header"), layersTitle = element("h2"), layersHelp = element("p"), layersList = element("div", "canvas-layers-list");
  const layersClose = button(ct("close"), () => layers.close());
  layersHead.append(layersTitle, layersClose); layers.append(layersHead, layersHelp, layersList); document.body.append(layers);
  function layerPick(label: string, id: string) {
    const pick = element("button", "ghost canvas-layer-pick", label) as HTMLButtonElement;
    pick.type = "button"; pick.setAttribute("aria-pressed", String(selectedUnits.has(id)));
    pick.addEventListener("click", event => { choose(id, (event as MouseEvent).shiftKey, true); paintLayers(); });
    return pick;
  }
  function paintLayers() {
    layersTitle.textContent = ct("layers"); layersHelp.textContent = ct("layersHelp"); layersList.replaceChildren();
    const objects = [...frames.values()].filter(frame => visibleFrames.has(frame.object.id)).sort((a, b) => currentPlacement(b).z - currentPlacement(a).z);
    for (const frame of objects) {
      const row = element("article", "canvas-layer-row"); row.dataset.itemId = frame.object.id;
      row.append(layerPick(frame.title.textContent ?? "", frame.object.id), element("small", "", ct("layerObject")));
      layersList.append(row);
    }
    for (const composition of savedLayout.compositions ?? []) {
      if (!compositionMembers(composition.id).some(id => visibleFrames.has(id))) continue;
      const row = element("article", "canvas-layer-row is-composition"); row.dataset.compositionId = composition.id;
      row.append(layerPick(composition.title || ct("groupTitle"), composition.id),
        element("small", "", ct("layerMembers", { n: composition.members.length })));
      layersList.append(row);
    }
    if (!layersList.childElementCount) layersList.append(element("p", "", ct("emptyLayers")));
  }

  const proposals = element("dialog", "board-dialog canvas-proposals");
  const proposalsHead = element("header"), proposalsTitle = element("h2"), proposalsHelp = element("p"), proposalsList = element("div", "canvas-proposals-list");
  const proposalsClose = button(ct("close"), () => proposals.close());
  const proposalRefresh = button(ct("proposalRefresh"), () => { void refreshProposals(); });
  proposalsHead.append(proposalsTitle, proposalRefresh, proposalsClose); proposals.append(proposalsHead, proposalsHelp, proposalsList); document.body.append(proposals);
  const reviewedProposals = new Map<string, string>();
  const applyingProposals = new Set<string>();
  let proposalsRefreshing = false;
  const pendingProposals = () => (savedLayout.proposals ?? []).filter(proposal => proposal.result.status === "proposed");
  function currentValue(read: CanvasRead) {
    if (read.kind === "content") {
      const object = objectById(read.id); return object ? titleFor(object, frames.get(read.id)?.reply) : ct("proposalMissing");
    }
    if (read.kind === "presentation") {
      const item = savedLayout.items.find(entry => entry.item_id === read.id);
      return item ? Math.round(item.x) + ", " + Math.round(item.y) + " · " + Math.round(item.width) + "×" + Math.round(item.height) : ct("proposalMissing");
    }
    const composition = compositionById(read.id); return composition ? composition.title + " · " + ct("layerMembers", { n: composition.members.length }) : ct("proposalMissing");
  }
  function operationText(proposal: CanvasProposal) {
    return proposal.request.operations.map(operation => {
      switch (operation.op) {
        case "patch_content": return ct("proposalPatch");
        case "patch_reply": return ct("proposalLegacyPatch");
        case "bind": return ct("proposalBind");
        case "place": return ct("proposalPlace");
        case "compose": return ct("group") + ": " + operation.members.length;
        case "ungroup": return ct("ungroup");
        case "create": return ct("proposalCreate");
      }
    }).join(" · ");
  }
  function blockText(block?: ReplyBlock): string {
    if (!block) return ct("proposalMissing");
    switch (block.type) {
      case "text": return [block.title, block.text].filter(Boolean).join("\n");
      case "comparison": return [block.title, block.criteria.join(" · "), ...block.options.map(option => [option.title, option.summary, option.values.join(" · ")].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n");
      case "graph": return [block.title, ...block.nodes.map(node => [node.title, node.detail].filter(Boolean).join(" — ")), ...block.edges.map(edge => `${block.nodes.find(node => node.id === edge.from)?.title || edge.from} → ${block.nodes.find(node => node.id === edge.to)?.title || edge.to}: ${edge.label}`)].filter(Boolean).join("\n");
      case "sequence": return [block.title, ...block.steps.map((step, index) => `${index + 1}. ${[step.title, step.action, step.feedback, step.note].filter(Boolean).join("\n")}`)].filter(Boolean).join("\n\n");
      case "artifact": return [block.title, block.description, block.bundle_id].filter(Boolean).join("\n");
    }
  }
  function objectFields(object?: CanvasObject): Record<string, unknown> {
    if (!object) return {};
    const content = object.content;
    if (content.type === "node") { const node = board?.nodes.find(node => node.id === content.id); return { title: node?.title, text: node?.body }; }
    if (content.type === "reply") return { title: board?.replies?.find(reply => reply.id === content.id)?.title };
    const { type: _type, ...fields } = content; return fields;
  }
  function appendProposalChanges(host: HTMLElement, proposal: CanvasProposal) {
    const labels: Record<string, string> = { title: ct("nativeTitle"), text: ct("nativeText"), src: ct("nativeImageSource"), alt: ct("nativeAlt"), fill: ct("nativeFill"), members: ct("layers"), bindings: ct("dataConnections") };
    const bindingText = (bindings: NonNullable<CanvasObject["bindings"]>) => bindings.map(binding => `${binding.from.object_id} / ${binding.from.block_id}.${binding.from.port} → ${binding.to.block_id ? binding.to.block_id + "." : ""}${binding.to.port}`).join("\n") || "—";
    const memberNames = (ids: string[]) => ids.map(id => compositionById(id)?.title || (objectById(id) ? titleFor(objectById(id)!, frames.get(id)?.reply) : id)).join("\n");
    const valueCell = (value: unknown, isImage: boolean) => {
      const cell = element("div", "canvas-proposal-value");
      if (isImage && typeof value === "string" && /^(https?:|\/artifacts\/|data:image\/(png|jpeg|webp);base64,)/i.test(value)) {
        const image = document.createElement("img"); image.alt = ct("nativeImageSource"); cell.append(image);
        if (value.startsWith("/artifacts/")) void apiBase().then(base => { if (image.isConnected) image.src = new URL(value, base).toString(); });
        else image.src = value;
      }
      const text = value == null ? "—" : typeof value === "string" ? value : String(value);
      cell.append(element("pre", "", isImage && text.startsWith("data:") ? text.slice(5, text.indexOf(';')) : text));
      return cell;
    };
    for (const operation of proposal.request.operations) {
      const object = objectById(operation.id), section = element("section", "canvas-proposal-change");
      section.append(element("strong", "", object ? titleFor(object, frames.get(object.id)?.reply) : compositionById(operation.id)?.title || ct("proposalCreate")));
      const table = element("div", "canvas-proposal-values");
      table.append(element("small", "", ct("proposalCurrent")), element("small", "", ct("proposalRequested")));
      const add = (key: string, before: unknown, after: unknown) => {
        const label = element("small", "canvas-proposal-field", labels[key] ?? key); table.append(label, valueCell(before, key === "src"), valueCell(after, key === "src"));
      };
      if (operation.op === "patch_content") {
        const fields = objectFields(object); for (const [key, value] of Object.entries(operation.fields)) add(key, fields[key], value);
      } else if (operation.op === "patch_reply") {
        const content = object?.content, reply = content?.type === "reply" ? board?.replies?.find(reply => reply.id === content.id) : undefined;
        add("text", blockText(reply?.blocks.find(block => block.id === operation.block.id)), blockText(operation.block));
      } else if (operation.op === "patch_block") {
        add("text", blockText(object?.content.type === "block" ? object.content.block : undefined), blockText(operation.block));
      } else if (operation.op === "place") {
        const current = savedLayout.items.find(item => item.item_id === operation.id);
        for (const [key, value] of Object.entries(operation.fields)) add(key, current?.[key as keyof CanvasPlacement], value);
      } else if (operation.op === "bind") {
        add("bindings", bindingText(object?.bindings ?? []), bindingText(operation.bindings));
      } else if (operation.op === "compose") {
        const group = compositionById(operation.id); add("title", group?.title, operation.title); add("members", group ? memberNames(group.members) : "—", memberNames(operation.members));
        if (operation.description !== undefined) add("description", group?.description, operation.description);
      } else if (operation.op === "ungroup") {
        add("members", memberNames(compositionById(operation.id)?.members ?? []), ct("ungroup"));
      } else if (operation.op === "create" && operation.content.type === "block") {
        add("text", null, blockText(operation.content.block));
      } else if (operation.op === "create" && isNativeCanvasContent(operation.content)) {
        for (const [key, value] of Object.entries(operation.content)) if (key !== "type") add(key, null, value);
        if (operation.bindings?.length) add("bindings", null, bindingText(operation.bindings));
      }
      section.append(table); host.append(section);
    }
  }
  function proposalCurrent(proposal: CanvasProposal): CanvasRead[] | null {
    const needed = [...proposal.request.reads];
    const created = new Set(proposal.request.operations.filter(operation => operation.op === "create").map(operation => operation.id));
    for (const operation of proposal.request.operations) {
      if ((operation.op === "patch_content" || operation.op === "patch_reply" || operation.op === "patch_block" || operation.op === "bind") && !created.has(operation.id)) needed.push({ kind: "content", id: operation.id, revision: operation.expected_revision });
      else if (operation.op === "place" && !created.has(operation.id)) needed.push({ kind: "presentation", id: operation.id, revision: operation.expected_revision });
      else if (operation.op === "ungroup") {
        needed.push({ kind: "composition", id: operation.id, revision: operation.expected_revision });
        const parent = savedLayout.compositions?.find(group => group.members.includes(operation.id));
        if (parent) needed.push({ kind: "composition", id: parent.id, revision: parent.revision });
      } else if (operation.op === "compose") {
        if (operation.expected_revision > 0) needed.push({ kind: "composition", id: operation.id, revision: operation.expected_revision });
        operation.members.filter(member => !created.has(member)).forEach(member => needed.push(...readsForUnit(member)));
      }
    }
    const current: CanvasRead[] = [];
    for (const read of needed) { const latest = currentRead(read.kind, read.id); if (!latest) return null; current.push(latest); }
    return uniqueReads(current);
  }
  const reviewStamp = (proposal: CanvasProposal) => contentKey({ request: proposal.request, current: proposalCurrent(proposal) });
  async function refreshProposals() {
    if (proposalsRefreshing) return;
    proposalsRefreshing = true; paintProposals();
    try {
      update(await handlers.onReload());
      pendingProposals().forEach(proposal => reviewedProposals.set(proposal.request.request_id, reviewStamp(proposal)));
    } catch (error) { fail(error); }
    finally { proposalsRefreshing = false; if (proposals.open) paintProposals(); }
  }
  async function decideProposal(proposal: CanvasProposal, action: "apply" | "dismiss") {
    const current = action === "apply" ? proposalCurrent(proposal) : [];
    if (action === "apply" && (reviewedProposals.get(proposal.request.request_id) !== reviewStamp(proposal) || !current)) return;
    applyingProposals.add(proposal.request.request_id); paintProposals();
    try { update(await handlers.onProposal(proposal.request.request_id, action, current ?? [])); reviewedProposals.delete(proposal.request.request_id); }
    catch (error) { try { update(await handlers.onReload()); } catch { /* Keep the dialog state if the bridge cannot refresh. */ } fail(error); }
    finally { applyingProposals.delete(proposal.request.request_id); if (proposals.open) paintProposals(); }
  }
  function paintProposals() {
    const pending = pendingProposals();
    proposalsButton.textContent = pending.length ? ct("proposalCount", { n: pending.length }) : ct("proposals");
    proposalsButton.disabled = !pending.length; proposalsTitle.textContent = ct("proposals");
    proposalsHelp.textContent = proposalsRefreshing ? ct("proposalRefreshing") : ct("proposalHelp");
    proposalRefresh.textContent = ct("proposalRefresh"); proposalRefresh.disabled = proposalsRefreshing;
    proposalsList.replaceChildren();
    if (!pending.length) { proposalsList.append(element("p", "", ct("emptyProposals"))); return; }
    for (const proposal of pending) {
      const item = element("article", "canvas-proposal"); item.dataset.requestId = proposal.request.request_id;
      item.append(element("strong", "", ct("proposalRequested")), element("p", "", operationText(proposal)));
      appendProposalChanges(item, proposal);
      const reads = proposalCurrent(proposal);
      const current = element("div", "canvas-proposal-current");
      current.append(element("small", "", ct("proposalCurrent")));
      for (const read of reads ?? proposal.request.reads) current.append(element("p", "", read.kind + ": " + currentValue(read)));
      item.append(current);
      const conflicts = proposal.result.targets.filter(target => target.status !== "ready");
      if (conflicts.length) {
        const detail = element("div", "canvas-proposal-conflicts"); detail.append(element("small", "", ct("proposalConflict")));
        for (const target of conflicts) detail.append(element("p", "", target.status + (target.message ? " · " + target.message : "")));
        item.append(detail);
      }
      const reviewed = reviewedProposals.get(proposal.request.request_id) === reviewStamp(proposal) && !proposalsRefreshing;
      const apply = button(ct("proposalApply"), () => { void decideProposal(proposal, "apply"); }); apply.classList.add("primary");
      const dismiss = button(ct("proposalDismiss"), () => { void decideProposal(proposal, "dismiss"); });
      apply.disabled = !reviewed || !reads || applyingProposals.has(proposal.request.request_id);
      dismiss.disabled = applyingProposals.has(proposal.request.request_id);
      item.append(apply, dismiss); proposalsList.append(item);
    }
  }

  const removedDialog = element("dialog", "board-dialog canvas-removed");
  const removedHead = element("header"), removedTitle = element("h2"), removedHelp = element("p"), removedList = element("div");
  const removedClose = button(ct("close"), () => removedDialog.close());
  removedHead.append(removedTitle, removedClose); removedDialog.append(removedHead, removedHelp, removedList); document.body.append(removedDialog);
  function paintRemovedButton() {
    removedButton.textContent = removedEntries.length ? ct("removedCount", { n: removedEntries.length }) : ct("removed");
    removedButton.title = ct("removed"); removedButton.setAttribute("aria-label", ct("removed"));
    removedButton.disabled = !removedEntries.length;
  }
  function paintRemovedList() {
    removedTitle.textContent = ct("removed"); removedHelp.textContent = ct("removedHelp");
    removedList.replaceChildren();
    if (!removedEntries.length) { removedList.append(element("p", "", ct("emptyRemoved"))); return; }
    for (const entry of removedEntries) {
      const row = element("article", "saved-item"); row.dataset.itemId = entry.object.id;
      row.append(element("strong", "", titleFor(entry.object, entry.reply)), element("small", "", entry.reply?.source_label ?? entry.object.source_id ?? ""));
      const restore = button(ct("restoreItem"), () => {
        restore.disabled = true;
        void restoreItem(entry.object.id).then(ok => { if (ok) removedDialog.close(); else restore.disabled = false; });
      });
      row.append(restore); removedList.append(row);
    }
  }

  const drafts = element("dialog", "board-dialog canvas-drafts");
  const draftHead = element("header"); const draftTitle = element("h2");
  const close = button(ct("close"), () => drafts.close()); draftHead.append(draftTitle, close);
  const draftHelp = element("p"); const draftList = element("div"); drafts.append(draftHead, draftHelp, draftList); document.body.append(drafts);
  type AnchoredDraft = DraftRecord & { anchors?: CanvasAnchor[] };
  const draftAnchors = (record: DraftRecord) => (record as AnchoredDraft).anchors?.filter(anchor => Boolean(objectById(anchor.object_id))) ?? [];
  function restoreAnchors(anchors: CanvasAnchor[]) {
    const ids = anchors.map(anchor => anchor.object_id).filter(id => frames.has(id)); if (!ids.length) return false;
    choose(ids[0], false, true); for (const id of ids.slice(1)) choose(id, true, true);
    for (const anchor of anchors) frames.get(anchor.object_id)?.native?.setRegion(anchor.region);
    focus(ids[0], true); return true;
  }
  /** Puts a draft back into its content; edit drafts need the content activated so the editor can take focus. */
  function restoreDraftInto(record: DraftRecord, key?: string): boolean {
    if (record.channel === "composer") {
      if (restoreAnchors(draftAnchors(record))) { drafts.close(); handlers.onRestoreComposer(record); return true; }
      const frame = key ? frames.get(key) : undefined;
      if (!frame?.editor) return false;
      frame.editor.selectBlock(record.reply_id, record.block_id); focus(frame.object.id, true);
      drafts.close(); handlers.onRestoreComposer(record); return true;
    }
    const frame = key ? frames.get(key) : undefined; if (!frame?.editor) return false;
    drafts.close(); activate(frame.object.id);
    if (!frame.editor.restoreDraft(record)) { deactivate(false); return false; }
    focus(frame.object.id, true); return true;
  }
  function paintDrafts() {
    const records = replyDrafts.list(); draftsButton.textContent = records.length ? ct("draftCount", { n: records.length }) : ct("drafts");
    draftsButton.title = ct("drafts"); draftsButton.setAttribute("aria-label", ct("drafts"));
    draftsButton.classList.toggle("has-warning", replyDrafts.hasUnpersisted);
    if (!drafts.open && !records.length) { draftList.replaceChildren(); }
    draftTitle.textContent = ct("drafts"); draftHelp.textContent = ct(replyDrafts.hasUnpersisted ? "draftUnsafe" : "draftHelp");
    draftList.replaceChildren();
    if (!records.length) draftList.append(element("p", "", ct("emptyDrafts")));
    for (const record of records) {
      const row = element("article", "saved-item"); row.append(element("strong", "", record.reply_title), element("small", "", ct(record.kind === "edit" ? "draftEdit" : "draftAsk")));
      const anchors = draftAnchors(record);
      const key = record.channel === "composer" && anchors.length ? anchors.find(anchor => frames.has(anchor.object_id))?.object_id ?? anchors[0]?.object_id : draftObject(record)?.id;
      const removed = key && !frames.has(key) ? removedEntries.find(entry => entry.object.id === key) : undefined;
      // A draft for removed content is kept and points at the restore step; it is never discarded on the user's behalf.
      if (removed) row.append(element("p", "canvas-draft-note", ct("draftRemoved")));
      const text = element("textarea"); text.readOnly = true; text.value = draftText(record); text.setAttribute("aria-label", record.reply_title); row.append(text);
      if (removed) row.append(button(ct("restoreItem"), () => {
        void restoreItem(removed.object.id).then(ok => {
          if (!ok) { paintDrafts(); return; }
          if (!restoreDraftInto(record, removed.object.id)) { paintDrafts(); drafts.showModal(); fail(ct("missingBlock")); }
        });
      }));
      else row.append(button(ct("restore"), () => {
        if ((!key && !anchors.length) || !restoreDraftInto(record, key)) { if (!drafts.open) drafts.showModal(); row.append(element("p", "", ct("missingBlock"))); }
      }));
      row.append(button(ct("copy"), () => { void navigator.clipboard.writeText(text.value).catch(() => { text.focus(); text.select(); }); }),
        button(ct("discard"), () => { replyDrafts.remove(draftKey(record), record.updated_at); paintDrafts(); }));
      draftList.append(row);
    }
  }
  const unsubscribeDrafts = replyDrafts.subscribe(paintDrafts);

  function mountHtml(cell: Node, frame: HTMLElement, native?: NativeCanvasContent) {
    if (destroyed || html.get(cell.id) !== frame) return;
    const held = frames.get(cell.id);
    if (held && (held.root !== frame || held.cell !== cell)) return;
    const view = graph.findViewByCell(cell) as { selectors?: { foContent?: HTMLElement }; container?: Element } | null;
    const host = view?.selectors?.foContent
      ?? (view?.container?.querySelector("foreignObject div") as HTMLElement | null)
      ?? (graphHost.querySelector(`.x6-node[data-cell-id="${cell.id}"] foreignObject > div`) as HTMLElement | null);
    if (host && frame.parentElement !== host) host.replaceChildren(frame);
    const live = graphHost.querySelector(`.canvas-frame[data-item-id="${cell.id}"]`);
    if (live && live !== frame) live.replaceWith(frame);
    if (native && !frame.querySelector(".canvas-native")) {
      frame.querySelector(".canvas-frame-content")?.append(native.root);
    }
  }
  function addFrame(object: CanvasObject, p: CanvasPlacement, reply?: BoardReply, note?: BoardNode) {
    const key = object.id;
    const frame = element("article", "canvas-frame"); frame.dataset.itemId = key; frame.dataset.contentId = legacyKey(object.content);
    if (object.content.type === "node") frame.classList.add("is-idea-note");
    // The head is a selection-time handle: static title bar for cards, floating handle for plain presentations.
    const label = titleFor(object, reply);
    const head = element("header", "canvas-frame-head"); head.tabIndex = 0; head.setAttribute("aria-label", label);
    const title = element("strong", "", label);
    const source = element("small", "canvas-frame-source");
    const provenance = element("small", "canvas-origin");
    const activateButton = button(ct("activate"), () => { if (active === key) deactivate(); else activate(key); });
    const openButton = button(ct("open"), () => openReader(key), ct("open"));
    for (const node of [activateButton, openButton]) node.addEventListener("mousedown", event => event.stopPropagation());
    head.append(title, source, activateButton, openButton);
    const content = element("div", "canvas-frame-content"); content.tabIndex = -1;
    content.inert = true;
    const drag = element("div", "canvas-card-drag"); drag.setAttribute("aria-hidden", "true");
    for (const name of ["mousedown", "pointerdown", "wheel", "dblclick"]) content.addEventListener(name, event => event.stopPropagation());
    content.addEventListener("pointerdown", event => choose(key, event.shiftKey, true), { capture: true });
    frame.append(head, provenance, content, drag);
    let editor: ReplyBoardHandle | undefined;
    let native: NativeCanvasContent | undefined;
    if (isNativeCanvasContent(object.content)) {
      native = new NativeCanvasContent(content, object, {
        onPatch: async (fields: CanvasContentFields) => {
          const held = frames.get(key); if (!held) return;
          const encoded = contentKey({ fields, expected_revision: held.object.content_revision }), previous = nativeRequestIds.get(key);
          const requestId = previous?.fields === encoded ? previous.requestId : crypto.randomUUID();
          nativeRequestIds.set(key, { fields: encoded, requestId });
          const request: CanvasBatchRequest = { request_id: requestId, reads: [{ kind: "content", id: key, revision: held.object.content_revision }],
            operations: [{ op: "patch_content", id: key, expected_revision: held.object.content_revision, fields }] };
          try { update(await handlers.onBatch(request)); nativeRequestIds.delete(key); }
          catch (error) { try { update(await handlers.onReload()); } catch { /* The local draft remains recoverable without a fresh snapshot. */ } throw error; }
        },
        onSelectionChange: () => { if (selectedUnits.has(key)) handlers.onSelect(getSelection()); },
        onTitleChange: value => { const held = frames.get(key); if (held) { held.title.textContent = value; held.head.setAttribute("aria-label", value); } },
        onError: fail,
      });
    } else if (reply) {
      editor = mountReplyBoard(content, {
        dataflow,
        onPatch: async request => {
          const atom = frames.get(key)?.object;
          if (atom?.content.type === "block") {
            if (request.block.type === "artifact") throw new Error("Interactive works use the artifact tools.");
            update(await handlers.onBatch({ request_id: request.request_id || crypto.randomUUID(), reads: [{ kind: "content", id: key, revision: request.expected_revision }], operations: [{ op: "patch_block", id: key, expected_revision: request.expected_revision, block: request.block }] }));
            return blockReply(objectById(key)!);
          }
          if (!note) return handlers.onPatch(request);
          const next = await handlers.onNodePatch(note.id, request); const held = frames.get(key); if (held) held.note = next;
          return noteReply(next, key);
        },
        onAction: async request => {
          const atom = frames.get(key)?.object;
          if (atom?.content.type === "block") {
            update(await handlers.onBlockAction(key, request, atom.content_revision));
            return blockReply(objectById(key)!);
          }
          if (!note) return handlers.onAction(request);
          await handlers.onNodeAsk(note.id, request.text ?? ""); return noteReply(frames.get(key)?.note ?? note, key);
        },
        onSelect: () => { if (selectedUnits.has(key)) handlers.onSelect(getSelection()); },
        onFocusNotice: message => { choose(key, false, true); handlers.onFocusNotice?.(message); },
        onError: handlers.onError,
      });
    }
    html.set(key, frame);
    const cell = graph.addNode({ id: key, shape, x: p.x, y: p.y, width: p.width, height: p.height, zIndex: p.z }, { remote: true });
    mountHtml(cell, frame, native);
    queueMicrotask(() => { if (!destroyed && html.get(key) === frame) mountHtml(cell, frame, native); });
    requestAnimationFrame(() => { if (!destroyed && html.get(key) === frame) mountHtml(cell, frame, native); });
    const held: Frame = { object, root: frame, head, title, source, provenance, content, activateButton, openButton, cell, editor, native, reply, placement: p, note };
    frames.set(key, held); applyAppearance(held, p); if (editor && reply) editor.update([reply]);
    frame.classList.toggle("is-selected", selectedObjectIds().includes(key));
  }

  type GraphEdgeSpec = { id: string; source: string; target: string; labels?: string[] };
  const edgeLabelStyle = { attrs: { text: { fill: "#5c574e", fontSize: 11, fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif" }, rect: { fill: "#fffcf7", stroke: "none", rx: 4, ry: 4 } } };
  function edgeLineAttrs(id: string) {
    return { stroke: id.startsWith("data:") ? "#2a8a78" : "#9e7cc0", strokeWidth: 1.6, strokeDasharray: id.startsWith("data:") ? "" : "5 5" };
  }
  function edgeLabelTexts(cell: { getLabels(): { attrs?: { label?: { text?: unknown } } }[] }) {
    return cell.getLabels().map(label => String(label.attrs?.label?.text ?? ""));
  }
  function syncGraphEdges(edges: GraphEdgeSpec[]) {
    if (contentKey(edges) === edgeKey) return;
    edgeKey = contentKey(edges);
    const wanted = new Map(edges.map(edge => [edge.id, edge]));
    for (const cell of graph.getEdges()) if (!wanted.has(cell.id)) graph.removeCell(cell, { remote: true });
    for (const edge of edges) {
      const cell = graph.getCellById(edge.id);
      if (cell?.isEdge()) {
        if (cell.getSourceCellId() !== edge.source) cell.setSource({ cell: edge.source }, { remote: true });
        if (cell.getTargetCellId() !== edge.target) cell.setTarget({ cell: edge.target }, { remote: true });
        const nextLabels = edge.labels ?? [];
        if (contentKey(edgeLabelTexts(cell)) !== contentKey(nextLabels)) cell.setLabels(nextLabels, { remote: true });
        if (cell.getZIndex() !== EDGE_Z) cell.setZIndex(EDGE_Z, { remote: true });
        const line = edgeLineAttrs(edge.id);
        if (cell.attr("line/stroke") !== line.stroke) cell.attr("line/stroke", line.stroke, { remote: true });
        if (Number(cell.attr("line/strokeWidth")) !== line.strokeWidth) cell.attr("line/strokeWidth", line.strokeWidth, { remote: true });
        if (String(cell.attr("line/strokeDasharray") ?? "") !== line.strokeDasharray) cell.attr("line/strokeDasharray", line.strokeDasharray, { remote: true });
      } else if (!cell) {
        graph.addEdge({ ...edge, zIndex: EDGE_Z, defaultLabel: edgeLabelStyle, attrs: { line: edgeLineAttrs(edge.id) } }, { remote: true });
      }
    }
  }

  function update(snapshot: BoardSnapshot) {
    if (destroyed) return;
    board = snapshot;
    dataflow.update(snapshot);
    const layout: CanvasLayout = { revision: snapshot.canvas?.revision ?? 0, objects: snapshot.canvas?.objects ?? [], items: snapshot.canvas?.items ?? [], compositions: snapshot.canvas?.compositions ?? [], proposals: snapshot.canvas?.proposals ?? [] };
    if (layout.revision >= revision) { revision = layout.revision; savedLayout = layout; }
    if (groupMove) {
      const receipt = savedLayout.proposals?.find(proposal => proposal.request.request_id === groupMove!.request.request_id);
      if (receipt && receipt.result.status !== "proposed") {
        for (const [id, position] of groupMove.positions) if (contentKey(groupLocal.get(id)) === contentKey(position)) groupLocal.delete(id);
        groupMove = null; layoutMessage = "layoutSaved";
      }
    }
    for (const [id, pending] of nativeRequestIds) if (savedLayout.proposals?.some(proposal => proposal.request.request_id === pending.requestId && proposal.result.status === "dismissed")) nativeRequestIds.delete(id);
    const nodes = new Map(snapshot.nodes.map(note => [note.id, note]));
    const replies = new Map((snapshot.replies ?? []).map(reply => [reply.id, reply]));
    // Objects carry identity; legacy nodes/replies keep their established authority while native objects carry their own content.
    const shown: Entry[] = [], hidden: Entry[] = [];
    for (const object of savedLayout.objects) {
      const p = savedLayout.items.find(item => item.item_id === object.id); if (!p) continue;
      if (isNativeCanvasContent(object.content)) (p.removed ? hidden : shown).push({ object, placement: p });
      else if (object.content.type === "block") (p.removed ? hidden : shown).push({ object, placement: p, reply: blockReply(object) });
      else {
        const note = object.content.type === "node" ? nodes.get(object.content.id) : undefined;
        const source = object.content.type === "reply" ? replies.get(object.content.id) : undefined;
        if (!note && !source) continue;
        const reply = note ? noteReply(note, object.id) : { ...source!, object_id: object.id };
        (p.removed ? hidden : shown).push({ object, placement: p, reply, note });
      }
    }
    shown.sort((a, b) => a.placement.z - b.placement.z);
    removedEntries = hidden;
    const keys = new Set(shown.map(entry => entry.object.id));
    const nextJumpKey = contentKey(shown.map(entry => [entry.object.id, titleFor(entry.object, entry.reply)]));
    if (jumpKey !== nextJumpKey) {
      jumpKey = nextJumpKey;
      const first = element("option", "", ct("openItem")); first.value = "";
      jump.replaceChildren(first, ...shown.map(entry => { const option = element("option", "", titleFor(entry.object, entry.reply)); option.value = entry.object.id; return option; }));
    }
    for (const [key, frame] of frames) if (!keys.has(key)) {
      if (readingKey === key) reader.close();
      if (active === key) deactivate(false);
      frame.editor?.destroy(); frame.native?.destroy();
      frame.root.remove();
      graph.removeCell(frame.cell, { remote: true }); frames.delete(key); html.delete(key); dirty.delete(key); groupLocal.delete(key); nativeRequestIds.delete(key); history.clean();
    }
    for (const { object, placement: p, reply, note } of shown) {
      const key = object.id; const frame = frames.get(key);
      if (!frame) { addFrame(object, p, reply, note); continue; }
      if (Boolean(frame.native) !== isNativeCanvasContent(object.content)) {
        frame.editor?.destroy(); frame.native?.destroy(); frame.root.remove(); graph.removeCell(frame.cell, { remote: true }); frames.delete(key); html.delete(key);
        addFrame(object, p, reply, note); continue;
      }
      frame.object = object; frame.note = note; frame.reply = reply; frame.placement = p;
      frame.native?.update(object);
      const label = frame.native?.title() ?? titleFor(object, reply);
      frame.title.textContent = label; frame.source.textContent = reply?.source_label ?? object.source_id ?? ""; frame.head.setAttribute("aria-label", label);
      if (frame.editor && reply) frame.editor.update([reply]);
      if (readingKey === key) { readerTitle.textContent = label; readerSource.textContent = frame.source.textContent; }
      // Unsaved local changes win over the server placement; confirmed or conflicting ones follow the layout.
      if (!dirty.has(key) && !groupLocal.has(key)) { frame.cell.position(p.x, p.y, { remote: true }); frame.cell.resize(p.width, p.height, { remote: true }); }
      applyAppearance(frame, currentPlacement(frame));
    }
    const objectKey = (type: LegacyContent["type"], id: string) => objectForContent(type, id)?.id ?? "";
    const visibleBoardEdges = snapshot.edges.filter((edge) => showLegacyEdges || edge.relation === "parent");
    const edges = [...visibleBoardEdges.map(edge => ({ id: `edge:${edge.id}`, source: objectKey("node", edge.from), target: objectKey("node", edge.to) })),
      ...(snapshot.replies ?? []).filter(reply => reply.origin_node_id).map(reply => ({ id: `origin:${reply.id}`, source: objectKey("node", reply.origin_node_id!), target: objectKey("reply", reply.id) })),
      ...savedLayout.objects.flatMap(object => (object.bindings ?? []).map((binding, i) => ({ id: `data:${object.id}:${i}`, source: binding.from.object_id, target: object.id, labels: [`${binding.from.port} → ${binding.to.port}`] })))]
      .filter(edge => keys.has(edge.source) && keys.has(edge.target));
    syncGraphEdges(edges);
    applyScope();
    for (const unit of [...selectedUnits]) if (!objectById(unit) && !compositionById(unit)) selectedUnits.delete(unit);
    if (selection && (!selectedUnits.size || !selectedObjectIds().length)) choose(null);
    else {
      const visual = new Set(selectedObjectIds());
      for (const [id, frame] of frames) frame.root.classList.toggle("is-selected", visual.has(id));
    }
    empty.hidden = visibleFrames.size > 0;
    paintLegacyEdges();
    if (overview.open) paintOverview();
    if (layers.open) paintLayers();
    if (removedDialog.open) paintRemovedList();
    if (drafts.open) paintDrafts();
    paintRemovedButton(); paintProposals(); paintSelectionTools(); paintMode();
    if (shown.length && !initialView && host.clientWidth > 0) {
      requestAnimationFrame(() => { if (!destroyed) applyInitialView(); });
    }
    paintData(); paintStatus();
  }
  /** Existing callers still address content by reply/node id; the layout mapping turns that into an object. */
  function reveal(object: CanvasObject | undefined) {
    if (!object) return;
    if (frames.has(object.id)) { focus(object.id); return; }
    if (removedEntries.some(entry => entry.object.id === object.id) && !document.querySelector("dialog[open]")) { paintRemovedList(); removedDialog.showModal(); }
  }
  function labels() {
    applyScope();
    graphHost.setAttribute("aria-label", ct("canvas"));
    connectionsButton.textContent = ct("dataConnections"); connectionsButton.title = ct("dataConnections"); connectionsButton.setAttribute("aria-label", ct("dataConnections"));
    moreSummary.setAttribute("aria-label", ct("moreMenu")); moreSummary.title = ct("more");
    focusButton.textContent = ct("focusSelection"); focusButton.title = ct("focusSelectionHint"); focusButton.setAttribute("aria-label", ct("focusSelectionHint"));
    paintLegacyEdges();
    for (const [node, key] of [[fitButton, "fit"], [undo, "undo"], [redo, "redo"], [retry, "retry"], [proposalsButton, "proposals"], [tidyButton, "arrange"], [overviewClose, "close"], [layersClose, "close"], [proposalsClose, "close"], [proposalRefresh, "proposalRefresh"], [frontButton, "toFront"], [backButton, "toBack"], [cardButton, "cardStyle"], [groupButton, "group"], [ungroupButton, "ungroup"]] as const) { node.textContent = ct(key); node.title = ct(key); node.setAttribute("aria-label", ct(key)); }
    for (const [node, key] of [[add, "addComponent"], [overviewButton, "overview"], [layersButton, "layers"], [handButton, "pan"], [zoomIn, "zoomIn"], [zoomOut, "zoomOut"]] as const) { node.title = ct(key); node.setAttribute("aria-label", ct(key)); }
    ideaButton.textContent = ct("ideaEdit"); ideaButton.setAttribute("aria-label", ct("ideaEdit"));
    paintIcons();
    if (overview.open) paintOverview(); if (layers.open) paintLayers(); paintProposals(); paintPan(); paintMode();
    for (const closeButton of [readerClose, close, removedClose]) { closeButton.textContent = ct("close"); closeButton.setAttribute("aria-label", ct("close")); }
    actual.title = ct("actualSize"); actual.setAttribute("aria-label", ct("actualSize"));
    jump.setAttribute("aria-label", ct("openItem")); if (jump.options[0]) jump.options[0].textContent = ct("openItem");
    for (const frame of frames.values()) { frame.openButton.textContent = ct("open"); frame.openButton.title = ct("open"); frame.openButton.setAttribute("aria-label", ct("open")); frame.native?.refreshLabels(); }
    emptyTitle.textContent = ct("emptyCanvas"); emptyHelp.textContent = ct("emptyHelp"); paintStatus(); paintDrafts(); paintRemovedButton(); paintProposals(); paintSelectionTools();
    if (removedDialog.open) paintRemovedList();
  }
  function selectObject(objectId: string) {
    const object = objectById(objectId);
    if (!object || !frames.has(object.id)) {
      locateIntent = object ? { kind: "object", id: object.id } : { kind: "none" };
      choose(null);
      if (object) reveal(object);
      return;
    }
    locateIntent = { kind: "object", id: object.id };
    reveal(object);
  }
  const unsubscribeLocale = onLocale(labels); labels();
  return { update, getSelection, setOverviewMeta, selectObject, getScope: () => ({ workspace: scopeWorkspace || "all", task: scopeTask }),
    async prepareFeedback() {
      const ids = new Set(selectedObjectIds());
      const addInputs = (id: string) => { for (const binding of objectById(id)?.bindings ?? []) if (!ids.has(binding.from.object_id)) { ids.add(binding.from.object_id); addInputs(binding.from.object_id); } };
      [...ids].forEach(addInputs);
      const selected = [...ids].map(id => frames.get(id)).filter((frame): frame is Frame => Boolean(frame));
      selected.forEach(frame => frame.native?.prepareFeedback());
      await Promise.all(selected.map(frame => frame.editor?.prepareFeedback()));
      update(await handlers.onReload());
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    },
    select(replyId: string) {
      const object = objectForContent("reply", replyId) ?? resolveObject(replyId);
      if (!object || !frames.has(object.id)) {
        locateIntent = { kind: "none" };
        choose(null);
        if (object) reveal(object);
        return;
      }
      locateIntent = { kind: "object", id: object.id };
      reveal(object);
    },
    selectNode(nodeId: string | null) {
      if (!nodeId) {
        locateIntent = { kind: "none" };
        choose(null);
        return;
      }
      const object = objectForContent("node", nodeId) ?? resolveObject(nodeId);
      if (!object) {
        locateIntent = { kind: "none" };
        choose(null);
        return;
      }
      if (!frames.has(object.id)) {
        if (removedEntries.some(entry => entry.object.id === object.id)) {
          locateIntent = { kind: "none" };
          choose(null);
          reveal(object);
          return;
        }
        locateIntent = { kind: "object", id: object.id };
        choose(null);
        return;
      }
      locateIntent = { kind: "object", id: object.id };
      reveal(object);
    },
    destroy() { persistView(); destroyed = true; viewResize.disconnect(); window.clearTimeout(saveTimer); window.clearTimeout(viewTimer); window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", releasePan); window.removeEventListener("mouseup", middleUp, true); window.removeEventListener("pagehide", persistView); window.removeEventListener("pointerdown", closeMore, true); window.removeEventListener("resize", placeSelectionTools); graphHost.removeEventListener("mousedown", middleDown, true); unsubscribeLocale(); unsubscribeDrafts(); unsubscribeData(); dataflow.destroy(); connections.destroy(); insert.destroy(); ideaEditor.destroy(); for (const frame of frames.values()) { frame.editor?.destroy(); frame.native?.destroy(); } graph.dispose(); reader.remove(); drafts.remove(); overview.remove(); layers.remove(); proposals.remove(); removedDialog.remove(); root.remove(); },
  };
}
