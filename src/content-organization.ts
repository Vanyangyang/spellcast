import type { AgentEvent, BoardNode, BoardSnapshot, CanvasObject, CapturedContext, CodexBinding, DeliveryPhase, DeliveryReceipt, FeedbackState } from "./types";
import type { BoardReply, ReplyBlock } from "./reply-types";
import { originForObject, resolveContentOrigin, type ContentOrigin } from "./content-origin";

export const USER_MESSAGE_KINDS = new Set(["say", "reply", "selection", "reply_edit"]);
export const FOLLOW_UP_PHASES = new Set<DeliveryPhase>(["waiting", "dispatching", "submitted", "unanswered", "queued", "received", "failed", "unknown"]);
export const REPLIED_PHASES = new Set<DeliveryPhase>(["responded", "handled"]);

export type FeedbackView = "followup" | "replied" | "activity";

export type ContentNavTarget = {
  objectId?: string;
  objectIds?: string[];
  replyId?: string;
  nodeId?: string;
  missing?: boolean;
  missingReason?: "response" | "content";
};

export type ContentIdentity = {
  key: string;
  type: "node" | "reply" | "object" | "composite" | "unknown";
  objectId?: string;
  nodeId?: string;
  replyId?: string;
  objectIds?: string[];
};

export type MessageRow = {
  seq: number;
  kind: string;
  text: string;
  at_ms: number;
  source_id?: string | null;
  taskLabel: string | null;
  unbound: boolean;
  receipt?: DeliveryReceipt;
  status: DeliveryPhase | "none";
  canRetry: boolean;
  responseTarget: ContentNavTarget | null;
  originalTarget: ContentNavTarget;
};

export type DiscussionCard = {
  key: string;
  identity: ContentIdentity;
  title: string;
  excerpt: string;
  background: string;
  originKind: "captured" | "associated" | "unsorted";
  associatedLabel: string | null;
  messages: MessageRow[];
};

export type OverviewProject = {
  kind: "captured" | "associated" | "unsorted";
  key: string;
  label: string;
};

export type OverviewItem = {
  objectId: string;
  contentType: CanvasObject["content"]["type"];
  contentId?: string;
  title: string;
  excerpt: string;
  background: string;
  project: OverviewProject;
  origin: ContentOrigin;
  revision: number;
};

export function isUserMessage(kind: string) {
  return USER_MESSAGE_KINDS.has(kind);
}

export function receiptFor(state: FeedbackState, seq: number) {
  return state.deliveries.find((item) => item.event.seq === seq);
}

export function mergedEvents(state: FeedbackState): AgentEvent[] {
  const map = new Map<number, AgentEvent>();
  for (const receipt of state.deliveries) map.set(receipt.event.seq, receipt.event);
  for (const event of state.pending) map.set(event.seq, event);
  return [...map.values()].sort((a, b) => b.seq - a.seq);
}

export function followUpEvents(state: FeedbackState): AgentEvent[] {
  return mergedEvents(state).filter((event) => {
    if (!isUserMessage(event.kind)) return false;
    const receipt = receiptFor(state, event.seq);
    if (!receipt) return true;
    return FOLLOW_UP_PHASES.has(receipt.phase);
  });
}

export function repliedEvents(state: FeedbackState): AgentEvent[] {
  return mergedEvents(state).filter((event) => {
    if (!isUserMessage(event.kind)) return false;
    const receipt = receiptFor(state, event.seq);
    return Boolean(receipt && REPLIED_PHASES.has(receipt.phase));
  });
}

export function activityEvents(state: FeedbackState): AgentEvent[] {
  return mergedEvents(state).filter((event) => !isUserMessage(event.kind));
}

export function followUpCount(state: FeedbackState) {
  return followUpEvents(state).length;
}

export function bindingFor(bindings: CodexBinding[], sourceId?: string | null) {
  if (!sourceId) return undefined;
  return bindings.find((item) => item.source_id === sourceId);
}

export function canRetry(receipt: DeliveryReceipt | undefined, bindings: CodexBinding[]) {
  if (!receipt) return false;
  if (receipt.phase !== "failed" && receipt.phase !== "unknown" && receipt.phase !== "unanswered") return false;
  if (receipt.desktop?.accepted_at_ms) return true;
  return Boolean(bindingFor(bindings, receipt.event.source_id));
}

