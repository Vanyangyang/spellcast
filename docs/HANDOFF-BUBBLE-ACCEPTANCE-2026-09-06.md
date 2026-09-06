# Spellcast 气泡交互收尾与验收

请在本地完成以下功能与验证。最终 Codex CLI 演示由原 Codex 任务在用户返回后制作，本次不录最终演示、不发布版本。

## 用户已经确定的行为

1. 新气泡出现后立即向上飘。不能因为窗口获得焦点而等待或暂停。
2. 未收藏的气泡正常上飘，到期消失。
3. 点击星星只切换收藏，不自动展开面板、不立即跳到顶部。收藏后的气泡继续上飘，到顶部后一直保留。
4. **拖动时已收藏**：松手后固定在松手位置，停止上飘和消失。
5. **拖动时未收藏**：松手后停留 5 秒，再继续上飘并最终消失。
6. 取消收藏已固定的气泡后，恢复上飘及正常消失。
7. 双击气泡直接进入主面板的想法视图，并选中这条气泡对应的想法；必要时先收藏。不能进入旧的 peek 小窗，也不能选中另一条旧想法。
8. 星星、拖动、双击之间不能互相误触；收藏失败时恢复原状态，不能误显示成功。

## 工作区与保护范围

- 仓库：`G:\VibeProj\spellcast`。当前工作区有大量既有未提交修改，必须保留；不要 reset、clean、自动 stash 或整体覆盖。
- 当前运行的应用是仓库下 `src-tauri\target\release\spellcast.exe`，最后观察 PID 为 `52260`，桥接端口 `47194`。这些运行信息需要重新核实。
- 当前使用的数据库：`G:\VibeProj\spellcast\data\native-codex-calendar-final.sqlite3`。用户已经在其中通过真实 UI 新建了卡片，**必须保留数据库、卡片和布局**；不能当测试数据清空或替换。
- 正式应用启动时使用 `SPELLCAST_PORT=47194` 和 `SPELLCAST_STATE_FILE` 指向上述数据库。构建前若 exe 被占用，正常关闭应用后再构建，不要广泛杀进程。
- 用户原有应用和窗口保持原样。不自动关机。

## 当前代码与已知问题

主要文件：

- `src/bubble.ts`：气泡动画、收藏、拖动、双击。
- `src/main.ts`：收到当前气泡的 focus 事件后刷新面板、切到想法视图。
- `src-tauri/src/desktop.rs`、`src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`：本次最新拖动修正。
- `skills/spellcast/SKILL.md`：已经同步过用户交互约定；修改后检查一致性。

最后一次原生排查确认：前端原本 `await win.startDragging()` 后立刻读取 `outerPosition()`，但本机 Tauri/Tao 的 Windows 实现只是投递系统拖动消息，Promise 返回不表示用户已经松手。因此现有“拖完才恢复动画”的时序不成立，真实拖动未通过验收。

**交接前刚落盘了一份候选修正，尚未编译、测试或在原生应用验证：**

- 新增 `desktop::drag_bubble` Tauri 命令，只允许 `bubble-` 窗口调用。
- Windows 在主线程用 `ReleaseCapture` 与同步 `SendMessageW(WM_NCLBUTTONDOWN, HTCAPTION, packed cursor position)` 发起系统移动；等调用返回，再把最终窗口位置返回给前端。
- 使用 `tokio::sync::oneshot` 返回结果；Cargo 增加 `sync` 和 Windows KeyboardAndMouse feature。
- 前端现在调用 `invoke("drag_bubble")`，以返回位置决定拖动后行为。
- 非 Windows 暂用原有 `start_dragging` 路径，**不能据此声称 macOS 的完成时序已验证**。
- 组件测试夹具已经把拖动 mock 改成 `drag_bubble`，但尚未重跑。

请先评估并验证这份小修正，必要时直接修好。它是待验证方案，不是必须坚持的架构。不要修改 Cargo registry 或依赖源码。重点检查：UI 线程不会卡死、松手才恢复动画、静止单击不会被当作拖动、双击仍然可靠、不同 DPI 下位置正确。

## 已有证据及边界

- 在最新候选修正之前，`npm run build` 通过，实际前端模块的 8 项组件检查通过。
- 组件检查模拟了 OS 调用与时钟，不能代替真实 Windows 输入验收。
- 原生已观察到：新气泡不激活窗口也立即向上移动；星星收藏后不自动打开面板，继续上飘，超过原寿命 112 秒后仍留在顶部。
- 原生**尚未通过**：收藏后拖动固定、未收藏拖动后 5 秒恢复、双击打开对应想法。不能把此前测试工具返回成功当作窗口真的移动。
- 当前运行 exe 不包含交接前刚写入的 Rust 拖动修正，需要重新构建并启动。

