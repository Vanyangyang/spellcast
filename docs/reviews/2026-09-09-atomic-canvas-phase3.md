# 原子画布第三阶段：有限数据链的本机原生复验

状态：第三阶段工程实现已在先前轮次整合；本轮完成最终原生复验、同一测试库正常退出后再启动、以及第二阶段原生回归。未提交或推送。本记录不宣称真实用户创意工作、Codex 注入工具、或原生宿主 Agent 回传已验收。

## 最终实现（本轮未重写）

实现范围仍是既定的一条链：参数作品 → 图表作品 + 原生数值说明。

- 对象绑定、`Create.bindings`、`Bind`、32/256 上限、对象图 DAG、内容版本/用户保护与整批提案保持不变。
- 作品 `io.inputs/outputs` 仍为有限 `number|string|boolean|null`。输入运行快照不写回作品 `state`。
- 作品调用 SDK `publishOutputs(values, expectedInputRevision)`。宿主若有未落盘 state 则暂存候选，保存完成且代次/输入版本有效后才转发。旧输出、失败和停止会失效；重开先恢复作品自身状态，再等待新输出。
- 原生文字绑定只做无表达式的值显示，断开后保留原正文。
- 内嵌 Ask 在 `beforeAsk` 保存/刷新之后构建；历史草稿保留原上下文。
- ROUND2 第 11 项失败后，主代理已让 `DraftStore.getComposer` 先精确取键；多锚点 composer 在去掉 `anchors.inputs` 后其余引用/来源完全一致且唯一时才恢复，歧义保留。原 `draftKey` 与原 `anchors` 不合并。本轮使用的 `spellcast.exe`（`src-tauri/target/debug/spellcast.exe`，2026-09-09 16:05:13）已包含该修复；源码此后未再改动，故未重建。

本轮唯一脚本改动：`scripts/check-canvas-links.mjs` 的 `--verify-restart` 在等待潮位 8 与 Harbor 选区后，再按原多锚点恢复并断言未发送草稿 `UNSENT_LINKED_TIDE_DRAFT`。没有删除既有断言，也没有把真实输入换成直接处理器。

## 现场与旧轮次

核对当时没有 `spellcast.exe`，也没有 `47202/9342/47200/9340/47194` 监听。ROUND3 只有 `acceptance.sqlite3` 与 webview，没有 `result.json`/`failure.json`，上次启动被宿主中断，不能称通过。ROUND1/ROUND2 此前已正常关闭。用户库未动。旧轮次全部保留，本轮另建 `final/`。

ROUND1 曾因 `to.block_id` 的 `null` 与省略差别失败，脚本随后写明 `block_id:null`。ROUND2 前 10 项通过，第 11 项因 inputs 运行快照改变导致草稿键不匹配而失败；草稿修复后的构建用于本轮。

先记下差异：工作区仍是先前阶段及用户工作的 dirty/untracked 集合（26 个已跟踪文件改动，以及 canvas/artifacts/examples/scripts 等未跟踪文件）。未 reset、stash、rebase、amend、提交或推送。

## 验证

