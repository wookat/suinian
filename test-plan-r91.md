# Suinian R91 全量线上评审测试计划（只测不改）

环境：生产 https://suinian.zalize.com / https://suinian-api.zalize.com。OS 时区已设 Asia/Shanghai。d1 remote 访问已验证（CLOUDFLARE_API_TOKEN=$CLOUDFLARE_WORKERS_API_TOKEN）。
账号：QA-A = `[QA-R91]-main`，QA-B = `[QA-R91]-iso`，密码各自记录（QaR91!main / QaR91!iso）。绝不动 u_boss。所有内容加 `[QA-R91]` 前缀。测完两账号均通过设置页注销（DELETE /api/auth/me）。

预发现：users 表现存遗留账号 `[QA-R88]-repro`（u_92fd58fe55a9）——报告中列为数据健康问题（P1），按 account.ts 口径用 d1 级联清理并留前后 SQL 证据。

## T1 首次体验 + 首条保存反馈（QA-A 注册视角）
- 注册 QA-A，观察引导/tour；首条笔记「[QA-R91] 买了 3 台服务器共花费 24680 元」保存后应有明确保存反馈（toast/状态），AI 分拣徽标数秒内出现。PASS=可见保存反馈+分拣结果。

## T2 待办时区（R88）
- 速记「[QA-R91] 明天下午3点提醒我给王工回电话」→ 应分拣为待办，due 时间显示为本地（Asia/Shanghai）明天 15:00（±解析口径）。PASS=UI 显示的提醒时间是明天 15:00 而非 07:00（UTC 偏移错则 FAIL）。
- 时间流 dayLabel/笔记时间戳应显示今天本地日期与当前 CST 时间（新建笔记时间戳 ≈ 当前 06:xx-07:xx CST）。

## T3 连发不丢（R88）
- 速记框快速连发 10 条 `[QA-R91] burst-01..10`（每条提交即清空）。刷新后时间流应有全部 10 条；d1 `SELECT COUNT(*) FROM notes WHERE user_id=<QA-A> AND content LIKE '%burst-%'` = 10。

## T4 问答 /ask（R88 数字直给 + 诚实没找到）
- 问「我买服务器一共花了多少钱？」→ 答案直给 24680，不 hedge，无 internal error。
- 问「我有几台服务器？」→ 答 3 台。
- 问无关问题「我的猫叫什么名字？」→ 诚实「没找到」类回答，非编造。
- 搜索框搜「burst-03」→ 有结果反馈；搜「zzz不存在xyz」→ 明确无结果反馈。

## T5 批量操作性能 + 持久化撤销（R90 核心）
- 多选 ≥10 条（burst 10 条），批量加标签 `qa批量`：观察完成耗时（DevTools Network 或界面进度），完成后时间流顶部出现**驻留撤销条**（不随 6s 消失；等 10s 确认仍在）。PASS=撤销条 >10s 仍可见。
- 刷新页面 → 撤销条仍在（localStorage `suinian:pending-undo` 持久化）。点「撤销」→ toast「已撤销：从 N 条移除 #qa批量」，笔记标签移除。
- 再批量加 `qa批量2`，然后多选同批做「移除标签」`qa批量2`（R89 新入口）→ 移除成功且出现驻留撤销条，点撤销补回标签。
- 标签污染回归：检查 AI 分拣未把已有标签硬套到无关新笔记（burst 笔记标签各自合理）。

## T6 问答历史跨账号隔离（R89）
- QA-A 在 /ask 留下历史后登出；同浏览器注册/登录 QA-B → ask 页历史为空（不出现 QA-A 的问答）。切回 QA-A 历史仍在。

## T7 安全抽查
- QA-A 记一条笔记 id（d1 或 URL）；用 QA-B 的 token 调 `GET /api/notes/<idA>`（QA-B 是 API 直连场景，允许 curl）→ 应 404/403。
- QA-A 建敏感笔记（标记敏感）：列表遮罩、搜索不露正文、ask 不召回正文、图谱无派生。PASS=各处均遮罩/隔离。

## T8 全产品走查 + Lighthouse
- 走查记录/整理/找回三环节（待办、线索、图谱、今日回顾、周报、回收站、设置），记录摩擦点，各打分（上轮 4.8/4.9/4.8）+ 首次体验评分。
- `npx lighthouse https://suinian.zalize.com --preset=desktop` 记录四项分数。

## T9 注销级联 + 数据健康（收尾，shell）
- QA-B、QA-A 依次设置页注销（输入「注销」确认，用 xclip 粘贴）。
- d1 验证：users 表无 QA-R91 账号；notes/attachments/note_embeddings/threads/user_preferences/daily_reviews/weekly_reports/entities/edges/push_* 等按 USER_ID_TABLES/NOTE_ID_TABLES 口径 count=0（按已删 user_id 查）。
- 清理遗留 `[QA-R88]-repro`（u_92fd58fe55a9）级联删除，前后 SQL 证据；最终 users 只剩 u_boss。

产出：录屏（T1-T8 UI 部分，带注解）+ 截图 + P0/P1/P2 报告 /home/ubuntu/repos/suinian/qa-report-r91.md（PASS/FAIL、评分、Lighthouse）。
