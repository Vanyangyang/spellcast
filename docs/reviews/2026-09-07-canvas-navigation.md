# Canvas 拖动与多卡片显示修正

已在 Windows 原生窗口实现并检查。整张卡片可以拖动，双击进入正常大小的内容阅读器；按住空格、中键拖动，或打开 Hand tool，可从卡片上平移画布。

All cards 提供固定字号的卡片总览，点击标题打开内容，Locate 定位到可读大小。Tidy layout 将现有卡片排成网格；本次操作在当前窗口内可一次撤销、重做。普通滚轮以鼠标位置缩放，比例按钮显示实际倍率。

根因和修正：

- 新卡片原先只向下避让，形成很长的单列。现在按三列寻找空位，并保留已有卡片的位置。
- 正文拦截拖动事件。画布卡片现为可整卡拖动的预览；打开后，原有输入、选择、编辑和作品控制继续可用。
- 启动时查看全部会把大量内容缩得很小。现在恢复上次视角，首次打开聚焦到一张卡片；总览另用正常字号显示。
- 输入区加载和窗口缩放会改变画布尺寸。现在保持画布中心，避免重启时视角漂移。

验证：

- `npm run tauri build -- --debug --no-bundle` 成功，包含 TypeScript、Vite 和原生构建。
- 本轮 Rust 检查 57 项通过；新增卡片分列、不重排已有位置、无重叠有断言覆盖。
- `node scripts/check-canvas-navigation.mjs`：原生 WebView2 CDP 鼠标／键盘输入通过整卡拖动、撤销、三种平移、双击打开、作品停止／重启、整理后一次撤销／重做；内容与参数保持不变。
- `node scripts/check-canvas-navigation.mjs --after-restart`：正常关闭、重新启动后，布局、节点、回复相同；缩放 100%，中心 `(238, 198)` 相同。
- `node scripts/check-canvas-wheel.mjs`：普通滚轮放大／缩小、鼠标锚点、实际比例、查看全部后的缩小、阅读器滚动不缩放外层画布通过。
- 原生窗口 `880 × 640`：13 张卡片、标题 18px，总览无横向溢出；恢复 `1320 × 860` 后中心和缩放相同。已检查两种尺寸截图。
- `git diff --check` 通过。未提交或推送。

运行结果：`artifacts/canvas-navigation/{result,after-restart,resize-check}.json`；截图：`artifacts/canvas-navigation/overview.png` 和 `overview-narrow.png`。

当前运行的是本地 debug 构建，使用本任务既有 acceptance 数据库。以上为 Windows 原生窗口自动化证据；不表示用户已亲手验收，也不表示其他平台已验证。

后续补充：W/A/S/D 分别向上、左、下、右移动视角，支持系统按键重复。点击画布正文或空白处会接收键盘焦点；输入框、可编辑文字、组合快捷键和打开的对话框不触发移动。原生构建及 `node scripts/check-canvas-navigation.mjs --wasd` 通过，覆盖四方向、重复按键、打字、Ctrl+A、回到画布及总览隔离，卡片布局和内容相同。结果见 `artifacts/canvas-navigation/wasd.json`。

后续补充：选中卡片后的 Delete / Backspace 已接入两类卡片的单项删除。复用想法节点的删除逻辑，并补上回复删除、内容版本检查、布局同步和持久化；不会清理作品的历史资源。前端收到成功结果后才移除卡片，保留未发送草稿。

本次 `cargo test --workspace` 为 58 项通过，新增检查覆盖 HTTP 删除、过期版本拒绝、重试幂等、相关连接和已保留气泡映射清理、其他卡片不变、重启与作品历史保留。TypeScript / Vite / Tauri 原生构建通过；`node scripts/check-canvas-delete.mjs` 用两张无任务绑定的临时卡片完成真实键盘删除，检查输入框和弹窗保护、人为网络失败时保留卡片、无选区时不误删、未发送草稿仍在。原有节点、回复、连接、位置、草稿与视角逐项不变，结果为 `artifacts/canvas-delete/result.json`。网络失败为 DIAG_ONLY；临时卡片和其草稿已清理，未删除用户原有卡片。
