import type { DevelopmentObject, ParameterCandidate, RecordFields } from "./project-record-api";

export type FlowVariable = { id: string; name: string; value_type: "number" | "flag" | "text"; initial: string; unit: string; parameter_id?: string };
export type FlowOperand = { kind: "literal" | "variable"; value: string };
export type FlowCondition = { variable_id: string; op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; operand: FlowOperand };
export type FlowEffect = { variable_id: string; op: "set" | "add" | "subtract"; operand: FlowOperand };
export type FlowChoice = { id: string; label: string; to: string; conditions: FlowCondition[]; effects: FlowEffect[] };
export type FlowStep = { id: string; title: string; goal: string; action: string; feedback: string; external: boolean; terminal: boolean; choices: FlowChoice[] };
export type FlowDefinition = { entry: string; variables: FlowVariable[]; steps: FlowStep[] };
export type FlowValue = number | boolean | string;
export type FlowState = Record<string, FlowValue>;
/** A reused earlier manual result: a stated assumption, never new evidence. */
export type FlowAssumption = { base_trial_id: string; base_event_index: number; context_changed: boolean };
export type FlowEvent = { kind: "choice" | "manual"; from: string; to: string; label: string; choice_id?: string; before: FlowState; after: FlowState; at: string; assumption?: FlowAssumption };
export type InputSourceKind = "flow" | "shared" | "local" | "candidate" | "override";
export type TrialInputSource = { variable_id: string; value: string; source: InputSourceKind; parameter_id?: string; parameter_revision?: number; candidate_id?: string; candidate_revision?: number; note?: string };
/** Which saved design pointed at the flow when the run started. */
export type TrialAnchor = { object_id: string; name: string; kind: string; revision: number; step_id: string; choice_id?: string; phase?: string; note?: string };
export type FlowReplay = { base_trial_id: string; base_run_id: string; status: "paused" | "diverged" | "complete"; cursor: number; divergence?: { index: number; kind: string; detail: string } };
export type FlowRun = { version: 1 | 2; id: string; started: string; source: DevelopmentObject; dependencies: DevelopmentObject[]; inputs: Record<string, string>; initial: FlowState; events: FlowEvent[];
  input_sources?: TrialInputSource[]; candidates?: ParameterCandidate[]; anchors?: TrialAnchor[]; replay?: FlowReplay };
export const FLOW_LIMIT = 200;
export const conditionNames = { eq: "等于", neq: "不等于", lt: "小于", lte: "小于等于", gt: "大于", gte: "大于等于" };
export const effectNames = { set: "设为", add: "增加", subtract: "减少" };
export const valueTypeNames = { number: "数字", flag: "开关", text: "文字" };
export const phaseNames: Record<string, string> = { cue: "线索", action: "动作", payoff: "回报", continuation: "继续动机" };
export const designKindNames: Record<string, string> = { content: "内容", rule: "规则", hook: "钩子" };
export const blankFlow = (): FlowDefinition => ({ entry: "", variables: [], steps: [] });
export const newStep = (index: number): FlowStep => ({ id: crypto.randomUUID(), title: `步骤 ${index}`, goal: "", action: "", feedback: "", external: false, terminal: false, choices: [] });

export function parseFlowValue(variable: FlowVariable, text: string): FlowValue {
  if (variable.value_type === "text") return text;
  if (variable.value_type === "flag") {
    if (text !== "true" && text !== "false") throw new Error(`${variable.name}：请选择开或关`);
    return text === "true";
  }
  // Match decimal text accepted by the store; do not coerce empty, hex, Infinity or expressions.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) || !Number.isFinite(Number(text))) throw new Error(`${variable.name}：需要有限数字`);
  return Number(text);
}
export function flowDependencies(object: DevelopmentObject, objects: DevelopmentObject[]) {
  const ids = new Set(object.planning?.flow?.variables.map(v => v.parameter_id).filter(Boolean));
  return objects.filter(o => ids.has(o.id)).sort((a, b) => a.id.localeCompare(b.id));
}
export type ResolvedInput = { variable: FlowVariable; value: string; unit: string; error: string; label: string; note: string; source: TrialInputSource; candidate?: ParameterCandidate };
/**
 * Initial values for one run. Precedence: typed for this run > the flow's local override >
 * an explicitly selected candidate > the shared parameter value > the flow's own initial value.
 */
