import { fetchProjectCandidates, fetchProjectTrial, fetchProjectTrials, mutateProject, newProjectRequestId,
  type DevelopmentObject, type FlowTrial, type ParameterCandidate, type RecordFields, type TrialSummary } from "./project-record-api";
import { candidateBaseChanges, confirmManualResult, evaluateChoice as evaluate, flowDependencies, flowDiagnostics, flowExample, flowRecord, flowSourceStatus, advanceFlow,
  resolveFlowInputs, rewindFlow, runPosition, startFlowRun, upgradeRun, verifyRun, type FlowRun, type FlowVariable } from "./game-flow-model";
import { replayManualInput, replayReuseManual, reusableManual, startReplay } from "./game-flow-replay";
import { renderComparison, renderFacts, renderReplaySetup, replayCandidateProblems, renderRoute, renderTrialDetail, renderTrialList, trialTitle, type ReplaySetup } from "./game-flow-trials";
import { anchoredDesigns } from "./project-planning-model";
import { anchorMarks, renderAnchoredDesigns } from "./game-flow-links";
import { flowEl as el, flowButton as button, flowField as field, flowSelect as select, flowMount } from "./game-flow-ui";
import { mountFlowChart, mountStepGraph } from "./game-flow-visuals";
import "./game-flow.css";

export type FlowFocus = { flowId: string; stepId: string; choiceId?: string };
type Mode = "run" | "trials" | "compare";
export type FlowReturnState = { flowId: string; mode: Mode; viewing?: string; replaySetup?: ReplaySetup; inspect: string; chartVariable: string; chartOpen: boolean };
type Options = { projectId: string; objects: DevelopmentObject[]; candidates: ParameterCandidate[]; scope: string; selected?: string; focus?: FlowFocus; returnState?: FlowReturnState;
  preselect?: { parameterId: string; candidateId: string }; returnTo?: { label: string; action(): void };
  create(): void; edit(object: DevelopmentObject): void; record(object: DevelopmentObject, fields: Partial<RecordFields>): void;
  refreshSources(): Promise<DevelopmentObject[]>; selectedFlow(id: string): void;
  openObject(object: DevelopmentObject, back: FlowFocus, returnState: FlowReturnState): void; adopt(candidate: ParameterCandidate, trialIds: string[]): void; trialsChanged?(): void;
  writeContent?(flow: DevelopmentObject, stepId: string, choiceId?: string, state?: FlowReturnState): void };
