# 碎念 Suinian R137 独立审查报告

- 审查日期：2026-08-15
- 审查对象：main @ `e867eca`（R136 #158：Web/PWA 语音输入 + 演示数据导入/清理提示 + MCP 文档防漂移 + 备份文件名区分）
- 审查方式：只审不改。全部结论基于生产实测（https://suinian.zalize.com / https://suinian-api.zalize.com）、真实接口调用、源码检查与本地 eval 重跑；未验证项如实标注。
- QA 纪律：全程未读写 `u_boss` 内容；QA 账号使用 `[QA-R137]` 前缀，测后注销并逐表核验（附录 C）。

## 总评

核心主线「什么都能丢 → AI 整理 → 可靠找回」在 R136 之后依然成立，且 R136 四项修复全部真实落地。本轮 **0 P0、1 P1、3 P2、3 设计建议**。1060 条规模压测显示检索/问答/备份链路在千条量级无退化，分拣补拣吞吐与 R75 修复后基线（~1700 条/小时）一致；新发现的 P1 是千条量级下线索重整任务在 summarize 阶段停滞不收敛（§3.1）。

三环节评分（10 分制）：

| 环节 | 评分 | 依据 |
|---|---|---|
| 什么都能丢 | 9.0 | 文字/语音/图片/文件/导入全入口可用；离线文字+语音均入队补传；扣分项：离线补传对 429/5xx 直接丢弃录音（P2-1） |
| AI 自动整理 | 8.5 | triage eval 53/53、语音转写→分拣正确、1060 条积压 ~1700 条/小时排空；扣分项：千条量级线索重整 summarize 停滞（P1-1）、月报统计静默截断（P2-2） |
| 可靠找回 | 9.5 | ask eval 59/60（98%）、千条量级搜索 <0.3s、精确计数路由准确、敏感口径无泄漏；扣分项：敏感提示推荐词依赖正文命中（P2-3） |

---

## 一、R136 复核（全部通过）

### 1.1 语音录音输入全链路 ✅

【生产实测 + UI 实录，录屏与截图见附录 A】

- 桌面：速记框内麦克风按钮可见（aria-label「录音，AI 转写为文字」）；点击后出现红点、`mm:ss` 计时、取消（X）与停止发送（■）；停止后走 `POST /api/ingest/media`，转写文本落库为 `raw_type:"voice"`，AI 分拣出正确分类与标签。
- iPhone 390×844：录音按钮可见、录音态控件不溢出，移动布局正常（`docs/assets/r137-mobile-recording.png`）。
- 可搜可问：语音笔记经 `/api/notes?q=...` 关键词可命中；`/api/ask` 能召回语音内容作答。
- 敏感语音：转写文本进入统一加密管道——D1 与普通接口正文均为 `[加密内容]`，`content_enc` 存在，`meta` 无 raw transcript 泄漏；问答/搜索/默认备份出口均不泄明文（`docs/assets/r137-sensitive-masked.png`）。
- 离线排队：断网录音入 IndexedDB `media` store，界面显示待同步数量；恢复网络后自动补传成功（`docs/assets/r137-offline-synced.png`）。
- Permissions-Policy：`web/public/_headers` 已为 `microphone=(self)`，生产响应头一致，录音权限可正常申请。

### 1.2 演示数据提示 ✅

- 演示模式写入 2 条笔记后注册：出现「演示模式里还有 2 条你记的笔记」迁移提示，一键导入逐条走 `POST /api/notes`（AI 重新分拣），导入后 mock localStorage 清除（`docs/assets/r137-demo-prompt.png`）。
- 纯种子演示数据（用户未写入）注册时不打扰，直接进入时间流（第二账号验证）。

### 1.3 MCP 文档防漂移 ✅

- `mcp/src/docs.test.ts` 用 InMemory transport 实际列举注册工具集，与 README、`docs/mcp.md` 比对；本地 `npx vitest run`：2 tests passed。11 个工具全部列出，R135 的 8 vs 11 漂移已闭环。

### 1.4 备份文件名区分 ✅

- 默认备份 `suinian-backup-<date>.zip`（敏感正文脱敏），完整备份 `suinian-backup-<date>-full.zip`（含明文 + manifest 标记），生产实测 Content-Disposition 一致。

## 二、R127-R136 十轮大回归（12 项抽测 + eval + Lighthouse）

【生产实测 + 本地 eval 重跑】12 项抽测结果：

