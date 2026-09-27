import type { DevelopmentObject, ParameterCandidate } from "./project-record-api";
import { advanceFlow, confirmManualResult, describeInputSource, evaluateChoice, flowChanges, flowSourceStatus, manualValues, runPosition, sameState, startFlowRun,
  type FlowEvent, type FlowRun, type FlowValue, type FlowVariable } from "./game-flow-model";

/**
 * Replays a saved trial's choice intent on the current definition and inputs. Stops at the first
 * difference instead of choosing another path, and pauses at every manual step.
 */
export type ReplayBase = { trialId: string; run: FlowRun };
const stepTitle = (run: FlowRun, id: string) => run.source.planning?.flow?.steps.find(step => step.id === id)?.title || id;

export function startReplay(base: ReplayBase, object: DevelopmentObject, objects: DevelopmentObject[], inputs: Record<string, string>, candidates: ParameterCandidate[]): FlowRun {
  const run = startFlowRun(object, objects, inputs, { candidates });
  return advanceReplay({ ...run, replay: { base_trial_id: base.trialId, base_run_id: base.run.id, status: "paused", cursor: 0 } }, base.run);
}

function settle(run: FlowRun, cursor: number, status: "paused" | "complete"): FlowRun {
  return { ...run, replay: { base_trial_id: run.replay!.base_trial_id, base_run_id: run.replay!.base_run_id, status, cursor } };
}
function diverge(run: FlowRun, cursor: number, kind: string, detail: string): FlowRun {
  return { ...run, replay: { base_trial_id: run.replay!.base_trial_id, base_run_id: run.replay!.base_run_id, status: "diverged", cursor, divergence: { index: cursor, kind, detail } } };
}

export function advanceReplay(run: FlowRun, base: FlowRun): FlowRun {
  if (!run.replay || run.replay.status === "diverged") return run;
  let current = run, cursor = run.replay.cursor;
  for (;;) {
    const position = runPosition(current);
    if (cursor >= base.events.length) return settle(current, cursor, "complete");
    if (position.manualNeeded) return settle(current, cursor, "paused");
    const intent = base.events[cursor];
    if (intent.kind === "manual") return diverge(current, cursor, "manual", `基准试走在「${stepTitle(base, intent.from)}」记录了手动结果，当前流程在「${position.step.title}」不需要手动结果。`);
    if (position.step.id !== intent.from) return diverge(current, cursor, "step", `当前位于「${position.step.title}」，基准试走此时位于「${stepTitle(base, intent.from)}」。`);
    if (position.step.terminal) return diverge(current, cursor, "ended", `当前流程在「${position.step.title}」结束，基准试走还有后续动作「${intent.label}」。`);
    const choice = position.step.choices.find(item => item.id === intent.choice_id);
    if (!choice) return diverge(current, cursor, "missing_choice", `步骤「${position.step.title}」中已没有选择「${intent.label}」。`);
    if (choice.to !== intent.to) return diverge(current, cursor, "target", `选择「${choice.label}」现在通往「${stepTitle(current, choice.to)}」，基准试走通往「${stepTitle(base, intent.to)}」。`);
    const evaluated = evaluateChoice(position.flow, choice, position.state);
    if (!evaluated.allowed) return diverge(current, cursor, "condition", `选择「${choice.label}」的条件未满足：${evaluated.reasons.filter(reason => !reason.passed).map(reason => reason.text).join("；")}`);
    current = advanceFlow(current, choice.id);
    cursor += 1;
  }
}

/** The base manual result that could be reused at the paused step, if any. */
export function reusableManual(run: FlowRun, base: FlowRun): { event: FlowEvent; index: number; contextChanged: boolean } | undefined {
  if (!run.replay) return;
  const position = runPosition(run), index = run.replay.cursor, event = base.events[index];
  if (!position.manualNeeded || event?.kind !== "manual" || event.from !== position.step.id) return;
  const inputSignature = (source: NonNullable<FlowRun["input_sources"]>[number]) =>
    [source.variable_id, source.source, source.value, source.parameter_id, source.candidate_id];
  const relevantAnchors = (source: FlowRun) => (source.anchors || []).filter(anchor => anchor.step_id === position.step.id)
    .map(anchor => [anchor.object_id, anchor.kind, anchor.step_id, anchor.choice_id, anchor.phase, anchor.note])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const contextChanged = !sameState(position.state, event.before)
    || flowSourceStatus(base, run.source, run.dependencies).changed
    || JSON.stringify((run.input_sources || []).map(inputSignature)) !== JSON.stringify((base.input_sources || []).map(inputSignature))
    || JSON.stringify(relevantAnchors(run)) !== JSON.stringify(relevantAnchors(base));
  return { event, index, contextChanged };
}

/** Explicit user choice only: the earlier result becomes a marked assumption. */
export function replayReuseManual(run: FlowRun, base: FlowRun): FlowRun {
  const reuse = reusableManual(run, base);
  if (!reuse) throw new Error("基准试走在这一步没有可复用的手动结果。");
  const next = confirmManualResult(run, manualValues(reuse.event, runPosition(run).flow.variables),
    { base_trial_id: run.replay!.base_trial_id, base_event_index: reuse.index, context_changed: reuse.contextChanged });
  return advanceReplay({ ...next, replay: { ...next.replay!, cursor: reuse.index + 1 } }, base);
}

/** New manual input for this replay. It replaces the base result at this step when there is one. */
export function replayManualInput(run: FlowRun, base: FlowRun, values: Record<string, string>): FlowRun {
  const position = runPosition(run), cursor = run.replay!.cursor, intent = base.events[cursor];
  const next = confirmManualResult(run, values);
  const consumes = intent?.kind === "manual" && intent.from === position.step.id;
  return advanceReplay({ ...next, replay: { ...next.replay!, cursor: consumes ? cursor + 1 : cursor } }, base);
}

