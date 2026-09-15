# Everything Canvas：实现与验收记录

日期：2026-09-07。对应用户已同意的[选型方案](2026-09-07-everything-canvas-options.md)。

开放 Web 作品容器及首批八个样本已落地。Windows 原生窗口中的交互、参数保存、源码恢复、历史版本、窄窗口、导出和重启恢复通过本机验证。早期快照中尚缺少新增工具的宿主注入；后续用户第 17 号反馈已通过当前 Codex 注册的原生工具完成作品读取、更新及确认，补上了这一层证据。

## 实现了什么

新增一种通用 `artifact` 块，复用原有 Canvas、版本化回复、阅读器和来源任务反馈。没有把选型矩阵变成十九种固定块或库白名单。HTML/CSS/JavaScript、SVG、Canvas、媒体与按需打包的库共同构成一个作品目录。

- 源码、编译产物和素材进入 SQLite 不可变资源记录，保存文件哈希、来源、入口和历史版本。发布新版本不会覆盖旧资源，也不会清空当前用户参数。
- 内容版本与参数版本分开。参数、备注、视角和选区通过窄消息接口保存；这些操作本身不请求模型。显式“提问”才产生反馈，并携带发送时的确切 bundle 与状态。
- 阅读器提供停止、重新运行、源码编辑、保存、历史恢复和 ZIP 导出。异步切换文件时立即清空旧编辑器；源码草稿与旧版绑定，遇到外部更新时保留草稿并禁用过期保存。
- 参数保存失败保留本地输入，提供查看当前状态、合并草稿与显式保存。编辑恢复期间不会用新运行实例覆盖未处理的本地草稿。
- 构建脚本收集原始源码、构建器、锁文件、使用中的依赖版本与许可证；输出到新目录，不覆盖已有目录。已有 Three.js 继续复用。

制作接口、限制与例子见[使用说明](../everything-canvas.md)；随仓库提供的 [Spellcast skill](../../skills/spellcast/SKILL.md) 已更新并通过验证器。没有改动用户全局安装的 skill，也没有提交或推送 Git。

## 八个代表性作品

以下输入通过 Windows WebView2 中的实际点击、键盘、选择框与鼠标拖动完成。数据和简化假设写在各自页面上。这些是验证人员发起的检查，不是外部用户验收。

| 作品 | 实际使用 | 本机通过的检查 |
| --- | --- | --- |
| [搜索过程](../../examples/artifacts/search) | SVG、Mermaid 11.17.2 | 40 个格子、23 个搜索快照；逐步、播放、暂停、重新开始和格子选择；最短路径为 11 步 |
| [数据联动](../../examples/artifacts/data) | ECharts 6.1.0、Tabulator 6.5.2 | 筛选住宅得到 3 行、合计 608；选择庭院公寓及排序同步保存，图表保持同一数据范围 |
| [公式与摆动](../../examples/artifacts/math) | KaTeX 0.18.7、SVG | 摆长 3 m 时周期约 3.475 s；MathML、播放暂停与摆锤选择。模型限于小角度近似 |
| [装配关系](../../examples/artifacts/assembly) | Three.js 0.170.0、实际 GLB | 五个具名部件；100% 展开、侧视、真实鼠标旋转和适应模型；实际 WebGL 2.0 上下文 |
| [图像共创](../../examples/artifacts/image) | 两次实际 ImageGen 输出、原生图像控件 | 原图与琥珀顶编辑版对照；35% 分割、鼠标圈选与数值输入同步；保存素材版本和归一化坐标 |
| [音视频](../../examples/artifacts/media) | 实际 MP4、WAV、原生媒体和 Web Audio | 8 秒视频播放、暂停、选段及循环回绕；音频实际播放与波形；模式切换清除旧范围 |
| [交互工具](../../examples/artifacts/tool) | 原生 HTML/SVG | 80 × 40 × 0.75 = 2400 L；储水箱选区、备注、CSV/SVG 下载和参数保存 |
| [研究报告](../../examples/artifacts/report) | Markdown、KaTeX、实际图像及 PDF | 四章、可定位章节、MathML；两页 PDF 渲染复核，原生窗口下载成功 |

