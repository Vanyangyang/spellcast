import type { BoardReply, ReplyBlock } from "./reply-types";
import type { CanvasObject, CanvasAnchor } from "./types";

export type DraftRecord = {
  object_id?: string;
  anchors?: CanvasAnchor[];
  target_source_id?: string;
  source_id: string;
  reply_id: string;
  reply_title: string;
  block_id: string;
  block_type: ReplyBlock["type"];
  kind: "edit" | "ask";
  channel?: "composer";
  expected_revision: number;
  updated_at: number;
  block?: ReplyBlock;
  base_block?: ReplyBlock;
  text?: string;
  context?: { label: string; prefix: string; artifact_context?: import("./reply-types").ArtifactFeedback } | null;
  focus_id?: string | null;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const STORAGE_KEY = "spellcast.reply-drafts.v1";
const MAX_RECORDS = 96;
const MAX_CHARACTERS = 1_500_000;

export function draftKey(record: Pick<DraftRecord, "object_id" | "source_id" | "reply_id" | "block_id" | "block_type" | "kind" | "context" | "channel" | "anchors" | "target_source_id">): string {
  const target = record.object_id ? ["object", record.object_id] : [record.source_id, record.reply_id];
  return JSON.stringify([...target, record.block_id, record.block_type, record.kind, record.kind === "ask" ? record.context?.prefix ?? "" : "", record.channel ?? "block",
    ...(record.kind === "ask" && record.context?.artifact_context ? [contentKey(record.context.artifact_context)] : []),
    ...(record.kind === "ask" && record.anchors?.length ? [contentKey(record.anchors), record.target_source_id ?? ""] : [])]);
}

/** Object-key order and omitted empty optional fields are not content changes. */
export function contentKey(value: unknown): string {
  function normalized(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalized);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).filter(([key, v]) => v != null && !(v === "" && ["title", "detail", "feedback", "note"].includes(key)))
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalized(v)]));
    }
    return input;
  }
  return JSON.stringify(normalized(value));
}

export function semanticBlockKey(block: ReplyBlock): string {
  if (block.type === "artifact") return contentKey({ ...block, state: null, state_revision: 0 });
  return contentKey(block.type === "graph" ? { ...block, nodes: block.nodes.map(({ x: _x, y: _y, ...node }) => node) } : block);
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 256 && value.every(v => typeof v === "string"); }
function validBlock(value: unknown): value is ReplyBlock {
  if (!object(value) || typeof value.id !== "string" || (value.title !== undefined && typeof value.title !== "string")) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "artifact") return typeof value.bundle_id === "string" && typeof value.description === "string" && Number.isSafeInteger(value.state_revision) && (value.state == null || object(value.state));
  if (value.type === "comparison") return strings(value.criteria) && Array.isArray(value.options) && value.options.length <= 128
    && value.options.every(o => object(o) && typeof o.id === "string" && typeof o.title === "string" && typeof o.summary === "string" && strings(o.values));
  if (value.type === "graph") return Array.isArray(value.nodes) && value.nodes.length <= 256 && Array.isArray(value.edges) && value.edges.length <= 512
    && value.nodes.every(n => object(n) && typeof n.id === "string" && typeof n.title === "string" && (n.detail == null || typeof n.detail === "string") && [n.x, n.y].every(v => v == null || (typeof v === "number" && Number.isFinite(v))))
    && value.edges.every(e => object(e) && [e.id, e.from, e.to, e.label].every(v => typeof v === "string"));
  if (value.type === "sequence") return Array.isArray(value.steps) && value.steps.length <= 256
    && value.steps.every(s => object(s) && [s.id, s.title, s.action].every(v => typeof v === "string") && [s.feedback, s.note].every(v => v == null || typeof v === "string"));
  return false;
}

function validRecord(value: unknown): value is DraftRecord {
  if (!object(value) || ![value.source_id, value.reply_id, value.reply_title, value.block_id].every(v => typeof v === "string")
      || (value.object_id != null && (typeof value.object_id !== "string" || !value.object_id || value.object_id.length > 160))
      || (value.target_source_id != null && typeof value.target_source_id !== "string")
      || (value.anchors != null && (!Array.isArray(value.anchors) || value.anchors.length > 32 || !value.anchors.every(anchor => object(anchor) && typeof anchor.object_id === "string" && Number.isSafeInteger(anchor.content_revision))))
      || !["text", "comparison", "graph", "sequence", "artifact"].includes(String(value.block_type))
      || (value.channel != null && value.channel !== "composer")
      || !Number.isSafeInteger(value.expected_revision) || !Number.isFinite(value.updated_at)) return false;
  if (value.context != null && (!object(value.context) || typeof value.context.label !== "string" || typeof value.context.prefix !== "string")) return false;
  if (value.kind === "ask") return typeof value.text === "string";
  return value.kind === "edit" && validBlock(value.block) && validBlock(value.base_block)
    && value.block.id === value.block_id && value.block.type === value.block_type;
}

export class DraftStore {
  private records = new Map<string, DraftRecord>();
  private pending = new Map<string, DraftRecord | null>();
  private loaded = false;
  private listeners = new Set<() => void>();
  private storage: () => StorageLike;
  lastError: "storage" | "invalid" | "full" | null = null;

  constructor(storage: () => StorageLike = () => globalThis.localStorage) { this.storage = storage; }

