# Orbit 头脑风暴板

桌面头脑风暴板。普通使用只需要下载安装包，**不需要** Node、Rust 或 Visual Studio。

## 安装

1. 打开 [Releases](https://github.com/Vanyangyang/spellcast/releases/latest)。
2. 下载 Windows 安装包（`Orbit_*_x64-setup.exe`，NSIS）。
3. 运行安装包。构建未签名，SmartScreen 可能提示警告：选 **更多信息** → **仍要运行**。
4. 从开始菜单打开 **Orbit**。

同一页如果附带 `.dmg`，Mac 也可以装。

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

## 开发者

从源码跑桌面窗口（需要本机 Node 22+ 和 Rust；Windows 还需要 WebView2，Win10/11 一般都有）：

```bash
git clone https://github.com/Vanyangyang/spellcast.git
cd spellcast
npm install
npm run desktop
```

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