export type CompareVariable = { id: string; name: string; unit: string; a?: FlowValue; b?: FlowValue; sourceA: string; sourceB: string; changed: boolean };
export type CompareRow = { index: number; a?: FlowEvent; b?: FlowEvent; sameRoute: boolean; changesA: string[]; changesB: string[]; valuesDiffer: boolean };
export type RunComparison = { variables: CompareVariable[]; rows: CompareRow[]; route?: { index: number; text: string }; value?: { index: number; text: string };
  endA: string; endB: string; assumptions: string[]; candidateInputs: string[] };

export function describeEnd(run: FlowRun): string {
  const position = runPosition(run);
  if (run.replay?.status === "diverged") return `停止：${run.replay.divergence?.detail || "路线分歧"}`;
  if (position.manualNeeded) return `暂停在「${position.step.title}」：需要手动结果`;
  if (position.complete) return `到达结束步骤「${position.step.title}」`;
  return `停在「${position.step.title}」（预演未结束）`;
}

export function compareRuns(a: FlowRun, b: FlowRun, names = { a: "A", b: "B" }): RunComparison {
  const variablesA = a.source.planning?.flow?.variables || [], variablesB = b.source.planning?.flow?.variables || [];
  const ids = [...new Set([...variablesA.map(v => v.id), ...variablesB.map(v => v.id)])];
  const find = (id: string) => (variablesB.find(v => v.id === id) || variablesA.find(v => v.id === id)) as FlowVariable;
  const variables = ids.map(id => {
    const variable = find(id), va = a.initial[id], vb = b.initial[id];
    return { id, name: variable.name, unit: variable.unit, a: va, b: vb, changed: va !== vb,
      sourceA: Object.hasOwn(a.initial, id) ? describeInputSource(a.input_sources?.find(s => s.variable_id === id), a) : "此流程版本没有这个变量",
      sourceB: Object.hasOwn(b.initial, id) ? describeInputSource(b.input_sources?.find(s => s.variable_id === id), b) : "此流程版本没有这个变量" };
  });
  const rows: CompareRow[] = [];
  for (let index = 0; index < Math.max(a.events.length, b.events.length); index++) {
    const ea = a.events[index], eb = b.events[index];
    const sameRoute = !!ea && !!eb && ea.kind === eb.kind && ea.from === eb.from && ea.to === eb.to && ea.choice_id === eb.choice_id;
    rows.push({ index, a: ea, b: eb, sameRoute, changesA: ea ? flowChanges(ea.before, ea.after, variablesA) : [], changesB: eb ? flowChanges(eb.before, eb.after, variablesB) : [],
      valuesDiffer: !!ea && !!eb && !sameState(ea.after, eb.after) });
  }
  let route: RunComparison["route"];
  const split = rows.find(row => !row.sameRoute);
  if (split) {
    const n = split.index + 1;
    if (b.replay?.status === "diverged" && b.replay.divergence && b.replay.base_run_id === a.id && split.index === b.events.length)
      route = { index: split.index, text: `第 ${n} 个动作：${names.b} 停止重放——${b.replay.divergence.detail}` };
    else if (!split.a) route = { index: split.index, text: `第 ${n} 个动作：${names.a} 已停在「${stepTitle(a, a.events.at(-1)?.to || a.source.planning!.flow!.entry)}」，${names.b} 继续「${split.b!.label}」` };
    else if (!split.b) route = { index: split.index, text: `第 ${n} 个动作：${names.b} 已停在「${stepTitle(b, b.events.at(-1)?.to || b.source.planning!.flow!.entry)}」（${describeEnd(b)}），${names.a} 继续「${split.a.label}」` };
    else route = { index: split.index, text: `第 ${n} 个动作：${names.a}「${split.a.label}」→「${stepTitle(a, split.a.to)}」，${names.b}「${split.b.label}」→「${stepTitle(b, split.b.to)}」` };
  }
  let value: RunComparison["value"];
  const firstInitial = variables.find(v => v.changed);
  if (firstInitial) value = { index: 0, text: `初值：${firstInitial.name} ${names.a} ${String(firstInitial.a ?? "—")} · ${names.b} ${String(firstInitial.b ?? "—")}` };
  else {
    const row = rows.find(item => item.valuesDiffer);
    if (row) {
      const variable = ids.map(find).find(v => row.a!.after[v.id] !== row.b!.after[v.id])!;
      value = { index: row.index + 1, text: `第 ${row.index + 1} 个动作后：${variable.name} ${names.a} ${String(row.a!.after[variable.id] ?? "—")} · ${names.b} ${String(row.b!.after[variable.id] ?? "—")}` };
    }
  }
  const assumptions = [[names.a, a], [names.b, b]].flatMap(([label, run]) => (run as FlowRun).events.flatMap((event, index) => event.assumption
    ? [`${label as string} 第 ${index + 1} 个动作复用了基准试走的手动结果（手动假设${event.assumption.context_changed ? "；复用时输入或依赖已与基准不同" : ""}）`] : []));
  const candidateInputs = [[names.a, a], [names.b, b]].flatMap(([label, run]) => ((run as FlowRun).input_sources || []).filter(source => source.source === "candidate")
    .map(source => `${label as string}：${find(source.variable_id)?.name || source.variable_id} 使用候选「${(run as FlowRun).candidates?.find(c => c.id === source.candidate_id)?.label || source.candidate_id}」= ${source.value}`));
  return { variables, rows, route, value, endA: describeEnd(a), endB: describeEnd(b), assumptions, candidateInputs };
}
