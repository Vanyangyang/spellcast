import type { DevelopmentObject, SourceReference } from "./project-record-api";
import type { FlowDefinition } from "./game-flow-model";

export const PLANNING_KINDS = ["system", "rule", "hook", "parameter", "content", "flow"] as const;
export type PlanningKind = typeof PLANNING_KINDS[number];
export type PlanningLink = {
  target_id: string;
  relation: "belongs_to" | "uses" | "depends_on" | "follows";
  note: string;
  local?: { value: string; reason: string };
};
export type ParameterDefinition = {
  value: string; unit: string; min: string; max: string; formula: string;
  variants: Array<{ label: string; value: string; reason: string }>;
};
/** Only content, rules and hooks own flow positions; the flow skeleton itself stays untouched. */
export const ANCHOR_KINDS = ["content", "rule", "hook"] as const;
export const HOOK_PHASES = ["cue", "action", "payoff", "continuation"] as const;
export type HookPhase = typeof HOOK_PHASES[number];
export type FlowAnchor = { flow_id: string; step_id: string; choice_id?: string; phase?: HookPhase; note?: string };
export const CONTENT_ROLES = ["body", "reason", "alternative", "question"] as const;
export type ContentRole = typeof CONTENT_ROLES[number];
export type ContentSection = { id: string; role: ContentRole; text: string; references?: SourceReference[] };
export type PlanningFields = {
  locked?: boolean;
  scopes: string[]; confirmed: boolean; body: string;
  links: PlanningLink[]; references: SourceReference[];
  rule?: { trigger: string; condition: string; effect: string };
  hook?: { cue: string; action: string; payoff: string; continuation: string };
  parameter?: ParameterDefinition;
  flow?: FlowDefinition;
  anchors?: FlowAnchor[];
  sections?: ContentSection[];
};

export const planningBody = (fields: PlanningFields): string => fields.sections !== undefined
  ? fields.sections.map(section => section.text).join("\n\n") : fields.body;

export function emptyPlanning(kind: string, scopes = ["R0"]): PlanningFields {
  return {
    scopes, confirmed: false, body: "", links: [], references: [],
    ...(kind === "rule" ? { rule: { trigger: "", condition: "", effect: "" } } : {}),
    ...(kind === "hook" ? { hook: { cue: "", action: "", payoff: "", continuation: "" } } : {}),
    ...(kind === "parameter" ? { parameter: { value: "", unit: "", min: "", max: "", formula: "", variants: [] } } : {}),
  };
}

export const supportsAnchors = (kind: string) => (ANCHOR_KINDS as readonly string[]).includes(kind);

/** Canonical form omits empty optional fields, matching the stored object exactly. */
export function cleanAnchor(anchor: FlowAnchor): FlowAnchor {
  return { flow_id: anchor.flow_id, step_id: anchor.step_id, ...(anchor.choice_id ? { choice_id: anchor.choice_id } : {}),
    ...(anchor.phase ? { phase: anchor.phase } : {}), ...(anchor.note?.trim() ? { note: anchor.note } : {}) };
}

export type AnchoredDesign = { object: DevelopmentObject; anchor: FlowAnchor };
/** Designs that point at a flow, optionally narrowed to a step or one of its choices. */
export function anchoredDesigns(objects: DevelopmentObject[], flowId: string, stepId?: string, choiceId?: string | null): AnchoredDesign[] {
  return objects.flatMap(object => (object.planning?.anchors || []).filter(anchor => anchor.flow_id === flowId
    && (stepId === undefined || anchor.step_id === stepId)
    && (choiceId === undefined || (choiceId === null ? !anchor.choice_id : anchor.choice_id === choiceId)))
    .map(anchor => ({ object, anchor })));
}

/** Explains an anchor against a flow definition. Missing positions stay visible instead of disappearing. */
export function anchorProblem(anchor: FlowAnchor, objects: DevelopmentObject[]): string {
  const flow = objects.find(object => object.id === anchor.flow_id);
  if (!flow || flow.kind !== "flow" || !flow.planning?.flow) return "关联的流程不存在或尚未定义步骤";
  const step = flow.planning.flow.steps.find(item => item.id === anchor.step_id);
  if (!step) return `流程「${flow.name}」中已没有这个步骤`;
  if (anchor.choice_id && !step.choices.some(choice => choice.id === anchor.choice_id)) return `步骤「${step.title}」中已没有这个选择`;
  return "";
}

export function planningImpact(objects: DevelopmentObject[], id: string) {
  const depth = new Map<string, number>([[id, 0]]), queue = [id];
  for (let index = 0; index < queue.length; index++) {
    const target = queue[index];
    for (const object of objects) {
      // Flow positions are references to the flow as well, so flow edits show their attached designs.
      if (!depth.has(object.id) && (object.planning?.links.some(link => link.target_id === target) || object.planning?.anchors?.some(anchor => anchor.flow_id === target))) {
        depth.set(object.id, depth.get(target)! + 1); queue.push(object.id);
      }
    }
  }
  return objects.filter(object => object.id !== id && depth.has(object.id))
    .map(object => ({ object, depth: depth.get(object.id)! }))
    .sort((a, b) => a.depth - b.depth || a.object.name.localeCompare(b.object.name));
}

/** Drafts are never passed as saved facts. */
export function planningContext(object: DevelopmentObject, objects: DevelopmentObject[]): string {
  const byId = new Map(objects.map(item => [item.id, item]));
  const targets = object.planning?.links.map(link => {
    const target = byId.get(link.target_id);
    return { ...link, target: target ? { id: target.id, name: target.name, kind: target.kind, revision: target.revision,
      archived: target.archived, planning: target.planning } : null };
  });
  return JSON.stringify({
    purpose: "Planning discussion; design confirmation does not prove implementation or player verification.",
    object, targets, impact: planningImpact(objects, object.id).map(({ object: item, depth }) => ({
      id: item.id, name: item.name, kind: item.kind, revision: item.revision, depth, links: item.planning?.links, anchors: item.planning?.anchors,
    })),
  }, null, 2);
}
