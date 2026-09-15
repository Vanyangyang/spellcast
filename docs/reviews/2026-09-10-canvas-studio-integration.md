# 画布工作室浅色集成（2026-09-10）

状态：把 `output/canvas-studio-20260910/` 的浅色工作台语言接入正式 Canvas（`body.mode-focus.view-replies`）。未提交或推送。确定性 MCP 布置不是宿主 Agent 回传；真实回传仍为 `NOT_CALLABLE`。

Round 1 交付被主代理拒收。Round 2 纠正已核实 UI 缺陷并被主体接受。Round 3 只收口两件事：恢复挂载不再无条件拆装 iframe，以及窄屏 `zh-narrow.png` 必须是「查看全部」后的构图。round2 证据保留；本轮源文件小 baseline 在 `round3/baseline-src/`。

## 本轮纠正（相对主代理核过的 06:01 截图）

1. **顶栏入口。** Chromium 对关闭的 `<details>` 会隐藏 summary 以外的子节点；`display:contents` 不能解除该隐藏。宽屏用 `details.open = true` + 菜单当行内 flex；`mode-focus.view-replies` 且 `max-width:1100` 才进入 compact More。想法布局 / ambient 不 compact，三个入口仍在。1320 实际打开并关闭了设置（div）、记忆、反馈（dialog）；1000 More 可开、Escape 关闭并回到 summary；恢复宽屏三个按钮重新可见。
2. **所选工具。** 一条屏幕坐标 dock 固定在左轨右侧、画布上方（约 left 88 / top 12）。plain 的 `frame.head` 仍在 DOM，用 1px clip + `pointer-events:none`，不用 `display:none`。选择后焦点落到 `.canvas-graph`，Enter / Delete / Escape 仍走 `onHost`。
3. **左轨遮挡。** 不改用户 geometry。Graph 背景铺满；fit / focus / persist / restore 以左 88px、顶 56px 为可用区。参数作品仍是 96,72,200×240。iframe 内标题、滑块、刻度可见。
4. **恢复旁注空白。** 根因：移除时 `native.destroy()` 掏空旧 frame，X6 按同一 cell id 复用 view，恢复后 FO 里仍是空 article。纠正：native 先于 `addNode` 建好；移除时 `frame.root.remove()`；`mountHtml` 只在父节点不匹配时换入当前 frame，只在缺失时追加 `native.root`。异步 microtask/rAF 若 `destroyed`、html map 已换根、或 `frames` 里已不是同一 cell/root 则不再操作。测试等待 h3「旁注」与 textarea「不被改写的说明」可见且对比度 ≥3，不改写内容、不换 ID。
5. **进程重启。** links 11 是 page refresh / 作品 Restart / draft reload，**不是** CloseMainWindow 再启动。本轮在 fresh DB 上跑完 studio 后保存 expected，正常关闭 PID 55168（退出码 0），同一 `studio.sqlite3` + `webview-final` 再启 PID 44760，`--verify-restart` 核对对象、geometry、绑定、潮位 3、可见旁注、未发送草稿。`page.reload` 不算进程重启。
6. **composition 269 行。** 首轮 `composition/failed.png`：所选 dock 跟对象走，盖住 Send signal，`state.count` 仍为 undefined。本轮 dock 固定在顶部安全区；点击命中 `IFRAME.artifact-frame` 而不是宿主按钮。测试在作品 `spellcast.ready`、`#signal` 可见后再点，并等到 `#count === '1'`。原 `state.count === 1` 与 `selection.label === 'Lighthouse lamp'` 未放宽。一次重跑不算修复；本轮最终构建上完整 10 项带前置/命中/后置记录。

呈现：composer 实测 104px；Work inside 深青字 / 浅薄荷底；标题不与三按钮争位。连接线是 `data:` 边，不是装饰。未改 Rust / dataflow / SDK / API。iframe 填满 presentation 保留；active 态仍可滚动作品内部。

## 原子契约

未改 object_id、内容/呈现/组合版本、用户 geometry、作品 state、草稿、反馈锚点、绑定协议或存储。缩放只改视图。禁止自动 tidy。旧 440/650 对象未迁移。

