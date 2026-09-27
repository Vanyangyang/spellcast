import { applyCanvasBatch, fetchBoard, restoreCanvasItem } from "./api";
import { gh } from "./i18n/game-home";
import type { PlayerLoop } from "./project-game-home-api";
import type { BoardSnapshot, CanvasSourceTable } from "./types";

const normalizedRoot = (root: string) => {
  const value = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
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
export async function ensureGameLoopOnCanvas(projectId: string, projectName: string, root: string, loop: PlayerLoop): Promise<string> {
  const table = sourceTable(projectId, root, loop);
  const id = await tableId(projectId, root, table.path, table.heading);
  let board: BoardSnapshot = await fetchBoard();
  let object = board.canvas?.objects.find(item => item.id === id);
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
  if (object?.content.type !== "source_table" || object.content.table.project_id !== projectId || object.content.table.root !== table.root
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
  if (placement?.removed) {
    try { board = await restoreCanvasItem(id, placement.revision); }
    catch (error) {
      board = await fetchBoard();
      if (board.canvas?.items.find(item => item.item_id === id)?.removed !== false) throw error;
    }
  }
  return id;
}
