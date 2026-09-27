import { currentLocale } from "./i18n";
import { renderLightText } from "./light-text";
import { CONTENT_ROLES, type ContentRole, type ContentSection, type PlanningFields } from "./project-planning-model";
import type { DevelopmentObject, SourceReference } from "./project-record-api";
import "./project-content.css";

const words = {
  write: ["写内容", "Write content"], here: ["在这里写内容", "Write content here"], read: ["阅读此处", "Read here"],
  body: ["正文", "Content"], reason: ["理由", "Reason"], alternative: ["备选", "Alternative"], question: ["问题", "Open question"],
  edit: ["编辑这一段", "Edit section"], unlock: ["解锁并编辑这一段", "Unlock & edit section"],
  empty: ["还没有正文。可以先写下想法，之后再整理。", "No content yet. Write first, organize later."],
  help: ["先完整写下内容；需要时再添加片段或标注理由、备选、问题。支持 Markdown。", "Write the full idea first. Add sections or optional roles when useful. Markdown supported."],
  add: ["添加片段", "Add section"], up: ["上移", "Move up"], down: ["下移", "Move down"], remove: ["移除", "Remove"], undo: ["撤销移除", "Undo removal"],
  preview: ["预览", "Preview"], sources: ["来源", "Sources"], addSource: ["添加来源", "Add source"], sourceLabel: ["名称", "Label"], uri: ["路径或网址", "Path or URL"], version: ["版本 / 提交", "Version / commit"],
  convert: ["改用片段编辑…", "Switch to sections…"], convertHelp: ["下面是将保留的原文。确认后只转换为一个正文片段，不会自动拆分；保存前仍可取消编辑。", "The original text below will become one section without splitting. Cancel editing before saving to keep the saved version."],
  confirmConvert: ["保留原文并转换", "Keep text & convert"], cancel: ["取消", "Cancel"],
  related: ["此处关联的设计", "Related designs here"], relatedHelp: ["以下读取各对象的已保存版本；关联顺序不代表玩家流程顺序。", "These are saved objects. Their order does not imply a player sequence."],
  before: ["修改前", "Before"], after: ["修改后", "After"], created: ["新增", "Added"], removed: ["移除", "Removed"], changed: ["修改", "Changed"],
  moved: ["顺序已改变", "Order changed"], noTextChange: ["正文未改变；名称、关联或其他信息有更新。", "Content unchanged; other object details were updated."],
  saved: ["已保存", "Saved"], revision: ["版本", "Revision"], return: ["返回阅读位置", "Back to reading position"],
  linkedValues: ["引用的数值", "Referenced values"], shared: ["共用值", "Shared value"], local: ["局部值", "Local value"],
  noBase: ["这份旧草稿没有基准版本，无法安全自动合并。请先复制草稿，再载入最新内容进行对照。", "This older draft has no base snapshot. Copy it before loading the latest content for comparison."],
  conflictHelp: ["以下字段双方都修改了，请对照后选择。其他无冲突的修改会一起保留。", "Both versions changed these fields. Compare and choose; non-conflicting changes are preserved."],
  myChanges: ["我的草稿", "My draft"], savedChanges: ["最新保存", "Latest saved"], chooseMine: ["这些冲突字段使用我的草稿", "Use my draft for these conflicting fields"], chooseSaved: ["这些冲突字段使用最新保存", "Use latest saved for these conflicting fields"],
  mergeChanged: ["内容又有更新，请重新对照合并。", "Content changed again. Compare and merge again."],
} as const;
export type ContentWord = keyof typeof words;
export function ct(key: ContentWord): string { return words[key][currentLocale() === "zh-CN" ? 0 : 1]; }
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
function button(text: string, action: () => void, key: string) {
  const node = el("button", text); node.type = "button"; node.dataset.contentAction = key; node.addEventListener("click", action); return node;
}
function markdown(text: string) { const node = el("div", "", "content-prose"); renderLightText(node, text); return node; }
function sources(refs: SourceReference[]) {
  const box = el("details", "", "content-sources"); box.append(el("summary", `${ct("sources")} · ${refs.length}`));
  for (const ref of refs) box.append(el("p", [ref.label, ref.uri, ref.version].filter(Boolean).join(" · ")));
  return box;
}
export function renderContentBody(object: DevelopmentObject, edit?: (sectionId: string) => void): HTMLElement {
  const fields = object.planning!, root = el("div", "", "content-reader"); root.dataset.contentBody = object.id;
  const items: ContentSection[] = fields.sections ?? [{ id: "legacy-body", role: "body", text: fields.body }];
  if (!items.length) root.append(el("p", ct("empty")));
  for (const [index, item] of items.entries()) {
    const article = el("article", "", "content-section"); article.dataset.contentSection = item.id; article.dataset.contentRole = item.role;
    const head = el("header"), label = el("span", `${index + 1} · ${ct(item.role)}`, "content-role"); head.append(label);
    if (edit) head.append(button(ct(fields.locked ? "unlock" : "edit"), () => edit(item.id), "edit-section"));
    article.append(head, markdown(item.text || ct("empty")));
    if (item.references?.length) article.append(sources(item.references));
    root.append(article);
  }
  return root;
}

