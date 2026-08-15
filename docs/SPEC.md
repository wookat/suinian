# 碎念 Suinian — 技术 SPEC v0.1

## 总体架构
```
微信 ClawBot(iLink) ─┐
Android 分享/小组件 ─┼─> backend (Cloudflare Workers, Hono)
Web 速记框 ─────────┘        │
                     ┌───────┼────────┐
                     D1(notes/threads) KV(缓存/会话) Queues/cron
                     │
     Workers AI（分拣/标签/摘要/聚类/周报/问答主力）←可选 DeepSeek/OpenAI 兼容 API 为第一链位
                     │
        Web 端(React PWA) / Android 查看端 / 微信内问答回复
```

## 数据模型（D1）
```sql
users(id, name, wechat_binding, api_token, created_at)
notes(
  id TEXT PK, user_id, source TEXT,          -- wechat|android|web|api
  raw_type TEXT,                             -- text|link|image|voice|file
  content TEXT,                              -- 原文/转写文本
  url TEXT, url_title TEXT, url_summary TEXT,
  url_titles TEXT NULL,                      -- 前 3 个 URL 的标题，JSON [{url,title}]
  category TEXT,                             -- idea|todo|collect|data (AI 分拣)
  tags TEXT,                                 -- JSON array
  thread_id TEXT NULL,                       -- 线索归属
  is_sensitive INTEGER DEFAULT 0,            -- 密码等，AES-GCM 加密存 content_enc
  content_enc TEXT NULL,
  todo_due TEXT NULL, todo_done INTEGER,
  created_at, updated_at
)
threads(id, user_id, title, summary, note_count, updated_at)  -- 思考线索
weekly_reports(id, user_id, week_start, content_md, created_at)
attachments(id, note_id, r2_key, mime, size)
note_embeddings(note_id, vector)  -- 语义检索/聚类 embedding（JSON 数组，bge-m3 1024 维）
```

## API（backend, Hono on Workers）
- `POST /api/notes` 收件（鉴权 Bearer token）：{source, raw_type, content, url?}
  - 入库后异步触发管线：分类→标签→(链接)抓取摘要→线索归并
- `GET /api/notes?category=&tag=&q=&cursor=` 时间流+筛选+混合搜索（首页无筛选时：关键词 LIKE + 语义召回去重合并按相关度排序，返回的 note 带 `match: keyword|semantic|both`；语义失败自动降级纯关键词）
- `GET /api/threads` / `GET /api/threads/:id`（含碎片列表）
- `POST /api/ask` 自然语言问答（检索+LLM 汇总，返回引用 note ids）
- `GET /api/reports` / `GET /api/reports/:id` 周报；`POST /api/reports/generate` 手动触发（空参默认当前周期，与 Web「生成本周报告」同口径；传 `{"which":"last"}` 生成上一完整周期，`{"period":"month"}` 生成月报）
- `GET /api/export` 全量导出（JSON，`?format=markdown` 转 markdown 附件）
- `POST /api/ingest/wechat` ClawBot 桥接入口（bot 实例回调，分拣同步以便回确认文案；其余入口分拣/抓取/聚类全异步）
- cron：每周一 08:00 Asia/Shanghai（UTC 00:00）生成周报；每日 04:00 重整 thread 标题/摘要

## AI 管线（两层 provider 链：可选外部 OpenAI 兼容 API → Workers AI 基线主力；外部链位失败自动切换、恢复后自动切回）
1. **分拣**：单条 prompt（注入今日日期+星期、用户 top50 已有标签）输出 {category, tags[≤3], title, is_sensitive, todo_due?}；敏感判定另有正则兜底，敏感值禁入 tags
2. **链接抓取**：Workers fetch → readability 抽正文 → 摘要（公众号/小红书后续专项）
3. **线索聚类**：新想法入库时与近 90 天 idea 类做 embedding 相似度（Workers AI `@cf/baai/bge-m3`，余弦阈值 0.78，向量存 note_embeddings 表；不可用时降级 DeepSeek 按标题判断），超阈值归入已有 thread 或建新 thread；每日 cron 重整 thread 标题/摘要
4. **周报**：本周 notes 汇总 → 结构化周报 markdown
5. **问答**：query rewrite 后混合召回（关键词 LIKE + 语义 top-K）→ LLM 生成回答附引用
6. **语义检索**：笔记入库/更新时异步用 Workers AI `@cf/baai/bge-m3` 生成 embedding 存 note_embeddings（可选 Vectorize 镜像，wrangler.toml 取消注释即启用；无 binding 时 D1 暴力余弦，个人量级足够）；存量笔记由 10 分钟 cron 限速补嵌入；**敏感笔记不生成 embedding**（避免明文进向量库，标记敏感时同步删除已有向量），删笔记/删账号同步删向量

## 微信接入（skill/ + bot 实例）
- 基于 openclaw/wechatbot SDK（Node）：扫码绑定、长轮询收消息
- 收到消息 → 规整为 note payload → POST backend `/api/ingest/wechat`
- 回复确认（"已存：想法 #创业 #AI"）；`?` 开头触发问答
- skill 形态发布 ClawHub：`suinian` skill，安装后配 SUINIAN_TOKEN 即用

## Web 端（web/）
- React + Vite + Tailwind v4 + shadcn/ui，响应式 + PWA（manifest + SW）
- 视图：时间流（含速记框）/ 线索列表与详情 / 周报 / 搜索 / 设置(token)
- 部署 Cloudflare Pages，域名 suinian.zalize.com

## Android（android/）
- Kotlin + Jetpack Compose + Material 3，minSdk 26
- ACTION_SEND/SEND_MULTIPLE 接收分享（text/url/image）→ POST /api/notes
- AppWidget 速记小组件、通知栏快捷输入
- 查看端：WebView 包 Web 端（第一版）→ 后续原生列表

## 安全
- 单用户 token（R1）→ 多用户注册（R3）
- 敏感 note：客户端标记或 AI 判定 → AES-256-GCM 加密存 content_enc，content 字段只存占位符 `[加密内容]`；密钥为 worker secret `SUINIAN_ENC_KEY`（不落仓库）；API 层对已授权 token 透明解密返回原文；敏感内容不进 AI prompt（周报/问答召回只见占位符）
- 内容长度上限 20k 字符（POST /api/notes、ingest、PATCH），超出返回 413 + 人话错误
- 不记录秘钥到日志；开源仓库不含任何真实凭据

## 轮次划分
- **R1**：backend 底座 + 分拣管线 + wechat bot 桥 + skill 打包 + Web 时间流/搜索（最小可用，老板先用）
- **R2**：线索聚类 + 周报 + 问答 + Web 线索/周报视图 + Android app
- **R3**：链接正文攻坚（公众号/小红书）、语音转写、多用户、托管版、开源发布
