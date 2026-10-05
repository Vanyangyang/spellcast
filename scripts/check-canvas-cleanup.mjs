import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts/spellcast-canvas-cleanup");
await mkdir(artifacts, { recursive: true });
const outfile = path.join(artifacts, "canvas-cleanup-model.mjs");
await build({ entryPoints: [path.join(root, "src/canvas-cleanup-model.ts")], bundle: true, platform: "neutral", format: "esm", outfile });
const { analyzeCleanup, mergeCleanupItems, prepareCleanup } = await import(pathToFileURL(outfile).href);

const route = { cwd: "G:/Project", thread_id: "thread-a", source_id: "source-a", label: "Task A" };
const card = (id, text, extra = {}) => ({ id, content: { type: "text", title: "内容整理", text }, content_revision: 1, origin: { ...route }, source_id: "source-a", ...extra });
const boardFor = (objects, extra = {}) => ({ topic: "cleanup", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [], replies: [],
  canvas: { revision: 1, objects, items: objects.map((object, index) => ({ item_id: object.id, revision: 1, x: index * 100, y: 0, width: 200, height: 100, z: index, removed: false, appearance: "card" })), compositions: [], annotations: [] }, ...extra });
const empty = () => ({ pending: [], deliveries: [], bindings: [] });
const analyze = (board, feedback = empty(), scope = new Set(board.canvas.objects.map(object => object.id)), protectedIds = new Set()) => analyzeCleanup(board, feedback, scope, protectedIds);
const message = (seq, extra = {}) => ({ seq, at_ms: seq, kind: "say", source_id: "source-a", object_id: "a", object_revision: 1, text: "请处理", ...extra });
const receipt = (seq, phase, extra = {}) => ({ event: message(seq), phase, client_message_id: `c${seq}`, ...extra });
const byId = (analysis, id) => analysis.items.find(item => item.id === id);
const error = (fn, code) => assert.throws(fn, error => error instanceof Error && error.message === code);
const choose = (archiveIds = [], mergeIds = []) => ({ archiveIds: new Set(archiveIds), mergeIds: new Set(mergeIds) });

const chinese = "内容整理应当先展示预览，再由用户选择已处理的内容。所有未完成反馈和待办批注都需要保护，合并时保留完整原文和来源信息。";
const chineseVariant = "内容整理应当先展示预览，再由用户选择已处理的内容。所有未完成反馈和待办批注都需要保护，合并时保留完整原文和任务来源信息。";
let board = boardFor([card("a", chinese), card("b", chineseVariant)]);
let analysis = analyze(board);
assert.equal(analysis.groups.length, 1, "Chinese shingles find useful close text");
assert.equal(analysis.groups[0].exact, false);
assert.ok(analysis.groups[0].text.includes(chinese));
assert.ok(analysis.groups[0].text.includes(chineseVariant));
const immutableBefore = JSON.stringify(board);
const first = prepareCleanup(analysis, choose(["a"], [analysis.groups[0].id]));
assert.equal(first.batch.operations.filter(operation => operation.op === "place" && operation.id === "a").length, 1);
assert.deepEqual(first.archivedIds, ["a", "b"]);
assert.equal(first.createdIds.length, 1);
assert.deepEqual(first.batch.reads.map(read => `${read.kind}:${read.id}`).sort(), ["content:a", "content:b", "presentation:a", "presentation:b"]);
const create = first.batch.operations.find(operation => operation.op === "create");
assert.equal(create.content.type, "text");
assert.deepEqual(create.origin, route);
assert.equal(create.placement.x, 0);
assert.equal(create.placement.y, 0);
assert.equal(JSON.stringify(board), immutableBefore, "analysis and preparation do not change sources");
assert.ok(first.batch.operations.every(operation => operation.op === "place" || operation.op === "create"));
const retryPrepared = prepareCleanup(analysis, choose([], [analysis.groups[0].id]));
assert.notEqual(first.batch.request_id, retryPrepared.batch.request_id);
assert.notEqual(first.createdIds[0], retryPrepared.createdIds[0]);
const english = "Preview all archived content before applying the cleanup. Preserve every original paragraph and title while protecting pending feedback annotations and local drafts.";
const englishVariant = "Preview all archived content before applying the cleanup. Preserve every original paragraph and title while protecting pending feedback annotations and unsaved local drafts.";
assert.equal(analyze(boardFor([card("a", english), card("b", englishVariant)])).groups.length, 1, "English tokens also find close text");
assert.deepEqual(analyzeCleanup({ topic: "empty", form: "spatial", form_reason: "", nodes: [], edges: [], messages: [] }, empty(), new Set()), { items: [], groups: [] });

