# audit-r125 — 碎念 Suinian 独立审查报告（R125 轮）

- 角色：独立评审官（审改分离，只审不改；本报告是本轮唯一落库产物，**未改任何产品代码、未部署**）
- 对象：生产环境 https://suinian.zalize.com / https://suinian-api.zalize.com ，main @ `cc3f13c`（R124 #146：敏感管道 DAO 收口 + 架构级静态断言 + `docs/write-paths.md`、计数统计精确查询、注销原子级联、语音纠错回退）
- 方法：5 个独立 QA 账号 `[QA-R125]-probe / -main / -sec / -del / -voice`（测毕全部注销并逐表 remote 核清，见附录 B）；生产接口对抗构造、D1 remote 只读核对、R2 对象核对、真实语音（TTS→Whisper）上传、15 问计数矩阵、静态断言对抗探针（仓库外 `/tmp` 复刻断言逻辑，未改仓库）、源码走读。**全程未触碰 `u_boss`**。
- 证据分级：【生产实测】接口/浏览器一手观测；【D1 实查】远端库只读查询；【R2 实查】对象存储只读核对；【代码证据】仅走读源码、未在生产验证；【未验证】明确标注。

## 一、总览与三环节评分

| 环节 | 评分 | 一句话结论 |
|---|---|---|
| 什么都能丢 | **6 / 10**（R123 9） | **新发 P0：新建后约 2 秒内的编辑会被异步分拣静默回滚**——接口返回 200 且回显新内容，D1 里仍是旧内容（3/3 复现）。入口覆盖面依旧很全（Web/微信/企微/媒体/导入/恢复/MCP/扩展/Android 全部经 API→DAO），但"丢进去的东西可能悄悄变回原样"直接伤主线 |
| AI 自动整理 | **8 / 10** | 分拣质量与 R124 持平；语音纠错回退【生产实测】4/4 未落拒答文案、敏感语音正确加密且 `raw_transcript` 洗净。扣分：**派生明文字段（`meta.file_excerpt` / `image_description` / `raw_transcript`、`url_summary`）不在守护字段内**，敏感笔记正文加密了、AI 从正文派生出的明文却原样留库并进导出/备份 |
| 可靠找回 | **7 / 10**（R123 8） | R123 P1-2 已真实修复：15 问里 7 问走 SQL 精确聚合、答案与 D1 逐一吻合（含本月/上月/本周/今天/昨天枚举）。扣分：**"我最早的一条笔记是什么时候"自信错答**（答 07-22，实为 07-20），以及"我一共收藏了多少条"用总数 15 回答分类计数（口径错配）；另有 6/15 落到 fail-closed 且拒答理由文案与真实原因不符 |

核心主线「什么都能丢 → AI 整理 → 可靠找回」**中段（AI 整理）与末段（找回）本轮明显变强**（R123 两个 P1 都已闭环，见 §六），但**首段被新发 P0 打穿**。

本轮结论：**1 个 P0、3 个 P1、3 个 P2、2 个设计建议**；公开推广 **NO-GO**（§六）。

