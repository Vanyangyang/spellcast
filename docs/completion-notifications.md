# Codex 完成气泡

已实现并在本机安装。已读同步随新版 Spellcast 生效，无需修改 Codex 配置；首次安装通知入口后，Codex 需要重新加载配置，重启 App 可让已打开的旧会话统一使用新入口。

## 使用

- 本机 Codex 主任务的一轮运行结束后，气泡出现在当前显示器右上方，始终位于其他窗口上方。
- 气泡按来源区分样式，同时出现时一眼能分清（样式见 `src/completion-clients.css`）：Codex 是靛蓝极光玻璃卡片（蓝紫渐变边、20px 圆角、发光对勾、从右侧弹入），Claude Code 是浅色暖纸卡片（陶土色侧边、衬线正文），Grok Build 是黑色终端块（直角、白色信号条、阶梯式出现）。每张卡片还带来源标签，不只靠颜色区分。卡片的主体是完成回复：去掉 markdown 符号（标题井号、列表符、粗体、反引号、链接、代码块）后的纯文本，最多三行，超出以省略号结尾（收件箱里最多存 240 字）。任务名只是上方一行淡色小字，用来在多个任务同时完成时分清是哪一个，不再当标题；任务名从不是提示词，没有名字就只显示项目名，与项目同名时也不重复显示。卡片不会因超时消失，重启 Spellcast 后仍可恢复。
- “Codex 任务”等通用占位名会隐藏，保留有实际内容的任务名称；气泡高度随内容收缩，每张最高 148px（窗口按每张 160px 预留）。
- 任务名在卡片显示时读取，而不是在任务结束时：Codex 取 `$CODEX_HOME/session_index.jsonl` 里该线程最新的 `thread_name`，没有则用 Codex 线程库里的标题；Claude 取 CC GUI 数据库（`~/.ccgui-next/app.db`）`sessions.custom_title`（你手动改的名字或“会话自动命名”插件写的名字，通常在一轮结束后几秒才出现，已显示的卡片会随之更新），没有则用 transcript 里的会话标题。CC GUI 的 `title` 列是第一条消息，不使用。数据库以只读方式短暂打开，`SPELLCAST_CCGUI_DB` 可指向副本用于检查。
- 双击气泡进入对应 Codex 任务；键盘选中后按回车也可打开。打开成功后气泡淡出并永久移除；打开失败时继续保留。只移除被点击的完成轮次，保留同时到来的新轮次。
- 直接在 Codex 打开对应任务、使它从未读变为已读后，Spellcast 也会在下一次同步时移除这条完成气泡，并取消尚未播出的语音。同步每秒检查一次，实际延迟还取决于 Codex 保存已读状态的时间。
- 点击右上角 × 移除气泡。同一任务再次完成时会重新出现；多任务自动排列，超出屏幕高度时可滚动。
- 关闭 Spellcast 主窗口会退出整个应用，通知窗口与后台服务一同停止；关闭单条完成气泡只移除该提醒。应用退出期间，通知钩子仍可保存完成事件，但不会启动界面；下次主动打开 Spellcast 时恢复未移除的提醒。
- 按线程保留最新完成轮次，重复的同一轮通知不会增加气泡。内部子任务通知会被过滤。
- CC GUI 的 Leader 子聊天不出气泡，结果由父聊天汇报，父聊天照常出气泡。CC GUI 在子聊天的 CLI 进程上设置 `CCGUI_LEADER_CHILD=1`，Claude 的 `Stop` 钩子和 Codex 的通知程序都会继承；值恰好是 `1` 时不记录这一轮，Codex 的原通知仍照常转发。CC GUI 定制版从提交 `223f14ed3` 起设置这个标记，更早的构建启动的子聊天仍会出气泡。
- Windows 默认开启离线轻声提醒：每个完成的来源先播自己的提示音，再播一句“有任务完成了”，不朗读标题或回复内容。提示音是程序内合成的短音，不带音频文件、不联网：Codex 是高音、上行的玻璃铃声（约 0.9 秒），Claude Code 是中音、下行的木质轻叩（约 0.6 秒），Grok Build 是三下短促的控制台“哔”声（约 0.35 秒）；三者按平均响度调成一致，都比较轻。其他来源按 Codex 处理。3 秒内的通知合并一次：同一窗口里多个来源完成时按到达顺序各播一次自己的提示音，之后只念一句；每个来源 90 秒内最多一次，所以 Codex 刚响过，30 秒后 Claude Code 完成仍会响；22:00–08:00 按系统本地时间静音。没有中文系统语音时使用英文短句。
- 气泡顶部的“轻声提醒”按钮可随时关闭提示音和语音，设置跨重启保存。重启恢复的旧通知、静音期间的通知和冷却期内的通知不会补播。打开或移除气泡后，尚未开始的相应提醒会取消。提示音的 WAV 预览可用 `SPELLCAST_SOUND_PREVIEW_DIR=<目录> cargo test --lib write_tone_previews -- --ignored` 导出。

