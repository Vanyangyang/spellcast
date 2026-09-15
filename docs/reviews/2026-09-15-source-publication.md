# 2026-09-15 源码同步检查

本次同步累计的 Canvas 工作台、直接反馈、组件组合、交互作品、Codex 完整接入、回复面板、桌面生命周期和相关测试。同步源码不等于发布新的安装包，也不代表下面列出的待改善项已完成。

## 发布准备

- 英文和中文 README 更新为 Canvas / 画布及当前 Codex-only 接入、明确发送后直接回发的流程。
- 保留 0.3.0 公开安装包与当前本机运行版/源码的区别，macOS 仍未声称实际运行验证。
- 本地 `output/`、构建目录、`artifacts/`、数据库和已安装插件缓存不进入提交；可复用的源码、示例、测试脚本和文档进入提交。
- 一并保留 Wry 本地补丁源码及其许可证，并为随前端分发的字体补入完整 OFL 许可证。
- 发布构建在桌面库测试前准备内置 Codex 插件资源。
- 部分历史验收脚本和文档保留本机路径、Codex 内置 Playwright 前置条件及本地产物引用；这些不是公共环境可直接运行的统一测试命令。

## 当前执行结果

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过 |
| `cargo test --locked --workspace` | 170 通过，0 失败 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target-teardown-20260913 --lib` | 修正测试目录隔离后，连续三次均为 76 通过、0 失败、2 忽略 |
| `node scripts/check-feedback-inbox.mjs` | 通过 |
| `node scripts/check-content-organization.mjs` | 通过 |
| `node scripts/check-content-origin.mjs` | 通过 |
| `node scripts/check-canvas-dataflow.mjs` | 通过 |
| `node scripts/check-canvas-insert.mjs` | 隔离浏览器通过，0 外部请求泄漏 |
| `node scripts/check-reply-drafts.mjs` | 通过 |
| `node scripts/check-complete-setup-ui.mjs` | 真实模块与 DOM 检查通过 |
| Codex 插件打包检查 | 通过 |

桌面测试首轮有一次安装锁冲突，复跑时曾通过，随后在 `activate_restore_dual_failure_keeps_backup_and_partial` 再现。测试辅助目录使用进程号和墙钟时间命名，34 个测试共用 `user` 标签，存在并发重名隐患；已改为 UUID，并使用 `create_dir` 拒绝复用已有目录。改动仅在测试模块中，未修改生产安装锁机制。修正后的三次默认并发套件均通过。

组件插入检查首次误用工具环境的 Bun 运行器而超时；随后明确使用系统 Node.js，七项前端检查全部通过。不得把这次超时归为产品浏览器失败，也不得把本次隔离测试外推为新的真实 Codex 模型交付验收。

## 未完成的改善

旧 `waiting` 且来源不完整的留言仍可能误入待跟进；本次只发布现状和已知问题，没有借发布操作重发或处理真实历史。回复与历史入口简化、组件粒度一致性及组合体验的下一步要求见 [后续改善提示词](../next-improvement-prompt.md)。