| 级别 | 问题 | 影响核心主线 | 出处 |
|---|---|---|---|
| **P0-1** | 新建后 ~2s 内的 `PATCH` 内容被创建时的异步分拣静默覆盖回旧内容（`applyTriage` 用创建时快照的 `content` 无版本校验回写），接口 200 回显新内容 → 用户以为存了 | **是（什么都能丢/可靠找回）** | §二.1 |
| **P1-1** | 派生明文不在守护字段：敏感笔记 `content` 已加密，`meta.file_excerpt` / `image_description` / 客户端传入的 `meta.*` 仍是明文，默认导出 JSON 与备份 zip 直接带出 | 是（隐私信任） | §二.2 |
| **P1-2** | `skip_triage`（Web `/` 速记 raw 模式、Ask「存为笔记」）只走高精度检测、且永不复判，密码类文本明文入库并进 Markdown/JSON 导出 | 是（隐私信任） | §二.3 |
| **P1-3** | 「最早一条笔记是什么时候」类统计问题不走 SQL，由 LLM 对 top-k 召回作答，**自信错答**（与 R123 P1-2 同型残留） | 是（可靠找回） | §五 |
| P2-1 | 架构级静态断言可被 5 种合法 SQLite 写法绕过（`UPDATE "notes"`、`UPDATE main.notes`、`REPLACE INTO notes`、`INSERT OR REPLACE INTO "notes"`、字符串拼列名），且只扫 `backend/src/*.ts` 顶层、不扫子目录与 `migrations/*.sql` | 否（防复发能力被高估） | §一.2 / §二.4 |
| P2-2 | 注销后 `auth_rate_limits` 仍残留 2 行含该 user_id 的限流键（其余 17 组行全清、无孤儿、R2 对象已删） | 否 | §三 |
| P2-3 | 分类计数（待办/想法/收藏几条）与「加密笔记几条」、绝对月份（「7 月」）落 fail-closed，且拒答文案称"带有主题/内容限定"，与真实原因不符 | 是（程度轻） | §五 |
| 设计建议 D1 | 敏感治理应从"守护 5 个列"升级为"守护派生明文闭包"（正文 → 摘要/描述/转写/链接摘要 → 导出/备份/嵌入/图谱），否则"另一个入口"会从列维度换成字段维度继续复发 | 是（结构性） | §七.1 |
| 设计建议 D2 | 异步分拣与用户写入之间没有并发模型（`waitUntil` 管道无版本号/无 CAS，请求侧 CAS 只防"另一台设备"不防"自己的管道"） | 是（结构性） | §七.2 |

### 1.2 R124 复核结论速览

| R124 交付项 | 复核结论 |
|---|---|
| 敏感管道 DAO 收口（`note-store.ts`） | ✅ **真实生效**：`PATCH` 内容/标题/标签、批量打标、分拣、重算标题、媒体重试、导入、备份恢复的守护字段写全部在 DAO 内；R123 P1-1 的 PATCH 绕过已封（§六.1 生产复现失败=修复成立） |
| 架构级静态断言 `write-path-guard.test.ts` | ⚠️ **只拦住"最常见写法"**：5 种合法 SQLite 等价写法可绕过（P2-1，探针证据 §一.2 表），且**不覆盖派生明文字段**（P1-1 的两处泄漏都不会让断言变红）、不扫子目录/迁移脚本 |
| 计数/枚举精确聚合 | ✅ 主体生效（7/15 精确且全部正确），残留 P1-3 / P2-3（§五） |
| 注销原子级联 | ✅ **生产实测通过**（17 组行→0、无孤儿、token 立即 401、R2 对象已删），残留 P2-2（§三） |
| 语音纠错拒答回退 | ✅ **生产实测 4/4**（含"转写文本本身含拒答词"的极端样本，用户原话完整保留，§四） |

静态断言对抗探针（把 `write-path-guard.test.ts` 的三条正则原样复刻到 `/tmp/guardprobe/probe.mjs`，未改仓库；SQL 合法性用本地 sqlite3 实测）：

| 写法 | SQLite 合法 | 断言结果 |
|---|---|---|
| `UPDATE notes SET content = ?` | ✅ | **CAUGHT**（设计目标） |
| `UPDATE "notes" SET content = ?, is_sensitive = 0` | ✅ | **BYPASS** |
| `UPDATE main.notes SET content = ?, title = ?` | ✅ | **BYPASS** |
| `REPLACE INTO notes (id,user_id,content,is_sensitive) VALUES (...)` | ✅ | **BYPASS**（连"收集 SQL 字面量"这一步都不匹配） |
| `INSERT OR REPLACE INTO "notes" (...)` | ✅ | **BYPASS** |
| `"UPDATE notes SET " + col + " = ?"`（列名变量） | ✅ | **BYPASS** |
| `UPDATE notes AS n SET n.content = ?` | ❌（SQLite 拒绝限定列名） | BYPASS 但不可用 |

