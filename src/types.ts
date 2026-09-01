import { t, type MessageKey } from "./i18n";

export type NodeKind = "idea" | "question" | "risk" | "action" | "insight";
export type FragmentWeight = "spark" | "note" | "anchor";
export type StageForm = "constellation" | "spatial" | "timeline" | "stack";

export type BoardNode = {
  id: string;
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
};

export type BubbleSize = "whisper" | "note" | "flare";
export type PokeAction = "peek" | "reply" | "focus" | "pin";
export type Surface = "ambient" | "focus";
export type ScreenAim = "active" | "primary" | "side";

export type ThrownBubble = {
  id: string;
  node_id?: string | null;
  tease: string;
  title: string;
  body: string;
  kind: NodeKind;
  size: BubbleSize;
  on_poke: PokeAction;
  linger_ms: number;
  delay_ms: number;
  screen?: ScreenAim;
};

export type ChatResponse = {
  reply: string;
  topic?: string | null;
  form: StageForm;
  form_reason: string;
  nodes: BoardNode[];
  edges: BoardEdge[];
  throws?: ThrownBubble[];
  provider: string;
  model: string;
};

export type ProviderInfo = {
  id: string;
  label: string;
  kind: string;
  default_model: string;
  default_base_url: string;
  needs_key: boolean;
  hint: string;
};

export type FormInfo = {
  id: StageForm;
  label: string;
  blurb: string;
};

export type Settings = {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
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
