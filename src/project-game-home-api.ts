import { projectOwnerGet, projectOwnerPost, mutateProject, newProjectRequestId, type RecordActor, type RecordFields, type SourceReference, type RecordMutationResult } from "./project-record-api";
import type { PlanningFields } from "./project-planning-model";
import type { GameConnection, GameResponse } from "./project-game-api";
import type { DeliveryPhase } from "./types";
import type { GameSkeleton } from "./project-game-skeleton-model";

export type SourceStamp = { path: string; hash: string };
export type GameIssue = { severity: string; message: string; path: string };
export type OverviewZone = { id: string; name: string; locations: number; routes: number; path?: string; hidden?: boolean; configured?: boolean };
export type OverviewDungeon = { id: string; name: string; type?: string; boss_id?: string; zones: OverviewZone[]; source: SourceStamp };
export type OverviewRegion = { id: string; name: string; description?: string; unlocked_by_default?: boolean; connected?: string[]; main_quest_id: string;
  main_quest_found: boolean; in_world: boolean; dungeons: OverviewDungeon[]; source: SourceStamp };
export type PlayerLoop = { source: SourceStamp & { heading: string; line: number }; columns: string[]; rows: string[][]; basis: "design" };
export type GameDocument = SourceStamp & { title: string; lines?: number; headings?: number; identifiers?: number; error?: string };
export type GameOverview = {
  connection: GameConnection;
  world: { id: string; name: string; description?: string; starting_region_id?: string; region_order?: string[]; source: SourceStamp } | null;
  loop: PlayerLoop | null;
  skeleton?: GameSkeleton | null;
  regions: OverviewRegion[];
  routed_zones: Array<OverviewZone & { dungeon_id: string; region_id: string }>;
  counts: Record<"regions" | "dungeons" | "zones" | "routed_zones" | "locations" | "contents" | "battles" | "loot_tables" | "missions" | "design_documents" | "code_files", number>;
  issues: GameIssue[];
  documents: GameDocument[];
  source_revision: string;
  runtime_verified: false;
};
export type DocMention = { path: string; hash: string; title: string; heading: string; line: number; excerpt: string };
export type CodeHit = { path: string; hash: string; line: number; text: string };
export type MissionLink = { id: string; name: string; description?: string; type?: string; dungeon_id?: string; required_rank?: number;
  objectives: Array<{ id: string; name?: string; type?: string; enemy_id: string; amount?: number; reward_table_id?: string; at: Array<{ location_id: string; candidate_id: string }> }>;
  basis: Array<{ kind: string; text: string }>; source: SourceStamp };
export type GameRelations = {
  error?: string;
  region: { id: string; name: string; description?: string; source: SourceStamp } | null;
  dungeon: { id: string; name: string; type?: string; zone_ids?: string[]; boss_id?: string; source: SourceStamp } | null;
  missions: MissionLink[];
  design: Record<string, DocMention[]>;
  code: Record<string, CodeHit[]>;
  loop: PlayerLoop | null;
};
export type ZoneResponse = GameResponse & { relations?: GameRelations };

export type GoalContext = { scale: "" | "overview" | "experience" | "object"; zone_id: string; location_id: string; entity_kind: string; entity_id: string;
  label: string; source_revision: string; sources: SourceStamp[] };
export type GoalDelivery = { phase: DeliveryPhase; error?: string; host_status?: string; attention?: string; received_at_ms?: number; handled_at_ms?: number };
export type Goal = { id: string; project_id: string; text: string; context: GoalContext; status: "unsent" | "sent";
  target?: { source_id: string; thread_id: string; cwd: string; label: string }; sequence?: number; sent_at_ms?: number; record_id?: string;
  revision: number; created_at_ms: number; updated_at_ms: number; delivery: GoalDelivery | null; proposal_ids: string[]; response_record_ids?: string[] };

export type ProposedObject = { name: string; kind: string; archived?: boolean; planning: PlanningFields };
export type ProposalItemStatus = "pending" | "adopted" | "returned" | "dismissed";
export type ProposalDecision = { status: ProposalItemStatus; at_ms: number; actor: RecordActor; request_id: string; note: string; revised: boolean;
  confirmed: boolean; unlocked: boolean; applied_revision?: number };
export type ProposalItem = { id: string; target: "object" | "record"; target_id: string; base_revision: number; object?: ProposedObject; record?: RecordFields;
  reason: string; basis: string[]; references: SourceReference[]; boundaries: string; status: ProposalItemStatus; edited_by?: RecordActor; decision?: ProposalDecision };
export type ProposalSubject = { scale: string; zone_id?: string; location_id?: string; entity_kind?: string; entity_id?: string };
export type ProjectProposal = { id: string; project_id: string; revision: number; title: string; summary: string; subject: ProposalSubject; goal_id?: string;
  items: ProposalItem[]; references: SourceReference[]; boundaries: string; status: "open" | "closed"; created_at_ms: number; updated_at_ms: number;
  created_by: RecordActor; updated_by: RecordActor };
export type ProposalMutation = RecordMutationResult & { proposal?: ProjectProposal; adopted_objects?: import("./project-record-api").DevelopmentObject[];
  adopted_records?: import("./project-record-api").WorkRecord[] };

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const fetchGameOverview = (id: string, refresh = false) => projectOwnerGet<GameOverview>(`${base(id)}/game/overview${refresh ? "?refresh=true" : ""}`);
export const fetchGameDocument = (id: string, path: string) => projectOwnerGet<GameDocument & { text: string }>(`${base(id)}/game/document?${new URLSearchParams({ path })}`);
export const fetchGoals = (id: string) => projectOwnerGet<Goal[]>(`${base(id)}/goals`);
export const createGoal = (id: string, body: { id: string; text: string; context: GoalContext }) => projectOwnerPost<Goal>(`${base(id)}/goals`, body);
export const sendGoal = (id: string, goal: string, target: { source_id: string; thread_id: string }) => projectOwnerPost<Goal>(`${base(id)}/goals/${encodeURIComponent(goal)}/send`, target);
export const promoteGoal = (id: string, goal: string) => projectOwnerPost<Goal>(`${base(id)}/goals/${encodeURIComponent(goal)}/record`, {});
export const fetchProposals = (id: string, includeClosed = true) => projectOwnerGet<ProjectProposal[]>(`${base(id)}/proposals${includeClosed ? "?archived=true" : ""}`);
export const returnFeedback = (id: string, body: { request_id: string; proposal_id: string; item_ids: string[]; note: string }) =>
  projectOwnerPost<{ sent: boolean; sequence?: number; reason?: string }>(`${base(id)}/proposals/return`, body);

export type Decision = { decision: "adopt" | "revise" | "return" | "dismiss"; itemIds: string[]; note?: string; revisedObject?: ProposedObject;
  revisedRecord?: RecordFields; confirm?: boolean; unlock?: boolean };

export function decideProposal(projectId: string, proposal: ProjectProposal, decision: Decision, requestId = newProjectRequestId()): Promise<ProposalMutation> {
  return mutateProject({
    request_id: requestId, project_id: projectId, op: "decide_proposal", id: proposal.id, expected_revision: proposal.revision,
    item_ids: decision.itemIds, decision: decision.decision, note: decision.note ?? "",
    ...(decision.revisedObject ? { revised_object: decision.revisedObject } : {}),
    ...(decision.revisedRecord ? { revised_record: decision.revisedRecord } : {}),
    confirm: decision.confirm ?? true, unlock: decision.unlock ?? false,
  }) as Promise<ProposalMutation>;
}
