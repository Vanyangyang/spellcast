# Orbit 头脑风暴板

这是一个**本机项目**：代码在你自己的文件夹里跑。云端会话改不了你的 Windows 硬盘。

## 拿到本机（Cursor）

1. 在这个 Agent / New Project 页点 **Create repo**，存成仓库。
2. 打开 [cursor.com/codebase](https://cursor.com/codebase)，进刚建的仓库，点绿色 **Code**，复制 HTTPS 地址。
3. 本机 PowerShell / 终端：

```bash
git clone <刚才复制的地址>
cd orbit
```

4. Cursor → **File → Open Folder** → 选这个文件夹。之后在这个本地窗口里改，才是本地项目。

不要打开别的仓库（例如 VESPERIX）。必须打开**这份 Orbit 源码**的根目录（里面有 `package.json`）。

## 本机先装

- [Node.js 22+](https://nodejs.org/)
- [Rust](https://rustup.rs/)
- Windows：系统自带 WebView2（Win10/11 一般都有）
- Mac：用系统 WKWebView

## 启动

```bash
npm install
npm run desktop
```

会打开 **Orbit** 桌面窗口。桌面级气泡是一扇扇透明小窗，浏览器预览里**不会**抛出来。

只要板的网页预览：

```bash
npm start
```

打开 [http://127.0.0.1:47193](http://127.0.0.1:47193)。

装 Cursor / VS Code 侧栏：

```bash
npm run plugin
```

命令面板 → **Orbit: 展开头脑风暴板**。

## 两种用法

- **桌面**：一直开着。Agent 自己决定要不要往桌面抛气泡——抛哪块屏、多大、露出多少、点开后怎样。不是把整段回复摊成泡。没人管的泡会升到这块屏的顶端，渐隐，悄悄破掉。
- **专注**：你要在板里头脑风暴时再进去。插件里「展开头脑风暴板」默认进专注。

多屏（Windows / Mac 同一套）：

- 每颗泡是一扇透明小窗，只落在**一块屏的工作区**里（避开 Windows 任务栏、Mac 菜单栏和 Dock）。
- 一粒泡不会复制到所有屏，也不会骑在两块屏的接缝上。
- Agent 选 `active`（你正在看的）、`primary`（主屏）或 `side`（旁边一块，少打扰）。

## 板上

- `新碎片` 或 `N`：放下
- 拖开、右边改字
- `Delete`：拿掉
- 下面「摊开」：让模型选形式、交碎片

界面语言跟系统走（中文 / English / 日本語），右上角可改。板上的碎片原文不改。