/** The active run is a local checkpoint; saved trials are immutable project evidence. */
type Checkpoint = { version: 2; run: FlowRun; saved?: { trial_id: string; fingerprint: string }; parent_trial_id?: string; candidates?: Record<string, string> };
type Legacy = { keys: string[]; raw: string; run?: FlowRun; problems: string[] };
const CHECKPOINT = "spellcast.flow-run.v2", LEGACY = "spellcast.flow-run.v1", VIEW = "spellcast.flow-view.v1";
const read = <T>(key: string): T | undefined => { try { return JSON.parse(localStorage.getItem(key) || "null") || undefined; } catch { return undefined; } };
function fingerprint(value: unknown) {
  const text = JSON.stringify(value); let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${text.length}:${hash.toString(16)}`;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const replayStatus = { paused: "暂停在手动步骤", diverged: "已停止在第一处分歧", complete: "已按基准的选择走完" } as const;

export function createFlowWorkspace(options: Options) {
  const element = el("section", "", "game-flow flow-workspace"); element.dataset.flowWorkspace = "true";
  const head = el("header", "", "flow-workspace-head"), modes = el("nav", "", "flow-modes"), status = el("p", "", "flow-error"), body = el("div");
  status.setAttribute("role", "status"); element.append(head, modes, status, body);
  const example = flowExample(); let objects = options.objects, candidates = options.candidates;
  const flows = () => objects.filter(o => o.planning && o.kind === "flow" && !o.archived && (!options.scope || o.planning.scopes.includes(options.scope)));
  let selected = options.selected === example.id || flows().some(o => o.id === options.selected) ? options.selected! : flows()[0]?.id || example.id;
  const view = read<{ mode?: Mode; a?: string; b?: string }>(`${VIEW}.${options.projectId}`) || {};
  let mode: Mode = view.mode === "trials" || view.mode === "compare" ? view.mode : "run";
  let pendingReturn = options.returnState;
  let checkpoint: Checkpoint | undefined, inputs: Record<string, string> = {}, startCandidates: Record<string, string> = {};
  let inspect = "", chartVariable = "", chartOpen = false, busy = false, disposed = false, focus = options.focus;
  let trials: TrialSummary[] = [], trialsLoaded = false, viewing: string | undefined, compareA = view.a, compareB = view.b, replaySetup: ReplaySetup | undefined, legacy: Legacy[] = [];
  const cache = new Map<string, FlowTrial>(), cleanups: Array<() => void> = [];
  const object = () => selected === example.id ? example : objects.find(o => o.id === selected);
  const demo = () => selected === example.id;
  const key = () => `${CHECKPOINT}.${options.projectId}.${selected}`;
  const saved = () => !!checkpoint?.saved && checkpoint.saved.fingerprint === fingerprint(checkpoint.run);
  const chosen = (map: Record<string, string>) => Object.values(map).map(id => candidates.find(c => c.id === id)).filter((c): c is ParameterCandidate => !!c && !c.archived);
  /** Errors and neutral confirmations share one live region but not one colour. */
  function setStatus(value = "", tone: "error" | "note" = "error") { status.textContent = value; status.hidden = !value; status.className = tone === "error" ? "flow-error" : "flow-note"; }
  function rememberView() { try { localStorage.setItem(`${VIEW}.${options.projectId}`, JSON.stringify({ mode, a: compareA, b: compareB })); } catch { /* View state only. */ } }
  function lock(value: boolean) { element.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button,select").forEach(control => { if (value) control.disabled = true; }); }
  function persist() {
    if (!checkpoint) return;
    try { localStorage.setItem(key(), JSON.stringify(checkpoint)); }
    catch { setStatus("本地存储已满，本次试走进度暂未保存在本机。请保存为项目试走记录。"); }
  }
  function validRun(run: FlowRun | undefined): run is FlowRun {
    try {
      return !!run && (run.version === 1 || run.version === 2) && run.source?.id === selected && (demo() || run.source.project_id === options.projectId) && Array.isArray(run.events) && run.events.length <= 200
        && !!run.initial && !!run.source.planning?.flow && !flowDiagnostics(run.source.planning.flow).length && !!runPosition(run).step;
    } catch { return false; }
  }
  function scanLegacy(): Legacy[] {
    const found: Legacy[] = [];
    for (const suffix of ["", ".previous"]) {
      const storageKey = `${LEGACY}.${options.projectId}.${selected}${suffix}`; let raw: string | null = null;
      try { raw = localStorage.getItem(storageKey); } catch { continue; }
      if (!raw) continue;
      const same = found.find(item => item.raw === raw); if (same) { same.keys.push(storageKey); continue; }
      const entry: Legacy = { keys: [storageKey], raw, problems: [] };
      try {
        const parsed = JSON.parse(raw) as FlowRun;
        if (parsed?.version !== 1) entry.problems.push(`记录格式 ${String(parsed?.version)} 不是可恢复的旧版试走`);
        else if (parsed.source?.id !== selected || parsed.source?.project_id !== options.projectId) entry.problems.push("记录不属于当前项目的这个流程");
        else { entry.run = upgradeRun(parsed); entry.problems.push(...verifyRun(entry.run)); }
      } catch (error) { entry.problems.push(`无法解析：${message(error)}`); }
      found.push(entry);
    }
    return found;
  }
  function load() {
    checkpoint = undefined; inspect = focus?.flowId === selected ? focus.stepId : ""; inputs = {}; startCandidates = {}; chartVariable = "";
    viewing = undefined; replaySetup = undefined; trials = []; trialsLoaded = false;
    if (options.preselect && object()?.planning?.flow?.variables.some(v => v.parameter_id === options.preselect!.parameterId)) startCandidates[options.preselect.parameterId] = options.preselect.candidateId;
    const stored = read<Checkpoint>(key());
    if (stored) {
      if (stored.version === 2 && validRun(stored.run)) checkpoint = stored;
      else setStatus("上次的试走进度无法读取，原始数据仍保留在本机。可重新开始。");
    }
    // The example never writes to the project; an old local example run simply continues locally.
    if (!checkpoint && demo()) { const old = read<FlowRun>(`${LEGACY}.${options.projectId}.${selected}`); if (old && validRun(old)) checkpoint = { version: 2, run: upgradeRun(old) }; }
    legacy = demo() ? [] : scanLegacy();
    if (pendingReturn) {
      if (pendingReturn.flowId === selected) {
        mode = pendingReturn.mode; viewing = pendingReturn.viewing; replaySetup = pendingReturn.replaySetup ? structuredClone(pendingReturn.replaySetup) : undefined;
        inspect = pendingReturn.inspect; chartVariable = pendingReturn.chartVariable; chartOpen = pendingReturn.chartOpen;
        if (viewing) void ensureTrial(viewing).then(render).catch(error => setStatus(`试走读取失败：${message(error)}`));
        if (replaySetup && replaySetup.baseId !== viewing) void ensureTrial(replaySetup.baseId).then(render).catch(error => setStatus(`重放基准读取失败：${message(error)}`));
      }
      pendingReturn = undefined;
    }
    options.selectedFlow(selected);
    if (!demo()) void loadTrials();
    const base = checkpoint?.run.replay?.base_trial_id;
    if (base) void ensureTrial(base).then(render).catch(error => setStatus(`重放基准读取失败：${message(error)}`));
  }
  async function loadTrials() {
    const flowId = selected;
    try {
      const list = await fetchProjectTrials(options.projectId, flowId);
      if (disposed || flowId !== selected) return;
      trials = list; trialsLoaded = true;
      if (compareA && !trials.some(t => t.id === compareA)) compareA = undefined;
      if (compareB && !trials.some(t => t.id === compareB)) compareB = undefined;
      if (!busy) render();
    } catch (error) { if (!disposed && flowId === selected) { trialsLoaded = true; setStatus(`试走记录读取失败：${message(error)}`); if (!busy) render(); } }
  }
  async function ensureTrial(id: string): Promise<FlowTrial> {
    const hit = cache.get(id); if (hit) return hit;
    const trial = await fetchProjectTrial(options.projectId, id); cache.set(id, trial); return trial;
  }
  /** Saves the active run as a new immutable trial; identical content is deduplicated by the store. */
  async function saveActive(label = ""): Promise<TrialSummary> {
    if (!checkpoint || demo()) throw new Error("演示流程只在本机运行，不会保存到项目。");
    if (saved()) { const found = trials.find(t => t.id === checkpoint!.saved!.trial_id); if (found) return found; }
    const active = checkpoint, run = active.run;
    const result = await mutateProject({ op: "save_trial", request_id: newProjectRequestId(), project_id: options.projectId, id: crypto.randomUUID(), label,
      origin: run.replay ? "replay" : "walkthrough", ...(active.parent_trial_id ? { parent_trial_id: active.parent_trial_id } : {}), run });
    if (!result.trial) throw new Error("试走保存结果缺失。");
    active.saved = { trial_id: result.trial.id, fingerprint: fingerprint(run) };
    if (checkpoint === active) persist();
    trials = [result.trial, ...trials.filter(t => t.id !== result.trial!.id)];
    options.trialsChanged?.();
    return result.trial;
  }
  async function task(work: () => Promise<string | void>) {
    if (busy) return; busy = true; setStatus(""); lock(true);
    let note = "", tone: "error" | "note" = "note";
    try { note = (await work()) || ""; } catch (error) { note = message(error); tone = "error"; }
    finally { busy = false; if (!disposed) { render(); setStatus(note, tone); } }
  }
  function sourceStatus() { return checkpoint ? flowSourceStatus(checkpoint.run, object(), objects) : undefined; }
  function replayBase(): FlowRun | undefined { const id = checkpoint?.run.replay?.base_trial_id; return id ? cache.get(id)?.run : undefined; }
  async function finishReplay() {
    const trial = await saveActive(checkpoint?.run.candidates?.map(c => `候选「${c.label}」`).join("、") || "当前数值");
    const base = checkpoint?.run.replay?.base_trial_id;
    if (base) { compareA = base; compareB = trial.id; mode = "compare"; rememberView(); await Promise.all([ensureTrial(base), ensureTrial(trial.id)]); }
  }
  async function act(action: () => FlowRun) {
    if (busy || !checkpoint) return;
    const selection = selected; busy = true; setStatus(""); lock(true);
    let note = "";
    try {
      if (!demo()) { const fresh = await options.refreshSources(); if (disposed || selected !== selection) return; objects = fresh; }
      if (sourceStatus()?.changed) throw new Error("流程或引用数值的版本已改变。旧记录已保留，请重新开始试走。");
      checkpoint = { ...checkpoint!, run: action() }; inspect = ""; persist();
      if (checkpoint.run.replay && checkpoint.run.replay.status !== "paused") await finishReplay();
    } catch (error) { note = message(error); }
    finally { busy = false; if (!disposed) { render(); setStatus(note); } }
  }
  async function start() {
    const previous = object(); if (!previous || busy) return;
    const dependencies = flowDependencies(previous, objects), selection = selected;
    await task(async () => {
      if (!demo()) { objects = await options.refreshSources(); if (disposed || selected !== selection) return; }
      const current = object(); if (!current || current.archived) throw new Error("流程已归档或不可用。");
      if (JSON.stringify(current) !== JSON.stringify(previous) || JSON.stringify(dependencies) !== JSON.stringify(flowDependencies(current, objects))) { inputs = {}; throw new Error("流程或数值已有更新，已加载新版本，请核对初值后开始。"); }
      const next = startFlowRun(current, objects, inputs, { candidates: chosen(startCandidates) });
      // The previous trace goes into the project before the active run is replaced.
      let note = "";
      if (!demo() && checkpoint && !saved()) {
        try { note = `上一次试走已保存为项目记录 ${(await saveActive("开始新试走前自动保存")).id}。`; }
        catch (error) { throw new Error(`无法保存上一次试走，未开始新的试走：${message(error)}`); }
      }
      checkpoint = { version: 2, run: next, ...(Object.keys(startCandidates).length ? { candidates: { ...startCandidates } } : {}) };
      inspect = focus?.flowId === selected ? focus.stepId : ""; persist();
      return note;
    });
  }
  async function beginReplay() {
    const setup = replaySetup; if (!setup) return;
    await task(async () => {
      objects = await options.refreshSources();
      candidates = await fetchProjectCandidates(options.projectId);
      const current = object(); if (!current || current.archived) throw new Error("流程已归档或不可用。");
      const problems = replayCandidateProblems(setup, candidates);
      if (problems.length) throw new Error(problems.join("；"));
      const base = await ensureTrial(setup.baseId);
      const next = startReplay({ trialId: base.id, run: base.run }, current, objects, setup.keepInputs ? base.run.inputs : {}, chosen(setup.candidates));
      if (checkpoint && !saved()) await saveActive("开始重放前自动保存");
      checkpoint = { version: 2, run: next, candidates: { ...setup.candidates } }; replaySetup = undefined; mode = "run"; inspect = ""; rememberView(); persist();
      if (next.replay!.status !== "paused") { await finishReplay(); return "重放已结束并保存，已打开与基准的对照。"; }
      return "重放在手动步骤暂停。请填写本次结果，或明确选择复用基准结果（将标为手动假设）。";
    });
  }
  async function continueTrial(trial: FlowTrial) {
    await task(async () => {
      if (trial.run.replay) throw new Error("重放记录不能直接继续；可从头试走或再次重放。");
      if (checkpoint && !saved()) await saveActive("继续旧试走前自动保存");
      const copy = structuredClone(trial.run); copy.id = crypto.randomUUID();
      checkpoint = { version: 2, run: copy, parent_trial_id: trial.id }; mode = "run"; inspect = ""; rememberView(); persist();
      return `已从试走 ${trial.id} 复制出新的试走；原记录不会被修改。`;
    });
  }
  async function recoverLegacy() {
    await task(async () => {
      const notes: string[] = [];
      for (const entry of legacy) {
        if (!entry.run || entry.problems.length) continue;
        try {
          const result = await mutateProject({ op: "save_trial", request_id: newProjectRequestId(), project_id: options.projectId, id: crypto.randomUUID(), label: "本机旧试走恢复", origin: "legacy_local", run: entry.run });
          // Only after the project write succeeded is the local copy removed.
          for (const storageKey of entry.keys) try { localStorage.removeItem(storageKey); } catch { /* The saved copy is authoritative. */ }
          notes.push(result.deduplicated ? `项目中已有相同试走 ${result.trial?.id}，本机副本已清理。` : `已保存为项目试走 ${result.trial?.id}。`);
        } catch (error) { notes.push(`恢复失败，本机数据已保留：${message(error)}`); }
      }
      legacy = scanLegacy(); await loadTrials(); options.trialsChanged?.();
      return notes.join("\n");
    });
  }
  async function show(id: string) {
    viewing = id; mode = "trials"; rememberView(); render();
    try { await ensureTrial(id); } catch (error) { setStatus(`试走读取失败：${message(error)}`); }
    render();
  }
  async function prepareReplay(id: string) {
    try {
      const base = await ensureTrial(id);
      replaySetup = { baseId: id, candidates: Object.fromEntries((base.run.candidates || []).map(c => [c.parameter_id, c.id])),
        candidateRevisions: Object.fromEntries((base.run.candidates || []).map(c => [c.parameter_id, candidates.find(live => live.id === c.id)?.revision ?? c.revision])), keepInputs: true };
      viewing = id; mode = "trials"; rememberView(); render();
    } catch (error) { setStatus(`试走读取失败：${message(error)}`); }
  }
  function downloadText(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = el("a"); link.href = url; link.download = name; link.hidden = true; element.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const download = (name: string, value: unknown) => downloadText(name, JSON.stringify(value, null, 2));
  function inputField(variable: FlowVariable, value: string, name: string, change: (value: string) => void) {
    if (variable.value_type === "flag") return select(variable.name, value, name, [["", "请选择"], ["true", "开"], ["false", "关"]], change);
    return field(`${variable.name}${variable.unit ? `（${variable.unit}）` : ""}`, value, name, change);
  }
  function openDesign(design: DevelopmentObject, stepId: string, choiceId?: string) {
    options.openObject(design, { flowId: selected, stepId, ...(choiceId ? { choiceId } : {}) },
      { flowId: selected, mode, viewing, replaySetup: replaySetup ? structuredClone(replaySetup) : undefined, inspect, chartVariable, chartOpen });
  }
  function writeHere(current: DevelopmentObject, stepId: string, choiceId?: string) {
    const action = button("在这里写内容", "write-content", () => options.writeContent?.(current, stepId, choiceId,
      { flowId: selected, mode, viewing, replaySetup: replaySetup ? structuredClone(replaySetup) : undefined, inspect, chartVariable, chartOpen }));
    action.disabled = busy || demo() || !options.writeContent || !current.planning?.flow?.steps.some(s => s.id === stepId && (!choiceId || s.choices.some(c => c.id === choiceId)));
    return action;
  }
  function designs(current: DevelopmentObject, stepId: string, choiceId?: string | null) { return anchoredDesigns(objects, current.id, stepId, choiceId); }
  function render() {
    if (disposed) return; cleanups.splice(0).forEach(dispose => dispose()); head.replaceChildren(); modes.replaceChildren(); body.replaceChildren();
    head.append(el("h2", "流程与试走"), select("流程", selected, "flow-picker", [...flows().map(o => [o.id, `${o.name} · ${o.planning!.scopes.join(" / ")}`] as [string, string]), [example.id, "演示 · 一次探索（不写入项目）"]], id => { selected = id; focus = undefined; setStatus(""); load(); render(); }), button("新建自己的流程", "new-flow", options.create));
    if (options.returnTo) head.append(button(options.returnTo.label, "return-object", options.returnTo.action));
    const current = object(), isDemo = demo();
    if (!current) { body.append(el("p", "这个流程已不可用，请选择其他流程。")); return; }
    if (!isDemo) head.append(button(current.planning?.locked ? "解锁并编辑流程" : "编辑流程", "edit-flow", () => options.edit(current)));
    for (const [value, label] of [["run", "试走"], ["trials", `已保存试走${trialsLoaded ? ` · ${trials.length}` : ""}`], ["compare", "对照"]] as const) {
      const choice = button(label, `mode-${value}`, () => { mode = value; rememberView(); setStatus(""); render(); });
      choice.setAttribute("aria-pressed", String((isDemo ? "run" : mode) === value));
      if (isDemo && value !== "run") { choice.disabled = true; choice.title = "演示流程只在本机运行，不保存试走"; }
      modes.append(choice);
    }
    body.append(el("p", isDemo ? "交互演示 · 示例数值与步骤不代表 VESPERIX 设计，也不会存为项目对象。" : `已保存的流程 · 版本 ${current.revision} · ${current.planning!.scopes.join(" / ")}`, "flow-context"));
    if (legacy.length) renderLegacy();
    if (focus?.flowId === selected) renderFocus(current);
    const shown = isDemo ? "run" : mode;
    if (shown === "trials") { renderTrials(current); return; }
    if (shown === "compare") { renderCompare(); return; }
    if (!checkpoint) { renderStart(current); return; }
    renderRun(current);
  }
  function renderLegacy() {
    const box = el("section", "", "flow-legacy"); box.dataset.flowLegacy = "true";
    box.append(el("h4", `发现 ${legacy.length} 条本机旧试走（尚未保存到项目）`), el("small", "恢复前按记录里的流程与数值快照逐步重算校验；项目保存成功后才清理本机副本，相同内容只保存一份。"));
    for (const entry of legacy) {
      const row = el("div", "", "flow-toolbar");
      row.append(el("span", entry.run ? `${new Date(entry.run.started).toLocaleString()} · ${entry.run.events.length} 个动作` : "无法读取的记录"));
      if (entry.problems.length) row.append(el("small", `不能恢复：${entry.problems.join("；")}`, "flow-warning"));
      row.append(button("导出原始记录", "export-legacy", () => downloadText("flow-run-legacy.json", entry.raw)));
      box.append(row);
    }
    const recover = button("校验并保存到项目", "recover-legacy", () => void recoverLegacy()); recover.disabled = !legacy.some(entry => entry.run && !entry.problems.length);
    box.append(recover); body.append(box);
  }
  function renderFocus(current: DevelopmentObject) {
    const target = focus!, step = current.planning?.flow?.steps.find(s => s.id === target.stepId), choice = step?.choices.find(c => c.id === target.choiceId);
    const box = el("section", "", "flow-focus"); box.dataset.flowFocus = target.stepId;
    box.append(el("h3", step ? `流程位置：步骤「${step.title}」${target.choiceId ? ` · 选择「${choice?.label || "已不存在"}」` : ""}` : "这个流程位置已不存在"));
    if (step) {
      const text = el("div", "", "flow-focus-text");
      for (const [label, value] of [["玩家目标", step.goal], ["玩家动作", step.action], ["反馈", step.feedback]]) { const cell = el("div"); cell.append(el("h4", label), el("p", value || "尚未描述", "flow-prose")); text.append(cell); }
      box.append(text, renderAnchoredDesigns(target.choiceId ? "关联到这个选择的设计" : "关联到这个步骤的设计", designs(current, step.id, target.choiceId ?? null), object => openDesign(object, step.id, target.choiceId)));
      if (!demo()) box.append(writeHere(current, step.id, target.choiceId));
    }
    box.append(button("关闭定位", "clear-focus", () => { focus = undefined; render(); }));
    body.append(box);
  }
  function renderStart(current: DevelopmentObject, container: HTMLElement = body) {
    const flow = current.planning?.flow;
    if (!flow) { container.append(el("h3", "这个流程还没有定义步骤"), el("p", "在编辑器里添加玩家目标、动作、分支条件与反馈后，就可以逐步试走。")); return; }
    const problems = flowDiagnostics(flow), form = el("section", "", "flow-start");
    form.append(el("h3", "本次试走的初值"), el("p", "修改这里只影响本次预演；已保存的游戏设计保持原值。选用的候选只作用于本次试走，不会修改参数。"));
    for (const problem of problems) form.append(el("p", problem, "flow-error"));
    const selectedMap = Object.fromEntries(chosen(startCandidates).map(c => [c.parameter_id, c]));
    const grid = el("div", "", "flow-initial-grid");
    for (const item of resolveFlowInputs(current, objects, inputs, selectedMap)) {
      const box = el("div"), parameterId = item.variable.parameter_id;
      box.append(inputField({ ...item.variable, unit: item.unit }, inputs[item.variable.id] ?? item.value, `initial-${item.variable.id}`, value => { inputs[item.variable.id] = value; }));
      if (parameterId && !demo()) {
        const parameter = objects.find(o => o.id === parameterId), offered = candidates.filter(c => c.parameter_id === parameterId && !c.archived);
        if (offered.length) box.append(select("数值候选（仅本次试走）", startCandidates[parameterId] || "", `candidate-${parameterId}`, [["", `当前共用值 ${parameter?.planning?.parameter?.value || "待定"}`],
          ...offered.map(c => [c.id, `候选「${c.label}」 ${c.value}${candidateBaseChanges(c, parameter).length ? "（基准已变化）" : ""}`] as [string, string])],
          value => { if (value) startCandidates[parameterId] = value; else delete startCandidates[parameterId]; delete inputs[item.variable.id]; render(); }));
      }
      box.append(el("small", item.error || item.label)); if (item.note) box.append(el("small", item.note, "flow-warning"));
      grid.append(box);
    }
    if (!flow.variables.length) grid.append(el("p", "没有变量，仍可检查步骤和分支。"));
    const begin = button(checkpoint ? "保存上次进度并开始" : "开始试走", "start", () => { void start(); }); begin.disabled = problems.length > 0; form.append(grid, begin); container.append(form);
    if (!checkpoint) {
      const canvas = el("div", "", "flow-graph"); canvas.dataset.flowGraph = "start"; container.append(canvas, el("small", "点步骤查看说明和关联设计"));
      const target = focus?.flowId === selected ? focus.stepId : flow.entry;
      cleanups.push(flowMount(canvas, () => mountStepGraph(canvas, flow, target, [], id => { focus = { flowId: selected, stepId: id }; render(); }, demo() ? {} : anchorMarks(objects, current.id))));
    }
  }
  function renderRun(current: DevelopmentObject) {
    const active = checkpoint!, run = active.run, source = sourceStatus()!, changed = source.changed, isDemo = demo();
    const position = runPosition(run), { flow, step, state, manualNeeded, complete } = position, replay = run.replay, base = replayBase();
    if (changed) { body.append(el("p", "来源已改变：当前显示上次版本的记录。继续试走前请重新开始。", "flow-error")); if (source.details.length) body.append(el("small", source.details.join("；"), "flow-warning")); }
    else if (source.metadata) body.append(el("p", `来源版本已更新：${source.details.join("；")}。执行定义未变，可以继续；本次试走仍按开始时的版本记录。`, "flow-note"));
    if (replay) body.append(el("p", `重放 · 基准试走 ${base ? trialTitle(cache.get(replay.base_trial_id)!) : replay.base_trial_id} · ${replayStatus[replay.status]}${replay.divergence ? `：${replay.divergence.detail}` : ""}`, replay.status === "diverged" ? "flow-warning" : "flow-note"));
    const actions = el("div", "", "flow-toolbar");
    const back = button("退回一步", "rewind", () => { if (busy || !checkpoint) return; checkpoint = { ...checkpoint, run: rewindFlow(checkpoint.run) }; inspect = ""; persist(); render(); });
    back.disabled = !run.events.length || !!replay; if (replay) back.title = "重放按基准记录推进；需要不同路线时请开始新的试走";
    const restart = button("重新设置初值", "reset-inputs", () => { const box = el("section", "", "flow-initial-reset"); body.prepend(box); renderStart(current, box); restart.disabled = true; });
    actions.append(el("strong", `${complete ? "已到达结束步骤" : `当前：${step.title}`} · ${run.events.length} 个动作${saved() ? " · 已保存" : ""}`), back, restart);
    if (!isDemo) {
      const store = button(saved() ? "已保存为试走记录" : "保存为试走记录", "save-trial", () => void task(async () => `已保存为项目试走记录 ${(await saveActive()).id}，之后继续或回退不会改写它。`));
      const again = button("按相同选择重放…", "replay-from-run", () => void task(async () => { const trial = await saveActive(); await prepareReplay(trial.id); }));
      const record = button("转为开发记录草稿", "save-record", () => void task(async () => {
        const trial = await saveActive(), fields = flowRecord(checkpoint!.run, { id: trial.id, digest: trial.digest });
        if (changed) fields.boundaries += " 来源已改变，本记录对应试走开始时的版本。";
        options.record(current, fields);
      }));
      actions.append(store, again, record);
    }
    actions.append(button("导出完整试走", "export-run", () => download(`flow-run-${run.id}.json`, { format: "spellcast.flow-run", boundary: "模型预演，非实际游戏验收", ...run })));
    body.append(actions, el("small", "模型预演：仅计算已声明的规则。手动输入单独标记，不代表真实游戏验收。"));
    const split = el("div", "", "flow-run-split"), overview = el("section"), detail = el("section", "", "flow-current-step"); detail.dataset.flowCurrent = step.id;
    const canvas = el("div", "", "flow-graph flow-run-graph"); canvas.dataset.flowGraph = "run"; overview.append(canvas, el("small", "滚轮缩放 · 点步骤查看说明与关联设计，当前位置不会跳转"));
    const stats = el("dl", "", "flow-stats");
    for (const variable of flow.variables) { const entry = el("div"); entry.dataset.flowValue = variable.id; entry.append(el("dt", variable.name), el("dd", `${String(state[variable.id])}${variable.unit ? ` ${variable.unit}` : ""}`)); stats.append(entry); }
    overview.append(stats); split.append(overview, detail); body.append(split);
    cleanups.push(flowMount(canvas, () => mountStepGraph(canvas, flow, inspect || step.id, run.events.map(e => e.to), id => { inspect = id; render(); }, isDemo ? {} : anchorMarks(objects, current.id))));
    const shown = flow.steps.find(s => s.id === inspect) || step;
    detail.append(el("small", shown.id === step.id ? "当前玩家步骤" : "查看其他步骤"), el("h3", shown.title));
    for (const [label, text] of [["玩家目标", shown.goal], ["玩家动作", shown.action], ["反馈", shown.feedback]]) detail.append(el("h4", label), el("p", text || "尚未描述", "flow-prose"));
    if (!isDemo) detail.append(renderAnchoredDesigns("关联到此步骤的设计", designs(current, shown.id, null), object => openDesign(object, shown.id)));
    if (!isDemo) detail.append(writeHere(current, shown.id));
    if (shown.id !== step.id) detail.append(button("回到当前步骤", "back-current", () => { inspect = ""; render(); }));
    else if (manualNeeded) {
      const manual = el("section", "", "flow-manual"), values: Record<string, string> = {};
      manual.append(el("h4", "填写手动结果"), el("p", replay ? "重放在此暂停：这一步依赖外部事件。填写本次结果；或明确选择复用基准结果，它会标为手动假设，不能作为新方案的运行证据。" : "这一步依赖外部事件。填写你要预演的结果，未修改的变量保持当前值。"));
      for (const variable of flow.variables) manual.append(inputField(variable, String(state[variable.id]), `manual-${variable.id}`, value => { values[variable.id] = value; }));
      const confirm = button("确认这些手动结果", "confirm-manual", () => { void act(() => replay && base ? replayManualInput(checkpoint!.run, base, values) : confirmManualResult(checkpoint!.run, values)); });
      confirm.disabled = changed || (!!replay && !base); manual.append(confirm);
      const reuse = replay && base ? reusableManual(run, base) : undefined;
      if (reuse) {
        manual.append(button("复用基准结果（标为手动假设）", "reuse-manual", () => { void act(() => replayReuseManual(checkpoint!.run, base!)); }));
        manual.append(el("small", `基准在这里记录的结果：${Object.entries(reuse.event.after).filter(([id, value]) => reuse.event.before[id] !== value).map(([id, value]) => `${flow.variables.find(v => v.id === id)?.name || id}=${String(value)}`).join("；") || "未改变数值"}`));
        if (reuse.contextChanged) manual.append(el("p", "注意：到达这一步时的执行定义、输入、依赖、关联位置或状态已与基准不同，复用的结果只是假设。", "flow-warning"));
      }
      detail.append(manual);
    } else if (replay) detail.append(el("p", replay.status === "complete" ? "重放已按基准的选择走完。可在“对照”中查看差异，或从头开始新的试走。" : "重放已在第一处分歧停止，没有改走其他路线。可在“对照”中查看差异。", replay.status === "complete" ? "flow-complete" : "flow-warning"));
    else if (complete) detail.append(el("p", "本次已到达声明的结束步骤。检查下方路线与数值变化，再决定下一处修改。", "flow-complete"));
    else {
      if (!step.choices.length) detail.append(el("p", "这里还没有后续选择，也未声明结束。回到编辑器补充流程。", "flow-error"));
      // Conditions are evaluated by the same model as advancing; errors remain local to this choice.
      for (const choice of step.choices) {
        const box = el("div", "", "flow-available-choice"); box.dataset.focused = String(focus?.flowId === selected && focus.choiceId === choice.id);
        try {
          const evaluated = evaluate(flow, choice, state), choose = button(choice.label, "choose", () => { void act(() => advanceFlow(checkpoint!.run, choice.id)); });
          choose.dataset.flowChoice = choice.id; choose.disabled = changed || !evaluated.allowed; box.append(choose);
          for (const reason of evaluated.reasons) box.append(el("small", `${reason.passed ? "✓" : "未满足"} ${reason.text}`));
          if (!evaluated.reasons.length) box.append(el("small", "无条件"));
          const attached = isDemo ? [] : designs(current, step.id, choice.id);
          if (attached.length) box.append(renderAnchoredDesigns("关联到此选择", attached, object => openDesign(object, step.id, choice.id)));
        } catch (error) { box.append(el("p", message(error), "flow-error")); }
        detail.append(box);
      }
    }
    renderTrace(run);
  }
  function renderTrace(run: FlowRun) {
    const { flow } = runPosition(run), trace = el("section", "", "flow-trace"); trace.dataset.flowTrace = "true"; trace.append(el("h3", "路线与数值变化"));
    const numeric = flow.variables.filter(v => v.value_type === "number");
    if (numeric.length) {
      trace.append(button(chartOpen ? "收起变化曲线" : "查看变化曲线", "chart", () => { chartOpen = !chartOpen; render(); }));
      if (chartOpen) {
        chartVariable = numeric.some(v => v.id === chartVariable) ? chartVariable : numeric[0].id;
        trace.append(select("变量", chartVariable, "chart-variable", numeric.map(v => [v.id, v.name]), id => { chartVariable = id; render(); }));
        const chart = el("div", "", "flow-chart"); chart.dataset.flowChart = "true"; trace.append(chart);
        cleanups.push(flowMount(chart, () => mountFlowChart(chart, run, chartVariable)));
      }
    }
    if (!run.events.length) trace.append(el("p", "选择一个动作，变化会记录在这里。"));
    else trace.append(renderRoute(run));
    if (!demo()) trace.append(renderFacts(run));
    body.append(trace);
  }
  function renderTrials(current: DevelopmentObject) {
    const bar = el("div", "", "flow-toolbar");
    bar.append(el("strong", trialsLoaded ? `${trials.length} 条已保存试走 · 保存后不可修改` : "正在读取已保存试走…"), button("刷新", "reload-trials", () => { void loadTrials(); }));
    body.append(bar);
    if (replaySetup) {
      const base = cache.get(replaySetup.baseId);
      body.append(base ? renderReplaySetup(base, current, objects, candidates, replaySetup, { change: render, start: () => { void beginReplay(); }, cancel: () => { replaySetup = undefined; render(); } }) : el("p", "正在读取基准试走…"));
    }
    body.append(renderTrialList(trials, { viewing, compareA, compareB }, { view: id => { void show(id); }, setA: id => { compareA = id; rememberView(); render(); }, setB: id => { compareB = id; rememberView(); render(); }, replay: id => { void prepareReplay(id); } }));
    if (viewing) {
      const trial = cache.get(viewing);
      body.append(trial ? renderTrialDetail(trial, { continueRun: trial.run.replay ? undefined : () => { void continueTrial(trial); }, replay: () => { void prepareReplay(trial.id); },
        exportJson: () => download(`flow-trial-${trial.id}.json`, { format: "spellcast.flow-trial", boundary: "模型预演，非实际游戏验收", ...trial }),
        record: () => options.record(current, flowRecord(trial.run, trial)), setA: () => { compareA = trial.id; rememberView(); render(); }, setB: () => { compareB = trial.id; rememberView(); render(); } }) : el("p", "正在读取试走…"));
    }
  }
  function renderCompare() {
    const bar = el("div", "", "flow-toolbar"), choices: Array<[string, string]> = [["", "请选择"], ...trials.map(t => [t.id, trialTitle(t)] as [string, string])];
    bar.append(select("对照 A", compareA || "", "compare-a", choices, value => { compareA = value || undefined; rememberView(); render(); }),
      select("对照 B", compareB || "", "compare-b", choices, value => { compareB = value || undefined; rememberView(); render(); }));
    body.append(bar);
    if (!compareA || !compareB) { body.append(el("p", "选择同一流程的两条已保存试走进行对照。重放结束后会自动打开基准与重放的对照。")); return; }
    const a = cache.get(compareA), b = cache.get(compareB);
    if (!a || !b) { body.append(el("p", "正在读取试走…")); void Promise.all([ensureTrial(compareA), ensureTrial(compareB)]).then(render).catch(error => setStatus(`试走读取失败：${message(error)}`)); return; }
    body.append(renderComparison(a, b, candidates, { adopt: candidate => options.adopt(candidate, [a.id, b.id]), view: id => { void show(id); } }));
  }
  setStatus(""); load(); render();
  return { element, dispose() { disposed = true; cleanups.splice(0).forEach(dispose => dispose()); } };
}
