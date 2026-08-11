# R92 生产环境专项 QA 报告

- 分支：`devin/1786489577-r92`，PR：https://github.com/wookat/suinian/pull/108
- 环境：生产 Web https://suinian.zalize.com / API https://suinian-api.zalize.com（`/health` ok）
- QA 账号：`[QA-R92]-sensitive`（`u_8772624cda37`），测试结束已通过设置页「注销账号」删除，D1 验证自清完成
- 语料：102 条混合笔记（想法/待办/收藏/资料/记账/收入，跨 10+ 主题），其中 12 条敏感（编造的假密码 / API key / GitHub token / AWS key / 身份证号 / 银行卡号 / 手机+密码），全部 triage 完成且 `is_sensitive=1`
- 派生触发：`POST /api/admin/reconcile-threads`（ok, deleted 0 dissolved 0）、`POST /api/admin/run-daily-reviews`（ok, generated 1）+ 等待生产 */10 cron 数轮
- 派生规模（阳性对照）：note_embeddings 90、edges 225、entities 130、threads 7 —— 管道确实在工作，隔离结果不是"什么都没生成"的假阴性

## 结论：未发现任何泄漏（无 P0）。全部 8 个隔离面 PASS，UI 小验证 PASS，自清 PASS。

## T1 敏感隔离验证点（对 12 个敏感 marker 逐一 grep）

| # | 验证面 | 结果 | 证据 |
|---|--------|------|------|
| 1 | 图谱实体/关系 | PASS | D1：`edges` 关联敏感 note_id = 0；`entities`/`edges` 全行 grep marker 0 命中。线索详情图谱 UI 截图 `ss_bc90b12c.png`。注：`/api/graph` 路由不存在（404），图谱数据经线索详情 API/UI 验证 |
| 2 | 线索 threads | PASS | D1：敏感笔记归属 thread = 0；`GET /api/threads` + 7 个线索详情响应 grep 0 命中；UI 截图 `ss_3b43754a.png` |
| 3 | 每日回顾 | PASS | D1：`daily_reviews` 引用敏感 note_id = 0；`GET /api/review/today` grep 0 命中；UI 截图 `ss_zoom_d78d95b8.png` |
| 4 | 周报 | PASS | 周报生成成功，UI 明示「其中 12 条为敏感记录，已计入以上计数但未提供内容」；content_md grep 0 命中；截图 `ss_4f4f5158.png`。月报：本轮未生成月报周期，未覆盖（untested） |
| 5 | 洞察/统计 | PASS | 洞察页 UI + `/api/stats` 响应 grep 0 命中；截图 `ss_43a28e6c.png`。注：`/api/insights` 路由不存在，洞察数据经 stats 端点验证 |
| 6 | 问答上下文与引用 | PASS | 问「服务器 root 密码」→ 未找到相关笔记，引用仅普通迁移待办（`ss_9b156a3a.png`）；问「银行卡号/身份证号」→ 拒答，引用 3 条普通支出笔记（`ss_78dc8c83.png`）；后端问答检索 SQL 硬过滤 `is_sensitive = 0` |
| 7 | 嵌入 | PASS | D1：`note_embeddings` 中敏感 note_id = 0 行；非敏感 90 条均有向量（阳性对照成立） |
| 8 | 默认导出 | PASS | `GET /api/backup`（不带 include_sensitive）解压 grep：12 条敏感笔记 content/title 均为 `[已加密内容]`、tags=[]，marker 全 zip 0 命中；90 条普通笔记明文保留（排除全打码假阳性） |
| + | 静置加密 | PASS | D1：12 条敏感行 `content='[加密内容]'` 且 `content_enc IS NOT NULL` |

## T2 注册页密码不一致内联提示

- PASS：不同密码提交后，两个密码框红框（border-destructive），确认密码框下出现内联红字「两次输入的密码不一致，请重新输入」（带警示图标）。截图 `ss_7e5df5fc.png` / 放大 `ss_zoom_792cc457.png`
- PASS：修改任一密码输入后红框与提示立即清除（无需提交）。截图 `ss_zoom_f2b7b6fa.png`

## 收尾自清审计

- 注销经设置页危险操作完成（确认输入「注销」）。注：测试环境下浏览器自动化会拦截原生 confirm/prompt 弹窗，QA 通过 console stub 提供确认值触发同一 UI 按钮 handler；生产用户路径逻辑未改动
- D1 逐表核对（account.ts USER_ID_TABLES 全部 14 表按 user_id，NOTE_ID_TABLES 2 表按 102 个 QA note_id）：全部 0 行
- 最终 `SELECT id,name FROM users` → 仅 `[{"id":"u_boss","name":"Thomas"}]`。u_boss 数据全程未触碰

## 证据文件

- 录屏与关键截图：见会话附件与 PR #108 的 QA 评论（含注册页提示、线索/图谱/洞察/周报/问答/回顾各面截图）

## 备注 / 未覆盖

- 月报未覆盖（生产尚无月报周期数据），周报已完整验证
- `/api/graph`、`/api/insights` 非实际生产路由（404），对应功能经线索详情与 stats 验证
- 备份 zip UI「下载完整备份」按钮点击后未在 ~/Downloads 落盘（自动化浏览器下载行为），改用同一 `GET /api/backup` 端点验证，结果等价
