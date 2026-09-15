import type { ArtifactBundle } from "./reply-types";
import type { BoardSnapshot, CanvasObject } from "./types";
import type { ArtifactIO, CanvasDataSource, CanvasInputSnapshot, CanvasPortType, CanvasPortValue, CanvasScalar } from "./canvas-data-types";

const EMPTY_IO: ArtifactIO = { inputs: {}, outputs: {} };
const TYPES = new Set<CanvasPortType>(["number", "string", "boolean", "null"]);
const NAME = /^[A-Za-z0-9_:.-]{1,160}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const keyOf = (objectId: string, blockId: string) => `${objectId}\u0000${blockId}`;
const splitKey = (key: string) => { const at = key.indexOf("\u0000"); return [key.slice(0, at), key.slice(at + 1)] as const; };

export type CanvasFrameToken = Readonly<{ key: string; epoch: number }>;
type Status = "notready" | "ready" | "error";
type Producer = {
  token: CanvasFrameToken;
  objectId: string;
  blockId: string;
  bundleId: string;
  io: ArtifactIO | null;
  stateRevision: number;
  contentRevision: number;
  awaitingStateRevision?: number;
  status: Status;
  reason?: string;
  output?: { values: Record<string, CanvasScalar>; input: string; contentRevision: number; stateRevision: number };
};

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validName(name: string) { return NAME.test(name) && !FORBIDDEN.has(name); }
function scalar(value: unknown, type?: CanvasPortType): value is CanvasScalar {
  if (value === null) return type === undefined || type === "null";
  if (typeof value === "number") return (type === undefined || type === "number") && Number.isFinite(value);
  if (typeof value === "string") return (type === undefined || type === "string") && new TextEncoder().encode(value).length <= 16_000;
  return typeof value === "boolean" && (type === undefined || type === "boolean");
}

function readIO(value: ArtifactBundle["io"]): ArtifactIO | null {
  const io = value ?? EMPTY_IO;
  if (!plain(io) || !plain(io.inputs) || !plain(io.outputs)) return null;
  if (Object.keys(io.inputs).length > 32 || Object.keys(io.outputs).length > 32) return null;
  for (const ports of [io.inputs, io.outputs]) {
    for (const [name, type] of Object.entries(ports)) if (!validName(name) || !TYPES.has(type)) return null;
  }
  return bytes(io) <= 64_000 ? { inputs: { ...io.inputs }, outputs: { ...io.outputs } } : null;
}

function cloneSnapshot(snapshot: CanvasInputSnapshot): CanvasInputSnapshot { return structuredClone(snapshot); }
function unavailable(reason: string, sources: CanvasDataSource[] = []): CanvasPortValue { return { status: "unavailable", reason, sources }; }
function sourceKey(source: CanvasDataSource) { return `${source.object_id}\u0000${source.content_revision}\u0000${source.block_id}\u0000${source.bundle_id}\u0000${source.state_revision}`; }
function sources(...groups: CanvasDataSource[][]) {
  const seen = new Set<string>(), result: CanvasDataSource[] = [];
  for (const source of groups.flat()) if (!seen.has(sourceKey(source))) { seen.add(sourceKey(source)); result.push(source); }
  return result;
}

/** In-memory work data. Runtime values deliberately have no storage path. */
export class CanvasDataflow {
  private board: BoardSnapshot = { topic: "", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [] };
  private producers = new Map<string, Producer>();
  private snapshots = new Map<string, CanvasInputSnapshot>();
  private forceRevision = new Set<string>();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private revision = 0;
  private destroyed = false;
  private notifying = false;
  private notifyAgain = false;

  update(board: BoardSnapshot) {
    if (this.destroyed) return;
    for (const producer of this.producers.values()) this.updateIdentity(producer, board);
    this.board = board;
    this.recompute();
  }

  snapshot(objectId: string, blockId?: string): CanvasInputSnapshot {
    return cloneSnapshot(this.snapshots.get(keyOf(objectId, blockId ?? "")) ?? { revision: 0, ports: {} });
  }

