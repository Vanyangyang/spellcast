# 接管：Orbit 头脑风暴板

你是本机 Grok。上一棒是 **Cursor Cloud Task**（会话名「通用AI板」），改的是云端 VM，**写不进这台 Windows**。你的工作是把项目落到本机、跑起来、接着做桌面抛出。

云端会话：https://cursor.com/agents/bc-d2edbeda-38ff-4ae5-a255-51bc7615a609  
分支：`main`  
HEAD（云端已推）：`8c2a592` — Make Orbit runnable as a local Windows or Mac project

不要打开、不要改 `VESPERIX` 或其它仓库。根目录必须有这份 `package.json`（`"name": "orbit"`）。

---

## 产品（不许走样）

这不是聊天 App。**板就是 Agent 的回复方式。** 碎片 + 选中的形式才是载荷；正文是旁注。

两种用法：

1. **桌面氛围**：常驻系统桌面。Agent *有时* 往桌面抛气泡。点/戳 = 感兴趣。没人管的泡升到该屏顶端，渐隐，关掉。
2. **专注**：用户要头脑风暴时，进可操作的整块板。

硬规则：

- **气泡不是整段回复的倾销。** Agent 自己决定：抛不抛、多大、露出多少（`tease`）、点了怎样（`on_poke`：peek / reply / focus / pin）、落哪块屏（`active` | `primary` | `side`）。
- **抛出是操作系统窗口，不是网页里的 CSS。** 一颗泡 = 一扇透明置顶小窗（大约 86–168px），不进任务栏，不抢焦点，最多 3 扇。
- 浏览器 Preview / `npm start` **看不见** 桌面泡。Cursor Cloud 的 Preview 更看不见。
- 一粒泡只落一块屏的工作区，不复制到所有屏，不骑在两屏接缝上。

## 栈

| 目录 | 作用 |
| --- | --- |
| `orbit-core/` | Rust：碎片、布局、mock、多 provider |
| `orbit-server/` | Axum HTTP，端口 **47194** |
| `src-tauri/` | Tauri 2，系统 WebView2 / WKWebView |
| `src/` | Vite + TS + Three.js，端口 **47193** |
| `src/i18n/` | zh-CN / en / ja |
| `extensions/orbit/` | Cursor/VS Code 插件；侧栏是启动器；「Orbit: 展开头脑风暴板」开专注板 |

命令：

```powershell
npm install
npm run desktop
```

`npm start` = 网页预览（板），不抛桌面泡。  
`npm run plugin` = 装插件。

协议：`ChatRequest.surface` 为 `ambient` | `focus`。只在 `ambient` 时解析 throws。`ModelPayload.throws`：`None` = 未决定（桌面保持安静）；`Some([])` = 选择沉默；`Some([...])` = 只抛这些。节点绝不隐含气泡。最多 3。

桌面实现：`src-tauri/src/desktop.rs`（`list_screens` / `spawn_bubble` / `close_bubbles`），`src/shell.ts` 仅在 `__TAURI_INTERNALS__` 时 invoke Rust。`src/bubble.ts` 是小窗自己升、停、戳。

## 你先做

1. 确认当前 Cursor 打开的是 **Orbit 根目录**。若用户还只有云端会话：让他在 Cloud Task 页点 **Create repo**，从 [cursor.com/codebase](https://cursor.com/codebase) 复制 HTTPS，本机 `git clone`，再 **File → Open Folder**。不要用 GitHub（云端 VM 没有 GitHub 登录）。
2. 检查 Node 22+、Rust、WebView2。缺了就装。
3. 在仓库根目录 `npm install`，然后 `npm run desktop`。必须弹出 **Orbit** 窗口，不能只开浏览器。
4. 在桌面氛围下让 agent 抛泡：确认是独立小窗，不是板里的圆点。
5. 需要的话再修：Windows 工作区/任务栏、第一下点击吃掉、多屏 `side`。不要把抛出改回 CSS。

## 不要做

- 不要把网页里的 constellation 碎片当成气泡。
- 不要为了「Preview 能看见」做成页内 CSS 球。
- 不要在 `G:\...\VESPERIX\` 里跑 `npm run desktop`（那是另一个项目，没有这份 `package.json`）。
- 不要给这个 New Project 建 PR（除非用户明确要）。
- 不要向用户报那串临时 Origin 仓库名。

## 测试

```powershell
cargo test -p orbit-core
npx tsc --noEmit
```