export function objectForContent(board: BoardSnapshot, type: "node" | "reply", id: string) {
  return board.canvas?.objects.find((object) => object.content.type === type && object.content.id === id);
}

export function identityFromEvent(event: AgentEvent, board: BoardSnapshot): ContentIdentity {
  const anchorIds = [...new Set((event.anchors ?? []).map((anchor) => anchor.object_id).filter(Boolean))];
  if (anchorIds.length > 1) {
    const objectIds = [...anchorIds].sort();
    return { key: `composite:${objectIds.join(",")}`, type: "composite", objectIds };
  }
  const objectId = anchorIds[0] || event.object_id || undefined;
  if (objectId) {
    const object = board.canvas?.objects.find((item) => item.id === objectId);
    if (object?.content.type === "node") return identityForNode(object.content.id, object.id, board);
    if (object?.content.type === "reply") return identityForReply(object.content.id, object.id, board);
    return { key: `object:${objectId}`, type: "object", objectId };
  }
  if (event.reply_id) {
    const object = objectForContent(board, "reply", event.reply_id);
    return identityForReply(event.reply_id, object?.id, board);
  }
  if (event.node_id) {
    const object = objectForContent(board, "node", event.node_id);
    return identityForNode(event.node_id, object?.id, board);
  }
  return { key: `event:${event.seq}`, type: "unknown" };
}

function identityForNode(nodeId: string, objectId: string | undefined, _board: BoardSnapshot): ContentIdentity {
  return { key: `node:${nodeId}`, type: "node", nodeId, objectId };
}

function identityForReply(replyId: string, objectId: string | undefined, board: BoardSnapshot): ContentIdentity {
  const reply = board.replies?.find((item) => item.id === replyId);
  if (reply?.origin_node_id) {
    const nodeObject = objectForContent(board, "node", reply.origin_node_id);
    return identityForNode(reply.origin_node_id, nodeObject?.id, board);
  }
  return { key: `reply:${replyId}`, type: "reply", replyId, objectId };
}

export function excerpt(text: string, limit = 120) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, Math.max(1, limit - 1)) + "…";
}

