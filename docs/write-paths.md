# notes 及派生表写路径清单（R124 P1-1）

背景：R117→R119→R121→R123 连续四轮出现同型缺陷——某个「另一个入口」直接写
notes 内容字段而绕过统一敏感管道。R124 做结构性终结：

- **守护字段**：`content` / `content_enc` / `title` / `tags` / `is_sensitive`。
  任何写入都必须经敏感管道（`sensitiveIngestGate` 加密 fail-closed、title 置空、
  tags 严格过滤、`meta.raw_transcript` 洗净）。
- **唯一持久层**：`backend/src/note-store.ts`。守护字段的 INSERT/UPDATE SQL
  全仓只允许出现在该文件；业务代码只能携带明文调用它的函数。
- **架构级单测**：`backend/test/write-path-guard.test.ts` 静态扫描 `src/`
  （除 note-store.ts）：出现 `INSERT INTO notes`、UPDATE notes SET 守护字段、
  或守护字段的动态 sets 拼接片段即 fail。新增第五个绕过入口时测试直接红。

## 一、守护字段写路径（全部经 note-store）

| 入口 | 调用点 | note-store 函数 | 管道行为 |
|---|---|---|---|
| POST /api/notes、微信 MP、企微 KF、媒体转写、MCP、扩展（均经 `createNote`） | index.ts `createNote` | `prepareNoteInsert`（markSensitive=onlyEncrypted） | fail-closed 预加密；raw_transcript 洗净；needs_retriage 标记 |
| PATCH /api/notes/:id（content/title/tags/is_sensitive） | index.ts PATCH 路由 | `applyNotePatch` | 新内容过 gate；转敏感时加密+旧 title/tags 洗净；转非敏感时解密恢复；CAS 乐观锁 |
| POST /api/notes/batch add_tags/remove_tags | index.ts `runBatchAction` | `prepareTagsUpdate` | 敏感行 tags 严格过滤（R123 P1 修复点） |
| 标签重命名 | index.ts `renameTagForUser` | `prepareTagsUpdate` | 同上 |
| 链接摘要 AI 补 tags | extract.ts `enrichLinkInto` | `prepareTagsUpdate` | 同上 |
| AI 分拣落库（同步/异步/cron 复判） | index.ts `runTriage`/`retriageOne` | `applyTriage` | 敏感→加密+title 置空+tags 过滤+raw_transcript 洗净；非敏感→解密恢复明文 |
| 内容编辑后重算 AI 标题 | index.ts `recomputeTitle` | `setNoteAiTitle` | SQL 内置 `is_sensitive = 0` 谓词，敏感行永不写 title |
| 媒体重试重提取 | index.ts POST /api/notes/:id/retry-media | `replaceNoteContent` | 新文本过 gate；category 归零重分拣 |
| 文件导入（Cubox/flomo/MD/txt） | import.ts `runImport` | `prepareNoteInsert` | 同 createNote；import_tags 敏感时过滤 |
| 备份恢复 | backup.ts restore | `prepareNoteInsert` | 不信任 zip 内 is_sensitive 定论，重新过 gate |

## 二、非守护字段写路径（不触内容字段，允许直写）

| 路径 | 位置 | 字段 |
|---|---|---|
| 软删/恢复/批量删 | index.ts 1481/1501/1656 | deleted_at, updated_at |
| 批量 set_category | index.ts 1678 | category, meta(manual_override) |
| cron 分拣兜底降级 | index.ts 3187 | category, meta(needs_retriage) |
| 链接元数据 | index.ts `fetchLinkMetaInto`、extract.ts 216/236 | url_title, url_summary, url_titles, meta |
| 图谱抽取标记 | graph.ts 214 | meta(graph_extracted_at) |
| 主题串聚类 | threads.ts 156/465/617/746 | thread_id |
| 待办提醒 | push.ts 182 | todo_reminded_at |
| 硬删（回收站清理/级联注销） | index.ts 1405/1437 | DELETE FROM notes（整行删除，无内容写入） |

注：`url_title`/`url_summary` 是链接页面的公开元数据（非用户内容派生），且链接
增强对敏感笔记不运行（管线在敏感判定后跳过）；`meta` 中敏感派生字段
（raw_transcript）的洗净由 note-store 在守护写入时一并处理。

## 三、迁移脚本（一次性，无法调用运行时 DAO）

| 文件 | 写入 | 说明 |
|---|---|---|
| migrations/0021_r120_scrub_sensitive_meta.sql | `UPDATE notes SET title = NULL / tags = '[]'`（仅 is_sensitive=1 行） | R120 存量洗净，语义与管道一致（置空/清空），方向只会更保守，允许 |

新迁移若需写守护字段：只允许「置空/清空/加密占位」这类更保守方向；禁止在迁移里
写入任何明文内容。评审时对照本清单。

## 四、派生表（内容可能二次泄漏，随主管道联动）

| 表 | 写入点 | 敏感防护 |
|---|---|---|
| note_embeddings | semantic.ts `upsertNoteEmbedding` | 敏感笔记删除向量行、不嵌入 |
| entities / edges | graph.ts `extractGraph` | 敏感笔记 purge 图谱行、不抽取 |
| threads | threads.ts | 聚类只用非敏感行；标题不含敏感内容 |
| attachments | index.ts 媒体入库 | 只存 R2 key/mime，无文本内容 |
| weekly_reports / daily_reviews | review.ts | 生成时排除敏感笔记明文 |

## 五、触发器 / cron

- D1 无触发器（全仓 migrations 无 `CREATE TRIGGER`）。
- cron（wrangler.toml crons）：retriage 扫描（经 `applyTriage`）、threads 重建
  （只写 thread_id）、软删清理（DELETE）、待办提醒（todo_reminded_at）——均已在
  上表覆盖。
