import type { DevelopmentObject } from "./project-record-api";
import { emptyPlanning, type PlanningLink } from "./project-planning-model";

export const MAP_LAYERS = ["rule", "parameter", "content", "hook"] as const;
export type MapLayer = typeof MAP_LAYERS[number];
export type MapPoint = { x: number; y: number };
export type MapConnection = { source: DevelopmentObject; target: DevelopmentObject; link: PlanningLink; from: string; to: string };
export type MapNode = { object: DevelopmentObject; items: DevelopmentObject[]; unattached: boolean };

/** All placements use the full saved graph, independent of the currently visible layers. */
export function planningMapModel(input: DevelopmentObject[]) {
  const objects = input.filter(o => o.planning && !o.archived);
  const byId = new Map(objects.map(o => [o.id, o]));
  const base = objects.filter(o => o.kind === "system" || o.kind === "flow");
  const baseIds = new Set(base.map(o => o.id));
  const hosts = new Map<string, string[]>();
  for (const object of objects) {
    const found = new Set<string>(), seen = new Set<string>(), queue = [object.id];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]; if (seen.has(id)) continue; seen.add(id);
      if (baseIds.has(id)) { found.add(id); continue; }
      const links = byId.get(id)?.planning?.links || [];
      // Explicit membership wins. Otherwise follow actual uses references to the skeleton.
      const membership = links.filter(link => link.relation === "belongs_to");
      for (const link of membership.length ? membership : links.filter(link => link.relation === "uses")) {
        if (byId.has(link.target_id)) queue.push(link.target_id);
      }
    }
    hosts.set(object.id, [...found].sort());
  }
  const nodes: MapNode[] = base.map(object => ({ object, unattached: false, items: objects.filter(o => o.id !== object.id && hosts.get(o.id)?.includes(object.id)) }));
  for (const object of objects.filter(o => !hosts.get(o.id)?.length)) {
    nodes.push({ object, unattached: true, items: [] }); hosts.set(object.id, [object.id]);
  }
  const connections: MapConnection[] = [];
  for (const source of objects) for (const link of source.planning!.links) {
    const target = byId.get(link.target_id); if (!target) continue;
    for (const from of hosts.get(source.id) || []) for (const to of hosts.get(target.id) || []) {
      if (from !== to) connections.push({ source, target, link, from, to });
    }
  }
  return { objects, nodes, connections, hosts };
}

/** Labelled, in-memory teaching example. Never sent to the project API or used as real design. */
export function planningMapExample(names: string[]): DevelopmentObject[] {
  const make = (id: string, name: string, kind: string, scopes = ["R0", "R1", "R2"]) => ({
    id: `example-${id}`, name, kind, project_id: "example-only", revision: 0, archived: false, planning: emptyPlanning(kind, scopes),
  });
  const exploration = make("exploration", names[0], "system"), encounter = make("encounter", names[1], "system"), settlement = make("settlement", names[2], "system");
  encounter.planning.links.push({ target_id: exploration.id, relation: "follows", note: "" });
  settlement.planning.links.push({ target_id: encounter.id, relation: "follows", note: "" });
  const content = make("content", names[3], "content", ["R0"]), hook = make("hook", names[4], "hook", ["R0"]);
  const parameter = make("parameter", names[5], "parameter"); parameter.planning.parameter!.value = "10";
  const rule = make("rule", names[6], "rule");
  for (const [object, parent] of [[content, encounter], [hook, exploration], [parameter, settlement], [rule, encounter]]) object.planning.links.push({ target_id: parent.id, relation: "belongs_to", note: "" });
  content.planning.links.push({ target_id: parameter.id, relation: "uses", note: "", local: { value: "5", reason: names[7] } });
  return [exploration, encounter, settlement, content, hook, parameter, rule];
}
