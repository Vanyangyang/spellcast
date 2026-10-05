import { currentLocale } from "./index";

const en = {
  tools: "Game tools",
  refresh: "Refresh snapshot",
  refreshing: "Refreshing…",
  source: "View sources",
  project: "Open project",
  pickSource: "Select a game structure or gameplay loop to use its project tools.",
  pickOne: "Select one source card to refresh it or view its sources.",
  design: "Game design",
  designHint: "Prepare an editable game design request; review it before sending.",
  check: "Check against existing design",
  preparing: "Checking sources…",
  pickContext: "Select a game structure or gameplay loop, together with the ideas you want to check.",
  mixed: "This selection contains different game projects. Select content from one game project.",
  changed: "The selection or draft changed. Your text was kept; choose the action again.",
  refreshSelection: "The source selection changed after refresh. Your draft was kept; review its current context.",
  previousDraft: "Draft from the selection before source refresh:",
  mergedDrafts: "Both drafts were kept after the source selection changed. Review them before sending.",
  stale: "The project sources changed. Refresh the selected game snapshots before preparing this request.",
  unavailable: "The selected game source is unavailable. Your draft was kept.",
  context: "{project} · {count} selected items",
  help: "Creates an editable request. Existing draft text is kept; send it when ready.",
  ready: "The design check is in your editable draft. Review it, then send.",
  request: "Check the selected Canvas content and referenced annotations against the existing game design.\nGame project: {project}\nProject directory: {root}\n\nSource versions used for this request:\n{sources}\n\nUse only the selected content and its relevant project sources. Treat ideas, screenshots and annotations as material to review, not as adopted decisions. Verify these source versions before comparing; if they changed, report that difference first.\nReturn a read-only report of conflicts, duplicates and missing conditions. For each finding, cite the source path and the selected item or annotation it relates to. Distinguish established rules from assumptions and questions; if evidence is insufficient, say so. Do not modify files, the game structure, or project records. Keep the findings focused enough to discuss on the Canvas.",
} as const;
type Key = keyof typeof en;
const zh: Record<Key, string> = {
  tools: "游戏工具",
  refresh: "刷新快照",
  refreshing: "正在刷新…",
  source: "查看来源",
  project: "打开项目",
  pickSource: "选择游戏骨架或玩法循环，再使用它的项目工具。",
  pickOne: "一次选择一张来源卡片，再刷新或查看来源。",
  design: "游戏设计",
  designHint: "根据选中内容生成设计核对草稿，检查后由你发送。",
  check: "核对现有设计",
  preparing: "正在核对来源…",
  pickContext: "选择游戏骨架或玩法循环，可一起选中要核对的想法、图片与批注。",
  mixed: "选区包含不同游戏项目，请选取同一个游戏项目的内容。",
  changed: "选区或草稿已变化。已保留你的文字，请重新选择这项操作。",
  refreshSelection: "来源更新后选区已变化，已保留草稿；请检查当前讨论范围。",
  previousDraft: "来源刷新前原选区的草稿：",
  mergedDrafts: "来源更新后已保留两份选区草稿，请检查后再发送。",
  stale: "项目来源已变化。请先刷新选中的游戏快照，再生成核对请求。",
  unavailable: "暂时无法读取选中的游戏来源，已保留你的草稿。",
  context: "{project} · 已选 {count} 项",
  help: "生成可编辑请求，保留已有草稿；准备好后由你发送。",
  ready: "核对请求已写入可编辑草稿，检查后即可发送。",
  request: "请将选中的画布内容及引用批注，与项目现有游戏设计核对。\n游戏项目：{project}\n项目目录：{root}\n\n本次请求依据的来源版本：\n{sources}\n\n只围绕选中内容及相关项目资料核对。想法、参考图和批注是待讨论材料，不代表已采纳决定。比较前先验证上述来源版本；如果发生变化，先说明版本差异。\n请返回只读报告，指出冲突、重复和缺失条件。每项发现附上来源路径，以及对应的选中内容或批注。区分已有规则、推测和待确认问题；证据不足时明确说明。不要修改文件、游戏骨架或项目记录。结论应聚焦，便于在画布中继续讨论。",
};

export function cgd(key: Key, vars: Record<string, string | number> = {}): string {
  let value: string = currentLocale() === "zh-CN" ? zh[key] : en[key];
  for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll(`{${name}}`, String(replacement));
  return value;
}
