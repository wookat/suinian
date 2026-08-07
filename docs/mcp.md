# MCP：把碎念接进 Claude / Cursor / Codex

碎念提供标准 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) server，让任何支持 MCP 的 AI 工具直接读写你的笔记：对话中随手「帮我记一条」、检索旧想法、问答带引用、查线索/周报/待办。

两种接入形态，工具集完全一致：

| 形态 | 地址 / 运行方式 | 适合 |
|---|---|---|
| **远程（推荐）** | `https://suinian-api.zalize.com/mcp`（Streamable HTTP） | 支持远程 MCP 的客户端，零安装 |
| **本地 stdio** | 仓库 [`mcp/`](../mcp/) 目录，`node dist/index.js`（发布 npm 后可 `npx suinian-mcp`） | 只支持 stdio 的客户端、自部署实例 |

鉴权：你的碎念 **API token**（Web [设置页](https://suinian.zalize.com/#/settings) 可查看/复制/轮换）。严格按 token 用户隔离，只能读写你自己的数据；敏感笔记（密码等加密内容）在 MCP 响应里默认脱敏。

自部署用户把 `suinian-api.zalize.com` 换成自己的 worker 地址即可（worker 已自带 `/mcp`）。

## 工具集

| 工具 | 说明 |
|---|---|
| `save_note` | 丢一条笔记，AI 自动分拣打标签；可选手动 `tags` / `category` |
| `search_notes` | 关键词 + 语义混合搜索 |
| `ask` | 自然语言问答，回答带 [序号] 引用 |
| `list_threads` / `get_thread` | 思考线索列表 / 单条线索全部笔记 |
| `get_weekly_report` | 最新（或指定）周报 |
| `list_todos` / `complete_todo` | 待办列表 / 标记完成 |

## Claude Code

```bash
claude mcp add --transport http suinian https://suinian-api.zalize.com/mcp \
  --header "Authorization: Bearer <你的token>"
```

## Claude Desktop

`Settings → Developer → Edit Config`（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "suinian": {
      "type": "http",
      "url": "https://suinian-api.zalize.com/mcp",
      "headers": { "Authorization": "Bearer <你的token>" }
    }
  }
}
```

旧版不支持远程 HTTP 时用 stdio（先在仓库 `mcp/` 里 `npm install && npm run build`）：

```json
{
  "mcpServers": {
    "suinian": {
      "command": "node",
      "args": ["/绝对路径/suinian/mcp/dist/index.js"],
      "env": { "SUINIAN_API_TOKEN": "<你的token>" }
    }
  }
}
```

## Cursor

`Settings → MCP → Add new MCP server`，或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "suinian": {
      "url": "https://suinian-api.zalize.com/mcp",
      "headers": { "Authorization": "Bearer <你的token>" }
    }
  }
}
```

## Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.suinian]
url = "https://suinian-api.zalize.com/mcp"
http_headers = { "Authorization" = "Bearer <你的token>" }
```

Codex 版本不支持远程 MCP 时用 stdio：

```toml
[mcp_servers.suinian]
command = "node"
args = ["/绝对路径/suinian/mcp/dist/index.js"]
env = { "SUINIAN_API_TOKEN" = "<你的token>" }
```

## MCP Inspector（调试）

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: https://suinian-api.zalize.com/mcp
# Authentication → Header: Authorization, Bearer Token: <你的token>
```

## 环境变量（stdio 版）

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUINIAN_API_TOKEN` | ✅ | 碎念 API token |
| `SUINIAN_API_URL` | 否 | 默认 `https://suinian-api.zalize.com`，自部署填自己的地址 |

## 安全说明

- token 即身份：泄露请立刻在设置页「轮换 token」。
- MCP 响应会进入第三方 AI 上下文，因此敏感笔记（`is_sensitive`）内容一律替换为 `[敏感内容已脱敏]`，如需查看请去 Web / App。
- 远程 endpoint 为无状态 Streamable HTTP，每个请求独立鉴权，无会话粘滞。
