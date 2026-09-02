# Spellcast

Spellcast 不是聊天 App，也不是「自带模型」的客户端。它不接密钥，也不让别人的 agent 来调一个接口。

它**不是** MCP server。不要把 Cursor 的 `mcpServers` JSON 写进 Codex 的 `~/.codex/config.toml`（那是 TOML，`[mcp_servers.name]` 表）。Spellcast 也不会去改那份文件。

- **桌面气泡（ambient）**：你在别处跟 AI 干活时的辅助旁路。偶尔冒一颗透明小窗，最多三扇，一屏一颗。不是新对话。
- **专注板（focus）**：真正的呈现面。模型该把想法摊成空间碎片，而不是一堵字。专注板不是又一个输入框。

普通使用只需要下载安装包，**不需要** Node、Rust 或 Visual Studio。

## 安装

1. 打开 [Releases](https://github.com/Vanyangyang/spellcast/releases/latest)。
2. 下载 Windows 安装包（`Spellcast_*_x64-setup.exe`，NSIS）。
3. 运行安装包。构建未签名，SmartScreen 可能提示警告：选 **更多信息** → **仍要运行**。
4. 从开始菜单打开 **Spellcast**。

同一页如果附带 `.dmg`，Mac 也可以装。

## 两种用法

- **桌面气泡**：一直开着。你在 Cursor、别的 agent、别处的对话里干活时，这里只偶尔抛一颗辅助泡——抛哪块屏、多大、露出多少、点开后怎样。不是把整段回复摊成泡。没人管的泡会升到这块屏的顶端，渐隐，悄悄破掉。
- **专注板**：要看整块呈现时再进去。碎片、形式、空间关系才是正文。插件里「展开专注板」默认进这里。

多屏（Windows / Mac 同一套）：

- 每颗泡是一扇透明小窗，只落在**一块屏的工作区**里（避开 Windows 任务栏、Mac 菜单栏和 Dock）。
- 一粒泡不会复制到所有屏，也不会骑在两块屏的接缝上。
- 落点可以是 `active`（你正在看的）、`primary`（主屏）或 `side`（旁边一块，少打扰）。

## 板上

- `新碎片` 或 `N`：放下
- 拖开、右边改字
- `Delete`：拿掉
- 下面「摊开」：把一句摊成空间碎片（本地预览，不是发给某个模型）
- 「拣进对话」：把别处已经在进行的对话贴进来，拣出碎片

界面语言跟系统走（中文 / English / 日本語），右上角可改。板上的碎片原文不改。

## 开发者

从源码跑桌面窗口（需要本机 Node 22+ 和 Rust；Windows 还需要 WebView2，Win10/11 一般都有）：

```bash
git clone https://github.com/Vanyangyang/spellcast.git
cd spellcast
npm install
npm run desktop
```

只要板的网页预览（看不见系统桌面泡）：

```bash
npm start
```

打开 [http://127.0.0.1:47193](http://127.0.0.1:47193)。后端在 **47194**。

装 Cursor / VS Code 侧栏：

```bash
npm run plugin
```

命令面板 → **Spellcast: 展开专注板**。

插件只装侧栏，不会注册 MCP，也不会写 `~/.codex/**`。
