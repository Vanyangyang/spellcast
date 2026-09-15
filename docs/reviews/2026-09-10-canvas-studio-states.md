# 画布工作室操作状态（2026-09-10）

状态：操作态与设置弹窗可达性纠正，不改 Canvas 身份、绑定或反馈协议。未提交或推送。确定性 MCP 布置不是宿主 Agent 回传；真实回传仍为 `NOT_CALLABLE`。未点「写入配置 / 安装 Skill」。Round 3 补了连接 chip 对比度、设置 label 重复 margin、源码编辑器进视口。

主代理暂停是为了给出明确纠正，不是撤销已有浅色面板。浅色 Settings / 客户端按钮 / 状态条 / 空态标题与一句 how-to 保留。本轮只修焦点陷阱、Idea 全局快捷键泄漏、Space 测试误报，并在同一 debug 构建上跑完 states + studio 真进程重启 + links + composition。

## 主代理核实过的失败

UTC 07:41:49 与 07:47:25 的 `failure.json` 都是 `Shift+Tab escaped settings dialog`。07:47 已经是面板样式，因此不能说只改全屏 CSS 就已解决。保留：

- [failed-focus-trap.png](../../artifacts/canvas-studio-states-20260910/failed-focus-trap.png) / [failure-focus-trap.json](../../artifacts/canvas-studio-states-20260910/failure-focus-trap.json)（15:41:49）
- [failure.json](../../artifacts/canvas-studio-states-20260910/failure.json)（15:47:25）
- 同期 [failed-focus-trap-2.png](../../artifacts/canvas-studio-states-20260910/failed-focus-trap-2.png)、[failed-focus-trap-3.png](../../artifacts/canvas-studio-states-20260910/failed-focus-trap-3.png)

根因：`document` `focusin` 救援发生在 Tab 已经离开之后；焦点落到 dialog 自身时 `closest('#settings')` 仍为真，下一次 Shift+Tab 就到 body。验收不以 body「在弹窗内」放宽。

round2 另保留一次作品「停止」超时：[failed-stop-timeout.png](../../artifacts/canvas-studio-states-20260910/round2/failed-stop-timeout.png)。之后改为等待 `.artifact-controls`，按实际标签点「停止」或「运行」，不把可访问按钮的 Space 关掉。

## 纠正

1. **Settings Tab 环。** 去掉 `document` `focusin` 救援。`#settings` 是原生 `<dialog class="settings" tabindex="-1">`，`showModal` / `close` / cancel 仍是模态基础。仅在 `settings.open && key === 'Tab'` 时，动态取当前可见、未 disabled、`tabIndex >= 0` 的按钮/输入等；Shift+Tab 在第一个或不在列表内 → `preventDefault` 并 focus 最后一个；Tab 在最后一个或不在列表内 → focus 第一个；没有目标 → focus dialog。列表中间走原生。不全局吞键，不拦截输入、Space、Escape。
2. **Idea / ambient 全局 keydown。** `src/main.ts` 约 1088 行 guard 从 `.board-dialog[open]` 改为 `dialog[open]`。Settings 没有 `board-dialog` class，原先 Delete / Backspace / n / Escape 会操作背景选中节点。Canvas 自己的同类 guard 未改。
3. **States 脚本。** 打开设置后焦点放到 `#settings-copy-url`（不是关闭按钮）再发 Delete / Space；Space 保持按钮激活。验证背景对象与视图不变，按实际 `open` 继续。新增 Idea 回归：选中隔离 fixture 普通节点，打开设置，焦点在设置按钮上，真实 Delete / Backspace / n / Escape 分开记录；背景节点未删未增，选中未被旧 global handler 改掉；Escape 只关 settings 并还原触发焦点。不用直接调用 handler 证明。

## 操作态目视

对比度（settings-zh）：标题 16.98、未选客户端 16.07、选中 Codex 7.60、状态条 16.07、关闭 16.07；禁用工具栏「组合」7.01。均 ≥4.5。英文标题为 compact「Connect Agent」。1000 从 More 打开设置。空态有标题「画布上还没有内容」和一句 how-to，左侧 + 可发现。Artifact 进入内容后「运行 / 重新运行」为真实可用控件。Native 编辑显示「未保存的草稿」，取消不改写已存正文。记忆 / 反馈 / 层级均为可读操作面板。

## 同一最终 debug 构建

未再构建。`src-tauri/target/debug/spellcast.exe` 15:58:51，36 176 384 字节。Vite：`dist/assets/main-w3JDxjGL.js`、`main-LZ3BjU0k.css`、`shared-BLwzttc1.css`。未改 Rust / bridge / API / SDK / 协议 / 依赖。未写用户库 47194，未关 Grok TUI。

| 检查 | 端口 / CDP | 结果 |
| --- | --- | --- |
| states 11（含 Idea guard） | 47210 / 9348，PID 51584 | 11/11，[round2/result.json](../../artifacts/canvas-studio-states-20260910/round2/result.json) |
| studio 20 + 真进程重启 | 47208 / 9346；PID 51240 → CloseMainWindow 0；同库同 profile 再启 56260 写入草稿后再启 57996 `--verify-restart` | 21/21，`processRestart: true` |
| links 11 | 47202 / 9342，PID 57076 | 11/11 |
| composition 10 | 47200 / 9340，PID 51204 | 10/10；`#signal`/`#lamp` 命中 `IFRAME.artifact-frame`，`workAfter.count === "1"` |

Studio 首跑 `draftMarker` 被后续视图切换清成空字符串。在 56260 上真实填入「闸口在低潮是否保持关闭？」再 CloseMainWindow，57996 上核对对象、geometry、绑定、潮位 3、可见旁注与该草稿。`page.reload` 不算进程重启。