assert.equal(analyze(boardFor([card("a", "请检查"), card("b", "请整理")])).groups.length, 0, "generic short text is not similar");
assert.equal(analyze(boardFor([card("a", "桃子香蕉草莓的水果分类清单，需要列出每种水果的颜色味道和成熟时间。"), card("b", "数据库连接池的性能分析报告，需要检查事务隔离锁竞争索引缓存和查询优化策略。")])).groups.length, 0, "same title does not drive similarity");
analysis = analyze(boardFor([card("a", "budget 10"), card("b", "budget 11")]));
assert.equal(analysis.groups.length, 0, "different numbers cannot become exact duplicates");
assert.equal(analyze(boardFor([card("a", chinese), card("b", chinese, { origin: { ...route, cwd: "G:/Other" } })])).groups.length, 0);
assert.equal(analyze(boardFor([card("a", chinese), card("b", chinese, { origin: { ...route, thread_id: "thread-b" } })])).groups.length, 0);
assert.equal(analyze(boardFor([card("a", chinese), card("b", chinese, { origin: { ...route, source_id: "source-b" }, source_id: "source-b" })])).groups.length, 0);
assert.equal(analyze(boardFor([card("a", chinese, { origin: null }), card("b", chinese, { origin: null })])).groups.length, 0, "unknown workspace cannot auto-merge");

const codeText = "Example:\n```js\n  const n = 10;\n\tconsole.log(n);\n```\n";
analysis = analyze(boardFor([card("a", codeText, { content: { type: "text", title: "Original A", text: codeText } }), card("b", codeText, { content: { type: "text", title: "Original B", text: codeText } })]));
assert.equal(analysis.groups[0].exact, true);
assert.ok(analysis.groups[0].text.includes(codeText), "code block whitespace stays literal");
assert.equal(analysis.groups[0].text.split("const n = 10;").length, 2, "duplicate body occurs once");
assert.ok(analysis.groups[0].text.includes("Original A") && analysis.groups[0].text.includes("Original B"));
analysis = analyze(boardFor([card("a", "Keep CASE, punctuation!"), card("b", "Keep CASE,   punctuation!"), card("c", "keep case punctuation")]));
assert.equal(analysis.groups.length, 0, "internal whitespace and punctuation cannot be exact-deduplicated");
const codeVariant = codeText.replace("  const n", "    const n");
analysis = analyze(boardFor([card("a", codeText), card("b", codeVariant)]));
const codeMerge = mergeCleanupItems(analysis.items);
assert.equal(codeMerge.exact, false);
assert.ok(codeMerge.text.includes(codeText) && codeMerge.text.includes(codeVariant), "different code indentation keeps both complete original bodies");
const stringCode = '```js\nconst label = "one  two";\n```';
const stringVariant = stringCode.replace("one  two", "one two");
analysis = analyze(boardFor([card("a", stringCode), card("b", stringVariant)]));
const stringMerge = mergeCleanupItems(analysis.items);
assert.equal(stringMerge.exact, false);
assert.ok(stringMerge.text.includes(stringCode) && stringMerge.text.includes(stringVariant));
analysis = analyze(boardFor([card("a", "same text\r\n\r\n"), card("b", "same text\n")]));
assert.equal(analysis.groups[0].exact, true, "line ending and trailing blank line normalization is allowed");