图像提示词、生成方式和文件哈希见[素材来源](../../examples/artifacts/image/provenance.md)。GLB 是教学几何模型；雨水数据、媒体与报告是构造样本，不代表工程测量或科学预测。

## 保存、恢复和交付证据

运行环境是仓库最新 Windows debug 原生构建、真实 WebView2，使用独立的 `artifacts/canvas-hardening/acceptance.sqlite3`。API 为 47194，验收 CDP 为 9337。原有其他回复和用户节点在发布前后逐项比较保持不变；没有改动真实用户数据库。

| 检查 | 结果与证据 |
| --- | --- |
| 八个作品的原生输入与持久状态 | 全部通过；[脚本](../../scripts/check-native-artifacts.mjs)、[结果](../../artifacts/everything-canvas/native-checks/latest-checks.json) |
| 保存失败与源码更新相撞 | 未保存的 `amount=40` 和备注可查看、编辑合并并恢复；[恢复结果](../../artifacts/everything-canvas/recovery-checks/result.json) |
| 切换源文件、编辑源码与历史恢复 | 延迟读取期间旧内容立即清空、保存禁用；保存新源码保留参数；外部改版保留旧草稿，回到旧版本后可恢复 |
| 停止与重新运行 | 停止后 iframe 数量为 0；重新运行恢复已保存备注与参数 |
| 880×640 原生窗口 | 使用 Tauri 窗口 API 实际改尺寸，八个作品均未出现横向溢出；截图已检查；恢复原 1320×860 尺寸 |
| 下载 | 原生点击实际保存 CSV、SVG、PDF 和 ZIP；读取文件验证格式与内容 |
| ZIP 独立运行 | ZIP 含 19 个文件、原始入口、manifest、状态、源码和 SDK；解压后由本地服务器提供，在独立 Chrome 中恢复 2400 L 与备注 |
| 完整重启 | 正常关闭并重新打开原生程序；持久化回复、节点和状态逐项相等，八个作品重新渲染 |

交付与重启的可运行检查见 [check-artifact-delivery.mjs](../../scripts/check-artifact-delivery.mjs)，结果见 [delivery-checks/result.json](../../artifacts/everything-canvas/delivery-checks/result.json) 与 [after-restart.json](../../artifacts/everything-canvas/delivery-checks/after-restart.json)。测试脚本连接明确的验收数据库运行实例；故障脚本使用未绑定 Agent 的独立来源。不要把这些针对样本的脚本直接指向真实用户工作。

故障注入明确标为 **DIAG_ONLY**：人为中断参数请求、延迟读取第二个源文件。输入动作本身使用真实控件。检查用源码草稿只清理了精确匹配的自有测试值；历史资源仍保留，恢复测试卡已换成结果说明。

发现并修正的交付问题包括：图像拖选后数值字段过期、三维底座被地面遮住、源码切换时旧输入可误保存、源码草稿遇改版的覆盖风险、沙箱 PDF 下载链接失效、导出 HTML 重复 doctype 导致 Vite 拒绝解析。相关路径已重跑。

## MCP 与反馈：分别记录两层证据