判定：断言是**有价值的回归护栏**（新人照着现有风格写 SQL 会被拦），但**不是架构证明**；`docs/write-paths.md` 里"新增第五个绕过入口时测试直接红"的说法过强。

## 二、【重点】第四次「另一个入口」攻击尝试

对照 `docs/write-paths.md` 逐入口核对：微信 MP / 企微 KF / 媒体转写 / MCP / 扩展 / Android / 导入 / 备份恢复 / 批量 / 标签重命名 / 链接摘要 / cron 复判 —— 【代码证据】守护字段全部经 `note-store.ts`；Android（`data/api/ApiClient.kt`）与扩展只走 HTTP API、无直连 D1；cron 十项任务的 notes 写全部落在 `applyTriage` / 非守护字段。**沿"列"这条线，第四次攻击没找到新的绕过入口**——但换两条线成功了。

### 2.1 P0-1：新建后立刻编辑，编辑被静默丢弃【生产实测 + D1 实查 + 代码证据】

复现（`[QA-R125]-sec`；接口路径三次不同间隔各 1 次，浏览器真实 UI 路径两次，见附录 A）：

| 创建→编辑间隔 | PATCH HTTP | 接口回显 | 75s 后 D1 实际内容 | 结论 |
|---|---|---|---|---|
| 0s | 200 | `QA-R125 已修正文本 delay0 这是用户的编辑` | `QA-R125 原始文本 delay0` | **编辑丢失** |
| 3s | 200 | 已修正文本 delay3 | 已修正文本 delay3 | 正常 |
| 8s | 200 | 已修正文本 delay8 | 已修正文本 delay8 | 正常 |

敏感场景更糟（2/2 复现，`Rp1/Rp2-R125-RACE`）：新建普通笔记 → `PATCH` 把正文改成「我的网银密码改成了 …」→ 再 `PATCH` 标题/标签。两次 PATCH 都返回 200，D1 终态是：

```
content = "QA-R125 race1 原始内容 无敏感"   -- 用户的密码编辑消失
content_enc = NULL, is_sensitive = 0        -- 敏感位也被重置
tags = ["密码"], title = NULL               -- 只留下第二次 PATCH 的痕迹
```

根因【代码证据】：`createNote` 把创建时的 `content` 闭包捕获后交给 `waitUntil` 异步分拣，分拣完成时执行
`applyTriage(env, id, triage, content)`；`applyTriage`（`note-store.ts:362-376`）在"模型判非敏感"分支无条件
`SET content = ?, content_enc = NULL, is_sensitive = 0`，**既不带 `updated_at` CAS，也不校验内容是否已被用户改过**：

```sql
UPDATE notes SET is_sensitive = ?, ..., content = ?, content_enc = NULL, updated_at = datetime('now') WHERE id = ?
```

而 PATCH 路由的乐观锁（`base_updated_at` + CAS）只防"另一台设备的并发编辑"，对自家 `waitUntil` 管道完全无效。

影响面（同一根因、窗口更大，**【未验证】未在生产逐一构造**）：cron `retriageUnsorted` 复判、导入回填、媒体重试都用"先读快照 → 调模型（数秒）→ 回写 content"的同一模式，落在其时间窗内的用户编辑同样会被回滚。

为什么这是 P0：这是最普通的用法（说完发现错字立刻改、语音转写完立刻纠正、Ask 存为笔记后立刻补一句），**接口返回 200 并回显新内容**，用户没有任何提示地丢内容；对敏感编辑还会顺带把加密与敏感位一起抹掉。直接否掉"什么都能丢"和"可靠找回"。

### 2.2 P1-1：派生明文不在守护字段【生产实测 + D1 实查】

`sensitiveIngestGate` 只洗 `meta.raw_transcript`，其余 meta 字段原样落库；导出/备份的脱敏只替换 `content/title/tags`。