board = boardFor([card("a", chinese), card("b", chinese)]);
let state = empty();
state.deliveries = [receipt(1, "handled")];
analysis = analyze(board, state);
assert.equal(byId(analysis, "a").reason, "handled");
assert.equal(analysis.groups.length, 0, "handled archive recommendation is not also an automatic merge");
for (const phase of ["responded", "completed"]) {
  const item = byId(analyze(board, { ...empty(), deliveries: [receipt(1, phase)] }), "a");
  assert.equal(item.reason, "replied");
  assert.deepEqual(item.blocked, []);
}
for (const phase of [undefined, "waiting", "executing", "awaiting_permission", "failed", "future_phase"]) {
  state = { ...empty(), pending: [message(2)], deliveries: [receipt(1, "handled"), ...(phase ? [receipt(2, phase)] : [])] };
  const item = byId(analyze(board, state), "a");
  assert.ok(item.blocked.includes("pending"), `${phase} is a pending blocker`);
  assert.notEqual(item.reason, "handled", "new pending overrides old handled");
  error(() => prepareCleanup(analyze(board, state), choose(["a"])), "cleanup.changed");
}
board.canvas.objects[0].content_revision = 2;
assert.notEqual(byId(analyze(board, { ...empty(), deliveries: [receipt(1, "handled")] }), "a").reason, "handled", "old event version is not handled evidence");
assert.equal(byId(analyze(board, { ...empty(), deliveries: [receipt(1, "handled", { event: message(1, { object_revision: 2 }) })] }), "a").reason, "handled");

board = boardFor([card("a", chinese), card("b", chinese)]);
board.canvas.annotations = [{ id: "annotation", revision: 3, anchor: { object_id: "a", content_revision: 1 }, text: "done", snapshot: null, removed: false, status: "handled" }];
assert.equal(byId(analyze(board), "a").reason, "handled", "handled annotations are evidence");
let prepared = prepareCleanup(analyze(board), choose(["a"]));
assert.ok(prepared.batch.reads.some(read => read.kind === "annotation" && read.id === "annotation" && read.revision === 3));
board.canvas.objects[0].content_revision = 2;
assert.equal(byId(analyze(board), "a").reason, "none", "stale annotation does not handle current content");
board.canvas.annotations[0].status = "pending";
assert.ok(byId(analyze(board), "a").blocked.includes("annotation"));
board.canvas.items[1].delete_locked = true;
assert.ok(byId(analyze(board), "b").blocked.includes("locked"));
assert.ok(byId(analyze(board, empty(), undefined, new Set(["a"])), "a").blocked.includes("draft"));
error(() => prepareCleanup(analyze(board), choose(["b"])), "cleanup.changed");

board = boardFor([card("a", chinese), card("b", chinese)]);
assert.deepEqual(analyze(board, empty(), new Set(["b"])).items.map(item => item.id), ["b"]);
board.canvas.items[0].removed = true;
assert.deepEqual(analyze(board).items.map(item => item.id), ["b"]);
board.canvas.items[0].removed = false;
analysis = analyze(board);
board.canvas.objects[0].content_revision++;
error(() => prepareCleanup(analysis, choose(["a"])), "cleanup.changed");

const imageBoard = boardFor([card("a", chinese), card("b", chinese + "\n![image](x.png)")]);
assert.equal(analyze(imageBoard).groups.length, 0, "markdown images are mixed media");
const replyBoard = boardFor([card("a", chinese), { id: "reply", content: { type: "reply", id: "r1" }, content_revision: 1, source_id: "source-a", origin: { ...route } }], {
  replies: [{ id: "r1", source_id: "source-a", source_label: "", title: "Reply", revision: 1, blocks: [{ id: "text", type: "text", text: chinese }, { id: "image", type: "comparison", options: [], criteria: [] }], created_at_ms: 1, updated_at_ms: 1 }] });
assert.equal(byId(analyze(replyBoard), "reply").text, null);
assert.equal(analyze(replyBoard).groups.length, 0);

