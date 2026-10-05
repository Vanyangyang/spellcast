import type { CanvasSelection } from "./canvas";
import type { BoardSnapshot, CanvasObject, CanvasSourceSkeleton, CanvasSourceTable } from "./types";
import { workspaceIdentity } from "./content-origin";
import { fetchGameConnection } from "./project-game-api";
import { fetchGameOverview, type SourceStamp } from "./project-game-home-api";
import { cgd } from "./i18n/canvas-game-design";

type GameSource = CanvasSourceSkeleton | CanvasSourceTable;
type GameObject = CanvasObject & { content: { type: "source_skeleton"; skeleton: CanvasSourceSkeleton } | { type: "source_table"; table: CanvasSourceTable } };
export type GameDesignContext = { status: "ready"; projectId: string; root: string; label: string; count: number; objects: GameObject[]; sources: SourceStamp[] };
export type GameDesignSelection = GameDesignContext | { status: "none" | "mixed" | "stale" };

export function gameSource(object: CanvasObject | undefined): GameSource | undefined {
  return object?.content.type === "source_skeleton" ? object.content.skeleton : object?.content.type === "source_table" ? object.content.table : undefined;
}

function gameRootPath(root: string): string {
  const value = root.trim().replaceAll("\\", "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  // Older source identities stripped a drive root's trailing slash when saved.
  return /^[a-z]:$/i.test(value) ? `${value}/` : value;
}
function gameWorkspaceIdentity(root: string): string {
  return workspaceIdentity(gameRootPath(root));
}

/** A source card establishes project identity; ordinary notes remain references, not routing votes. */
export function resolveGameDesignSelection(board: BoardSnapshot, selection: CanvasSelection | null): GameDesignSelection {
  const ids = new Set([...(selection?.object_ids ?? []), ...(selection?.anchors?.map(anchor => anchor.object_id) ?? []), ...(selection?.object_id ? [selection.object_id] : [])]);
  const selected = [...ids].map(id => board.canvas?.objects.find(object => object.id === id));
  if (selected.some(object => !object)) return { status: "stale" };
  const objects = selected.filter((object): object is GameObject => !!gameSource(object));
  if (!objects.length) return { status: "none" };
  const first = gameSource(objects[0])!;
  const identity = gameWorkspaceIdentity(first.root);
  if (!first.project_id || identity === "unsorted") return { status: "stale" };
  if (objects.some(object => { const source = gameSource(object)!; return source.project_id !== first.project_id || gameWorkspaceIdentity(source.root) !== identity; })
    || selected.some(object => object?.content.type === "work_record" && object.content.project_id !== first.project_id)) return { status: "mixed" };
  if (selection?.anchors?.some(anchor => board.canvas?.objects.find(object => object.id === anchor.object_id)?.content_revision !== anchor.content_revision)) return { status: "stale" };

  const sources = new Map<string, SourceStamp>();
  const remember = (source: SourceStamp) => {
    if (!source.path || !source.hash) return false;
    const previous = sources.get(source.path);
    if (previous && previous.hash.toLowerCase() !== source.hash.toLowerCase()) return false;
    sources.set(source.path, { path: source.path, hash: source.hash }); return true;
  };
  for (const object of objects) {
    const source = gameSource(object)!;
    if (!remember(source)) return { status: "stale" };
    if (object.content.type !== "source_skeleton") continue;
    const skeleton = object.content.skeleton;
    const selectedNodes = selection?.anchors?.filter(anchor => anchor.object_id === object.id && anchor.block_id).map(anchor => anchor.block_id!) ?? [];
    if (selectedNodes.some(id => !skeleton.model.nodes.some(node => node.id === id))) return { status: "stale" };
    const paths = selectedNodes.length ? new Set(skeleton.model.nodes.filter(node => selectedNodes.includes(node.id))
      .flatMap(node => [...node.sources, ...(node.provenance ?? []).filter(item => !item.archived).map(item => item.path)])) : undefined;
    for (const document of skeleton.documents) {
      if (document.error || (paths && !paths.has(document.path))) continue;
      if (!remember(document)) return { status: "stale" };
    }
  }
  return { status: "ready", projectId: first.project_id, root: gameRootPath(first.root),
    label: objects[0].origin?.label?.trim() || first.root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || first.title,
    count: selection?.anchors?.length || ids.size, objects, sources: [...sources.values()] };
}

/** Reads current metadata only. A changed snapshot must be explicitly refreshed by the user. */
export async function verifyGameDesignSources(context: GameDesignContext): Promise<void> {
  const { connection } = await fetchGameConnection(context.projectId);
  if (!connection || connection.project_id !== context.projectId || gameWorkspaceIdentity(connection.root) !== gameWorkspaceIdentity(context.root)) throw new Error(cgd("stale"));
  const overview = await fetchGameOverview(context.projectId, true);
  if (overview.connection.project_id !== context.projectId || gameWorkspaceIdentity(overview.connection.root) !== gameWorkspaceIdentity(context.root)) throw new Error(cgd("stale"));
  const live = new Map<string, string>();
  for (const document of overview.documents) if (!document.error) live.set(document.path, document.hash.toLowerCase());
  if (overview.skeleton) live.set(overview.skeleton.source.path, overview.skeleton.source.hash.toLowerCase());
  if (overview.loop) live.set(overview.loop.source.path, overview.loop.source.hash.toLowerCase());
  if (context.sources.some(source => live.get(source.path) !== source.hash.toLowerCase())) throw new Error(cgd("stale"));
}

export function gameDesignCheckRequest(context: GameDesignContext): string {
  return `${cgd("check")}\n\n${cgd("request", { project: context.label, root: context.root,
    sources: context.sources.map(source => `- ${source.path} · SHA-256 ${source.hash}`).join("\n") })}`;
}