## Round 3 收口

`mountHtml` 不再对已在 `foContent` 里的 frame 做 `replaceChildren`。narrow 主图改为：先把旁注特写存成 `narrow-note-focused.png`，再真实点「查看全部」、等 rect 稳定后拍 `zh-narrow.png`。该张断言参数/地图/潮位观察/旁注都在可用画布内（8px 边框容差），参数与左轨不相交，旁注标题正文仍在。未改 pose，未隐藏工具。

## 验证

隔离端口，不用 47194。Round 3 最终构建：`tsc --noEmit`、Vite、`tauri build --debug --no-bundle` 均为 0。可执行文件 `src-tauri/target/debug/spellcast.exe`。

| 检查 | 结果 |
| --- | --- |
| studio round3（47208 / CDP 9346，fresh `round3/studio.sqlite3`） | 20 项（含 fit-all 可用区）+ 进程重启，[round3/result.json](../../artifacts/canvas-studio-integration-20260910/round3/result.json) |
| 真实进程重启 CloseMainWindow → 同库同 profile | PASS，`processRestart: true`，[round3/restart-verified.png](../../artifacts/canvas-studio-integration-20260910/round3/restart-verified.png) |
| check-canvas-links.mjs（47202 / 9342） | 11/11，[round3/links/result.json](../../artifacts/canvas-studio-integration-20260910/round3/links/result.json) |
| check-atomic-composition.mjs（47200 / 9340） | 10/10，[round3/composition/result.json](../../artifacts/canvas-studio-integration-20260910/round3/composition/result.json)；点击仍命中 `IFRAME.artifact-frame`，`workAfter.count === "1"` |
| CSS.getPlatformFontsForNode（`#settings-open`） | OBSERVED：`Noto Sans SC Thin Medium` |

Round 2 对照仍在 [round2/result.json](../../artifacts/canvas-studio-integration-20260910/round2/result.json)。本轮自有 App 均 `CloseMainWindow` 退出码 0。未使用 47194。未关 GrokTUI。

### 关键截图（亲自看过）

- [round3/zh-desktop.png](../../artifacts/canvas-studio-integration-20260910/round3/zh-desktop.png)：宽屏构图与 round2 一致。
- [round3/zh-narrow.png](../../artifacts/canvas-studio-integration-20260910/round3/zh-narrow.png)：1000「查看全部」后参数/地图/两份原生都在可用区内，左轨不挡参数，旁注有字。
- [round3/narrow-note-focused.png](../../artifacts/canvas-studio-integration-20260910/round3/narrow-note-focused.png)：旁注特写（旧 zh-narrow 构图，另存）。
- [round3/restart-verified.png](../../artifacts/canvas-studio-integration-20260910/round3/restart-verified.png)：同库重启后潮位 3、草稿、旁注仍在。
- 保留的失败证据：round1 两张 zh 图；[composition/failed.png](../../artifacts/canvas-studio-integration-20260910/composition/failed.png)；round2 [failed-restore.png](../../artifacts/canvas-studio-integration-20260910/round2/failed-restore.png)。

### composition 边界（本轮 10/10）

`workReady`: active、`#signal`/`#lamp` 可见、`spellcast` true、count `"0"`。`#signal` / `#lamp` 的 `elementFromPoint` 命中 `IFRAME.artifact-frame`（不再是宿主 dock）。`workAfter.count === "1"`，selection `Lighthouse lamp`。断言未改。

## 未覆盖

- 未跑 Rust workspace 测试（Rust 未改）。
- 未改用户数据库、旧页面、独立候选 `output/canvas-studio-20260910/`。
- 未在真实宿主 Agent 上跑 MCP 回传（`hostAgent: NOT_CALLABLE`）。
- 想法布局只断言了三个顶栏入口仍在，没有单独的想法布局视觉回归集。
- Round 3 窄屏主图在选中旁注的同时做了「查看全部」，所选 dock 仍可见（未隐藏工具）。
