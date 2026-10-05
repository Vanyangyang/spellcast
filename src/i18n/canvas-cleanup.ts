import { currentLocale } from "./index";

const words = {
  "zh-CN": {
    title: "整理内容", close: "关闭", refresh: "重新分析", loading: "正在读取内容…",
    scope: "整理范围", view: "当前视图", selection: "已选内容", search: "搜索内容",
    suggestions: "整理建议", all: "全部内容", archive: "收起", merge: "合并",
    handled: "已处理", replied: "已回复，待确认", none: "未标记处理", exact: "重复内容", similar: "相似内容",
    locked: "已锁定", pending: "仍有待办留言", annotation: "仍有待办批注", draft: "有草稿或正在编辑",
    preview: "合并后内容", originals: "原文", details: "查看原文", empty: "没有可整理的建议",
    emptyAll: "这个范围没有内容", emptySearch: "没有匹配的内容", untitled: "无标题",
    selectHandled: "勾选已处理", selectVisible: "勾选当前列表", clear: "清空选择",
    mergeSelected: "合并勾选内容", cancelMerge: "取消合并", apply: "应用整理", applying: "正在保存…",
    count: "{n} 项内容", groupCount: "{n} 项合为 1 项", summary: "收起 {archive} 项 · 合并 {merge} 组",
    ready: "原内容保留在「已移除」中。", changed: "内容或状态已变化，请重新分析后再整理。",
    done: "已整理 {n} 项内容", undo: "撤销本次整理", undoDone: "已恢复整理前的内容",
    removed: "查看已移除", failed: "保存未确认。可重试本次操作，或重新分析。",
    retry: "重试保存", limit: "选中的内容较多，请分几次整理。", nothing: "请先勾选要整理的内容。",
    mergeUnavailable: "请选择同一任务下的 2–8 项独立文字内容；带有关系、组合或待办的内容暂不能合并。",
    undoChanged: "整理后内容已变化，无法直接撤销。仍可从「已移除」逐项恢复原文。",
    protected: "{n} 项内容暂不可收起", mergeHint: "各条不同原文均保留；完全重复的内容只出现一次。",
    archiveSection: "可收起的内容", mergeSection: "可合并的内容", inspect: "定位原内容",
  },
  en: {
    title: "Organize content", close: "Close", refresh: "Analyze again", loading: "Loading content…",
    scope: "Scope", view: "Current view", selection: "Selected content", search: "Search content",
    suggestions: "Suggestions", all: "All content", archive: "Put away", merge: "Merge",
    handled: "Handled", replied: "Replied, needs review", none: "Not marked handled", exact: "Duplicate content", similar: "Similar content",
    locked: "Locked", pending: "Open follow-up", annotation: "Open annotation", draft: "Draft or active editor",
    preview: "Merged content", originals: "Originals", details: "Read original", empty: "No suggested changes",
    emptyAll: "No content in this scope", emptySearch: "No matching content", untitled: "Untitled",
    selectHandled: "Select handled", selectVisible: "Select this list", clear: "Clear selection",
    mergeSelected: "Merge checked content", cancelMerge: "Cancel merge", apply: "Apply changes", applying: "Saving…",
    count: "{n} items", groupCount: "{n} items into 1", summary: "Put away {archive} · Merge {merge} groups",
    ready: "Original content stays in Removed items.", changed: "Content or status has changed. Analyze again before applying.",
    done: "Organized {n} items", undo: "Undo these changes", undoDone: "Original content restored",
    removed: "Open removed items", failed: "Save was not confirmed. Retry this operation or analyze again.",
    retry: "Retry save", limit: "Too much content selected. Organize it in smaller sets.", nothing: "Select content to organize first.",
    mergeUnavailable: "Choose 2–8 standalone text items from the same task, without groups, connections, or open follow-ups.",
    undoChanged: "Content has changed since organizing. Restore individual originals from Removed items.",
    protected: "{n} items cannot be put away yet", mergeHint: "Every distinct original is retained. Identical content appears once.",
    archiveSection: "Content to put away", mergeSection: "Content to merge", inspect: "Locate original",
  },
};

export function cleanupText(key: keyof typeof words.en, vars?: Record<string, string | number>) {
  let text: string = words[currentLocale()][key];
  for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
