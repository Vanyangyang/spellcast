import { t, type MessageKey } from "./i18n";
import type { BoardReply } from "./reply-types";

export type NodeKind = "idea" | "question" | "risk" | "action" | "insight";
export type FragmentWeight = "spark" | "note" | "anchor";
export type StageForm = "constellation" | "spatial" | "timeline" | "stack";

export type BoardNode = {
  id: string;
  source_id?: string | null;
  title: string;
  body: string;
  kind: NodeKind;
  weight: FragmentWeight;
  x: number;
  y: number;
  z: number;
  parent_id?: string | null;
};

export type BoardEdge = {
  id: string;
  from: string;
  to: string;
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
};

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
  source_id?: string | null;
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
};

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
