import type { BoardReply, ReplyBlock } from "./reply-types";
import type { CanvasObject } from "./types";

export type StructuredAtom = Exclude<ReplyBlock, { type: "artifact" }>;

/** A renderer adapter only. The object remains the sole stored content identity. */
export function blockReply(object: CanvasObject): BoardReply {
  if (object.content.type !== "block") throw new Error("Expected an independent block object.");
  return { id: object.id, object_id: object.id, source_id: object.source_id || `canvas:${object.id}`,
    source_label: "", title: object.content.block.title || "", blocks: [object.content.block],
    revision: object.content_revision, created_at_ms: 0, updated_at_ms: object.content_revision };
}

export function defaultAtom(type: StructuredAtom["type"], title: string): StructuredAtom {
  const id = crypto.randomUUID();
  switch (type) {
    case "text": return { type, id, title, text: title };
    case "comparison": return { type, id, title, criteria: ["维度"], options: [
      { id: crypto.randomUUID(), title: "方案 A", summary: "", values: ["待填写"] },
      { id: crypto.randomUUID(), title: "方案 B", summary: "", values: ["待填写"] },
    ] };
    case "graph": return { type, id, title, nodes: [{ id: crypto.randomUUID(), title, detail: "" }], edges: [] };
    case "sequence": return { type, id, title, steps: [{ id: crypto.randomUUID(), title: "第一步", action: "待填写", feedback: "", note: "" }] };
  }
}
