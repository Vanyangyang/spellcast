# 画布 UI 精修（2026-09-10）

状态：视觉与呈现结构精修，不改变 Canvas 身份、版本、绑定或反馈协议。未提交或推送。真实宿主 Agent 回传仍为 `NOT_CALLABLE`。

第一轮已完成分组工具栏与深色画布基线，主代理指出弹窗控件、连接摘要、工具栏重量、近景与更多菜单仍未达标。第二轮按这些取舍修正；第一轮截图保留不覆盖。

## 第二轮修正

- 画布相关弹窗（层级、连接、提案、恢复、草稿、总览）的按钮、可选择行、输入统一为深色应用控件：继承字体、≥32px、8px 圆角、hover/focus/selected/disabled。Connect / Apply 用薄荷绿主操作，Close / Disconnect 用次级样式。
- 连接摘要只显示「来源标题 · 端口 → 目标标题 · 端口」；同名标题不重复；缺失来源标「来源不可用」。原始 ID 只在 `title`，不进正文。绑定协议未改。
- 主条：Add thought / All items / Layers；所选：Work inside / Data connections / Focus（中文「聚焦所选」）；视图：Fit all / − / 当前百分比 / +。Expand 下拉与 Group / Ungroup 进更多。Add thought 为克制主按钮；画布按钮与 More 为 8px 圆角，顶部 Canvas/Idea layouts 仍用圆弧分段。
- Focus 仅居中并适合当前选区，zoom 上限 1，不写对象几何或作品 state；无选择时禁用。
- 更多菜单受画布容器高度约束，内部可滚动，最后一项可到达；去掉误导的 `role=menu`。Escape 关闭后焦点回到 summary；点击外部关闭不抢焦点。

## CSS 收尾

- 层级列表：通用 `.board-dialog button` 不再覆盖 `.canvas-layer-pick[aria-pressed=true]`；已选行有淡紫底与边线，悬停/焦点仍可辨认。
- 更多菜单与画布弹窗宿主滚动条改为暗色细轨道/滑块；不改 iframe 内部样式。

## 改动文件

`index.html`，`src/styles.css`，`src/board-workspace.css`，`src/canvas.css`，`src/artifacts.css`，`src/canvas.ts`，`src/canvas-connections.ts`，`src/i18n/canvas.ts`；`scripts/check-canvas-links.mjs`、`scripts/check-atomic-composition.mjs`（真实打开更多再点 Group 等）；`scripts/check-canvas-ui-polish.mjs`。已删除本轮新建的 `check-canvas-ui-extra.mjs`。

## 检查

| 检查 | 退出码 |
| --- | --- |
| `tsc --noEmit` + Vite + `tauri.js build --debug --no-bundle` | 0 |
| `check-canvas-links.mjs` 11 项（47204 / 9344，fresh DB） | 0 |
| `check-canvas-ui-polish.mjs` 8 项（round2-links 库复验，含已选层级可见样式差；viewport 1320×860 / 1000×700） | 0 |
| `check-atomic-composition.mjs` 10 项（另一 fresh DB） | 0 |

未重跑 Rust workspace。测试进程 `CloseMainWindow` 退出码 0，无残留。未使用 `47194`。1000×700 是 `window.innerWidth/innerHeight` 的 WebView viewport，不是原生外窗尺寸。

## 证据

第一轮保留：`artifacts/ui-polish-20260910/` 根目录截图与 `links/`、`composition/`。

CSS 收尾截图：[en-desktop](../../artifacts/ui-polish-20260910/final-ui/en-desktop.png)、[en-closeup](../../artifacts/ui-polish-20260910/final-ui/en-closeup.png)、[en-layers](../../artifacts/ui-polish-20260910/final-ui/en-layers.png)、[en-connections](../../artifacts/ui-polish-20260910/final-ui/en-connections.png)、[en-narrow-more](../../artifacts/ui-polish-20260910/final-ui/en-narrow-more.png)、[zh-desktop](../../artifacts/ui-polish-20260910/final-ui/zh-desktop.png)、[UI result](../../artifacts/ui-polish-20260910/final-ui/result.json)。第二轮 `final/` 保留不覆盖。

联动 [round2-links/result.json](../../artifacts/ui-polish-20260910/round2-links/result.json)；组成 [round2-composition/result.json](../../artifacts/ui-polish-20260910/round2-composition/result.json)。

## Focus 多选远距下限

`focusSelection` 合并多对象 bounds 后，缩放下限从 `0.2` 改为与画布 `scaling.min` / 视图恢复一致的 `0.01`（上限仍为 1）。旧单对象 `focus()` 与普通缩放未改。约 12000 世界单位的选区在 1320 视口下可落到约 10%，两端不再被 20% 下限裁掉。

验证：隔离库/端口 47206，MCP `spellcast_canvas_batch` 仅作测试布置（不是宿主 Agent 回传）；真实 Layers 多选后点 Focus。对象几何、内容、作品 state 与选区不变。同构建另用 round2-links 库、独立 WebView 跑中文 Tide chart 聚焦近景。

证据：[far-pair](../../artifacts/ui-polish-20260910/focus-bounds/far-pair.png)（10%）、[zh-tide-closeup](../../artifacts/ui-polish-20260910/focus-bounds/zh-tide-closeup.png)、[result](../../artifacts/ui-polish-20260910/focus-bounds/result.json)。精修主截图仍在 `final-ui/`；11+10 仍在 `round2-*`。未提交或推送。

## 未覆盖

原生 Spellcast 工具目录仍空。确定性 MCP 样本创建不是宿主 Agent 回传。未改对象几何或用户数据库。
