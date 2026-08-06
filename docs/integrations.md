# 把碎念接入你的 Agent：作为个人记忆源使用

碎念的后端是 API-first 的：所有能力（收件、检索、问答、线索、周报、导出）都是普通 REST 端点 + Bearer token 鉴权。这意味着任何能发 HTTP 请求的 agent——Claude（自定义工具 / MCP 包装）、OpenClaw、n8n、你自己写的脚本——都可以把碎念当作**个人记忆源**：往里写碎片、从里面问「我最近在想什么」。

完整 API 参考见 [backend/README.md](../backend/README.md)。

## 前提：API 地址与 token

- **API 地址**：你自部署的 Workers 域名（如 `https://suinian-api.example.workers.dev`），或自定义域。
- **token**：D1 `users` 表里的 `api_token`（自部署时用 `wrangler d1 execute` 创建，见[自部署指南](self-host.md)）。所有 `/api/*` 请求带上：

```
Authorization: Bearer <你的 token>
```

token 等同于账号的全部读写权限，请像密码一样保管；泄露后在 D1 里更新 `users.api_token` 即可作废旧 token。

下文示例用环境变量：

```bash
export SUINIAN_API_URL="https://suinian-api.example.workers.dev"
export SUINIAN_TOKEN="<你的 token>"
```

## 核心用法与 curl 示例

### 1. 往记忆里写一条碎片

```bash
curl -X POST "$SUINIAN_API_URL/api/notes" \
  -H "Authorization: Bearer $SUINIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"web","raw_type":"text","content":"agent 记忆应该分层：工作记忆 + 长期记忆"}'
```

立即返回 `201 {note}`；AI 分拣（分类/标签/标题/敏感判定）、链接抓取、线索聚类在后台异步完成。agent 只管丢，不用等。

### 2. 用自然语言问自己的记忆

```bash
curl -X POST "$SUINIAN_API_URL/api/ask" \
  -H "Authorization: Bearer $SUINIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"我最近在想什么关于 agent 记忆的？"}'
```

返回 `{answer, references: [{index, note_id}...]}`，`references` 与回答里的 `[n]` 引用一一对应——agent 可以把 answer 直接给用户，也可以拿 note_id 继续取原文。

### 3. 结构化检索时间流

```bash
# 按分类/标签/关键词过滤，游标分页
curl "$SUINIAN_API_URL/api/notes?category=idea&q=记忆&limit=20" \
  -H "Authorization: Bearer $SUINIAN_TOKEN"
```

### 4. 读思考线索（跨周同题碎片的聚类）

```bash
curl "$SUINIAN_API_URL/api/threads" -H "Authorization: Bearer $SUINIAN_TOKEN"
curl "$SUINIAN_API_URL/api/threads/<thread_id>" -H "Authorization: Bearer $SUINIAN_TOKEN"
```

### 5. 读周报 / 手动生成

```bash
curl "$SUINIAN_API_URL/api/reports" -H "Authorization: Bearer $SUINIAN_TOKEN"
curl -X POST "$SUINIAN_API_URL/api/reports/generate" \
  -H "Authorization: Bearer $SUINIAN_TOKEN" \
  -H "Content-Type: application/json" -d '{"week":"this"}'
```

### 6. 全量导出（给 agent 建索引 / 备份）

```bash
# JSON（结构化）
curl "$SUINIAN_API_URL/api/export" -H "Authorization: Bearer $SUINIAN_TOKEN"
# Markdown（人类可读，format=md 亦可）
curl "$SUINIAN_API_URL/api/export?format=markdown" -H "Authorization: Bearer $SUINIAN_TOKEN"
```

## 接入 OpenClaw

仓库自带 OpenClaw skill（[skill/](../skill/)）：在 skill 环境变量里配置 `SUINIAN_API_URL` 与 `SUINIAN_TOKEN`，agent 即可通过微信/对话把碎片写入碎念、用 `?` 前缀问答检索。详见 [skill/README.md](../skill/README.md) 与 [skill/SKILL.md](../skill/SKILL.md)。

## 接入 Claude（或其他支持自定义工具的 agent）

把上面的端点声明为工具即可。最小工具集建议：

| 工具 | 端点 | 用途 |
|---|---|---|
| `remember(content)` | `POST /api/notes` | 把对话中值得留存的碎片写入记忆 |
| `recall(question)` | `POST /api/ask` | 自然语言查询记忆，带引用 |
| `search(query, category?)` | `GET /api/notes?q=...` | 结构化检索 |
| `threads()` | `GET /api/threads` | 查看用户长期在想什么 |

以 Claude 的 MCP 生态为例，用任意 HTTP 桥（或十几行自定义 MCP server）包一层上述四个端点即可；无需改动碎念后端。

## 注意事项

- **敏感内容**：被判定敏感的笔记在库中 AES-256-GCM 加密，问答/周报召回只见占位符——agent 通过 `GET /api/notes` 读取时对已授权 token 透明解密，请注意 agent 侧日志不要落盘原文。
- **限额**：单条内容上限 20000 字符；`/api/notes` 列表 `limit` 最大 100。
- **幂等**：写入没有去重，agent 侧自行避免重复写同一碎片。
