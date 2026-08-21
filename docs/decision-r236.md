# R236 修改轮决策记录（落实 audit-r235）

对应审查报告：`docs/audit-r235.md`（R235 终定 GO：无 P0/P1，P2×3 必清 + P3×8 逐条评估）。统一管道原则：全部收口在既有管道内，不新增平行逻辑。

## 1. P2-1 孤立「赔付了 15 元」判 expense → 双重根因：词面兜底误翻 + few-shot 缺口

先归因后动手（一手证据）：

- few-shot 回流（`triage.ts` buildTriagePrompt 增加赔付方向双语境判例）后**生产复测仍 100% 判 expense**——说明模型主判不是唯一根因。
- 源码追查：`fixFinanceDirection` 词面兜底的 `EXPENSE_DIRECTION_RE` 含裸 `付了`，「**赔**付了」被误当无歧义支出证据，把模型（提示词修正后）正确的 income **确定性翻回 expense**。
- 修复：`付了/付款` 加 `(?<!赔)` 排除（这是修正既有正则的误匹配，非新增方向正则）；方向主判仍由模型 few-shot 承担：「谁赔谁」双语境判例（别人赔我=income / 我赔别人=expense / 孤立无对象默认获赔=income）。
- 生产实测（部署后）：`商家超时赔付了 15 元`→income 15、`赔付了 15 元`→income 15、`打碎了店里的杯子，赔付了店家 60 元`→expense 60。R234 台账冲减判例（`快递 10 赔付 -35`→income 25）回归通过。
- 锁定：`test/r236-fixes.test.ts`（prompt 判例 + fixFinanceDirection 不翻转）+ `scripts/triage-eval.ts` 双语境 live eval 用例。

## 2. P2-2 UI 注销偶发 ~60s 超时 → 归因：连接级悬挂（与 R221 P1-1 同型），非级联删除慢

先归因后动手（一手证据）：

- 生产 D1 实查：threads=1、notes=6、users=1（仅 u_boss）——表量级极小，「级联删除同步耗时过长」假设不成立。
- 注销路径源码检查：R2/Vectorize 清理已在 `waitUntil` 异步（R234），同步路径只剩一次 D1 batch。
- 压测（`scripts/qa-r236-delete-stress.ts`，生产实跑）：200 条×5 轮 p50=204ms max=222ms；1000 条单轮 158ms；旧 token 全部 401。服务端级联是**百毫秒级**，挂满 60s 只能是连接级悬挂——与 audit-r221 P1-1 已归因的浏览器/网络单连接卡死同型。
- 修复（各在其责任边界，不掩盖）：
  - `web/src/lib/api.ts`：注销是幂等删除 → 与幂等 GET 同口径收紧 20s + 超时重试一次（重试若遇 401 说明首发已删成功，settings 页既有 `verifyAccountDeleted` 探测兜底）。
  - `backend/src/index.ts`：注销级联加服务端耗时打点日志，后续再报超时可直接区分 D1 慢/网络慢。
  - `backend/migrations/0028`：补 `idx_threads_user`——threads 是级联删除清单里唯一没有 user_id 索引的表，属随全站数据增长的预防性同口径补齐（非本次超时主因，证据如上）。

## 3. P2-3 Top-3 支出排序完全错误 → 归因：Top-N 无确定性路径，走 LLM 对截断召回猜排序

- 归因：单极值/序数（第N大）走 `financeExtremeIntent` 确定性 SQL 管道（`ORDER BY amount, id ASC`），但「最多的三笔/前 5 笔/topN」**不被意图识别**，落回普通召回 + LLM 生成——召回截断且模型排序不可靠，故单极值对而 Top-3 全错。
- 修复：`FinanceExtremeQuery` 加 `count`（rank 语义不变，count=1 时行为与旧完全一致），Top-N 措辞并入同一意图识别与同一 SQL 排序管道，同币种分组内 `slice(rank-1, rank-1+count)` 取行、逐名编号输出、不足 N 笔如实声明；台账合计行仍排除。
- 生产实测：`支出最多的三笔`（4200/1450/960 逐名正确）、`这个月支出最多的两笔`（时间窗×TopN 正确）、`我最贵的一笔支出`（单极值不回归）。
- 锁定：`test/r236-fixes.test.ts`（意图×收支×时间窗×排序×不足 N）+ `scripts/ask-eval-data.ts` q148/q149。

