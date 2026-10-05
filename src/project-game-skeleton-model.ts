import type { SourceStamp } from "./project-game-home-api";

/** Authored game structure. It describes design and navigation, never runtime completion. */
export type SkeletonNode = {
  id: string;
  kind: "system" | "region" | "structure" | "rule" | "world" | "reference";
  title: string;
  summary: string;
  parent_id?: string;
  state: "rules_preserved" | "structure_only" | "world_basis" | "supporting_reference" | "needs_reconciliation";
  notes?: string[];
  steps?: Array<{ title: string; text: string }>;
  /** Retained design semantics, visible and discussable within the selected node. */
  rule?: Partial<Record<"trigger" | "conditions" | "effects" | "exceptions" | "formulas" | "conflicts", string[]>>;
  /** Evidence remains read-only. Archived paths identify history; they are never opened as current documents. */
  provenance?: Array<{ path: string; hash: string; start_line: number; end_line: number; quote: string; archived?: boolean }>;
  /** Repository-relative Markdown references; auxiliary reading only. */
  sources: string[];
};

export type SkeletonRelation = { from: string; to: string; label: string };
export type SkeletonLoopStage = { id: string; title: string; summary: string; node_ids: string[] };
export type GameSkeletonModel = {
  schema_version: 1;
  title: string;
  description: string;
  entry_ids: string[];
  loop: SkeletonLoopStage[];
  nodes: SkeletonNode[];
  relations: SkeletonRelation[];
};
export type GameSkeleton = { source: SourceStamp; model: GameSkeletonModel };
