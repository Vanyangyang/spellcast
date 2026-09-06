# Spellcast

**给 AI 一个发挥创造力的 Everything 板。**

> **Spellcast 仍在孵化中。** 这是初期演示 demo，目前提供的是体验测试版本，不是成品；成品敬请期待。
> Early demo · Experimental preview · Stay tuned for the full release.

想听听你的 Astra 对项目有什么吐槽？想让它帮你记起忙着忙着忘掉的事？想接住一次意料之外的灵光一闪？

试试 **Spellcast**。Agent 继续处理你的任务，与任务相关的吐槽、提醒和灵感，会从你当前操作的显示器上冒出来，不必切回 Agent 窗口。喜欢哪个，就收进板里，用文字、对比、关系图和分镜继续展开。

[English](README.md) · 简体中文 · [下载体验版（Windows / macOS）](https://github.com/Vanyangyang/spellcast/releases/latest)

https://github.com/user-attachments/assets/ab418e8c-b98c-4e39-a224-8a5227fef105

真实 Windows 桌面、真实鼠标操作，只剪掉了等待，没有任何合成。

## 体验版现在到哪了

- **已发布的构建：** [0.2.0](https://github.com/Vanyangyang/spellcast/releases/tag/v0.2.0)，含 Windows x64 安装包和 Apple Silicon、Intel 两个 `.dmg`。只有 Windows 经过人工验证，macOS 构建仅通过 CI 打包。
- **已在 `main`、尚未出包：** 气泡跟随你前台窗口所在的显示器；收藏后的气泡拖到哪就停在哪，未收藏的拖动后停 5 秒再继续上飘；双击气泡直接在板上打开这条想法。立即上飘、点星后顶部常驻、收藏后拖动原地驻留、不理会则消散、双击进板并选中该节点，均已用真实鼠标通过；未收藏拖动后停 5 秒再恢复、取消收藏后恢复，仍未测。详见 [docs/reviews](docs/reviews/2026-09-06-bubble-acceptance-record.md)。
- **会有毛边。** 版式、文案和 Agent Skill 在各个体验版之间还会变，欢迎反馈和提 issue。

## 一个念头，如何长成可以继续创作的东西

1. **在你工作时冒出来。** 想法来自 Agent 正在处理的任务，显示位置跟随你当前的前台窗口。值得留意的吐槽、提醒和创意岔路，以稀疏的气泡出现。可以忽略、拖动或打开。
2. **收进来。** 点亮星标，把内容放进板，同时保留它来自哪个任务。
3. **展开它。** 请 Agent 继续发展这个想法。板成为完整回复的呈现面，由内容决定适合的表达形式。
4. **变成你的。** 选方向、改内容、移动关系、补充约束，反馈回到负责这条想法的原任务。

| 表达形式 | 可以怎样继续 |
| --- | --- |
| 文字 | 阅读完整说明，修改内容，针对一块追问 |
| 方案对照 | 用相同标准比较方向，明确选中一个方案 |
| 关系图 | 阅读带标签的连线，查看节点详情，拖动、平移与缩放 |
| 分镜 | 按顺序探索动作、反馈和说明，也可以调整顺序 |

一条回复可以混合这些形式。Agent 能只更新其中一块；遇到版本冲突时会拒绝覆盖，保留草稿供继续处理。

切去其他应用后，桌面气泡会恢复投放，板保留原来的模式和内容。手动暂停则会持续生效。

## Agent 留在你原本使用的地方

Spellcast 是通过 MCP 连接的本地桌面应用，不运行模型，也不需要填写模型 API Key。Agent 继续使用原来的宿主和模型。

反馈会留在队列中，直到原任务读取并确认处理。**它不会自动唤醒已经停止的宿主任务。** 随软件分发的 Skill 会告诉 Agent 何时查看反馈、什么时候值得抛气泡，以及何时直接在板上回复。

开发构建新增了**独立旁念**：为当前任务启用后，宿主在有实质进展的检查点提供短项目快照，由不继承对话历史的子代理独立判断是否值得冒泡；保持安静也是正常结果。子代理直接向 Spellcast 提交决定，只给主任务返回简短状态。检查点凭证限制重复，并拒绝过期或已被新进展替代的内容。这需要宿主支持隔离子代理和原生 MCP，不会另装后台模型服务。当前验证范围见[独立观察机制记录](docs/reviews/2026-09-06-independent-observer.md)；已有发布包尚不包含此功能。

采纳的想法和板上回复可以跨重启保留。长期记忆是另一项明确操作：你决定记住什么，在 **记忆** 中查看、搜索和逐条遗忘。收藏气泡不会自动建立长期记忆。

## 开始使用

1. 从 [Releases](https://github.com/Vanyangyang/spellcast/releases/latest) 下载并运行最新的 **Windows x64 体验版**；想用上 `main` 里的全部改动，按下文从源码运行。
2. 打开 **设置**，选中正在使用的宿主并查看 MCP 配置。支持的写入器只合并 Spellcast 条目，修改前备份原文件；其他客户端提供配置片段。
3. 安装内置 **Skill**，重载宿主中的 Agent，再请它使用 Spellcast。

使用期间需要保持桌面应用运行。本地 MCP 地址为 `http://127.0.0.1:47194/mcp`。连接设置支持 Cursor、Codex、Windsurf、Claude Code 和通用 MCP 客户端；具体运行体验取决于宿主的工具与任务生命周期支持。

同一套发布流程也会产出 Apple Silicon 和 Intel macOS 构建，它们已通过 CI 打包；[当前原生交互验证仅覆盖 Windows](docs/releases/0.2.1.md)。

## 本地开发

```sh
git clone https://github.com/Vanyangyang/spellcast.git
cd spellcast
npm ci
npm run desktop
```

需要 Node.js 22+、仓库配置的 Rust 工具链及 Tauri 平台构建环境。Windows 需要 Visual Studio C++ 构建工具、Windows SDK 和 WebView2。

`npm start` 打开板的浏览器预览；真实桌面气泡需要运行 `npm run desktop` 或已安装的应用。

```sh
npm run build
cargo test --workspace
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri -- build --bundles nsis
```

## Astra 如何参与

Astra 帮助检查产品理解，构建并整合气泡 → 板 → 反馈更新的流程，验证交互，并制作这段演示。关系图使用 [AntV X6](https://github.com/antvis/X6)，桌面外壳使用 [Tauri](https://github.com/tauri-apps/tauri)。

[Agent 行为说明](skills/spellcast/SKILL.md) · [版本说明与验证记录](docs/releases/) · [MIT 许可证](LICENSE)