| # | 修复项（轮次） | 结果 |
|---|---|---|
| 1 | 敏感数据统一口径：正文密文、出口占位（R119+） | ✅ 语音/文字敏感笔记 D1 密文、搜索/问答/默认备份不泄漏 |
| 2 | 精确计数 SQL 路由（R126） | ✅ 「一共记了多少条」返回数据库精确统计并注明口径 |
| 3 | 主题枚举（R129） | ✅ eval 主题枚举 2/2 |
| 4 | 财务合计与澄清追问（R121/R123） | ✅ eval 财务澄清 1/1；生产追问「包括…吗」正确走澄清路由 |
| 5 | 缺失事实拒答（R125） | ✅ 不编造，明确说明无相关记录 |
| 6 | 409 乐观锁冲突（R124） | ✅ 携带旧 `updated_at` PATCH 返回 409 |
| 7 | 默认/完整备份口径（R132/R136） | ✅ 默认脱敏、完整明文 + manifest，文件名区分 |
| 8 | AI health 探针（R130） | ✅ `/health?probe=ai` `ok:true`（provider=fallback, workers-ai llama-3.3-70b） |
| 9 | MCP 文档防漂移（R136） | ✅ 本地测试通过 |
| 10 | 导入 2000 条上限 truncated 标记（R130） | ✅ 1060 条导入 `truncated:false`，逻辑在位 |
| 11 | bulk_ingest 限流（R122） | ✅ 第 4 次导入 429 |
| 12 | transfer 口径（R121-123） | ✅ triage eval category 53/53 含 transfer 用例 |

- **ask eval 全套重跑**：59/60（98%），唯一失败 q31「为什么依据」引用集不全（召回正确、引用列表缺 1 条），与历轮同源、非新漂移。
- **triage eval 全套重跑**：category 53/53、todo_due 5/5、tags 无前缀污染 53/53、sensitive 11/11、amount 22/22。
- **Lighthouse desktop 四项**：Performance / Accessibility / Best Practices / SEO 全部 100，无退化。
- 观察项（非本轮缺陷）：`/health?probe=bridge` 为 `waiting_scan`（微信桥登录扫码超时），属已知运维态，不影响核心主线。

## 三、数据规模健康：1060 条重度账号压测（对比 R75 基线）

【生产实测】账号 `[QA-R137]-scale`，导入 1060 条跨 360 天、5 大主题 + 支出/待办混合的真实感笔记。

| 链路 | 本轮（1060 条） | R75 基线参照 | 结论 |
|---|---|---|---|
| 批量导入 POST /api/import | 1060 条 2.3s，imported=1060 failed=0 | —（R75 为 3000 条） | ✅ |
| 列表首页 GET /api/notes?limit=50 | 0.14s ×3 | 0.13–0.14s（R127 附录 A） | ✅ 无退化 |
| 深分页（cursor 走完 11 页×100） | 最差单页 0.31s | — | ✅ 无线性劣化 |
| 关键词搜索（马拉松/咖啡） | 0.25–0.27s | 0.09s（小数据量） | ✅ 千条量级仍亚秒 |
| 精确计数问答（SQL 路由） | 0.27s | 0.1–0.2s | ✅ |
| 语义问答 POST /api/ask | 1.8–2.5s | 1.6–4.1s | ✅ 同量级 |
| /api/stats（360 活跃天全量） | 0.14s | — | ✅ |
| 备份 GET /api/backup | 0.26s / 53KB zip | — | ✅ |
| 导出 GET /api/export?format=json | 0.22s / 616KB | — | ✅ |
| 分拣补拣吞吐（cron 排空） | 1035 条 / 35min ≈ **1770 条/小时**（10:53 全部排空） | R75 修复后 ~1700 条/小时（PR #91 实测） | ✅ 与基线一致，无漂移 |
| 线索重整 755 条想法聚类 | cluster 完成 37 线索（聚类正确） | — | ✅ 聚类 / ❌ summarize 停滞（P1-1，§3.1） |
| 语义问答（分拣后） | 「开咖啡店的想法」5.6s 召回 15 条归因 | — | ✅ |

补拣排空取样（问答精确计数，UTC）：10:18 待分类 1010 → 10:23 875 → 10:28 700 → 10:33 585 →（排空全程见附录 B drain.log）。分拣后的分类分布合理（想法/支出/待办/资料），金额问答「最近一个月在咖啡上花了多少钱」返回逐笔归因合计。

结论：写入、检索、问答、统计、备份全链路在千条量级健康，补拣吞吐与 R75 3000 条修复后基线一致；唯一异常是线索重整任务（§3.1）。

### 3.1 P1-1：千条量级线索重整任务在 summarize 阶段停滞不收敛

【生产实测】分拣排空后（755 条想法）触发 `POST /api/threads/rebuild`：

