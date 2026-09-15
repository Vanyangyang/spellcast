import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const art = path.resolve(root, "artifacts/spellcast-content-organization-20260913");
await mkdir(art, { recursive: true });
const outfile = path.join(art, "content-organization.mjs");
await build({
  entryPoints: [path.join(root, "src/content-organization.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  write: true,
});
const {
  followUpCount,
  followUpEvents,
  activityEvents,
  discussionCards,
  identityFromEvent,
  canRetry,
  originalNavTarget,
  responseNavTarget,
  boardLayoutFingerprint,
  filterOverviewItems,
  overviewItemFromObject,
  overviewProject,
  mergeFeedbackFetch,
  applyLocalReceipt,
  stampReceiptGuard,
  resolveNavObjectId,
} = await import(pathToFileURL(outfile).href);

const captured = { project: "日历", goal: "一周", change: "午餐已定", source_id: "task-1", captured_at_ms: 1, cwd: "/tmp/x", thread_id: "tid" };
const board = {
  topic: "fixture",
  form: "spatial",
  form_reason: "",
  nodes: [
    { id: "idea-a", revision: 1, title: "同名点子", body: "A 的正文", kind: "idea", weight: "note", x: 0, y: 0, z: 0, captured_context: captured, source_id: "task-1" },
    { id: "idea-b", revision: 1, title: "同名点子", body: "B 的正文", kind: "idea", weight: "note", x: 1, y: 0, z: 0 },
    { id: "idea-c", revision: 1, title: "空正文点子", body: "", kind: "idea", weight: "note", x: 2, y: 0, z: 0, captured_context: { ...captured, change: "空档" } },
  ],
  edges: [],
  messages: [],
  replies: [
    { id: "reply-1", source_id: "task-1", source_label: "", origin_node_id: "idea-a", title: "回复一", revision: 1, created_at_ms: 1, updated_at_ms: 1, blocks: [{ id: "t", type: "text", text: "回复一正文" }] },
    { id: "reply-2", source_id: "task-2", source_label: "", origin_node_id: "idea-a", title: "回复二", revision: 1, created_at_ms: 1, updated_at_ms: 1, blocks: [{ id: "t", type: "text", text: "回复二正文" }] },
    { id: "reply-orphan", source_id: "task-1", source_label: "", origin_node_id: null, title: "独立回复", revision: 1, created_at_ms: 1, updated_at_ms: 1, blocks: [{ id: "t", type: "text", text: "独立正文" }] },
  ],
  canvas: {
    revision: 1,
    objects: [
      { id: "obj-a", content: { type: "node", id: "idea-a" }, content_revision: 1 },
      { id: "obj-b", content: { type: "node", id: "idea-b" }, content_revision: 1 },
      { id: "obj-c", content: { type: "node", id: "idea-c" }, content_revision: 1 },
      { id: "obj-r1", content: { type: "reply", id: "reply-1" }, content_revision: 1 },
      { id: "obj-ro", content: { type: "reply", id: "reply-orphan" }, content_revision: 1 },
    ],
    items: [
      { item_id: "obj-a", revision: 1, z: 0, removed: false, appearance: "plain", x: 0, y: 0, width: 200, height: 120 },
      { item_id: "obj-b", revision: 1, z: 0, removed: false, appearance: "plain", x: 240, y: 0, width: 200, height: 120 },
      { item_id: "obj-c", revision: 1, z: 0, removed: false, appearance: "plain", x: 480, y: 0, width: 200, height: 120 },
      { item_id: "obj-r1", revision: 1, z: 0, removed: false, appearance: "plain", x: 0, y: 160, width: 200, height: 120 },
      { item_id: "obj-ro", revision: 1, z: 0, removed: false, appearance: "plain", x: 480, y: 160, width: 200, height: 120 },
    ],
  },
};
const bindings = [{ source_id: "task-1", thread_id: "tid", cwd: "/tmp/x", label: "周五排期", protocol_agent: "codex", bound_at_ms: 1 }];
const say = (seq, extra) => ({ seq, at_ms: seq, kind: "say", text: extra.text, source_id: extra.source_id, ...extra });
const state = {
  pending: [
    say(1, { text: "请展开", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }),
    { seq: 2, at_ms: 2, kind: "kept", text: "采纳", node_id: "idea-b", title: "同名点子" },
    say(3, { text: "跨源", source_id: "task-1", anchors: [{ object_id: "obj-a", content_revision: 1 }, { object_id: "obj-ro", content_revision: 1 }] }),
    say(7, { text: "无收据", source_id: "task-1", node_id: "idea-a" }),
  ],
  deliveries: [
    { event: say(1, { text: "请展开", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "waiting", client_message_id: "c1" },
    { event: say(4, { text: "已得到回复", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }), phase: "responded", response_reply_id: "reply-1", response_object_ids: ["obj-r1"], client_message_id: "c4" },
    { event: say(6, { text: "失败未绑定", source_id: "task-missing", node_id: "idea-b" }), phase: "failed", error: "x", client_message_id: "c6" },
    { event: say(8, { text: "失败可重试", source_id: "task-1", node_id: "idea-a" }), phase: "failed", error: "t", client_message_id: "c8" },
  ],
  bindings,
};

assert.equal(followUpCount(state), 5);
assert.equal(followUpEvents(state).some((event) => event.kind === "kept"), false);
assert.equal(activityEvents(state).some((event) => event.kind === "kept"), true);

const sameName = [
  identityFromEvent({ seq: 1, at_ms: 1, kind: "say", node_id: "idea-a" }, board).key,
  identityFromEvent({ seq: 1, at_ms: 1, kind: "say", node_id: "idea-b" }, board).key,
];
assert.notEqual(sameName[0], sameName[1]);

const replyOnIdea = identityFromEvent({ seq: 1, at_ms: 1, kind: "say", reply_id: "reply-1" }, board);
assert.equal(replyOnIdea.key, "node:idea-a");
assert.equal(replyOnIdea.type, "node");
const orphan = identityFromEvent({ seq: 1, at_ms: 1, kind: "say", reply_id: "reply-orphan" }, board);
assert.equal(orphan.key, "reply:reply-orphan");
const composite = identityFromEvent({
  seq: 3, at_ms: 3, kind: "say",
  anchors: [{ object_id: "obj-a", content_revision: 1 }, { object_id: "obj-ro", content_revision: 1 }],
}, board);
assert.equal(composite.type, "composite");
assert.deepEqual(composite.objectIds, ["obj-a", "obj-ro"]);

const followCards = discussionCards(state, board, "followup");
assert.equal(followCards.some((card) => card.messages.some((row) => row.kind === "kept")), false);
const ideaA = followCards.find((card) => card.key === "node:idea-a");
assert.ok(ideaA);
assert.equal(ideaA.messages.some((row) => row.seq === 7 && row.status === "none"), true);
assert.equal(ideaA.originKind, "captured");
assert.match(ideaA.background, /日历/);
assert.equal(ideaA.associatedLabel, null);
assert.notEqual(ideaA.title, ideaA.identity.key);
const ideaB = followCards.find((card) => card.key === "node:idea-b");
assert.ok(ideaB);
assert.equal(ideaB.originKind, "unsorted");
assert.equal(ideaB.associatedLabel, null);
assert.notEqual(ideaB.title, "node:idea-b");
const failedUnbound = followCards.flatMap((card) => card.messages).find((row) => row.seq === 6);
assert.equal(failedUnbound.canRetry, false);
assert.equal(failedUnbound.unbound, true);
const failedBound = followCards.flatMap((card) => card.messages).find((row) => row.seq === 8);
assert.equal(failedBound.canRetry, true);
assert.equal(canRetry(state.deliveries.find((item) => item.event.seq === 8), bindings), true);
assert.equal(canRetry(state.deliveries.find((item) => item.event.seq === 6), bindings), false);

const original = originalNavTarget(say(4, { text: "x", source_id: "task-1", node_id: "idea-a", object_id: "obj-a" }));
assert.equal(original.objectId, "obj-a");
assert.equal(original.replyId, undefined);
const response = responseNavTarget(state.deliveries.find((item) => item.event.seq === 4));
assert.equal(response.objectId, "obj-r1");
assert.equal(response.replyId, "reply-1");
assert.notEqual(response.objectId, original.objectId);

const emptyBody = overviewItemFromObject(board.canvas.objects[2], board, bindings);
assert.equal(emptyBody.title, "空正文点子");
assert.equal(emptyBody.excerpt, "");
assert.match(emptyBody.background, /日历|空档/);
assert.equal(emptyBody.project.kind, "captured");
const unsorted = overviewItemFromObject(board.canvas.objects[1], board, bindings);
assert.equal(unsorted.project.kind, "unsorted");
const linked = overviewProject(undefined, "task-1", bindings);
assert.equal(linked.kind, "associated");
assert.equal(linked.label, "/tmp/x");
assert.equal(linked.key, "workspace:/tmp/x");
assert.notEqual(linked.label, "codex");

const before = boardLayoutFingerprint(board);
const filtered = filterOverviewItems([emptyBody, unsorted], "同名", "unsorted");
assert.equal(filtered.length, 1);
assert.equal(filtered[0].objectId, "obj-b");
assert.equal(boardLayoutFingerprint(board), before);
board.nodes[0].title = "should not leak";
filterOverviewItems([unsorted], "", "all");
assert.equal(board.canvas.items[0].removed, false);

const replied = discussionCards(state, board, "replied");
assert.equal(replied.some((card) => card.messages.some((row) => row.seq === 4)), true);
assert.equal(replied.some((card) => card.messages.some((row) => row.seq === 2)), false);

const activity = discussionCards(state, board, "activity");
const kept = activity.find((card) => card.messages[0].kind === "kept");
assert.ok(kept);
assert.equal(kept.title, "同名点子");
assert.notEqual(kept.title, "kept");
assert.equal(kept.excerpt, "");
assert.notEqual(kept.messages[0].text, kept.messages[0].kind);

const missing = discussionCards({
  pending: [{ seq: 99, at_ms: 1, kind: "say", text: "ghost", node_id: "ghost" }],
  deliveries: [],
  bindings,
}, board, "followup");
assert.equal(missing[0].title, "");
assert.notEqual(missing[0].title, missing[0].identity.key);
assert.equal(missing[0].originKind, "unsorted");
const missingKept = discussionCards({
  pending: [{ seq: 100, at_ms: 1, kind: "kept", node_id: "ghost" }],
  deliveries: [],
  bindings: [],
}, board, "activity");
assert.equal(missingKept[0].title, "");
assert.notEqual(missingKept[0].title, "kept");
const titledMissing = discussionCards({
  pending: [{ seq: 101, at_ms: 1, kind: "kept", title: "用户标题", node_id: "ghost" }],
  deliveries: [],
  bindings: [],
}, board, "activity");
assert.equal(titledMissing[0].title, "用户标题");

const assocBoard = {
  ...board,
  nodes: [...board.nodes, { id: "idea-d", revision: 1, title: "关联点子", body: "D", kind: "idea", weight: "note", x: 3, y: 0, z: 0, source_id: "task-1" }],
};
const assocState = {
  pending: [say(20, { text: "给其他任务", source_id: "task-2", node_id: "idea-d" })],
  deliveries: [{ event: say(20, { text: "给其他任务", source_id: "task-2", node_id: "idea-d" }), phase: "waiting", client_message_id: "c20" }],
  bindings: [...bindings, { source_id: "task-2", thread_id: "t2", cwd: "/tmp/y", label: "其他任务", protocol_agent: "codex", bound_at_ms: 2 }],
};
const assocCards = discussionCards(assocState, assocBoard, "followup");
const cardD = assocCards.find((card) => card.key === "node:idea-d");
assert.ok(cardD);
assert.equal(cardD.originKind, "associated");
assert.equal(cardD.associatedLabel, "周五排期");
assert.equal(cardD.messages[0].taskLabel, "其他任务");
assert.notEqual(cardD.associatedLabel, cardD.messages[0].taskLabel);
assert.equal(assocCards.filter((card) => card.key === "node:idea-d").length, 1);

const twoTaskState = {
  ...state,
  pending: [...state.pending, say(9, { text: "给另一任务", source_id: "task-2", node_id: "idea-a", object_id: "obj-a" })],
};
const two = discussionCards(twoTaskState, board, "followup");
assert.equal(two.filter((card) => card.key === "node:idea-a").length, 1);
assert.equal(two.find((card) => card.key === "node:idea-a").messages.some((row) => row.seq === 9), true);

const failed = state.deliveries.find((item) => item.event.seq === 8);
const waiting = { ...failed, phase: "waiting", error: null };
const stamped = stampReceiptGuard(new Map(), 0, 8);
const local = applyLocalReceipt({ ...state, deliveries: state.deliveries.map((item) => item.event.seq === 8 ? { ...failed } : item) }, waiting);
const oldGet = mergeFeedbackFetch(local, { ...state, deliveries: state.deliveries.map((item) => item.event.seq === 8 ? { ...failed } : item) }, stamped.guards, 0);
assert.equal(oldGet.state.deliveries.find((item) => item.event.seq === 8).phase, "waiting");
assert.equal(oldGet.guards.get(8), 1);
const laterFail = mergeFeedbackFetch(oldGet.state, { ...state, deliveries: state.deliveries.map((item) => item.event.seq === 8 ? { ...failed } : item) }, oldGet.guards, stamped.epoch);
assert.equal(laterFail.state.deliveries.find((item) => item.event.seq === 8).phase, "failed");
assert.equal(laterFail.guards.has(8), false);
assert.equal(canRetry(laterFail.state.deliveries.find((item) => item.event.seq === 8), bindings), true);

const multi = { objectId: "missing", objectIds: ["missing", "obj-r1"], replyId: "reply-1" };
assert.equal(resolveNavObjectId(multi, board), "obj-r1");
assert.notEqual(resolveNavObjectId(multi, board), "obj-a");
assert.notEqual(resolveNavObjectId(multi, board), original.objectId);

const viewOut = path.join(art, "canvas-view.mjs");
await build({
  entryPoints: [path.join(root, "src/canvas-view.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: viewOut,
  write: true,
});
const { viewShouldRecover } = await import(pathToFileURL(viewOut).href);
const content = [{ x: 0, y: 0, width: 400, height: 300 }];
assert.equal(viewShouldRecover({ scale: 1, x: 200, y: 150 }, content, 800, 600), false);
assert.equal(viewShouldRecover({ scale: 0.01, x: 200, y: 150 }, content, 800, 600), true);
assert.equal(viewShouldRecover({ scale: 1, x: 20000, y: 20000 }, content, 800, 600), true);
const far = [{ x: 0, y: 0, width: 100, height: 100 }, { x: 5000, y: 0, width: 100, height: 100 }];
assert.equal(viewShouldRecover({ scale: 1, x: 2550, y: 50 }, far, 800, 600), true);
assert.equal(viewShouldRecover({ scale: 1, x: 50, y: 50 }, far, 800, 600), false);

console.log("content-organization grouping/nav/hash checks ok");
