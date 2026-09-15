# 客户端入口仅启用 Codex

设置页和桌面接入页均默认选择 Codex；Cursor、Claude Code、Windsurf 和“其他”保留显示，置灰并使用原生 `disabled` 禁止选择。预览和点击处理也拒绝非 Codex 入口，安装流程解锁后不会重新启用这些按钮。中、英、日文均显示当前仅支持 Codex 的说明。

TypeScript/Vite、Windows 构建和原有 `check-complete-setup-ui.mjs` 异步界面回归通过。Browser Use 在两处实际界面确认 Codex 选中且可用，其他四项均 disabled；设置页截图确认灰色样式。浏览器使用隔离夹具，没有执行真实接入安装。记录位于 `artifacts/workbench-20260915/inbox-browser-1789406659916/evidence.json`。

运行版已更新至 SHA-256 `87c9452fbb5ed70c488f4adfb490ed2542dbfb1969b93779c014becb7f9a9a7a`。`artifacts/workbench-20260914/native-codex-only-20260915/` 记录正常重启、备份及全部既有画布字段保留；节点、回复、消息与布局未改变。
