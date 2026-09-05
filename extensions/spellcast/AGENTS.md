# Spellcast 编辑器扩展

Spellcast 是独立的桌面与头脑风暴板。跑起来：

```bash
npm run desktop
```

编辑器扩展只负责打开板、刷新桌面状态和显示板上的本地通知。

- 不注册或暴露 MCP。
- 不读取、写入或修补 Cursor、Codex、Claude、Windsurf 的配置。
- 不把不同客户端的配置格式或路径混用。

不要再开第二个终端跑 server；桌面程序自己带本地 API。
