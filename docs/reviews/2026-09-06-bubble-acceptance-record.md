# 气泡交互收尾验收记录（2026-09-06）

## Codex 接回后的核对（16:35）

- 当前 HEAD `75f5fe0`；仅保留交接指出的三个未跟踪旧文件。实际应用 PID `53180`，`/api/health` 正常，原有两张卡片 ID 未变。
- 创建了一条 `diag:codex-native-acceptance-20260906` 诊断气泡。Computer Use 能读取气泡截图，但激活及点击先后返回 `failed to activate captured window`；没有成功的点击、拖动或双击证据。已停止输入并请用户切回普通桌面或手动验收，未运行交接中的自制 SendInput 脚本。
- 最新原生交互验收仍未完成，不能将下述组件通过记录升级为原生通过。
- 已准备并检查全英文 6 秒片尾：`artifacts/launch-0.2.1/calendar-demo/preview-end-card.mp4`。新 CLI 预检启动脚本在 `G:\Demos\Calendar\start-codex-final.ps1`，尚未启动。旧 CLI PID `39088` 保留。

对应交接：`docs/HANDOFF-BUBBLE-ACCEPTANCE-2026-09-06.md`。本次不录演示、不发布。

## 修改文件

- `src-tauri/src/desktop.rs`：`drag_bubble` 改为返回 `DragOutcome { x, y, moved }`。主线程闭包先读一次 `outer_position()`，再同步 `SendMessageW(WM_NCLBUTTONDOWN, HTCAPTION)` 进入系统移动循环，返回后再读一次位置；`moved = after != before` 由 Rust 判定，前端不再用几何推算的"按下前位置"比对。
- `src/bubble.ts`：以 `after.moved` 区分静止点击与拖动；拖动结束后追加一次 `setPosition(after)`，防止按下前已排队的动画帧在移动循环结束后被 Tao 事件缓冲区补发、把窗口拉回旧位置。
- `artifacts/launch-0.2.1/calendar-demo/bubble-interaction-check.html`：`drag_bubble` mock 支持挂起（`beginDrag`/`endDrag`），并返回 `moved`；新增 `press()`。
- `artifacts/launch-0.2.1/calendar-demo/check-bubble-contract.js`：新增 3 项检查（见下），失败时输出检查名。
- `skills/spellcast/SKILL.md`：核对第 29 行的交互约定与 8 条用户行为一致，未改动。

## 候选修正的评估结论

- 主线程不会死锁：`tauri-runtime-wry 2.11.4` 的 `send_user_message` 在主线程上直接内联处理，因此闭包内的 `outer_position()`/`hwnd()` 不会等待被阻塞的事件循环。系统移动循环自带消息泵，窗口仍可重绘和收输入。
- 已知副作用：移动循环期间 Tao runner 处于处理事件状态，其他窗口的用户消息（包括其他气泡的 `setPosition`）会被缓冲到松手后统一补发；其他气泡在拖动期间会暂停。由此引出上面的 `setPosition(after)` 兜底。
- `GetAsyncKeyState(VK_LBUTTON) >= 0` 时不进入移动循环，直接返回 `moved=false`，快速单击不会被当作拖动。
- LPARAM 用 `as u16` 截断打包，负坐标（副屏在左/上方）打包正确。返回的是物理像素，前端按 `currentMonitor().scaleFactor` 换算，跨 DPI 显示器时取松手后所在显示器的比例。
- 非 Windows 仍走 `start_dragging`，macOS 的完成时序未验证。

## 构建与组件检查

- `npm run build`（tsc + vite）：通过。
- `cargo check --release` / `cargo build --release`（`src-tauri`）：通过，无警告；`target/release/spellcast.exe` 于 15:37:56 重新链接。
- 组件检查（Vite `127.0.0.1:47193` 加载实际 `/src/bubble.ts`，Playwright 执行 `check-bubble-contract.js`）：**11/11 通过**。
  - 原 8 项：未收藏上飘到期消失；收藏后继续上飘并顶部常驻（超过寿命 120 s 仍在）；收藏后拖动固定；未收藏拖动停 5 s 后恢复并消失；取消收藏后恢复；双击进入对应想法（`node_id` 一致、`on_poke=focus`）；收藏失败回滚且无成功事件；焦点不延迟新气泡上飘。
  - 新增 3 项：`drag_bubble` 挂起 40 s（超过整个寿命）期间位置不变、不到期、不消失，松手后停 5 s 再恢复并到期；一次静止按下不打开面板且继续上飘，两次快速按下打开对应想法；按星星不触发 `drag_bubble`。
