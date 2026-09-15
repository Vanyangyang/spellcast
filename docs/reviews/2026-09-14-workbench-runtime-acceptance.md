# Canvas 工作台运行版验收

本轮实现已直接更新到本机运行版，未加入新的旧版本兼容逻辑。

## 已交付

- “添加组件”支持文字、图片、矩形、椭圆、比较、关系图和步骤。新增内容选择附近空位，失败重试沿用请求和对象身份。
- 独立结构组件复用已有编辑器，直接保存到 Canvas 对象；交互作品保留原有资源和参数生命周期，可以加入同一 idea。
- 多个组件可组成一个有名称、说明和阅读顺序的 idea。可增减、排序成员；移出组合保留内容与位置。用户修改受版本检查和提案保护。
- 按记录的工作区及原任务筛选。新增手工组件记录当前工作区；没有证据的旧归属继续显示“待整理”。不根据相邻位置自动连线。
- 整体 idea 的反馈携带成员内容和组合版本；响应还需声明组合读取依赖。
- 选择和编辑只保存本地状态及防重复记录，不进入待跟进队列；是否关联任务不改变这一规则。用户明确点击发送后，才提交当前最终内容。
- 比较、关系图、步骤采用浅色画布样式，历史长标题可在原尺寸内换行。
- 选中内容后，“交给”默认选中其原任务；整体 idea 使用归属任务，引用组件不改变默认收件人。用户手动改选保留到当前对象草稿，切换内容重新采用相应原任务。
- 原任务删除后保留名称与来源，显示“原任务已删除”并阻止发送，允许用户主动改选。归档、未关联、关联变更和临时读取失败分别处理，不混为删除。
- 提交事件固定接收任务 ID；来源后续重新关联到其他任务时，待发反馈不会自动改投。相同请求重试仍使用原始回执。
- 改选非原任务须确认警告，显示原任务、新任务及工作区；取消和 Esc 保持当前任务及草稿。确认只改变接收人，不自动发送。返回原任务不重复警告。

## 验证范围

- Core 44 项、Bridge 66 项、Hook 35 项、Server 11 项 Rust 测试在相关回归批次通过。
- TypeScript、Vite 构建及组件插入、工作区/任务隔离、内容归属检查通过。
- `scripts/check-workbench-assembly.mjs` 使用真实 Rust API、独立 SQLite 和浏览器输入。覆盖：提交成功但响应丢失后重试、比较编辑/选择、混合组件组合、说明草稿恢复、冲突审阅、成员移出、交互作品参数和进程重启持久化。HTTP 仅准备测试夹具；响应丢失为明确的故障注入。
- Windows 原生窗口实际完成插入比较组件及选项操作。最后一次本地选择核验得到 `selected_id=b`、内容版本 2、`pending=0`、`deliveries=0`；测试窗口正常退出，退出码 0。
- 正式更新后的窗口已查看：历史长标题完整换行，设置面板显示接入已安装，未再显示源冲突。

## 当前运行状态

- 程序：`G:\VibeProj\spellcast\src-tauri\target\debug\spellcast.exe`
- SHA-256：`87c9452fbb5ed70c488f4adfb490ed2542dbfb1969b93779c014becb7f9a9a7a`
- Codex 插件：`spellcast@personal`，版本 `0.3.0+sc.b2c73cd57898`。原生 CLI 确认 installed/enabled；源和缓存的 9 个静态载荷文件与发行资源一致，MCP 指向 47194。
- 最后一次更新前后的 6 条点子、5 条历史边、1 份回复、11 条消息、8 个 Canvas 对象及全部既有字段和布局逐项一致；没有清理历史内容。
- 物理数据库备份：`artifacts/workbench-20260914/native-codex-only-20260915/direct-physical-state-87c9452f/`。备份通过解包进程访问实际 AppData，避免 Codex Appx 的重定向副本。
- 原程序和资源备份：同目录下 `runtime-original/`。用户接入配置备份在 `C:\Users\Administrator\AppData\Local\SpellcastAcceptance\profile-native-codex-only-20260915`。

关键证据：`artifacts/workbench-20260914/assembly-1789371772478/result.json`、`native-workbench-20260914-0739/native-choice-result.json`，以及 `native-workbench-20260914-final/` 下的 `direct-result.json`、`production-preserved.json`、`plugin-verified.json`。

## 原任务默认选中补充验收