  subscribe(listener: () => void): () => void {
    if (this.destroyed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  register(objectId: string, blockId: string, bundle: ArtifactBundle, stateRevision: number): CanvasFrameToken {
    const key = keyOf(objectId, blockId), token = Object.freeze({ key, epoch: ++this.epoch });
    const current = this.artifact(this.board, objectId, blockId);
    const identityValid = current?.block.bundle_id === bundle.id && current.object.content.type === "reply" &&
      current.object.content.id === bundle.reply_id && bundle.block_id === blockId;
    const producer: Producer = {
      token, objectId, blockId, bundleId: bundle.id, io: identityValid ? readIO(bundle.io) : null, stateRevision,
      contentRevision: current?.object.content_revision ?? 0, status: "notready",
    };
    if (!producer.io) { producer.status = "error"; producer.reason = "invalid port declarations"; }
    this.producers.set(key, producer);
    this.enforceDeclarationLimit(objectId);
    this.recompute();
    return token;
  }

  unregister(token: CanvasFrameToken) {
    const current = this.producers.get(token.key);
    if (!current || current.token !== token) return;
    this.producers.delete(token.key);
    this.recompute();
  }

  ready(token: CanvasFrameToken) {
    const producer = this.get(token); if (!producer || !producer.io) return;
    if (producer.status === "error") return;
    producer.status = "ready"; producer.reason = undefined; this.recompute();
  }

  error(token: CanvasFrameToken, reason = "work error") {
    const producer = this.get(token); if (!producer) return;
    producer.status = "error"; producer.reason = reason.slice(0, 2000); producer.output = undefined; this.recompute();
  }

  invalidate(token: CanvasFrameToken, reason = "work state changed") {
    const producer = this.get(token); if (!producer) return;
    producer.output = undefined; producer.reason = reason; this.forceRevision.add(token.key); this.recompute();
  }

  commit(token: CanvasFrameToken, stateRevision: number) {
    const producer = this.get(token); if (!producer || !Number.isSafeInteger(stateRevision) || stateRevision < producer.stateRevision) return;
    producer.stateRevision = stateRevision; producer.awaitingStateRevision = stateRevision; producer.output = undefined; producer.reason = undefined;
    this.recompute();
  }

  publish(token: CanvasFrameToken, expectedInputRevision: number, value: unknown): boolean {
    const producer = this.get(token), snapshot = producer && this.snapshots.get(token.key);
    const current = producer && this.artifact(this.board, producer.objectId, producer.blockId);
    if (!producer || current?.block.bundle_id !== producer.bundleId || producer.status !== "ready" || !producer.io || !snapshot || snapshot.revision !== expectedInputRevision) return false;
    const reject = () => {
      producer.status = "error"; producer.reason = "invalid output payload"; producer.output = undefined; this.recompute(); return false;
    };
    if (!plain(value)) return reject();
    const values: Record<string, CanvasScalar> = {};
    for (const [name, item] of Object.entries(value)) {
      const type = producer.io.outputs[name];
      if (!validName(name) || !type || !scalar(item, type)) return reject();
      values[name] = item;
    }
    const aggregate: Record<string, Record<string, CanvasScalar>> = {};
    for (const other of this.producers.values()) if (other.objectId === producer.objectId && other.output && other !== producer) aggregate[other.blockId] = other.output.values;
    aggregate[producer.blockId] = values;
    if (bytes(aggregate) > 64_000) return reject();
    producer.output = { values, input: this.portSignature(snapshot.ports), contentRevision: producer.contentRevision, stateRevision: producer.stateRevision };
    producer.reason = undefined;
    this.recompute();
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.producers.clear(); this.snapshots.clear(); this.listeners.clear();
  }

  private get(token: CanvasFrameToken) { const producer = this.producers.get(token.key); return producer?.token === token ? producer : undefined; }

  private enforceDeclarationLimit(objectId: string) {
    const declarations: Record<string, ArtifactIO> = {};
    for (const producer of this.producers.values()) if (producer.objectId === objectId && producer.io) declarations[producer.blockId] = producer.io;
    if (bytes(declarations) <= 64_000) return;
    for (const producer of this.producers.values()) if (producer.objectId === objectId) {
      producer.io = null; producer.status = "error"; producer.reason = "port declarations exceed 64 KB"; producer.output = undefined;
    }
  }

  private updateIdentity(producer: Producer, board: BoardSnapshot) {
    const current = this.artifact(board, producer.objectId, producer.blockId);
    if (!current || current.block.bundle_id !== producer.bundleId) { producer.output = undefined; return; }
    const contentRevision = current.object.content_revision, stateRevision = current.block.state_revision;
    if (producer.awaitingStateRevision !== undefined) {
      if (stateRevision < producer.awaitingStateRevision) return;
      if (stateRevision === producer.awaitingStateRevision) {
        if (producer.output) producer.output.contentRevision = contentRevision;
        producer.contentRevision = contentRevision; producer.awaitingStateRevision = undefined; return;
      }
      producer.awaitingStateRevision = undefined;
    }
    if (producer.stateRevision !== stateRevision) producer.output = undefined;
    else if (producer.output) producer.output.contentRevision = contentRevision;
    producer.contentRevision = contentRevision; producer.stateRevision = stateRevision;
  }

  private artifact(board: BoardSnapshot, objectId: string, blockId: string) {
    const object = board.canvas?.objects.find(item => item.id === objectId);
    if (!object || object.content.type !== "reply") return undefined;
    const replyId = object.content.id;
    const reply = board.replies?.find(item => item.id === replyId);
    const block = reply?.blocks.find(item => item.id === blockId);
    return block?.type === "artifact" ? { object, block } : undefined;
  }

  private hidden(objectId: string) {
    const item = this.board.canvas?.items.find(item => item.item_id === objectId);
    return !item || item.removed;
  }

  private identity(object: CanvasObject, blockId: string): CanvasDataSource | undefined {
    if (object.content.type !== "reply") return undefined;
    const replyId = object.content.id;
    const block = this.board.replies?.find(reply => reply.id === replyId)?.blocks.find(item => item.id === blockId);
    if (block?.type !== "artifact") return undefined;
    const producer = this.producers.get(keyOf(object.id, blockId));
    return { object_id: object.id, content_revision: producer?.contentRevision ?? object.content_revision, block_id: block.id,
      bundle_id: block.bundle_id, state_revision: producer?.stateRevision ?? block.state_revision };
  }

  private targetKeys() {
    const keys = new Set(this.producers.keys());
    for (const object of this.board.canvas?.objects ?? []) {
      if (object.content.type === "text" && object.bindings?.some(binding => binding.to.block_id == null && binding.to.port === "text")) keys.add(keyOf(object.id, ""));
    }
    return [...keys].sort();
  }

  private inputPorts(targetKey: string, oversized: Set<string>, stack: Set<string>, memo: Map<string, Record<string, CanvasPortValue>>): Record<string, CanvasPortValue> {
    const cached = memo.get(targetKey); if (cached) return cached;
    const [objectId, blockId] = splitKey(targetKey), object = this.board.canvas?.objects.find(item => item.id === objectId);
    if (!object) return {};
    const producer = blockId ? this.producers.get(targetKey) : undefined;
    const declarations = producer?.io?.inputs ?? (blockId ? {} : { text: "string" as CanvasPortType });
    const ports: Record<string, CanvasPortValue> = {};
    for (const [port, type] of Object.entries(declarations)) {
      if (oversized.has(targetKey)) { ports[port] = unavailable("input snapshot exceeds 64 KB"); continue; }
      const matching = (object.bindings ?? []).filter(binding => (binding.to.block_id ?? "") === blockId && binding.to.port === port);
      if (matching.length !== 1) { ports[port] = unavailable(matching.length ? "multiple connections" : "unconnected"); continue; }
      const binding = matching[0], sourceObject = this.board.canvas?.objects.find(item => item.id === binding.from.object_id);
      const immediate = sourceObject ? this.identity(sourceObject, binding.from.block_id) : undefined;
      if (!sourceObject || !immediate) { ports[port] = unavailable("source is missing"); continue; }
      const sourceProducer = this.producers.get(keyOf(sourceObject.id, binding.from.block_id));
      const outputType = sourceProducer?.io?.outputs[binding.from.port];
      if (!outputType || (blockId && outputType !== type)) { ports[port] = unavailable("port declaration mismatch", [immediate]); continue; }
      ports[port] = this.output(sourceProducer!, binding.from.port, immediate, oversized, stack, memo);
    }
    memo.set(targetKey, ports); return ports;
  }

  private output(producer: Producer, port: string, immediate: CanvasDataSource, oversized: Set<string>, stack: Set<string>,
    memo: Map<string, Record<string, CanvasPortValue>>): CanvasPortValue {
    if (stack.has(producer.token.key)) return unavailable("cyclic dependency", [immediate]);
    if (this.hidden(producer.objectId)) return unavailable("producer is hidden", [immediate]);
    if (producer.status !== "ready") return unavailable(producer.reason ?? (producer.status === "error" ? "producer failed" : "producer is not ready"), [immediate]);
    const next = new Set(stack); next.add(producer.token.key);
    const inputs = this.inputPorts(producer.token.key, oversized, next, memo), dependencies = sources(...Object.values(inputs).map(value => value.sources));
    if (Object.values(inputs).some(value => value.status !== "available")) return unavailable("upstream input unavailable", sources([immediate], dependencies));
    const record = producer.output, value = record?.values[port];
    if (!record || record.contentRevision !== producer.contentRevision || record.stateRevision !== producer.stateRevision ||
      record.input !== this.portSignature(inputs) || value === undefined && !(port in record.values)) return unavailable("output is unavailable", sources([immediate], dependencies));
    return { status: "available", value, sources: sources([immediate], dependencies) };
  }

  private portSignature(ports: Record<string, CanvasPortValue>) { return JSON.stringify(ports); }

  private calculate(keys: string[], oversized: Set<string>) {
    const result = new Map<string, Record<string, CanvasPortValue>>(), memo = new Map<string, Record<string, CanvasPortValue>>();
    for (const key of keys) result.set(key, this.inputPorts(key, oversized, new Set([key]), memo));
    return result;
  }

  private recompute() {
    if (this.destroyed) return;
    const keys = this.targetKeys();
    let calculated = this.calculate(keys, new Set());
    const byObject = new Map<string, Record<string, Record<string, CanvasPortValue>>>();
    for (const [key, ports] of calculated) {
      const [objectId, blockId] = splitKey(key), object = byObject.get(objectId) ?? {};
      object[blockId] = ports; byObject.set(objectId, object);
    }
    const oversized = new Set<string>();
    for (const [objectId, value] of byObject) if (bytes(value) > 64_000) for (const key of keys) if (splitKey(key)[0] === objectId) oversized.add(key);
    if (oversized.size) calculated = this.calculate(keys, oversized);

    let changed = false;
    const next = new Map<string, CanvasInputSnapshot>();
    for (const key of keys) {
      const ports = calculated.get(key) ?? {}, previous = this.snapshots.get(key);
      const same = previous && !this.forceRevision.has(key) && this.portSignature(previous.ports) === this.portSignature(ports);
      next.set(key, same ? previous : { revision: ++this.revision, ports });
      if (!same) changed = true;
    }
    if ([...this.snapshots.keys()].some(key => !next.has(key))) changed = true;
    this.snapshots = next;
    this.forceRevision.clear();
    if (changed) this.notify();
  }

  private notify() {
    if (this.notifying) { this.notifyAgain = true; return; }
    this.notifying = true;
    do {
      this.notifyAgain = false;
      for (const listener of [...this.listeners]) listener();
    } while (this.notifyAgain && !this.destroyed);
    this.notifying = false;
  }
}