- 组件检查仍是模拟 OS 调用与时钟，不替代真实 Windows 输入验收。

## 真实 Windows 输入验收：未完成

- 尝试用 `SendInput`（P/Invoke，位于仓库外 `%USERPROFILE%\.playwright-mcp\spellcast-native\`）做真实输入。**首版脚本 `INPUT` 结构体多了 8 字节，`SendInput` 全部返回 0（错误 87），没有任何合成输入送达任何窗口**——已用零位移调用复核（旧结构体 `sent=0 lastError=87`，修正后 `sent=1`）。因此期间出现的光标移动全部来自用户本人。
- 只读 Win32 取证正常：`WindowFromPoint` 确认星星点与中心点均命中气泡窗口内的 `Chrome_RenderWidgetHostHWND`（msedgewebview2），气泡窗口 ExStyle `0x40118`（TOPMOST/TOOLWINDOW，无 TRANSPARENT），DPI 96。
- 复核光标与前台窗口时发现用户正在使用本机（前台为哔哩哔哩，光标持续移动），**未再发送任何合成输入**，避免抢占用户鼠标。修正后的脚本未运行。
- 唯一得到的原生证据：新气泡在无任何输入时立即上飘（`rise_before_any_input`：3 s 内 y 1203→1186，窗口未激活）。
- 以下项目均为 **未测**：收藏后继续上飘并顶部常驻、收藏后拖动固定、未收藏拖动停 5 s 后恢复并消失、取消收藏恢复、双击进入该条想法及面板选中节点 ID 核对。

### 建议的手动验证步骤（用户在场时）

1. 任一方式抛一个 `card` 气泡（Codex 侧 `spellcast_bubble`，或本地 `POST http://127.0.0.1:47194/api/bubble`，`source_id` 用诊断前缀）。
2. 不碰它：应立即上飘。
3. 点右上角星星：变金色、不弹面板、继续上飘、到顶后一直留着。
4. 按住气泡本体拖到别处松手：应停在松手位置不再动、不消失；再点星星取消收藏，应从该位置继续上飘并按寿命消失。
5. 再抛一个不收藏的，拖动松手：停 5 s 后继续上飘并消失。
6. 再抛一个，双击本体：气泡关闭，主面板进入想法视图并选中该条；对照 `GET /api/events` 中 `poke` 事件的 `node_id` 与面板选中项。
7. 可选取证：`native.ps1 -Cmd watch -Hwnd <hwnd> -A <ms> -B <interval>` 只读采样窗口位置。

## 数据与运行状态

- 数据库 `data/native-codex-calendar-final.sqlite3` 保留；重启前后 `/api/board` 均为 2 个节点（`7cd390a3… New scrap`、`d72ed9d4… Keep this thought…`），布局未动。本次未创建、未删除任何节点（收藏从未成功触发）。
- 收件箱新增了 `diag:native-input-20260906` 的 `ready`/`expired` 事件（seq 16–23），无 `kept`/`poke`。
- 旧进程 PID 52260 通过 `CloseMainWindow()` 正常关闭；新进程 PID 53180，`SPELLCAST_PORT=47194`、`SPELLCAST_STATE_FILE` 指向上述数据库，`/api/health` ok，`mcp: http://127.0.0.1:47194/mcp`。
- 重启会断开 Codex CLI 已建立的 MCP 会话（重启前 `/api/health` 显示 `codex-mcp-client 0.153.4` 曾调用），CLI 侧需按原计划正常重开。
- 临时 Vite 会话已停止；未动 Codex CLI、未杀无关进程。

## 证据文件