- cluster 阶段完成（755/755，产出 37 条线索，聚类质量良好——「手冲埃塞俄比亚豆子风味」65 条、「跑步姿势研究」62 条等主题正确聚合）；
- 随后进入 summarize 阶段，**从 11:07 到 11:51（44+ 分钟、跨 4 个以上 10 分钟 cron 复活周期）`summarized` 始终为 0/37**，job 状态永远 `running`（取样日志见附录 B rebuild-watch.log）；
- 同期 37 条线索的 summary 靠另一条路径（全量聚类 backfill cron 顺带 summarize）缓慢补齐（11:47 时 16/37），但 rebuild job 本身不收敛——用户界面上「重整线索」永远转圈，且每个 cron 周期都被这个僵死 job 消耗预算。

根因分析（源码证据，标注为推断）：`runRebuildJobSlice` 每步 30s 预算、步后落盘；但 `summarizeThread` → `chatComplete` 的 Workers AI 路径（`runWorkersAi`，ai.ts）调用 `env.AI.run` **没有超时/abort 保护**（DeepSeek fetch 路径有 `AbortSignal.timeout(20s)`，Workers AI 路径没有）——生产当前正是 workers-ai fallback 主力。推断为首条线索的 AI 调用挂起 → slice 整体被杀 → 进度未落盘 → 3 分钟后被 cron 判 stale 重启 → 再次挂在同一条上，形成毒丸循环。cluster 阶段进度同样呈「长时间 0 → 一次性跳变」的簇状（附录 B），与 slice 反复夭折的模式吻合。

- 影响核心主线：**是**（AI 整理：千条量级用户的线索重整不可完成，重整入口实际不可用）。
- 小账号不受影响（历轮 R121/R123 重建实测正常），属规模才暴露的缺陷。
- 修复方向建议：给 `runWorkersAi` 补上与 fetch 路径同等的超时保护（`Promise.race` 20s 即可，不新增实体）；summarize 失败时也推进 cursor（现逻辑已推进，但前提是调用能返回）。

## 四、安全周期性复审

【生产实测】

- 鉴权：`/api/notes|stats|ask|backup|export` 无 token 全部 401；伪造 token 401；`/api/ingest/media`（新语音入口）无 token 401。
- 越权：用 A 账号 token 对 B 账号笔记 GET/PATCH/DELETE 均 404（不泄露存在性）。
- 限流：`bulk_ingest` 第 4 次 429；登录爆破第 6 次起 429；`note_write`（含语音入口）共用 60/min 限额（代码证据 index.ts:2173）。
- 敏感出口：搜索/问答/默认备份/普通接口正文均为占位或脱敏（§1.1）。
- 凭据扫描：对全仓 ts/tsx/toml/json/kt/yml 做密钥模式扫描（api key / AKIA / PRIVATE KEY / 长随机 token 赋值），0 命中；`wrangler.toml` 仅含资源 ID 与公开配置，无 secrets。

未验证：R2 桶对象级越权（需更高权限 token 直查，本轮未做）；DoS 级压测（避免影响生产）。

## 五、设计质疑（2 个未审过流程深挖）

### 5.1 周报/月报生成链路（`backend/src/reports.ts`，历轮未审）

流程：cron（周一/每月 1 日）→ `generateAll*Reports` 遍历全部 users → 每用户查询期段笔记 → LLM 生成 → upsert `weekly_reports`。

质疑点与建议：

1. **统计静默截断（P2-2）**：期段查询 `LIMIT ${month ? 1000 : 300}`，超限笔记被静默丢弃——月报的「收支合计」「总数与分类计数」都在截断后的集合上计算，重度用户（>1000 条/月，本轮 1060 条/年账号尚安全，但 R75 已证明 3000 条量级真实存在）月报金额会**无提示低估**，而 prompt 却把它标注为「权威计数、不要重算」。更适合的做法：计数与收支合计改走 SQL 聚合（复用 `/api/stats` 与精确计数路由的现成口径），只有 digest 摘要用 LIMIT——统计口径与展示摘要解耦，不新增实体。
2. **全用户串行无时间预算（设计建议 D1）**：`generateAllWeeklyReports` 逐用户串行 LLM（单用户 40s 超时），与 R75 修复前的 retriage 是同一模式。当前用户量无感，但已有现成的「时间预算 + 并发」模式（R75 `retriageUnsorted`）可直接复用；建议在用户量增长前对齐，避免重蹈 R75 的 2 天积压。
3. 好的一面：敏感笔记「计数计入、正文绝不进 digest/展示」口径贯彻一致；LLM 失败回退 fallbackMarkdown 不丢报告；同期重生成为 upsert 不产生重复实体——符合「如无必要勿增实体」。

### 5.2 离线 outbox 补传（`web/src/lib/outbox.ts`，R136 扩展 media 后未审）

流程：网络失败 → IndexedDB（notes/media 两 store）→ online 事件/启动时 `flushOutbox` 逐条补发，成功即删，NetworkError 停队，其余错误**丢弃出队**。

质疑点与建议：

