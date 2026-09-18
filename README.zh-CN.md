# Spellcast

![Spellcast：法杖把旁念气泡发射出去](docs/media/spellcast-hero-story.gif)

**对话之外的舞台。** 桌面旁念、用来发展想法的画布，以及 Codex 与 Grok Build 的完成提醒。把请求直接回发到原任务仍走 Codex Desktop。

> **Spellcast 仍在孵化中。** 这是初期演示 demo，目前提供的是体验测试版本，不是成品；成品敬请期待。
> Early demo · Experimental preview · Stay tuned for the full release.

想听听你的 Astra 对项目有什么吐槽？想让它帮你记起忙着忙着忘掉的事？想接住一次意料之外的灵光一闪？

试试 **Spellcast**。Agent 继续处理你的任务，与任务相关的吐槽、提醒和灵感，会从你当前操作的显示器上冒出来，不必切回 Agent 窗口。喜欢哪个，就收进画布，用文字、图片、对比、关系图、步骤和交互作品继续展开。

[English](README.md) · 简体中文 · [下载体验版（仅 Windows 经过测试）](https://github.com/Vanyangyang/spellcast/releases/latest)

[![Spellcast - Desktop stage for coding agents: bubbles & Canvas | Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1254388&theme=light&t=1789729302078)](https://www.producthunt.com/products/spellcast?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-spellcast)

## 现在长什么样

这是早期预览，不是成品。**当前支持并经过测试的路径是 Codex + Windows。** CI 会打出未签名的 macOS 包，但还没有人实际跑过。

**旁念和气泡是被动的。** 没有“生成气泡”按钮。打开**显示旁念**后，由正在进行的 Agent 会话在“有值得说的内容”时才可能冒出桌面气泡——一句吐槽、提醒或灵感。保持安静也是正常结果。Hooks 不保证每一轮都会冒泡。下面第 4、5 步是 **Windows 上 Grok Build** 的同一套气泡和完成提醒界面，不是 Codex。

1. **先为 Codex 打开旁念**

   ![桌面设置：显示旁念已开启，并选中 Codex。只有值得说的进展才会变成气泡。](docs/media/02-desktop-asides-codex.png)

   桌面设置里 **显示旁念** 为开，并选中 **Codex**。文案写得很清楚：任务有新进展时另看一眼，不读聊天记录；有值得说的才冒泡。关掉则只留主对话和画布。

2. **画布上的结果**

   ![画布上「待整理」里的一条 Idea 卡片](docs/media/01-canvas-idea.png)

   **待整理**里的一条 Idea。这是 Agent 觉得值得留下时放到画布上的，不是你按按钮生成的。

3. **主张、批注，再说给 Agent**

   ![画布上的主张与批注卡片，以及说给 Agent 输入栏](docs/media/03-canvas-claim-note.png)

   画布上的 **主张** 或 **批注**，以及 **说给 Agent**。这条输入栏用来回会话，不会生成气泡。

4. **桌面上的旁念气泡**

   ![Windows 上 Grok Build TUI 会话上方浮动的 TAKE 气泡](docs/media/02-desktop-asides-grok.png)

   真实桌面 / TUI 上的被动 **TAKE** 气泡。这张图是 **Windows 上的 Grok Build**，展示的是同一套旁念界面，不是 Codex。仍然没有“生成气泡”按钮，气泡由正在进行的会话自己冒出来。

5. **完成提醒**

   ![完成提醒卡片：Task complete，页脚为 Grok Build · Double-click to dismiss](docs/media/04-completion-notice.png)

   完成提醒卡片，可选语音播报。页脚显示 **Grok Build**；双击关闭。这张图是 Grok Build，不是 Codex。

## 体验版现在到哪了

- **已发布的构建：** [0.4.5](https://github.com/Vanyangyang/spellcast/releases/tag/v0.4.5)，含 Windows x64 安装包。**只有 Windows 经过测试。** 发布流程也可能附上未签名的 macOS `.dmg`，不保证可用。详见 [0.4.5 说明](docs/releases/0.4.5.md) 与 [0.4.0 工作台说明](docs/releases/0.4.0.md)。
- **当前源码和已在本机测试的 Windows 运行版：** 可编辑画布组件、带名称的 Idea 组合、按工作区和任务整理、直接回发原 Codex Desktop 任务、Codex 一键接入（MCP + Hooks + Skill）、按发送请求展示的回复面板。**Grok Build 接入将在未来版本加入**（设置里按钮仍显示，但不可安装）。详见[运行验收](docs/reviews/2026-09-14-workbench-runtime-acceptance.md)和[回复面板](docs/reviews/2026-09-15-replies-inbox.md)。[仅 Codex 接入](docs/reviews/2026-09-15-codex-only-entry.md)与当前安装界面一致。
- **已知缺口：** 组件粒度尚未完全统一，一个组件不能同时属于多个 Idea，来源不完整的历史请求还存在分类遗漏；回复与历史界面仍需收敛。详见[下一步改善提示词](docs/next-improvement-prompt.md)。
- **会有毛边。** 版式、文案和 Agent Skill 在各个体验版之间还会变，欢迎反馈和提 issue。

## 一个念头，如何长成可以继续创作的东西

1. **在你工作时冒出来。** 想法来自 Agent 正在处理的任务，显示位置跟随你当前的前台窗口。值得留意的吐槽、提醒和创意岔路，以稀疏的气泡出现。可以忽略、拖动或打开。
2. **收进来。** 点亮星标，把内容放进画布，保留已知的原任务来源。
3. **展开它。** 把组件组合成有标题、有意图的 Idea。画布成为完整回复的呈现面，由内容决定适合的表达形式。
4. **变成你的。** 选方向、改组件、补充约束。这些操作先保留在画布中，最后点击**发送到 Codex**，才回发原任务；改发其他任务需要确认。

| 表达形式 | 可以怎样继续 |
| --- | --- |
| 文字 | 阅读完整说明，修改内容，针对一块追问 |
| 图片与图形 | 排列参考图、矩形、椭圆和注释 |
| 方案对照 | 用相同标准比较方向，明确选中一个方案 |
| 关系图 | 阅读带标签的连线，查看节点详情，拖动、平移与缩放 |
| 分镜 | 按顺序探索动作、反馈和说明，也可以调整顺序 |
| 交互作品 | 操作 Agent 提供并在本地保存的 Web 工具，使用其声明的输入输出 |

一个 Idea 可以组合这些形式，调整成员顺序、嵌套组合；每个成员目前只属于一个组合。Agent 可以更新指定内容；版本冲突和受保护的用户编辑会形成可审阅提案。数据连接限于声明了接口的作品输出，目标为文字或另一作品的输入，尚不支持所有组件任意联动。

切去其他应用后，桌面气泡会恢复投放，画布保留原来的模式和内容。手动暂停则会持续生效。

## Agent 留在你原本使用的地方

Spellcast 是通过 MCP 连接的本地桌面应用，不运行模型，也不需要填写模型 API Key。Agent 继续使用原来的宿主和模型。

明确发送后，Spellcast 通过运行中的 **Codex Desktop** 直接把请求交给对应任务，包括当前空闲的任务；结果可以回写原画布内容。应用关闭、任务删除、工具不可用或投递失败时，不会把请求显示为已成功执行。Codex 完整接入包含 MCP、Hooks 和行为说明，收到请求与实际完成分别记录。本预览不含 Grok Build 接入。

**完成提醒**会在你正在使用的显示器上以一张置顶小卡片出现，可选语音播报（“Codex 有任务完成了。” / “A Codex task is ready.”，跟随界面语言）。Codex 的卡片双击回跳到 Codex Desktop 里的原任务；Grok Build 的卡片双击关闭。界面提供简体中文和英文；卡片、语音短句和接入页跟随同一个设置。

**独立旁念**以 Spellcast 的开关为准。开启后，宿主在出现实质项目新信息时提供简短上下文，由隔离的观察者判断是否有值得补充的想法；保持安静也是正常结果。这需要宿主支持隔离子代理及原生 MCP 工具。Hooks 不保证每一轮都会出现旁念，也不会另外安装模型服务。详见[Codex Hooks 与验证边界](docs/codex-observer-hooks.md)。

采纳的想法和画布回复可以跨重启保留。长期记忆是另一项明确操作：你决定记住什么，在 **记忆** 中查看、搜索和逐条遗忘。收藏气泡不会自动建立长期记忆。

## 开始使用

![Spellcast 桌面设置：旁念开关、MCP 地址，以及 Codex 一步接入](docs/media/spellcast-desktop-settings.png)

1. 按下文从当前源码运行，或安装[公开的 Windows 体验版](https://github.com/Vanyangyang/spellcast/releases/latest)。
2. **Codex：** 打开**设置**，保持选中 Codex，安装或更新 Spellcast 接入。一次写入 MCP、Hooks 和行为 Skill，并完成备份及冲突检查。然后重载 Codex，按接入状态中的提示信任 Hooks。
3. **Grok Build 将在未来版本加入。** 设置里仍能看到按钮，但无法安装。
4. 需要独立旁念时，在 Spellcast 中打开旁念开关（能自动拉起旁念的是 Codex Hooks）。

接入详情：[docs/codex-observer-hooks.md](docs/codex-observer-hooks.md) 与包内 [hooks/INSTALL.md](hooks/INSTALL.md)。

使用期间需要保持 Spellcast 运行。本地 MCP 地址为 `http://127.0.0.1:47194/mcp`。**接入界面当前支持 Codex。** Grok Build、Cursor、Claude Code、Windsurf 和“其他”保留显示，但置灰且不可选。

发布流程也会产出 Apple Silicon 和 Intel macOS 构建，以及 Linux AppImage 与 `.deb`，但[只有 Windows 经过测试](docs/releases/0.4.5.md)。macOS 的 `.dmg` 未签名、未验证，可能遇到 Gatekeeper 警告或运行失败。Linux 包只是 CI 打包产物，尚未做过运行时验证。

## 本地开发

```sh
git clone https://github.com/Vanyangyang/spellcast.git
cd spellcast
npm ci
npm run prepare:codex-plugin
npm run desktop
```

需要 Node.js 22+、仓库配置的 Rust 工具链及 Tauri 平台构建环境。Windows 需要 Visual Studio C++ 构建工具、Windows SDK 和 WebView2。Linux 需要 WebKitGTK 4.1 以及 [Tauri 2 Linux 依赖](https://v2.tauri.app/start/prerequisites/#linux) 中的其余软件包。

`npm start` 打开画布的浏览器预览；真实桌面气泡需要运行 `npm run desktop` 或已安装的应用。`npm run desktop` / `tauri dev` 依赖本机 Vite `http://127.0.0.1:47193` 热重载；没有 Vite 时双击该 debug 进程会看到 `ERR_CONNECTION_REFUSED`。可双击的本机运行版用 `npx tauri build --debug --no-bundle` 构建，产物是 `src-tauri/target/debug/spellcast.exe`（本机桌面快捷方式已指向它）。`scripts/` 中部分浏览器验收脚本依赖 Codex 内置的 Playwright 环境；隔离测试结果不代表真实 Codex 模型回合已通过。

```sh
npm run build
cargo test --workspace
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri -- build --bundles nsis
# Linux: npm run tauri -- build --bundles appimage,deb
```

## Astra 如何参与

Spellcast 由 GPT-6 Astra 参与构建。Astra 检查产品理解，编写 Rust 核心与 Tauri 外壳，整合气泡 → 画布 → 反馈更新的流程，并用 computer use 端到端验证桌面交互、制作演示。关系图使用 [AntV X6](https://github.com/antvis/X6)，桌面外壳使用 [Tauri](https://github.com/tauri-apps/tauri)。

[Agent 行为说明](skills/spellcast/SKILL.md) · [版本说明与验证记录](docs/releases/) · [AGPL-3.0 许可证](LICENSE)