/** Local edits only. The caller owns draft persistence, the object lock and revision. */
export function renderContentEditor(fields: PlanningFields, changed: () => void): HTMLElement {
  const root = el("section", "", "content-editor"); root.dataset.contentEditor = "true";
  let removed: { item: ContentSection; index: number } | undefined;
  function input(text: string, value: string, update: (value: string) => void, multiline = false) {
    const wrap = el("label"), node = multiline ? el("textarea") : el("input"); wrap.append(el("span", text), node); node.value = value;
    node.addEventListener("input", () => { update(node.value); changed(); }); return { wrap, node };
  }
  function render() {
    root.replaceChildren(el("p", ct("help")));
    if (fields.sections === undefined) {
      const body = input(ct("body"), fields.body, value => { fields.body = value; }, true); body.node.dataset.planField = "body";
      const panel = el("div", "", "content-convert"); panel.hidden = true;
      root.append(body.wrap, button(ct("convert"), () => {
        panel.hidden = false; panel.replaceChildren(el("p", ct("convertHelp")), markdown(fields.body),
          button(ct("confirmConvert"), () => { fields.sections = [{ id: crypto.randomUUID(), role: "body", text: fields.body }]; fields.body = ""; changed(); render(); }, "confirm-convert"),
          button(ct("cancel"), () => { panel.hidden = true; }, "cancel-convert"));
      }, "convert"), panel); return;
    }
    for (const [index, item] of fields.sections.entries()) {
      const card = el("article", "", "content-section-editor"); card.dataset.contentSectionEditor = item.id;
      const controls = el("header"), role = el("select"); role.setAttribute("aria-label", `${index + 1} · ${ct("body")}`); role.dataset.contentRoleSelect = item.id;
      for (const key of CONTENT_ROLES) { const option = el("option", ct(key)); option.value = key; role.append(option); }
      role.value = item.role; role.addEventListener("change", () => { item.role = role.value as ContentRole; changed(); });
      const move = (delta: number) => { const rows = fields.sections!; [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]]; changed(); render(); };
      const up = button(ct("up"), () => move(-1), "up"), down = button(ct("down"), () => move(1), "down"); up.disabled = index === 0; down.disabled = index === fields.sections.length - 1;
      controls.append(el("strong", String(index + 1)), role, up, down, button(ct("remove"), () => { removed = { item, index }; fields.sections!.splice(index, 1); changed(); render(); }, "remove"));
      const text = input(ct("body"), item.text, value => { item.text = value; }, true); text.node.dataset.contentText = item.id;
      const preview = el("details"); preview.append(el("summary", ct("preview"))); preview.addEventListener("toggle", () => { if (preview.open) { preview.querySelector("div")?.remove(); preview.append(markdown(item.text)); } });
      text.node.addEventListener("input", () => { if (preview.open) { preview.querySelector("div")?.remove(); preview.append(markdown(item.text)); } });
      const refs = el("details", "", "content-sources"); refs.append(el("summary", `${ct("sources")} · ${item.references?.length || 0}`));
      for (const [i, ref] of (item.references || []).entries()) {
        const row = el("div", "", "content-source-editor");
        for (const [key, label] of [["label", "sourceLabel"], ["uri", "uri"], ["version", "version"]] as const) row.append(input(ct(label), ref[key], value => { ref[key] = value; }).wrap);
        row.append(button(ct("remove"), () => { item.references!.splice(i, 1); changed(); render(); }, "remove-source")); refs.append(row);
      }
      refs.append(button(ct("addSource"), () => { (item.references ??= []).push({ label: "", uri: "", version: "" }); changed(); render(); root.querySelector(`[data-content-section-editor="${CSS.escape(item.id)}"] .content-sources`)?.setAttribute("open", ""); }, "add-source"));
      card.append(controls, text.wrap, preview, refs); root.append(card);
    }
    const add = button(ct("add"), () => { const item = { id: crypto.randomUUID(), role: "body" as const, text: "" }; fields.sections!.push(item); changed(); render(); root.querySelector<HTMLTextAreaElement>(`[data-content-text="${CSS.escape(item.id)}"]`)?.focus(); }, "add");
    add.disabled = fields.sections.length >= 128; root.append(add);
    if (removed) root.append(button(ct("undo"), () => { fields.sections!.splice(Math.min(removed!.index, fields.sections!.length), 0, removed!.item); removed = undefined; changed(); render(); }, "undo-remove"));
  }
  render(); return root;
}

