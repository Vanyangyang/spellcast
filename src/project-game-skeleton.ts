import type { GameSkeleton, SkeletonNode } from "./project-game-skeleton-model";
import type { GameDocument } from "./project-game-home-api";
import { gs } from "./i18n/game-skeleton";
import "./project-game-skeleton.css";
import "./project-game-skeleton-list.css";

type Options = {
  skeleton: GameSkeleton;
  documents: readonly GameDocument[];
  selectedId: string;
  query: string;
  onSelect(id: string): void;
  onQuery(query: string): void;
  onDiscuss(id: string, intent: "develop" | "question"): void;
  onSource(path: string): void;
  mode?: "canvas";
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", value = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
};
const button = (label: string, action: () => void, className = "") => {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};
const kindLabel = (node: SkeletonNode) => gs(node.kind);
const stateLabel = (node: SkeletonNode) => gs(node.state);
const searchable = (node: SkeletonNode) => [node.title, node.summary, ...(node.notes || []), ...(node.steps?.flatMap(step => [step.title, step.text]) || []), ...Object.values(node.rule || {}).flat()].join(" ").toLocaleLowerCase();
function appendPagedNodes(host: HTMLElement, nodes: SkeletonNode[], make: (node: SkeletonNode) => HTMLElement, revealId = "") {
  const pageSize = 24; let shown = 0;
  const revealIndex = nodes.findIndex(node => node.id === revealId);
  const firstPage = revealIndex < 0 ? pageSize : Math.ceil((revealIndex + 1) / pageSize) * pageSize;
  const more = button("", () => appendNext(), "gs-more");
  function appendNext() {
    more.remove();
    const end = Math.min(nodes.length, shown ? shown + pageSize : firstPage);
    for (; shown < end; shown++) host.append(make(nodes[shown]));
    if (shown < nodes.length) { more.textContent = gs("moreChildren", { count: Math.min(pageSize, nodes.length - shown) }); host.append(more); }
  }
  appendNext();
}

