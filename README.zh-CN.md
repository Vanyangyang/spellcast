# Spellcast

![Spellcast：法杖把旁念气泡发射出去](docs/media/spellcast-hero-story.gif)

Spellcast 是给 coding agent 用的本地桌面应用。Agent 在干活时，可以往你正在用的显示器上扔一条旁念：吐槽、提醒，或者一个忽然冒出来的想法。气泡叠在你当前工作上面，不会把 Agent 窗口拽到前面。

想留下的念头可以收进画布，用文字、图片、对比、关系图、步骤或交互作品接着改。Codex 和 Grok Build 任务结束时，会有完成提醒。把请求回发到原任务，目前还是走 Codex Desktop。

> 项目还早。这是体验版，不是成品。

[English](README.md) · 简体中文 · [下载体验版（仅 Windows 经过测试）](https://github.com/Vanyangyang/spellcast/releases/latest)

[![Spellcast - Desktop stage for coding agents: bubbles & Canvas | Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1254388&theme=light&t=1789729302078)](https://www.producthunt.com/products/spellcast?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-spellcast)

## 现在长什么样

**目前测过、能用的路径是 Codex + Windows。** macOS 没测。

**旁念和气泡是被动的。** 没有「生成气泡」按钮。打开「显示旁念」之后，只会通过宿主的**子代理**抛旁念，只占主任务一小块。有值得说的才出桌面气泡。不出也正常。Hooks 不保证每一轮都冒泡。

1. **先给 Codex 打开旁念**

   ![桌面设置：显示旁念已开启，并选中 Codex。只有值得说的进展才会变成气泡。](docs/media/02-desktop-asides-codex.png)

   桌面设置里「显示旁念」开着，并选中 **Codex**。关掉就只剩主对话和画布。

2. **画布上的结果**

   ![画布上「待整理」里的一条 Idea 卡片](docs/media/01-canvas-idea.png)

   「待整理」里的一条 Idea。Agent 觉得值得留下才放上来的，不是你按按钮生成的。画布还在改，欢迎提建议。现在就能用几种形式把想法摊开。后面可能加一个画布专注模式，不计成本，把创意工作推快一点。

3. **主张、批注，再说给 Agent**

   ![画布上的主张与批注卡片，以及说给 Agent 输入栏](docs/media/03-canvas-claim-note.png)

   画布上的「主张」或「批注」，再加上「说给 Agent」。这条输入栏用来回会话，不会生成气泡。

4. **桌面上的旁念气泡**

   ![Grok Build TUI 会话里 TAKE/旁念气泡正在冒出](docs/media/02-desktop-asides-bubble.gif)

   一段 **Grok Build** TUI 会话，TAKE/旁念气泡正在冒出来。还是没有「生成气泡」按钮，气泡是正在跑的会话自己冒出来的。收藏之后会停在顶端；不点收藏，过一会儿自己散掉。这个气泡可以拖。

5. **完成提醒**

   ![完成提醒卡片：Task complete，页脚为 Grok Build · Double-click to dismiss](docs/media/04-completion-notice.png)

   完成提醒卡片，可选语音播报。页脚显示 **Grok Build**。双击关掉。

## 体验版到哪了

- **已经发出去的包：** [0.4.8](https://github.com/Vanyangyang/spellcast/releases/tag/v0.4.8)，Windows x64 安装包。说明在 [0.4.8](docs/releases/0.4.8.md)。
- **这份预览里有：** 可编辑的画布 Idea、按工作区和任务整理、回发原 Codex Desktop 任务、Codex 一键接入（MCP + Hooks + Skill）。**Grok Build 接入还没做**（设置里按钮还在，但点不了）。背景材料：[运行验收](docs/reviews/2026-09-14-workbench-runtime-acceptance.md)、[回复面板](docs/reviews/2026-09-15-replies-inbox.md)、[仅 Codex 接入](docs/reviews/2026-09-15-codex-only-entry.md)。
- **毛边还在。** 版式、文案和 Skill 都还在改，欢迎反馈和提 issue。下一步想改什么写在[这份提示词](docs/next-improvement-prompt.md)里。

## 气泡怎么进画布

1. **跟着你当前的屏幕走。** 内容来自 Agent 正在做的任务，显示位置跟前台窗口。气泡本来就少。可能是一句吐槽、一条提醒，或者一条岔路。可以不理、拖走，或者打开。
2. **收进来。** 点星标，把文字放进画布。知道原任务的话会带上。
3. **接着做。** 把组件收成一条有标题、有意图的 Idea。画布就是回复面，版式跟着内容走。
4. **改完再发。** 选方向、改组件、加约束，都先留在画布上。点「发送到 Codex」才回原任务。要改发别的任务，需要确认。

| 表达形式 | 可以怎样继续 |
| --- | --- |
| 文字 | 阅读完整说明，修改内容，针对一块追问 |
| 图片与图形 | 排列参考图、矩形、椭圆和注释 |
| 方案对照 | 用相同标准比较方向，明确选中一个方案 |
| 关系图 | 阅读带标签的连线，查看节点详情，拖动、平移与缩放 |
| 分镜 | 按顺序探索动作、反馈和说明，也可以调整顺序 |
| 交互作品 | 操作 Agent 提供并在本地保存的 Web 工具，使用其声明的输入输出 |

一个 Idea 可以混用这些形式。切到别的应用后，桌面气泡会接着投。你手动暂停的话，会一直停着。

## 它怎么接上你的 Agent

Spellcast 是本地桌面应用，走 MCP。自己不跑模型，也不要模型 API Key。Agent 还用原来的宿主和模型。

你在画布上明确发送之后，请求交给正在跑的 **Codex Desktop** 里对应任务，空闲的任务也算。投递失败不会显示成成功。这份预览没有 Grok Build 接入。

**完成提醒**是一张置顶小卡片，语音播报可选，语言跟界面走。Codex 卡片双击跳回原任务；Grok Build 卡片双击关掉。

**独立旁念**听 Spellcast 开关。由宿主子代理抛出，只占主任务一小块。细节在 [Codex Hooks 与验证边界](docs/codex-observer-hooks.md)。

收进来的想法和画布回复，重启还在。长期记忆是另一件事：你决定记住什么，在「记忆」里查看、搜索、一条条忘掉。收藏气泡不会自动写成长期记忆。

## 开始用

![Spellcast 桌面设置：旁念开关、MCP 地址，以及 Codex 一步接入](docs/media/spellcast-desktop-settings.png)

1. 按下面从当前源码跑，或安装[已经发出去的 Windows 体验版](https://github.com/Vanyangyang/spellcast/releases/latest)。
2. **Codex：** 打开「设置」，保持选中 Codex，安装或更新 Spellcast 接入。一次写入 MCP、Hooks 和行为 Skill，并做备份和冲突检查。然后重载 Codex，按接入状态里的提示信任 Hooks。
3. **Grok Build 要等后面的版本。** 设置里还能看见按钮，但装不上。
4. 需要独立旁念时，在 Spellcast 里打开旁念开关。能自动拉起旁念的是 Codex Hooks。

接入细节：[docs/codex-observer-hooks.md](docs/codex-observer-hooks.md) 和包里的 [hooks/INSTALL.md](hooks/INSTALL.md)。

用的时候要让 Spellcast 一直开着。本地 MCP 是 `http://127.0.0.1:47194/mcp`。**接入界面目前只支持 Codex。** 设置里其他宿主还显示，但装不上。macOS 和 Linux 的 CI 包没测过。

## 本地开发

```sh
git clone https://github.com/Vanyangyang/spellcast.git
cd spellcast
npm ci
npm run prepare:codex-plugin
npm run desktop
```

需要 Node.js 22+、仓库里的 Rust 工具链，以及 Tauri 各平台的构建环境。Windows 要 Visual Studio C++ 构建工具、Windows SDK 和 WebView2。Linux 要 WebKitGTK 4.1，再加上 [Tauri 2 Linux 依赖](https://v2.tauri.app/start/prerequisites/#linux)里其余的包。

`npm start` 打开画布的浏览器预览。桌面气泡要用 `npm run desktop`，或者已经装好的应用。`npm run desktop` 会热重载本机 Vite `http://127.0.0.1:47193`。本机 debug 可执行文件：`npx tauri build --debug --no-bundle`。

```sh
npm run build
cargo test --workspace
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri -- build --bundles nsis
# Linux: npm run tauri -- build --bundles appimage,deb
```

## Astra 做了什么

Spellcast 是跟 GPT-6 Astra 一起做的。Astra 会顶产品假设，写了 Rust 核心和 Tauri 外壳，把气泡 → 画布 → 回传这条链路接上，再用 computer use 把桌面交互跑通、做出演示。关系图用 [AntV X6](https://github.com/antvis/X6)，桌面外壳用 [Tauri](https://github.com/tauri-apps/tauri)。

## 友情链接

- [LINUX DO](https://linux.do)

[Agent 行为说明](skills/spellcast/SKILL.md) · [版本说明与验证记录](docs/releases/) · [AGPL-3.0 许可证](LICENSE)
