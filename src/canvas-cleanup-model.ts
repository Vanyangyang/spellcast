import type { AgentEvent, BoardSnapshot, CanvasBatchRequest, CanvasObject, CanvasOrigin, CanvasPlacement, CanvasRead, DeliveryReceipt, FeedbackState } from "./types";
import { originForObject, type ContentOrigin } from "./content-origin";

export type CleanupItem = {
  id: string; title: string; excerpt: string; text: string | null;
  reason: "handled" | "replied" | "none";
  blocked: ("locked" | "pending" | "annotation" | "draft")[];
  mergeBlocked: boolean; object: CanvasObject; placement: CanvasPlacement; origin: ContentOrigin;
  route?: CanvasOrigin;
};
export type CleanupGroup = { id: string; items: CleanupItem[]; exact: boolean; title: string; text: string };
export type CleanupAnalysis = { items: CleanupItem[]; groups: CleanupGroup[] };
export type CleanupChoice = { archiveIds: ReadonlySet<string>; mergeIds: ReadonlySet<string> };
export type CleanupPrepared = { batch: CanvasBatchRequest; archivedIds: string[]; createdIds: string[] };

const MESSAGE_KINDS = new Set(["say", "reply", "selection", "reply_edit"]);
const FINISHED_PHASES = new Set(["handled", "responded", "completed"]);
const snapshots = new WeakMap<CleanupItem, { object: string; placement: string; annotations: CanvasRead[] }>();
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
// Internal whitespace may be code indentation or a string value, so it is never deduplicated away.
const exactText = (text: string) => text.replace(/\r\n/g, "\n").replace(/(?:\n[ \t]*)+$/g, "");
const compact = (text: string, length = 120) => normalize(text).slice(0, length);

function plainContent(object: CanvasObject, board: BoardSnapshot): { title: string; text: string | null } {
  const content = object.content;
  if (content.type === "text") return { title: content.title, text: content.text };
  if (content.type === "node") {
    const node = board.nodes.find(node => node.id === content.id);
    return { title: node?.title ?? "", text: node?.body ?? null };
  }
  if (content.type === "reply") {
    const reply = board.replies?.find(reply => reply.id === content.id);
    return { title: reply?.title ?? "", text: reply && reply.blocks.every(block => block.type === "text")
      ? reply.blocks.map(block => block.type === "text" ? (block.title ? `### ${block.title}\n\n` : "") + block.text : "").join("\n\n") : null };
  }
  if (content.type === "block") {
    const block = content.block;
    return { title: block.title ?? "", text: block.type === "text" ? block.text : null };
  }
  return { title: content.type === "source_table" ? content.table.title : content.type === "source_skeleton" ? content.skeleton.title : "title" in content ? content.title : "", text: null };
}

function routeFor(object: CanvasObject, board: BoardSnapshot, feedback: FeedbackState, origin: ContentOrigin): CanvasOrigin {
  const content = object.content;
  const node = content.type === "node" ? board.nodes.find(node => node.id === content.id) : undefined;
  const reply = content.type === "reply" ? board.replies?.find(reply => reply.id === content.id) : undefined;
  const parent = reply?.origin_node_id ? board.nodes.find(node => node.id === reply.origin_node_id && node.source_id === reply.source_id) : undefined;
  const captured = node?.captured_context ?? parent?.captured_context;
  const sourceId = captured?.source_id || object.origin?.source_id || node?.source_id || reply?.source_id || object.source_id || "";
  const binding = feedback.bindings.find(binding => binding.source_id === sourceId && (!captured?.thread_id || captured.thread_id === binding.thread_id));
  return { cwd: origin.cwd, source_id: sourceId || undefined,
    thread_id: captured?.thread_id || object.origin?.thread_id || binding?.thread_id || undefined,
    label: origin.taskLabel || undefined };
}

