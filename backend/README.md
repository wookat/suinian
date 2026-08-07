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
# 敏感内容加密密钥（32 随机字节 base64，生成后妥善备份，丢失将无法解密存量敏感笔记；不要写进仓库/日志）
openssl rand -base64 32 | npx wrangler secret put SUINIAN_ENC_KEY
# 部署（自定义域 suinian-api.zalize.com 已在 wrangler.toml routes 中声明）
npx wrangler deploy
# 创建用户 token（也可直接用自助注册接口 POST /api/auth/register，见下）
npx wrangler d1 execute suinian --remote --command \
  "INSERT INTO users (id,name,api_token) VALUES ('u_xxx','boss','<random-token>')"
```

环境变量：`REGISTRATION_ENABLED`（`wrangler.toml [vars]`，默认 `"true"`；设为 `"false"`/`"0"`/`"off"` 关闭自助注册）。

## API

所有 `/api/*` 需要 `Authorization: Bearer <token>`（token 存 D1 `users.api_token`），仅 `POST /api/auth/register`、`POST /api/auth/login` 公开。

### 账号（R13）

- `POST /api/auth/register` `{name, password}` → `201 {user:{id,name}, api_token}`。用户名 2-32 字符（中英文/数字/._-）且唯一；密码 8-128 字符。受 `REGISTRATION_ENABLED` 开关控制（关闭时 403）。
- `POST /api/auth/login` `{name, password}` → `{user, api_token}`。老用户（无 `password_hash`）不能密码登录，仍用 token。
- `POST /api/auth/rotate-token`（Bearer 鉴权）→ `{api_token}`，旧 token 立即失效。
- `GET /api/auth/me` → `{user:{id,name,created_at,has_password}}`。
- `DELETE /api/auth/me` → 自助注销，级联删除该用户全部笔记/embeddings/附件（含 R2 对象）/线索/周报。
- 密码哈希：PBKDF2-HMAC-SHA256（WebCrypto），100,000 次迭代、16 字节随机盐、32 字节输出，存 `pbkdf2$<iter>$<salt b64>$<hash b64>`（Workers 无原生 argon2/bcrypt 且 WebCrypto PBKDF2 上限 10 万次迭代，故选 OWASP 认可的 PBKDF2-SHA256）。任何日志不记录密码明文。
- 速率限制：注册/登录每 IP 每分钟 5 次（D1 `auth_rate_limits` 固定窗口计数；取舍：D1 表是 Workers 上最简单的持久方案——内存计数按 isolate 隔离且随时被回收；固定分钟窗口在边界处最多允许 2 倍突发，对登录/注册防滥用足够。D1 出错时放行，保证限流故障不影响登录）。

### POST /api/notes — 收件
```json
{ "source": "web", "raw_type": "text", "content": "碎片内容", "url": "可选" }
```
立即落库返回 `201 {note}`（此时 `category=null, tags=[]`），DeepSeek 分拣（`deepseek-chat`，输出 `{category, tags(≤3个，优先复用用户 top50 已有标签), title, is_sensitive, todo_due}`）、链接抓取、线索聚类均在 `ctx.waitUntil` 异步回填。敏感信息除 prompt 判定外另有正则兜底（密码/密钥/卡号等模式），疑似敏感值的标签会被过滤。

- **内容长度上限 20000 字符**（`POST /api/notes`、`/api/ingest/wechat`、`PATCH content` 同），超出返回 `413 {"error":"内容过长：最多 20000 字符，当前 N 字符。…"}`。
- **多链接抓取**：正文中前 3 个（去重）URL 都会抓标题，存 `url_titles`（JSON `[{url,title}]`）；`url`/`url_title`/`url_summary` 保持为首个 URL 的信息。

#### 敏感内容加密（R3）
分拣判定 `is_sensitive=true` 的笔记，原文用 **AES-256-GCM** 加密后存 `content_enc`（格式 `v1:<b64 iv>:<b64 ct>`），D1 中 `content` 字段只存占位符 `[加密内容]`。GET/PATCH/export 等接口对已授权 token **透明解密**返回原文（响应中不含 `content_enc`）。密钥为 worker secret `SUINIAN_ENC_KEY`（32 随机字节的 base64，生成方式见上；不落仓库，丢失即无法解密）。周报与问答召回只见占位符，敏感原文不会进入 AI prompt。存量敏感笔记迁移：`node scripts/encrypt-existing.mjs`（需 `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/`D1_DATABASE_ID`/`SUINIAN_ENC_KEY` 环境变量，支持 `--dry-run`）。

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
同 Bearer 鉴权；等价于 `source=wechat` 的收件，但分拣保持同步（微信需要带分类/标签的确认文案），链接抓取与聚类仍异步；返回：
```json
{ "note": {...}, "reply": "已存 · 想法 #创业 #AI" }
```

### POST /api/ask — 自然语言问答
```json
{ "question": "我最近在想什么关于创业的？" }
```
关键词召回 top-20（每个关键词按 UTF-8 截断至 45 字节，避开 D1 LIKE 模式长度限制）→ 召回笔记每条截断 500 字符入 prompt → DeepSeek 汇总回答。返回 `{answer, references: [{index, note_id}...]}`：`index` 与回答正文中的 `[n]` 引用编号一一对应，被引用的笔记按引用顺序排列；回答中没有 `[n]` 引用时返回全部召回笔记（index 为召回序号）。AI 失败降级返回全部召回 references。

### GET /api/threads — 思考线索列表
返回 `{threads: [{id, title, summary, note_count, updated_at}...]}`（仅含有笔记的线索）。

### GET /api/threads/:id — 线索详情
返回 `{thread, notes: [...]}`（按时间升序）。

### POST /api/threads/rebuild — 全量重建线索
对当前用户近 90 天的 idea 笔记做全量重聚类（含冷启动两两配对）：先把它们从 thread 中摘出、删掉空 thread，再按时间顺序逐条重新聚类（同步执行，笔记多时耗时较长）。返回 `{ideas: 参与聚类的 idea 数, threads: [...最新线索列表]}`。聚类没生效或阈值调整后可用它重算。

聚类机制：新 idea 入库后用 Workers AI `@cf/baai/bge-m3` embedding 与近 90 天 idea 做余弦相似度（阈值 0.78），命中则归入已有 thread 或与命中笔记建新 thread；Workers AI 不可用时降级为 DeepSeek 按线索标题判断。命中/新建 thread 时会**立即同步生成**一句话标题/摘要（不等每日 cron）；每日 cron（04:00 北京时间）仍会重整全部 thread 标题/摘要。

### 周报
- `GET /api/reports` 列表 `{reports: [{id, week_start, created_at}...]}`
- `GET /api/reports/:id` 详情 `{report: {..., content_md}}`
- `POST /api/reports/generate` 手动触发（默认上周；传 `{"week":"this"}` 生成本周，验收用），同周重复生成会覆盖
- cron：每周一 08:00 Asia/Shanghai（UTC 周一 00:00）自动为全部用户生成上周周报；敏感笔记不进周报 prompt

### GET /api/export — 全量导出
默认 JSON `{exported_at, notes, threads, reports}`；`?format=markdown`（或 `?format=md`）返回 markdown 附件（`content-disposition: attachment`）。

### 其他
- `GET /health` 公开健康检查。
- 所有 404（含不存在的 thread/report id 与未知路由）统一返回 JSON `{"error":"not found"}`。

## 作为个人记忆源接入 agent

REST API 可直接作为 Claude / OpenClaw / 任意 agent 的个人记忆源，接入方式与 curl 示例见 [docs/integrations.md](../docs/integrations.md)。

## 数据模型
见 `migrations/`：0001（users / notes / threads / weekly_reports / attachments）+ 0002（note_embeddings 聚类向量表 + 索引）+ 0003（notes.url_titles 多链接标题）。R2 已启用 threads/weekly_reports；attachments 为 R3+ 预留。

### 线上迁移

wrangler v3 对 D1 migrations/zone-routes 有兼容问题，线上迁移用仓库内脚本走 Cloudflare REST API `/d1/database/:id/query`：

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
# 可选：D1_DATABASE_ID（默认读 wrangler.toml 的 database_id）
node scripts/migrate-remote.mjs --dry-run   # 先看待应用列表
node scripts/migrate-remote.mjs             # 应用 migrations/*.sql
```

脚本用与 wrangler 相同的 `d1_migrations` 表记录已应用迁移，重复执行会自动跳过（幂等）。`wrangler deploy` 上传正常（需 `CLOUDFLARE_ACCOUNT_ID` 环境变量）。
