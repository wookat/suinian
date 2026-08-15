# R138 修改轮报告（落实 R137 审查结论）

审改分离的"改"方。本文逐条记录 P1 根因一手复现与修复、3×P2 处置、3×设计建议评估、生产存量检查与压测实测结果。

## P1：千条量级重整 summarize 停滞不收敛

### 一手复现（生产实测，非转述 R137 报告）

- 新建独立 QA 账号（`[QA-R138]` 前缀，u_8745fff8d71d），导入 1000 条合成笔记并置为 `idea`。
- 在修复前的生产代码上触发重整：job 停在 `phase=cluster processed=0/1000` 超过 22 分钟无任何推进，`status=running` 永不落地——与 R137 观察到的 44+ 分钟停滞同一失败模式，复现成立。

### 根因（一手证据 + 代码定位）

R137 推断"Workers AI 调用无超时"只是一半。实测定位到两层叠加：

1. **AI 调用无超时**：`env.AI.run` 无任何超时保护；主 provider（DeepSeek）当时正在故障（wrangler tail 实录反复出现 `provider error 530 error code: 1016`），每次调用都要走完"主失败→fallback"全链路，单次耗时不可控。
2. **切片内不落 checkpoint（真正的死锁根源）**：`runRebuildJobSlice` 原来以 30 秒为内层步长，而 HTTP `waitUntil` 隔离窗口约 30 秒——切片总是在写回进度之前被杀死。每次 poll/cron 重新拉起的切片都从同一游标重做同样的工作，再次死在同一位置。于是 job 心跳看似在更新（切片开头无条件刷 `updated_at`），进度却永远是 0，`running` 永不终止。

### 修复（收敛到既有封装层，未散落）

- `backend/src/ai.ts`（provider 封装层，唯一改动点）：新增 `withTimeout`；Workers AI 调用统一 20s 超时；瞬时错误重试 1 次、超时不重试（毒丸跳过）；OpenAI 兼容路径沿用既有 abort 超时。
- `backend/src/threads.ts`：summarize 单条线索的 `chatComplete` 传 `timeout_ms: 8s`，保证"主重试+fallback"全链路能在一个切片窗口内返回；summarize 阶段逐条推进游标（`summarized/summarizeTotal` 进度可见）。
- `backend/src/thread-jobs.ts`：内层步长 30s→10s，每步后立即持久化 checkpoint（死切片最多损失一批）；切片开头不再无条件刷心跳（只做 queued→running），避免"没有进度的心跳"掩盖僵死切片；job 最大寿命 `JOB_MAX_AGE_MINUTES=120`，超龄标记 `error` 并给出可读错误文案（不能永远 running）。
- `backend/src/index.ts`：poll 时 45s 无心跳即拉起新切片（切片寿命 ~30s，45s 无心跳必然已死），僵死恢复从 2 分钟降到 45 秒。

### 修复后千条压测实测（生产环境、主 provider 故障期间的最坏条件）

- 第一轮（跨越修复部署）：同一 job 从停滞状态在修复部署后恢复推进，最终 `done`，179 线索全部 summarize，总计 68.9 分钟（其中 ~40 分钟耗在修复前的停滞段）。
- 第二轮（纯修复后代码、从零全量重建）：1000 条 → cluster 15.7 分钟 → summarize 179 线索 → `done`，全程 40.9 分钟收敛，无人工干预。
- 全程 `summarized` 进度单调推进、心跳/checkpoint 正常，未再出现停滞。
- 失败可见性生产实测：将一个 running job 的 `created_at` 回拨 3 小时后，下一次 poll 拉起切片即命中最大寿命检查，job 变为 `status=error`、错误文案「重建超过 120 分钟未完成，已终止（可重新发起）」——不再永远 running。

## 3×P2 处置

1. **outbox 瞬时失败被丢弃** → 修：`web/src/lib/outbox.ts` 网络失败/429/5xx 停止重放并保留队列，等下次 online 重试；仅确定性 4xx 丢弃。
2. **报告统计被 LIMIT 截断低估** → 修：`backend/src/reports.ts` 新增 `aggregatePeriod` SQL 聚合（分类×币种），笔记数/待办完成数/收支合计走权威 SQL 口径，LLM 摘要仍受 LIMIT 约束只影响展示。新增单测覆盖多币种、金额未知、敏感计数。
3. **敏感提示匹配与正常搜索语义不一致（tags 缺失）** → 修：`backend/src/index.ts` `KEYWORD_FIELDS` 纳入 tags，敏感提示与正常搜索字段对齐，`matchedTermCount` 同步。

## 3×设计建议评估

1. **D1 报告 cron 串行处理的时间预算/并发**：不修。当前生产只有 1 个真实用户（u_boss），串行 cron 距时间预算余量巨大；引入并发调度属"如无必要勿增实体"。留待用户量级接近百级再评估。
2. **D2 media 上传幂等**：已实现。web outbox 入队时生成 `client_id`（UUID），重放随 multipart 提交；服务端按 `meta.client_id` 去重，响应丢失后的补传返回既有笔记而不重复建笔记。改动限于既有 ingest 路径，未新增表/索引。
3. **D3 ask-eval q31 引用集不全**：评估为评测质量/引用集口径问题而非产品缺陷——q31（"我为什么想做周末快闪店"）答案正确、引用了相关笔记，只是引用集合与标注集不完全重合。DEV SET 59/60（98%）。不改产品代码；后续可在 eval 标注侧放宽引用集合判定。

## 生产存量检查

- 修复部署前查询生产 D1 `thread_jobs`：无卡死 `running` 残留（0 条），无需清理。
- QA 压测账号及其全部数据在测试完成后注销，逐表验证清零。

## 回归

- backend：typecheck ✓，单测 67 文件 727+ 全过 ✓，ask-eval DEV SET 59/60（98%，唯一失败即 D3 已知项）✓
- web：lint ✓（仅存量 Fast Refresh warning）、build ✓
- QA 全链路 + 失败可见性 + 录屏：见 PR 附件。
