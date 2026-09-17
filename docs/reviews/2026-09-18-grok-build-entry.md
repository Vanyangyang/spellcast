# Grok Build 第一切接入

第一切：设置页可把 Spellcast MCP + Skill 写入用户 `~/.grok`，形态与 Codex 的 TOML 合并相同，但路径是 `.grok/config.toml` 与 `.grok/skills/spellcast/`。不是 Codex 插件 / hooks / marketplace 复制品。没有画布回发，没有 `spellcast_bind_grok`。

客户端 id：`grok`。UI 标签（中英日）：`Grok Build`。`complete_supported`：`codex` 仍走插件+hooks+Skill；`grok` 走 `configure` 的 MCP+Skill。缺少 grok.exe 不阻止写入。

## 改动文件

- `src-tauri/src/configure.rs`
- `src-tauri/src/complete_setup.rs`
- `src-tauri/src/lib.rs`
- `src/api.ts`
- `src/complete-setup-ui.ts`
- `src/main.ts`
- `src/i18n/messages.ts`
- `index.html`
- `skills/spellcast/SKILL.md`
- `skills/spellcast/references/feedback.md`
- `README.md`
- `README.zh-CN.md`
- `scripts/check-complete-setup-ui.mjs`
- `scripts/check-complete-setup-preview.mjs`
- `spellcast-bridge/src/api.rs`

未改 `src/types.ts`：`client` 已是 `string`。未改 `scripts/check-native-complete-setup.mjs`：它只点 `codex` 做原生 Codex 回归，没有硬编码「仅 Codex」文案。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib configure -- --test-threads=1` | 通过（12 passed）。含 `grok_merge_preserves_models_plugins_marketplace_ui_and_other_servers`、`grok_writer_cannot_touch_codex_config`、Skill 写入 `.grok/skills/spellcast`。 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib complete_setup -- --test-threads=1` | 通过（54 passed）。含 `grok_status_and_install_write_mcp_and_skill_under_isolated_home`、`grok_conflict_endpoint_does_not_overwrite`、`unsupported_clients_do_not_install`（`cursor`/`claude-code`/`windsurf`/`generic`）、既有 Codex 用例未回归。 |
| `cargo test --manifest-path spellcast-bridge/Cargo.toml --lib mcp_initialize -- --test-threads=1` | 通过（3 passed）。含 `mcp_initialize_records_grok_cli_client_info`（`name: grok-cli`）。未改 `identify_client`。 |
| `npx tsc --noEmit` | 通过 |
| `npx vite build` | 通过（预览脚本读 `dist/`） |
| `npm run check:complete-setup-ui` | 通过 |
| `npm run check:complete-setup-preview` | 通过。`codex` 与 `grok` 可点；`cursor`/`claude-code`/`windsurf`/`generic` 仍 `disabled`。文案匹配 Codex 与 Grok Build。 |
| `scripts/check-native-complete-setup.mjs` | 未跑。需要打包 `spellcast.exe`、本机 Codex CLI，并会再启一个 Spellcast 窗口；任务禁止生产窗口与真实 `~/.grok` 安装。Grok 写入由伪装 home 的库测试覆盖。 |

## 隔离核验（伪装 home，不是真实用户配置）

- 合并 `user_home/.grok/config.toml` 的 `[mcp_servers.spellcast]`：`enabled = true`、`url = <mcp>`；删除该表 `command`/`args`/`type`。
- 保留 `models`、`plugins`、`marketplace`、其他 `mcp_servers.*`、`[ui]`。
- 不写 `user_home/.codex/config.toml` 或 Codex Skill。
- Skill：`user_home/.grok/skills/spellcast/SKILL.md` + `references/*.md`。
- `PanicCli`：Grok 安装不调用 Codex CLI。
- 其他实例 URL → `conflict_endpoint`，不覆盖。

## 未做

- 未写入真实 `C:\Users\Administrator\.grok\config.toml` 或真实 Skill 目录。
- 未做活 MCP 安装、`grok plugin install --trust`、hooks、marketplace。
- 未做画布回发 / `codex queue` 等价物。
- 未改 Grok Build Supervisor、Cursor 全局 skills、Unity/Scene。
- 未 git commit/push。

## 未触及的已有脏工作

画布/工作台未提交改动保持不动。本切只改接入所需行。