这里的“完成”指 Codex 发出 `agent-turn-complete`，不代表项目已经通过验收。接入覆盖启用后的本机任务、所有项目；历史任务和其他主机/云端完成事件尚未接入。

## 安装与停用

在本机已执行安装。其他机器可在构建桌面程序后执行：

```powershell
.\src-tauri\target\debug\spellcast.exe --install-completion-hook
```

安装器只修改 Codex 用户配置的 `notify`，保留原命令及参数，并备份原配置。新的通知入口先转发原通知，再记录 Spellcast 完成事件，不依赖 Agent 主动调用 MCP 或消耗模型额度。

停用新事件接入并恢复原通知：

```powershell
.\src-tauri\target\debug\spellcast.exe --uninstall-completion-hook
```

停用后重新加载 Codex 配置。已有气泡可逐条关闭。

独立的通知程序、原通知设置和完成收件箱位于 `$CODEX_HOME/spellcast/completions`，默认是 `~/.codex/spellcast/completions`。收件箱使用自己的 `inbox.sqlite3`；Codex 的 `state_*.sqlite` 仅以只读方式查询线程标题和来源。未知线程会暂存，等待其元数据写入。

已读同步只读 `$CODEX_HOME/.codex-global-state.json` 的 `electron-thread-read-state-v1`（本机 Codex 26.908.4834 的持久状态格式）。Spellcast 在自己的收件箱记录每个完成轮次对应的本地账号/主机未读观察；只有相同范围明确从未读变为已读才移除。观察记录跨重启保存，账号退出、主机切换、缺失/损坏/未知版本状态均不清除提醒，其他主机的状态不用于确认本机通知。首次启用前已经读过的旧通知、未曾观察到未读状态的通知仍需手动关闭；不能仅凭“不在未读列表”推断它已被用户查看。这是对 Codex 私有持久格式的兼容接入，格式变化时保留提醒。

同步在后台线程执行。没有待处理通知时不读取 Codex 已读文件；有通知时每秒检查文件大小、修改时间和待处理轮次。成功同步后，它们未变时跳过 JSON 读取/解析以及已读同步的数据库操作，只有确实清除了通知才重复查询待处理列表。缓存仅保留文件元数据和轮次 ID；每 30 秒做一次完整复查，避免低精度时间戳导致变化被永久漏掉。文件超过 16 MiB 时直接保留提醒，不继续读取。前端仍只在通知内容变化时刷新。

性能测量与优化记录见 [已读同步性能](completion-read-performance.md)。

Codex 的通知格式依据 [OpenAI 的 legacy notify 实现](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/legacy_notify.rs)。跳转使用 `codex://threads/<thread-id>`；已在本机 Codex 26.903.9818 的 URL 解析实现中确认该路径，并限制参数为 UUID。

## Claude Code 完成气泡

Claude Code 的 `Stop` 钩子在主代理结束一轮回复时触发，可以把完成事件写进同一个收件箱；卡片是浅色暖纸样式，带 “Claude” 来源标签。用户中断不会触发 `Stop`；子代理走 `SubagentStop`，不会产生气泡。

```powershell
.src-tauri	argetdebugspellcast.exe --install-claude-completion-hook
.src-tauri	argetdebugspellcast.exe --uninstall-claude-completion-hook
```

