# Debug 运行版改为自包含（不依赖 47193）

桌面快捷方式 `C:\Users\Administrator\Desktop\Spellcast.lnk` 指向 `G:\VibeProj\spellcast\src-tauri\target\debug\spellcast.exe`。此前该文件是会去连 `devUrl` `http://127.0.0.1:47193` 的 debug 进程；本机没有 Vite 时 WebView2 显示 `ERR_CONNECTION_REFUSED`，但 Rust 仍会在 47194 起 bridge。

## 已核实事实

- 关窗后：无 `spellcast` 进程，47193/47194 均未监听。
- 快捷方式未改：目标仍是 `src-tauri\target\debug\spellcast.exe`，工作目录 `G:\VibeProj\spellcast`。
- 未使用 `src-tauri\target\release\spellcast.exe`（2026-09-12）。
- 未 `tauri dev` / `npm run desktop`。
- 未 `Stop-Process`。未 commit。未写真实 `~/.grok`。未改用户库内容。

## 备份

- 旧 exe 复制：`artifacts/workbench-20260918/debug-selfcontained-runtime/backup/spellcast.exe`
- 旧 SHA-256：`dab5ffd04aff3d96f7dde2bd2f4d222845a54a82706f9270487357dbf732a105`
- sqlite：`python scripts/backup-runtime-state.py` → `artifacts/workbench-20260918/debug-selfcontained-runtime/backup/state-after-close/`
  - source SHA-256：`143ad3de1e475ec81b2847d8a8ad1353ceef4b957375bbf95b4a8bb03eb44947`
  - snapshot SHA-256：`12c46d7e7c09628c5da0016fd389f2429abfb6ef563a0f97f9fa500cb97f7e4c`
  - `quickCheck`: `ok`

## 构建

命令：`npx tauri build --debug --no-bundle`（仓库根目录）

- `beforeBuildCommand` 跑了 `prepare-codex-plugin-resource.mjs` 与 `npm run build`（`tsc --noEmit && vite build`）。
- 退出码 0。产物：`G:\VibeProj\spellcast\src-tauri\target\debug\spellcast.exe`
- 新 SHA-256：`bf2d7ee8f7a6dcedeb758b520619667cecb1767823dbdd5fca9bba577bf286db`
- 体积 35039744 → 39272960。二进制里仍能搜到字符串 `127.0.0.1:47193`（`tauri.conf.json` 的 `devUrl` 被编进配置），但本次是 `tauri build` 打进 `frontendDist`，运行时未监听 47193，也未出现 Edge 错误页。未改产品代码。

快捷方式：未改。

## 验证

通过桌面 `.lnk` 启动**一个**实例（未设置 `SPELLCAST_STATE_FILE` / `SPELLCAST_PORT` / WebView2 覆盖）：

- PID `50100`
- `GET http://127.0.0.1:47194/api/health` → `ok: true`, `port: 47194`
- 47193 监听数：0
- UIA：`RootWebArea` 标题 Spellcast；有画布控件与 `settings-open`；无 `ERR_CONNECTION_REFUSED`
- 设置页按钮：`Codex` enabled=true，`Grok Build` enabled=true，`Cursor` enabled=false
- 文案：`当前支持 Codex 与 Grok Build，其他客户端暂不可用。`
- 原始 dump：`artifacts/workbench-20260918/debug-selfcontained-runtime/uia-settings-final.json`、`verify.json`

该验证进程随后被本代理命令的 Job Object 回收，不是产品崩溃。从资源管理器双击同一个 `Spellcast.lnk` 与当时的启动方式相同。不要用 `tauri dev` 再绑回 47193。

## 未做

- 未 NSIS、未 commit/push、未写 `~/.grok`、未迁移/清空用户 sqlite。
- 未改快捷方式，未动 2026-09-12 release exe。
- 未回滚未提交的画布/工作台/Grok 接入源码。
