# Spellcast Agent 指导适配优化

文件路径保持 `docs/reviews/2026-09-12-guidance-slimming.md`。这是**指导适配**，不是新增功能、新开关或新授权步骤。目标是更适合模型与 Spellcast 的工作方式。字符只是诊断指标，不能作为成败标准。先前只读推演**不能**证明真实效果。

本轮没有安装到用户目录或插件缓存，没有重启或触碰正在运行的 Spellcast、其数据、Hooks 或 Codex 任务。当前运行宿主仍加载旧 MCP 元数据；源码候选未安装、未 commit/push。真实 token / 耗时 / 采纳率未知。

## 评判标准（优先于字数）

1. **正确自主触发**：工作中出现方案、新证据或新约束等实质上下文时可以提交短快照；不是每个请求或每次工具调用。
2. **上下文足够**：快照有项目信息；unknown 不是 OFF；过时 OFF 可在下一次实质上下文时刷新。
3. **表达质量**：旁念有独立价值或合法沉默，不是进度复述。
4. **主任务连续**：主任务不等待 child；不把 observer 推理内联进主任务。
5. **数据与用户意图可靠**：App 旁念开关是运行权威（关闭由现有程序使旧票据失效）；源级任务结束/项目切换用现有 `snapshot=null` 清理。编辑保护与 ack 边界保持。

## 本轮层级纠正

- `description`：`Use connected Spellcast for independent asides as fresh project context emerges during ongoing work, or for its Canvas, task feedback, and explicit memory.` 入口只写能力与适用场景。已删除「无需每次点名」等解释句。仍为隐式调用，未改成 explicit-only，未削弱主动旁念。
- 根：App 开关为权威；状态缺失/过时才轻量发现；`allowed` 门控；主任务继续。把「合适项目检查点」改成 Agent 决策条件（方案 / 新证据 / 新约束为例，非固定阶段表，用户不声明检查点）。源级 `snapshot=null` 从根删除反复控制口吻，指路 [references/asides.md](../../skills/spellcast/references/asides.md)。
- `references/asides.md`：保留 `spellcast_checkpoint` 真名与 `checkpoint_id` 等协议。Source lifecycle 段写明 `snapshot=null` 是该 source 观察工作的内部清理（任务结束/项目切换），不是与 UI 并列的第二套用户控制。UI 关闭不依赖 Agent 再发 null。
- MCP `INSTRUCTIONS`：状态发现与 `allowed`/`ready` 门控；不含「用户说停止优先」控制流程。`checkpoint` tool description 保留 `snapshot=null` 源生命周期，并写明 App 开关关闭不要求该调用。
- 未改 UI、handler、installer、package、其他 refs、Hooks。未创造任务级设置。

原始 dirty 基线：`artifacts/spellcast-guidance-20260912/baseline/`。适配前实现：`artifacts/spellcast-guidance-20260912/before-adaptation/`。均未覆盖。

## 历史数字（纠正后候选 / 适配前；诊断）

root 17518→3516，description 359→175，INSTRUCTIONS 7529→1298。完整 root+全部 refs 当时 18909（baseline 单 root 17518）。不表示所有任务总读取量下降。

## 当前数字（层级纠正后；诊断，非成败）

见 `artifacts/spellcast-guidance-20260912/metrics.json`（本轮刷新）：description 155，root 3902，INSTRUCTIONS 1673，tool description 合计 5486。按需 root+单个 ref：旁念 9866，Canvas 7064，works 7203，feedback 7508。完整 root+全部 refs 19935。18 倍估算只覆盖 instructions+description 文案（instructions×18 = 30114；加 description 合计 35600），未覆盖 schemas / 实际注入缓存。字数变化或推演一致**不能**宣称实际效果更好或无损。

## 已查证的隔离验证

| 检查 | 结果 |
| --- | --- |
| `quick_validate.py skills/spellcast` | Skill is valid（本轮重跑） |
| Skill 内相对引用 | 4/4 |
| `cargo test` installer | 3 passed（历史；installer 未改，本轮未重跑） |
| `node scripts/check-package-codex-plugin.mjs` | package checks ok（本轮重跑） |
| `cargo check -p spellcast-bridge` | exit 0（本轮重跑） |

## 只读决策推演（历史事实；非真实效果）

下列均是说明决策推演：**不是** Astra 真实宿主 A/B，**不是**原生队列/旁念验收，没有可见气泡，没有 token/耗时/采纳率实测，**不能证明更好或无损**。没有调用产品工具。

**两种现有机制不要混成一步：** UI 旁念开关 OFF 由运行实例 `invalidate_all` 使待处理票据失效，后续 complete 为 stale，不依赖 Agent 再发 `snapshot=null`。`snapshot=null` 是该 source 观察工作的内部生命周期清理（任务结束 / 项目切换 / 停止该 source 的观察）。不要把「聊天里再说一次停止」写成产品必须另有的控制步骤。

### 先前 6 场景（baseline vs 当时 candidate）

关键决策一致：1 纯产品讨论留在主对话；2 已有 ready 只交 brief 给无历史 child；3 多来源 anchors 只回应 task-a；4 未 ack 的旧 sequence 仍处理；5 artifact 锚点与独立 state；6 kept 不自动展开或记忆。

### 当时 root+asides 5 场景

开关未知会查 status；旧 OFF 遇新实质上下文会刷新；App 关闭后不再调度；在途 child 在当时文案下拟 `snapshot=null`（现已澄清：UI OFF 不要求该调用）；对 Spellcast 本身的实质讨论在 allowed 时也可旁念。这些推演没有显示「现版必须每次点名」的运行故障。

### MCP 说明层 3 场景（当时 INSTRUCTIONS + observer tools）

A 新证据+未知开关→拟读 status，只有 allowed 且 ready 才 child。B 当时文案下用户 stop→拟 `checkpoint(..., snapshot=null)`，App 仍 ON 不改变——保留为当时推演事实，不把它升级成产品必须的聊天停止步骤。C 仅 memory→remember，不 bind、不查 observer。

## 后续实际宿主验收清单（本次未通过、未执行）

- 冷启动 / 未知状态：在**工作中首次出现方案、新证据或新约束**时判定是否轻量读 status。不要求每个普通请求都做前置检查。
- App OFF→ON 后再次出现实质上下文：是否刷新并发现开关变化。
- App ON→OFF：关闭后旧票据 / 在途旁念不再投递。这是程序保障；不要把 parent 是否发出 `snapshot=null` 当作唯一判据。
- 任务结束或项目切换：该 source 的观察工作是否用现有 `snapshot=null` 做内部清理。
- 真实有价值旁念与合法沉默：主任务是否继续、是否被拖住。
- 采纳 → Canvas → 原任务反馈闭环是否仍按既有协议工作。