function references(event: AgentEvent, receipt: DeliveryReceipt | undefined, board: BoardSnapshot): Set<string> {
  const ids = new Set<string>([...(event.anchors ?? []).map(anchor => anchor.object_id), ...(receipt?.response_object_ids ?? [])]);
  if (event.object_id) ids.add(event.object_id);
  for (const object of board.canvas?.objects ?? []) {
    if (object.content.type === "node" && object.content.id === event.node_id) ids.add(object.id);
    if (object.content.type === "reply" && (object.content.id === event.reply_id || object.content.id === receipt?.response_reply_id)) ids.add(object.id);
  }
  return ids;
}

function currentEvidence(event: AgentEvent, object: CanvasObject): boolean {
  const revisions = (event.anchors ?? []).filter(anchor => anchor.object_id === object.id).map(anchor => anchor.content_revision);
  if (event.object_id === object.id && event.object_revision != null) revisions.push(event.object_revision);
  // Legacy messages and response receipts have no response revision. Only initial content is known to match.
  return revisions.length ? revisions.every(revision => revision >= object.content_revision) : object.content_revision <= 1;
}

function sameContext(a: CleanupItem, b: CleanupItem): boolean {
  return Boolean(a.route?.source_id && a.route.source_id === b.route?.source_id
    && a.origin.workspaceKey !== "unsorted" && a.origin.workspaceKey === b.origin.workspaceKey
    && a.origin.taskKey !== "unsorted" && a.origin.taskKey === b.origin.taskKey);
}

function sameManualContext(a: CleanupItem, b: CleanupItem): boolean {
  if (sameContext(a, b)) return true;
  const anonymous = (item: CleanupItem) => !item.route?.source_id && !item.route?.cwd && !item.route?.thread_id;
  return anonymous(a) && anonymous(b) && a.origin.workspaceKey === b.origin.workspaceKey && a.origin.taskKey === b.origin.taskKey;
}

function tokens(text: string): Set<string> {
  const limited = text.slice(0, 8000).toLowerCase();
  const result = new Set<string>();
  for (const run of limited.match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(run)) {
      const chars = [...run];
      for (let size = 2; size <= 3 && result.size < 4000; size++) {
        for (let i = 0; i <= chars.length - size && result.size < 4000; i++) result.add(chars.slice(i, i + size).join(""));
      }
    } else result.add(run);
    if (result.size >= 4000) break;
  }
  const words = limited.match(/[a-z0-9_]+/g) ?? [];
  for (let i = 0; i + 1 < words.length && result.size < 4000; i++) result.add(`${words[i]} ${words[i + 1]}`);
  return result;
}