- 真实长文件上传（`POST /api/ingest/media`，`type=file`，600 字以上触发摘要）：D1 里 `content = "[加密内容]"`、`is_sensitive = 1`，同一行 `meta.file_excerpt` 是**前 6000 字明文**，内含「服务器 root 密码设为 …」原文。
- 客户端可直接投递 meta：`POST /api/notes` 带 `meta.raw_transcript = "我的银行卡密码是 <marker>"` 且正文无害 → 整条按非敏感明文入库（`is_sensitive = 0`）。
- 出口验证：默认 `GET /api/export?format=json`（不带 `include_sensitive`）与备份 zip 的 `notes.json` 里都能搜到上述明文 marker；Markdown 导出泄漏 §2.3 的明文笔记正文。
- 【代码证据】图片路径 `meta.image_description`（视觉模型对"密码截图"的完整描述）与链接路径 `url_summary` / `url_title` 同型：非守护字段、直写、导出不脱敏。**图片路径本轮只做了 meta 注入等价验证，未用真实含密截图跑通，标【未验证】**。

### 2.3 P1-2：`skip_triage` 明文入库且永不复判【生产实测 + D1 实查 + 代码证据】

`POST /api/notes {skip_triage:true}` → `prepareNoteInsert(..., { rejudge: false })`，只用高精度 `detectSensitive`（要求"密码…是/为 X"这类赋值句式），`maybeSensitive` 的主题级 fail-closed 被关掉；同时写 `manual_override.category`，cron 永不复判。

生产结果：`家里 wifi 密码 <marker> 别忘` → `is_sensitive = 0`、`content_enc = NULL`、明文入库，Markdown 导出原样带出。调用方是 Web 快速输入的 raw 模式与 Ask 的「存为笔记」（`web/src/components/quick-input.tsx`、`ask-chat.tsx`），都是真实用户路径。

源码注释说明这是有意取舍（"broad hint would stay encrypted forever"）。审查判定：取舍方向可以理解，但**代价是 fail-closed 在一整类真实入口上失效**，且没有任何补偿机制（不复判、不提示、导出不脱敏）。可选的更优解：skip_triage 只跳过"分类"，不跳过"敏感预检"；或对命中 `maybeSensitive` 的 skip_triage 笔记保留一次复判。

### 2.4 未能攻破的路径（本轮反向证据）

- `PATCH` 正文写密码（R123 P1-1 原漏洞）→ 【生产实测】`content = "[加密内容]"`、`content_enc = v1:…`、`is_sensitive = 1`、`needs_retriage` 复判后仍判敏感；标题/标签 PATCH 带密码值 → title 置空、marker 标签被 `sanitizeSensitiveTags` 剔除。**修复成立**。
- 敏感笔记不进图谱：`extractGraph` 对 `is_sensitive` 直接 purge；【生产实测】敏感笔记无 entities/edges。显式 `is_sensitive:false` 解敏后会生成含秘密值的图谱实体（这是用户主动解密的显式语义），再标回敏感时实体被清除——**行为自洽**。
- 迁移脚本 `0021_r120_scrub_sensitive_meta.sql` 直写 `title/tags`（清洗用途，合理），但说明**迁移目录不在静态断言扫描范围**，未来迁移可无声写入守护字段（P2-1 的一部分）。

## 三、永久注销原子级联【生产实测 + D1 实查 + R2 实查】

`[QA-R125]-del`（`u_e55169a…`）先造数：4 条笔记（含 1 条敏感、1 条文件上传带附件）、偏好、每日回顾、线程重建任务，异步管道跑满 90s 后：

| 快照 | notes | entities | edges | user_preferences | thread_jobs | thread_backfill | users | attachments | note_embeddings | auth_rate_limits |
|---|---|---|---|---|---|---|---|---|---|---|
| DELETE 前 | 4 | 4 | 6 | 1 | 1 | 1 | 1 | 1 | 3 | 2 |
| DELETE 后 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **2** |

（其余 `threads / weekly_reports / push_subscriptions / push_daily_log / wechat_mp_bindings / wechat_mp_bind_codes / wecom_kf_bindings / daily_reviews` 前后均 0。）