- 组件检查结果：本文件"构建与组件检查"一节（Playwright 返回 `checks: 11, passed: true`）。
- 原生只读采样与截图：`%USERPROFILE%\.playwright-mcp\spellcast-native\scenario-A.json`、`shot-154538-414.png`、`shot-154540-248.png`（气泡渲染正常、星星位于 right-41/top+41）。
- 输入驱动脚本（已修正结构体、未运行）：`%USERPROFILE%\.playwright-mcp\spellcast-native\native.ps1`、`scenario.ps1`。

## 原生鼠标验收与演示实拍（20:06–20:37，Cursor 宿主）

Codex 无额度，本轮由 Cursor 会话作宿主。屏幕上的 Codex CLI 终端是当天做日历的真实会话（`gpt-5.6-sol`），入镜时只展示其历史输出，未再输入。三条实拍原始文件均保留在 `artifacts/launch-0.2.1/calendar-demo/`，录制脚本 `CAPTURE-TAKE.ps1` 在 `*.mkv.start.json` 里记下起录毫秒，下表时间即 `/api/events` 的 `at_ms` 对齐到镜头的秒数。用户亲手操作鼠标，未用合成输入。

### Take 1 `final-live-20260906-200654.mkv`（148 s）

- `spellcast_checkpoint(cursor:calendar-demo-20260906, calendar-week-2026-09-07-final-review-desktop)` → `ready`；隔离子代理（无历史）调用 `spellcast_observer_complete` 返回 `accepted`。
- seq 28 `ready`（+87.0 s）→ 立即上飘；seq 29 `kept`（+101.7 s，node `077c88ab…`）→ 继续上飘、到顶常驻；+108–114 s 拖到终端右侧松手后原地驻留；seq 30 `kept` + seq 31 `poke on_poke=focus`（+117.6 s）→ 主窗口进入想法视图并选中该节点。
- 发现问题：Scatter 布局把最左碎片放在 8% 处、卡片 240px 居中，窄窗口下被左边缘裁掉。修复 `src/forms/constellation.ts`（`left` 夹在 `132px … calc(100% - 132px)`），`npm run build` + `cargo build --release`，PID 37540 经 `WM_CLOSE` 正常退出后以同端口、同数据库重启为 PID 61600。
- 重启前 seq 32 `cleared` 为用户在板上亲手按 Clear；本轮未由代理清空或删除任何节点。

### Take 2 `final-live-20260906-202852.mkv`（188.8 s）

- 第二次 checkpoint（`…-post-review-zero-slack`，变化为用户保留了零余量顾虑）→ `ready` → 子代理 `accepted`。seq 33 `ready`（+66.9 s）未被触碰，seq 35 `expired`（+84.9 s）：未收藏气泡上飘后自然消散。
- 用户明确要求同镜头出现多条，主任务按技能允许的方式直接 `spellcast_bubble` 两条与日历项目相关的旁念（seq 34、37）；两条均被收藏（seq 36、38），并排常驻顶部。seq 39 `kept` + seq 40 `poke`（+150.3 s，node `a3a32d89…`）→ 双击进板、选中该条；修复后卡片完整可见。本条未做拖动。
- 三条气泡来源：1 条独立观察者、2 条用户要求下的直接旁念，成片字幕只写 "an independent observer" 于第一条。

### Take 3 `final-live-20260906-203547.mkv`（81 s）

- 板上四种形态切换：Scatter（0–27 s）→ Space（28 s）→ Sequence（37 s）→ Side by side（46 s 起）。

### 结论

- 原生通过：新气泡立即上飘；收藏后继续上飘并顶部常驻；收藏后拖动原地驻留（Take 1）；未收藏不理会则消散（Take 2）；双击进板并选中对应 `node_id`（两条）。
- 仍未测：未收藏拖动后停 5 s 再恢复；取消收藏后恢复上飘。
- 成片 `spellcast-calendar-demo.mp4`（`BUILD-DEMO.ps1`，83.7 s，1920×1080）：只剪等待、部分加速、裁掉任务栏、加字幕与两张黑底卡（片头、下一功能预告）+ 6 s 片尾；无合成气泡。副本发布在 `docs/assets/spellcast-calendar-demo.mp4`。
- 未打新 tag、未出包。v0.2.1 安装包不含以上交互与观察机制。
