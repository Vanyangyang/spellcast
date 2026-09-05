<p align="center">
  <img src="docs/assets/spellcast-hero.svg" alt="Spellcast：给 AI 一个发挥创造力的 Everything 板。" width="100%">
</p>
<p align="center"><strong>桌面上的旁念，板上展开的想法。</strong></p>
<p align="center"><a href="README.md">English</a> · 简体中文 · <a href="https://github.com/Vanyangyang/spellcast/releases">下载发行版</a></p>

想听听你的 Astra 对项目有什么吐槽？
想让它提醒你那些忙着忙着就忘掉的事？
想接住一次意料之外的灵光一闪？

试试 **Spellcast**。

让 Astra 的吐槽、提醒和奇思妙想，冒成你真实桌面上的气泡。喜欢哪个，就把它收进板里，接着展开。

进入板模式后，Agent 可以摆开方案、画出关系、展开分镜、推演过程，用适合这个想法的形式回复你。

**给 AI 一个发挥创造力的 Everything 板。**

> Everything 板升级正在开发。现有 **v0.1.1** 安装包是较早的桌面预览；新的板上表达与实际演示会随下一版一起发布。

## 从一句旁念，走向一块可以继续创作的板

**冒出来。** 你继续做原来的事，值得留意的旁念以透明桌面气泡出现。可以忽略、拖动，或留下。

**收进来。** 点亮星星，把气泡里的内容放进板，之后再回来。

**展开它。** 进入板模式，Agent 用板上的内容和结构呈现回复。比较不同方向，理清关系，逐步推演一个想法。

**变成你的东西。** 你可以整理、改写和反馈。哪些只是创作中的材料，哪些需要明确记住，由你决定。

## 两个空间，一条连续的体验

| 真实桌面上的气泡 | 主动进入的 Everything 板 |
| --- | --- |
| 质疑、提醒、联想和创意岔路 | 有结构、可继续展开的回复 |
| 看一眼，也可以不理会 | 选择方向，比较与推演 |
| 留下值得回来的想法 | 把想法变成可以继续做的东西 |

Spellcast 在你的电脑上运行。Agent 留在你平时使用的客户端中，通过适配与这块舞台连接。Astra 很适合成为这里的创意伙伴；产品也面向其他兼容的客户端和模型。

## 体验当前桌面预览

到 [Releases](https://github.com/Vanyangyang/spellcast/releases) 下载现有构建；每一版的说明会列出对应能力与可用平台。

从源码开发：

    git clone https://github.com/Vanyangyang/spellcast.git
    cd spellcast
    npm install
    npm run desktop

源码构建需要 Node.js 22+、Rust 和相应平台的 Tauri 构建环境。Windows 需要 Visual Studio C++ 构建工具及 Windows SDK。

**npm start** 提供板的浏览器预览；真实桌面气泡需要运行桌面应用。

## 下一版正在完成

- 混合内容、方案对照、有语义的关系图、分镜等板上回复。
- 切换表达形式后仍跟随同一想法的上下文与反馈。
- 明确、可查看的记忆，以及回到原 Agent 的反馈路径。
- 从真实桌面气泡到 Everything 板的完整操作演示。

表现形式可以有想象力；选择、修改和保存的行为应当清楚。

## Astra 如何参与

Astra 正在帮助我们检查产品理解、追踪现有实现、研究适合 AI 的视觉表达，并把这套体验做成可以运行的产品。

正式演示会录制实际产品操作。当前预览与正在开发的能力在上文分别说明。
