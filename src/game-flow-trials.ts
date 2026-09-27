import type { DevelopmentObject, FlowTrial, ParameterCandidate, TrialSummary } from "./project-record-api";
import { candidateBaseChanges, describeInputSource, FACT_BOUNDARY, flowChanges, pathFacts, resolveFlowInputs, type FlowRun } from "./game-flow-model";
import { compareRuns } from "./game-flow-replay";
import { flowEl as el, flowButton as button, flowSelect as select, flowCheck as check } from "./game-flow-ui";

export const originNames: Record<string, string> = { walkthrough: "试走", replay: "重放", legacy_local: "本机旧试走恢复" };
export const PREVIEW_BOUNDARY = "模型预演：只计算已声明的条件与结果，不代表 Unity 运行或真实玩家验收。";
const time = (ms: number) => new Date(ms).toLocaleString();
export function trialTitle(trial: TrialSummary | FlowTrial) {
  return `${time(trial.created_at_ms)} · ${originNames[trial.origin] || trial.origin}${trial.label ? ` · ${trial.label}` : ""}`;
}
function stepTitle(run: FlowRun, id: string) { return run.source.planning?.flow?.steps.find(step => step.id === id)?.title || id; }

export function renderTrialList(trials: TrialSummary[], state: { viewing?: string; compareA?: string; compareB?: string },
  actions: { view(id: string): void; setA(id: string): void; setB(id: string): void; replay(id: string): void }): HTMLElement {
  const box = el("section", "", "flow-trials"); box.dataset.flowTrials = "true";
  if (!trials.length) { box.append(el("p", "还没有保存的试走。试走中选择“保存为试走记录”，或开始新的试走时会自动保存上一次的进度。")); return box; }
  const table = el("table", "", "flow-table"), head = el("tr");
  for (const title of ["保存时间与类型", "路线", "初值与候选", "操作"]) head.append(el("th", title));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const trial of trials) {
    const row = el("tr"); row.dataset.trialRow = trial.id; row.dataset.selected = String(state.viewing === trial.id);
    const first = el("td"); first.append(el("strong", trialTitle(trial)), el("small", `流程版本 ${trial.flow_revision} · 摘要 ${trial.digest.slice(0, 10)}${trial.base_trial_id ? ` · 重放基准 ${trial.base_trial_id.slice(0, 8)}` : ""}${trial.replay_status ? ` · ${({ paused: "已暂停", diverged: "已分歧", complete: "已完成" } as Record<string, string>)[trial.replay_status]}` : ""}`));
    const route = el("td", `${trial.event_count} 个动作 · ${trial.terminal ? `到达结束「${trial.end_step_title}」` : `停在「${trial.end_step_title}」`}${trial.manual_count ? ` · 手动 ${trial.manual_count}` : ""}${trial.assumption_count ? ` · 手动假设 ${trial.assumption_count}` : ""}`);
    const inputs = el("td", trial.candidates.length
      ? `${trial.candidates.map(c => `实际使用候选「${c.label}」= ${c.value}`).join("；")} · 其他初值来源见详情`
      : "未使用候选 · 实际初值来源见详情");
    const actionsCell = el("td"), bar = el("div", "", "flow-toolbar");
    const view = button("查看", "view-trial", () => actions.view(trial.id)), a = button(state.compareA === trial.id ? "已设为 A" : "设为 A", "compare-a", () => actions.setA(trial.id));
    const b = button(state.compareB === trial.id ? "已设为 B" : "设为 B", "compare-b", () => actions.setB(trial.id)), replay = button("重放…", "replay-trial", () => actions.replay(trial.id));
    for (const item of [view, a, b, replay]) item.dataset.trialId = trial.id;
    a.setAttribute("aria-pressed", String(state.compareA === trial.id)); b.setAttribute("aria-pressed", String(state.compareB === trial.id));
    bar.append(view, a, b, replay); actionsCell.append(bar);
    row.append(first, route, inputs, actionsCell); body.append(row);
  }
  table.append(body); box.append(table);
  return box;
}

export function renderFacts(run: FlowRun): HTMLElement {
  const facts = pathFacts(run), box = el("section", "", "flow-facts"); box.dataset.flowFacts = "true";
  box.append(el("h4", "路径事实"), el("small", FACT_BOUNDARY));
  if (!facts.length) { box.append(el("p", "开始这次试走时没有设计关联到此流程。")); return box; }
  const list = el("ul");
  for (const fact of facts) { const item = el("li", fact.text); item.dataset.factReached = String(fact.reached); list.append(item); }
  box.append(list);
  return box;
}

