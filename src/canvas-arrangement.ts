import { currentLocale } from "./i18n";
import type { CanvasArrangement, CanvasPlacement } from "./types";

export const arrangements: CanvasArrangement[] = ["free", "side_by_side", "figure_caption", "sequence"];
const words = {
  "zh-CN": {
    label: "如何一起看", free: "自由摆放", side_by_side: "并置比较", figure_caption: "图文解释", sequence: "连续展开",
    save: "仅保存", apply: "保存并编排", preview: "编排示意", unavailable: "包含组合或已移除的内容，暂时只能保存观看方式。",
    hint: "仅保存会保留当前位置；保存并编排会按成员顺序调整位置，保留尺寸，不创建关系线。",
    freeHelp: "保留各组件的位置。", side_by_sideHelp: "横向并置、顶部对齐，便于来回比较。", figure_captionHelp: "第一项作为主体，其余说明靠近主体下方。", sequenceHelp: "从上到下展开，让阅读顺序清楚可见。",
  },
  en: {
    label: "How to view together", free: "Free placement", side_by_side: "Side by side", figure_caption: "Figure and captions", sequence: "Sequence",
    save: "Save only", apply: "Save and arrange", preview: "Arrangement preview", unavailable: "Nested groups or removed items are included. Only the viewing intent can be saved.",
    hint: "Save only keeps positions. Save and arrange repositions members in reading order, preserving their sizes and adding no connections.",
    freeHelp: "Keep every component in place.", side_by_sideHelp: "Align across a row for easy comparison.", figure_captionHelp: "The first member is the subject; explanations follow closely below.", sequenceHelp: "Unfold from top to bottom in reading order.",
  },
  ja: {
    label: "一緒にどう見るか", free: "自由配置", side_by_side: "並べて比較", figure_caption: "図と説明", sequence: "順に展開",
    save: "保存のみ", apply: "保存して配置", preview: "配置イメージ", unavailable: "グループまたは非表示の内容を含むため、見る順序のみ保存できます。",
    hint: "保存のみでは位置を保持します。保存して配置すると、サイズを変えずに順序に沿って並べます。関係線は作りません。",
    freeHelp: "各部品の位置を保持します。", side_by_sideHelp: "上端を揃えて横に並べ、比較しやすくします。", figure_captionHelp: "最初の部品を主題にし、説明をその下に置きます。", sequenceHelp: "上から下へ、読む順序で展開します。",
  },
};
export function arrangementText(key: keyof typeof words.en): string { return words[currentLocale()][key]; }
export function isArrangement(value: unknown): value is CanvasArrangement { return arrangements.includes(value as CanvasArrangement); }

/** Read-only preview; the server validates versions and applies the actual layout. */
export function arrangementPreview(mode: CanvasArrangement, items: CanvasPlacement[]) {
  if (!items.length || mode === "free") return items.map(p => ({ id: p.item_id, x: p.x, y: p.y }));
  const left = Math.min(...items.map(p => p.x)), top = Math.min(...items.map(p => p.y));
  const width = Math.max(...items.map(p => p.width)); let x = left, y = top;
  return items.map(item => {
    const point = { id: item.item_id, x: mode === "figure_caption" ? left + (width - item.width) / 2 : x, y };
    if (mode === "side_by_side") x += item.width + 32;
    else y += item.height + (mode === "figure_caption" ? 16 : 48);
    return point;
  });
}