组件夹具：

- `artifacts/launch-0.2.1/calendar-demo/bubble-interaction-check.html`
- `artifacts/launch-0.2.1/calendar-demo/check-bubble-contract.js`

夹具通过 Vite 的 `http://127.0.0.1:47193/artifacts/launch-0.2.1/calendar-demo/bubble-interaction-check.html` 加载实际 `/src/bubble.ts`。检查脚本是接受 Playwright `page` 的 async 函数。原 Vite 会话已停止，按仓库脚本重启即可。建议补一项有真实异步等待的模拟检查，确认拖动命令未返回期间不会恢复动画；不要只用立即返回的 mock 掩盖本次根因。

## 请完成的验收

1. 编译前端及 Rust，修复最新候选代码中的编译或运行问题；选择与改动相关的检查，不盲目跑无关全量任务。
2. 重跑组件行为检查，覆盖上面 8 条用户约定。
3. 用实际 Windows 鼠标输入，逐项验证收藏、拖动松手、等待恢复、取消收藏和双击。记录窗口真实移动及等待后的状态，不能直接调用 handler、改变量或拿模拟结果充当原生证据。
4. 双击后核对面板当前选中的节点 ID 与该气泡对应节点一致。
5. 保留一份简短验收记录：修改文件、构建/检查结果、真实输入步骤和结果、仍未覆盖的平台或场景。如果有阻塞，写明具体阻塞，不写“全部完成”。

之前自动化在移动窗口上多次因坐标过期、窗口边界变化被拦截，第二屏坐标也曾与 Win32 实际位置不一致。可优先由用户手动验证，或使用允许的真实输入工具；不要绕过输入守卫。只读 Win32 窗口位置诊断可以辅助取证，但不能替代真实输入。

## 完成后交还的信息

请向用户提供以下简短回执，方便回到原 Codex 任务继续：

```text
修改文件：
构建与组件检查：
真实 Windows 验收：
  新气泡立即上飘：PASS/FAIL/未测
  收藏继续上飘并顶部常驻：PASS/FAIL/未测
  收藏后拖动固定：PASS/FAIL/未测
  未收藏拖动停 5 秒后恢复并消失：PASS/FAIL/未测
  取消收藏恢复：PASS/FAIL/未测
  双击进入该条想法：PASS/FAIL/未测
数据库与用户卡片是否保留：
当前运行 exe / 端口 / 数据库：
遗留问题与证据文件：
```

## 留给原 Codex 任务的最终演示

用户回来后再做：使用真实、可见、当前安装的 Codex CLI，以 Sol 模型完成全英文日历规划任务，再演示气泡上飘、收藏、拖动和双击进入当前想法。界面、任务文本和演示路径均为英文。不使用 Notepad 替代场景，不用假终端或直接 HTTP 注入冒充 CLI 的原生 MCP 调用。

- CLI 场景目录：`G:\Demos\Calendar`。
- 已有产物：`BRIEF.md`、`weekly-plan.md`、`weekly-plan.ics`、`weekly-plan.svg`、`check-calendar.py`、`start-codex.ps1`。25 个日历事件的约束检查此前通过。
- 原 CLI 任务：`01a0753b-0e36-70d1-b010-30a607d95ffe`，气泡来源：`codex:calendar-sol-20260906`。
- 原 CLI 最后观察 PID `39088`；它在 Spellcast 未启动时初始化，后续提示 MCP 不可调用。应先保证 Spellcast 健康，再正常重开或恢复 CLI，确认原生 MCP 真正可用。
- 此前“停止旧 CLI 进程并启动新 CLI”的组合命令被自动审批拒绝，尚未执行；已请求用户正常关闭旧 CLI，尚未收到确认。不要绕过该拒绝。当前任务也无需为修复气泡而操纵 CLI。
- 面板与 CLI 后续通信研究已在 `docs/reviews/2026-09-06-codex-board-feedback.md`，属于后续设计研究，不是本次新增生产功能要求。
- 现有 GitHub `v0.2.1` draft/tag 不含这些最新交互修改；不要把旧发布包当成当前修复成果，不移动旧标签。本次不处理发布。

用户已取消 Web Chat 接管方案，旧 `docs/HANDOFF-WEB-CHAT-2026-09-06.md` 不是本次执行依据。

### 用户追加的演示片尾要求

片尾必须表达：项目孵化中，这是初期演示 demo，目前提供的是体验测试版本，成品敬请期待。沿用整个演示的全英文约定，使用以下文案：

```text
Spellcast is in early development.
Early demo · Experimental preview
Stay tuned for the full release.
```

这段话作为演示收尾画面，不能把当前版本描述为成熟成品或正式发布版。
