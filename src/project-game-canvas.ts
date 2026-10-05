import { applyCanvasBatch, fetchBoard, restoreCanvasItem } from "./api";
import { gh } from "./i18n/game-home";
import { fetchGameOverview, type GameDocument, type PlayerLoop } from "./project-game-home-api";
import { fetchGameConnection } from "./project-game-api";
import type { GameSkeleton } from "./project-game-skeleton-model";
import { csk } from "./i18n/canvas-source-skeleton";
import type { BoardSnapshot, CanvasSourceSkeleton, CanvasSourceTable } from "./types";

const normalizedRoot = (root: string) => {
  const value = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
};
// Compare live connections without changing the normalization used by saved object IDs.
const connectionRoot = (root: string) => {
  const value = root.trim().replaceAll("\\", "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  return /^[a-z]:(?:\/|$)/i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
};

async function tableId(projectId: string, root: string, path: string, heading: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([projectId, normalizedRoot(root), path, heading]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const key = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
  return `source-table:${projectId}:${key}`;
}

function failure(result: { targets: { status: string; message?: string | null }[] }) {
  return new Error(result.targets.find(target => target.status !== "ready")?.message || "Canvas could not save the source table.");
}

function sourceTable(projectId: string, root: string, loop: PlayerLoop): CanvasSourceTable {
  return { title: gh("loopTitle"), project_id: projectId, root: normalizedRoot(root), path: loop.source.path, heading: loop.source.heading,
    line: loop.source.line, hash: loop.source.hash, columns: [...loop.columns], rows: loop.rows.map(row => [...row]) };
}

/** Locate one saved source identity. A changed source version needs an explicit refresh. */
export async function ensureGameLoopOnCanvas(projectId: string, projectName: string, root: string, loop: PlayerLoop, objectId?: string): Promise<string> {
  const table = sourceTable(projectId, root, loop);
  const id = objectId ?? await tableId(projectId, root, table.path, table.heading);
  let board: BoardSnapshot = await fetchBoard();
  let object = board.canvas?.objects.find(item => item.id === id);
  if (objectId && (!object || board.canvas?.items.find(item => item.item_id === id)?.removed !== false)) throw new Error(csk("sourceUnavailable"));
  if (!object) {
    const right = Math.max(0, ...(board.canvas?.items.filter(item => !item.removed).map(item => item.x + item.width) ?? []));
    try {
      const outcome = await applyCanvasBatch({ request_id: crypto.randomUUID(), reads: [], operations: [{ op: "create", id,
        content: { type: "source_table", table }, origin: { cwd: root, label: projectName },
        placement: { x: right + 48, y: 80, width: 760, height: 360, appearance: "card" } }] });
      if (outcome.result.status !== "applied") throw failure(outcome.result);
      board = outcome.board;
    } catch (error) {
      board = await fetchBoard();
      if (!board.canvas?.objects.some(item => item.id === id)) throw error;
    }
    object = board.canvas?.objects.find(item => item.id === id);
  }
  if (object?.content.type !== "source_table" || object.content.table.project_id !== projectId
    || (objectId ? connectionRoot(object.content.table.root) !== connectionRoot(table.root) : object.content.table.root !== table.root)
    || object.content.table.path !== table.path || object.content.table.heading !== table.heading) {
    throw new Error("Canvas source identity is already used by different content.");
  }
  if (object.content.table.hash !== table.hash && window.confirm(gh("loopCanvasChanged"))) {
    try {
      const outcome = await applyCanvasBatch({ request_id: crypto.randomUUID(),
        reads: [{ kind: "content", id, revision: object.content_revision }],
        operations: [{ op: "patch_content", id, expected_revision: object.content_revision, fields: { source_table: table } }] });
      if (outcome.result.status !== "applied") throw failure(outcome.result);
      board = outcome.board;
    } catch (error) {
      board = await fetchBoard();
      const saved = board.canvas?.objects.find(item => item.id === id);
      if (saved?.content.type !== "source_table" || saved.content.table.hash !== table.hash) throw error;
    }
  }
  const placement = board.canvas?.items.find(item => item.item_id === id);
  if (!objectId && placement?.removed) {
    try { board = await restoreCanvasItem(id, placement.revision); }
    catch (error) {
      board = await fetchBoard();
      if (board.canvas?.items.find(item => item.item_id === id)?.removed !== false) throw error;
    }
  }
  return id;
}

/** One browsable Canvas object per project source, independent of its current node selection. */
export async function ensureGameSkeletonOnCanvas(projectId: string, projectName: string, root: string, source: GameSkeleton, documents: readonly GameDocument[], objectId?: string): Promise<string> {
  const paths = new Set(source.model.nodes.flatMap(node => [...node.sources, ...(node.provenance || []).filter(item => !item.archived).map(item => item.path)]));
  const skeleton: CanvasSourceSkeleton = { title: source.model.title, project_id: projectId, root: normalizedRoot(root), path: source.source.path,
    hash: source.source.hash, model: source.model,
    documents: documents.filter(document => paths.has(document.path)).map(({ path, hash, error }) => ({ path, hash, ...(error ? { error } : {}) })).sort((a, b) => a.path.localeCompare(b.path)) };
  const id = objectId ?? (await tableId(projectId, root, skeleton.path, "")).replace(/^source-table:/, "source-skeleton:");
  let board = await fetchBoard();
  let object = board.canvas?.objects.find(item => item.id === id);
  if (objectId && (!object || board.canvas?.items.find(item => item.item_id === id)?.removed !== false)) throw new Error(csk("sourceUnavailable"));
  if (!object) {
    const right = Math.max(0, ...(board.canvas?.items.filter(item => !item.removed).map(item => item.x + item.width) ?? []));
    try {
      const outcome = await applyCanvasBatch({ request_id: crypto.randomUUID(), reads: [], operations: [{ op: "create", id,
        content: { type: "source_skeleton", skeleton }, origin: { cwd: root, label: projectName },
        placement: { x: right + 48, y: 80, width: 1040, height: 720, appearance: "card" } }] });
      if (outcome.result.status !== "applied") throw failure(outcome.result);
      board = outcome.board;
    } catch (error) {
      board = await fetchBoard();
      if (!board.canvas?.objects.some(item => item.id === id)) throw error;
    }
    object = board.canvas?.objects.find(item => item.id === id);
  }
  if (object?.content.type !== "source_skeleton" || object.content.skeleton.project_id !== projectId
    || (objectId ? connectionRoot(object.content.skeleton.root) !== connectionRoot(skeleton.root) : object.content.skeleton.root !== skeleton.root)
    || object.content.skeleton.path !== skeleton.path) throw new Error(csk("sourceMismatch"));
  if ((object.content.skeleton.hash !== skeleton.hash || JSON.stringify(object.content.skeleton.documents) !== JSON.stringify(skeleton.documents))
    && window.confirm(csk("sourceChanged"))) {
    const outcome = await applyCanvasBatch({ request_id: crypto.randomUUID(), reads: [{ kind: "content", id, revision: object.content_revision }],
      operations: [{ op: "patch_content", id, expected_revision: object.content_revision, fields: { source_skeleton: skeleton } }] });
    if (outcome.result.status !== "applied") throw failure(outcome.result);
    board = outcome.board;
  }
  const placement = board.canvas?.items.find(item => item.item_id === id);
  if (!objectId && placement?.removed) await restoreCanvasItem(id, placement.revision);
  return id;
}

export async function refreshGameSkeletonOnCanvas(saved: CanvasSourceSkeleton, objectId?: string): Promise<string> {
  const { connection } = await fetchGameConnection(saved.project_id);
  if (!connection || connection.project_id !== saved.project_id || connectionRoot(connection.root) !== connectionRoot(saved.root)) throw new Error(csk("sourceMismatch"));
  const overview = await fetchGameOverview(saved.project_id, true);
  if (overview.connection.project_id !== saved.project_id || connectionRoot(overview.connection.root) !== connectionRoot(saved.root)) throw new Error(csk("sourceMismatch"));
  if (!overview.skeleton) throw new Error(csk("sourceUnavailable"));
  if (overview.skeleton.source.path !== saved.path) throw new Error(csk("sourceMismatch"));
  return ensureGameSkeletonOnCanvas(saved.project_id, saved.title, saved.root, overview.skeleton, overview.documents, objectId);
}

export async function refreshGameLoopOnCanvas(saved: CanvasSourceTable, objectId?: string): Promise<string> {
  const { connection } = await fetchGameConnection(saved.project_id);
  if (!connection || connection.project_id !== saved.project_id || connectionRoot(connection.root) !== connectionRoot(saved.root)) throw new Error(csk("sourceMismatch"));
  const overview = await fetchGameOverview(saved.project_id, true);
  if (overview.connection.project_id !== saved.project_id || connectionRoot(overview.connection.root) !== connectionRoot(saved.root)) throw new Error(csk("sourceMismatch"));
  if (!overview.loop) throw new Error(csk("loopUnavailable"));
  if (overview.loop.source.path !== saved.path || overview.loop.source.heading !== saved.heading) throw new Error(csk("sourceMismatch"));
  return ensureGameLoopOnCanvas(saved.project_id, saved.title, saved.root, overview.loop, objectId);
}