1. **正在运行的服务：通过。** 直接 MCP 客户端完成 initialize、tools/list、`spellcast_artifact_read` 元数据与源文件读取，以及 `spellcast_artifact` 发布。两个新工具真实存在于服务目录中。[可运行协议检查](../../scripts/check-artifact-mcp.mjs)、[结果](../../artifacts/everything-canvas/mcp-checks/result.json)。
2. **当前 Codex 任务的工具注入：第 17 号反馈复验通过。** 早期目录只有十四个旧工具，新增工具当时为 NOT_CALLABLE。后续真实用户在图像作品圈选并提出“把这里换成一个游泳池？”，请求排入本任务；本任务使用注册的原生 `spellcast_listen`、`spellcast_board` 和 `spellcast_artifact_read` 核对待处理序号、精确 bundle、源文件与选区，经内置 ImageGen 编辑后，用原生 `spellcast_artifact(feedback_sequences=[17])` 更新同一 reply/block。核对原生窗口新图加载、状态和布局未变后，原生 `spellcast_ack` 返回 acknowledged=1，后续 listen 的 pending_sequences 为空。该回合未以 HTTP 或独立 MCP 客户端替代宿主工具。[本次记录](../../artifacts/everything-canvas/image-pool-seq17-verification.json)。

使用当前绑定任务的工具作品进行了第 10 号反馈检查。验收人员通过原生“提问”控件提交明确的检查文字；当前任务的原生 `spellcast_listen` 收到确切作品版本、储水箱选区、面积 80、降雨 40、效率 75、容量 5000 和已有备注。随后直接 MCP 客户端更新同一作品简介，保持源码、参数、其他回复及节点；主任务在原生窗口核对结果后，通过原生 `spellcast_ack` 确认处理。

实际回执字段：`phase=handled`；`queued_id=01a07c10-eb26-7642-9450-078de07ca4a2`；`queued_at_ms=1788787878755`；`received_at_ms=1788787879270`；`responded_at_ms=1788787951529`；`handled_at_ms=1788787985532`；`response_reply_id=everything-tool-20260907`。本来源已无待处理反馈。

这证明保存、排队、原生读取、直接 MCP 更新、原生确认这条混合路径；不是两个新增工具已经在 Codex 原生目录中可调用的证明，也不是等待自动唤醒后才完成的独立新回合。此前第 7 号反馈的自动回合证据属于已有结构块路径。若稍后收到第 10 号已排队通知，应按回执跳过，不重复制作。

## 验证边界

- 浏览器 sandbox、资源路径 CSP、父层 frame-src 与 MessageChannel 共同限制运行边界。实际原生检查中，非法 JSON 状态、访问宿主 API 与跳转外网被阻止。更早的限时 Tauri 调用探针未造成节点写入；这不是完整的原生 IPC 安全审计，也不能外推到其他操作系统。浏览器与 Tauri 的规则分别见 [MDN sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox) 和 [Tauri capabilities](https://v2.tauri.app/security/capabilities/)。
- 导入限制为 2048 文件、单文件 128 MiB、总计 256 MiB；状态限制为 64 KB JSON 对象。文件读取和路径边界在宿主验证，作品运行时不使用外部 CDN，也不拥有通用宿主命令接口。
- 只验收了上表的库和组合。更多科学绘图、地图、二维编辑与计算引擎仍按需求验证；没有宣称所有库都可无修改运行、完整 IDE、多用户实时合编、全平台兼容或性能基准达标。
- ZIP 当前在内存中生成；已验证约 18.6 MB 报告 ZIP 和交互工具 ZIP，没有进行 256 MiB 压力测试。图像是实际栅格版本与区域选区，不是虚构的可编辑图层。

## 可复验检查

`npm run build` 和 Windows 原生构建通过；Rust 工作区 56 个测试通过；`cargo fmt --all -- --check`、`git diff --check`、源码草稿检查、Artifact SDK 检查及 skill 验证通过。SDK 检查覆盖消息来源身份、JSON 边界、不可变状态快照、选区与恢复。

本机产物：[PDF](../../output/pdf/rain-garden-report.pdf)、[CSV/SVG/ZIP 下载目录](../../artifacts/everything-canvas/delivery-checks/downloads)、[原生截图](../../artifacts/everything-canvas/native-checks)、[窄窗口与重启证据](../../artifacts/everything-canvas/delivery-checks)。这些文件是本机验证结果；Git 的提交、发布、宿主工具刷新与其他系统验收未在此记录中冒充完成。