| 检查 | 结果 |
| --- | --- |
| 实现整合（主代理，原 brief） | 同一任务中由主代理实际完成：Rust 47 Bridge + 35 Core = 82、TypeScript、Vite/Tauri debug 构建、`check-canvas-dataflow.mjs` 与 `check-reply-drafts.mjs` 均通过。来源是原 brief，不是本轮 Grok 运行。本轮没有改这些产品源码，也没有再执行这些检查。 |
| 构建 | 源码 `src/main.ts`、`src/reply-drafts.ts` 最后写入 16:03:45，exe 16:05:13，前端 `dist` 16:04:56。本轮未改 Rust/TS 产品代码，未重建。 |
| 第三阶段原生 11 项 | [检查脚本](../../scripts/check-canvas-links.mjs) 退出码 0，11/11 通过，见 [result.json](../../artifacts/atomic-phase3-20260909/final/result.json) 与 [verified.png](../../artifacts/atomic-phase3-20260909/final/verified.png)。确定性 MCP 只用于样本创建/响应/确认；真实鼠标键盘走 Tauri WebView。 |
| 进程重启 | `CloseMainWindow` 正常退出码 0 后，同一 `acceptance.sqlite3` 与 WebView 目录重开。`--verify-restart` 退出码 0：对象、布局、绑定、作品 own state、Harbor 选区、未发送草稿保持；输入等待新输出后恢复 8。见同一 [result.json](../../artifacts/atomic-phase3-20260909/final/result.json)（`processRestart: true`）与 [restart-verified.png](../../artifacts/atomic-phase3-20260909/final/restart-verified.png)。 |
| 第二阶段原生回归 | 另一 fresh DB、`47200`/`9340` 上 [组成脚本](../../scripts/check-atomic-composition.mjs) 10/10 通过，退出码 0，见 [第二阶段结果](../../artifacts/atomic-phase3-20260909/phase2-regression/result.json)。 |
| SDK | [artifact SDK 脚本](../../scripts/check-artifact-sdk.mjs) 退出码 0，日志见 [check-artifact-sdk.log](../../artifacts/atomic-phase3-20260909/phase2-regression/check-artifact-sdk.log)。 |
| 用户库 | 未使用默认服务 `47194`。 |

第三阶段 11 项：

1. 一次原子批放置参数/图表、绑定声明端口，保留原生回退正文和无关便笺。
2. 默认潮位 4 传到图表和原生值，不替换已保存正文。
3. 真实输入改 7 再 8，Harbor 点击独立保存；图表 state 不持久化上游 tide/inputs。
4. 连接 UI 断开回到回退正文，再重连声明的 tide 输出。
5. `DIAG_ONLY producer error` 与真实 Stop 使下游不可用；Restart 和 Run 恢复潮位与选区。
6. 页面重开重算潮位 8 并恢复 Harbor。
7. `DIAG_ONLY producer artifact route abort` 只阻断上游 HTML，下游不可用且选区保留，Restart 恢复。
8. 仍打开的内联 Ask 在参数改 9 后发送得到 9 及正确版本，再还原 8。
9. 全局多锚点反馈携带图表选区、潮位 8 来源版本和原生联动值，不持久化 inputs。
10. 确定性 MCP listen / Canvas response / ack 记为 handled；**不断言原生 Agent 循环**。
11. 未发送多锚点草稿 `UNSENT_LINKED_TIDE_DRAFT` 在页面重开后找回，潮位 8 与 Harbor 仍在。

## 实际命令与进程

可执行文件：`G:\VibeProj\spellcast\src-tauri\target\debug\spellcast.exe`。Node：`C:\Program Files\nodejs\node.exe`。未改包清单。

第一次 `Start-Process -WindowStyle Hidden` 得到 PID 38016，health/CDP 已就绪；启动 shell 结束后 PID 与 CDP 消失。推测与启动 shell 的进程生命周期有关，未作产品崩溃归因，也没有直接的 Job Object 终止证据。之后用保活 shell 再启并通过，只操作已核实的测试 PID。

| 轮次 | PID | 端口 | 退出 |
| --- | --- | --- | --- |
| 11 项检查 | 50944（父保活 63740） | API 47202，CDP 9342 | `CloseMainWindow`，进程退出码 0 |
| 同库重启 | 3348（父保活 64428） | 同上，同一 DB/WebView | `CloseMainWindow`，进程退出码 0 |
| 第二阶段回归 | 56688（父保活 26936） | API 47200，CDP 9340 | `CloseMainWindow`，进程退出码 0 |

环境变量示例（第三阶段）：

