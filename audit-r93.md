# R93 独立审查报告（审改分离 · 只审不改）

- 审查日期：2026-08-13 · 环境：生产 https://suinian.zalize.com / https://suinian-api.zalize.com · 仓库 main @ bd313ad（含 R92 #108）
- QA 账号：`[QA-R93]-api`（API 侧，u_95845c3c86b7）与 `[QA-R93]-ui`（UI 侧）；全部写入带 `[QA-R93]` 前缀，收尾均已注销并 D1 逐表核对自清（见文末）
- 仓库门禁（本地实跑）：backend `tsc --noEmit` 通过、vitest **494/494** 通过；web `npm run build` 通过
- UI 侧完整发现清单见同轮 `qa-report-r93-ui.md`（测试代理产出，含全部截图路径）；本文为汇总定级

## 结论一句话
**发现 1 个 P0：生产 AI 分拣管线全断（DeepSeek 余额耗尽），核心主线「AI 自动整理」不可用**；API 层性能优秀、非 AI 路径全部健康、Lighthouse 桌面满分。AI 效果抽查整体被 P0 阻断，充值后需补测一轮。

## P0

### P0-1 生产 AI 分拣全断：所有新笔记永久卡「AI 分拣中…」【影响核心主线：是】
- 复现：任意提交笔记，30 分钟+ 后仍无分类/标签/失败提示；本轮 API 侧 19 条 + UI 侧 13 条全部 `category=null`（截图 `/home/ubuntu/screenshots/ss_6a6ee09f.png`）
- 服务端证据：`wrangler tail suinian-api` 每次 POST /api/notes 后输出 `graph: chatComplete returned null`
- 根因（一手验证，非推断）：直调 `api.deepseek.com/chat/completions`，密钥库两个 DeepSeek key 均返回 `{"error":{"message":"Insufficient Balance"}}`——DeepSeek 账户余额耗尽；生产 worker 走 `DEEPSEEK_BASE_URL=https://api.deepseek.com`（wrangler.toml:35），大概率同一账户
- 连锁阻断：AI 分拣/打标、待办 due 提取、敏感遮罩判定、问答 LLM 直答、线索聚类、周报/月报/今日回顾/洞察内容
- 改进方向：**老板充值 DeepSeek**（或把 `AI_BASE_URL` 切到 api.aicdks.com 中转站一 key 多模型互备）；中期韧性见 P1-1

## P1

### P1-1 AI 单点依赖、无降级、无告警：故障静默直至人肉发现【影响核心主线：是（放大 P0 时长）】
- `backend/src/ai.ts`：单一供应商，chatComplete 失败仅 console.error 返回 null
- 兜底 cron（backend/src/index.ts ≈L2898）`if (triaged === 0) break`——AI 全断时直接放弃，笔记无限期 pending，无「失败 N 次后落 FALLBACK_TRIAGE + 标记待重分拣」的降级
- `/health` 只返回静态 `{ok:true}`，探测不到 AI 供应商故障，外部监控形同虚设
- 前端「AI 分拣中…」无超时、无失败态（UI 缺陷，独立成立）
- 改进方向：① `/health` 增加 ai probe 子检查 + UptimeRobot 告警；② 重分拣连续失败达阈值时降级 FALLBACK_TRIAGE 并打 `needs_retriage` 标记，恢复后自动重分拣；③ 前端 pending 超阈值显示「分拣延迟中/失败，点此重试」
- 正面对照：ask 链路已有诚实降级（AI 不可用返回「（AI 暂不可用）已找到相关记录」+ 引用，实测 0.8s/200）——分拣链路应对齐同等韧性

### P1-2 删除确认文案与实际行为矛盾
- 卡片删除 confirm 称「删除后无法恢复」，实际进「最近删除」保留 30 天可恢复（实测恢复成功）。文案吓退用户。截图 `ss_127a2289.png`
- 改进：统一为「移入最近删除，30 天内可恢复」。影响核心主线：否

### P1-3 注销账号用原生 prompt，输入法兼容差
- 键盘直接键入「注销」未被原生 prompt 接收（「输入不匹配，已取消注销」，截图 `ss_3c56d73d.png`），需 console stub 才能完成。中文输入法用户可能真实踩中
- 改进：危险操作改应用内自绘对话框（与其余确认框统一）。影响核心主线：否

## P2

### P2-1 backend/src/index.ts 2938 行 55 路由单文件 + worker 入口导出测试常量
- 业务模块拆分整体不错（threads/graph/backup/import 等已独立），但路由层全堆一处；且入口导出 `RETRIAGE_TIME_BUDGET_MS` 等常量导致 wrangler dev 4.119.x 本地启动崩溃（`.agents/skills/testing-local-dev` 已记载 workaround）——应把常量移到 constants.ts。可维护性债，不影响核心主线

