import { excerpt, mergedEvents, messageRow, originalNavTarget, replyPlain, targetOnBoard, type ContentNavTarget, type FeedbackView, type MessageRow } from "./content-organization";
import { originForObject, resolveContentOrigin, type ContentOrigin } from "./content-origin";
import type { AgentEvent, BoardSnapshot, FeedbackState } from "./types";

export type InboxEntry = {
  row: MessageRow;
  title: string;
  context: string;
  origin: ContentOrigin;
  view: FeedbackView;
  attention: boolean;
  result: string;
  hasResult: boolean;
};

function describeObject(board: BoardSnapshot, id?: string, blockId?: string | null) {
  const object = board.canvas?.objects.find(item => item.id === id);
  if (!object) return { title: "", text: "" };
  const content = object.content;
  if (content.type === "node") {
    const node = board.nodes.find(item => item.id === content.id);
    return { title: node?.title || "", text: node?.body || "" };
  }
  if (content.type === "reply") {
    const reply = board.replies?.find(item => item.id === content.id);
    const block = reply?.blocks.find(item => item.id === blockId);
    return { title: [reply?.title, block?.title].filter(Boolean).join(" / "), text: replyPlain(reply) };
  }
  if (content.type === "block") {
    const block = content.block;
    return { title: block.title || "", text: block.type === "text" ? block.text : "" };
  }
  return { title: "title" in content ? content.title : "", text: "text" in content ? content.text : "alt" in content ? content.alt : "" };
}

function describeTarget(board: BoardSnapshot, target: ContentNavTarget, blockId?: string | null) {
  if (target.objectId || target.objectIds?.length) {
    const parts = (target.objectIds || [target.objectId!]).map(id => describeObject(board, id, blockId));
    return { title: parts.map(item => item.title).filter(Boolean).join(" · "), text: parts.map(item => item.text).filter(Boolean).join("\n") };
  }
  if (target.replyId) {
    const reply = board.replies?.find(item => item.id === target.replyId);
    return { title: reply?.title || "", text: replyPlain(reply) };
  }
  const node = board.nodes.find(item => item.id === target.nodeId);
  return { title: node?.title || "", text: node?.body || "" };
}

/** A request belongs to its recorded recipient, not every object it references. */
function requestOrigin(event: AgentEvent, state: FeedbackState, board: BoardSnapshot): ContentOrigin {
  const receipt = state.deliveries.find(item => item.event.seq === event.seq);
  const threadId = receipt?.desktop?.thread_id || event.target_thread_id;
  const bindings = state.bindings.filter(item => item.source_id === event.source_id && (!threadId || item.thread_id === threadId));
  if (receipt?.desktop?.cwd) return resolveContentOrigin({ cwd: receipt.desktop.cwd, thread_id: threadId || undefined, source_id: event.source_id || undefined }, event.source_id, bindings);
  if (bindings.length) return resolveContentOrigin(undefined, event.source_id, bindings);
  const target = originalNavTarget(event);
  const ids = target.objectIds || (target.objectId ? [target.objectId] : []);
  const object = board.canvas?.objects.find(item => ids.includes(item.id) || (item.content.type === "node" && item.content.id === target.nodeId) || (item.content.type === "reply" && item.content.id === target.replyId));
  if (object) {
    const origin = originForObject(object, board, []);
    const content = object.content;
    const source = content.type === "node" ? board.nodes.find(item => item.id === content.id)?.source_id
      : content.type === "reply" ? board.replies?.find(item => item.id === content.id)?.source_id : object.source_id;
    if (event.source_id && event.source_id === source && (!threadId || origin.taskKey === `thread:${threadId}`)) return origin;
  }
  return resolveContentOrigin(threadId ? { thread_id: threadId } : undefined, event.source_id, []);
}

export function feedbackInbox(state: FeedbackState, board: BoardSnapshot): InboxEntry[] {
  return mergedEvents(state).filter(event => !["canvas_state", "board_edit"].includes(event.kind)).map(event => {
    const row = messageRow(event, state, board);
    const origin = requestOrigin(event, state, board);
    row.taskLabel = origin.taskLabel || null;
    const target = event.target_thread_id || row.receipt?.desktop?.thread_id;
    row.unbound = !state.bindings.some(binding => binding.source_id === event.source_id && (!target || binding.thread_id === target));
    if (target && !state.bindings.some(binding => binding.source_id === event.source_id && binding.thread_id === target)) row.canRetry = Boolean(row.receipt?.desktop?.accepted_at_ms);
    const description = describeTarget(board, row.originalTarget, event.anchors?.[0]?.block_id || event.block_id);
    const explicit = event.kind === "say" || event.kind === "reply";
    const historical = !explicit || (row.status === "queued" && !row.receipt?.desktop);
    const view: FeedbackView = historical ? "activity" : ["responded", "handled"].includes(row.status) ? "replied" : "followup";
    const hasResult = Boolean(row.responseTarget && !row.responseTarget.missing && targetOnBoard(row.responseTarget, board));
    return { row, origin, view, title: description.title || event.title || "", context: excerpt(description.text, 500),
      attention: view === "followup" && (row.unbound || ["failed", "unknown", "unanswered", "none"].includes(row.status)),
      hasResult, result: hasResult ? excerpt(describeTarget(board, row.responseTarget!).text, 240) : "" };
  }).sort((a, b) => b.row.at_ms - a.row.at_ms || b.row.seq - a.row.seq);
}

export function filterInbox(entries: InboxEntry[], workspace = "all", task = "all", query = "", view?: FeedbackView) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(entry => (workspace === "all" || entry.origin.workspaceKey === workspace)
    && (task === "all" || entry.origin.taskKey === task) && (!view || entry.view === view)
    && (!needle || [entry.title, entry.row.text, entry.origin.cwd, entry.origin.taskLabel, entry.result].join("\n").toLocaleLowerCase().includes(needle)));
}
