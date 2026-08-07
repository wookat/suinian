# suinian-mcp（本地 stdio 版 MCP server）

让 Claude Desktop / Claude Code / Cursor / Codex 等 AI 工具直接读写你的碎念。

优先推荐直接连远程版（无需安装）：`https://suinian-api.zalize.com/mcp`（Streamable HTTP，`Authorization: Bearer <你的 API token>`）。本目录是等价的本地 stdio 版，适合只支持 stdio 的客户端或自部署实例。

```bash
cd mcp && npm install && npm run build
SUINIAN_API_TOKEN=<你的token> node dist/index.js
```

环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUINIAN_API_TOKEN` | ✅ | 你的碎念 API token（Web 设置页可复制） |
| `SUINIAN_API_URL` | 否 | API 地址，默认 `https://suinian-api.zalize.com`，自部署填自己的 worker 地址 |

工具集（与远程版一致）：`save_note` / `search_notes` / `ask` / `list_threads` / `get_thread` / `get_weekly_report` / `list_todos` / `complete_todo`。敏感笔记内容默认脱敏。

各客户端配置片段见 [docs/mcp.md](../docs/mcp.md)。

> 尚未发布到 npm；发布后即可 `npx suinian-mcp` 直接运行。