export function renderInputs(run: FlowRun): HTMLElement {
  const box = el("section", "", "flow-inputs"); box.append(el("h4", "初值与来源"));
  const list = el("ul"), variables = run.source.planning?.flow?.variables || [];
  if (!variables.length) list.append(el("li", "此流程没有变量。"));
  for (const variable of variables) list.append(el("li", `${variable.name} = ${String(run.initial[variable.id])}${variable.unit ? ` ${variable.unit}` : ""} · ${describeInputSource(run.input_sources?.find(source => source.variable_id === variable.id), run)}`));
  box.append(list);
  return box;
}

export function renderRoute(run: FlowRun): HTMLElement {
  const variables = run.source.planning?.flow?.variables || [], table = el("table", "", "flow-table"), header = el("tr");
  for (const title of ["动作", "路线", "数值变化"]) header.append(el("th", title));
  const thead = el("thead"); thead.append(header); table.append(thead);
  const rows = el("tbody");
  for (const [index, event] of run.events.entries()) {
    const row = el("tr");
    row.append(el("td", `${index + 1}. ${event.label}${event.kind === "manual" ? event.assumption ? "（手动假设）" : "（手动）" : ""}`), el("td", `${stepTitle(run, event.from)} → ${stepTitle(run, event.to)}`),
      el("td", flowChanges(event.before, event.after, variables).join("；") || "未变化"));
    rows.append(row);
  }
  if (!run.events.length) { const row = el("tr"), cell = el("td", "还没有动作。"); cell.colSpan = 3; row.append(cell); rows.append(row); }
  table.append(rows);
  return table;
}

export function renderTrialDetail(trial: FlowTrial, actions: { continueRun?(): void; replay(): void; exportJson(): void; record?(): void; setA(): void; setB(): void }): HTMLElement {
  const box = el("section", "", "flow-trial-detail"); box.dataset.flowTrialDetail = trial.id;
  box.append(el("h3", trialTitle(trial)), el("small", `流程「${trial.run.source.name}」版本 ${trial.flow_revision} · 内容摘要 ${trial.digest.slice(0, 12)} · 保存后不可修改，继续、回退或重放都会生成新的试走`));
  if (trial.run.replay) box.append(el("p", `重放基准 ${trial.run.replay.base_trial_id} · ${({ paused: "暂停在手动步骤", diverged: "已分歧", complete: "已按基准选择走完" } as Record<string, string>)[trial.run.replay.status]}${trial.run.replay.divergence ? ` · 第一处分歧：${trial.run.replay.divergence.detail}` : ""}`, trial.run.replay.divergence ? "flow-warning" : ""));
  const bar = el("div", "", "flow-toolbar");
  if (actions.continueRun) bar.append(button("从这里继续（新试走）", "continue-trial", actions.continueRun));
  bar.append(button("按相同选择重放…", "replay-trial", actions.replay), button("设为对照 A", "compare-a", actions.setA), button("设为对照 B", "compare-b", actions.setB), button("导出 JSON", "export-trial", actions.exportJson));
  if (actions.record) bar.append(button("转为开发记录草稿", "record-trial", actions.record));
  box.append(bar, el("small", PREVIEW_BOUNDARY), renderInputs(trial.run), renderFacts(trial.run), renderRoute(trial.run));
  return box;
}

