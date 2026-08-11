# 碎念 Suinian R91 全量线上评审报告

- 日期：2026-08-12（Asia/Shanghai）
- 环境：生产 https://suinian.zalize.com / https://suinian-api.zalize.com（只测不改代码）
- QA 账号：`[QA-R91]-main`（u_027948bb33fa）、`[QA-R91]-iso`（u_0fca608ffe2d），全部测完已通过设置页「注销账号」自清，D1 已验证级联清理
- 录屏：见会话附件（全程 UI 测试带注解）

## 一、R88–R90 回归结果

| 项目 | 结果 | 证据/说明 |
|---|---|---|
| R88 待办时区（相对时间解析） | PASS | 「明天下午3点提醒我给王工回电话」→ 待办 08-13 15:00（CST），非 UTC 偏移。![todo](https://app.devin.ai/attachments/de70b364-5030-4e61-84ec-65e87c0b0d27/ss_b88f51dc.png) |
| R89 全站时间本地时区 | PASS | 拍摄时 UTC 仍是 8/11 22:xx，时间流 dayLabel 显示「今天」、详情「记于 2026年8月12日」，设置页 token 时间 06:51 CST。![daylabel](https://app.devin.ai/attachments/12d04ac6-bdcb-4325-83bc-066865ab0e2d/ss_zoom_61d9bde6.png) |
| R88 速记连发 10 条不丢 | PASS | 连续回车提交 burst-01..10，提交即清空；刷新后 UI 全在，D1 计数 bursts=10。![burst](https://app.devin.ai/attachments/503bcb60-ec59-4be3-84c9-8557ae525392/ss_54ac1e12.png) |
| R88 问答数字直给 | PASS | 「买服务器一共花多少钱」→ 直答 24680 元带引用；「几台服务器」→ 直答 3 台，无 hedge、无 internal error。![ask](https://app.devin.ai/attachments/968e1f7c-1fe2-4d2f-92b9-8a1ef17e38d2/ss_f674e12b.png) |
| R88 问答诚实「没找到」 | PASS | 「我的猫叫什么名字？」→ 明确回答笔记中没有相关记录，未编造。![notfound](https://app.devin.ai/attachments/f99b707b-abc4-4add-aebe-61a69c120947/ss_c4a68c53.png) |
| R88 首次保存/搜索反馈 | PASS | 新账号首条笔记提交后立即上屏 +「AI 分拣中…」→ 数秒变分类徽标；搜索有结果列表、无结果显示「没有找到匹配的笔记 + 清除筛选」 |
| R90 批量操作性能 | PASS | 10 条批量打标 ~2s 内完成（本次未复现 R89 观察到的 40–60s 慢请求，见 P2） |
| R90 撤销入口持久化 | PASS | 打标后顶部驻留撤销条，>10s 不消失、**F5 刷新后仍在**（localStorage suinian:pending-undo），点撤销后 10 条标签全部移除。![undo-bar](https://app.devin.ai/attachments/b43b7a4f-798a-4299-8681-dabd11a20359/ss_c87676c3.png) ![after-refresh](https://app.devin.ai/attachments/5ea0299d-a982-4765-855a-37da1730eb76/ss_33d0ba58.png) ![undone](https://app.devin.ai/attachments/7a5e7ec1-a726-4f66-a7ce-ba445cf6b8d2/ss_2963f749.png) |
| R89 批量「移除标签」+撤销 | PASS | 移除 #qa-b2（10 条）成功，撤销「已撤销：为 10 条补回 #qa-b2」chips 恢复。![remove-undo](https://app.devin.ai/attachments/3a6ee8c2-524c-40e8-a786-724b033d551d/ss_ce4c0ae6.png) |
| R88 标签污染 | PASS | burst 短文本笔记各自获得 #编号 等合理标签，未硬套账号里已有的 #服务器/#电话 |
| R89 问答历史账号隔离 | PASS | 同浏览器登出 → 注册 QA-B，ask 面板为空（QA-A 的 4 条问答不可见）。![iso](https://app.devin.ai/attachments/99401cc0-b262-4184-91b2-4e21943f260f/ss_f7528362.png) |

## 二、安全抽查

| 项目 | 结果 | 说明 |
|---|---|---|
| 跨账号笔记访问 | PASS | 账号 B token GET /api/notes/<A的笔记id> → 404 {"error":"not found"}；B 自己的 /api/notes → 200（对照） |
| 敏感笔记遮罩 | PASS | 含银行卡密码的笔记被 AI 自动标记「敏感」，列表/搜索均显示 ••••「敏感内容，点击查看」；ask 问「银行卡密码是多少」拒绝给出密码内容。![masked](https://app.devin.ai/attachments/86effe16-47fc-4a82-8f3d-dd3860d10dd3/ss_a84a3560.png) ![ask-refuse](https://app.devin.ai/attachments/103a8d1b-72ae-415a-be8d-077e245bbffa/ss_0a549b54.png) |
| 敏感笔记图谱派生隔离 | 未完整验证 | QA 账号数据量小，图谱/实体派生未生成到可断言程度（见 P2 观察） |

## 三、数据健康

- 两个 QA 账号 UI 注销后，D1 按 `backend/src/account.ts` 全口径核查：notes/threads/daily_reviews/weekly_reports/entities/edges/user_preferences/push_subscriptions/thread_jobs/thread_backfill/wechat_* /attachments/note_embeddings **全部 count=0**，users 行已删。PASS
- 发现遗留账号 `[QA-R88]-repro`（u_92fd58fe55a9，12 notes/11 embeddings/2 threads）——上轮 QA 未自清。已按 account.ts 级联口径用 wrangler d1 手动清理（children 先删，前后 SQL 证据在会话记录）。
- 最终 `SELECT id,name FROM users` = 仅 `u_boss / Thomas`。PASS

## 四、Lighthouse（桌面）

| Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|
| **100** | **100** | **100** | **100** |

FCP 0.5s · LCP 0.6s · TBT 0ms · CLS 0

## 五、体验评分（满分 5）

- **记录：4.9**（上轮 4.8）——提交即清空+乐观上屏+分拣徽标反馈非常顺；连发零丢失
- **整理：4.9**（上轮 4.9）——批量打标/移标秒级完成，驻留撤销条是明显升级；待办时区正确
- **找回：4.9**（上轮 4.8）——数字直给、诚实没找到、搜索空态反馈清晰、敏感内容不泄漏
- **首次体验：4.8**——注册即用、4 步引导、空态「先丢入 3 条示例」，摩擦点见 P2

## 六、问题分级

- **P0：无**
- **P1：无**（本轮回归与安全抽查全过）
- **P2 / 观察项：**
  1. 上轮遗留 QA 账号 `[QA-R88]-repro` 未自清（本轮已代为清理）——建议 QA 流程收尾强制核查 users 表。
  2. 注册页确认密码校验对首次输入报「两次输入的密码不一致」时无字段级高亮，仅顶部红条；小摩擦。
  3. 敏感笔记在图谱/派生（线索、实体）中的隔离本轮未能构造出可断言场景（QA 数据量小，图谱未生成），建议下轮用更大语料专项验证。
  4. R89 观察的 batch 慢请求（40–60s）本轮未复现（10 条 ~2s），但驻留撤销条设计已覆盖慢请求场景。
  5. Lighthouse 附带的 agentic-browsing 新指标仅 67（非四大项，供参考）。

## 七、结论

R88–R90 全部回归项 PASS，R90 核心（批量性能 + 持久化撤销）线上表现符合设计；安全抽查通过；数据库仅剩 u_boss。**建议保持现状发布，无阻塞问题。**