/** Navigation label only; the original text and its optional title stay untouched. */
export function textLabel(text: string) {
  const first = text.split(/\r?\n/).find(line => line.trim()) || "";
  return excerpt(first.replace(/^\s*(?:#{1,6}\s+|>\s*)/, "").replace(/(\*\*|__|`)(.*?)\1/g, "$2").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"), 64);
}

export function backgroundLine(context?: CapturedContext | null) {
  if (!context) return "";
  return [context.project, context.change || context.goal].filter(Boolean).join(" · ");
}

export function replyPlain(reply?: BoardReply | null) {
  if (!reply) return "";
  return [reply.title, ...(reply.blocks ?? []).map(blockPlain)].filter(Boolean).join("\n");
}

function blockPlain(block: ReplyBlock) {
  switch (block.type) {
    case "text":
      return [block.title, block.text].filter(Boolean).join("\n");
    case "comparison":
      return [block.title, ...block.options.map((option) => option.title)].filter(Boolean).join("\n");
    case "graph":
      return [block.title, ...block.nodes.map((node) => node.title)].filter(Boolean).join("\n");
    case "sequence":
      return [block.title, ...block.steps.map((step) => step.title)].filter(Boolean).join("\n");
    case "artifact":
      return [block.title, block.description].filter(Boolean).join("\n");
  }
}

export function originalNavTarget(event: AgentEvent): ContentNavTarget {
  if (event.anchors?.length) {
    const objectIds = event.anchors.map((anchor) => anchor.object_id);
    return { objectId: objectIds[0], objectIds };
  }
  if (event.object_id) return { objectId: event.object_id };
  if (event.reply_id) return { replyId: event.reply_id };
  if (event.node_id) return { nodeId: event.node_id };
  return { missing: true, missingReason: "content" };
}

export function responseNavTarget(receipt?: DeliveryReceipt | null): ContentNavTarget | null {
  if (!receipt) return null;
  const objectIds = (receipt.response_object_ids ?? []).filter(Boolean);
  if (objectIds.length) {
    return { objectId: objectIds[0], objectIds, replyId: receipt.response_reply_id || undefined };
  }
  if (receipt.response_reply_id) return { replyId: receipt.response_reply_id };
  if (REPLIED_PHASES.has(receipt.phase)) return { missing: true, missingReason: "response" };
  return null;
}

export function targetOnBoard(target: ContentNavTarget, board: BoardSnapshot) {
  if (target.missing) return false;
  const objectIds = navObjectIds(target);
  if (objectIds.length) return objectIds.some((id) => objectPlaced(board, id));
  if (target.replyId) return Boolean(board.replies?.some((item) => item.id === target.replyId));
  if (target.nodeId) return board.nodes.some((item) => item.id === target.nodeId);
  return false;
}

export function navObjectIds(target: ContentNavTarget) {
  if (target.objectIds?.length) return target.objectIds;
  return target.objectId ? [target.objectId] : [];
}

export function objectPlaced(board: BoardSnapshot, objectId: string) {
  return Boolean(
    board.canvas?.objects.some((item) => item.id === objectId)
    && board.canvas?.items.some((item) => item.item_id === objectId && !item.removed),
  );
}

export function resolveNavObjectId(target: ContentNavTarget, board: BoardSnapshot) {
  return navObjectIds(target).find((id) => objectPlaced(board, id));
}

export function stampReceiptGuard(guards: Map<number, number>, epoch: number, seq: number) {
  const nextEpoch = epoch + 1;
  const next = new Map(guards);
  next.set(seq, nextEpoch);
  return { epoch: nextEpoch, guards: next };
}

export function applyLocalReceipt(state: FeedbackState, receipt: DeliveryReceipt): FeedbackState {
  const deliveries = state.deliveries.slice();
  const index = deliveries.findIndex((item) => item.event.seq === receipt.event.seq);
  if (index >= 0) deliveries[index] = receipt;
  else deliveries.push(receipt);
  return { ...state, deliveries };
}

/** A GET that started before a local receipt mutation cannot replace it. A GET started after is authoritative. */
export function mergeFeedbackFetch(
  current: FeedbackState,
  incoming: FeedbackState,
  guards: Map<number, number>,
  fetchStartedAt: number,
): { state: FeedbackState; guards: Map<number, number> } {
  const remaining = new Map(guards);
  const localBySeq = new Map(current.deliveries.map((item) => [item.event.seq, item]));
  const deliveries = incoming.deliveries.map((item) => {
    const guard = remaining.get(item.event.seq);
    if (guard != null && fetchStartedAt < guard) return localBySeq.get(item.event.seq) ?? item;
    if (guard != null) remaining.delete(item.event.seq);
    return item;
  });
  for (const [seq, local] of localBySeq) {
    if (deliveries.some((item) => item.event.seq === seq)) continue;
    const guard = remaining.get(seq);
    if (guard != null && fetchStartedAt < guard) deliveries.push(local);
  }
  return { state: { ...incoming, deliveries }, guards: remaining };
}

export function overviewProject(
  captured: CapturedContext | null | undefined,
  sourceId: string | null | undefined,
  bindings: CodexBinding[],
): OverviewProject {
  const origin = resolveContentOrigin(captured, sourceId, bindings);
  if (origin.cwd) return { kind: origin.captured ? "captured" : "associated", key: origin.workspaceKey, label: origin.cwd };
  return { kind: "unsorted", key: "unsorted", label: "unsorted" };
}

export function filterOverviewItems(items: OverviewItem[], query: string, projectKey: string, taskKey = "all") {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => {
    if (projectKey && projectKey !== "all" && item.project.key !== projectKey) return false;
    if (taskKey !== "all" && item.origin.taskKey !== taskKey) return false;
    if (!needle) return true;
    const hay = [item.title, item.excerpt, item.background, item.project.label, item.origin.taskLabel, item.origin.project].join("\n").toLowerCase();
    return hay.includes(needle);
  });
}

export function boardLayoutFingerprint(board: BoardSnapshot) {
  return JSON.stringify({
    topic: board.topic,
    nodes: board.nodes,
    edges: board.edges,
    replies: board.replies ?? [],
    canvas: board.canvas ?? null,
  });
}

function ideaCard(identity: ContentIdentity, board: BoardSnapshot, bindings: CodexBinding[]): Pick<DiscussionCard, "title" | "excerpt" | "background" | "originKind" | "associatedLabel"> {
  if (identity.type === "node" && identity.nodeId) {
    const node = board.nodes.find((item) => item.id === identity.nodeId);
    return describeNode(node, bindings);
  }
  if (identity.type === "reply" && identity.replyId) {
    const reply = board.replies?.find((item) => item.id === identity.replyId);
    const project = overviewProject(undefined, reply?.source_id, bindings);
    return {
      title: reply?.title || "",
      excerpt: excerpt(replyPlain(reply)),
      background: "",
      originKind: project.kind,
      associatedLabel: project.kind === "associated" ? bindingFor(bindings, reply?.source_id)?.label || null : null,
    };
  }
  if (identity.type === "composite") {
    const titles = (identity.objectIds ?? []).map((id) => titleForObject(board, id)).filter(Boolean);
    return { title: titles.join(" · "), excerpt: "", background: "", originKind: "unsorted", associatedLabel: null };
  }
  if (identity.objectId) {
    return { title: titleForObject(board, identity.objectId), excerpt: "", background: "", originKind: "unsorted", associatedLabel: null };
  }
  return { title: "", excerpt: "", background: "", originKind: "unsorted", associatedLabel: null };
}

function describeNode(node: BoardNode | undefined, bindings: CodexBinding[]) {
  const project = overviewProject(node?.captured_context, node?.source_id, bindings);
  const background = backgroundLine(node?.captured_context);
  const excerptText = excerpt(node?.body || background);
  return {
    title: node?.title || "",
    excerpt: excerptText,
    background,
    originKind: node?.captured_context ? "captured" as const : project.kind,
    associatedLabel: !node?.captured_context && project.kind === "associated" ? bindingFor(bindings, node?.source_id)?.label || null : null,
  };
}

function titleForObject(board: BoardSnapshot, objectId: string) {
  const object = board.canvas?.objects.find((item) => item.id === objectId);
  if (!object) return "";
  const content = object.content;
  if (content.type === "block") return content.block.title || (content.block.type === "text" ? textLabel(content.block.text) : "");
  if (content.type === "node" || content.type === "reply") {
    const contentId = content.id;
    if (content.type === "node") return board.nodes.find((item) => item.id === contentId)?.title || "";
    return board.replies?.find((item) => item.id === contentId)?.title || "";
  }
  if ("title" in content) return content.title || (content.type === "text" ? textLabel(content.text) : "");
  return "";
}

export function messageRow(event: AgentEvent, state: FeedbackState, board: BoardSnapshot): MessageRow {
  const receipt = receiptFor(state, event.seq);
  const binding = bindingFor(state.bindings, event.source_id);
  return {
    seq: event.seq,
    kind: event.kind,
    text: event.text || "",
    at_ms: event.at_ms,
    source_id: event.source_id,
    taskLabel: binding?.label ?? null,
    unbound: Boolean(event.source_id) && !binding,
    receipt,
    status: receipt?.phase ?? "none",
    canRetry: canRetry(receipt, state.bindings),
    responseTarget: responseNavTarget(receipt),
    originalTarget: originalNavTarget(event),
  };
}

export function discussionCards(
  state: FeedbackState,
  board: BoardSnapshot,
  view: FeedbackView,
  query = "",
): DiscussionCard[] {
  const events = view === "followup" ? followUpEvents(state) : view === "replied" ? repliedEvents(state) : activityEvents(state);
  if (view === "activity") {
    return events.map((event) => {
      const identity = identityFromEvent(event, board);
      const described = ideaCard(identity, board, state.bindings);
      return {
        key: `activity:${event.seq}`,
        identity,
        title: cardTitle(described.title, event.title),
        excerpt: "",
        background: described.background,
        originKind: described.originKind,
        associatedLabel: described.associatedLabel,
        messages: [messageRow(event, state, board)],
      };
    }).filter((card) => matchesQuery(card, query));
  }
  const groups = new Map<string, DiscussionCard>();
  for (const event of events) {
    const identity = identityFromEvent(event, board);
    const described = ideaCard(identity, board, state.bindings);
    const existing = groups.get(identity.key);
    const row = messageRow(event, state, board);
    if (existing) {
      existing.messages.push(row);
      continue;
    }
    groups.set(identity.key, {
      key: identity.key,
      identity,
      title: cardTitle(described.title, event.title),
      excerpt: described.excerpt,
      background: described.background,
      originKind: described.originKind,
      associatedLabel: described.associatedLabel,
      messages: [row],
    });
  }
  return [...groups.values()].filter((card) => matchesQuery(card, query));
}

function cardTitle(describedTitle: string, eventTitle?: string | null) {
  return (describedTitle || eventTitle || "").trim();
}

function matchesQuery(card: DiscussionCard, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = [card.title, card.excerpt, card.background, ...card.messages.map((item) => item.text)].join("\n").toLowerCase();
  return hay.includes(needle);
}

export function feedbackPaintKey(state: FeedbackState, board: BoardSnapshot, view: FeedbackView, query: string) {
  return JSON.stringify({
    view,
    query,
    followUp: followUpCount(state),
    cards: discussionCards(state, board, view, query).map((card) => ({
      key: card.key,
      title: card.title,
      excerpt: card.excerpt,
      background: card.background,
      originKind: card.originKind,
      associatedLabel: card.associatedLabel,
      messages: card.messages.map((item) => ({
        seq: item.seq,
        status: item.status,
        text: item.text,
        taskLabel: item.taskLabel,
        canRetry: item.canRetry,
        response: item.responseTarget,
        desktop: item.receipt?.desktop,
        error: item.receipt?.error,
      })),
    })),
    bindings: state.bindings.map((item) => [item.source_id, item.label]),
  });
}

export function overviewItemFromObject(
  object: CanvasObject,
  board: BoardSnapshot,
  bindings: CodexBinding[],
): OverviewItem {
  const origin = originForObject(object, board, bindings);
  if (object.content.type === "block") return {
    objectId: object.id, contentType: "block", title: object.content.block.title || (object.content.block.type === "text" ? textLabel(object.content.block.text) : "") || object.id,
    excerpt: excerpt(blockPlain(object.content.block)), background: "", origin,
    project: overviewProject(undefined, object.source_id, bindings), revision: object.content_revision,
  };
  if (object.content.type === "node" || object.content.type === "reply") {
    const contentId = object.content.id;
    if (object.content.type === "node") {
      const node = board.nodes.find((item) => item.id === contentId);
      const project = overviewProject(node?.captured_context, node?.source_id, bindings);
      const background = backgroundLine(node?.captured_context);
      return {
        objectId: object.id,
        contentType: "node",
        contentId,
        title: node?.title || object.id,
        excerpt: excerpt(node?.body || ""),
        background,
        project,
        origin,
        revision: node?.revision ?? object.content_revision,
      };
    }
    const reply = board.replies?.find((item) => item.id === contentId);
    const project = overviewProject(undefined, reply?.source_id, bindings);
    return {
      objectId: object.id,
      contentType: "reply",
      contentId,
      title: reply?.title || object.id,
      excerpt: excerpt(replyPlain(reply)),
      background: "",
      project,
      origin,
      revision: reply?.revision ?? object.content_revision,
    };
  }
  const title = "title" in object.content ? object.content.title : object.id;
  const text = "text" in object.content ? object.content.text : "";
  const project = overviewProject(undefined, object.source_id, bindings);
  return {
    objectId: object.id,
    contentType: object.content.type,
    title: title || textLabel(text) || object.id,
    excerpt: excerpt(text || ""),
    background: "",
    project,
    origin,
    revision: object.content_revision,
  };
}

export function overviewPaintKey(items: OverviewItem[], query: string, projectKey: string) {
  return JSON.stringify({
    query,
    projectKey,
    items: items.map((item) => [item.objectId, item.title, item.excerpt, item.background, item.revision, item.project, item.origin]),
  });
}
