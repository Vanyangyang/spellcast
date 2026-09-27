# 游戏工作台：关联、候选与试走验收

日期：2026-09-26。本地版本号保持 0.4.12，已重新构建、安装并启动。

## 交付范围

- 内容、规则、钩子关联到流程步骤或选择，支持双向定位。
- 独立数值候选及版本；保存候选不改动当前参数。
- 项目中保存不可变试走、来源快照、实际初值、选择与手动输入。
- 按基准选择重放，展示第一处分歧，显式复用的外部结果标为手动假设。
- 采用候选时保存理由、参数版本、候选版本及所选试走依据；保留局部覆盖。
- 原 Canvas 入口和代码保留；没有导入旧 VESPERIX 配置或填写假设的 R0–R2 内容。

实施契约见 `docs/game-workbench-linked-trials-contract.md`。

## 交付后复核与修正

Claude 第一轮交付通过原测试，但主任务及独立审查确认两个持久化校验缺口：初值可冒充来源，选择结果未按定义重算。交回同一 Claude 会话修正：

- 每个变量必须有唯一来源，按手动初值、局部值、候选、共用值、流程初值的实际优先级核对值与身份。
- 后端按冻结定义重算条件和 set/add/subtract；右侧读选择前状态，同一目标依次累计，拒绝非有限结果。
- 保存和导入共用语义校验。篡改后即使重新计算摘要仍会被拒绝，不产生部分记录。
- 现有 `serde_json` 启用 `float_roundtrip`，使 JSON 双精度输入能与前端精确对应；没有新增依赖，Cargo.lock 未变。
- 主任务补齐 JavaScript 与 Rust 对粘贴数字边界空白的兼容，并加入有效 BOM、无效 NEXT LINE 用例。

另由独立审查者在独立文件范围修正界面，主任务集成：

- 未用候选的记录不再冒称共用值；可进入冻结的初值来源详情。
- 未保存的零动作试走在替换前也保存。
- 重放设置和启动共同拒绝缺失、归档或发生版本变化的候选，提示用户重新选择。
- 手动结果复用检查有意义的执行、输入来源、依赖和关联位置差异，不把锁标记变化算作执行变化。
- 查看关联对象后返回，保留所选试走、重放设置和流程位置。
- 采用依据显示候选版本；只有 ID 和版本同时匹配才标为匹配。
- 安装检查补上三类新数据与数据库完整性；不再输出未经观测的“零请求”常量。

## 主任务实际复跑

| 检查 | 结果 |
| --- | --- |
| TypeScript `--noEmit` | 通过 |
| `cargo test -p spellcast-bridge --lib` | 128 通过 |
| `cargo build -p spellcast-server` | 通过 |
| `check-game-flow-model.mjs` | 通过 |
| `check-game-flow-trials.mjs` | 通过 |
| `check-workbench-review-fixes.mjs` | 通过 |
| `check-workbench-trials-restart.mjs` | 通过，真实隔离 server，7 条试走重启、导出及导入 |
| `check-project-record-restart.mjs` | 通过，隔离 REST/MCP 与真实进程重启 |
| Vite build | 通过，保留已有包体积提醒 |
| `check-project-record-workspace.mjs` | 通过，最终构建，端口 47406，含 1920/1320/880 窗口检查 |
| Tauri NSIS build | 通过，保留已有 Rust 未使用代码提醒 |
| 安装程序 | 退出码 0 |
| 更新后的 `check-planning-install.mjs` | 通过 |

浏览器夹具中的两个 HTTP 400 来自预期的拒绝路径，脚本整体通过。截图位于 `artifacts/project-record-workspace/ui/workbench-*.png`。

## 本地安装与数据

- 安装包：`src-tauri/target/release/bundle/nsis/Spellcast_0.4.12_x64-setup.exe`。
- 安装程序：`C:/Users/Administrator/AppData/Local/Spellcast/spellcast.exe`。
- 已核对新进程实际监听 47194，程序路径为上述安装路径。
- 安装版 SHA-256：`e0fe1a4f1336d4285e5d424fc7b553bc18013d1763c4a0f88a94a8489468c254`。
- 源码构建与安装程序在 Tauri 包类型标记归一化后相同；源码、用户活动技能和安装资源指南哈希一致。
- 项目结构版本从 3 升至 4；真实数据库关闭后只读 `PRAGMA quick_check` 为 `ok`。
- 运行中的应用独占数据库，因此首次直接只读检查报 `database is locked`。关闭应用后检查成功，并复制关闭状态的升级后快照；重新启动后完成 API 与安装前数据对比。
- 原有 51 个 Canvas 对象，以及 1 个项目、1 个开发对象、2 条记录、4 条历史与安装前一致；Canvas 对比包含完整 canvas/replies/nodes/edges/messages/topic/form/form_reason。
- 真实项目没有候选、试走或采用记录，均为 0；新增数据的持久性由隔离真实服务检查验证，没有向真实项目写入测试内容。

安装前备份（旧程序、数据库及两份指南）：

`G:/VibeProj/spellcast/artifacts/linked-trials-backup-20260926-033809`

升级后关闭状态数据库快照：该目录的 `post-install/`。旧程序不支持 v4 数据库，回退需使用对应的安装前程序与数据库备份。

## 验证边界

- 以上证明工作台数据与模型行为；没有真实 R0–R2 内容、Unity 运行或玩家体验验收。
- 没有通过原生窗口自动化检查安装版的每个控件；界面交互证据来自最终构建的浏览器夹具。
- 第一轮报告的旧 `check-project-game-ui`（等待已下线视图）及 `check-i18n` 完成提醒英文检查未在本轮重跑，不宣称整个仓库所有检查全绿。
- 后端重算条件、数值结果与来源，但未逐项核算重放进度/分歧标签是否完全符合基准意图；手动结果仍是明确输入。
- 试走暂不支持删除/归档，大列表性能没有专门验收；本轮不扩展该范围。
- 没有提交、推送或远端发布。

## 执行证据

- Claude 会话：`41e724bd-5e47-4908-ba4c-3a535c4bb857`。
- 实施 run：`79206a18-4698-4653-a654-6c9d12e743a4`；结果为完成，证据来源 `hook`。
- 校验修复 run：`e20ca7c6-845e-4b8a-9a74-4954572a1efe`；prompt `03085e23-c984-493b-a95e-7c0374192232`；结果为完成，证据来源 `hook`，主任务已读取完整回复并确认回执。
- Claude 负责主要实现及后端修复；独立审查者负责明确列出的界面修复；主任务负责取舍、补充修正、独立复跑、打包安装及最终验收。