export function renderReferencedValues(object: DevelopmentObject, objects: DevelopmentObject[]): HTMLElement | undefined {
  const links = object.planning?.links.filter(link => link.relation === "uses" && objects.some(o => o.id === link.target_id && o.planning?.parameter)) || [];
  if (!links.length) return;
  const root = el("section", "", "content-values"); root.append(el("h4", ct("linkedValues")));
  for (const link of links) {
    const target = objects.find(o => o.id === link.target_id)!, parameter = target.planning!.parameter!;
    root.append(el("p", `${target.name} · ${link.local ? ct("local") : ct("shared")}: ${link.local?.value ?? (parameter.value || "—")} ${parameter.unit} · ${ct("revision")} ${target.revision}${target.archived ? " · archived" : ""}${link.local?.reason ? ` · ${link.local.reason}` : ""}`));
  }
  return root;
}

/** Compare stable section identities. Metadata-only revisions stay readable without JSON. */
export function renderContentDifference(before: PlanningFields | undefined, after: PlanningFields): HTMLElement {
  const root = el("div", "", "content-difference");
  const rows = (value?: PlanningFields): ContentSection[] => value ? value.sections ?? [{ id: "legacy-body", role: "body", text: value.body }] : [];
  const old = rows(before), next = rows(after), ids = [...new Set([...old.map(s => s.id), ...next.map(s => s.id)])];
  for (const id of ids) {
    const a = old.find(s => s.id === id), b = next.find(s => s.id === id);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const row = el("section"), title = `${ct(!a ? "created" : !b ? "removed" : "changed")} · ${ct((b || a)!.role)}`; row.append(el("h4", title));
    for (const [label, item] of [["before", a], ["after", b]] as const) if (item) {
      const pane = el("div"); pane.append(el("strong", `${ct(label)} · ${ct(item.role)}`), markdown(item.text));
      if (item.references?.length) pane.append(sources(item.references)); row.append(pane);
    }
    root.append(row);
  }
  if (before && old.map(s => s.id).join("|") !== next.map(s => s.id).join("|")) root.prepend(el("p", ct("moved")));
  if (!root.childElementCount) root.append(el("p", ct("noTextChange")));
  return root;
}