- `DELETE /api/auth/me` → 200 `{ok:true}`；孤儿检查 `attachments / note_embeddings / edges(by note_id)` 全 0。
- 旧 token 立即失效（后续调用 401）。
- 【R2 实查】附件 `media/u_e55169a…/…/qa-r125-del.txt` → `The specified key does not exist.`，异步 R2 清理真实生效。
- `USER_ID_TABLES` 与库内实际含 `user_id` 的 14 张表**完全一致**，`NOTE_ID_TABLES` 覆盖 `attachments / note_embeddings`，单个 `DB.batch` 保证原子性【代码证据】。
- 残留（P2-2）：`auth_rate_limits` 里 2 行 key 含被删 user_id（无内容、仅计数），注销后未清。
- 【未验证】Vectorize 向量删除无只读查询手段，本轮未核。

## 四、语音纠错拒答文案回退【生产实测】

用 gTTS 合成 4 段真实中文语音 → `POST /api/ingest/media {type:"audio"}` → 生产 Whisper 转写 + 纠错模型：

| # | 语音内容 | 转写/落库结果 | 判定 |
|---|---|---|---|
| 1 | 「我的银行卡密码是三六九零二五…」 | `text` = 完整原话；`content = "[加密内容]"`、`is_sensitive = true`、`meta` 只剩 `needs_retriage`（`raw_transcript` 已洗净） | ✅ |
| 2 | 身份证号 + 银行卡密码 + 支付宝密码混合 | 同上，转写完整、正文加密 | ✅ |
| 3 | **「作为人工智能，你无法处理这些敏感信息，抱歉…」（原话本身含拒答特征词）** | 落库正文 = 用户原话逐字保留（未被纠错模型的输出替换），`is_sensitive = false` | ✅ 回退口径正确 |
| 4 | 「服务器的 root 口令改成了…API 密钥是 sk 开头的那串」 | `content = "[加密内容]"`、`is_sensitive = true` | ✅ |

4/4 **没有任何一条落库成拒答文案**，敏感语音的 `raw_transcript` 派生明文也确实被洗净（补上了 R123 标注的【未验证】项）。

【未验证】无法在生产**强制**纠错模型真的拒答（`isCorrectionRefusal` 的两条分支：特征词命中 / 长度严重失真），因此"回退逻辑本身"只有单测 + 样本 3 的等价观测，不是对拒答路径的直接触发。

## 五、计数/统计类提问 15 问矩阵【生产实测 + D1 实查】

语料：`[QA-R125]-probe`，15 条（12 条 Cubox 导入 + 3 条 API），跨 2026-07-20 ~ 08-15，分布 idea 6 / expense 4 / todo 3 / collect 1 / data 1，无敏感笔记。D1 口径为准。

| # | 提问 | 期望（D1 口径） | 生产回答 | 判定 |
|---|---|---|---|---|
| 1 | 我到目前为止一共记了多少条笔记？ | 15 + 分布 | 15，想法 6/支出 4/待办 3/收藏 1/资料 1，"数据库精确统计" | ✅ 精确 |
| 2 | 我记了几篇笔记？ | 15 | 同上 | ✅ 精确 |
| 3 | 我最早的一条笔记是什么时候记的？ | 2026-07-20 01:00 UTC | **2026-07-22 02:00:00 [1]**（接口首测错答；浏览器复测第一次答对 07-20、重试再现错答 07-22） | ❌ **不确定性错答（P1-3）** |
| 4 | 我平均每天记几条笔记？ | 15/27 ≈ 0.56 | fail-closed（理由文案不符）+ 精确总数 | ⚠️ 安全但降级 |
| 5 | 这个月我记了多少条笔记？ | 11 | 11 + 分布 | ✅ 精确 |
| 6 | 上个月我一共记了多少条笔记？ | 4 | 4 + 分布 | ✅ 精确 |
| 7 | 本周我记了多少条笔记？ | 5 | 5 + 分布 | ✅ 精确 |
| 8 | 今天记了几条？ | 3 | 3 + 分布 | ✅ 精确 |
| 9 | 我的待办有多少条？ | 3 | fail-closed（但同一段文本里就写着"待办 3 条"） | ⚠️ 自相矛盾（P2-3）|
| 10 | 想法类的笔记有几条？ | 6 | fail-closed（同上） | ⚠️ 同上 |
| 11 | 关于咖啡的笔记有多少条？ | 1（主题限定） | fail-closed + 精确总数 | ✅ 设计目标 |
| 12 | 我一共收藏了多少条？ | 1（collect） | **"你一共记了 15 条笔记"**（按总数答分类问题） | ❌ 口径错配、答案误导 |
| 13 | 昨天都记了什么？ | 0 条 | "昨天你没有记录任何笔记。" | ✅ 精确枚举 |
| 14 | 7 月我一共记了多少条笔记？ | 4 | fail-closed（绝对月份未解析） | ⚠️ 能力缺口 |
| 15 | 加密的敏感笔记有几条？ | 0 | fail-closed（该数值已在精确统计里可得） | ⚠️ 同上 |

