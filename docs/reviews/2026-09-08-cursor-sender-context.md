# Cursor Bridge 调用方身份与评审来源

## 5.10.0：显式来源接口已发布

[Cursor Bridge 5.10.0](https://github.com/Vanyangyang/cursor-bridge/releases/tag/cursor-bridge--v5.10.0) 已发布，远端 main 与标签均指向 `ad41781a4816bb3855397bfb5b994db59cca9043`，主代理已核对 GitHub 发布页与远端引用。独立修复任务后来收到用户新增授权，实现并发布了这一接口；它不是本任务擅自扩展工作区修复范围。

CCE 与 `cursor_do` 新增每次独立的 `request_context`：

```json
{"request_context":{"sender":"model","source":"mixed"}}
```

`sender` 表示直接发送者（user/model/unknown），`source` 表示要求来源（user/model/mixed/unknown）。AI 主代理使用 `sender=model`；同时包含用户要求与主代理补充时使用 `source=mixed`，正文继续分别标明。Bridge 自动加入来源前缀，在任务状态回显 `requestContext`；缺省为 unknown，不继承上一轮。

这些仍是调用方声明，不是身份认证、额外授权或模型路由。发布任务报告核心 237/237、Supervisor 118/118 及协议/打包检查通过，详见 [5.10.0 发布核验](C:/Users/Administrator/Documents/Codex/2026-09-08/cursor-bridge-workspace-fix/outputs/5.10.0-verification.md)。

本任务当前原生 MCP 仍报告 `pluginVersion=5.9.1`、`adapterPid=43444`，工具 schema 尚无 `request_context`。此前两轮 Fable 评审使用手写来源前缀；其成功不能代替 5.10.0 新接口的宿主加载与实际发送验收。已安装新版与已运行连接是不同状态。

## 5.9.1：历史核查与可用办法

本次身份核查为只读，没有为此修改模型偏好或公共身份接口。之后的工作区识别修复是独立任务，已提交为 `894c64c5`；它没有引入自动调用方身份协议。

当时已核对本机源码与安装的 5.9.1 构建。该版本的 `cursor_do` 接收一段 `prompt`，附加语言要求、只读或允许写入的路径，以及验收/报告要求，再放入队列。它没有自动标明上游调用方是 AI，也没有把用户原话、用户已确认约束和主代理提案分成独立来源。CCE 提示词提到 caller，但同样没有声明调用方身份。

最初核查时的源码位置（修复前）：`C:/Users/Administrator/plugins/cursor-bridge/server.mjs:117`、`:174`、`:2080`。当时已安装 `.codex-plugin/plugin.json:14` 指向 `dist/cursor-bridge.mjs`，对应构建逻辑为 `:22649`、`:22689`、`:24456`。修复后再次核对 `server.mjs:2183–2188`，组装仍是 prompt 加语言、只读/路径及验收要求，未自动加入 AI 调用方声明。

建议把责任分成两层：

- Bridge 负责中性的来源信息：这是经 Bridge 传来的上游任务；只报告实际可知的客户端/会话信息。无法确认调用方是人还是 AI 时，保留 unknown，不从提示词语气或模型名称猜测。
- 主代理负责内容的来源与用途：明确自己是 AI；单列用户原话与已确认要求；将自己的推断和待评审方案标为候选；明确要求独立判断和基于证据的反对意见。

最小可用办法是统一的提示词开头，暂不需要增加模型人格、模型高低排序或复杂角色系统。例如本轮已经使用的表达：

> 这是由 Codex 主代理（AI）通过 Cursor Bridge 发出的独立评审请求，不是用户逐字写的指令。你是独立评审伙伴；主代理负责整合与最终决策。请依据用户目标和实际源码判断，允许明确反对主代理的假设，不要把发送者的身份或表述当作方案正确的证据。

随后分别放置“用户已确认内容”“主代理工作假设”“评审问题”“只读范围和验收要求”。仅增加“我也是模型”这句话不能保证评审独立；这里能直接改善的是信息来源与授权边界的准确性。是否进一步改善评审质量，需要用实际评审结果比较，不能提前宣称已消除偏差。

## 历史失败与后续成功

最初真实调用 `cursor_do`，任务 `cursor-mtrh0qbj-2`，配置为 `Claude Fable 5.1 / high`、FIFO、isolated、read_only=true。随后按此 task_id 查询 `cursor_status`，终态为 failed：

```text
modelSelection.applied = false
modelSelection.errorCode = CURSOR_MODEL_PROBE_ERROR
error = Cursor model picker did not close after selection
sendState = not_sent
sentAt = null
result = null
```

因此该次请求没有到达 Fable，当时不能宣称已有 Cursor 意见或双方达成一致。保留原模型偏好，没有改成 Auto，也没有用 GUI 发送代替 `cursor_do`。

用户要求重试后，新任务 `cursor-mtrhmm4g-3` 仍为 failed / not_sent，但失败原因变为 `repository_not_found`。运行时报告 wanted=`spellcast`，可选仓库包含 `flyingmoonc/spellcast` 和多个 `vanyangyang/spellcast`。本地 `git remote get-url origin` 实际为 `https://origin.cursor.com/git/flyingmoonc/spellcast`，因此不能随意选择另一个同名仓库。

当时重新执行 `cursor_init(G:/VibeProj/spellcast)` 返回 ready；修复前 `server.mjs:746-773` 只取本地路径 basename，与仓库标题完全相等比较。此逻辑随后已由独立修复任务替换为精确工作区和 Agent 环境验证；初始化成功不单独证明提示已发送。

修复并重载后，`cursor-mts3jb97-1` 与 `cursor-mts3wi7g-2` 均经原生宿主完成 `sent → completed`，实际为 Fable 5.1/high。两次提示都由主代理明确声明 AI 身份、区分用户原话与自身假设，并要求独立反驳。结果确实提出了分歧，但这不构成“声明 AI 身份导致评审更好”的因果证据。详见 [原生验收记录](2026-09-08-cursor-native-acceptance.md) 与 [收敛方案](2026-09-08-atomic-canvas-decision.md)。
