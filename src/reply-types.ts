/** Structured replies are documents on the board, independent of the loose-fragment layout. */
export type ReplyTextBlock = {
  id: string;
  type: "text";
  title?: string;
  text: string;
};

export type ReplyOption = {
  id: string;
  title: string;
  summary: string;
  values: string[];
};

export type ReplyComparisonBlock = {
  id: string;
  type: "comparison";
  title?: string;
  criteria: string[];
  options: ReplyOption[];
  selected_id?: string | null;
};

export type ReplyGraphNode = {
  id: string;
  title: string;
  detail?: string;
  x?: number | null;
  y?: number | null;
};

export type ReplyGraphEdge = { id: string; from: string; to: string; label: string };

export type ReplyGraphBlock = {
  id: string;
  type: "graph";
  title?: string;
  nodes: ReplyGraphNode[];
  edges: ReplyGraphEdge[];
};

export type ReplyStep = {
  id: string;
  title: string;
  action: string;
  feedback?: string;
  note?: string;
};

export type ReplySequenceBlock = {
  id: string;
  type: "sequence";
  title?: string;
  steps: ReplyStep[];
};

export type ReplyBlock =
  | ReplyTextBlock
  | ReplyComparisonBlock
  | ReplyGraphBlock
  | ReplySequenceBlock
  | ReplyArtifactBlock;

export type ReplyArtifactBlock = {
  id: string;
  type: "artifact";
  title?: string;
  description: string;
  bundle_id: string;
  state: Record<string, unknown> | null;
  state_revision: number;
};

export type ArtifactBundle = {
  id: string;
  io?: import("./canvas-data-types").ArtifactIO;
  source_id: string;
  reply_id: string;
  block_id: string;
  entry: string;
  files: { name: string; media_type: string; bytes: number; sha256: string }[];
  created_at_ms: number;
};

export type BoardReply = {
  id: string;
  /** Canonical canvas identity, resolved from BoardSnapshot.canvas.objects. */
  object_id?: string;
  source_id: string;
  source_label: string;
  origin_node_id?: string | null;
  title: string;
  blocks: ReplyBlock[];
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type ReplyPatchRequest = {
  object_id?: string;
  reply_id: string;
  request_id?: string;
  expected_revision: number;
  block: ReplyBlock;
  /** The backend verifies that only graph coordinates changed before suppressing feedback. */
  layout_only?: boolean;
};

export type ArtifactFeedback = { bundle_id: string; state: Record<string, unknown>; state_revision?: number; inputs?: import("./canvas-data-types").CanvasInputSnapshot };

export type ReplyActionInput = {
  object_id?: string;
  reply_id: string;
  request_id?: string;
  block_id: string;
  action: "select" | "ask";
  option_id?: string;
  text?: string;
  artifact_context?: ArtifactFeedback;
};