for (const structure of ["composition", "binding-in", "binding-out", "edge"]) {
  board = boardFor([card("a", chinese), card("b", chinese)]);
  if (structure === "composition") board.canvas.compositions = [{ id: "group", revision: 1, title: "group", members: ["a"] }];
  if (structure === "binding-in") board.canvas.objects[0].bindings = [{ from: { object_id: "b", block_id: "t", port: "value" }, to: { port: "value" } }];
  if (structure === "binding-out") board.canvas.objects[1].bindings = [{ from: { object_id: "a", block_id: "t", port: "value" }, to: { port: "value" } }];
  if (structure === "edge") board.edges = [{ id: "edge", from: "a", to: "b" }];
  analysis = analyze(board);
  assert.equal(byId(analysis, "a").mergeBlocked, true, structure);
  assert.equal(analysis.groups.length, 0);
  assert.equal(prepareCleanup(analysis, choose(["a"])).archivedIds.length, 1, "structural members can still be manually archived");
}

const node = { id: "n1", revision: 1, title: "node", body: chinese, kind: "idea", weight: "note", x: 0, y: 0, z: 0, source_id: "source-a", captured_context: { ...route, project: "P", goal: "G", change: "C", captured_at_ms: 1 } };
board = boardFor([{ id: "n", content: { type: "node", id: "n1" }, content_revision: 1 }, { id: "r", content: { type: "reply", id: "r1" }, content_revision: 1 }, card("a", chinese), card("b", chinese)], {
  nodes: [node], replies: [{ id: "r1", source_id: "source-a", title: "reply", revision: 1, source_label: "", blocks: [{ id: "t", type: "text", text: chinese }], created_at_ms: 1, updated_at_ms: 1 }] });
const association = message(1, { kind: "selection", object_id: "a", anchors: [{ object_id: "b", content_revision: 1 }], node_id: "n1", reply_id: "r1" });
analysis = analyze(board, { ...empty(), pending: [association] });
assert.ok(analysis.items.every(item => item.blocked.includes("pending")), "all message reference forms are associated, not just first anchor");
for (const kind of ["say", "reply", "selection", "reply_edit"]) assert.ok(byId(analyze(board, { ...empty(), pending: [message(1, { kind })] }), "a").blocked.includes("pending"));
analysis = analyze(board, { ...empty(), deliveries: [receipt(1, "handled", { event: message(1, { object_id: "n" }), response_object_ids: ["a"], response_reply_id: "r1" })] });
assert.equal(byId(analysis, "a").reason, "handled");
assert.equal(byId(analysis, "r").reason, "handled");
prepared = prepareCleanup(analysis, choose(["a"]));
assert.equal(prepared.batch.feedback_sequences, undefined, "cleanup never marks associated feedback handled");

board = boardFor([card("a", "Original one"), card("b", "Original two")]);
analysis = analyze(board);
assert.equal(analysis.groups.length, 0);
const manual = mergeCleanupItems(analysis.items);
assert.ok(manual.text.includes("Original one") && manual.text.includes("Original two"));
analysis.groups.push(manual);
assert.equal(prepareCleanup(analysis, choose([], [manual.id])).createdIds.length, 1);
error(() => mergeCleanupItems([analysis.items[0]]), "cleanup.mergeUnavailable");
error(() => mergeCleanupItems([analysis.items[0], { ...analysis.items[1], mergeBlocked: true }]), "cleanup.mergeUnavailable");
error(() => mergeCleanupItems([analysis.items[0], { ...analysis.items[1], origin: { ...analysis.items[1].origin, taskKey: "thread:other" } }]), "cleanup.mergeUnavailable");
error(() => mergeCleanupItems([analysis.items[0], { ...analysis.items[1], text: "x".repeat(64001) }]), "cleanup.mergeUnavailable");
error(() => prepareCleanup(analysis, choose()), "cleanup.empty");
error(() => prepareCleanup(analysis, choose(["missing"])), "cleanup.changed");

