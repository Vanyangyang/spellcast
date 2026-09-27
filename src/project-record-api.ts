import { apiBase, inTauri } from "./api";
import { pt } from "./i18n/projects";
import type { BoardSnapshot } from "./types";
import type { PlanningFields } from "./project-planning-model";
import type { FlowRun } from "./game-flow-model";

export type Project = {
  id: string;
  name: string;
  aliases: string[];
  revision: number;
  archived: boolean;
  created_at_ms: number;
  updated_at_ms: number;
};

export type DevelopmentObject = {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  revision: number;
  archived: boolean;
  planning?: PlanningFields;
};

export type RecordStatus = "planned" | "active" | "blocked" | "done" | "cancelled";

export type SourceReference = {
  label: string;
  uri: string;
  version: string;
};

export type RecordFields = {
  object_id?: string | null;
  title: string;
  goal?: string;
  scope?: string;
  status?: RecordStatus;
  result?: string;
  boundaries?: string;
  next_step?: string;
  references?: SourceReference[];
};

export type RecordActor = {
  kind: string;
  source_id?: string | null;
  thread_id?: string | null;
  cwd?: string | null;
  label: string;
};

export type WorkRecord = RecordFields & {
  id: string;
  project_id: string;
  revision: number;
  archived: boolean;
  created_at_ms: number;
  updated_at_ms: number;
  updated_by: RecordActor;
};

export type RecordHistory = {
  project_id: string;
  kind: "project" | "object" | "record" | "candidate";
  id: string;
  revision: number;
  at_ms: number;
  actor: RecordActor;
  operation: string;
  request_id: string;
  snapshot: unknown;
};

/** The execution-relevant parameter definition a candidate was compared against. */
export type CandidateBase = { revision: number; value: string; unit: string; min: string; max: string };

/** A project-level numeric proposal. Saving it never edits or unlocks the parameter. */
export type ParameterCandidate = {
  id: string;
  project_id: string;
  parameter_id: string;
  label: string;
  value: string;
  reason: string;
  base: CandidateBase;
  from_variant?: string;
  revision: number;
  archived: boolean;
  created_at_ms: number;
  updated_at_ms: number;
  updated_by: RecordActor;
};

export type TrialOrigin = "walkthrough" | "replay" | "legacy_local";

/** One immutable saved walkthrough; continuing or rewinding never rewrites it. */
export type FlowTrial = {
  id: string;
  project_id: string;
  flow_id: string;
  flow_revision: number;
  label: string;
  origin: TrialOrigin;
  parent_trial_id?: string;
  digest: string;
  created_at_ms: number;
  created_by: RecordActor;
  run: FlowRun;
};

export type TrialSummary = {
  id: string;
  project_id: string;
  flow_id: string;
  flow_revision: number;
  flow_name: string;
  label: string;
  origin: TrialOrigin;
  parent_trial_id?: string;
  base_trial_id?: string;
  replay_status?: "paused" | "diverged" | "complete";
  digest: string;
  created_at_ms: number;
  created_by: string;
  event_count: number;
  manual_count: number;
  assumption_count: number;
  end_step_id: string;
  end_step_title: string;
  terminal: boolean;
  parameter_ids: string[];
  candidates: Array<{ id: string; revision: number; parameter_id: string; label: string; value: string }>;
};

export type CandidateAdoption = {
  id: string;
  project_id: string;
  parameter_id: string;
  parameter_revision_before: number;
  parameter_revision_after: number;
  value_before: string;
  value_after: string;
  candidate: ParameterCandidate;
  trial_ids: string[];
  reason: string;
  at_ms: number;
  actor: RecordActor;
  request_id: string;
};

export type ProjectExport = {
  format: "spellcast.project";
  version: 1 | 2 | 3 | 4;
  exported_at_ms: number;
  project: Project;
  objects: DevelopmentObject[];
  records: WorkRecord[];
  history: RecordHistory[];
  external_files: Array<{ uri: string; original_included: false }>;
  candidates?: ParameterCandidate[];
  trials?: FlowTrial[];
  adoptions?: CandidateAdoption[];
};

export type ProjectAccess = {
  id: string;
  project_id: string;
  source_id: string;
  thread_id: string;
  cwd: string;
  label: string;
  state: "pending" | "approved" | "revoked";
  revision: number;
  created_at_ms: number;
  expires_at_ms: number | null;
};

export type RecordMutationResult = {
  project?: Project;
  object?: DevelopmentObject;
  record?: WorkRecord;
  candidate?: ParameterCandidate;
  trial?: TrialSummary;
  adoption?: CandidateAdoption;
  replayed: boolean;
  /** Identical trial content was already saved; no second copy was created. */
  deduplicated?: boolean;
};

type CommandBase = { request_id: string; project_id: string };

