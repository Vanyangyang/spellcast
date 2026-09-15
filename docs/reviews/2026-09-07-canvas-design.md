# Canvas 收敛方案与迭代验证

状态：统一 Canvas 与可靠反馈已实现，Windows 原生窗口和原 Codex CLI 任务已完成四轮闭环验证；Canvas → 当前 Codex App 自动接手 → 原块回写 → 确认处理也已完成一轮。App 在上一轮结束后接手队列。用户目标是可靠实用的 Canvas 与 Codex 及时反馈，不以新增展示形态或更换框架作为完成标准。

## 参考来源与采用范围

| 官方来源 | 借鉴内容 | 本轮取舍 |
| --- | --- | --- |
| [Obsidian Canvas](https://obsidian.md/canvas) / [交互说明](https://obsidian.md/help/plugins/canvas) | 在同一空间并置卡片、调整尺寸、用关系表达组织意图 | 采用统一空间与对象选择；不复刻整个笔记应用 |
| [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) | 稳定对象 ID、位置尺寸与连接分开记录 | 用作布局数据边界参考；本轮不宣称格式完全兼容 |
| [BlockSuite Edgeless](https://blocksuite.io/components/editors/edgeless-editor) | 画布与文档使用相同内容，文档作为画布中的区域 | 复用已有 ReplyBlock 与 DOM 编辑器，不复制内容到第二份图数据 |
| [tldraw Agent](https://tldraw.dev/starter-kits/agent) / [AI 集成](https://tldraw.dev/docs/ai) | 上下文与明确动作、稳定对象引用、增量结果 | 采用明确目标与动作校验，宿主仍拥有模型执行 |
| [ChatGPT Canvas 发布说明](https://openai.com/index/introducing-canvas/) | 局部选择、直接编辑、恢复修改 | 草稿保护与可撤销操作是主线要求，不是外观优化 |
| [json-render Catalog](https://json-render.dev/docs/catalog) | 组件与动作是有界词汇表 | 保留现有四类结构化块，扩展必要动作，不引入任意生成代码 |
| [A2UI 数据流](https://a2ui.org/concepts/data-flow/) | 模型输出、UI 渲染、用户事件的职责分离 | 保留 MCP 与现有状态库，补可靠用户反馈路径 |
| [X6 交互](https://x6.antv.antgroup.com/en/api/model/interaction) / [历史](https://x6.antv.antgroup.com/tutorial/plugins/history) | 节点移动、缩放、调整尺寸、交互限制与历史过滤 | 复用已安装的 X6 3.1.8，明确区分布局变化和内容变化 |
| [React Flow 白板能力](https://reactflow.dev/learn/advanced-use/whiteboard) | 对象编辑与视口交互的成熟组合 | 作为能力核对，不为了白板名称再引入 React 与另一套图引擎 |
| [tldraw 许可](https://tldraw.dev/community/license) | SDK 生产使用有独立许可要求 | 本轮借鉴交互与动作设计，不引入 SDK |
| [Codex App Server](https://developers.openai.com/codex/app-server) / [CLI queue 源码](https://github.com/openai/codex/blob/main/codex-rs/tui/src/session_queue_commands.rs) | 明确任务 ID、队列、请求与结果分离 | 使用本机版本实测到的接口；不能直接把 main 分支文档当作本机兼容证明 |

## 第一轮：代码与资料对照

现有完整回复是纵向文档，碎片是另一套空间视图。四种内容块已接入，但“同一工作面里组织内容并继续共创”未完成。现有 listen/ack 保存反馈，不主动把画布输入交给原任务。先保留已有内容、来源、revision 与 SQLite；补齐它们之间的工作流。

## 第二轮：小范围实测后的修正

### 画布引擎

在独立样稿中验证已安装 X6 的 HTML shape、Transform 与 History：

- 用真实鼠标移动卡片，输入框内容保留；一次撤销恢复原位置。
- 卡片从 490×320 调整到 580×380，输入保留；一次撤销恢复原尺寸。
- CSS 尺寸容器与 X6 实际宿主分开，避免 autoResize 把页面不断撑大；修正后无整页横纵溢出。
- HTML shape 使用稳定 DOM 与空 effect 列表，布局变化不重建编辑器。XHTML 容器使用 div，避免嵌入多个 body 与全局样式相互影响。

这只证明候选渲染方式可用，仍须在正式数据、编辑器、窄窗口与原生 WebView 中验证。

### Codex 连接与去重

本机 CLI 0.153.4：daemon 管理命令不支持 Windows；proxy 未连接到控制 socket。独立标准输入输出 App Server 可以正常 initialize、读取指定原任务、列出队列并正常退出，没有启动模型轮次。

从本机生成的 JSON schema 确认 `thread/queue/add`、list、delete、start 等方法及字段。进一步实测发现：**相同 clientUserMessageId 连续 add 会返回不同队列 ID，不能当作服务端幂等保证。** 测试创建的两条临时记录已按确切 ID 删除，复查队列为 0。

因此修正设计：由 Spellcast 持久记录请求、串行投递并阻止重复点击；投递结果不明时先按稳定客户端 ID 查询原任务队列。查询到已排队记录就复用，不能盲目再 add。未能证明尚未投递时保留未知状态，不自动重复执行。

## 本轮实现边界

1. **统一 Canvas**：完整回复与采纳的想法在同一二维工作面中展示，可选择、移动、调整尺寸、聚焦与撤销布局操作。继续使用原内容 ID，布局单独持久保存；更新一块内容不重排用户的其他区域。原有碎片视图保留为辅助查看方式。
2. **可编辑内容**：复用四类 ReplyBlock。补 graph 的节点与有标签关系编辑；视图移动不产生语义请求，明确保存的语义修改回到对应来源。
3. **用户输入保护**：内容更新、删块或换类型不能让未保存编辑与追问消失。提供有界、按来源与内容隔离的草稿恢复；过期版本保持可恢复，不自动盖过新内容。
4. **准确绑定原任务**：Codex 宿主明确提供自己的任务 UUID（原生执行环境的 CODEX_THREAD_ID）与 source_id；服务端验证任务身份与工作目录。不能从模型名、最近任务或标签猜测路由。
5. **可靠反馈投递**：输入先持久保存，再由事件驱动的投递器排入绑定任务；等待、投递中、已排队、已读取、已有回复、已处理以及失败/未知分别表示。没有模型常驻或定时抛气泡。
6. **同一内容上的回复**：Agent 读取对应反馈，以同一 reply/block ID 更新，并关联处理的反馈序号；处理结束后 ack。接口成功不替代模型接手或结果完成。

## 第三轮必须完成的验收

先跑数据迁移、旧数据保留、重启恢复、重复请求、乱序回包、保存失败与跨来源拒绝等针对性检查，再跑真实输入的正式 Canvas 操作。最后在一个真实 Codex 项目任务里验证采纳/选择 → 继续 → 原任务接手 → 同一内容更新 → 确认处理，并记录每个阶段的时间。

空闲、忙碌、离线与重启必须显示各自真实结果；队列成功不等于离线任务已被自动唤醒。只有实测支持的宿主行为才进入最终承诺，不以诊断写入、样稿或 mock 替代原生 MCP 与真实输入证据。

本轮不新增模型宿主、任意脚本内容块、完整绘图工具箱、多人 CRDT 或更多展示库。

## 实现结果

- 采纳的想法和完整回复共用 X6 工作面，原内容只有一份；位置和尺寸按稳定对象 ID 单独保存。新增回复不会重排原卡片。提供平移、缩放、拖动、调整尺寸、布局撤销/重做与聚焦阅读。
- 聚焦阅读使用原生 dialog，把现有编辑器移入阅读区域，再放回原卡片；不创建另一份编辑状态。880×640 的窗口下仍为正常字号，关闭后未提交内容保留。
- 四种内容块沿用原组件。关系图新增节点、删除节点及关联、添加/删除有明确标签的关系；位置变化不产生语义请求。来源更新保留用户已有坐标和选择。
- 编辑、局部追问、底部继续输入分别保存草稿；底部输入和块内追问有独立标识。恢复入口保留被删除或换类型的块的文字。旧版本提交、存储失败和迟到的保存结果不会清空新输入。
- Codex 绑定核对实际任务 UUID、工作目录和队列能力。用户输入先持久保存，再排入原任务。请求台账保留已完成历史被裁剪后的去重信息；结果未知时只核对，不能盲目重发。
- 反馈面板显示等待、投递中、已排队、已读取、已有回写、已处理、失败和未知，附阶段时间及原目标导航。Agent 的回复通过反馈序号关联到原回复或原想法。
- 同一个状态库只允许一个本地实例持有，避免两个内存状态或两个投递器争抢同一份数据。使用已有 SQLite 的 [exclusive locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode)，退出后释放；没有增加锁服务或新依赖。

## 四轮原生 Codex 验证

原任务：`01a0753b-0e36-70d1-b010-30a607d95ffe`，工作目录 `G:/Demos/Calendar`，来源 `codex:calendar-sol-20260906`。实际系统 CLI 为 0.153.4，模型按此前用户选择保持 Sol / high。验证回复为 `calendar-native-canvas-20260907`，原块 ID 保持 `focus`、`options`、`dependencies`、`plan`。

先由真实 CLI 调用注册的 `spellcast_bind_codex → spellcast_board → spellcast_reply` 创建可编辑内容；后续请求来自实际鼠标/键盘输入，未通过手工转述驱动 Agent。原 CLI 的新轮次逐一调用原生 `spellcast_listen → spellcast_board → spellcast_update → spellcast_ack`。这里的原生证据是宿主记录的 `mcpToolCall`，不是 REST 测试或 Agent 自报。

| 反馈序号 | 场景 | 排队 | 原任务读取 | 内容回写 | 处理确认 |
| --- | --- | ---: | ---: | ---: | ---: |
| 3 | 实际点选块内追问，原块改为一句解释 | 0.241 s | 27.601 s | 56.737 s | 69.393 s |
| 4 | 保持未保存编辑，让 Agent 同时更新该块 | 0.311 s | 18.568 s | 36.218 s | 43.284 s |
| 5 | 关闭预览后端，启动真实 Tauri 窗口，再从原生 WebView 追问 | 0.314 s | 20.577 s | 43.205 s | 52.000 s |
| 6 | 在正式图编辑器新增节点和带标签的关系并保存 | 0.280 s | 12.424 s | 43.739 s | 50.916 s |

四轮均到 `handled`。最后回复 revision=6，图保持 4 个节点、3 条关系，方案仍为 `protect-runway`。第 5 轮确认后端重启后，仍由原 CLI 任务通过原生工具接续。真实桌面 URL 为 `http://tauri.localhost/`，`__TAURI_INTERNALS__` 存在。

时间以服务器持久接收事件为起点；回写时间是状态提交时刻，未单独测量首次屏幕绘制。上述结果说明传输排队约 0.24–0.31 秒，模型完整处理约 43–69 秒；不能称为模型即时回复，也不能用单次 MCP 调用的几毫秒代替整段延迟。

## 在反复操作中修正的问题

1. 快速移动后撤销，待保存队列仍可能持有撤销前的位置：现把撤销后的实际位置同步回待保存集合，重载后核对位置和尺寸。
2. 图编辑反复清除并重用相同节点 ID 时，异步渲染留下旧节点：统一在图实例中同步清理与绘制；连续三次编辑/取消，DOM 节点数一直为 4。
3. 聚焦一个高卡片可能把标题裁到工具栏后面，窄窗口缩放又使文字太小：聚焦改为复用编辑器的阅读窗口。880×640 实测阅读区域为 846×600、字号 14px，无整页溢出。
4. 底部继续输入与块内追问可能共用草稿键：已隔离，并实际输入两段不同文字、刷新、分别恢复。
5. 旧窗口的迟到清理可能删除另一窗口较新的草稿：清理前核对持久记录，保留更新后的文字。

第二轮中，Agent 更新后再保存旧编辑，后端拒绝覆盖，原草稿仍留在输入框。另用标明 `DIAG_ONLY` 的独立测试内容注入“同 ID 换类型”和“移除原块”，验证真实 UI 输入在更新、刷新后仍能从草稿入口取回。这两项属于故障注入证据，不冒充原生 Agent 自发行为。

## 自动检查与交付边界

- `npm run build`：通过。
- `cargo test --workspace`：52 通过，其中桥接 37、核心 15。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：9 通过、1 项交互桌面监测测试按原设置忽略。
- `node scripts/check-reply-drafts.mjs`：通过来源隔离、恢复、失败存储、容量边界、窗口合并、迟到清理和损坏数据保留检查。
- Windows 桌面构建：`npm run tauri -- build --debug --no-bundle`。这是本地调试构建，未发布安装包。
- 本次运行使用 `artifacts/canvas-hardening/acceptance.sqlite3`，保留用户原数据库和既有脏文件。未提交或推送；此前 GitHub 文案更新仍按用户要求留待下一次 push。

CLI 环境读取命令曾被自动审批以 `blocked by policy` 拦截；没有把它算作身份读取成功。随后使用宿主 stdout 的真实 `thread.started` 字段和启动工作目录作为当前任务身份，绑定结果与之完全一致。一次 Windows Terminal 启动标题的引号错误导致“找不到指定文件”，已修正参数并核对实际 CLI 进程；该错误没有修改项目文件。

## Codex App 通信的单独状态

Codex App 原生任务工具可以读取和发送任务消息。对于用户进一步询问的 **CLI queue → Codex App 当前对话**，向当前真实任务 `01a0726d-5237-7d02-b889-d0c195cce284` 提交了无额外工作的测试标记，队列 ID 为 `01a07ab1-cb16-76f3-a73d-be149a6aded9`。原轮次执行期间，查询确认队列中有这一项；原轮次结束后，标记 `CLI_TO_CODEX_APP_CANVAS_20260907` 实际作为当前 App 对话的新消息到达，并启动了下一轮响应。随后只读复查队列，数量为 0，没有手动删除该消息或再发测试标记。

因此：本机 0.153.4 的 CLI 排队消息可以进入指定的 Codex App 对话，已超出“仅成功入队”的证据范围。这次验证的是忙碌任务在原轮次结束后接手；没有证明中途打断、关闭 App 后自动唤醒，或所有版本和远程主机都具有相同行为。独立 App Server 复查仍返回 `notLoaded`，再次说明这个字段不能用来判定其他宿主中的任务是否正在运行。

当前 App 宿主还已直接调用原生 `spellcast_board` 读取画布，以原生环境核对到的 `CODEX_THREAD_ID` 调用 `spellcast_bind_codex` 绑定本任务和 `G:/VibeProj/spellcast`，再通过原生 `spellcast_reply` 写入结果卡片 `canvas-implementation-20260907`。收到 CLI 测试消息后，本轮重新读取该卡片，以原生 `spellcast_update` 更新其证据块。这补上了当前 App 的原生读取、绑定、写回，以及 CLI 队列消息实际到达 App 的证据；它与前述四轮完整 Canvas → CLI 反馈回路分别记录。

## Canvas → 当前 Codex App → Canvas 完整回路

2026-09-07，用户授权继续验证后，Agent 在同一 Windows 原生 Tauri 窗口中，点击 `canvas-implementation-20260907` 的 `result` 块的 Ask，输入“请把这一块整理成三条简短说明，直接更新原块，保留其他内容。”，点击 Send 一次。这是 Agent 操作原生 UI 的真实输入证据，未冒充用户亲手操作，也没有通过 HTTP 伪造反馈。

反馈序号为 `7`，请求 ID 为 `87e2d710-04d6-4ab5-b088-891434c9b3e7`，队列 ID 为 `01a07b0a-c1d6-7b01-b191-067bfebc5605`，来源绑定到当前 App 任务 `01a0726d-5237-7d02-b889-d0c195cce284`。提交后先确认成功入队，没有主动读取或确认这条反馈。上一轮结束后，Canvas 通知实际作为当前 App 对话的新输入到达，才调用原生 `spellcast_listen`、`spellcast_board`、`spellcast_update` 和 `spellcast_ack` 处理该序号。

原回复修订从 `2` 变为 `3`，只把 `result` 块更新成三条说明。逐项比较确认其他块、其他回复、想法和 Canvas 布局完全一致；原生窗口中的目标块可见并显示了三条新内容。最终回执为 `phase=handled`、`error=null`，序号 7 已从待处理列表移除。

| 从服务端保存请求起计时 | 毫秒 |
| --- | ---: |
| 入队 | 800 |
| App 原生工具读取 | 85,886 |
| 原块回写 | 99,274 |
| 处理确认 | 105,797 |

这些时间包含上一轮检查、结束轮次和下一轮接手的等待，不是纯模型推理耗时或点击到首次绘制的延迟。此次已完成一轮 Canvas → 当前 App 自动接手 → 原块回写的完整验证；仍未证明中途打断或关闭 App 后唤醒。

核验同时发现块内追问的发送成功提示一直写着“等待原任务”，即使真实回执已经处理完毕也不变化。该固定提示现只确认“已保存，可在反馈查看处理进度”，块内追问与底部输入的中、英、日三种语言一并修正；实时阶段继续由现有反馈面板显示。

该文案修正后重新运行 `npm run tauri -- build --debug --no-bundle`（包含 TypeScript 检查和前端构建），以及 `git diff --check`，均通过。重启原生测试窗口后，原生 MCP 读取仍为回复修订 3、布局修订 6，反馈面板实际显示该请求为 Handled；当前窗口载入的资源包含三语新提示，已不含旧等待文案。该修正仅改固定提示，没有再次提交反馈或重跑整条队列测试。

## 后续产品方向：Everything Canvas（用户于 2026-09-07 明确）

用户明确要求让 Canvas 解放 Astra 等模型的表达方式，点名 SVG、Three.js 和生图结果，并允许质量优先、不以节省调用额度为由收窄表达能力。前文“四类块”和“不引入任意生成代码”仅记录已完成阶段的范围，不作为后续产品上限。

当前实现事实：回复协议和渲染器仍只接收 text、comparison、graph、sequence。Three.js 已用于应用自己的空间布局，但尚未开放为模型可提交的场景；SVG、生图文件及交互网页也尚无正式回复入口。前述反馈回路通过，不等于这些表达能力已实现。

后续需要开放可持续编辑的产物区域：模型可以选择原生文字、SVG、图片、HTML/CSS/JavaScript、Canvas 2D 或 Three.js/WebGL 来表达，同一画布可混合并置。四种已有结构块保留为便捷组件。生图能力由现有模型宿主调用，Canvas 接收并持久保存生成文件、来源和后续版本；不绑定单一生图供应商。

实现应围绕一个通用产物入口及资源链路展开，避免为每种图形或场景重新增加封闭模板。产物保留源文件、稳定 ID、来源任务、修订和可回传的选择上下文，让“修改这条 SVG 曲线”“展开这个 3D 部件”“调整这张图的局部”能继续落到原产物。显示成功、交互可用、选择回传和原位修改应分别验收。

浏览器原生能力已覆盖 SVG 图像与可运行交互文档；动态内容的运行隔离应保护宿主数据和任务控制权，而不把表达重新限制为预设图表类型。可参考 [MDN SVG 图像](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)、[MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) 和 [Three.js 资源释放](https://threejs.org/manual/en/how-to-dispose-of-objects.html)。具体运行方案仍需原生 WebView 验证；本节是已确认目标和实现方向，没有把尚未实现的能力列为通过。

按用户进一步要求，对更广泛的表达需求、候选引擎、推荐组合与验收样本的研究见 [Everything Canvas 选型报告](2026-09-07-everything-canvas-options.md)。该报告区分选型建议与当前已经实现的能力。