export function resolveFlowInputs(object: DevelopmentObject, objects: DevelopmentObject[], inputs: Record<string, string> = {}, candidates: Record<string, ParameterCandidate | undefined> = {}): ResolvedInput[] {
  return (object.planning?.flow?.variables || []).map(variable => {
    const parameter = variable.parameter_id ? objects.find(o => o.id === variable.parameter_id) : undefined;
    const link = variable.parameter_id ? object.planning!.links.find(l => l.target_id === variable.parameter_id && l.relation === "uses") : undefined;
    const definition = parameter?.planning?.parameter;
    const error = variable.parameter_id && (!definition || !link) ? `${variable.name}：数值引用缺失` : "";
    const selected = variable.parameter_id && definition ? candidates[variable.parameter_id] : undefined;
    const typed = Object.hasOwn(inputs, variable.id) ? inputs[variable.id] : undefined;
    const base = { variable_id: variable.id, ...(parameter && definition ? { parameter_id: parameter.id, parameter_revision: parameter.revision } : {}) };
    const where = parameter ? `${parameter.name} · 版本 ${parameter.revision}` : "";
    const archived = parameter?.archived ? " · 已归档" : "";
    let value: string, label: string, note = "", source: TrialInputSource, candidate: ParameterCandidate | undefined;
    if (typed !== undefined) {
      value = typed; label = "本次试走手动初值"; source = { ...base, value, source: "override" };
      if (selected) note = `已选候选「${selected.label}」未生效：本次手动初值优先。`;
    } else if (definition && link?.local) {
      value = link.local.value; label = `${where} · 局部值（${link.local.reason}）${archived}`; source = { ...base, value, source: "local" };
      if (selected) note = `已选候选「${selected.label}」未生效：此流程对该参数设置了局部值 ${link.local.value}，局部覆盖优先。`;
    } else if (definition && selected) {
      value = selected.value; candidate = selected;
      label = `${where} · 候选「${selected.label}」（候选版本 ${selected.revision}；共用值 ${definition.value || "待定"}）${archived}`;
      source = { ...base, value, source: "candidate", candidate_id: selected.id, candidate_revision: selected.revision };
    } else if (definition) {
      value = definition.value; label = `${where} · 共享值${archived}`; source = { ...base, value, source: "shared" };
    } else {
      value = variable.parameter_id ? "" : variable.initial; label = "流程初值"; source = { variable_id: variable.id, value, source: "flow" };
    }
    if (note) source.note = note;
    return { variable, value, unit: definition?.unit || variable.unit, error, label, note, source, candidate };
  });
}
export function flowInputs(object: DevelopmentObject, objects: DevelopmentObject[]) {
  return resolveFlowInputs(object, objects).map(item => ({ variable: item.variable, initial: item.value, source: item.label, error: item.error, unit: item.unit }));
}
export function describeInputSource(source: TrialInputSource | undefined, run?: FlowRun): string {
  if (!source) return "旧版试走未记录来源";
  const parameter = run?.dependencies.find(d => d.id === source.parameter_id);
  const name = parameter ? `${parameter.name} · 版本 ${source.parameter_revision}` : "";
  const text = source.source === "override" ? "本次手动初值" : source.source === "local" ? `${name} · 局部值` : source.source === "shared" ? `${name} · 共享值`
    : source.source === "candidate" ? `${name} · 候选「${run?.candidates?.find(c => c.id === source.candidate_id)?.label || source.candidate_id}」· 候选版本 ${source.candidate_revision}` : "流程初值";
  return source.note ? `${text}（${source.note}）` : text;
}
/** Saved designs that point at a flow, frozen into a run for later path reports. */
export function trialAnchors(flowId: string, objects: DevelopmentObject[]): TrialAnchor[] {
  return objects.filter(o => !o.archived).flatMap(o => (o.planning?.anchors || []).filter(a => a.flow_id === flowId).map(a => ({
    object_id: o.id, name: o.name, kind: o.kind, revision: o.revision, step_id: a.step_id,
    ...(a.choice_id ? { choice_id: a.choice_id } : {}), ...(a.phase ? { phase: a.phase } : {}), ...(a.note ? { note: a.note } : {}) })));
}
export function flowDiagnostics(flow: FlowDefinition): string[] {
  const errors: string[] = [], vars = new Map(flow.variables.map(v => [v.id, v])), steps = new Set(flow.steps.map(s => s.id)), choices = new Set<string>();
  if (!steps.size) errors.push("还没有步骤，先添加玩家的第一个动作。");
  else if (!steps.has(flow.entry)) errors.push("请选择流程入口。");
  if (vars.size !== flow.variables.length || steps.size !== flow.steps.length) errors.push("变量或步骤 ID 重复。");
  if (vars.size > 32 || steps.size > 64) errors.push("单个流程最多 32 个变量和 64 个步骤。");
  for (const variable of flow.variables) {
    if (!variable.id || !variable.name.trim() || !(variable.value_type in valueTypeNames)) errors.push("变量需要有效的名称、ID 和类型。");
    if (variable.parameter_id && variable.value_type !== "number") errors.push(`${variable.name}：只有数字变量可以引用数值对象。`);
    if (variable.initial !== "") try { parseFlowValue(variable, variable.initial); } catch (e) { errors.push(String(e)); }
  }
  for (const step of flow.steps) {
    if (!step.id || !step.title.trim()) errors.push("步骤需要名称和 ID。");
    if (step.terminal && step.choices.length) errors.push(`${step.title}：结束步骤不能再连接分支。`);
    if (step.choices.length > 8) errors.push(`${step.title}：最多 8 个选择。`);
    for (const choice of step.choices) {
      if (!choice.id || choices.has(choice.id) || !choice.label.trim()) errors.push(`${step.title}：选择需要名称和独立 ID。`);
      choices.add(choice.id);
      if (!steps.has(choice.to)) errors.push(`${step.title} / ${choice.label}：目标步骤不存在。`);
      if (choice.conditions.length > 16 || choice.effects.length > 16) errors.push(`${choice.label}：条件和结果各最多 16 条。`);
      for (const [items, effect] of [[choice.conditions, false], [choice.effects, true]] as const) for (const item of items) {
        const variable = vars.get(item.variable_id), numeric = effect ? item.op !== "set" : !["eq", "neq"].includes(item.op);
        if (!variable) { errors.push(`${choice.label}：引用的变量不存在。`); continue; }
        if (!(item.op in (effect ? effectNames : conditionNames))) errors.push(`${choice.label}：运算类型无效。`);
        if (numeric && variable.value_type !== "number") errors.push(`${choice.label}：大小比较和加减只支持数字。`);
        if (item.operand.kind === "variable") {
          if (vars.get(item.operand.value)?.value_type !== variable.value_type) errors.push(`${choice.label}：操作数需要同类型的变量。`);
        } else if (item.operand.kind === "literal") {
          try { parseFlowValue(variable, item.operand.value); } catch (e) { errors.push(`${choice.label}：${String(e)}`); }
        } else errors.push(`${choice.label}：操作数类型无效。`);
      }
    }
  }
  return [...new Set(errors)];
}
function operandValue(flow: FlowDefinition, variableId: string, operand: FlowOperand, state: FlowState): FlowValue {
  const variable = flow.variables.find(v => v.id === variableId);
  if (!variable) throw new Error("引用的变量不存在");
  if (operand.kind === "literal") return parseFlowValue(variable, operand.value);
  const other = flow.variables.find(v => v.id === operand.value);
  if (!other || other.value_type !== variable.value_type || !Object.hasOwn(state, other.id)) throw new Error("操作数变量不存在或类型不匹配");
  return state[other.id];
}
export function evaluateChoice(flow: FlowDefinition, choice: FlowChoice, state: FlowState) {
  const reasons = choice.conditions.map(condition => {
    const variable = flow.variables.find(v => v.id === condition.variable_id)!;
    const left = state[condition.variable_id], right = operandValue(flow, condition.variable_id, condition.operand, state);
    let passed = false;
    if (condition.op === "eq") passed = left === right;
    else if (condition.op === "neq") passed = left !== right;
    else if (typeof left !== "number" || typeof right !== "number") throw new Error("大小比较只支持数字");
    else if (condition.op === "lt") passed = left < right;
    else if (condition.op === "lte") passed = left <= right;
    else if (condition.op === "gt") passed = left > right;
    else if (condition.op === "gte") passed = left >= right;
    return { passed, text: `${variable.name} ${conditionNames[condition.op]} ${String(right)}（当前 ${String(left)}）` };
  });
  return { allowed: reasons.every(r => r.passed), reasons };
}
export function startFlowRun(object: DevelopmentObject, objects: DevelopmentObject[], inputs: Record<string, string>, options: { candidates?: ParameterCandidate[] } = {}): FlowRun {
  const flow = object.planning?.flow;
  if (!flow) throw new Error("这个流程还没有定义步骤");
  const errors = flowDiagnostics(flow); if (errors.length) throw new Error(errors.join("\n"));
  const selected = Object.fromEntries((options.candidates || []).map(candidate => [candidate.parameter_id, candidate]));
  const initial: FlowState = Object.create(null), sources: TrialInputSource[] = [], used: ParameterCandidate[] = [];
  for (const item of resolveFlowInputs(object, objects, inputs, selected)) {
    if (item.error) throw new Error(item.error);
    initial[item.variable.id] = parseFlowValue(item.variable, item.value);
    sources.push(item.source);
    if (item.candidate) used.push(structuredClone(item.candidate));
  }
  const anchors = trialAnchors(object.id, objects);
  return { version: 2, id: crypto.randomUUID(), started: new Date().toISOString(), source: structuredClone(object), dependencies: structuredClone(flowDependencies(object, objects)), inputs: { ...inputs }, initial, events: [],
    input_sources: sources, ...(used.length ? { candidates: used } : {}), ...(anchors.length ? { anchors } : {}) };
}
export function runPosition(run: FlowRun) {
  const raw = run.source.planning!.flow!;
  const flow = { ...raw, variables: raw.variables.map(variable => ({ ...variable, unit: run.dependencies.find(o => o.id === variable.parameter_id)?.planning?.parameter?.unit || variable.unit })) };
  const last = run.events.at(-1), id = last?.to ?? flow.entry;
  const step = flow.steps.find(s => s.id === id)!;
  const manualNeeded = step.external && !(last?.kind === "manual" && last.to === id);
  return { flow, step, state: last?.after ?? run.initial, manualNeeded, complete: step.terminal && !manualNeeded };
}
function checkLimit(run: FlowRun) { if (run.events.length >= FLOW_LIMIT) throw new Error(`本次已记录 ${FLOW_LIMIT} 个动作，请保存记录后重新试走。`); }
export function advanceFlow(run: FlowRun, choiceId: string): FlowRun {
  checkLimit(run);
  const { flow, step, state, manualNeeded } = runPosition(run);
  if (manualNeeded) throw new Error("这一步需要先确认手动结果");
  if (step.terminal) throw new Error("已到达结束步骤");
  const choice = step.choices.find(c => c.id === choiceId);
  if (!choice || !flow.steps.some(s => s.id === choice.to)) throw new Error("选择或目标不存在");
  if (!evaluateChoice(flow, choice, state).allowed) throw new Error("尚未满足这个选择的条件");
  // All effects commit together. Operands read the pre-choice state, never another effect's partial result.
  const after = { ...state };
  for (const effect of choice.effects) {
    const value = operandValue(flow, effect.variable_id, effect.operand, state), before = after[effect.variable_id];
    if (effect.op === "set") after[effect.variable_id] = value;
    else {
      if (typeof before !== "number" || typeof value !== "number") throw new Error("加减只支持数字");
      after[effect.variable_id] = effect.op === "add" ? before + value : before - value;
    }
    if (typeof after[effect.variable_id] === "number" && !Number.isFinite(after[effect.variable_id])) throw new Error("结果超出有限数字范围，本次选择未执行");
  }
  return { ...run, events: [...run.events, { kind: "choice", from: step.id, to: choice.to, label: choice.label, choice_id: choice.id, before: { ...state }, after, at: new Date().toISOString() }] };
}
export function confirmManualResult(run: FlowRun, values: Record<string, string>, assumption?: FlowAssumption): FlowRun {
  checkLimit(run);
  const { flow, step, state, manualNeeded } = runPosition(run);
  if (!manualNeeded) throw new Error("当前步骤无需手动结果");
  const after = { ...state };
  for (const variable of flow.variables) if (Object.hasOwn(values, variable.id)) after[variable.id] = parseFlowValue(variable, values[variable.id]);
  return { ...run, events: [...run.events, { kind: "manual", from: step.id, to: step.id, label: assumption ? "复用基准手动结果（手动假设）" : "手动确认结果", before: { ...state }, after, at: new Date().toISOString(), ...(assumption ? { assumption } : {}) }] };
}
export function rewindFlow(run: FlowRun): FlowRun { return { ...run, events: run.events.slice(0, -1) }; }
/** Key order independent; server-returned states are sorted. */
export function sameState(a: FlowState, b: FlowState) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => Object.hasOwn(a, key) && Object.hasOwn(b, key) && a[key] === b[key]);
}
/** Only what the walkthrough computes with: the flow definition and bound parameter values. */
function executionKey(object: DevelopmentObject, dependencies: DevelopmentObject[]) {
  const flow = object.planning?.flow;
  return JSON.stringify({ flow: flow ?? null, archived: object.archived, bindings: (flow?.variables || []).filter(v => v.parameter_id).map(v => {
    const dependency = dependencies.find(d => d.id === v.parameter_id)?.planning?.parameter, link = object.planning?.links.find(l => l.target_id === v.parameter_id && l.relation === "uses");
    return [v.id, v.parameter_id, link?.local?.value ?? null, dependency?.value ?? null, dependency?.unit ?? null];
  }) });
}
export type SourceStatus = { changed: boolean; metadata: boolean; details: string[] };
/**
 * Separates changes that alter the computation from editing metadata (revision, lock, notes,
 * candidates). The frozen source snapshot is kept either way.
 */
