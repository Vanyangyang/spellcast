import type { DevelopmentObject } from "./project-record-api";
import type { AnchoredDesign, FlowAnchor } from "./project-planning-model";
import { designKindNames, phaseNames } from "./game-flow-model";
import { flowEl as el, flowButton as button } from "./game-flow-ui";
import { renderContentBody } from "./project-content";

/** Designs are owned by their own objects; the flow only displays and locates them. */
export function designLabel({ object, anchor }: AnchoredDesign): string {
  return `${designKindNames[object.kind] || object.kind}「${object.name}」${anchor.phase ? ` · ${phaseNames[anchor.phase]}` : ""}${anchor.note ? ` · ${anchor.note}` : ""} · 版本 ${object.revision}${object.archived ? " · 已归档" : ""}`;
}

export function renderAnchoredDesigns(title: string, designs: AnchoredDesign[], open?: (object: DevelopmentObject, anchor: FlowAnchor) => void, empty = ""): HTMLElement {
  const box = el("section", "", "flow-designs"); box.dataset.flowDesigns = "true";
  box.append(el("h4", `${title}${designs.length ? ` · ${designs.length}` : ""}`));
  if (!designs.length) { if (empty) box.append(el("small", empty)); return box; }
  const list = el("ul");
  for (const design of designs) {
    const item = el("li"); item.dataset.designId = design.object.id;
    item.append(el("span", designLabel(design)));
    if (open) { const go = button("打开对象", "open-design", () => open(design.object, design.anchor)); go.dataset.designId = design.object.id; item.append(go); }
    if (design.object.kind === "content" && design.object.planning) item.append(renderContentBody(design.object));
    list.append(item);
  }
  box.append(list);
  return box;
}

export function anchorMarks(objects: DevelopmentObject[], flowId: string): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const object of objects) if (!object.archived) for (const anchor of object.planning?.anchors || []) if (anchor.flow_id === flowId) marks[anchor.step_id] = (marks[anchor.step_id] || 0) + 1;
  return marks;
}