- 安装器只在 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json` 的 `hooks.Stop` 里追加一组命令（exec 形式：`spellcast-notify` 加 `--claude-notify <收件箱>`，超时 10 秒）。其余键、键顺序、缩进和换行符，以及其他 Stop 钩子（例如 claude-supervisor），都按原文复制；改动前备份为 `settings.json.spellcast.bak`。文件不是合法的 JSON 对象，或 `hooks`/`Stop` 形状不对时拒绝修改；写入前发现文件被其他程序改过也会放弃。卸载只移除这一组，文件恢复到与安装前字节一致。
- 钩子读取 stdin 的 Stop 载荷（`session_id`、`cwd`、`transcript_path`、`last_assistant_message`），不向 stdout 输出任何内容，因为 Claude Code 会把 stdout 当作决策解析。任务名取 transcript 末尾 512 KiB 内最新的 `custom-title`/`ai-title`，没有则留空（不引用提示词），卡片只显示项目名；摘要用 `last_assistant_message`，缺失时回退到 transcript 里最后一条文字回复。5 秒内同一会话的相同摘要只算一条。
- 一次性提问不出卡片：钩子由 claude 进程启动，Spellcast 读取该进程的命令行（Windows），`-p`/`--print` 且没有 `--input-format` 的（脚本里的 `claude -p "问题"`，以及 CC GUI“会话自动命名”插件每轮结束后用 `claude -p` 生成标题、测试连接时的调用）视为一次性提问，其 Stop 不生成卡片，否则每轮对话都会多出一张“正常”或命名 JSON 的卡。CC GUI 自己的对话以 `-p --input-format stream-json` 启动，终端里的交互会话没有 `-p`，都不受影响。读不到进程或找不到 claude 祖先进程时不隐藏任何卡片。
- 带 `agent_id`、`subagent_id`、`is_subagent`，或 `agent_type` 为 `child`/`subagent`/`observer` 的事件不产生气泡。Spellcast 自己的 Observer 以 `claude -p --safe-mode` 运行，该模式不加载任何 hooks。
- **CC GUI 里的会话**（插件版本 0.1.2 起，需要在 CC GUI 里重新“从本地目录安装”一次）：卡片和 Codex 一样可以回到对话。
  - 双击卡片或按回车：Spellcast 向该会话已登记的 CC GUI 插件下发一个聚焦请求，同时把 `ccgui-next.exe` 的窗口提到前台（插件 SDK 只能切换聊天，不能提升系统窗口；其他构建名可用环境变量 `SPELLCAST_CCGUI_EXE` 指定）。插件调用公共的 `sessions.selectSession` 打开聊天，并用一次明确的注意力心跳应答；3 秒内没有应答时卡片保留并提示 CC GUI 没有响应，可以再试。请求只在 8 秒内有效，过期的点击不会在之后把窗口拉回来。
  - 查看后卡片消失：插件在聊天被切换到、或 CC GUI 窗口重新获得焦点且停在该聊天时，会上报明确注意力。任务完成之后收到这个会话的新注意力，Spellcast 就移除这张卡片，和 Codex 从未读变已读的时机一致。仅有心跳（存活）不算注意力，注意力早于任务完成也不算；同一会话下一次完成会重新出现。
  - 提示文字随连接状态变化：有已连接的 CC GUI 窗口时是“双击回到 CC GUI ↗”，否则仍是“Claude · 双击关闭”。
- **没有 CC GUI 的会话**（命令行、官方 Desktop、`claude -p` 脚本、CC GUI 没运行或插件未连接）：没有回到会话的办法，双击只移除气泡。
- 限制：窗口一直停在该聊天里时任务完成，不会有新的注意力事件，卡片要等下一次切换/重新聚焦或手动关闭；同一会话同时有多个 CC GUI 窗口登记时，请求发给最近有过注意力的那个（再按最新登记），窗口提升则取最靠前的 CC GUI 窗口，两者不一定是同一个。
- 没有走 Claude 插件包：插件包的钩子和二进制有完整性校验与版本号，改动需要重新打包并重装。设置文件方式与 Codex、Grok 的安装器同构，可单独卸载。设置界面里暂时没有对应开关。

验证：`cargo test --manifest-path src-tauri/Cargo.toml --lib completion_hook` 覆盖载荷解析、子代理过滤、Leader 子聊天标记只认 `1`、transcript 回退、安装与卸载的保真（含 CRLF、没有设置文件、拒绝异常文件）。`node scripts/check-completion-claude-hook.mjs` 在隔离的 `com.spellcast.board.verify` 调试程序里，把钩子安装到假的 `CLAUDE_CONFIG_DIR`，再按 Claude Code 的方式（exec 形式、stdin 载荷、环境里没有收件箱）运行已安装的钩子，同时输入 Codex 和 Grok 完成，检查四张卡片的来源与样式、双击只移除被点击的 Claude 卡片、卸载后设置文件逐字节还原。该测试的 Stop 载荷按官方文档构造，是合成数据，没有启动真实的 Claude Code 会话，所以 Claude Code 实际触发 `Stop` 这一步没有被验证。

CC GUI 部分：`cargo test -p spellcast-bridge host_` 覆盖注意力时间戳、聚焦请求的下发、应答、过期与多租约选择；`node scripts/check-ccgui-spellcast-plugin.mjs` 覆盖插件对聚焦请求的处理（每个请求编号只处理一次、切换失败不影响轮询、暂停时忽略）；`node scripts/check-completion-ccgui.mjs` 在隔离的调试程序里用一个假插件走真实的桥接端点，检查提示文字随连接变化、存活心跳不算注意力、注意力只清除对应卡片、双击发出且只发出一次聚焦请求并清除卡片、不响应的窗口保留卡片并显示原因、没有窗口的会话仍直接关闭。真实的 CC GUI 窗口在这个检查里不会被触碰或提升（`SPELLCAST_CCGUI_EXE` 指向不存在的名字），所以真实窗口提升和真实插件在真实 CC GUI 里的行为不在覆盖范围内。

## 已读同步验证（2026-09-12）

- `cargo test --manifest-path src-tauri/Cargo.toml completion_ --lib`：12 通过、0 失败，1 项人工音频测试忽略。新增测试覆盖对应任务清除、跨重启观察、无效/缺失状态保留、账号/主机隔离和新轮次保护。
- Release 桌面程序构建通过。隔离原生测试向测试用已读状态写入未读→已读变化，确认真实通知窗口消失、清除持久化，以及同一任务的新轮次继续显示；原有双击、回车、语音、重启和滚动测试均通过。
- 这次原生测试使用合成通知和隔离 Codex 状态，不代表已经现场完成真实 Codex 点击→已读持久化→气泡消失的端到端验证。Codex 26.908.4834 的本机代码已确认已读操作会从相应列表移除任务，并保留空的账号/主机列表。
- 已读同步初版部署时，唯一进程 PID 70976、父进程 Explorer 9676；实际程序与 Release 的 SHA-256 均为 `80FD0395B9F1FD37957303B6056BE530ECC46C91A930C0099BE4CDDC1F1AD173`。后续缓存优化已部署，最新测试、性能数据及程序标识见 [已读同步性能](completion-read-performance.md)。
- 更新时直接从 Codex 子进程启动曾读到 Windows 包重定向下的旧演示画布；改用现有 Explorer broker 启动后恢复。未覆盖或重放生产画布库。完整 `/api/board` 的序列化 SHA-256 与本次更新前一致：`844e0d5df52d5030ecdfe6680ec585af88a535620fd7d0556e03835796faa400`，1 node / 1 reply / 2 objects / canvas revision 3；health 正常，observer 仍开启。

本次测试记录：`output/completion-notifications/check-1789200511439/report.json`。部署与恢复记录：`output/completion-notifications/deploy-read-sync-20260912/deploy.md`。

## 既有验证（2026-09-11）

- TypeScript/Vite 生产构建、Tauri 桌面程序构建通过。
- 首版 Tauri 单元测试：13 通过，1 项既有交互式显示器测试忽略。打开后移除与语音更新：8 项相关测试通过，覆盖打开失败保留、轮次竞争、合并播报、夜间/手动静音、重启持久化和冷却期。
- Windows 离线语音单次测试通过：系统默认音频设备执行一次 25% 音量的短句播报并正常结束；未测量扬声器的实际输出音量。
- 分来源提示音（2026-10-03）：单元测试检查三种提示音的 WAV 格式、时长、平均响度一致、开头音高各不相同，以及合并窗口内按来源去重、各来源冷却独立；导出的三个 WAV 能被 Windows 的声音加载器解析。发布时处于静音时段，没有真机播放过，扬声器上的实际响度和听感未验证；`completion_voice_native_smoke`（忽略的测试）白天运行会依次播三种提示音再念一句。
- 隔离原生测试通过：原通知参数完整转发、重复和内部事件过滤、窗口 `always_on_top=true`、半透明背景、真实 WebView 双击/回车后对应气泡消失并持久化、语音开关及重启后保留静音、超过普通气泡生命周期仍保留、重启恢复、关闭后的下一轮通知、13 个任务滚动排列、停用后恢复原通知。
- 原生测试使用隔离 Codex 元数据、收件箱和 Canvas。它向真实通知入口输入测试事件；不是一次真实 Agent 完成事件的端到端验收。打开命令成功返回也不等于已目视确认 Codex 最终选中页面。
- 新版生产 Spellcast 的 `/api/health` 返回 200；重启前后保存的 Canvas 数量一致：1 个回复、6 个节点、7 个对象。

测试程序：`scripts/check-completion-notifications.mjs`。2026-09-11 完整测试记录：`output/completion-notifications/check-1789114594359/report.json`。原生截图保存在同一目录。

验证原生窗口输入前先捕获其首帧；WebView2 的离屏调试环境会在未绘制时丢弃鼠标事件。测试没有通过直接调用关闭处理器替代按钮输入。