export function flowSourceStatus(run: FlowRun, object: DevelopmentObject | undefined, objects: DevelopmentObject[]): SourceStatus {
  if (!object) return { changed: true, metadata: false, details: ["流程已不可用"] };
  const dependencies = flowDependencies(object, objects), details: string[] = [];
  const changed = executionKey(run.source, run.dependencies) !== executionKey(object, dependencies);
  if (object.archived) details.push("流程已归档");
  if (JSON.stringify(run.source.planning?.flow) !== JSON.stringify(object.planning?.flow)) details.push("流程步骤、条件、结果或变量已修改");
  for (const variable of object.planning?.flow?.variables || []) if (variable.parameter_id) {
    const before = run.dependencies.find(d => d.id === variable.parameter_id), after = dependencies.find(d => d.id === variable.parameter_id);
    const oldLocal = run.source.planning?.links.find(l => l.target_id === variable.parameter_id && l.relation === "uses")?.local?.value;
    const newLocal = object.planning?.links.find(l => l.target_id === variable.parameter_id && l.relation === "uses")?.local?.value;
    if (oldLocal !== newLocal) details.push(`「${variable.name}」的局部值 ${oldLocal ?? "无"} → ${newLocal ?? "无"}`);
    const oldValue = before?.planning?.parameter?.value, newValue = after?.planning?.parameter?.value;
    if (oldValue !== newValue || before?.planning?.parameter?.unit !== after?.planning?.parameter?.unit) details.push(`参数「${after?.name || before?.name || variable.name}」共用值 ${oldValue ?? "缺失"} → ${newValue ?? "缺失"}`);
    else if (before && after && before.revision !== after.revision) details.push(`参数「${after.name}」版本 ${before.revision} → ${after.revision}（执行值未变）`);
  }
  if (run.source.revision !== object.revision && !details.some(d => d.startsWith("流程步骤"))) details.push(`流程版本 ${run.source.revision} → ${object.revision}（执行定义未变）`);
  const metadata = !changed && (JSON.stringify(run.source) !== JSON.stringify(object) || JSON.stringify(run.dependencies) !== JSON.stringify(dependencies));
  return { changed, metadata, details };
}
export function flowSourceChanged(run: FlowRun, object: DevelopmentObject, objects: DevelopmentObject[]): boolean {
  return flowSourceStatus(run, object, objects).changed;
}
export function flowChanges(before: FlowState, after: FlowState, variables: FlowVariable[]) {
  return variables.filter(v => before[v.id] !== after[v.id]).map(v => `${v.name}：${String(before[v.id])} → ${String(after[v.id])}${v.unit ? ` ${v.unit}` : ""}`);
}
function changedValues(before: FlowState, after: FlowState, variables: FlowVariable[]) {
  return Object.fromEntries(variables.filter(v => before[v.id] !== after[v.id]).map(v => [v.id, String(after[v.id])]));
}
/** The variables a manual result explicitly set, as text for re-entry. */
export function manualValues(event: FlowEvent, variables: FlowVariable[]) { return changedValues(event.before, event.after, variables); }

