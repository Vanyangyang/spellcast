# 持久注释、紧凑作品与状态引用验收

2026-09-15：实现已完成并更新本地桌面版。此次没有提交或推送 Git；保留此前工作区改动。

## 用户现在可以做什么

- 选中内容或图片局部，打开「注释」并保存。注释有稳定身份、版本、当时内容的后端快照；可编辑、移除和恢复。图片圈注留在画布上，点击标记能找到说明。关系节点与关系线也有明确的子目标选择。
- 在注释中选择「讨论这条注释」，再使用画布底部的最终发送按钮。保存、恢复、选择讨论和本地作品操作均不会自行启动任务。发送时冻结注释内容，来源更新不覆盖旧快照。
- 在比较项和分镜步骤中附加同一 Idea 内作品的固定状态。引用记录原对象、内容、作品包和状态版本、参数及可选预览；原作品改变后仍展示所引用的旧状态。更新引用需要明确操作。
- 作品自动采用适合小演示的紧凑呈现，可切换完整显示。运行/停止与错误反馈常驻；导出、重新运行、源码及捕获入口收在「作品操作」。显示偏好可跨刷新保留。
- 作品通过 `spellcast.onSnapshot` 返回画面后，可「保存当前状态画面」。引用默认展示保存的画面；「重现保存状态」才运行只读沙箱，不能改写原作品。

## 验证

### 自动检查

- `cargo test -p spellcast-core -p spellcast-bridge`：58 + 91，共 149 项通过，0 失败。
- `npm run build`：TypeScript 与 Vite 成功。
- `node scripts/check-artifact-capture.mjs`：正常捕获、缺少回调、异步期间参数变化和只读行为通过。
- `node scripts/check-artifact-sdk.mjs`：通信通道身份、JSON 边界、不可变状态、选择与恢复通过。
- `node scripts/check-light-text.mjs`：安全轻量文字渲染通过。
- 桌面 Tauri 编译成功；`git diff --check` 通过。
- Rust 检查覆盖持久化重开、事务原子性、旧注释正文更新不重定向、软移除/恢复、伪造与跨来源拒绝、发送后冻结上下文、原来源删除后的上下文与接收任务，以及固定作品引用的直接入口与 batch 校验。

### Browser Use，真实隔离 Rust/SQLite

第一轮记录：`artifacts/durable-canvas-work/browser-1789474701215/evidence.json`。

- 真实点击新增注释并保存；发现并修正保存按钮没有提交表单的问题。
- 刷新后恢复草稿；保存、移除、恢复、选择讨论均保持 pending=0。
- 来源由 revision 1 更新至 2 后，面板显示「来源已更新」并保留 revision 1 的原文。
- 只有点击最终发送后 pending=1；实际事件 anchor 指向当前对象 revision 2，annotation_context 保留注释 revision 3、原 anchor revision 1 和原文。

最终作品与圈注记录：`artifacts/durable-canvas-work/browser-1789475212905/evidence.json`。

- 隔离作品正常加载；小演示自动紧凑显示，当前缩放下 iframe 高约 185 px。
- 用真实 slider 将 gap 从 15 改为 24，分别点击捕获画面。后端状态为 gap=24、state_revision=4，预览为实际 Canvas PNG（6038 个编码字符）。
- 比较和分镜旧引用仍为 gap=15；默认预览不会运行额外作品。明确只读重现后，画面显示 15 分钟，原作品仍为 24。
- 点击「引用当前已保存状态」并保存后，仅所编辑的比较项更新至 gap=24；旧分镜引用保留。
- 对比较项图片真实拖动框选，保存注释。后端保留稳定 option ID、归一化区域、图片资源和当时作品引用；画布显示可点击圈注。
- 重开后注释与快照仍在；完整显示偏好保留，原作品参数恢复到 24。停止操作移除运行 iframe并显示「已停止」。
- 最终该环境 pending=0。作品交互、捕获、状态引用修改、注释保存与查看均未启动模型。
- 修复了测试代理的 Host 转发，使作品通信脚本在原有 bundle 沙箱策略下正常加载；没有放宽生产安全策略。中间失败环境记录保留，最终环境已停止。

## 运行版更新

- 运行文件：`src-tauri/target/debug/spellcast.exe`。
- SHA256：`4467d3e2b8a6b06bb45a1c36a61857fd05ca323435de61bec99d05bfe4ad7703`。
- 更新结果：`artifacts/workbench-20260914/durable-expression-20260915/direct-result.json`，pass=true，production-running；核对时 PID=57724，仅一个主进程。
- 接入包：`spellcast@personal`，`0.3.0+sc.1cce033ba44d`；`plugin-verified.json` pass=true，已核对 Hook、Skill 与参考文件。
- 更新前后 `verify-workbench-runtime.mjs` 均通过：6 nodes、5 edges、1 reply、13 messages、12 objects、1 composition。未确认、重放或删除旧请求。
- 更新后原生 `spellcast_board` 成功返回新的 `canvas.annotations`；健康接口正常。
- 隔离进程与临时浏览器标签已关闭。生产版继续运行。

## 验证边界

- 本轮最终发送验收使用隔离接收任务；没有另开真实 Codex 对话验证新增注释的模型回复。此前真实 Codex 往返验收不冒充本轮注释上下文验收。
- 没有画面捕获回调的作品仍可保存和引用参数，会明确提示没有画面；不会伪造截图。
- 只读重现恢复保存参数，不承诺将动画逐像素冻结。永久保留的预览才是固定图像。
- 当前引用限同一个 Idea 的作品；文字注释支持对象或结构化子项，未声称提供任意文本字符范围编辑器。