Composer 实测 104px。`CSS.getPlatformFontsForNode(#settings-open)`：`Noto Sans SC Thin Medium`。

## 关键截图

States round2：[empty-zh](../../artifacts/canvas-studio-states-20260910/round2/empty-zh.png)、[settings zh 1320](../../artifacts/canvas-studio-states-20260910/round2/dialog-settings-zh-1320.png)、[settings en](../../artifacts/canvas-studio-states-20260910/round2/dialog-settings-en-1320.png)、[settings zh 1000](../../artifacts/canvas-studio-states-20260910/round2/dialog-settings-zh-1000.png)、[native-edit](../../artifacts/canvas-studio-states-20260910/round2/native-edit.png)、[active 运行/重新运行](../../artifacts/canvas-studio-states-20260910/round2/active.png)、[memory](../../artifacts/canvas-studio-states-20260910/round2/dialog-memory.png)、[feedback](../../artifacts/canvas-studio-states-20260910/round2/dialog-feedback.png)、[layers](../../artifacts/canvas-studio-states-20260910/round2/dialog-layers.png)。

Studio：[zh-desktop](../../artifacts/canvas-studio-states-20260910/studio/zh-desktop.png)、[zh-narrow 查看全部](../../artifacts/canvas-studio-states-20260910/studio/zh-narrow.png)、[more-open](../../artifacts/canvas-studio-states-20260910/studio/more-open.png)、[restore-note](../../artifacts/canvas-studio-states-20260910/studio/restore-note.png)、[restart-verified](../../artifacts/canvas-studio-states-20260910/studio/restart-verified.png)（潮位 3、草稿、旁注仍在）。

## Round 3 显示收尾

主代理已接受 Tab / Idea 快捷键 / Space。本轮只修三件显示问题。旧证据与 round2 保留；新证据在 [round3/](../../artifacts/canvas-studio-states-20260910/round3/)。baseline：`round3/baseline-src/`。

1. **连接 chip。** `styles.css` `.agent-chip { color: var(--paper) }` 在浅色里是白字浅底。`canvas-studio.css` 给 `.agent-chip` / `.live` / `.stale` 明确前景与不透明底（live `#0f4f46` on mint-soft，stale `#6b4a0c` on `#f3e6c4`），不造连接状态。MCP fixture 注册并活动后打开设置，等待可见 `.agent-chip`，按祖先合成 rgba 后对比 7.60。截图 [connected-settings.png](../../artifacts/canvas-studio-states-20260910/round3/connected-settings.png)：`rmcp 3.2.0` 青绿底深字。
2. **设置 label margin。** 全局 `dialog label { margin: 12px 0 }` 在 `.settings-sheet` 里与 grid gap 叠 24px。浅色 scope 内 `label { margin: 0 }`，分组 gap 保留。1320 自然容纳无页滚动；1000 仍内部滚动。
3. **源码进视口。** 停止态另存 [active-stopped.png](../../artifacts/canvas-studio-states-20260910/round3/active-stopped.png)；真实重新运行后等 `#tide-value` 再拍 [active-running.png](../../artifacts/canvas-studio-states-20260910/round3/active-running.png)。打开源码时 iframe 吃掉滚轮、编辑器在折下。最小修复：active 且 `details` 打开时视口 `max-height: 42%`，不改对象 geometry。真实点 summary + 作品内容区滚轮，断言 textarea/controls 与内容可视区相交且有 HTML。 [active-sources.png](../../artifacts/canvas-studio-states-20260910/round3/active-sources.png) 可见 `index.html` 源码。失败对照 [failed-sources-scroll.png](../../artifacts/canvas-studio-states-20260910/round3/failed-sources-scroll.png)。

Studio 关闭进程前在 composer 真实填入非空「闸口在低潮是否保持关闭？」并断言，避免空对空当草稿重启。

最终构建：`tsc --noEmit` + Vite + `tauri build --debug --no-bundle` 0。`dist/assets/main-DgrObfpw.js`、`main-BTUKeqzp.css`。

| 检查 | 端口 | 结果 |
| --- | --- | --- |
| states 12（含 chip + 源码视口） | 47210 / 9348，PID 53160 | 12/12，[round3/result.json](../../artifacts/canvas-studio-states-20260910/round3/result.json) |
| studio 20 + CloseMainWindow 真重启 | 47208 / 9346；PID 48316 → 47948 `--verify-restart` | 21/21，`processRestart: true`，非空草稿 |
| links 11 | 47202 / 9342，PID 59656 | 11/11 |
| composition 10 | 47200 / 9340，PID 57252 | 10/10，`workAfter.count === "1"` |

亲自看过：[connected-settings](../../artifacts/canvas-studio-states-20260910/round3/connected-settings.png)、[1320](../../artifacts/canvas-studio-states-20260910/round3/dialog-settings-zh-1320.png)、[1000](../../artifacts/canvas-studio-states-20260910/round3/dialog-settings-zh-1000.png)、[active-running](../../artifacts/canvas-studio-states-20260910/round3/active-running.png)、[active-sources](../../artifacts/canvas-studio-states-20260910/round3/active-sources.png)。

自有 App 均 CloseMainWindow 退出码 0。无残留监听。未用 47194。未关 TUI。未写客户端配置 / Skill。

## 未覆盖

- 英文 Settings 页脚说明仍是中文（`describeClient` note），未追。
- 未跑 Rust workspace（Rust 未改）。
- 未写真实客户端配置，未安装 Skill。
- MCP fixture ≠ 宿主 Agent。
- 未改主画布美术 / 布局，未扩展产品功能。
