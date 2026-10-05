// Window client for sigils (法阵). Writes carry the main window's private credential; agents use
// the native MCP tools instead.
import { apiBase } from "./api";
import { newProjectRequestId, projectOwnerPost } from "./project-record-api";
import type { BoardSnapshot, DeliveryPhase, DeliveryReceipt } from "./types";

export type SigilState = "draft" | "frozen" | "running" | "paused" | "completed" | "aborted" | "archived";
export type SigilLocation = "worktree" | "in_place";

/** The list endpoint returns a step count, not the full step definitions. */
export type SigilSummary = {
  id: string;
  title: string;
  state: SigilState;
  revision: number;
  owner_source: string;
  updated_at_ms: number;
  steps: number;
};

export type SigilCheck =
  | { kind: "command"; label: string; argv: string[]; timeout_s: number }
  | { kind: "manual"; label: string; description: string };

export type SigilStep = {
  id: string;
  title: string;
  instructions: string;
  inputs: string[];
  scope: string[];
  checks: SigilCheck[];
  depends_on: string[];
  stop_when: string[];
};

export type SigilCommand = { step_id: string; label: string; argv: string[]; timeout_s: number };

export type StepLight = "pending" | "ready" | "running" | "verifying" | "passed" | "done_unverified" | "failed" | "needs_you" | "skipped";

/** One file in a change list. `size` marks a large new file that was listed but not stored. */
export type ChangedPath = {
  path: string;
  status: string;
  added?: number;
  deleted?: number;
  binary?: boolean;
  size?: number;
  out_of_scope?: boolean;
};

export type StepMarker = { kind: string; at_ms: number; detail?: string };

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "waiting" | "needs_approval" | "stopped";

/** One check of a step's latest report. Command output beyond `tail` comes from the step view. */
export type CheckResult = {
  index: number;
  kind: "command" | "manual";
  label: string;
  attempt: number;
  status: CheckStatus;
  run?: number;
  started_at_ms?: number;
  finished_at_ms?: number;
  exit_code?: number;
  timed_out?: boolean;
  error?: string;
  tail?: string;
  output_bytes?: number;
  disturbed?: string[];
  disturbed_files?: number;
  note?: string;
};

export type StepProgress = {
  status: "pending" | "active" | "reported" | "blocked" | "skipped";
  attempt: number;
  summary?: string;
  block_reason?: string;
  markers?: StepMarker[];
  changes?: ChangedPath[];
  changed_files?: number;
  outside_scope?: string[];
  checks?: CheckResult[];
};

export type OutsideChanges = { from_tree: string; to_tree: string; first_at_ms: number; last_at_ms: number; files: ChangedPath[]; changed_files: number };

export type SigilObservation = {
  baseline_tree: string;
  tree: string;
  observed_at_ms: number;
  partial?: string[];
  outside?: OutsideChanges[];
  inputs_differ_at_start?: string[];
  private_bytes: number;
  stopped?: "size_cap" | "unavailable" | string;
  stopped_detail?: string;
};

/** Timing of the latest snapshot, kept in memory by the app; null before the first one. */
export type ObservationLive = { last_at_ms: number; duration_ms: number; interval_ms: number; error: string } | null;

/** The command running now and its newest output; null when none runs. */
export type CheckLive = { step_id: string; index: number; run: number; label: string; started_at_ms: number; output_tail: string; output_bytes: number } | null;

export type SigilRun = {
  started_at_ms: number;
  execution_directory: string;
  location: SigilLocation;
  branch: string;
  base_ref: string;
  base_commit: string;
  executor?: { source_id: string; label: string; since_ms: number };
  pending_claims: { source_id: string; label: string; at_ms: number }[];
  revoked: string[];
  replaced: string[];
  steps: Record<string, StepProgress>;
  observation?: SigilObservation;
  amendments?: SigilAmendment[];
};

/** One change of an amendment; `fields` lists what an update changed. */
export type AmendmentChange = { kind: "add_step" | "update_step" | "skip_step"; step_id: string; fields?: string[] };

/** An agent's change to the running plan, named by the revision it produced. */
export type SigilAmendment = { revision: number; at_ms: number; source_id: string; reason: string; changes: AmendmentChange[]; reverted_at_ms?: number };

/** A command an amendment added or changed, waiting for the user's approval. */
export type PendingCommand = { step_id: string; index: number; label: string; argv: string[]; timeout_s: number };

export type Sigil = {
  id: string;
  title: string;
  goal: string;
  repository: string;
  base_ref: string;
  location: SigilLocation;
  worktree_path: string;
  materials: { object_id: string; content_revision: number }[];
  open_questions: string[];
  steps: SigilStep[];
  state: SigilState;
  revision: number;
  owner_source: string;
  created_at_ms: number;
  updated_at_ms: number;
  updated_by: { kind: string; source_id?: string; label: string };
  freeze?: { at_ms: number; revision: number; commands: SigilCommand[]; execution_directory: string };
  run?: SigilRun;
};

export type SigilIssue = { level: "error" | "warning"; step_id?: string; code: string; message: string };

export type SigilReview = {
  can_freeze: boolean;
  issues: SigilIssue[];
  commands: SigilCommand[];
  location: SigilLocation;
  execution_directory: string;
};

export type SigilDelivery = {
  source_id: string;
  target_label: string;
  thread_id: string | null;
  cwd: string | null;
  started_at_ms: number | null;
  request_id: string | null;
  sequence: number | null;
  phase: DeliveryPhase | "reserved" | "local" | null;
  /** A recorded delivery's problem; never the plan's lifecycle. */
  error: string | null;
  /** Stable code: why the original session cannot take this plan, whatever its state. */
  handover_unavailable?: string | null;
  can_dispatch: boolean;
  can_retry: boolean;
  fallback_instruction: string;
  receipt: DeliveryReceipt | null;
};