/** Local v1 runs become v2 without changing what happened; sources are rebuilt from their own snapshots. */
export function upgradeRun(run: FlowRun): FlowRun {
  if (run.version === 2) return run;
  const sources = resolveFlowInputs(run.source, run.dependencies, run.inputs).map(item => ({ ...item.source, note: "由旧版试走的来源快照重建" }));
  return { ...run, version: 2, input_sources: sources };
}
function valueMatches(variable: FlowVariable, value: unknown) {
  return variable.value_type === "number" ? typeof value === "number" && Number.isFinite(value) : variable.value_type === "flag" ? typeof value === "boolean" : typeof value === "string";
}
/** Recomputes a stored run from its own snapshots. Any mismatch is reported, never repaired. */
export function verifyRun(run: FlowRun): string[] {
  const problems: string[] = [];
  try {
    const flow = run.source?.planning?.flow;
    if (!flow || run.source.kind !== "flow") return ["缺少流程定义"];
    if (!Array.isArray(run.events) || run.events.length > FLOW_LIMIT) return [`动作记录缺失或超过 ${FLOW_LIMIT} 个`];
    problems.push(...flowDiagnostics(flow));
    const vars = new Map(flow.variables.map(v => [v.id, v]));
    if (Object.keys(run.initial || {}).some(key => !vars.has(key)) || flow.variables.some(v => !valueMatches(v, run.initial?.[v.id]))) problems.push("初值与流程变量不匹配");
    const selected = Object.fromEntries((run.candidates || []).map(c => [c.parameter_id, c]));
    for (const item of resolveFlowInputs(run.source, run.dependencies, run.inputs || {}, selected)) {
      try { if (!problems.length && parseFlowValue(item.variable, item.value) !== run.initial[item.variable.id]) problems.push(`「${item.variable.name}」的初值与来源快照不一致`); }
      catch (error) { problems.push(String(error)); }
    }
    if (problems.length) return problems;
    let replayed: FlowRun = { ...run, events: [] };
    run.events.forEach((event, index) => {
      if (problems.length) return;
      if (!sameState(event.before, runPosition(replayed).state)) { problems.push(`第 ${index + 1} 个动作的前状态与重算不一致`); return; }
      const next = event.kind === "choice" ? advanceFlow(replayed, event.choice_id || "") : event.kind === "manual" ? confirmManualResult(replayed, changedValues(event.before, event.after, flow.variables), event.assumption)
        : (() => { throw new Error(`第 ${index + 1} 个动作类型无效`); })();
      const last = next.events.at(-1)!;
      if (last.to !== event.to || last.from !== event.from || !sameState(last.after, event.after)) { problems.push(`第 ${index + 1} 个动作的结果与重算不一致`); return; }
      replayed = { ...replayed, events: run.events.slice(0, index + 1) };
    });
  } catch (error) { problems.push(String(error instanceof Error ? error.message : error)); }
  return problems;
}
export type PathFact = { anchor: TrialAnchor; reached: boolean; index: number | null; text: string };
/**
 * States only whether this route passed an attached position. It never judges whether a hook
 * worked or whether the player understood anything.
 */