### P2-2 web 页面级巨石文件：settings.tsx 1403 行 / timeline.tsx 1285 行 / note-card.tsx 840 行
- settings 页承载 连接/外观/标签管理/推送/微信绑定/导出/备份/导入/恢复/危险操作 十类职责；timeline 混合 速记/筛选/多选/问答面板/今日回顾。建议分区组件化 + 页内锚点

### P2-3 搜索召回 = LIKE + D1 全表暴力余弦：个人量级 OK，万条级隐患
- 当前实测 130-140ms 无压力；量级上去需 FTS5/Vectorize。挂账观察即可（如无必要勿增实体），不建议现在动

## 设计建议（信息架构 · 系统论视角）

- **D-1 「回顾类」实体偏多，可合并**：今日回顾（timeline 内嵌）/ 周报 / 月报 / 洞察（热力图+随机漫步）/ 线索——五个「帮你回头看」的实体散在 3 个导航入口。建议周报+月报+今日回顾合并为「回顾」一页（日/周/月 tab），随机漫步并入回顾；导航 6 项收敛到 5 项（移动端底部导航 6 项已到可用性上限）
- **D-2 问答入口层级偏低**：作为「可靠找回」主线支柱之一，问答藏在时间流工具条按钮里；建议提升为搜索框统一入口（输入即搜、`?` 即问）
- **D-3 设置页高低频未分层**：外观/标签（高频）与备份恢复/危险操作（低频）平铺堆叠（同 P2-2）
- **D-UI-1~3**：分拣失败态、删除文案统一、危险操作自绘弹窗（见 P1 与 qa-report-r93-ui.md）

## 性能实测（生产，2026-08-13）

| 端点 | 时延 | 状态 |
|---|---|---|
| POST /api/notes 写入 ×5 | 0.17–0.20s | 201 |
| GET /api/notes?limit=20 时间流 ×3 | 0.13–0.14s | 200 |
| GET /api/notes?q=… 搜索 ×3 | 0.13–0.14s | 200 |
| POST /api/ask（降级路径） | 0.13–0.80s | 200 |
| POST /api/notes/batch add/remove_tags（5条） | 0.18s | 200（R89 观察的 40–60s 慢批未复现） |
| GET /api/export?format=md · /api/threads · /api/stats · /api/review/today | 0.13–0.32s | 200 |

- Lighthouse 首页：桌面 **100/100/100/100**，移动 **95/100/100/100**
- AI 管线端到端时延：本轮不可测（P0-1）

## 功能与视觉走查结果（详见 qa-report-r93-ui.md）
- 通过：注册/登录、速记写入、关键词搜索召回（5/5 命中）、单删→回收站→恢复、批量加/移标签、导出、断网提交内容保留+重试、深色主题全页面、375px/768px 响应式、注销全流程
- 失败/阻断（全部归因 P0-1）：AI 分拣与标签、待办提取、敏感遮罩、问答直答、线索生成、周报/回顾/洞察内容

## 效果抽查
- 被 P0-1 阻断：分拣 0/19 完成、问答 LLM 全走降级、线索无法新聚——标记 **blocked**，充值后按「分拣 20 条多样输入 / 问答 10 问含边界 / 线索聚类合理性」补测一轮
- 已验证非 AI 路径：关键词搜索准确；ask 降级不瞎编（诚实返回引用）

## 本轮三环节评分（上轮 4.9 / 4.9 / 4.9）

| 环节 | 评分 | 依据 |
|---|---|---|
| 什么都能丢（记录） | **4.7** | 写入快（<0.2s）、断网不丢、边界处理好；扣分：pending 无失败态（P1-1 前端面） |
| AI 自动整理 | **1.0** | 生产全断（P0-1），本轮完全不可用；架构本身无回归迹象，纯供应商余额+韧性缺失 |
| 可靠找回（搜索/问答/回顾） | **3.5** | 关键词/语义搜索健康、ask 诚实降级；但 LLM 直答/线索/回顾内容全阻断 |

## 收尾自清（强制核对）
- `[QA-R93]-ui`：设置页注销完成，原凭据登录被拒（截图 `ss_43d64c71.png`）
- `[QA-R93]-api`：`DELETE /api/auth/me` 返回 `{"ok":true}`，token 立即 401
- D1 remote 逐表核对（account.ts USER_ID_TABLES 全 14 表按 user_id）：**全部 0 行**；attachments/note_embeddings 孤儿行 0
- 全量 `SELECT id,name FROM users` → 仅 `[{"id":"u_boss","name":"Thomas"}]`。u_boss 全程未触碰

## 等老板事项
1. **DeepSeek 账户充值**（P0-1 唯一即时解法；或授权切 AI_BASE_URL 到 api.aicdks.com）
2. 顺带提醒：api.aicdks.com 管理台 root / aicdks 两账号密码均已失效（本轮排查时无法登录，提示用户名或密码错误），如需继续用中转站请重置并更新密钥库
