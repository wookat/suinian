# Suinian Backend（碎念后端）

Cloudflare Workers + Hono + D1。线上：`https://suinian-api.zalize.com`

## 本地开发

```bash
cd backend
npm install
# 本地 D1 建表
npx wrangler d1 migrations apply suinian --local
# 本地起服务（http://localhost:8787）
npx wrangler dev
# 单测 / 类型检查
npm test
npm run typecheck
```

本地调用 DeepSeek 需在 `backend/.dev.vars` 写入 `DEEPSEEK_API_KEY=sk-...`（不要提交）。

## 部署

```bash
# 首次：创建 D1 并把 database_id 填入 wrangler.toml
npx wrangler d1 create suinian
npx wrangler d1 migrations apply suinian --remote
# 设置密钥
npx wrangler secret put DEEPSEEK_API_KEY
# 部署（自定义域 suinian-api.zalize.com 已在 wrangler.toml routes 中声明）
npx wrangler deploy
# 创建用户 token
npx wrangler d1 execute suinian --remote --command \
  "INSERT INTO users (id,name,api_token) VALUES ('u_xxx','boss','<random-token>')"
```

## API

所有 `/api/*` 需要 `Authorization: Bearer <token>`（token 存 D1 `users.api_token`）。

### POST /api/notes — 收件
```json
{ "source": "web", "raw_type": "text", "content": "碎片内容", "url": "可选" }
```
入库时同步调用 DeepSeek 分拣（`deepseek-chat`），输出 `{category, tags, title, is_sensitive, todo_due}`；AI 失败降级为 `category=idea` 无标签，不阻塞入库。`content` 中含 URL 或传了 `url` 时后台抓取 `<title>`/meta description 存入 `url_title`/`url_summary`。返回 `201 {note}`。

### GET /api/notes — 时间流
Query：`category=idea|todo|collect|data`、`tag=标签`、`q=关键词`（LIKE 全文）、`cursor`（上一页返回的 `next_cursor`）、`limit`（默认 20，最大 100）。
返回 `{notes: [...], next_cursor: string|null}`，按 `created_at DESC, id DESC` 稳定分页。

### PATCH /api/notes/:id
可更新字段：`content`、`todo_done`（boolean）、`category`、`tags`（数组）、`title`、`todo_due`。返回更新后的 note。

### DELETE /api/notes/:id
返回 `{ok: true}`。

### POST /api/ingest/wechat — 微信 bot 桥接
```json
{ "content": "消息文本", "url": "可选", "raw_type": "可选" }
```
同 Bearer 鉴权；等价于 `source=wechat` 的收件，另外返回适合微信回复的确认文案：
```json
{ "note": {...}, "reply": "已存 · 想法 #创业 #AI" }
```

### POST /api/ask — 自然语言问答
```json
{ "question": "我最近在想什么关于创业的？" }
```
关键词召回 top-20 → DeepSeek 汇总回答。返回 `{answer, references: [note_id...]}`。

### 其他
- `GET /health` 公开健康检查。

## 数据模型
见 `migrations/0001_init.sql`（users / notes / threads / weekly_reports / attachments，按 docs/SPEC.md）。R1 只写 users/notes，threads/weekly_reports/attachments 为 R2+ 预留。
