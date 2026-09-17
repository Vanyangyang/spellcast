import { t, type MessageKey } from "./i18n";
import type { BoardReply } from "./reply-types";

export type NodeKind = "idea" | "question" | "risk" | "action" | "insight";
export type FragmentWeight = "spark" | "note" | "anchor";
export type StageForm = "constellation" | "spatial" | "timeline" | "stack";

export type CapturedContext = {
  project: string;
  goal: string;
  change: string;
  source_id: string;
  captured_at_ms: number;
  thread_id?: string | null;
  cwd?: string | null;
};

export type BoardNode = {
  id: string;
  revision?: number;
  source_id?: string | null;
  title: string;
  body: string;
  kind: NodeKind;
  weight: FragmentWeight;
  x: number;
  y: number;
  z: number;
  parent_id?: string | null;
  captured_context?: CapturedContext | null;
};

export type EdgeRelation = "unconfirmed" | "parent";
export type BoardEdge = {
  id: string;
  from: string;
  to: string;
  relation?: EdgeRelation;
};

export type ChatMessage = {
  role: string;
  content: string;
};

export type BoardSnapshot = {
  topic: string;
  form: StageForm;
  form_reason: string;
  nodes: BoardNode[];
  edges: BoardEdge[];
  messages: ChatMessage[];
  replies?: BoardReply[];
  canvas?: CanvasLayout;
};

export type CanvasContent = { type: "node" | "reply"; id: string }
  | { type: "block"; block: Exclude<import("./reply-types").ReplyBlock, { type: "artifact" }> }
  | { type: "text"; title: string; text: string }
  | { type: "image"; title: string; src: string; alt: string }
  | { type: "shape"; title: string; shape: "rect" | "ellipse"; fill: string; text: string };
export type CanvasOrigin = { cwd: string; thread_id?: string | null; source_id?: string | null; label?: string };
export type TaskTarget = { source_id: string; thread_id?: string | null; cwd?: string | null; label: string };
export type TaskTargetStatus = { source_id: string; thread_id?: string | null; label: string; status: "available" | "deleted" | "unlinked" | "changed" | "unknown"; message: string; checked_at_ms: number };
export type CanvasObject = { id: string; content: CanvasContent; content_revision: number; origin?: CanvasOrigin | null; source_id?: string | null; user_edited?: boolean; bindings?: import("./canvas-data-types").CanvasBinding[] };
export type CanvasPlacement = { item_id: string; revision: number; z: number; removed: boolean; appearance: "plain" | "card"; x: number; y: number; width: number; height: number; content_scale?: number; user_modified?: boolean };
export type CanvasArrangement = "free" | "side_by_side" | "figure_caption" | "sequence";
export type CanvasComposition = { id: string; revision: number; title: string; description?: string; arrangement?: CanvasArrangement; members: string[]; source_id?: string | null; user_modified?: boolean };
export type CanvasRead = { kind: "content" | "presentation" | "composition" | "annotation"; id: string; revision: number };
export type CanvasAnnotation = { id: string; revision: number; anchor: CanvasAnchor; snapshot: unknown; text: string; origin?: CanvasOrigin | null; source_id?: string | null; removed: boolean };
export type CanvasContentFields = { title?: string; text?: string; src?: string; alt?: string; fill?: string };
export type CanvasPlacementFields = Partial<Pick<CanvasPlacement, "x" | "y" | "width" | "height" | "content_scale" | "z" | "appearance" | "removed">>;
export type CanvasOperation = { op: "create"; id: string; content: CanvasContent; origin?: CanvasOrigin; placement: CanvasPlacementFields; bindings?: import("./canvas-data-types").CanvasBinding[] }
  | { op: "patch_content"; id: string; expected_revision: number; fields: CanvasContentFields }
  | { op: "patch_reply"; id: string; expected_revision: number; block: import("./reply-types").ReplyBlock }
  | { op: "patch_block"; id: string; expected_revision: number; block: Exclude<import("./reply-types").ReplyBlock, { type: "artifact" }> }
  | { op: "bind"; id: string; expected_revision: number; bindings: import("./canvas-data-types").CanvasBinding[] }
  | { op: "place"; id: string; expected_revision: number; fields: CanvasPlacementFields }
  | { op: "compose"; id: string; expected_revision: number; title: string; description?: string; arrangement?: CanvasArrangement; members: string[] }
  | { op: "arrange"; id: string; expected_revision: number; expected_presentations: Record<string, number> }
  | { op: "annotate"; id: string; expected_revision: number; anchor: CanvasAnchor; text: string }
  | { op: "remove_annotation"; id: string; expected_revision: number; removed: boolean }
  | { op: "ungroup"; id: string; expected_revision: number };
export type CanvasBatchRequest = { request_id: string; reads: CanvasRead[]; operations: CanvasOperation[]; feedback_sequences?: number[] };
export type CanvasTargetStatus = { kind: CanvasRead["kind"]; id: string; status: string; expected_revision?: number | null; actual_revision?: number | null; message?: string | null };
export type CanvasBatchResult = { request_id: string; status: "applied" | "proposed" | "dismissed"; targets: CanvasTargetStatus[] };
export type CanvasProposal = { request: CanvasBatchRequest; source_id?: string | null; result: CanvasBatchResult };
export type CanvasLayout = { revision: number; objects: CanvasObject[]; items: CanvasPlacement[]; compositions?: CanvasComposition[]; annotations?: CanvasAnnotation[]; proposals?: CanvasProposal[] };
export type CanvasAnchor = { object_id: string; content_revision: number; block_id?: string; selection?: string;
  target?: import("./reply-types").ReplyTarget;
  image?: import("./reply-types").ReplyImageReference;
  artifact_reference?: import("./reply-types").ReplyArtifactReference;
  annotations?: { id: string; revision: number }[];
  compositions?: { id: string; revision: number }[];
  inputs?: import("./canvas-data-types").CanvasInputSnapshot;
  region?: { resource: string; unit: "normalized"; x: number; y: number; width: number; height: number };
  artifact?: { bundle_id: string; state_revision: number; state: unknown; selection?: unknown } };