```
SPELLCAST_STATE_FILE=<final>/acceptance.sqlite3
SPELLCAST_PORT=47202
WEBVIEW2_USER_DATA_FOLDER=<final>/webview
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9342
SPELLCAST_TEST_OUTPUT=<final>
SPELLCAST_CDP=http://127.0.0.1:9342
SPELLCAST_TEST_PORT=47202
```

检查命令：

```
node scripts/check-canvas-links.mjs                 # 退出码 0，11 项
node scripts/check-canvas-links.mjs --verify-restart # 退出码 0
node scripts/check-atomic-composition.mjs            # 退出码 0，10 项
node scripts/check-artifact-sdk.mjs                  # 退出码 0
```

Clash Verge 曾把 `192.168.1.3:9342` 用作出站临时端口；`127.0.0.1:9342` 仍可绑定。未结束任何非本测试进程。

## 产物路径

- 预检与启动：`artifacts/atomic-phase3-20260909/final/preflight.json`、`launch-1.json`、`ready-1.json`、`shutdown-1.json`
- 11 项：[result.json](../../artifacts/atomic-phase3-20260909/final/result.json)、[verified.png](../../artifacts/atomic-phase3-20260909/final/verified.png)、`check-canvas-links.log`（退出码 0）
- 重启：[restart-verified.png](../../artifacts/atomic-phase3-20260909/final/restart-verified.png)；同一 [result.json](../../artifacts/atomic-phase3-20260909/final/result.json) 含 `processRestart: true`；另有 `launch-restart.json`、`ready-restart.json`、`check-canvas-links-restart.log`、`shutdown-restart.json`
- 第二阶段回归：[result.json](../../artifacts/atomic-phase3-20260909/phase2-regression/result.json)、[SDK 日志](../../artifacts/atomic-phase3-20260909/phase2-regression/check-artifact-sdk.log)；目录内另有 `verified.png`、`proposal.png`、`check-atomic-composition.log`
- 保留未通过/中断轮次：`round1/`、`round2/`、`round3/`
- 样本：`examples/linked-tide/`

截图可读：重启近景可见潮位 8.0、港湾锚点选中、`tide → tide` / `tide → text` 连接、composer 中的 `UNSENT_LINKED_TIDE_DRAFT`。Fit all 缩小了总览，未为展示改布局。

## DIAG 故障标识

第三阶段脚本声明并实际注入：

- `DIAG_ONLY producer error`：作品内“模拟上游故障”走 `spellcast.reportError`。
- `DIAG_ONLY producer artifact route abort`：Playwright `page.route` 对上游作品 HTML 做 `connectionfailed` 中止，随后 `unroute`。

第二阶段回归另有 `DIAG_ONLY network abort` 与 `DIAG_ONLY corrupt native draft storage`。这些都不是用户故障，也不是原生 Agent 失败。

## 已知限制

- 只验证这一条声明端口链，不证明任意作品可自由联动，也没有通用响应式引擎或表达式绑定。
- 原生说明只显示标量；完整动态叙述仍留在作品内。
- 复杂双向计算应放在单个作品内。
- Fit all 后总览较小；对象级可用性仍要以真实创意工作为准。
- 检查脚本的样本创建、listen/response/ack 是确定性直接 MCP，**不能**称作原生宿主 Agent 运行。

## 未验证

当前主代理的原生 Spellcast 工具目录仍是空（`NOT_CALLABLE`）。未安装或改宿主插件，未操作其他项目的 Grok/Cursor 会话，未发送外部消息，也未新建 Codex 任务来绕过。因此：

- 原生宿主 Agent 回传：**未验证**
- Codex 注入工具 / 真实原任务唤醒：**未验证**
- 用户真实创意验收：**未验证**

检查过程中测试实例的 `/api/health` 出现过 `canvas-links-check 1`（本脚本）以及一个 `rmcp 3.2.0` 客户端。后者只说明有 MCP 传输连到隔离测试端口，仍然不是宿主工具注册或原任务回传。