export type ReplaySetup = { baseId: string; candidates: Record<string, string>; candidateRevisions: Record<string, number>; keepInputs: boolean };
export function replayCandidateProblems(setup: ReplaySetup, candidates: ParameterCandidate[]): string[] {
  return Object.entries(setup.candidates).flatMap(([parameterId, candidateId]) => {
    const candidate = candidates.find(item => item.id === candidateId);
    if (!candidate || candidate.parameter_id !== parameterId) return [`参数 ${parameterId} 的候选 ${candidateId} 已不可用，请重新选择数值来源。`];
    if (candidate.archived) return [`候选「${candidate.label}」已归档，请重新选择数值来源。`];
    if (candidate.revision !== setup.candidateRevisions[parameterId]) return [`候选「${candidate.label}」已有新版本，请重新选择数值来源。`];
    return [];
  });
}
export function renderReplaySetup(base: FlowTrial, current: DevelopmentObject, objects: DevelopmentObject[], candidates: ParameterCandidate[], setup: ReplaySetup,
  actions: { change(): void; start(): void; cancel(): void }): HTMLElement {
  const box = el("section", "", "flow-replay-setup"); box.dataset.flowReplaySetup = base.id;
  box.append(el("h3", "按相同选择重放"), el("p", `基准：${trialTitle(base)}。重放使用当前流程定义和下列初值，按基准的选择顺序执行；遇到手动步骤会暂停，出现分歧时停止并说明原因，原试走保持不变。`));
  const flow = current.planning?.flow;
  if (!flow) { box.append(el("p", "当前流程没有步骤。", "flow-error")); return box; }
  const selected: Record<string, ParameterCandidate | undefined> = {};
  const problems = replayCandidateProblems(setup, candidates);
  for (const [parameterId, candidateId] of Object.entries(setup.candidates)) {
    const candidate = candidates.find(c => c.id === candidateId);
    if (candidate && !candidate.archived && candidate.parameter_id === parameterId && candidate.revision === setup.candidateRevisions[parameterId]) selected[parameterId] = candidate;
  }
  const inputs = setup.keepInputs ? base.run.inputs : {};
  if (Object.keys(base.run.inputs).length) box.append(check(`沿用基准试走的手动初值（${Object.entries(base.run.inputs).map(([id, value]) => `${flow.variables.find(v => v.id === id)?.name || id}=${value}`).join("；")}）`, setup.keepInputs, "replay-keep-inputs", value => { setup.keepInputs = value; actions.change(); }));
  const grid = el("div", "", "flow-replay-grid");
  for (const item of resolveFlowInputs(current, objects, inputs, selected)) {
    const cell = el("div"), parameterId = item.variable.parameter_id, baseValue = base.run.initial[item.variable.id];
    cell.append(el("strong", `${item.variable.name}${item.unit ? `（${item.unit}）` : ""}`));
    if (parameterId) {
      const parameter = objects.find(o => o.id === parameterId), options = candidates.filter(c => c.parameter_id === parameterId && !c.archived);
      const unavailable = setup.candidates[parameterId] && !options.some(c => c.id === setup.candidates[parameterId])
        ? [[setup.candidates[parameterId], "所选候选已不可用 · 请重新选择"] as [string, string]] : [];
      cell.append(select("数值来源", setup.candidates[parameterId] || "", `replay-candidate-${parameterId}`, [["", `当前共用值 ${parameter?.planning?.parameter?.value || "待定"}`],
        ...unavailable, ...options.map(c => [c.id, `候选「${c.label}」 ${c.value}${candidateBaseChanges(c, parameter).length ? "（基准已变化）" : ""}`] as [string, string])], value => {
          if (value) { setup.candidates[parameterId] = value; setup.candidateRevisions[parameterId] = candidates.find(c => c.id === value)!.revision; }
          else { delete setup.candidates[parameterId]; delete setup.candidateRevisions[parameterId]; }
          actions.change();
        }));
    }
    const differs = baseValue === undefined || String(baseValue) !== item.value;
    const value = el("p", `重放初值 ${item.value || "待填写"} · ${item.label}`); value.dataset.replayChanged = String(differs);
    cell.append(value, el("small", `基准初值 ${baseValue === undefined ? "（基准没有此变量）" : String(baseValue)}${differs ? " · 与基准不同" : ""}`));
    if (item.note) cell.append(el("small", item.note, "flow-warning"));
    if (item.error) cell.append(el("small", item.error, "flow-error"));
    grid.append(cell);
  }
  const bar = el("div", "", "flow-toolbar");
  const start = button("开始重放", "start-replay", actions.start); start.disabled = !!problems.length;
  bar.append(start, button("取消", "cancel-replay", actions.cancel));
  box.append(grid, ...problems.map(problem => el("p", problem, "flow-error")), bar);
  return box;
}