- Core 44 项和 Bridge 67 项测试通过；新增回归确认关联变化不会发往替代任务，且不会启动连接进程，原请求重试保持原回执。TypeScript、Vite、Windows 构建通过，`git diff --check` 通过。
- 浏览器使用实际 `CanvasRecipient` 模块及明确的状态夹具，覆盖默认来源、旧对象经节点恢复来源、组合归属、手動改选及草稿恢复、删除保留标签与禁发、未知状态不误标、异步核验期间切换选择取消旧发送。证据：`artifacts/workbench-20260914/recipient-1789375583458/result.json`。
- 真实 Rust API + 隔离 SQLite + 原生 Codex 元数据核验通过：本任务 available，错误工作区 changed，无绑定 unlinked，指定不存在 UUID deleted，真实归档任务仍存在。未删除任何用户任务、未发送模型回合。证据：`artifacts/workbench-20260914/task-target-1789375850591/result.json`。
- 原生 `thread/read` 的 `thread not loaded` 本身不等于删除；只有完整检索当前及归档任务均未找到时才标注。真实长历史曾触发每帧 2 MB 限额，现采用每页 25 条；本机不存在任务核验约 9.5 秒。超时、缺页、异常仍显示暂时无法核验。
- 更新后在原生窗口实际点击“两种推进方式”，自动选中“审查产品理解偏差并找方案 · 原任务”。没有发送测试反馈到生产任务。截图：`artifacts/workbench-20260914/native-recipient-20260914/original-task-selected.png`。
- 同目录 `direct-result.json`、`production-preserved.json`、`plugin-verified.json` 确认替换、原有数据逐字段保留及插件载荷一致。
- 边界：旧 `check-canvas-feedback-20260914.mjs` 在首个 `.canvas-frame` 可见性等待处超时，本次没有把该历史整体验收脚本算作通过。上述针对性模块、原生元数据及当前运行窗口证据各自独立，不代表完整历史 UI 回归全部通过。

## 改派确认补充验收

改派确认补充验证：`scripts/check-canvas-recipient.mjs` 的 10 组浏览器检查通过，包含取消/Esc 不改接收人或草稿、确认后才提交选择事件、待确认时禁发、回到原任务不弹警告，以及内容或目标身份变化使旧确认失效。证据：`artifacts/workbench-20260914/recipient-1789376919380/result.json`。TypeScript/Vite 与 Windows 构建通过。

原生运行窗口实际选择“社区共享工具借还方案”，显示原任务、新任务、两个工作区和改派说明；点击取消后恢复“审查产品理解偏差并找方案 · 原任务”。证据：`artifacts/workbench-20260914/native-recipient-confirm-20260914/native-confirmation.png`、`native-cancelled.png`，同目录 `direct-result.json` 和 `production-preserved.json`。未向生产任务发送测试内容；原有数据逐字段保持一致。

## 内容块选中反馈

原先第一块自动选中，按钮却始终叫“关注这一块”；重复点击无状态变化，底部又优先显示整份回复标题，用户无法明确判断实际目标。

现改为“针对这块讨论” / “✓ 已选中”，配合当前讨论对象标记、选中边框和点击后的明确提示。底部使用锚定块标题。提示不增加内容高度；按钮保持宽度，避免聚焦时文案变化让点击目标移动。普通、未激活的卡片不显示内部默认选择高亮。

完整 dist 页面浏览器回归通过：默认状态、重复点击提示、切换块时高亮及具体标题同步、分块草稿恢复、键盘操作、未激活卡片样式。API 全部使用隔离夹具，远程字体阻止访问，没有生产请求或写入。证据：`artifacts/workbench-20260914/block-focus-1789378246505/result.json`。

Windows 原生最终运行版点击“当前建议”后，按钮、紫色高亮、底部目标和提示同步变化。截图及 UIA 记录：`artifacts/workbench-20260914/native-block-focus-final-20260914/native-selected-block.png`、`native-selected-block.txt`。同目录记录实际替换及原有画布逐字段保留。TypeScript/Vite、Windows 构建通过，未发送测试反馈。

## 原生直接交付补充

空闲原 Codex 任务的接手和实际执行回传已完成：五次原生窗口提交均在原任务执行并回写同一对象（版本 1→6），且具有匹配的反馈处理回执。运行中并发提交和实机断线不在这五次通过范围内。实现、测试与证据见 [原生交付验收](2026-09-14-native-canvas-delivery.md)。未新增独立模型、未重启 Grok 执行器。

设置面板的“待信任”是当前安装器对宿主 hook 信任状态的保守描述。本轮验证了插件 installed/enabled 和文件一致性，没有改写 hook 信任，也没有重新进行新任务的无提醒旁念激活试验。

## 工作区优先接收任务与 Browser Use 补充

运行版已改为先选工作区、再列该工作区的 Codex 任务；已有内容自动选中原工作区和原任务。改派取消保留选择与草稿，发送按钮明确为“发送到 Codex”。本次替换与原数据逐字段比对证据位于 `artifacts/workbench-20260914/native-workspace-recipient-20260914/`。

用户要求以 Browser Use 完成后续界面检查。实际浏览器点选发现并修复了改派时遗留旧收件人草稿副本的问题；该修复已随下面的收起式入口一起部署到运行版。详见 [浏览器接收任务验收](2026-09-14-browser-recipient-acceptance.md)。

## 底部接收任务按需展开

底部默认仅显示“发送给：任务名称 · 原任务”和“更换”。工作区和任务选择器只在点击更换后展开，展开期间禁发；取消、Esc 或改派确认完成后收起。未选内容时隐藏整个接收任务入口。顶部工作区和任务仍只负责浏览筛选，不能替代选中内容的原任务归属。