export type RecordCommand =
  | (CommandBase & { op: "create_project"; name: string; aliases: string[] })
  | (CommandBase & { op: "update_project"; expected_revision: number; name: string; aliases: string[]; archived: boolean })
  | (CommandBase & { op: "put_object"; id: string; expected_revision: number; name: string; kind: string; archived: boolean; planning?: PlanningFields })
  | (CommandBase & { op: "restore_object"; id: string; expected_revision: number; restore_revision: number })
  | (CommandBase & { op: "set_object_lock"; id: string; expected_revision: number; locked: boolean })
  | (CommandBase & { op: "put_record"; id: string; expected_revision: number; fields: RecordFields })
  | (CommandBase & { op: "archive_record"; id: string; expected_revision: number; archived: boolean })
  | (CommandBase & { op: "restore_record"; id: string; expected_revision: number; restore_revision: number })
  | (CommandBase & { op: "import_project"; bundle: ProjectExport; name: string })
  | (CommandBase & { op: "put_candidate"; id: string; expected_revision: number; parameter_id: string; label: string; value: string; reason: string; base_revision: number; archived: boolean; from_variant?: string })
  | (CommandBase & { op: "save_trial"; id: string; label: string; origin: TrialOrigin; parent_trial_id?: string; run: FlowRun })
  | (CommandBase & { op: "adopt_candidate"; adoption_id: string; parameter_id: string; expected_revision: number; candidate_id: string; candidate_revision: number; trial_ids: string[]; reason: string; lock_after: boolean })
  | (CommandBase & { op: "decide_proposal"; id: string; expected_revision: number; item_ids: string[]; decision: "adopt" | "revise" | "return" | "dismiss"; note: string;
      revised_object?: { name: string; kind: string; archived?: boolean; planning: PlanningFields }; revised_record?: RecordFields; confirm: boolean; unlock: boolean });

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : undefined;
    throw new Error(typeof error === "string" && error ? error : `Project request failed (${response.status}).`);
  }
  return body as T;
}

async function get<T>(path: string): Promise<T> {
  return read<T>(await fetch(`${await apiBase()}${path}`));
}

let projectWindowKey: Promise<string> | null = null;

async function windowKey(): Promise<string> {
  if (!inTauri()) throw new Error(pt("desktopOnly"));
  projectWindowKey ??= import("@tauri-apps/api/core").then(({ invoke }) => invoke<string>("project_window_key"));
  try {
    return await projectWindowKey;
  } catch (error) {
    projectWindowKey = null;
    throw error;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const key = await windowKey();
  return read<T>(await fetch(`${await apiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-spellcast-window": key },
    body: JSON.stringify(body),
  }));
}

export async function projectOwnerGet<T>(path: string): Promise<T> {
  return read<T>(await fetch(`${await apiBase()}${path}`, { headers: { "x-spellcast-window": await windowKey() } }));
}

export async function projectOwnerPost<T>(path: string, body: unknown): Promise<T> {
  return post<T>(path, body);
}

export function newProjectRequestId(): string {
  return crypto.randomUUID();
}

export async function fetchProjects(): Promise<Project[]> {
  return get<Project[]>("/api/projects");
}

export async function fetchProjectObjects(projectId: string): Promise<DevelopmentObject[]> {
  return get<DevelopmentObject[]>(`/api/projects/${encodeURIComponent(projectId)}/objects`);
}

export async function fetchProjectRecords(projectId: string, filters: { query?: string; status?: RecordStatus | ""; includeArchived?: boolean } = {}): Promise<WorkRecord[]> {
  const query = new URLSearchParams();
  if (filters.query?.trim()) query.set("query", filters.query.trim());
  if (filters.status) query.set("status", filters.status);
  if (filters.includeArchived) query.set("archived", "true");
  const suffix = query.size ? `?${query}` : "";
  return get<WorkRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/records${suffix}`);
}

export async function fetchProjectRecord(projectId: string, recordId: string): Promise<WorkRecord> {
  return get<WorkRecord>(`/api/projects/${encodeURIComponent(projectId)}/records/${encodeURIComponent(recordId)}`);
}

export async function fetchProjectHistory(projectId: string, kind: RecordHistory["kind"], id: string): Promise<RecordHistory[]> {
  return get<RecordHistory[]>(`/api/projects/${encodeURIComponent(projectId)}/history/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
}

export async function fetchProjectCandidates(projectId: string): Promise<ParameterCandidate[]> {
  return get<ParameterCandidate[]>(`/api/projects/${encodeURIComponent(projectId)}/candidates`);
}

/** Newest first; summaries only. */
export async function fetchProjectTrials(projectId: string, flowId = ""): Promise<TrialSummary[]> {
  const suffix = flowId ? `?${new URLSearchParams({ flow_id: flowId })}` : "";
  return get<TrialSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/trials${suffix}`);
}

export async function fetchProjectTrial(projectId: string, trialId: string): Promise<FlowTrial> {
  return get<FlowTrial>(`/api/projects/${encodeURIComponent(projectId)}/trials/${encodeURIComponent(trialId)}`);
}

export async function fetchProjectAdoptions(projectId: string): Promise<CandidateAdoption[]> {
  return get<CandidateAdoption[]>(`/api/projects/${encodeURIComponent(projectId)}/adoptions`);
}

export async function mutateProject(command: RecordCommand): Promise<RecordMutationResult> {
  return post<RecordMutationResult>("/api/projects/command", command);
}

export async function exportProject(projectId: string): Promise<ProjectExport> {
  return get<ProjectExport>(`/api/projects/${encodeURIComponent(projectId)}/export`);
}

export async function exportProjectMarkdown(projectId: string): Promise<{ markdown: string }> {
  return get<{ markdown: string }>(`/api/projects/${encodeURIComponent(projectId)}/markdown`);
}

export async function pinProjectRecord(projectId: string, recordId: string, requestId: string): Promise<BoardSnapshot> {
  return post<BoardSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/pin`, { record_id: recordId, request_id: requestId });
}

export async function fetchProjectAccess(projectId: string): Promise<ProjectAccess[]> {
  return get<ProjectAccess[]>(`/api/projects/${encodeURIComponent(projectId)}/access`);
}

export async function decideProjectAccess(projectId: string, accessId: string, expectedRevision: number, decision: "approved" | "revoked"): Promise<ProjectAccess> {
  return post<ProjectAccess>(`/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(accessId)}`, {
    expected_revision: expectedRevision,
    decision,
  });
}
