import type { BoardSnapshot, CanvasObject, CapturedContext, CodexBinding } from "./types";

export type ContentOrigin = {
  workspaceKey: string;
  workspaceLabel: string;
  cwd: string;
  taskKey: string;
  taskLabel: string;
  project: string;
  captured: boolean;
};

/** Workspace identity comes from a recorded path, never a model/project label. */
export function workspaceIdentity(cwd: string) {
  const value = cwd.trim();
  if (!value) return "unsorted";
  const slashes = value.replace(/\\/g, "/");
  if (!slashes.startsWith("/") && !/^[a-z]:\//i.test(slashes)) return "unsorted";
  const normalized = /^[a-z]:\/+$/i.test(slashes) ? `${slashes.slice(0, 2)}/` : slashes.replace(/\/+$/, "") || "/";
  return `workspace:${/^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized}`;
}

export function resolveContentOrigin(context: Partial<CapturedContext> | null | undefined, sourceId: string | null | undefined, bindings: CodexBinding[]): ContentOrigin {
  const source = context?.source_id || sourceId;
  const candidate = bindings.find(binding => binding.source_id === source);
  // A source can later be rebound. Its current binding cannot replace captured provenance.
  const binding = candidate && (!context?.thread_id || candidate.thread_id === context.thread_id) ? candidate : undefined;
  const candidateCwd = context?.cwd?.trim() || binding?.cwd?.trim() || "";
  const cwd = workspaceIdentity(candidateCwd) === "unsorted" ? "" : candidateCwd;
  const threadId = context?.thread_id || binding?.thread_id || "";
  const taskLabel = binding?.label?.trim() || context?.goal?.trim() || "";
  return {
    workspaceKey: workspaceIdentity(cwd),
    workspaceLabel: cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || cwd,
    cwd,
    taskKey: threadId ? `thread:${threadId}` : source ? `source:${source}` : "unsorted",
    taskLabel,
    project: context?.project?.trim() || "",
    captured: Boolean(context?.cwd),
  };
}

export function originForObject(object: CanvasObject, board: BoardSnapshot, bindings: CodexBinding[]) {
  const content = object.content;
  if (content.type === "node") {
    const node = board.nodes.find(item => item.id === content.id);
    return resolveContentOrigin(node?.captured_context, node?.source_id || object.source_id, bindings);
  }
  if (content.type === "reply") {
    const reply = board.replies?.find(item => item.id === content.id);
    const origin = reply?.origin_node_id ? board.nodes.find(item => item.id === reply.origin_node_id) : undefined;
    // An explicit continuation inherits its captured origin only when the source agrees.
    const context = origin?.source_id === reply?.source_id ? origin?.captured_context : undefined;
    return resolveContentOrigin(context, reply?.source_id || object.source_id, bindings);
  }
  const origin = object.origin;
  return resolveContentOrigin(origin ? { cwd: origin.cwd, thread_id: origin.thread_id, source_id: origin.source_id || undefined, goal: origin.label } : undefined, object.source_id, bindings);
}

export function originMatches(origin: ContentOrigin, workspace: string, task = "all") {
  return (workspace === "all" || origin.workspaceKey === workspace) && (task === "all" || origin.taskKey === task);
}

/** Keep a visible selection in view when a new task binding classifies its source. */
export function scopeForReclassifiedSelection(scope: { workspace: string; task: string }, origins: ContentOrigin[]) {
  if (!origins.length || origins.every(origin => originMatches(origin, scope.workspace, scope.task))) return null;
  const workspaces = new Set(origins.map(origin => origin.workspaceKey));
  const tasks = new Set(origins.map(origin => origin.taskKey));
  return {
    workspace: scope.workspace === "all" ? "all" : workspaces.size === 1 ? origins[0].workspaceKey : "all",
    task: scope.task === "all" ? "all" : tasks.size === 1 ? origins[0].taskKey : "all",
  };
}
