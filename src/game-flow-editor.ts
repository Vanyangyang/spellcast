import type { DevelopmentObject } from "./project-record-api";
import { blankFlow, conditionNames, effectNames, flowDiagnostics, flowInputs, newStep, type FlowCondition, type FlowEffect, type FlowStep } from "./game-flow-model";
import { flowEl as el, flowButton as button, flowField as field, flowSelect as select, flowCheck as check, flowMount } from "./game-flow-ui";
import { mountStepGraph, mountVariableTable } from "./game-flow-visuals";
import { anchoredDesigns, type FlowAnchor } from "./project-planning-model";
import { anchorMarks, designLabel, renderAnchoredDesigns } from "./game-flow-links";
import "./game-flow.css";
import { ct } from "./project-content";

/** `openObject` locates attached designs; they stay editable only through their own objects. */
export function createFlowEditor(object: DevelopmentObject, objects: DevelopmentObject[], changed: () => void, openObject?: (object: DevelopmentObject, anchor: FlowAnchor) => void, writeContent?: (stepId: string) => void) {
  const element = el("section", "", "game-flow flow-editor"); element.dataset.flowEditor = "true";
  let tab: "steps" | "variables" = "steps", selected = object.planning?.flow?.entry || "";
  let disposed = false;
  let disposeGraph: (() => void) | undefined, disposeTable: (() => void) | undefined;
  const notice = el("p", "", "flow-error"); notice.setAttribute("role", "status");
  const errors = el("div", "", "flow-diagnostics"), body = el("div"), toolbar = el("div", "", "flow-toolbar"), guard = el("div", "", "flow-guard"); guard.hidden = true;
  element.append(el("h3", "玩家流程"), el("p", "描述玩家动作，连接条件分支，并声明结果。保存后可逐步试走。"), toolbar, notice, guard, errors, body);
  function update() { changed(); errors.replaceChildren(); for (const error of flowDiagnostics(object.planning!.flow!)) errors.append(el("p", error)); }
  function message(text = "") { notice.textContent = text; notice.hidden = !text; guard.hidden = true; guard.replaceChildren(); }
  /** Referenced positions cannot disappear; name each owner and offer a way to unlink it there. */
  function blocked(designs: ReturnType<typeof anchoredDesigns>, what: string) {
    if (!designs.length) return false;
    message(`${what}仍被 ${designs.length} 个设计关联。请先在这些对象中解除流程位置，再删除。`);
    guard.hidden = false; guard.dataset.flowGuard = "true";
    for (const design of designs) { const row = el("div", "", "flow-toolbar"); row.append(el("span", designLabel(design))); if (openObject) row.append(button("打开并解除关联", "open-design", () => openObject(design.object, design.anchor))); guard.append(row); }
    return true;
  }
  function graph(container: HTMLElement) {
    disposeGraph?.(); disposeGraph = flowMount(container, () => mountStepGraph(container, object.planning!.flow!, selected, [], id => { selected = id; render(); }, anchorMarks(objects, object.id)));
  }
  function render() {
    if (disposed) return;
    disposeGraph?.(); disposeTable?.(); disposeGraph = undefined; disposeTable = undefined; body.replaceChildren(); toolbar.replaceChildren(); message();
    const flow = object.planning!.flow;
    if (!flow) { body.append(button("定义步骤与变量", "define", () => { object.planning!.flow = blankFlow(); update(); render(); })); return; }
    toolbar.append(button("步骤与分支", "steps", () => { tab = "steps"; render(); }), button("变量与初值", "variables", () => { tab = "variables"; render(); }));
    toolbar.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.flowAction === tab)));
    errors.replaceChildren(); for (const error of flowDiagnostics(flow)) errors.append(el("p", error));
    if (tab === "variables") { renderVariables(); return; }
    const split = el("div", "", "flow-editor-split"), left = el("section", "", "flow-step-browser"), right = el("section", "", "flow-step-detail");
    const actions = el("div", "", "flow-toolbar"), add = button("+ 添加步骤", "add-step", () => {
      const step = newStep(flow.steps.length + 1); flow.steps.push(step); flow.entry ||= step.id; selected = step.id; update(); render();
    }); add.disabled = flow.steps.length >= 64; actions.append(add);
    if (flow.steps.length) actions.append(select("入口", flow.entry, "entry", flow.steps.map(s => [s.id, s.title]), id => { flow.entry = id; update(); render(); }));
    left.append(actions);
    const canvas = el("div", "", "flow-graph"); canvas.dataset.flowGraph = "editor"; left.append(canvas, el("small", "滚轮缩放 · 拖动空白处平移 · 点步骤编辑"));
    const list = el("nav", "", "flow-step-list");
    selected = flow.steps.some(s => s.id === selected) ? selected : flow.entry;
    for (const step of flow.steps) { const item = button(`${step.id === flow.entry ? "入口 · " : ""}${step.title}${step.terminal ? " · 结束" : ""}`, "select-step", () => { selected = step.id; render(); }); item.dataset.flowStep = step.id; item.setAttribute("aria-current", String(step.id === selected)); list.append(item); }
    left.append(list); split.append(left, right); body.append(split); graph(canvas);
    const step = flow.steps.find(s => s.id === selected);
    if (!step) { right.append(el("h3", "先添加玩家的第一个步骤"), el("p", "例如：看见目标 → 作出选择 → 收到反馈。这里从空白流程开始。")); return; }
    right.append(field("步骤名称", step.title, "step-title", value => { step.title = value; update(); }),
      field("玩家目标", step.goal, "step-goal", value => { step.goal = value; update(); }, true),
      field("玩家动作", step.action, "step-action", value => { step.action = value; update(); }, true),
      field("看到的反馈", step.feedback, "step-feedback", value => { step.feedback = value; update(); }, true));
    const toggles = el("div", "", "flow-toolbar");
    toggles.append(check("需要手动结果（如战斗或外部事件）", step.external, "external", value => { step.external = value; update(); }),
      check("在这里结束", step.terminal, "terminal", value => { if (value && step.choices.length) { message("请先移除这个步骤的后续选择，再设为结束。"); return; } step.terminal = value; update(); render(); }));
    const terminal = toggles.querySelector<HTMLInputElement>('[data-flow-field="terminal"]')!; terminal.disabled = step.choices.length > 0;
    if (terminal.disabled) terminal.title = "请先移除后续选择";
    right.append(toggles, renderAnchoredDesigns("关联到此步骤的设计", anchoredDesigns(objects, object.id, step.id, null), openObject, "暂无。内容、规则或钩子可在各自对象中关联到这里，流程无需解锁。"), el("h4", "玩家选择与后果"));
    if (writeContent) right.append(button(ct("here"), "write-content", () => writeContent(step.id)));
    for (const [index, choice] of step.choices.entries()) {
      const box = el("section", "", "flow-choice-editor"); box.dataset.flowChoiceEditor = choice.id;
      box.append(field(`选择 ${index + 1}`, choice.label, `choice-label-${index}`, value => { choice.label = value; update(); }),
        select("接着到", choice.to, `choice-target-${index}`, flow.steps.map(s => [s.id, s.title]), value => { choice.to = value; update(); graph(canvas); }));
      const attached = anchoredDesigns(objects, object.id, step.id, choice.id);
      if (attached.length) box.append(renderAnchoredDesigns("关联到此选择的设计", attached, openObject));
      const conditions = el("section"), effects = el("section"); conditions.append(el("h4", "需要同时满足")); effects.append(el("h4", "选择后发生"));
      for (const [i, item] of choice.conditions.entries()) conditions.append(operation(item, false, `${index}-condition-${i}`, () => { choice.conditions.splice(i, 1); update(); render(); }));
      for (const [i, item] of choice.effects.entries()) effects.append(operation(item, true, `${index}-effect-${i}`, () => { choice.effects.splice(i, 1); update(); render(); }));
      if (!choice.conditions.length) conditions.append(el("small", "无条件，始终可选。"));
      if (!choice.effects.length) effects.append(el("small", "不改变变量。"));
      else effects.append(el("small", "右侧变量取选择前的值；对同一变量的多条变化按顺序应用。"));
      const addOperation = (effect: boolean) => { const variable = flow.variables[0]; if (!variable) { tab = "variables"; render(); message("先添加变量，再回来设置条件与结果。"); return; }
        const value = { variable_id: variable.id, operand: { kind: "literal" as const, value: variable.value_type === "flag" ? "true" : variable.value_type === "number" ? "0" : "" } };
        if (effect) choice.effects.push({ ...value, op: "set" }); else choice.conditions.push({ ...value, op: "eq" }); update(); render(); };
      const addCondition = button("+ 条件", "add-condition", () => addOperation(false)), addEffect = button("+ 数值或状态变化", "add-effect", () => addOperation(true));
      addCondition.disabled = choice.conditions.length >= 16; addEffect.disabled = choice.effects.length >= 16;
      conditions.append(addCondition); effects.append(addEffect); box.append(conditions, effects, button("移除这个选择", "remove-choice", () => { if (blocked(anchoredDesigns(objects, object.id, step.id, choice.id), `选择「${choice.label}」`)) return; step.choices.splice(index, 1); update(); render(); })); right.append(box);
    }
    const addChoice = button("+ 添加选择", "add-choice", () => { step.choices.push({ id: crypto.randomUUID(), label: "继续", to: flow.steps.find(s => s.id !== step.id)?.id || step.id, conditions: [], effects: [] }); update(); render(); });
    addChoice.disabled = step.terminal || step.choices.length >= 8;
    right.append(addChoice, button("移除步骤", "remove-step", () => {
      const referenced = flow.steps.flatMap(s => s.choices.filter(c => c.to === step.id).map(c => `${s.title} / ${c.label}`));
      if (referenced.length) { message(`还被这些选择引用，请先调整：${referenced.join("；")}`); return; }
      if (blocked(anchoredDesigns(objects, object.id, step.id), `步骤「${step.title}」`)) return;
      flow.steps = flow.steps.filter(s => s.id !== step.id); if (flow.entry === step.id) flow.entry = flow.steps[0]?.id || ""; selected = flow.entry; update(); render();
    }));
    right.addEventListener("change", event => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) graph(canvas); });
  }
  function operation(item: FlowCondition | FlowEffect, effect: boolean, key: string, remove: () => void) {
    const flow = object.planning!.flow!, row = el("div", "", "flow-operation"), variable = flow.variables.find(v => v.id === item.variable_id);
    row.append(select("变量", item.variable_id, `${key}-variable`, flow.variables.map(v => [v.id, v.name]), id => { item.variable_id = id; update(); render(); }),
      select("运算", item.op, `${key}-op`, Object.entries(effect ? effectNames : conditionNames), op => { item.op = op as typeof item.op; update(); }),
      select("右侧", item.operand.kind, `${key}-kind`, [["literal", "固定值"], ["variable", "另一变量"]], kind => { item.operand = { kind: kind as "literal" | "variable", value: kind === "variable" ? variable?.id || "" : variable?.value_type === "flag" ? "true" : "0" }; update(); render(); }));
    if (item.operand.kind === "variable") row.append(select("取值", item.operand.value, `${key}-value`, flow.variables.filter(v => v.value_type === variable?.value_type).map(v => [v.id, v.name]), value => { item.operand.value = value; update(); }));
    else if (variable?.value_type === "flag") row.append(select("取值", item.operand.value, `${key}-value`, [["true", "开"], ["false", "关"]], value => { item.operand.value = value; update(); }));
    else row.append(field("取值", item.operand.value, `${key}-value`, value => { item.operand.value = value; update(); }));
    row.append(button("移除", "remove-operation", remove)); return row;
  }
  function renderVariables() {
    const flow = object.planning!.flow!, add = button("+ 添加变量", "add-variable", () => { flow.variables.push({ id: crypto.randomUUID(), name: `变量 ${flow.variables.length + 1}`, value_type: "number", initial: "", unit: "" }); update(); render(); }); add.disabled = flow.variables.length >= 32;
    body.append(el("p", "点击单元格编辑。数字初值可留空，试走前补齐；开关填写 true / false。引用数值对象时采用共享值或该流程的局部值。"), add);
    const host = el("div", "", "flow-variable-table"); host.dataset.flowVariables = "true"; body.append(host);
    const parameters = objects.filter(o => o.kind === "parameter" && o.planning?.parameter && !o.archived);
    disposeTable = flowMount(host, () => mountVariableTable(host, flow.variables, Object.fromEntries(parameters.map(o => [o.id, o.name])), (id, key, value) => {
      const variable = flow.variables.find(v => v.id === id)!;
      if (key === "value_type" && value !== "number" && variable.parameter_id) { queueMicrotask(() => { render(); message("引用数值对象的变量只能是数字；请先将来源改为流程初值。"); }); return; }
      if (key === "parameter_id") { if (value) { variable.parameter_id = value; variable.value_type = "number"; if (!object.planning!.links.some(l => l.target_id === value && l.relation === "uses")) object.planning!.links.push({ target_id: value, relation: "uses", note: "流程变量初值" }); } else delete variable.parameter_id; }
      else if (["name", "value_type", "initial", "unit"].includes(key)) Object.assign(variable, { [key]: value });
      update(); renderSources();
      if (key === "parameter_id") queueMicrotask(render);
    }));
    const sources = el("section", "", "flow-variable-sources"); body.append(sources);
    function renderSources() {
      sources.replaceChildren(); for (const input of flowInputs(object, objects)) {
        const row = el("div", "", "flow-toolbar"); row.append(el("span", `${input.variable.name} · ${input.source} · ${input.initial || "待填写"} ${input.unit}`), button("移除变量", "remove-variable", () => {
          const used = flow.steps.some(s => s.choices.some(c => [...c.conditions, ...c.effects].some(i => i.variable_id === input.variable.id || (i.operand.kind === "variable" && i.operand.value === input.variable.id))));
          if (used) { message("这个变量仍被条件或结果使用，请先调整引用。"); return; } flow.variables = flow.variables.filter(v => v.id !== input.variable.id); update(); render();
        })); sources.append(row);
      }
    }
    renderSources();
  }
  render();
  return { element, dispose() { disposed = true; disposeGraph?.(); disposeTable?.(); } };
}
