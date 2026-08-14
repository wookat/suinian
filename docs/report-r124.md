# R124 修改轮报告

落实 R123 独立审查结论（docs/audit-r123.md，PR #145）。审改分离的「改」方：系统性权衡后统一实施。

## 一、P1-1：PATCH/batch 绕过敏感管道的结构性终结

同型「另一个入口」攻击已第三次奏效，本轮不做逐路径打补丁，做架构收口：

1. **写路径全量静态盘点**：`docs/write-paths.md`，枚举所有对 `notes` 及派生表（`note_embeddings`/`entities`/`edges`/`threads`/`attachments`/报告表）的写路径，含 UPDATE/batch/cron/迁移脚本（本仓库无触发器）。
2. **DAO 收口**：新增唯一持久化边界 `backend/src/note-store.ts`，敏感管道（`sensitiveIngestGate`/加密/标题标签洗净/`raw_transcript` 剥除）下沉到该层。所有受保护字段（`content`/`content_enc`/`title`/`tags`/`is_sensitive`）的写入只能经由：
   - `prepareNoteInsert()`：创建（notes API、media、微信 MP、企微 KF、MCP、扩展、文件导入、备份恢复——恢复不再信任备份自带的 `is_sensitive` 判定，重新过闸）
   - `applyNotePatch()`：PATCH（内容/标题/标签/敏感位切换全部重新过闸，CAS 乐观锁保留）
   - `prepareTagsUpdate()`：batch 加删标签、标签重命名、AI 建议标签
   - `applyTriage()` / `setNoteAiTitle()`（仅非敏感行）/ `replaceNoteContent()`：AI 分诊、标题重生成、media 重试
3. **架构级单测**：`backend/test/write-path-guard.test.ts` 静态扫描 `src/*.ts`，除 `note-store.ts` 外禁止出现对 notes 受保护字段的直接 INSERT/UPDATE（含动态 SQL 片段）。第四次同型攻击将直接被 CI/本地单测拦截。
4. DAO 内部再设运行时护栏：`extra sets` 中出现受保护列即抛异常。

## 二、P1-2：计数/枚举类提问走精确 SQL 聚合

R123 实测「我一共记了多少条笔记」被答成 16（实为 210，恰为召回窗口条数）。与财务聚合（R107）同理修复：

- `countAggIntent()`（`backend/src/ask.ts`）：计数意图 → SQL `COUNT(*)` + 分类分布精确回答（可带时间窗）；带主题限定无法精确 SQL 化 → fail-closed 说明不估算，并附可精确的总数。金额类计数仍由财务路径优先处理。
- `enumListIntent()`：「上周都记了些什么」类时间窗枚举 → 窗口内 SQL 全量列举（上限 50 条+精确总数），不再走 top-k 召回；加密敏感笔记只显示占位不露内容。
- 单测：`backend/test/r124-count.test.ts`。

## 三、P2：限流补盲

- PATCH 内容编辑并入 note-write 限流（60/分钟）。
- batch 操作新增限流 `BATCH_WRITE_RATE_LIMIT_MAX=30/分钟`。
- threads rebuild 新增限流 `THREAD_REBUILD_RATE_LIMIT_MAX=2/分钟`。
- 文件导入沿用既有 bulk 限流（3/分钟，按请求；单请求条数已有上限）。

## 四、R123 主线 26/30 中 4 个失败 case 归因

| # | 提问 | 归因 | 本轮处置 |
|---|---|---|---|
| 26 | 我一共记了多少条笔记？（答 16 实为 210） | **生成层**（架构缺口）：无计数意图识别，LLM 对 LIMIT 截断的召回窗口心算 | **已修**：`countAggIntent()` 走 SQL COUNT 精确回答 |
| 23 | 这周我都记了些什么？（6 条只答 3 条） | **检索层**：时间窗枚举走语义 top-k 而非按 `created_at` 窗口全量枚举 | **已修**：`enumListIntent()` 窗口内 SQL 全量列举+精确总数 |
| 1 | 上个月存的那个什么管理的文章讲了什么？ | **生成层**（设计取舍）：库内同期有知识/注意力/需求管理多条候选，系统替用户选了最相似一条直接作答；答案本身不误，判定口径记未命中 | **不修（归因入报告）**：正确设计是多候选枚举+追问式交互，涉及 ask 应答结构与前端交互改造，非低风险；列入后续轮候选 |
| 25 | 今年在吉他上一共花了多少钱？ | **生成层**（判定口径 vs 设计意图）：被正确 fail-closed（带主题限定的财务合计拒绝心算），按「答案含预期数字」口径记未命中，行为本身是预期设计 | **不修（归因入报告）**：按限定条件（标签/关键词）精确聚合需可靠的口径映射，误映射比拒答更伤信任；维持 fail-closed |

## 五、验证

- backend：`npm run typecheck` 通过；`npm test` 60 文件 / 659 用例全绿（含新增架构守卫与计数单测）。
- 其余端到端回归（QA 账号全链路、对抗实测、存量排查、语音 raw_transcript 一手验证、web lint+build、录屏）见 PR 描述与录屏。
