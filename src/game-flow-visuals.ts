import type { FlowDefinition, FlowRun, FlowVariable } from "./game-flow-model";
import { flowEl as el } from "./game-flow-ui";

/** `marks` counts designs attached to each step; it only annotates labels. */
export async function mountStepGraph(host: HTMLElement, flow: FlowDefinition, selected: string, visited: string[], choose: (id: string) => void, marks: Record<string, number> = {}) {
  const { Graph } = await import("@antv/x6");
  if (!host.isConnected) return () => {};
  const inner = el("div"); inner.style.position = "absolute"; inner.style.inset = "0"; host.append(inner);
  const graph = new Graph({ container: inner, width: host.clientWidth, height: host.clientHeight, background: { color: "#0e1118" },
    grid: { visible: true, size: 20 }, interacting: false, panning: { enabled: true, eventTypes: ["leftMouseDown"] },
    mousewheel: { enabled: true, modifiers: null, zoomAtMousePosition: true, minScale: .2, maxScale: 1.8 }, scaling: { min: .2, max: 1.8 } });
  // Breadth-first ranks expose branches; unconnected steps remain visible at the right.
  const ranks = new Map<string, number>(); if (flow.entry) ranks.set(flow.entry, 0);
  const queue = [flow.entry]; for (let i = 0; i < queue.length; i++) for (const choice of flow.steps.find(s => s.id === queue[i])?.choices || []) {
    if (!ranks.has(choice.to)) { ranks.set(choice.to, (ranks.get(queue[i]) || 0) + 1); queue.push(choice.to); }
  }
  const used = new Map<number, number>(), lastRank = Math.max(0, ...ranks.values()) + 1;
  for (const step of flow.steps) {
    const rank = ranks.get(step.id) ?? lastRank, row = used.get(rank) || 0; used.set(rank, row + 1);
    const active = step.id === selected;
    graph.addNode({ id: step.id, x: 30 + rank * 240, y: 30 + row * 125, width: 190, height: 72,
      attrs: { body: { fill: active ? "#234741" : "#181e2a", stroke: active ? "#84e0ca" : visited.includes(step.id) ? "#c5a3ed" : "#4a5160", strokeWidth: active ? 2 : 1, rx: 10, ry: 10 },
        label: { text: `${step.id === flow.entry ? "入口 · " : ""}${step.title}\n${step.terminal ? "结束" : step.external ? "手动结果" : `${step.choices.length} 个选择`}${marks[step.id] ? ` · 关联 ${marks[step.id]}` : ""}`, fill: "#e9edf3", fontSize: 13, textWrap: { width: -16, height: -12, ellipsis: true } } } });
  }
  for (const step of flow.steps) for (const choice of step.choices) if (flow.steps.some(s => s.id === choice.to)) graph.addEdge({ source: step.id, target: choice.to,
    router: { name: "manhattan", args: { padding: 18 } }, connector: { name: "rounded", args: { radius: 8 } },
    attrs: { line: { stroke: "#868fa1", targetMarker: "classic", strokeWidth: 1.5 } },
    labels: [{ attrs: { label: { text: choice.label.slice(0, 24), fill: "#cbd3e0", fontSize: 11 }, body: { fill: "#0e1118", stroke: "#343c4b" } } }] });
  graph.on("node:click", ({ node }) => choose(node.id));
  const fit = () => { if (host.clientWidth > 0) { graph.resize(host.clientWidth, host.clientHeight); graph.zoomToFit({ padding: 28, maxScale: 1 }); } };
  const observer = new ResizeObserver(fit); observer.observe(host); fit();
  return () => { observer.disconnect(); graph.dispose(); inner.remove(); };
}

export async function mountVariableTable(host: HTMLElement, variables: FlowVariable[], parameterValues: Record<string, string>, change: (id: string, field: string, value: string) => void) {
  const [{ TabulatorFull }] = await Promise.all([import("tabulator-tables"), import("tabulator-tables/dist/css/tabulator_midnight.min.css")]);
  if (!host.isConnected) return () => {};
  const text = (cell: { getValue(): unknown }) => el("span", String(cell.getValue() ?? ""));
  const table = new TabulatorFull(host, { data: variables.map(v => ({ ...v, parameter_id: v.parameter_id || "" })), index: "id", layout: "fitColumns", popupContainer: host.closest("dialog") || host,
    height: Math.min(420, 84 + variables.length * 42), placeholder: "先添加一个变量，例如体力、金币或已完成引导。", editTriggerEvent: "click",
    columns: [{ title: "变量名称", field: "name", editor: "input", formatter: text, minWidth: 140 },
      { title: "类型", field: "value_type", width: 100, editor: "list", editorParams: { values: { number: "数字", flag: "开关", text: "文字" } }, formatter: (cell: { getValue(): unknown }) => el("span", ({ number: "数字", flag: "开关", text: "文字" } as Record<string, string>)[String(cell.getValue())]) },
      { title: "初值", field: "initial", editor: "input", formatter: text, minWidth: 100, editable: (cell: { getRow(): { getData(): Record<string, unknown> } }) => !cell.getRow().getData().parameter_id },
      { title: "单位", field: "unit", editor: "input", formatter: text, width: 100 },
      { title: "初值来源", field: "parameter_id", editor: "list", editorParams: { values: { "": "流程初值", ...parameterValues }, itemFormatter: (label: string) => el("span", label) }, minWidth: 190,
        formatter: (cell: { getValue(): unknown }) => el("span", cell.getValue() ? parameterValues[String(cell.getValue())] || "引用缺失" : "流程初值") }] });
  table.on("cellEdited", cell => change(String(cell.getRow().getData().id), cell.getField(), String(cell.getValue() ?? "")));
  return () => table.destroy();
}

export async function mountFlowChart(host: HTMLElement, run: FlowRun, variableId: string) {
  const echarts = await import("echarts"); if (!host.isConnected) return () => {};
  const variable = run.source.planning!.flow!.variables.find(v => v.id === variableId)!;
  const chart = echarts.init(host, "dark");
  chart.setOption({ backgroundColor: "transparent", animation: false, grid: { left: 65, right: 24, top: 40, bottom: 50 },
    title: { text: `${variable.name}${variable.unit ? `（${variable.unit}）` : ""}`, textStyle: { fontSize: 14 } },
    tooltip: { trigger: "axis", renderMode: "richText" }, xAxis: { name: "步骤", type: "category", data: ["初值", ...run.events.map((_, i) => String(i + 1))] },
    yAxis: { type: "value", scale: true }, dataZoom: [{ type: "inside" }],
    series: [{ type: "line", step: "end", data: [run.initial[variableId], ...run.events.map(e => e.after[variableId])], symbolSize: 7, lineStyle: { color: "#b995e8" }, itemStyle: { color: "#b995e8" } }] });
  const observer = new ResizeObserver(() => chart.resize()); observer.observe(host);
  return () => { observer.disconnect(); chart.dispose(); };
}
