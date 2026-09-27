import { planText as t } from "./i18n/planning";
import { wheelScale } from "./canvas-wheel";
import type { DevelopmentObject } from "./project-record-api";
import { planningBody, planningImpact, type PlanningKind, type FlowAnchor } from "./project-planning-model";
import { ct, renderContentBody } from "./project-content";
import { MAP_LAYERS, planningMapExample, planningMapModel, type MapConnection, type MapLayer, type MapPoint } from "./project-planning-map-model";
import "./project-planning-map.css";

export type PlanningCreation = { kind: PlanningKind; scopes: string[]; parent?: string; anchor?: FlowAnchor };
type Options = { projectId: string; objects: DevelopmentObject[]; scope: string; open(object: DevelopmentObject): void;
  edit(object: DevelopmentObject, relations?: boolean): void; create(options: PlanningCreation): void };
type ViewState = { positions: Record<string, MapPoint>; camera?: { x: number; y: number; zoom: number }; layers: Record<MapLayer, boolean>; selected?: string };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
};
const svg = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS("http://www.w3.org/2000/svg", tag);
function button(text: string, action: () => void, name = "") {
  const value = el("button", text); value.type = "button"; value.dataset.mapAction = name; value.addEventListener("click", action); return value;
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export function createPlanningMap(options: Options) {
  const example = !options.objects.some(o => o.planning && !o.archived);
  const objects = example ? planningMapExample([t("exampleExplore"), t("exampleEncounter"), t("exampleSettle"), t("exampleContent"), t("exampleHook"), t("exampleParameter"), t("exampleRule"), t("exampleReason")]) : options.objects;
  const model = planningMapModel(objects), key = `spellcast.planning.map.v1.${options.projectId}${example ? ".example" : ""}`;
  let previous: Partial<ViewState> = {}; try { previous = JSON.parse(localStorage.getItem(key) || "{}"); } catch { /* Use defaults. */ }
  if (!previous || typeof previous !== "object") previous = {};
  const state: ViewState = { positions: {}, layers: { rule: true, parameter: true, content: true, hook: true }, selected: previous.selected };
  for (const kind of MAP_LAYERS) if (typeof previous.layers?.[kind] === "boolean") state.layers[kind] = previous.layers[kind];
  const ordered = [...model.nodes].sort((a, b) => Number(a.unattached) - Number(b.unattached));
  const rowHeights: number[] = [];
  for (let row = 0; row < Math.ceil(ordered.length / 3); row++) rowHeights.push(Math.max(...ordered.slice(row * 3, row * 3 + 3).map(n => 190 + Math.min(n.items.length, 5) * 66)) + 80);
  for (const [index, node] of ordered.entries()) {
    const point = previous.positions?.[node.object.id];
    state.positions[node.object.id] = point && finite(point.x) && finite(point.y) ? { x: point.x, y: point.y } : {
      x: 60 + (index % 3) * 440, y: 80 + rowHeights.slice(0, Math.floor(index / 3)).reduce((sum, value) => sum + value, 0),
    };
  }
  if (previous.camera && finite(previous.camera.x) && finite(previous.camera.y) && finite(previous.camera.zoom)) state.camera = { ...previous.camera, zoom: clamp(previous.camera.zoom, .25, 2) };
  if (!model.objects.some(o => o.id === state.selected)) state.selected = undefined;
  const root = el("section", "", "plan-map"); root.dataset.planMap = "true"; root.dataset.example = String(example);
  const tools = el("div", "", "plan-map-tools"), caption = el("div", "", "plan-map-caption");
  caption.append(el("strong", example ? t("exampleTitle") : t("mapCaption")), el("small", example ? t("exampleHelp") : t("mapHelp")));
  const layers = el("div", "", "plan-map-layers"), controls = el("div", "", "plan-map-camera"), zoomLabel = el("span");
  const body = el("div", "", "plan-map-body"), stage = el("div", "", "plan-map-stage"), world = el("div", "", "plan-map-world");
  const lines = svg("svg"), nodeLayer = el("div", "", "plan-map-nodes"), edgeLabels = el("div", "", "plan-map-edge-labels"), inspector = el("aside", "", "plan-map-inspector");
  const hint = el("div", t("mapGesture"), "plan-map-hint");
  lines.classList.add("plan-map-lines"); lines.setAttribute("aria-hidden", "true");
  world.append(lines, edgeLabels, nodeLayer); stage.append(world, hint); stage.tabIndex = 0; stage.setAttribute("aria-label", t("structure"));
  body.append(stage, inspector); tools.append(caption, layers, controls); root.append(tools, body);
  let disposed = false, frame = 0;
  let wheelFrame = 0, wheelIntent: { x: number; y: number; deltaY: number } | undefined;
  const nodes = new Map<string, HTMLElement>();
  function persist() { try { localStorage.setItem(key, JSON.stringify(state)); } catch { hint.textContent = t("mapStorageFailed"); } }
  function visible(object: DevelopmentObject) {
    return (object.kind === "system" || object.kind === "flow") || ((!options.scope || object.planning!.scopes.includes(options.scope)) && state.layers[object.kind as MapLayer]);
  }
  function activeItems(id: string) { return model.nodes.find(n => n.object.id === id)?.items.filter(visible) || []; }
  function effectiveText(object: DevelopmentObject) {
    const fields = object.planning!;
    if (fields.parameter) return `${t("sharedValue")}: ${fields.parameter.value || t("undecided")} ${fields.parameter.unit}`.trim();
    const values = state.layers.parameter ? fields.links.filter(link => link.relation === "uses").flatMap(link => {
      const target = model.objects.find(o => o.id === link.target_id), parameter = target?.planning?.parameter;
      return parameter ? [`${target!.name}: ${link.local?.value || parameter.value || t("undecided")} ${parameter.unit} (${t(link.local ? "localValue" : "sharedValue")})`] : [];
    }) : [];
    return values.join(" · ") || fields.hook?.cue || fields.rule?.effect || planningBody(fields);
  }
  function select(id?: string) { state.selected = id; persist(); renderNodes(); renderInspector(); drawEdges(); }
  function camera() { return state.camera || { x: 24, y: 24, zoom: 1 }; }
  function updateCamera() {
    const { x, y, zoom } = camera(); world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    stage.style.backgroundPosition = `${x}px ${y}px`; stage.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }
  function zoom(factor: number, x = stage.clientWidth / 2, y = stage.clientHeight / 2) {
    const old = camera(), z = clamp(old.zoom * factor, .25, 2), scale = z / old.zoom;
    state.camera = { zoom: z, x: x - (x - old.x) * scale, y: y - (y - old.y) * scale }; updateCamera(); persist();
  }
  function fit() {
    if (!stage.clientWidth || !stage.clientHeight || !ordered.length) return;
    const visibleNodes = ordered.filter(n => !n.unattached || visible(n.object));
    const placed = visibleNodes.length ? visibleNodes : ordered;
    const x = Math.min(...placed.map(n => state.positions[n.object.id].x)), y = Math.min(...placed.map(n => state.positions[n.object.id].y));
    const right = Math.max(...placed.map(n => state.positions[n.object.id].x + 304));
    const bottom = Math.max(...placed.map(n => state.positions[n.object.id].y + (nodes.get(n.object.id)?.offsetHeight || 120)));
    const z = clamp(Math.min((stage.clientWidth - 64) / (right - x), (stage.clientHeight - 80) / (bottom - y), 1), .25, 1);
    state.camera = { zoom: z, x: (stage.clientWidth - (right - x) * z) / 2 - x * z, y: Math.max(32, (stage.clientHeight - (bottom - y) * z) / 2) - y * z };
    updateCamera(); persist();
  }
  function moveTo(id: string) {
    const point = state.positions[id]; if (!point) return;
    const old = camera(); state.camera = { ...old, x: stage.clientWidth / 2 - (point.x + 152) * old.zoom, y: 70 - point.y * old.zoom };
    updateCamera(); persist();
  }
  function add(kind: PlanningKind, parent?: DevelopmentObject) {
    const value = button(kind === "content" ? ct(parent ? "here" : "write") : `+ ${t(kind)}`, () => options.create({ kind, scopes: options.scope ? [options.scope] : parent?.planning?.scopes || ["R0"], parent: example ? undefined : parent?.id }));
    value.dataset.planCreate = kind; if (parent && !example) value.dataset.createParent = parent.id; return value;
  }
  function renderControls() {
    layers.replaceChildren(el("span", t("layers")));
    for (const kind of MAP_LAYERS) {
      const label = el("label", "", "plan-map-layer"), input = el("input"); input.type = "checkbox"; input.checked = state.layers[kind]; input.dataset.mapLayer = kind;
      input.addEventListener("change", () => { state.layers[kind] = input.checked; persist(); renderNodes(); drawEdges(); renderInspector(); });
      label.dataset.kind = kind; label.append(input, el("span", t(kind))); layers.append(label);
    }
    layers.append(button(t("skeletonOnly"), () => { for (const kind of MAP_LAYERS) state.layers[kind] = false; persist(); renderControls(); renderNodes(); drawEdges(); renderInspector(); }, "skeleton"),
      button(t("allLayers"), () => { for (const kind of MAP_LAYERS) state.layers[kind] = true; persist(); renderControls(); renderNodes(); drawEdges(); renderInspector(); }, "layers"));
    controls.replaceChildren(add("content"), add("system"), add("flow"), button("−", () => zoom(1 / 1.2), "zoom-out"), zoomLabel,
      button("+", () => zoom(1.2), "zoom-in"), button(t("fitMap"), fit, "fit"));
  }
  function renderNodes() {
    nodeLayer.replaceChildren(); nodes.clear();
    for (const { object, unattached } of ordered) {
      if (unattached && !visible(object)) continue;
      const node = el("article", "", "plan-map-node"); node.dataset.planGraphNode = object.id; node.dataset.unattached = String(unattached);
      const point = state.positions[object.id]; node.style.left = `${point.x}px`; node.style.top = `${point.y}px`;
      const items = activeItems(object.id), selected = state.selected === object.id || items.some(o => o.id === state.selected);
      node.dataset.selected = String(selected); node.dataset.outsideScope = String(!!options.scope && !object.planning!.scopes.includes(options.scope));
      const head = el("div", "", "plan-map-node-head"), handle = button("⠿", () => {}, "drag"); handle.title = t("moveNode"); handle.setAttribute("aria-label", `${t("moveNode")} ${object.name}`);
      handle.addEventListener("pointerdown", event => startDrag(event, object.id));
      handle.addEventListener("keydown", event => {
        const delta = ({ ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] } as Record<string, number[]>)[event.key];
        if (delta) { event.preventDefault(); const position = state.positions[object.id]; position.x += delta[0]; position.y += delta[1]; node.style.left = `${position.x}px`; node.style.top = `${position.y}px`; drawEdges(); persist(); }
      });
      const title = button(object.name, () => select(object.id), "select-node"); title.className = "plan-map-node-title";
      head.append(handle, title); node.append(head, el("small", `${unattached ? t("unattached") : t(object.kind as PlanningKind)} · ${object.planning!.scopes.join(" / ")}`, "plan-map-node-meta"));
      if (object.planning!.body) node.append(el("p", object.planning!.body, "plan-map-node-summary"));
      if (unattached && effectiveText(object)) node.append(el("p", effectiveText(object), "plan-map-effective"));
      if (items.length) {
        const overlays = el("div", "", "plan-map-overlays");
        for (const item of items.slice(0, 5)) {
          const chip = button("", () => select(item.id)); chip.className = "plan-map-overlay"; chip.dataset.overlayObject = item.id; chip.dataset.kind = item.kind;
          chip.dataset.selected = String(state.selected === item.id);
          chip.append(el("small", `${item.planning!.scopes.join("/")} · ${t(item.kind as PlanningKind)}`), el("strong", item.name));
          const value = effectiveText(item); if (value) { chip.append(el("span", value)); chip.title = `${item.name}\n${value}`; } overlays.append(chip);
        }
        if (items.length > 5) overlays.append(button(`${t("moreAtNode")} · ${items.length}`, () => select(object.id), "more"));
        node.append(overlays);
      } else if (!unattached && MAP_LAYERS.some(k => state.layers[k])) node.append(el("small", t("noOverlayHere"), "plan-map-node-empty"));
      nodeLayer.append(node); nodes.set(object.id, node);
    }
  }
  function drawEdges() {
    lines.replaceChildren(); edgeLabels.replaceChildren();
    const definitions = svg("defs"), marker = svg("marker"), arrow = svg("path");
    marker.id = "planning-map-arrow"; marker.setAttribute("viewBox", "0 0 10 10"); marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5"); marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7"); marker.setAttribute("orient", "auto-start-reverse");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); arrow.setAttribute("fill", "currentColor"); marker.append(arrow); definitions.append(marker); lines.append(definitions);
    const groups = new Map<string, MapConnection[]>();
    for (const connection of model.connections) {
      if (!visible(connection.source) || !visible(connection.target) || !nodes.has(connection.from) || !nodes.has(connection.to)) continue;
      const groupKey = `${connection.from}\u0000${connection.to}\u0000${connection.link.relation}`; const group = groups.get(groupKey) || []; group.push(connection); groups.set(groupKey, group);
    }
    const pairIndices = new Map<string, number>();
    for (const group of groups.values()) {
      const first = group[0], reverse = first.link.relation === "follows", from = state.positions[reverse ? first.to : first.from], to = state.positions[reverse ? first.from : first.to];
      const pair = [first.from, first.to].sort().join("/"), index = pairIndices.get(pair) || 0; pairIndices.set(pair, index + 1);
      const forward = to.x >= from.x, sx = from.x + (forward ? 304 : 0), sy = from.y + 44, tx = to.x + (forward ? 0 : 304), ty = to.y + 44;
      const bend = Math.max(65, Math.abs(tx - sx) * .45), offset = index * 65;
      const path = svg("path"); path.setAttribute("d", `M ${sx} ${sy} C ${sx + (forward ? bend : -bend)} ${sy - offset}, ${tx + (forward ? -bend : bend)} ${ty - offset}, ${tx} ${ty}`);
      path.setAttribute("marker-end", "url(#planning-map-arrow)"); path.dataset.mapEdge = `${first.source.id}:${first.target.id}`;
      path.dataset.active = String(group.some(c => c.source.id === state.selected || c.target.id === state.selected || c.from === state.selected || c.to === state.selected));
      path.dataset.overlay = String(group.some(c => c.source.id !== c.from || c.target.id !== c.to)); lines.append(path);
      const projected = first.source.id !== first.from || first.target.id !== first.to;
      const label = button(`${projected ? `${first.source.name} · ` : ""}${reverse ? t("flowOrder") : t(first.link.relation)}${group.length > 1 ? ` · ${group.length}` : ""}`, () => { select(first.source.id); renderInspector(group); });
      label.className = "plan-map-edge-label"; label.style.left = `${(sx + tx) / 2}px`; label.style.top = `${(sy + ty) / 2 - offset * .75 - 14}px`;
      label.title = group.map(c => `${c.source.name} · ${t(c.link.relation)} · ${c.target.name}`).join("\n"); edgeLabels.append(label);
    }
  }
  function renderInspector(connectionGroup?: MapConnection[]) {
    inspector.replaceChildren(); const selected = model.objects.find(o => o.id === state.selected);
    inspector.hidden = !selected; body.dataset.inspecting = String(!!selected); if (!selected) return;
    const head = el("header"); head.append(el("h3", selected.name), button("×", () => select(undefined), "close-inspector")); inspector.append(head);
    inspector.append(el("small", `${t(selected.kind as PlanningKind)} · ${selected.planning!.scopes.join(" / ")} · ${example ? t("exampleBadge") : t(selected.planning!.locked ? "locked" : "unlocked")}`));
    if (example) inspector.append(el("p", t("exampleHelp"), "plan-map-example-note"));
    else {
      const actions = el("div", "", "plan-map-inspector-actions");
      actions.append(button(ct("read"), () => options.open(selected), "open"), button(t(selected.planning!.locked ? "unlockEdit" : "edit"), () => options.edit(selected), "edit")); inspector.append(actions);
    }
    const paragraph = (title: string, text: string) => { const box = el("section"); box.append(el("h4", title), el("p", text || t("undecided"))); inspector.append(box); };
    if (selected.kind === "content") inspector.append(renderContentBody(selected));
    else if (selected.planning!.body) paragraph(t("body"), selected.planning!.body);
    const fields = selected.planning!;
    if (fields.rule) for (const key of ["trigger", "condition", "effect"] as const) paragraph(t(key), fields.rule[key]);
    if (fields.hook) for (const key of ["cue", "action", "payoff", "continuation"] as const) paragraph(t(key), fields.hook[key]);
    if (fields.parameter) paragraph(t("sharedValue"), `${fields.parameter.value || t("undecided")} ${fields.parameter.unit}\n${t("limits")}: ${fields.parameter.min || "—"} … ${fields.parameter.max || "—"}`);
    for (const link of fields.links) {
      const target = model.objects.find(o => o.id === link.target_id); if (!target) continue;
      const row = el("section", "", "plan-map-inspector-link"); row.append(el("small", t(link.relation)), button(target.name, () => select(target.id)));
      if (link.note) row.append(el("p", link.note));
      if (target.planning?.parameter && link.relation === "uses") row.append(el("p", `${t("sharedValue")}: ${target.planning.parameter.value || t("undecided")} ${target.planning.parameter.unit}`),
        el("p", link.local ? `${t("localValue")}: ${link.local.value} · ${link.local.reason}` : t("inherited")));
      inspector.append(row);
    }
    if (connectionGroup) { paragraph(t("connectionProvenance"), connectionGroup.map(c => `${c.source.name} → ${t(c.link.relation)} → ${c.target.name}${c.link.note ? `\n${c.link.note}` : ""}`).join("\n\n")); }
    const active = activeItems(selected.id);
    if (active.length) {
      const box = el("section"); box.append(el("h4", `${t("overlaysAtNode")} · ${active.length}`));
      for (const item of active) box.append(button(`${t(item.kind as PlanningKind)} · ${item.name}`, () => select(item.id))); inspector.append(box);
    }
    const hosts = model.hosts.get(selected.id) || [];
    if (hosts.some(id => id !== selected.id)) {
      const box = el("section"); box.append(el("h4", t("attachedAt")));
      for (const id of hosts) { const host = model.objects.find(o => o.id === id); if (host) box.append(button(host.name, () => { select(host.id); moveTo(host.id); })); } inspector.append(box);
    }
    const impact = planningImpact(model.objects, selected.id);
    if (impact.length) { const box = el("section"); box.append(el("h4", t("impact"))); for (const {object, depth} of impact) box.append(button(`${t(depth === 1 ? "direct" : "indirect")} · ${object.name}`, () => select(object.id))); inspector.append(box); }
    if (!example) {
      if (selected.kind === "system" || selected.kind === "flow") { const box = el("section"); box.append(el("h4", t("addAtNode"))); for (const kind of MAP_LAYERS) box.append(add(kind, selected)); inspector.append(box); }
      inspector.append(button(t("editConnections"), () => options.edit(selected, true), "connections"));
    }
  }
  let drag: { pointer: number; id?: string; start: MapPoint; origin: MapPoint; target: HTMLElement } | undefined;
  function startDrag(event: PointerEvent, id?: string) {
    if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget as HTMLElement, position = id ? state.positions[id] : camera();
    drag = { pointer: event.pointerId, id, start: { x: event.clientX, y: event.clientY }, origin: { x: position.x, y: position.y }, target };
    target.setPointerCapture(event.pointerId);
  }
  stage.addEventListener("pointerdown", event => { if (!(event.target as Element).closest("button,article")) startDrag(event); });
  stage.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const scale = drag.id ? camera().zoom : 1, x = drag.origin.x + (event.clientX - drag.start.x) / scale, y = drag.origin.y + (event.clientY - drag.start.y) / scale;
    if (drag.id) { state.positions[drag.id] = { x, y }; const node = nodes.get(drag.id)!; node.style.left = `${x}px`; node.style.top = `${y}px`; drawEdges(); }
    else { state.camera = { ...camera(), x, y }; updateCamera(); }
  });
  const endDrag = (event: PointerEvent) => { if (drag?.pointer === event.pointerId) { if (drag.target.hasPointerCapture(event.pointerId)) drag.target.releasePointerCapture(event.pointerId); drag = undefined; persist(); } };
  stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("wheel", event => {
    if (event.defaultPrevented || !Number.isFinite(event.deltaY) || !event.deltaY) return;
    event.preventDefault(); event.stopPropagation();
    if (drag) return;
    const rect = stage.getBoundingClientRect();
    wheelIntent = { x: event.clientX - rect.left, y: event.clientY - rect.top, deltaY: event.deltaY };
    if (wheelFrame) return;
    // Match Canvas: a bounded zoom step per frame, anchored under the pointer.
    // Ctrl/Meta remain compatible aliases; content beside the stage owns its scrolling.
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0; const intent = wheelIntent; wheelIntent = undefined;
      if (disposed || !intent) return;
      const current = camera().zoom, next = wheelScale(current, intent.deltaY, { min: .25, max: 2 });
      zoom(next / current, intent.x, intent.y);
    });
  }, { passive: false });
  stage.addEventListener("keydown", event => { if (event.target === stage && event.key.toLowerCase() === "f") { event.preventDefault(); fit(); } });
  root.addEventListener("keydown", event => { if (event.key === "Escape" && state.selected) { event.preventDefault(); event.stopPropagation(); select(undefined); } });
  renderControls(); renderNodes(); renderInspector(); drawEdges(); updateCamera();
  const observer = new ResizeObserver(() => { if (!state.camera && !disposed) fit(); }); observer.observe(stage);
  frame = requestAnimationFrame(() => { if (!disposed && !state.camera) fit(); });
  return { element: root, dispose() { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(wheelFrame); wheelIntent = undefined; } };
}