  private read(): Map<string, DraftRecord> {
    const raw = this.storage().getItem(STORAGE_KEY);
    if (!raw) return new Map();
    if (raw.length > MAX_CHARACTERS) throw new Error("full");
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > MAX_RECORDS || !values.every(validRecord)) throw new Error("invalid");
    return new Map(values.map(value => [draftKey(value), value]));
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try { this.records = this.read(); }
    catch { this.lastError = "storage"; }
  }

  private flush(): boolean {
    try {
      // Merge only this window's changes into the latest saved collection.
      const records = this.read();
      for (const [key, value] of this.pending) { if (value) records.set(key, value); else records.delete(key); }
      const serialized = JSON.stringify([...records.values()]);
      if (records.size > MAX_RECORDS || serialized.length > MAX_CHARACTERS) { this.lastError = "full"; return false; }
      this.storage().setItem(STORAGE_KEY, serialized);
      this.records = records; this.pending.clear(); this.lastError = null;
      return true;
    } catch { this.lastError = "storage"; return false; }
  }

  list(): DraftRecord[] { this.load(); return [...this.records.values()].sort((a, b) => b.updated_at - a.updated_at).map(value => structuredClone(value)); }

  /** Migrate only resolvable legacy keys, in the same atomic localStorage write. */
  bindObjects(objects: CanvasObject[], replies: Pick<BoardReply, "id" | "source_id">[]): void {
    this.load();
    let changed = false;
    for (const [oldKey, record] of [...this.records]) {
      if (record.object_id) continue;
      const target = objects.find(object => object.content.type === "reply"
        ? object.content.id === record.reply_id && replies.some(reply => reply.id === record.reply_id && reply.source_id === record.source_id)
        : object.content.type === "node" && record.reply_id === `node:${object.content.id}` && record.source_id === `node:${object.content.id}`);
      if (!target) continue; // Orphaned drafts remain readable and exportable.
      const migrated = { ...record, object_id: target.id }, key = draftKey(migrated), existing = this.records.get(key);
      if (existing && contentKey({ ...existing, updated_at: 0 }) !== contentKey({ ...migrated, updated_at: 0 })) continue;
      this.records.delete(oldKey); this.pending.set(oldKey, null);
      if (!existing) { this.records.set(key, migrated); this.pending.set(key, migrated); }
      changed = true;
    }
    if (changed) { this.flush(); this.changed(); }
  }
  get(key: string): DraftRecord | undefined { this.load(); const value = this.records.get(key); return value ? structuredClone(value) : undefined; }
  /** Startup recomputes inputs. Recover a unique draft for the same references without rewriting its saved evidence. */
  getComposer(record: DraftRecord): DraftRecord | undefined {
    const exact = this.get(draftKey(record));
    if (exact || record.channel !== "composer" || !record.anchors?.length) return exact;
    const targetKey = (draft: DraftRecord) => draftKey({ ...draft, anchors: draft.anchors?.map(({ inputs: _inputs, ...anchor }) => anchor) });
    const key = targetKey(record), matches = [...this.records.values()].filter(draft => draft.channel === "composer" && targetKey(draft) === key);
    return matches.length === 1 ? structuredClone(matches[0]) : undefined;
  }
  get hasUnpersisted(): boolean { return [...this.pending.values()].some(Boolean); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }

  put(record: DraftRecord): boolean {
    this.load();
    if (!validRecord(record)) { this.lastError = "invalid"; return false; }
    const key = draftKey(record); const copy = structuredClone(record);
    const previous = this.records.get(key);
    copy.updated_at = previous && contentKey({ ...previous, updated_at: 0 }) === contentKey({ ...copy, updated_at: 0 })
      ? previous.updated_at : Math.max(Date.now(), (previous?.updated_at ?? 0) + 1);
    this.records.set(key, copy); this.pending.set(key, copy);
    const saved = this.flush(); this.changed(); return saved;
  }

  remove(key: string, expectedStamp?: number): boolean {
    this.load();
    const previous = this.records.get(key);
    if (!previous) return true;
    if (expectedStamp !== undefined && previous.updated_at !== expectedStamp) return false;
    if (expectedStamp !== undefined && !this.pending.has(key)) {
      try {
        const latest = this.read().get(key);
        if (latest && contentKey(latest) !== contentKey(previous)) {
          this.records.set(key, latest); this.changed(); return false;
        }
      } catch { /* A failed flush below restores the held draft. */ }
    }
    this.records.delete(key); this.pending.set(key, null);
    const saved = this.flush();
    if (!saved && previous) { this.records.set(key, previous); this.pending.set(key, previous); }
    this.changed(); return saved;
  }
}

export const replyDrafts = new DraftStore();

export function draftText(record: DraftRecord): string {
  if (record.kind === "ask") return (record.context?.prefix ?? "") + (record.text ?? "");
  const block = record.block;
  if (!block) return "";
  const title = block.title ? block.title + "\n\n" : "";
  switch (block.type) {
    case "text": return title + block.text;
    case "artifact": return title + block.description + "\n" + block.bundle_id;
    case "comparison": return title + block.options.map(option => option.title + "\n" + option.summary + "\n" + block.criteria.map((criterion, i) => `${criterion}: ${option.values[i] ?? ""}`).join("\n")).join("\n\n");
    case "graph": return title + block.nodes.map(node => node.title + (node.detail ? `: ${node.detail}` : "")).join("\n") + "\n\n" + block.edges.map(edge => `${block.nodes.find(n => n.id === edge.from)?.title ?? edge.from} → ${block.nodes.find(n => n.id === edge.to)?.title ?? edge.to}: ${edge.label}`).join("\n");
    case "sequence": return title + block.steps.map((step, i) => `${i + 1}. ${step.title}\n${step.action}\n${step.feedback ?? ""}\n${step.note ?? ""}`).join("\n\n");
  }
}