## 4. P3×8 逐条评估

| 项 | 决策 | 依据 |
|---|---|---|
| P3-1 改签差价退回判 transfer | **实施**：few-shot 判例回流（退差价=消费冲抵进账，与退款同口径） | triage-eval 用例锁定，生产复测 income 37.5 |
| P3-2 发票 OCR 判 data、amount=null | **实施**：提示词明确「发票/收据 OCR 文本是已发生交易凭证，按票面方向与金额入账」+ 判例 | triage-eval 用例（家电发票 2199→expense）生产复测通过 |
| P3-3 中文数字金额未提取 | **实施**：提示词明确中文数字换算提取 + 判例（三十八块五→38.5） | triage-eval 用例生产复测通过 |
| P3-4 「8月10号到8月20号之间」关键词提取失败 | **实施**：`parseTimeRange` 增加明确日期区间解析（含中文数字日期、跨月、单日、未来月份回退去年），`STRIP_RES` 同步剥离区间措辞，主题词提取恢复干净（咖啡豆） | 单测锁定（区间边界上海时区、bare-month 行为不变） |
| P3-5 召回未命中 5 例（同义词/聚合） | **论证不改**：5 例全部是保守拒答/如实说没找到，零幻觉（audit-r235 §4 忠实性 30 问幻觉 0）——属召回率与幻觉率的既定权衡取向（宁拒答勿虚构）。同义词召回提升需嵌入/召回策略专项调优 + 全量 eval 保护，收益（P3 级摩擦）不对称于回归风险，留召回专项轮次处理 | audit-r235 §4：均无幻觉伴随 |
| P3-6 次数推算 `10 - 3 = 7 节` 不在禁推算范围 | **部分实施**：答案金额溯源改为只认笔记标题/正文与图谱三元组（不再把格式化上下文的元数据数字当「有源」），未见于原文的算术结果一律剥除；节数类非金额推算本身是正确且有用的回答（原文含 10 节与 3 次），不禁 | 单测锁定 scrub 源收紧行为 |
| P3-7 SW 初装停滞一次 | **论证不改**：单次复现、清理浏览器 profile 后正常，audit 自身归属未定位（疑本机损坏 profile）；R178 已有安装失败终态可见性 + 重试出路 + 10s 超时自救文案，防护面完整。无稳定复现无法归因，盲改属拍脑袋 | audit-r235 §3.4；web settings SwStatusCard 既有防护 |
| P3-8 Slow 3G 首次写入进 outbox | **论证不改**：弱网先落 outbox 再后台同步是离线优先架构的既定 fail-safe（数据不丢、UI 即时反馈）；改为「先在线提交、失败再落箱」会让弱网用户白等超时且引入重复提交风险，方向性劣化。audit 亦确认数据不丢，仅体验摩擦 | audit-r235 §3.4 |

## 5. 验证与部署

- backend：`tsc --noEmit` ✅、vitest 1539+ 全绿 ✅（含新增 r236-fixes 33 例）；triage-eval 生产 141/141（few-shot 回流+兜底修复后）；ask-eval 含 holdout 生产实跑（结果见 PR）。
- web：lint ✅ build ✅；android：assembleDebug + testDebugUnitTest ✅。
- 部署：D1 migration 0028 已 apply --remote；worker 已 deploy；Pages 已 deploy --branch main。
- QA：全部 [QA-R236]/eval 临时账号注销自清，`SELECT id,name FROM users` 复核仅剩 u_boss（见 PR 证据）。