14 组接收任务浏览器回归、完整 dist 回归、TypeScript/Vite 和 Windows 构建通过。Browser Use 实际完成默认收起、展开、更换工作区、取消恢复、确认改派、发送及重新选中验证；确认发送记录的任务 ID 与原对象版本匹配，已发送草稿没有恢复。

证据：`artifacts/workbench-20260914/recipient-1789393963506/result.json`、`block-focus-1789393975612/result.json`、`browser-recipient-1789394027512/evidence.json`。Browser Use 使用隔离 API，不包含新的原生任务执行回合。运行文件已正常重启替换；`native-compact-recipient-20260914/direct-result.json` 与 `production-preserved.json` 确认新进程运行和所有原有画布字段逐项保留。

## 中间操作仅本地保存，显式发送才反馈

用户选择比较选项、保存内容或点子修改时，只记录本地 Canvas 状态，不创建可投递反馈、不写入用户会话消息，也不作为任务指令从 `spellcast_listen` 返回。重复选择同一选项不会增加内容版本。布局编辑仍只更新布局。历史反馈保留，不自动清理。

点击“发送到 Codex”才创建一次反馈，携带当前对象及内容块的最新版本。补充文字可留空；选中内容并具备有效接收任务时，直接提交当前选择和修改。明确的提问表单仍在用户点击其发送按钮后提交，任务归属和改派确认规则保持有效。

验证：Bridge 75 项、Core 44 项测试通过，新增回归覆盖多次选择、重复选择、内容编辑、重启后保持本地状态及最终发送。TypeScript/Vite、Windows 构建和 `git diff --check` 通过。完整 dist 的内容块选择、草稿和接收任务回归证据：`artifacts/workbench-20260914/block-focus-1789398930473/result.json`。

Browser Use 使用真实 Rust API 与隔离 SQLite，实际完成选择 a、改选 b、编辑并保存备注；发送前内容版本为 4，待反馈和投递记录均为 0。不填写额外文字，点击一次发送后，两者均为 1；提交锚点引用版本 4，最终选项为 b。证据：`artifacts/workbench-20260914/final-send-1789399000290/evidence.json`。

验收边界：任务可用性及任务身份是夹具，代理核验请求携带的任务 ID 后，只对隔离后端移除该字段以保存未绑定请求，确保测试不启动真实模型。此批验证本地编辑与最终请求生成，不包含新的原生 Codex 执行回合。此前首轮夹具在最终发送时因缺少真实任务绑定失败，仅保留其本地状态证据，没有计作发送通过。

运行版已正常关闭、备份、替换并重启；`artifacts/workbench-20260914/native-final-send-20260914/` 中的 `direct-result.json`、`production-preserved.json`、`plugin-verified.json` 分别确认运行进程、全部既有画布字段保留及已安装插件载荷一致。

## 用户请求优先的交付流程

新通知先显示用户留言原文、对应画布标题；有已绑定任务时显示任务和工作区，再附请求编号及一次原生读取指引。多行留言保持分行引用，标题按数据转义；通知在提交时保存，后续重试不因标题变化而改写原请求。历史聊天和既有回执不改写。

`spellcast_listen` 新增 `sequence`：必须同时指定来源，只读取该条仍待处理的请求，立即返回，不受 `since` 或 `wait` 影响。缺失、已确认或属于其他来源的请求返回 `status=not_pending` 和空事件；不会读取或标记其他留言。通用事件流仍通过 `pending_sequences` 区分历史与待处理内容。

实际处理指引随工具结果的 `handling` 返回，明确用户留言决定测试、询问、讨论或执行范围，引用内容不是额外授权；只有请求涉及锚点、组合或作品时才附相应读取要求。已有回写通过 `response` 返回，先核验结果再确认，不重复生成。同一对象、版本保护、冲突提案和完成回执要求保留；不强迫为测试生成内容。

Bridge 80 项、Core 44 项测试通过，包含原文显示、标题快照、防伪装元数据、按需指引、精确读取、跨来源隔离、已确认历史不重放和已回写未确认的分支。Windows 构建通过；已修改的跟踪文件 `git diff --check` 通过。本轮没有前端代码改动。

Browser Use + 真实隔离 Rust API/SQLite 实测：选项 b 本地保存后投递为 0；发送“这只是测试，请不要执行所选方案，也不要改动画布内容。”后只有 1 条投递。生成通知保留完整原文与“比较回复 / 选择推进方式”标题，引用内容版本 2；证据：`artifacts/workbench-20260914/final-send-1789400704196/evidence.json`。任务身份仍为隔离夹具，没有启动真实模型回合，因此不将提示词约束视作已完成的模型行为验收。

部署后在本任务调用原生 MCP，按实际来源精确读取已经确认的序号 73，得到 `requested_sequence=73`、`status=not_pending`、`events=[]`、`pending_sequences=[]`。没有执行旧请求或确认其他反馈。证据：`artifacts/workbench-20260914/native-handoff-flow-20260914/native-read-check.json`。同目录的运行替换、逐字段保留和插件校验记录全部通过。