board = boardFor([card("anonymous-a", chinese, { origin: null, source_id: null }), card("anonymous-b", chineseVariant, { origin: null, source_id: null })]);
analysis = analyze(board);
assert.equal(analysis.groups.length, 0, "anonymous content remains excluded from automatic suggestions");
const anonymousGroup = mergeCleanupItems(analysis.items);
analysis.groups.push(anonymousGroup);
prepared = prepareCleanup(analysis, choose([], [anonymousGroup.id]));
assert.equal(prepared.createdIds.length, 1, "explicit anonymous selection can be merged");
assert.ok(!Object.hasOwn(prepared.batch.operations.find(operation => operation.op === "create"), "origin"), "anonymous merged text omits invalid empty origin");
assert.ok(anonymousGroup.text.includes(chinese) && anonymousGroup.text.includes(chineseVariant));
const anonymousItem = analysis.items[0];
const sourcedItem = analyze(boardFor([card("sourced", chinese)])).items[0];
error(() => mergeCleanupItems([anonymousItem, sourcedItem]), "cleanup.mergeUnavailable");
error(() => mergeCleanupItems([anonymousItem, { ...analysis.items[1], origin: { ...analysis.items[1].origin, workspaceKey: "workspace:G:/other" } }]), "cleanup.mergeUnavailable");
error(() => mergeCleanupItems([anonymousItem, { ...analysis.items[1], origin: { ...analysis.items[1].origin, taskKey: "thread:other" } }]), "cleanup.mergeUnavailable");
const otherSourceItem = analyze(boardFor([card("other-source", chinese, { source_id: "source-b", origin: { ...route, source_id: "source-b" } })])).items[0];
error(() => mergeCleanupItems([sourcedItem, otherSourceItem]), "cleanup.mergeUnavailable");

board = boardFor(Array.from({ length: 64 }, (_, index) => card(`item-${index}`, `Unique ${index}`)));
analysis = analyze(board);
assert.equal(prepareCleanup(analysis, choose(analysis.items.map(item => item.id))).batch.operations.length, 64);
assert.equal(prepareCleanup(analysis, choose(analysis.items.map(item => item.id))).batch.reads.length, 128);
board = boardFor(Array.from({ length: 65 }, (_, index) => card(`item-${index}`, `Unique ${index}`)));
analysis = analyze(board);
error(() => prepareCleanup(analysis, choose(analysis.items.map(item => item.id))), "cleanup.limit");
board = boardFor([card("a", chinese)]);
board.canvas.annotations = Array.from({ length: 127 }, (_, index) => ({ id: `an-${index}`, revision: 1, anchor: { object_id: "a", content_revision: 1 }, text: "handled", status: "handled", removed: false, snapshot: null }));
error(() => prepareCleanup(analyze(board), choose(["a"])), "cleanup.limit");
board = boardFor(Array.from({ length: 10 }, (_, index) => card(`item-${index}`, chinese)));
analysis = analyze(board);
assert.deepEqual(analysis.groups.map(group => group.items.length), [8, 2]);
prepared = prepareCleanup(analysis, choose([], analysis.groups.map(group => group.id)));
const created = prepared.batch.operations.filter(operation => operation.op === "create");
for (const operation of created) assert.ok(operation.content.title.length <= 160);
board = boardFor([card("a", "one"), card("b", "two"), card("c", "three"), card("d", "four")]);
board.canvas.items.forEach(item => { item.x = 0; item.y = 0; });
analysis = analyze(board);
analysis.groups = [mergeCleanupItems(analysis.items.slice(0, 2)), mergeCleanupItems(analysis.items.slice(2, 4))];
prepared = prepareCleanup(analysis, choose([], analysis.groups.map(group => group.id)));
const positions = prepared.batch.operations.filter(operation => operation.op === "create").map(operation => operation.placement);
assert.equal(positions[1].y - positions[0].y, 340, "new merge cards do not overlap");
board = boardFor([card("a", "x".repeat(31700)), card("b", "y".repeat(31700))]);
analysis = analyze(board);
analysis.groups = [mergeCleanupItems(analysis.items)];
assert.equal(prepareCleanup(analysis, choose([], [analysis.groups[0].id])).createdIds.length, 1, "JSON overhead does not reduce the 64000 text limit");
analysis.groups[0] = { ...analysis.groups[0], text: "x".repeat(64001) };
error(() => prepareCleanup(analysis, choose([], [analysis.groups[0].id])), "cleanup.limit");

console.log("canvas-cleanup analysis, preservation, protection, association and batch limit checks passed");