export type BubbleSize = "whisper" | "note" | "flare";
export type BubbleShape = "orb" | "pill" | "card" | "sticky" | "speech" | "code";
export type PokeAction = "peek" | "reply" | "focus" | "pin";
export type Surface = "ambient" | "focus";
export type ScreenAim = "active" | "primary" | "side";

export type ThrownBubble = {
  id: string;
  source_id?: string | null;
  node_id?: string | null;
  tease: string;
  title: string;
  body: string;
  kind: NodeKind;
  size: BubbleSize;
  shape: BubbleShape;
  on_poke: PokeAction;
  linger_ms: number;
  delay_ms: number;
  screen?: ScreenAim;
  captured_context?: CapturedContext | null;
};

/** What the agent laid on the board in one call. */
export type PresentResult = {
  reply: string;
  topic?: string | null;
  form: StageForm;
  form_reason: string;
  nodes: BoardNode[];
  edges: BoardEdge[];
  throws: ThrownBubble[];
  open: boolean;
};

export type AgentEvent = {
  seq: number;
  at_ms: number;
  kind: string;
  request_id?: string | null;
  source_id?: string | null;
  target_thread_id?: string | null;
  object_id?: string | null;
  object_revision?: number | null;
  anchors?: CanvasAnchor[];
  annotation_context?: CanvasAnnotation[];
  reply_id?: string | null;
  block_id?: string | null;
  option_id?: string | null;
  bubble_id?: string;
  node_id?: string;
  title?: string;
  text?: string;
};

export type RecentAgent = {
  client: string;
  last_call_ms: number;
};

export type BridgeStatus = {
  surface: Surface;
  board_focused?: boolean;
  port: number;
  client?: string | null;
  last_call_ms: number;
  calls: number;
  agents?: RecentAgent[];
  sources?: { id: string; label: string; last_call_ms: number }[];
  paused?: boolean;
  observer_enabled?: boolean;
  observer_policy_revision?: number;
  observer_allowed?: boolean;
  observer_reason?: string;
};

export type ObserverStatus = {
  enabled: boolean;
  paused: boolean;
  allowed: boolean;
  reason: string;
  policy_revision: number;
};

export type DeliveryPhase = "waiting" | "dispatching" | "submitted" | "unanswered" | "queued" | "received" | "responded" | "handled" | "failed" | "unknown";
export type DeliveryReceipt = {
  event: AgentEvent;
  phase: DeliveryPhase;
  client_message_id: string;
  queued_id?: string | null;
  attempted_at_ms?: number | null;
  queued_at_ms?: number | null;
  received_at_ms?: number | null;
  responded_at_ms?: number | null;
  handled_at_ms?: number | null;
  response_reply_id?: string | null;
  response_request_id?: string | null;
  response_object_ids?: string[];
  error?: string | null;
  desktop?: { thread_id?: string; cwd?: string; accepted_at_ms: number; previous_turn_id?: string | null; turn_id?: string | null; host_status: string; attention?: string | null } | null;
};
export type CodexBinding = { source_id: string; thread_id: string; cwd: string; label: string; protocol_agent: string; bound_at_ms: number };
export type FeedbackState = { pending: AgentEvent[]; deliveries: DeliveryReceipt[]; bindings: CodexBinding[] };

export type MemoryItem = {
  id: string;
  title: string;
  text: string;
  created_at_ms: number;
};

export type ClientConfig = {
  client: string;
  label: string;
  path?: string | null;
  snippet: string;
  written: boolean;
  backup?: string | null;
  skill_path?: string | null;
  note: string;
};

export type SetupKind =
  | "unsupported"
  | "missing_cli"
  | "missing_resources"
  | "not_installed"
  | "installing"
  | "installed_pending_trust"
  | "installed_unverified"
  | "pending_reload"
  | "verified"
  | "conflict_custom"
  | "conflict_endpoint"
  | "failed";

export type SetupReport = {
  client: string;
  kind: SetupKind;
  complete_supported: boolean;
  installed: boolean;
  hook_trust?: "trusted" | "untrusted" | "modified" | "disabled" | "unknown" | null;
  note: string;
  done: string[];
  not_done: string[];
  source_path?: string | null;
  cache_path?: string | null;
  marketplace_path?: string | null;
  backup?: string | null;
  mcp_url?: string | null;
  conflicts: string[];
  partial?: boolean;
  ui?: "status-read-failed";
};

export type SkillInstall = {
  client: string;
  path: string;
  installed: boolean;
  backup?: string | null;
  note: string;
};

export type FormInfo = {
  id: StageForm;
  label: string;
  blurb: string;
};

export function kindLabel(kind: NodeKind): string {
  return t(`kind.${kind}` as MessageKey);
}

export function weightLabel(weight: FragmentWeight): string {
  return t(`weight.${weight}` as MessageKey);
}

export function formLabel(form: StageForm): string {
  return t(`form.${form}` as MessageKey);
}

export function formReason(form: StageForm): string {
  return t(`formReason.${form}` as MessageKey);
}

export const KINDS: NodeKind[] = ["idea", "question", "risk", "action", "insight"];
export const WEIGHTS: FragmentWeight[] = ["spark", "note", "anchor"];
export const FORMS: StageForm[] = ["constellation", "spatial", "timeline", "stack"];
