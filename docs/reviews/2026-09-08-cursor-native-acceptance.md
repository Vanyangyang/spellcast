# Cursor Bridge 原生宿主验收记录

状态：本条只读任务的原生端到端验收通过，已收到 Fable 的独立源码评审。工作区修复最初推送为 `894c64c5bb982b3d03b4ab4f41f99dd8c448c97c`，当时尚无新发行版本；后来独立修复任务依用户新增要求发布 [5.10.0](https://github.com/Vanyangyang/cursor-bridge/releases/tag/cursor-bridge--v5.10.0)，含该修复与来源声明接口。本文实测仍针对 5.9.1 本机补丁，不代替 5.10.0 新接口的原生验收，也不代表画布新方案已实现。

- 调用入口：当前 Codex 任务直接调用公开 `cursor_status → cursor_init → cursor_status → cursor_do → cursor_status(task_id)`，不是独立 stdio 客户端。
- 缓存 SHA-256：`EFF4DEFCDEC054AAD2DDC2775837A40C279BE48C88BBA5EAF1639D613C327E2A`。文件写入时间 `2026-09-08T03:06:43.7333614Z`。
- MCP adapter PID：`43444`，启动时间 `2026-09-08T03:13:03.9532140Z`，晚于缓存更新。协议版本仍是 `5.9.1`，这是本机待发布补丁。
- 初始化：`ready=true`，`workspace_ready`，`g:/vibeproj/spellcast`，`environment=local`，`identitySource=registered_workspace_file_uri`，`workspaceId=430a41bb21d42103e6230e4b6a09aa85`。
- 只读任务：`cursor-mts3jb97-1`，`execution=fifo`，`sessionMode=isolated`，无允许写入路径。
- 模型：`requestedModel=Claude Fable 5.1`，`requestedEffort=high`，`effectiveModel=Claude Fable 5.1 High`，`effectiveEffort=high`，`applied=true`，验证时间 `2026-09-08T03:14:53.393Z`。
- `before_create / after_create / before_fill / before_send` 均为 `ok=true`，使用相同工作区 ID 和精确本地 URI。
- 新建草稿身份：`local:d8326f14-7714-4fdb-9d92-2497b0422c2f`；运行任务身份：`local:19a3849b-fe91-4eab-9fb1-a109cf07c87e`。Bridge 的 `provisionalAgentId` 保留前者，`agentId` 跟踪后者。
- `sendState=sent`，`sentAt=2026-09-08T03:14:55.085Z`；最终 `status=completed`、`phase=completed`、`error=null`、`reservationHeld=false`，`resultCollectedAt=2026-09-08T03:19:10.955Z`。

评审提示明确声明发送方是 Codex AI 主代理，区分用户原话与主代理待验证假设，要求 Cursor 独立反驳并保持只读；没有将发送方身份作为正确性证据。

## 结果核对

1. 同一 task ID 回收到完整结果，保留原始模型、身份检查和回复字段于 [原生结果](../../output/acceptance/cursor-native-review-20260908.json)。
2. 主代理核对了返回的 `src/canvas.ts:286` / `:295` / `:104` 的 addFrame/inert/openReader 行为，以及 `spellcast-core/src/canvas.rs:59` 的 CanvasLayout::sync 键与自动布局行为。它们与本地未提交文件一致，包含提示中未提供的具体源码细节。
3. 进一步核对 `reply.rs:389` 的回复级版本检查、`:399` 的用户状态保留范围、`:523` 与 `:564` 的实际检查点，`inbox.rs:8` 的单锚点事件以及 `artifact-runtime.js:27` 的选区状态存储。源码事实可支持评审；建议仍由主代理判断。
4. `src/canvas.ts`、`src/reply-types.ts`、`spellcast-core/src/canvas.rs`、`spellcast-core/src/reply.rs` 在发送后采样与回收后 SHA-256 一致。Cursor 声明未改文件、Git 或用户画布；主代理本轮只修改评审文档并保存验收记录。这不是对整台机器所有写入的审计。
5. 原修复任务在已有用户授权范围内完成审查、提交与推送，并报告最终全量 231/231 检查通过；只提交 server、构建入口及两个相关测试文件，保留原 marketplace 脏改动。详见该任务的 [最终报告](C:/Users/Administrator/Documents/Codex/2026-09-08/cursor-bridge-workspace-fix/outputs/final-verification.md)。父任务独立核实了远端提交，未重复运行子任务的全量测试。