Q3 的行为是**非确定性**的（同一问题多次提问答案不同：07-20 / 07-22），这正是「没走 SQL、由 LLM 对 top-k 召回作答」的特征——比稳定错答更难被用户察觉。

汇总：**精确且正确 7/15**（Q1/2/5/6/7/8/13，相对时间窗全部正确，R123「210 条答成 16」的同型缺陷已消除）；**安全降级 6/15**（其中只有 Q11 是设计目标）；**错答 2/15**（Q3 事实错误、Q12 口径错配）。Q3 最伤：`min(created_at)` 是一条 SQL 就能精确回答的问题，却由 LLM 对 top-k 召回猜答，且没有任何不确定性提示。

## 六、【重点】公开推广终审：GO / NO-GO

### 6.1 R123「暂不建议」两项必须项逐条复核

| R123 必须项 | 本轮复核 | 结论 |
|---|---|---|
| P1-1 PATCH/batch 绕过敏感管道，秘密值明文落库并进备份 zip | 【生产实测】PATCH 正文/标题/标签三路攻击全部被拦（加密 + title 置空 + 标签过滤 + 复判仍判敏感）；批量打标经 `prepareTagsUpdate`【代码证据】 | ✅ **已闭环** |
| P1-2 非财务计数/枚举由 LLM 心算、自信错答 | 【生产实测】15 问中 7 问走 SQL 精确聚合且全部正确，时间窗枚举正确；残留 Q3/Q12 两处错答（P1-3） | ⚠️ **主体闭环，同型残留未清** |

R123 的两个 P2/设计建议（限流补盲、押金对账、时间窗枚举、纠偏样本等）不在本轮重复审查范围。

### 6.2 结论：**NO-GO（仍不建议公开推广）**

理由不是 R123 的老问题——那两项确实修好了——而是本轮新发的三条，且都命中"最普通的用法"：

1. **P0-1 必须先修**：公开推广的第一批用户一定会"记完立刻改一句"。返回 200 却把内容悄悄改回旧值，是比错答更致命的信任事故，且没有任何用户可见线索（无 409、无提示）。修复方向：`applyTriage` 的内容回写加 `content_enc IS ? / updated_at = ?` 版本谓词或"仅当内容未变更"谓词；改动面小、在 DAO 内一处。
2. **P1-1 必须先修**：把含密码的文件/截图丢进来，是这个产品最想要的用法（"什么都能丢"）；正文加密但摘要明文进导出/备份，属隐私事故级别。
3. **P1-2 必须先修**：`/` 速记与 Ask 存笔记是主路径，密码类内容明文入库且永不复判。
4. **P1-3 建议同批修**：一条 SQL 就能精确回答的"最早一条/收藏几条"仍在自信错答，与 R123 被否的理由同型。

可推广判定：**修完 P0-1 + P1-1 + P1-2（建议含 P1-3）并回归验证后，本报告的其余部分不构成阻塞**——找回主线、注销级联、语音回退、计数精确聚合都已具备对外讲承诺的底气；P2 三项可在推广后短周期迭代处理。

## 七、设计质疑：两个未审过的流程深挖