export function pathFacts(run: FlowRun, anchors: TrialAnchor[] = run.anchors || []): PathFact[] {
  const flow = run.source.planning!.flow!, title = (id: string) => flow.steps.find(s => s.id === id)?.title || id;
  return anchors.map(anchor => {
    const owner = `${designKindNames[anchor.kind] || anchor.kind}「${anchor.name}」 · `, phase = anchor.phase ? phaseNames[anchor.phase] || anchor.phase : "";
    if (anchor.choice_id) {
      const label = flow.steps.find(s => s.id === anchor.step_id)?.choices.find(c => c.id === anchor.choice_id)?.label || anchor.choice_id;
      const found = run.events.findIndex(e => e.kind === "choice" && e.from === anchor.step_id && e.choice_id === anchor.choice_id);
      return { anchor, reached: found >= 0, index: found >= 0 ? found + 1 : null,
        text: `${owner}${phase}选择「${label}」${found >= 0 ? `已执行（第 ${found + 1} 个动作）` : "未执行"} · 设计版本 ${anchor.revision}` };
    }
    const found = anchor.step_id === flow.entry ? 0 : run.events.findIndex(e => e.to === anchor.step_id) + 1;
    return { anchor, reached: found > 0 || anchor.step_id === flow.entry, index: found > 0 || anchor.step_id === flow.entry ? found : null,
      text: `${owner}${phase}步骤「${title(anchor.step_id)}」${found > 0 ? `已到达（第 ${found} 个动作后）` : anchor.step_id === flow.entry ? "已到达（开始时）" : "未到达"} · 设计版本 ${anchor.revision}` };
  });
}
export const FACT_BOUNDARY = "路径事实只说明本次路线是否经过关联位置，不评价体验、理解或钩子效果。";
export function flowRecord(run: FlowRun, trial?: { id: string; digest: string }): Partial<RecordFields> {
  const { flow, step, complete } = runPosition(run), name = (id: string) => flow.steps.find(s => s.id === id)?.title || id;
  const where = trial ? `完整轨迹见项目试走记录 ${trial.id}` : "完整轨迹请先保存为项目试走记录";
  const limited = (value: string, bytes: number) => { let used = 0, out = ""; for (const char of value) { const length = new TextEncoder().encode(char).length; if (used + length > bytes) return out + `… [摘要截断，${where}]`; used += length; out += char; } return out; };
  const facts = pathFacts(run), assumptions = run.events.filter(event => event.assumption).length;
  const replay = run.replay ? [`重放基准：试走 ${run.replay.base_trial_id} · 状态 ${run.replay.status}${run.replay.divergence ? ` · 第一处分歧：${run.replay.divergence.detail}` : ""}`] : [];
  return { title: limited(`${run.source.name} · 流程试走`, 400), status: "planned", goal: "检查玩家步骤、分支条件和显式数值变化。",
    scope: `${run.source.name} · 版本 ${run.source.revision} · ${run.source.planning!.scopes.join(" / ")}\n${run.dependencies.map(o => `${o.name} · 版本 ${o.revision}`).join("\n")}${(run.candidates || []).map(c => `\n候选「${c.label}」· 候选版本 ${c.revision}`).join("")}`,
    result: limited([trial ? `项目试走记录 ${trial.id} · 内容摘要 ${trial.digest.slice(0, 12)} · 已保存且不会被后续试走覆盖` : `试走 ${run.id}（尚未保存到项目）`, `开始：${run.started}`,
      `初值：${flow.variables.map(v => `${v.name}=${String(run.initial[v.id])}（${describeInputSource(run.input_sources?.find(s => s.variable_id === v.id), run)}）`).join("；")}`, ...replay,
      ...run.events.map((event, index) => `${index + 1}. ${name(event.from)} → ${event.label} → ${name(event.to)}${event.kind === "manual" ? event.assumption ? " [手动假设]" : " [手动输入]" : ""}\n${flowChanges(event.before, event.after, flow.variables).join("；") || "数值未变化"}`),
      `当前：${step.title} · ${complete ? "到达声明的结束步骤" : "预演未结束"}`, ...(facts.length ? ["路径事实：", ...facts.map(fact => `- ${fact.text}`)] : [])].join("\n"), 32000),
    boundaries: `模型预演，非实际游戏验收。仅计算已声明的条件与结果；手动输入不是运行时取证。未执行 Unity、战斗系统或任意脚本。${facts.length ? FACT_BOUNDARY : ""}${assumptions ? " 本次含复用的手动假设，不能作为新方案的运行证据。" : ""}`,
    next_step: "核对这条路线与玩家目标；在真实游戏中验证交互、反馈和体验。" };
}