function similar(a: CleanupItem, b: CleanupItem, tokenMap: Map<string, Set<string>>): boolean {
  if (!sameContext(a, b) || a.text == null || b.text == null) return false;
  if (exactText(a.text) === exactText(b.text)) return true;
  if ((a.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 24 || (b.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 24) return false;
  const left = tokenMap.get(a.id)!; const right = tokenMap.get(b.id)!;
  if (left.size < 10 || right.size < 10) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return 2 * shared / (left.size + right.size) >= 0.78;
}

function groupId(items: CleanupItem[]): string {
  return `cleanup:${items.map(item => encodeURIComponent(item.id)).sort().join(",")}`;
}

export function mergeCleanupItems(items: CleanupItem[]): CleanupGroup {
  if (items.length < 2 || items.length > 8 || new Set(items.map(item => item.id)).size !== items.length
    || items.some(item => item.text == null || item.blocked.length || item.mergeBlocked || item.placement.removed || !sameManualContext(items[0], item))) {
    throw new Error("cleanup.mergeUnavailable");
  }
  const bodies = new Map<string, { titles: string[]; text: string }>();
  for (const item of items) {
    const key = exactText(item.text!);
    const entry = bodies.get(key);
    if (entry) { if (!entry.titles.includes(item.title)) entry.titles.push(item.title); }
    else bodies.set(key, { titles: [item.title], text: item.text! });
  }
  const text = [...bodies.values()].map(entry => `${entry.titles.map(title => `## ${title}`).join("\n\n")}\n\n${entry.text}`).join("\n\n");
  if (text.length > 64000) throw new Error("cleanup.mergeUnavailable");
  return { id: groupId(items), items: items.slice(), exact: bodies.size === 1, title: items[0].title.slice(0, 160), text };
}

export function analyzeCleanup(board: BoardSnapshot, feedback: FeedbackState, scopeIds: ReadonlySet<string>, protectedIds: ReadonlySet<string> = new Set()): CleanupAnalysis {
  const canvas = board.canvas;
  if (!canvas) return { items: [], groups: [] };
  const receipts = new Map(feedback.deliveries.map(receipt => [receipt.event.seq, receipt]));
  const events = new Map(feedback.deliveries.map(receipt => [receipt.event.seq, receipt.event]));
  for (const event of feedback.pending) events.set(event.seq, event);
  const messages = [...events.values()].filter(event => MESSAGE_KINDS.has(event.kind)).map(event => ({ event, receipt: receipts.get(event.seq), ids: references(event, receipts.get(event.seq), board) }));
  const structural = new Set<string>();
  for (const composition of canvas.compositions ?? []) for (const id of composition.members) structural.add(id);
  for (const object of canvas.objects) {
    if (object.bindings?.length) structural.add(object.id);
    for (const binding of object.bindings ?? []) structural.add(binding.from.object_id);
    if (object.content.type === "node") {
      const id = object.content.id;
      const node = board.nodes.find(node => node.id === id);
      if (node?.parent_id || board.nodes.some(node => node.parent_id === id) || board.edges.some(edge => edge.from === id || edge.to === id)) structural.add(object.id);
    }
    if (board.edges.some(edge => edge.from === object.id || edge.to === object.id)) structural.add(object.id);
  }
  const items: CleanupItem[] = [];
  for (const object of canvas.objects) {
    if (!scopeIds.has(object.id)) continue;
    const placement = canvas.items.find(item => item.item_id === object.id && !item.removed);
    if (!placement) continue;
    const { title, text } = plainContent(object, board);
    const related = messages.filter(message => message.ids.has(object.id));
    const annotations = (canvas.annotations ?? []).filter(annotation => !annotation.removed && annotation.anchor.object_id === object.id);
    const blocked: CleanupItem["blocked"] = [];
    if (placement.delete_locked) blocked.push("locked");
    if (related.some(message => !message.receipt || !FINISHED_PHASES.has(message.receipt.phase))) blocked.push("pending");
    if (annotations.some(annotation => annotation.status !== "handled")) blocked.push("annotation");
    if (protectedIds.has(object.id)) blocked.push("draft");
    const allHandled = related.every(message => message.receipt?.phase === "handled") && annotations.every(annotation => annotation.status === "handled");
    const evidence = related.some(message => message.receipt?.phase === "handled" && currentEvidence(message.event, object))
      || annotations.some(annotation => annotation.status === "handled" && annotation.anchor.content_revision >= object.content_revision);
    const replied = related.some(message => message.receipt && FINISHED_PHASES.has(message.receipt.phase));
    const origin = originForObject(object, board, feedback.bindings);
    const item: CleanupItem = { id: object.id, title, excerpt: compact(text ?? ""), text,
      reason: allHandled && evidence && !blocked.includes("pending") && !blocked.includes("annotation") ? "handled" : replied ? "replied" : "none",
      blocked, mergeBlocked: structural.has(object.id) || text == null || /!\[[^\]]*\]\s*\(|<(?:img|video|audio|iframe)\b/i.test(text),
      object, placement, origin, route: routeFor(object, board, feedback, origin) };
    snapshots.set(item, { object: JSON.stringify(object), placement: JSON.stringify(placement),
      annotations: annotations.map(annotation => ({ kind: "annotation", id: annotation.id, revision: annotation.revision })) });
    items.push(item);
  }
  const candidates = items.filter(item => !item.blocked.length && !item.mergeBlocked && item.reason !== "handled" && item.text?.trim());
  const tokenMap = new Map(candidates.map(item => [item.id, tokens(item.text!)]));
  const used = new Set<string>();
  const groups: CleanupGroup[] = [];
  // Exact groups take precedence; the second pass adds only pairwise-compatible members.
  for (const exactOnly of [true, false]) for (const item of candidates) {
    if (used.has(item.id)) continue;
    const members = [item];
    for (const candidate of candidates) {
      if (candidate.id === item.id || used.has(candidate.id) || members.length >= 8) continue;
      if (members.every(member => sameContext(member, candidate) && (exactOnly
        ? exactText(member.text!) === exactText(candidate.text!) : similar(member, candidate, tokenMap)))) members.push(candidate);
    }
    if (members.length < 2) continue;
    try {
      const group = mergeCleanupItems(members);
      groups.push(group);
      for (const member of members) used.add(member.id);
    } catch { /* Oversized content remains available for individual archive choices. */ }
  }
  return { items, groups };
}

let fallbackId = 0;
function freshId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++fallbackId).toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

export function prepareCleanup(analysis: CleanupAnalysis, choice: CleanupChoice): CleanupPrepared {
  if (!choice.archiveIds.size && !choice.mergeIds.size) throw new Error("cleanup.empty");
  const items = new Map(analysis.items.map(item => [item.id, item]));
  const groups = new Map(analysis.groups.map(group => [group.id, group]));
  const affected = new Map<string, CleanupItem>();
  const selected: CleanupGroup[] = [];
  const mergedIds = new Set<string>();
  const check = (item: CleanupItem | undefined): CleanupItem => {
    if (!item || item.blocked.length || item.placement.removed) throw new Error("cleanup.changed");
    const snapshot = snapshots.get(item);
    if (snapshot && (snapshot.object !== JSON.stringify(item.object) || snapshot.placement !== JSON.stringify(item.placement))) throw new Error("cleanup.changed");
    if (!Number.isInteger(item.object.content_revision) || !Number.isInteger(item.placement.revision)) throw new Error("cleanup.changed");
    return item;
  };
  for (const id of choice.archiveIds) affected.set(id, check(items.get(id)));
  for (const id of choice.mergeIds) {
    const group = groups.get(id);
    if (!group) throw new Error("cleanup.changed");
    if (group.text.length > 64000) throw new Error("cleanup.limit");
    const members = group.items.map(item => check(items.get(item.id)));
    if (members.some(item => mergedIds.has(item.id))) throw new Error("cleanup.changed");
    let prepared: CleanupGroup;
    try { prepared = mergeCleanupItems(members); } catch { throw new Error("cleanup.changed"); }
    if (prepared.text !== group.text || prepared.title !== group.title || prepared.exact !== group.exact) throw new Error("cleanup.changed");
    selected.push(prepared);
    for (const member of members) { mergedIds.add(member.id); affected.set(member.id, member); }
  }
  const batch: CanvasBatchRequest = { request_id: freshId("cleanup"), reads: [], operations: [] };
  const reads = new Map<string, CanvasRead>();
  for (const item of affected.values()) {
    for (const read of [{ kind: "content" as const, id: item.id, revision: item.object.content_revision },
      { kind: "presentation" as const, id: item.id, revision: item.placement.revision }, ...(snapshots.get(item)?.annotations ?? [])]) reads.set(`${read.kind}:${read.id}`, read);
    batch.operations.push({ op: "place", id: item.id, expected_revision: item.placement.revision, fields: { removed: true } });
  }
  batch.reads = [...reads.values()];
  const createdIds: string[] = [];
  const placements: { x: number; y: number }[] = [];
  for (const group of selected) {
    const id = freshId("text");
    const x = Math.min(...group.items.map(item => item.placement.x));
    let y = Math.min(...group.items.map(item => item.placement.y));
    while (placements.some(other => x < other.x + 440 && x + 440 > other.x && y < other.y + 340 && y + 340 > other.y)) y += 340;
    placements.push({ x, y });
    batch.operations.push({ op: "create", id, content: { type: "text", title: group.title, text: group.text },
      ...(group.items[0].route?.cwd ? { origin: { ...group.items[0].route } } : {}),
      placement: { x, y, width: 420, height: 320, z: Math.max(...group.items.map(item => item.placement.z)) + 1, appearance: "card", removed: false } });
    createdIds.push(id);
  }
  if (batch.operations.length > 64 || batch.reads.length > 128) throw new Error("cleanup.limit");
  return { batch, archivedIds: [...affected.keys()], createdIds };
}