### 7.1 D1：敏感治理的边界画错了——应守"派生明文闭包"而非"5 个列"

现状：守护字段 = `content / content_enc / title / tags / is_sensitive`，收口在 `note-store.ts`，静态断言守列名。但正文的**派生明文**散落在非守护字段里，各自直写：

| 派生明文 | 来源 | 写入点 | 敏感时是否处理 | 导出/备份是否脱敏 |
|---|---|---|---|---|
| `meta.raw_transcript` | 语音原始转写 | DAO 内 | ✅ 删除 | — |
| `meta.file_excerpt` | 文件前 6000 字 | `createNote` 传入 meta | ❌ | ❌ |
| `meta.image_description` | 视觉模型完整描述 | 同上 | ❌ | ❌ |
| `url_title` / `url_summary` | 链接正文 AI 摘要 | `extract.ts` 直写 | ❌ | ❌ |
| 客户端任意 `meta.*` | 调用方 | 直接采信 | ❌ | ❌ |

"是否真的最适合？"——不是。真正的不变式是 **"任何由用户内容派生的明文都必须与 `content` 同生命周期、同敏感口径"**，而当前实现把不变式退化成了"列名白名单"，于是 R117→R123 的"另一个入口"从**列维度**（已被 R124 堵住）平移到了**字段维度**（本轮 P1-1 就是第一例）。

更好的做法（一处收敛、实体不增）：
1. `NoteMeta` 显式区分 `derived`（派生明文，敏感时统一 purge/加密）与 `control`（`manual_override` / `needs_retriage` / `media_status` 等控制位），`sensitiveIngestGate` 只需清空 `meta.derived` 整个子树，不再逐字段列举；
2. 客户端只允许投递白名单 meta 键（当前任意 meta 被直接采信，等于把派生明文的写权交给调用方）；
3. 导出/备份的脱敏改为"取反白名单"：敏感笔记只输出 `id/时间/分类` 等安全字段，而不是替换三个已知字段；
4. 静态断言从"扫列名"升级为"派生明文只能经 DAO 的 `putDerived()`"，并递归扫 `src/**` 与 `migrations/*.sql`（顺带修掉 P2-1 的扫描范围与写法绕过）。

### 7.2 D2：异步分拣与用户写入之间没有并发模型（P0-1 的结构性根因）

现状的写模型是两条互不知情的路：

```
请求侧：SELECT existing → applyNotePatch（sets + CAS updated_at）→ 200
管道侧：createNote 闭包捕获 content → waitUntil(triageNote 数秒) → applyTriage 无条件回写 content/is_sensitive/title/tags/category
```

请求侧有乐观锁、管道侧没有；而两侧写的是同一批列。于是"用户编辑 vs 自己的分拣"这条最常发生的并发路径完全没有仲裁——**先到的用户编辑被后到的旧快照覆盖**（P0-1）。同样的模式还出现在 cron 复判、导入回填、媒体重试三处，窗口从秒级到分钟级。

"有没有更好的方式？"有，且都不需要增加实体：
1. **最小修**：`applyTriage` / `replaceNoteContent` 的内容回写带上乐观谓词（`WHERE id = ? AND updated_at = ?` 或 `AND content_enc IS ?`），冲突时**只写分类/标签等非内容列**并放弃 content 回写——分拣的价值本来就不在"改正文"。
2. **更彻底**：给 notes 加单调 `rev`（或复用 `updated_at`）作为唯一并发货币，所有写路径（请求侧 + 管道侧）统一走 DAO 的 CAS 入口；DAO 已经存在，这是把"唯一写路径"从**语法收口**升级为**语义收口**——`rev` 不匹配就 no-op 并记一条 observability 日志。
3. **可观测性**：当前分拣被跳过/被冲突丢弃时没有任何用户可见或日志可见信号，建议 no-op 分支打点（本轮 P0-1 之所以能长期存在，正是因为它在返回 200 的同时完全静默）。