export function renderGameSkeleton(options: Options): { map: HTMLElement; detail: HTMLElement; navigation?: HTMLElement; search?: HTMLElement } {
  const canvas = options.mode === "canvas";
  const { model } = options.skeleton;
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const children = new Map<string, SkeletonNode[]>();
  for (const node of model.nodes) if (node.parent_id && byId.has(node.parent_id)) {
    const list = children.get(node.parent_id) || [];
    list.push(node);
    children.set(node.parent_id, list);
  }
  const ancestors = (node: SkeletonNode): SkeletonNode[] => {
    const path: SkeletonNode[] = [];
    const seen = new Set([node.id]);
    let parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    while (parent && !seen.has(parent.id)) {
      path.unshift(parent);
      seen.add(parent.id);
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    return path;
  };
  const rootOf = (id: string) => {
    const node = byId.get(id);
    return node && [...ancestors(node), node].find(item => item.kind === "system" && !item.parent_id);
  };
  const selected = byId.get(options.selectedId);
  const group = canvas && selected
    ? (children.get(selected.id)?.length ? selected : selected.parent_id ? byId.get(selected.parent_id) : undefined)
    : undefined;
  const documents = new Map(options.documents.map(document => [document.path, document]));
  const evidenceState = (evidence: NonNullable<SkeletonNode["provenance"]>[number]) => {
    if (evidence.archived) return "archived";
    const document = documents.get(evidence.path);
    if (!document || document.error || !document.hash) return "unavailable";
    return document.hash.toLowerCase() === evidence.hash.toLowerCase() ? "matched" : "changed";
  };
  const selectedRoot = selected && rootOf(selected.id);
  const rootNodes = model.nodes.filter(node => node.kind === "system" && !node.parent_id);
  const rank = new Map(model.entry_ids.map((id, index) => [id, index]));
  rootNodes.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  const rootEntries = model.nodes.filter(node => !node.parent_id || !byId.has(node.parent_id));
  rootEntries.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  const navigate = (node: SkeletonNode) => options.onSelect(node.id);

  const map = el("section", "gs-map");
  map.dataset.gameSkeleton = "map";
  map.dataset.selected = String(!!selected);
  const mapHeader = el("header", "gs-map-header");
  const mapHeading = el("div", "gs-map-heading");
  mapHeading.append(el("h2", "gs-heading", gs("mapTitle")), el("p", "gs-intro", gs("mapIntro")));
  mapHeader.append(mapHeading);

  const search = el("div", "gs-search");
  const label = el("label", "gs-search-label", gs("searchLabel"));
  const input = el("input", "gs-search-input");
  const searchId = `gs-search-${Math.random().toString(36).slice(2)}`;
  input.id = searchId;
  input.type = "search";
  input.autocomplete = "off";
  input.placeholder = gs("searchPlaceholder");
  input.value = options.query;
  label.htmlFor = searchId;
  const clear = button(gs("clearSearch"), () => { input.value = ""; filterResults(); input.focus(); }, "gs-search-clear");
  search.append(label, input, clear);
  const resultArea = el("section", "gs-search-results");
  resultArea.setAttribute("aria-label", gs("searchResults"));
  const resultCount = el("p", "gs-result-count");
  resultCount.setAttribute("role", "status");
  const resultList = el("div", "gs-result-list");
  const resultEmpty = el("p", "gs-empty", gs("searchEmpty"));
  const indexedResults = model.nodes.map(node => {
    const item = button("", () => navigate(node), "gs-result");
    item.dataset.gsNodeId = node.id;
    item.setAttribute("aria-pressed", String(selected?.id === node.id));
    const resultPath = ancestors(node).map(ancestor => ancestor.title).join(" › ");
    item.append(el("strong", "", node.title), el("span", "", canvas ? (resultPath || gs("root")) : `${kindLabel(node)} · ${stateLabel(node)}`));
    resultList.append(item);
    return { item, searchText: searchable(node) };
  });
  resultArea.append(resultCount, resultList, resultEmpty);
  search.append(resultArea);
  if (!canvas) {
    mapHeader.append(search);
    map.append(mapHeader);
  }

  function filterResults() {
    const query = input.value.trim().toLocaleLowerCase();
    options.onQuery(input.value);
    resultArea.hidden = !query;
    clear.hidden = !input.value;
    if (!query) return;
    let count = 0;
    for (const { item, searchText } of indexedResults) {
      const shown = searchText.includes(query);
      item.hidden = !shown;
      if (shown) count++;
    }
    resultCount.textContent = gs("searchCount", { count });
    resultEmpty.hidden = count !== 0;
  }
  input.addEventListener("input", filterResults);
  // Filtering the initial query should not cause a state write back to the parent.
  const initialQuery = input.value;
  if (initialQuery) {
    const query = initialQuery.trim().toLocaleLowerCase();
    let count = 0;
    for (const { item, searchText } of indexedResults) {
      item.hidden = !searchText.includes(query);
      if (!item.hidden) count++;
    }
    resultCount.textContent = gs("searchCount", { count });
    resultEmpty.hidden = count !== 0;
  }
  resultArea.hidden = !initialQuery.trim();
  clear.hidden = !initialQuery;

  const loop = el("section", "gs-loop");
  loop.append(el("h3", "gs-section-heading", gs("loopTitle")));
  const stages = el("ol", "gs-stages");
  for (const stage of model.loop) {
    const stageItem = el("li", "gs-stage");
    stageItem.append(el("strong", "gs-stage-title", stage.title), el("p", "", stage.summary));
    const linked = [...new Map(stage.node_ids.map(rootOf).filter((node): node is SkeletonNode => !!node).map(node => [node.id, node])).values()];
    if (linked.length) {
      const links = el("div", "gs-stage-links");
      links.setAttribute("aria-label", gs("relatedSystems"));
      for (const node of linked) {
        const link = button(node.title, () => navigate(node), "gs-stage-link");
        link.setAttribute("aria-pressed", String(selectedRoot?.id === node.id));
        links.append(link);
      }
      stageItem.append(links);
    }
    stages.append(stageItem);
  }
  loop.append(stages);
  if (!canvas || !group) map.append(loop);

  const systems = el("section", "gs-systems");
  const systemsHead = el("div", "gs-section-head");
  systemsHead.append(el("h3", "gs-section-heading", gs("systemsTitle")), el("p", "", gs("systemsHelp")));
  systems.append(systemsHead);
  const grid = el("div", "gs-system-grid");
  for (const node of rootNodes) {
    const card = button("", () => navigate(node), "gs-system-card");
    card.dataset.gsNodeId = node.id;
    card.setAttribute("aria-pressed", String(selectedRoot?.id === node.id));
    card.append(el("strong", "gs-card-title", node.title), el("span", "gs-card-summary", node.summary));
    const footer = el("span", "gs-card-footer");
    footer.append(el("span", "gs-state", stateLabel(node)), el("span", "", gs("childCount", { count: children.get(node.id)?.length || 0 })));
    card.append(footer);
    grid.append(card);
  }
  systems.append(grid);
  if (!canvas) map.append(systems);

  let navigation: HTMLElement | undefined;
  if (canvas) {
    const crumbs = el("nav", "gs-crumbs");
    crumbs.setAttribute("aria-label", gs("root"));
    crumbs.append(button(gs("root"), () => options.onSelect("")));
    if (group) {
      for (const ancestor of ancestors(group)) {
        crumbs.append(el("span", "gs-crumb-separator", "›"), button(ancestor.title, () => navigate(ancestor)));
      }
      const current = el("span", "gs-crumb-current", group.title);
      current.setAttribute("aria-current", "location");
      crumbs.append(el("span", "gs-crumb-separator", "›"), current);
    }
    navigation = crumbs;

    const groupHeader = el("div", "gs-group-header");
    groupHeader.dataset.gsGroupId = group?.id || "";
    const groupTitle = button(group?.title || gs("root"), () => options.onSelect(group?.id || ""), "gs-group-title");
    groupTitle.dataset.gsNodeId = group?.id || "";
    groupTitle.setAttribute("aria-pressed", String(group ? selected?.id === group.id : !options.selectedId));
    const currentChildren = group ? children.get(group.id) || [] : rootEntries;
    const unresolved = currentChildren.filter(node => node.state === "needs_reconciliation").length;
    const metrics = el("span", "gs-group-count", gs("groupDirectCount", { count: currentChildren.length }));
    groupHeader.append(groupTitle, metrics);
    if (unresolved) groupHeader.append(el("span", "gs-group-needs-reconciliation", gs("groupDirectUnresolved", { count: unresolved })));
    map.append(groupHeader);

    const list = el("div", "gs-node-list");
    appendPagedNodes(list, currentChildren, node => {
      const entry = el("div", "gs-node-entry");
      entry.dataset.gsNodeId = node.id;
      const row = button("", () => navigate(node), `gs-node-row ${group ? "gs-branch-card" : "gs-system-card"}`);
      row.dataset.gsNodeId = node.id;
      row.setAttribute("aria-pressed", String(selected?.id === node.id));
      row.append(el("strong", "gs-card-title", node.title), el("span", "gs-card-summary", node.summary));
      const footer = el("span", "gs-card-footer");
      if (node.state === "needs_reconciliation") footer.append(el("span", "gs-state gs-needs-reconciliation", stateLabel(node)));
      if (node.state === "structure_only") footer.append(el("span", "gs-state gs-structure-only", stateLabel(node)));
      const childCount = children.get(node.id)?.length || 0;
      if (childCount) footer.append(el("span", "gs-child-count", gs("rowChildCount", { count: childCount })));
      if (footer.childElementCount) row.append(footer);
      entry.append(row);
      return entry;
    }, selected?.id);
    map.append(list);
  }

  if (selected && !canvas) {
    const branch = el("section", "gs-branch");
    const crumbs = el("nav", "gs-crumbs");
    crumbs.setAttribute("aria-label", gs("root"));
    crumbs.append(button(gs("root"), () => options.onSelect("")));
    for (const ancestor of ancestors(selected)) {
      crumbs.append(el("span", "gs-crumb-separator", "›"), button(ancestor.title, () => navigate(ancestor)));
    }
    const currentCrumb = el("span", "gs-crumb-current", selected.title);
    currentCrumb.setAttribute("aria-current", "location");
    crumbs.append(el("span", "gs-crumb-separator", "›"), currentCrumb);
    branch.append(crumbs, el("h3", "gs-section-heading", gs("branchTitle")), el("p", "gs-branch-help", gs("branchHelp")));
    const childNodes = children.get(selected.id) || [];
    if (childNodes.length) {
      const branchGrid = el("div", "gs-branch-grid");
      appendPagedNodes(branchGrid, childNodes, node => {
        const item = button("", () => navigate(node), "gs-branch-card");
        item.dataset.gsNodeId = node.id;
        item.append(el("small", "gs-kind", kindLabel(node)), el("strong", "", node.title), el("span", "", node.summary));
        return item;
      });
      branch.append(branchGrid);
    } else branch.append(el("p", "gs-empty", gs("branchEmpty")));
    map.insertBefore(branch, loop);
  }

  const detail = el("section", "gs-detail");
  detail.dataset.gameSkeleton = "detail";
  if (!selected) {
    detail.append(el("h2", "gs-detail-title", canvas ? gs("root") : gs("detailStartTitle")), el("p", "gs-detail-lead", canvas ? model.description : gs("detailStart")));
    return canvas ? { map, detail, navigation, search } : { map, detail };
  }
  const header = el("header", "gs-detail-header");
  if (!canvas) header.append(el("span", "gs-kind", kindLabel(selected)));
  header.append(el("h2", "gs-detail-title", selected.title));
  header.append(el("span", `gs-state${selected.state === "needs_reconciliation" ? " gs-needs-reconciliation" : ""}`, stateLabel(selected)));
  detail.append(header);
  const actions = el("div", "gs-actions");
  actions.append(button(gs("develop"), () => options.onDiscuss(selected.id, "develop"), "gs-develop"), button(gs("question"), () => options.onDiscuss(selected.id, "question")));
  if (canvas) detail.append(actions, el("p", "gs-detail-lead", selected.summary));
  const changedSources = new Set((selected.provenance || []).filter(evidence => ["changed", "unavailable"].includes(evidenceState(evidence))).map(evidence => evidence.path));
  if (changedSources.size) {
    const warning = el("div", "gs-evidence-alert"); warning.dataset.gsEvidenceAlert = "true"; warning.setAttribute("role", "status");
    warning.append(el("strong", "", gs("sourceChanges", { count: changedSources.size })), el("p", "", gs("sourceChangesHelp")));
    const reveal = button(gs("inspectChanges"), () => {
      const evidence = detail.querySelector<HTMLDetailsElement>(".gs-sources");
      if (evidence) { evidence.open = true; evidence.querySelector<HTMLElement>("summary")?.focus(); }
    });
    warning.append(reveal); detail.append(warning);
  }
  if (!canvas) {
    const purpose = el("section", "gs-detail-section");
    purpose.append(el("h3", "", gs("purpose")), el("p", "gs-detail-prose", selected.summary));
    detail.append(purpose);
  }
  if (!canvas) detail.append(actions);
  const ruleFields = (canvas
    ? [["conflicts", "ruleConflicts"], ["trigger", "ruleTrigger"], ["conditions", "ruleConditions"], ["effects", "ruleEffects"], ["exceptions", "ruleExceptions"], ["formulas", "ruleFormulas"]]
    : [["trigger", "ruleTrigger"], ["conditions", "ruleConditions"], ["effects", "ruleEffects"], ["exceptions", "ruleExceptions"], ["formulas", "ruleFormulas"], ["conflicts", "ruleConflicts"]]) as Array<readonly [keyof NonNullable<SkeletonNode["rule"]>, "ruleTrigger" | "ruleConditions" | "ruleEffects" | "ruleExceptions" | "ruleFormulas" | "ruleConflicts"]>;
  for (const [field, label] of ruleFields) {
    const values = selected.rule?.[field]; if (!values?.length) continue;
    const group = el("section", "gs-detail-section gs-rule-section"); group.dataset.gsRule = field;
    group.append(el("h3", "", gs(label)));
    if (field === "formulas") {
      for (const value of values) { const formula = el("pre", "gs-formula"); formula.append(el("code", "", value)); group.append(formula); }
    } else { const list = el("ul", "gs-notes"); for (const value of values) list.append(el("li", "", value)); group.append(list); }
    detail.append(group);
  }
  if (selected.notes?.length) {
    const notes = el("section", "gs-detail-section");
    notes.append(el("h3", "", gs("contents")));
    const list = el("ul", "gs-notes");
    for (const note of selected.notes) list.append(el("li", "", note));
    notes.append(list);
    detail.append(notes);
  }
  if (selected.steps?.length) {
    const steps = el("section", "gs-detail-section");
    steps.append(el("h3", "", gs("steps")));
    const list = el("ol", "gs-steps");
    for (const step of selected.steps) {
      const item = el("li");
      item.append(el("strong", "", step.title), el("p", "", step.text));
      list.append(item);
    }
    steps.append(list);
    detail.append(steps);
  }
  const directChildren = children.get(selected.id) || [];
  if (directChildren.length && !canvas) {
    const next = el("section", "gs-detail-section");
    next.append(el("h3", "", gs("children")));
    const links = el("div", "gs-detail-links");
    appendPagedNodes(links, directChildren, node => button(node.title, () => navigate(node)));
    next.append(links);
    detail.append(next);
  }
  const relations = model.relations.flatMap(relation => {
    const otherId = relation.from === selected.id ? relation.to : relation.to === selected.id ? relation.from : "";
    const other = byId.get(otherId);
    return other ? [{ node: other, label: relation.label }] : [];
  });
  if (relations.length || !canvas) {
    const connected = el("section", "gs-detail-section");
    connected.append(el("h3", "", gs("connections")));
    if (relations.length) {
      const links = el("div", "gs-relation-list");
      for (const relation of relations) {
        const link = button("", () => navigate(relation.node), "gs-relation");
        link.append(el("small", "", relation.label), el("strong", "", relation.node.title));
        links.append(link);
      }
      connected.append(links);
    } else connected.append(el("p", "gs-empty", gs("connectionEmpty")));
    detail.append(connected);
  }

  if (selected.sources.length || selected.provenance?.length) {
    const sources = el("details", "gs-sources");
    sources.dataset.gsDisclosure = "evidence";
    sources.append(el("summary", "", gs("basis")));
    for (const evidence of selected.provenance || []) {
      const reference = el("article", "gs-provenance");
      const state = evidenceState(evidence); reference.dataset.gsEvidenceState = state;
      reference.append(el("strong", "gs-evidence-label", gs(state === "archived" ? "archivedEvidence" : state === "changed" ? "sourceChanged" : state === "unavailable" ? "sourceUnavailable" : "currentEvidence")));
      reference.append(el("blockquote", "", evidence.quote));
      const metadata = el("details", "gs-source-metadata"); metadata.append(el("summary", "", gs("sourceDetails")));
      metadata.dataset.gsDisclosure = `${evidence.path}:${evidence.hash}:${evidence.start_line}-${evidence.end_line}`;
      metadata.append(el("small", "", `${evidence.path} · L${evidence.start_line}–${evidence.end_line}`));
      metadata.append(el("small", "gs-evidence-hash", `${gs("quotedVersion")} · SHA-256 ${evidence.hash}`));
      const document = documents.get(evidence.path);
      if (state === "changed") metadata.append(el("small", "gs-evidence-hash", `${gs("currentVersion")} · SHA-256 ${document!.hash}`));
      if (!evidence.archived && document && !document.error) metadata.append(button(gs("openCurrentSource"), () => options.onSource(evidence.path)));
      reference.append(metadata);
      sources.append(reference);
    }
    if (selected.sources.length) {
      const originals = el("details", "gs-original-sources"); originals.append(el("summary", "", gs("originalSources", { count: selected.sources.length })));
      originals.dataset.gsDisclosure = "originals";
      const links = el("div", "gs-source-links");
      for (const path of selected.sources) {
        const filename = path.split(/[\\/]/).at(-1) || path;
        const sourceButton = button(filename, () => options.onSource(path));
        sourceButton.disabled = !documents.has(path) || !!documents.get(path)?.error;
        sourceButton.title = sourceButton.disabled ? gs("sourceUnavailable") : gs("source", { name: path });
        links.append(sourceButton);
      }
      originals.append(links); sources.append(originals);
    }
    detail.append(sources);
  }
  return canvas ? { map, detail, navigation, search } : { map, detail };
}