export function renderComparison(a: FlowTrial, b: FlowTrial, candidates: ParameterCandidate[], actions: { adopt(candidate: ParameterCandidate): void; view(id: string): void }): HTMLElement {
  const result = compareRuns(a.run, b.run), box = el("section", "", "flow-compare"); box.dataset.flowCompare = `${a.id}:${b.id}`;
  const heads = el("div", "", "flow-compare-heads");
  for (const [name, trial] of [["A", a], ["B", b]] as const) {
    const card = el("div"); card.append(el("strong", `${name} · ${trialTitle(trial)}`), el("small", `流程版本 ${trial.flow_revision} · ${trial.run.events.length} 个动作`));
    const view = button("查看详情", "view-trial", () => actions.view(trial.id)); view.dataset.trialId = trial.id; card.append(view); heads.append(card);
  }
  const callouts = el("div", "", "flow-callouts");
  const callout = (title: string, text: string, key: string, warn = false) => { const item = el("div", "", warn ? "flow-callout warn" : "flow-callout"); item.dataset.compare = key; item.append(el("h4", title), el("p", text)); callouts.append(item); };
  callout("第一处路线分歧", result.route?.text || "路线一致：两次试走的动作序列相同。", "route", !!result.route);
  callout("第一处数值差异", result.value?.text || "初值和每一步的数值都相同。", "value", !!result.value);
  callout("结束状态", `A：${result.endA}\nB：${result.endB}`, "end");
  box.append(heads, callouts);
  for (const text of [...result.candidateInputs, ...result.assumptions]) box.append(el("p", text, text.includes("假设") ? "flow-warning" : "flow-note"));
  const initial = el("table", "", "flow-table"), ih = el("tr");
  for (const title of ["变量", "A 初值与来源", "B 初值与来源"]) ih.append(el("th", title));
  const ithead = el("thead"); ithead.append(ih); initial.append(ithead);
  const ibody = el("tbody");
  for (const variable of result.variables) {
    const row = el("tr"); row.dataset.compareChanged = String(variable.changed);
    row.append(el("td", `${variable.name}${variable.unit ? `（${variable.unit}）` : ""}`), el("td", `${String(variable.a ?? "—")} · ${variable.sourceA}`), el("td", `${String(variable.b ?? "—")} · ${variable.sourceB}`));
    ibody.append(row);
  }
  initial.append(ibody);
  const route = el("table", "", "flow-table"), rh = el("tr");
  for (const title of ["#", "A 的动作与变化", "B 的动作与变化"]) rh.append(el("th", title));
  const rthead = el("thead"); rthead.append(rh); route.append(rthead);
  const rbody = el("tbody"), cell = (run: FlowRun, event: FlowRun["events"][number] | undefined, changes: string[]) => event
    ? `${event.label}${event.kind === "manual" ? event.assumption ? "（手动假设）" : "（手动）" : ""}\n${stepTitle(run, event.from)} → ${stepTitle(run, event.to)}\n${changes.join("；") || "未变化"}` : "—";
  for (const row of result.rows) {
    const tr = el("tr"); tr.dataset.compareRoute = row.sameRoute ? "same" : "different"; tr.dataset.compareValues = String(row.valuesDiffer);
    tr.append(el("td", String(row.index + 1)), el("td", cell(a.run, row.a, row.changesA)), el("td", cell(b.run, row.b, row.changesB)));
    rbody.append(tr);
  }
  if (!result.rows.length) { const tr = el("tr"), td = el("td", "两次试走都还没有动作。"); td.colSpan = 3; tr.append(td); rbody.append(tr); }
  route.append(rbody);
  box.append(el("h4", "初值"), initial, el("h4", "逐步路线"), route, el("small", PREVIEW_BOUNDARY));
  const used = [...new Map([...(a.run.candidates || []), ...(b.run.candidates || [])].map(c => [c.id, c])).values()];
  if (used.length) {
    const adopt = el("section", "", "flow-compare-adopt"); adopt.append(el("h4", "采用候选"), el("small", "采用会打开参数的采用面板：需要明确解锁、填写理由，并核对候选基准与影响范围。"));
    for (const snapshot of used) {
      const live = candidates.find(c => c.id === snapshot.id), go = button(`采用候选「${snapshot.label}」…`, "adopt-candidate", () => live && actions.adopt(live));
      go.dataset.candidateId = snapshot.id; go.disabled = !live || live.archived;
      adopt.append(go);
      if (live && live.revision !== snapshot.revision) adopt.append(el("small", `候选「${snapshot.label}」已更新到版本 ${live.revision}（试走中为版本 ${snapshot.revision}），采用时以当前版本为准。`, "flow-warning"));
    }
    box.append(adopt);
  }
  return box;
}