export type SigilView = {
  sigil: Sigil;
  review: SigilReview;
  lights: Record<string, StepLight>;
  next: string | null;
  card_id: string;
  observation_live?: ObservationLive;
  check_live?: CheckLive;
  pending_commands?: PendingCommand[];
  delivery?: SigilDelivery;
};

/** One step with its check results and the kept output of each command run, keyed by run. */
export type SigilStepView = {
  sigil_id: string;
  step: SigilStep;
  light: StepLight;
  progress: StepProgress;
  outputs: Record<string, string>;
  max_output_bytes: number;
};

export type SigilDiff = { patch: string; truncated: boolean; max_bytes: number; path: string; step_id: string; outside: number | null };

export type SigilResult = {
  sigil_id: string;
  sigil?: Sigil;
  review?: SigilReview;
  created: boolean;
  deleted: boolean;
  replayed: boolean;
  card_id: string;
  kept_cards?: string[];
  card_error?: string;
};

const path = (id: string, action = "") => `/api/sigils/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

/** Read every sigil independently of whether its Canvas card is pinned. */
export async function fetchSigils(signal?: AbortSignal): Promise<SigilSummary[]> {
  const response = await fetch(`${await apiBase()}/api/sigils`, { signal });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
    throw new Error(typeof error === "string" ? error : `HTTP ${response.status}`);
  }
  const states: SigilState[] = ["draft", "frozen", "running", "paused", "completed", "aborted", "archived"];
  if (!Array.isArray(body) || !body.every(value => value && typeof value === "object"
    && typeof value.id === "string" && value.id.length > 0 && typeof value.title === "string"
    && states.includes(value.state) && Number.isInteger(value.revision) && typeof value.owner_source === "string"
    && Number.isFinite(value.updated_at_ms) && Number.isInteger(value.steps) && value.steps >= 0)
    || new Set(body.map(value => value.id)).size !== body.length) {
    throw new Error("Invalid sigil list response");
  }
  return body as SigilSummary[];
}

/** Reading needs no window credential, so the card also loads in the browser preview. */
export async function fetchSigil(id: string): Promise<SigilView> {
  const response = await fetch(`${await apiBase()}${path(id)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  return body as SigilView;
}

/** The observed patch of a step, or of edits made outside any step; read-only like the sigil. */
export async function fetchSigilDiff(id: string, target: { step_id?: string; outside?: number; path?: string }): Promise<SigilDiff> {
  const query = new URLSearchParams();
  if (target.step_id) query.set("step_id", target.step_id);
  if (target.outside !== undefined) query.set("outside", String(target.outside));
  if (target.path) query.set("path", target.path);
  const response = await fetch(`${await apiBase()}${path(id, "diff")}?${query}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  return body as SigilDiff;
}

/** A step with its check outputs; read-only like the sigil. */
export async function fetchSigilStep(id: string, stepId: string): Promise<SigilStepView> {
  const response = await fetch(`${await apiBase()}${path(id, "step")}?${new URLSearchParams({ step_id: stepId })}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  return body as SigilStepView;
}

function transition(id: string, action: "freeze" | "unfreeze" | "delete", expectedRevision: number): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, action), { request_id: newProjectRequestId(), expected_revision: expectedRevision });
}

export const freezeSigil = (id: string, expectedRevision: number) => transition(id, "freeze", expectedRevision);
export const unfreezeSigil = (id: string, expectedRevision: number) => transition(id, "unfreeze", expectedRevision);
export const deleteSigil = (id: string, expectedRevision: number) => transition(id, "delete", expectedRevision);

export function pinSigil(id: string): Promise<BoardSnapshot> {
  return projectOwnerPost<BoardSnapshot>(path(id, "pin"), { request_id: newProjectRequestId() });
}

export function startSigil(id: string, expectedRevision: number): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "start"), { request_id: newProjectRequestId(), expected_revision: expectedRevision });
}

/** Native code binds this run to its original verified session and reuses its receipt. */
export function dispatchSigil(id: string, startedAtMs: number, retry = false): Promise<SigilView & { replayed: boolean }> {
  return projectOwnerPost<SigilView & { replayed: boolean }>(path(id, "dispatch"), {
    request_id: newProjectRequestId(), started_at_ms: startedAtMs, ...(retry ? { retry: true } : {}),
  });
}

export function controlSigil(id: string, action: "pause" | "resume" | "abort" | "revoke"): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, action), { request_id: newProjectRequestId() });
}

export function decideHandover(id: string, sourceId: string, approve: boolean): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "handover"), { request_id: newProjectRequestId(), source_id: sourceId, approve });
}

export function noteSigil(id: string, text: string): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "note"), { request_id: newProjectRequestId(), text });
}

export function decideCheck(id: string, stepId: string, index: number, passed: boolean, note: string): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "checks/decide"), { request_id: newProjectRequestId(), step_id: stepId, index, passed, note });
}

export function rerunChecks(id: string, stepId: string): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "checks/rerun"), { request_id: newProjectRequestId(), step_id: stepId });
}

export function approveCommand(id: string, stepId: string, index: number): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "commands/approve"), { request_id: newProjectRequestId(), step_id: stepId, index });
}

export function revertAmendment(id: string, revision: number): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "amendments/revert"), { request_id: newProjectRequestId(), revision });
}

export function reopenStep(id: string, stepId: string): Promise<SigilResult> {
  return projectOwnerPost<SigilResult>(path(id, "steps/reopen"), { request_id: newProjectRequestId(), step_id: stepId });
}