/** Candidate base compared with the parameter's current effective definition. */
export function candidateBaseChanges(candidate: ParameterCandidate, parameter: DevelopmentObject | undefined): string[] {
  const definition = parameter?.planning?.parameter;
  if (!definition) return ["参数不存在或未定义数值"];
  const same = (a: string, b: string) => a === b || (a.trim() !== "" && b.trim() !== "" && Number(a) === Number(b));
  const changes: string[] = [];
  if (!same(candidate.base.value, definition.value)) changes.push(`共用值 ${candidate.base.value || "待定"} → ${definition.value || "待定"}`);
  if (candidate.base.unit !== definition.unit) changes.push(`单位 ${candidate.base.unit || "无"} → ${definition.unit || "无"}`);
  if (!same(candidate.base.min, definition.min) || !same(candidate.base.max, definition.max)) changes.push(`范围 ${candidate.base.min || "—"}…${candidate.base.max || "—"} → ${definition.min || "—"}…${definition.max || "—"}`);
  return changes;
}

/** Built-in learning example, never persisted as a project object. */
export function flowExample(): DevelopmentObject {
  const variable = (id: string, name: string, initial: string): FlowVariable => ({ id, name, initial, value_type: "number", unit: "" });
  const step = (id: string, title: string, action: string, terminal = false): FlowStep => ({ id, title, action, goal: "验证一次行动与反馈的联系", feedback: terminal ? "查看行动后的状态" : "观察可用选择与数值变化", external: false, terminal, choices: [] });
  const steps = [step("entry", "开始探索", "查看体力，选择继续探索或返回。"), step("encounter", "遭遇与选择", "手动输入遭遇结果，再领取奖励。"), step("end", "返回与结算", "查看本次路线与资源变化。", true)];
  steps[1].external = true;
  steps[0].choices = [{ id: "explore", label: "消耗体力，进入遭遇", to: "encounter", conditions: [{ variable_id: "energy", op: "gte", operand: { kind: "literal", value: "2" } }], effects: [{ variable_id: "energy", op: "subtract", operand: { kind: "literal", value: "2" } }] }, { id: "return", label: "直接返回", to: "end", conditions: [], effects: [] }];
  steps[1].choices = [{ id: "reward", label: "领取奖励并返回", to: "end", conditions: [], effects: [{ variable_id: "coins", op: "add", operand: { kind: "variable", value: "reward" } }] }];
  return { id: "example-flow", project_id: "example-only", name: "演示 · 一次探索", kind: "flow", revision: 0, archived: false,
    planning: { scopes: ["R0"], confirmed: false, body: "交互教学，不代表 VESPERIX 的游戏设计。", links: [], references: [], flow: { entry: "entry", variables: [variable("energy", "体力", "3"), variable("coins", "金币", "0"), variable("reward", "本次奖励", "5")], steps } } };
}