顺带一个"如无必要勿增实体"的观察：`meta.needs_retriage` 已经是一个"待复判"状态位，而 `category IS NULL` 也表示同一件事，cron 的 `WHERE (category IS NULL OR json_extract(meta,'$.needs_retriage') = 1)` 用两种表示描述同一状态机，建议合并为单一状态字段。

## 附录 A：证据与截屏

- 断言对抗探针：`/tmp/guardprobe/probe.mjs`（仓库外，逐条 CAUGHT/BYPASS 输出见 §1.2 表）；SQL 合法性本地 sqlite3 实测。
- P0-1 复现脚本与原始输出（仓库外）：创建→0s/3s/8s 编辑三组、敏感 race 两组、D1 t+0/t+30/t+90 快照。
- 注销级联：DELETE 前后 17 组行数快照、孤儿检查、R2 `object get` 输出、注销后 token 401。
- 语音：4 段 TTS 音频 + 生产 `POST /api/ingest/media` 响应与 D1 行。
- 计数矩阵：15 问原始回答 JSON + D1 口径查询。
- 浏览器视觉检查与录屏【生产实测】（Playwright/CDP 注入 QA token 登录生产站点，一段连续录屏 + 标注，随汇报附送）：
  - **P0-1 经真实 UI 路径复现**：速记框保存后 **1.07s** 打开卡片编辑并保存（网络面板：`POST /notes 201 @0.31s`、`PATCH /notes/<id> 200 @1.07s`），60s 后刷新——UI 与 API 均显示内容被静默回滚为原文，`updated_at` 停在创建后 2 秒；两次尝试（1.07s / 1.68s）均复现。
  - 时间流展示 15 条语料、分类筛选（想法 6 / 支出 4 / 待办 3）、搜索「咖啡」命中均正常，无明显视觉缺陷。
  - Ask 计数精确回答截图；「最早一条」错答截图（P1-3）。
  - 敏感笔记 UI 以「敏感」徽标 + 圆点遮蔽展示、标题为空、无秘密值外露；同屏可见 `skip_triage` 明文密码笔记（P1-2）。
  - 附带发现（偶发、未定级）：一次分类请求长时间 loading 后显示「网络连接失败，请检查网络后重试」，点重试恢复。

（含 QA marker 的原始数据与 token 保存在仓库外 `/home/ubuntu/qa-r125/`，按纪律不落库、不在报告中展示秘密值本体。）

## 附录 B：QA 账号与数据自清

| 账号 | 用途 | 注销 | 逐表核清 |
|---|---|---|---|
| `[QA-R125]-probe` | 计数 15 问语料（15 条） | ✅ | ✅ |
| `[QA-R125]-main` | 视觉检查 / 导出备份出口扫描 | ✅ | ✅ |
| `[QA-R125]-sec` | 敏感写路径攻击 / P0-1 复现 | ✅ | ✅ |
| `[QA-R125]-del` | 注销原子级联实测 | ✅（即测试本体） | ✅ |
| `[QA-R125]-voice` | 语音纠错回退实测 | ✅ | ✅ |

核清口径：18 组统计（14 张 `user_id` 表 + `users` + `attachments` / `note_embeddings` / `edges(by note_id)` 孤儿）全部为 0，详见汇报正文。`u_boss` 全程未触碰（所有查询均带 `user_id = '<QA uid>'` 谓词）。

## 附录 C：本轮【未验证】清单（不作结论）

1. 真实"含密码截图"走 `image_description` 的端到端泄漏（本轮以 meta 注入 + 代码走读等价推断）。
2. cron 复判 / 导入回填 / 媒体重试三处的编辑覆盖窗口（与 P0-1 同根因，仅代码证据）。
3. `isCorrectionRefusal` 拒答分支在生产被真实触发（无法强制模型拒答）。
4. Vectorize 向量在注销后的删除（无只读查询手段）。
5. 微信 MP / 企微 KF 通道的端到端实测（缺公众号测试号绑定，本轮只做代码走读；`/api/wechat/bind-code` 生产返回 404）。
6. 限流（R123 P2-1）与押金对账（P2-2）等 R123 遗留 P2 项，本轮不在范围。
