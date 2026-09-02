# 接管：Spellcast

产品名是 **Spellcast**。不要打开、不要改 VESPERIX 或其它仓库。根目录必须有这份 `package.json`（`"name": "spellcast"`）。

不要向用户报临时仓库名。

---

## 产品（不许走样）

Spellcast 不是聊天 App，也不是 LLM 客户端，也不提供「让别的 agent 来调我们」的接口。

1. **桌面气泡（ambient）**：辅助旁路。用户已经在别处跟 AI 干活。偶尔抛一颗透明小窗。点/戳 = 感兴趣。没人管的泡升到该屏顶端，渐隐，关掉。不是新对话，不是接模型向导。
2. **专注板（focus）**：真正的呈现面。空间碎片，不是一堵字。专注板不是又一个输入框。

硬规则：

- **气泡不是整段回复的倾销。** 抛不抛、多大、露出多少（`tease`）、点了怎样（`on_poke`：peek / reply / focus / pin）、落哪块屏（`active` | `primary` | `side`）。
- **抛出是操作系统窗口，不是网页里的 CSS。** 一颗泡 = 一扇透明置顶小窗（大约 86–168px），不进任务栏，不抢焦点，最多 3 扇，一屏一颗。
- 浏览器 Preview / `npm start` **看不见** 桌面泡。
- 一粒泡只落一块屏的工作区，不复制到所有屏，不骑在两屏接缝上。
- 界面上不准出现「接到任意模型」、API Key、Base URL、`orbit-local`，也不准做成「把 agent 指到这个 HTTP/MCP」的引导。
- 本地预览只用来试板和泡，不当成「模型」。
- **不准写 `~/.codex/**`。** Codex `config.toml` 是 TOML。Cursor MCP 是 JSON `mcpServers`。两者不能互换。2026-09-02 有一次把 Cursor JSON 整文件盖进 `~/.codex/config.toml`，用户配置全没了。默认不要注册 MCP。`orbit-core::config_safety` 是唯一允许的写助手：拒 `.codex`、拒 TOML / 非 JSON、只允许 merge Cursor `mcp.json` 的一个 key。产品路径必须继续走 `register_spellcast_mcp` 的 disabled。

## 栈

| 目录 | 作用 |
| --- | --- |
| `orbit-core/` | Rust：碎片、布局、本地预览 |
| `orbit-server/` | Axum HTTP，端口 **47194** |
| `src-tauri/` | Tauri 2，系统 WebView2 / WKWebView |
| `src/` | Vite + TS + Three.js，端口 **47193** |
| `src/i18n/` | zh-CN / en / ja |
| `extensions/orbit/` | Cursor/VS Code 插件；侧栏是启动器；「Spellcast: 展开专注板」开专注板 |

命令：

```powershell
npm install
npm run desktop
```

`npm start` = 网页预览（板），不抛桌面泡。  
`npm run plugin` = 装插件。

协议：`ChatRequest.surface` 为 `ambient` | `focus`。只在 `ambient` 时解析 throws。`ModelPayload.throws`：`None` = 未决定（桌面保持安静）；`Some([])` = 选择沉默；`Some([...])` = 只抛这些。节点绝不隐含气泡。最多 3。

桌面实现：`src-tauri/src/desktop.rs`（`list_screens` / `spawn_bubble` / `close_bubbles`），`src/shell.ts` 仅在 `__TAURI_INTERNALS__` 时 invoke Rust。`src/bubble.ts` 是小窗自己升、停、戳。

## 不要做

- 不要把网页里的 constellation 碎片当成气泡。
- 不要为了「Preview 能看见」做成页内 CSS 球。
- 不要做成接模型 / 填密钥 / 填 Base URL 的设置页。
- 不要做成「这里是我们的 HTTP/MCP，把你的 agent 指过来」的产品。
- 不要给 orbit-server 加 `/mcp`，不要把 Spellcast 写进 Codex 或 Cursor 的 MCP 配置。
- 不要取消已经在跑的 v0.1.0 Release 构建。

## 测试

```powershell
cargo test -p orbit-core
node scripts/check-config-safety.mjs
npx tsc --noEmit
```