1. **非网络错误一律丢弃对语音过重（P2-1）**：文字笔记被 413 拒绝时用户还能从输入框重打，但录音是**不可重建**的——补传时若命中 429（`note_write` 限额，服务端明确返回 `retryable:true`）或临时 5xx，`flushOutbox` 会把录音永久删除，无任何提示。这与「什么都能丢」的承诺相悖：恰恰是攒了一队离线语音集中补传的场景最容易触发 429。更适合的做法：对 429/5xx（服务端已给出 `retryable` 信号）保留在队并退避重试，仅对确定性 4xx（413/400）丢弃并给用户一条失败通知；不新增实体，只改分支条件。
2. **media 补传无幂等去重（设计建议 D2）**：注释声称「服务端按内容+时间去重」，这只对文字 `createNote` 成立（同分类+同首行去重，index.ts:925）；`/api/ingest/media` 每次上传都重新转写建新笔记，补传响应丢失（请求已成功、响应超时）会产生重复语音笔记。建议客户端为每个 media 项生成 UUID 随请求携带，服务端按 `(user_id, client_id)` 幂等——复用 meta 字段即可，不新增表。
3. 好的一面：IndexedDB 选型论证充分（配额/阻塞/平台覆盖）；单飞锁 `flushing` 防并发重放；notes 先于 media 保持时序直觉。

## 六、问题分级汇总

| 级别 | 编号 | 问题 | 影响核心主线 | 证据 |
|---|---|---|---|---|
| P1 | P1-1 | 千条量级线索重整 job 在 summarize 阶段停滞 44+ 分钟不收敛（0/37），状态永远 running；推断根因为 Workers AI 调用无超时形成毒丸循环 | **是**（AI 整理） | §3.1 + 附录 B rebuild-watch.log |
| P2 | P2-1 | 离线 outbox 补传对 429/5xx 一律永久丢弃录音（服务端明确 `retryable:true` 仍丢） | **是**（什么都能丢：离线语音可静默丢失） | outbox.ts:137-143/155-159 + index.ts:2174 429 响应实测 |
| P2 | P2-2 | 周报/月报统计在 LIMIT 300/1000 截断集合上计算且无提示，重度用户月报金额低估 | 是（AI 整理的可信度） | reports.ts:227 + prompt「权威计数」矛盾 |
| P2 | P2-3 | ask 敏感提示推荐的搜索词按正文字段命中生成，若敏感关联仅在标签上，推荐词在时间流搜索可能 0 命中（搜索字段不含 tags） | 否（有绕行：手动换词） | ask.ts sensitiveHintLine + index.ts KEYWORD_FIELDS 源码比对 + 生产两问对照实测 |
| 建议 | D1 | 报告 cron 全用户串行无时间预算，建议复用 R75 时间预算+并发模式 | 否（当前规模无感） | reports.ts:337-358 |
| 建议 | D2 | media 补传无幂等键，响应丢失会重复建语音笔记 | 否（低概率、可手删） | outbox.ts:150-154 + index.ts:2171+ 无去重 |
| 建议 | D3 | ask eval q31 引用集不全（59/60 唯一失败，历轮同源） | 否 | 附录 B ask-eval.log |

## 附录 A：UI 实测证据

- 录屏（带注解）：语音全链路（桌面+iPhone 尺寸+敏感语音+离线排队）、演示数据迁移提示——见 PR 附件/会话产物 `rec-a05c46a8`、`rec-f92a09af`。
- 截图（已入库 docs/assets/）：`r137-voice-note.png`（语音转写落库+分拣）、`r137-mobile-recording.png`（iPhone 尺寸录音态）、`r137-offline-synced.png`（离线队列恢复补传）、`r137-demo-prompt.png`（演示数据迁移提示）、`r137-sensitive-masked.png`（敏感语音密文口径）。

## 附录 B：测试产物（会话机 ~/qa-r137/）

`ask-eval.log`（59/60）、`triage-eval.log`（53/53 等五项）、`lh-r137.json`（四项 100）、`import.json`、`drain.log`（补拣排空取样）、`rebuild-watch.log`（线索重整 summarize 停滞取样）、`stats.json`、`backup.zip`/`bk-default.zip`/`bk-full.zip`、搜索/问答响应样本。

## 附录 C：QA 自清核验

- 账号 `[QA-R137]-main`、`[QA-R137]-scale`、`[QA-R137]-triage`（eval 脚本已自清）、`[Q-R137]-ui-demo`、`[QA-R137]-ui-demo2` 全部 `DELETE /api/auth/me` 注销。
- 【D1 实查】user 域表对全部 QA user_id 计数为 0；全量 `SELECT id, name FROM users` 仅剩 `u_boss / Thomas`。
- 会话机上的 token/密码文件已删除。
- `u_boss` 全程未读未写其内容。
