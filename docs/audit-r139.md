# R139 独立审查报告（审改分离 · 只审不改）

- 审查对象：生产环境 https://suinian.zalize.com / https://suinian-api.zalize.com
- 基线：main @ 549acbd（R138 #160 合入后）
- 审查方式：生产 API 实测、远程 D1 只读查询、源码核对、独立 QA 账号（[QA-R139] 前缀，测毕注销自清）、浏览器 UI 实测（附录屏+截图）
- u_boss：仅只读（API 未持有其 token，一律走 D1 只读 SELECT），全程零写入
- 结论先行：核心主线「什么都能丢→AI 整理→可靠找回」整体成立；本轮发现 1×P1（敏感识别缺口）、3×P2、2 个设计问题。无 P0。

## 一、R138 复核：千条重整收敛（独立复测）

### 1.1 千条全量重建（生产实测，全新账号）
- QA 账号 `[QA-R139]-scale`（u_4c8404862a7c），bulk import 导入 1000 条想法类笔记（生成语料，非真实用户数据）。
- 触发 `POST /api/threads/rebuild` → job `aee718df-5cf3-40fb-a9cf-09969ad1bc31`，全程 15s/60s 间隔轮询 `GET /api/threads/rebuild/latest`。
- 观测（见 QA 侧 rebuild-watch 日志，节选）：
  - cluster 阶段 processed 在全部轮询样本中单调递增（6→1000），无一次倒退；观测窗口内未见停滞（R138 之前的 checkpoint 死锁/回退未复现）。
  - 单个 HTTP 切片寿命有限，进度跨越 42 分钟持续推进，证明「切片续跑 + checkpoint 恢复」机制在生产真实生效（等价于 Worker 实例更替后的恢复路径）。
  - 终态：status=done，1000/1000 processed，summarize 153/153，threads=153，总耗时 2538s（≈42.3 分钟），error=null（完整 JSON 见附录 A）。
- 判定：R138 千条收敛修复在生产独立复测下成立。
- 附带观察：153 条线索中存在同题分裂（如「跑步姿势与配速」出现 3 条独立线索，7/2/4 条笔记），聚类粒度偏碎，属质量观察非回归。

### 1.2 并发触发 / 限流
- 重建进行中再次 `POST /api/threads/rebuild`：返回 200 + 同一 job（复用 active job，不重复起任务）✅
- 连续快速触发：命中 `thread_rebuild` 限流（THREAD_REBUILD_RATE_LIMIT_MAX=2/分钟），429 +「重建太频繁了，请稍等一分钟再试」✅

### 1.3 中途取消 / Worker 重启 / 失败可见
- 中途取消：后端不存在任何取消端点（全库 grep 无 cancel 路由），Web 端也无取消按钮。用户一旦触发千条级重建（本轮实测 42 分钟），只能等它跑完或等 120 分钟寿命上限强杀。→ 设计问题 D-2。
- Worker 重启恢复：代码路径为 `kickStaleJob`（GET latest 时对 queued/45s 无心跳 running 补踢）+ cron `resumeThreadJobs`。生产侧证据：千条 job 跨多个切片持续推进（1.1）；显式 kill Worker 实例无法从外部黑盒操作，未单独实测，标注为「代码+间接证据」。
- 失败可见：`thread_jobs` 全表历史无 error 行（生产至今只有 3 个 job），无法在生产观察真实失败展示；代码路径（超 120 分钟置 error=「重建超过 120 分钟未完成，已终止（可重新发起）」+ 前端 error 分支渲染）有 r138-job-max-age 单测覆盖。标注为「代码+单测验证，生产未观察到」。

### 1.4 千条重建终态
- 见「附录 A：千条重建终态记录」（实测终态 JSON 与总耗时）。

## 二、R137 未验证项补测（重点）

### 2.1 R2 对象级越权（附件原件）—— 通过 ✅
两个独立 QA 账号（[QA-R139]-a / -b），a 上传附件后：
| 请求 | 结果 |
|---|---|
| owner token → `GET /api/notes/:id/file` | 200，返回原件字节 |
| 他人 token → 同一 URL | 404 `{"error":"not found"}`（note 按 `id AND user_id` 查询，天然隔离） |
| 无 token | 401 `{"error":"unauthorized"}` |
| R2 managed 域名直连（r2.dev） | 401（public access 关闭） |
判定：对象级授权无越权面；R2 不暴露公共读取。R137 遗留项关闭。

### 2.2 API 轻量 DoS / 滥用压力 —— 通过 ✅（分两层）
- Cloudflare edge：非浏览器 UA（python-requests 默认 UA）直接 403 error 1010，脚本首先被边缘规则拦截。
- API 层 D1 限流（换 Chrome UA 绕过 edge 后实测）：
  - 笔记写入 burst：60/分钟后稳定 429；
  - /api/ask burst：命中配置上限 429；
  - bulk import：3/分钟后 429；
  - 登录爆破：同账号连续错误密码 5 次后 429（按 IP+账号双维度）；
  - 重建并发：复用 active job + 2/分钟限流（见 1.2）。
- `checkRateLimit` 为原子 UPSERT（`ON CONFLICT ... RETURNING count`），无读改写竞态；limiter 故障时 fail-closed（返回 false）。
判定：脚本滥用在 edge 和 API 双层均被真实挡住。R137 遗留项关闭。

## 三、老板真实旅程（u_boss 只读 + 镜像账号 UI 实测）

### 3.1 u_boss 数据只读检查（D1 SELECT，零写入）
- 6 条笔记：4 条非敏感分拣/标签正确，2 条敏感均密文存储（D1 中为密文，不可反查）；1 条 AI/产品主题线索；周报/月报、embeddings、graph 行均存在且 user_id 隔离正确。
- 每日回顾（daily_reviews 实表）：08-08~08-15 每天 1 条、全部 kind=revisit，且 同一条笔记（05719970…）在 08-10/12/13/14 五天内被选中 4 次。根因见 D-1（降级选材无 30 天排重）。这是老板每天真实看到的重复体验。
- thread_jobs 全表仅 3 行（本轮 QA 产生），u_boss 从未触发过重建 → 线索页「重建」入口对真实老板是未被发现/未被需要的功能，或入口不显眼。

### 3.2 镜像账号 UI 旅程（[QA-R139]-boss-mirror，语义等价的 7 条笔记；见录屏）
通过：
- 时间流分拣正确：待办抓到「周五」=08-21 截止日；链接笔记出标题+摘要卡片；明确密码文本被判敏感并加密脱敏（••••，点击查看）；
- 待办页按期限分组正确；周报手动生成结构完整、计数准确、敏感条仅计数不展示内容；
- 问答失败可见可重试：追问超时后展示「请求超时，请重试」+ 重试按钮，重试后返回正确引用答案。
发现的问题：
- 【P1】带空格银行卡号「6222 0000 1111 2222」未被判敏感：首页时间流明文展示、标签云生成 #银行卡、问答引用卡片中原文可见。根因：LLM 判敏未命中时，兜底正则 `BANK_CARD_RE = /(银行卡|卡号|储蓄卡|信用卡)[^\n]{0,10}\d{12,19}\b/` 要求连续 12-19 位数字，而人们抄卡号的常见格式恰是 4-4-4-4 带空格。影响核心主线的信任基础（「什么都能丢」的前提是丢进去的秘密不会漏）。
- 【P2】问答意图误路由：「我记过哪些关于 AI 创业的想法？」被 `enumListIntent` 正则（`记[了过](?:些|哪些)`）在 LLM 主题分类之前劫持为无主题全量枚举，回答罗列全部 7 条笔记（含银行卡/密码占位条目），答非所问且扩大暴露面。对照实测：「AI 相关的记录都有哪些」正确路由 topic=AI；「列一下我记的 AI 创业相关想法」「我对 AI 创业有什么想法」均正常。规则优先于 LLM 的顺序 + 规则过宽是根因。
- 【P2】问答追问偶发 3 分钟才报超时：UI 等待约 180s 才显示「请求超时」，同一问题+history 用 curl 3.2s 返回 200。失败可见性没问题（有重试按钮），但超时阈值明显过长，用户会以为卡死。
- 【P2】空线索页「重建线索」按钮无完成反馈：小语料（3 条想法）下 job 1 秒完成、0 线索，界面无任何提示地回到同一空状态，两次点击看起来像按钮失灵（D1 证实 job 已创建并 done）。应在完成后给出「已重建，仍未聚成线索」类反馈。

### 3.3 新用户 tour → 重度使用断层
- 新账号首屏演示数据 + 引导切换真实 API 的路径清晰；空线索页文案诚实（「第一周线索少是正常的」）。
- 断层点：a) 演示模式→真实 API 的切换埋在设置页，首次真实记录的转化路径长；b) 重建入口只在空线索页/线索页，老板 6 条真实笔记用了数月从未触发过一次重建（3.1）；c) 长任务（千条重建）无取消、无耗时预期提示，重度用户导入历史数据后会面对 40+ 分钟的黑盒等待（仅有进度条）。

## 四、全端文案与状态一致性 —— 通过 ✅
- `/health?probe=ai`：`{"ok":true,"provider":"fallback","model":"workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast"}`。`fallback` 是 provider 链第二层的语义（Workers AI 正常应答），与 README「Workers AI 主力、外部 DeepSeek 可选」的口径一致，非故障。
- 微信入口：`GET /api/wechat/status` 全 false（configured/bound/kf_* 均 false），`POST /api/wechat/bind-code` 404，与 README/设置页「线上版微信通道即将上线、自部署 bridge 可用」的表述一致，无虚假承诺。
- 设置页承诺（敏感默认脱敏、导出完整备份、注销永久删除）与实测行为一致（注销级联清理见第六节）。

## 五、设计质疑（2 个未审流程深挖）

### D-1 每日回顾的选材与重复（有生产实证）
- 现状：年/月纪念 → 主题/待办按日期奇偶轮换 → revisit 随机（30 天排重）→ 降级 relaxedCandidates（任意 1 天前笔记随机取 1，无任何排重）。
- 实证：u_boss 小语料下严格 revisit 池为空，天天落入降级路径，同一条笔记 5 天被推 4 次（3.1）。「回顾」变成「复读机」，恰恰伤害的是最该被留住的种子重度用户。
- 是否真的最适合？不是。建议：降级路径同样带 30 天（或至少 7 天）排重，排重后无候选宁可当天空着（现有 outcome=empty 路径已支持空态）；奇偶轮换可换成「上次展示 kind 之外优先」，避免小语料用户永远看不到主题/待办类洞察。

### D-2 重建任务不可取消、无耗时预期
- 现状：只有创建/查询端点；取消语义完全缺失。千条重建实测 42 分钟，期间用户只能看进度条；唯一的「停止」是 120 分钟寿命上限强杀（error 文案面向超时而非用户意愿）。
- 是否真的最适合？对小语料（秒级完成）够用；对导入历史数据的重度用户是黑盒。建议（低成本优先）：a) 前端按 total 给出量级预期文案（「约需 N 分钟，可离开页面」）；b) 后端加一个幂等的 `POST /api/threads/rebuild/:id/cancel`（置 status=cancelled，切片循环已有终态检查点可自然退出），如无必要勿增实体——若判断取消需求罕见，至少先做 a。

## 六、QA 数据自清
- 本轮 4 个 QA 账号（[QA-R139]-a / -b / -scale / -boss-mirror）已全部注销（`DELETE /api/auth/me`，均返回 `{"ok":true}`）。
- 远程 D1 对全部含 user_id/note_id 的表逐一 SELECT 核验零残留（结果见附录 B）。
- 发现一处残留：注销级联不清理 `auth_rate_limits`（本轮 QA 相关 key 残留 14 行）。该表为分钟级限流计数器、无敏感内容，属卫生问题（P2-微）；本轮已手动 DELETE 清零。
- u_boss 全程零写入。

## 七、分级汇总

| 级别 | 问题 | 影响核心主线 | 验证状态 |
|---|---|---|---|
| P1 | 带空格银行卡号绕过敏感识别，明文出现在时间流/标签云/问答引用 | 是（信任基础） | 生产实测复现 |
| P2 | 「记过哪些…」问法被枚举正则劫持，答非所问且全量罗列（含敏感条目标题与非敏感原文） | 是（可靠找回） | 生产实测复现+代码定位 |
| P2 | 问答追问偶发 ~3 分钟才报超时（同请求 curl 3s 成功） | 轻微 | 生产实测 1 次+录屏 |
| P2 | 空线索页重建完成 0 线索时无反馈，按钮看似失灵 | 轻微 | 生产实测复现+D1 证实 |
| P2-微 | 账号注销级联不清理 auth_rate_limits（限流计数器残留） | 否 | 生产注销后 D1 实查 |
| 设计 D-1 | 每日回顾降级路径无排重，小语料用户同条笔记 5 天推 4 次 | 是（回顾价值） | u_boss 生产数据实证 |
| 设计 D-2 | 重建不可取消、无耗时预期 | 轻微 | 代码核实+千条实测 |

## 八、三环节评分

| 环节 | 评分 | 依据 |
|---|---|---|
| 什么都能丢 | 8.5/10 | 文本/链接/待办/敏感分拣质量高、限流与越权防线扎实；扣分：带空格卡号漏判敏感（P1） |
| AI 整理 | 8/10 | 千条重建收敛达成、周报口径准确、线索机制诚实；扣分：回顾复读（D-1）、重建黑盒（D-2）、0 线索无反馈 |
| 可靠找回 | 7.5/10 | 引用式问答、精确枚举、失败可见可重试都在线；扣分：高频问法被误路由全量枚举（P2）、追问超时体验 |

## 附录 A：千条重建终态记录
- job：`aee718df-5cf3-40fb-a9cf-09969ad1bc31`（u_4c8404862a7c，1000 条 bulk import 后触发）
- 终态（生产 `GET /api/threads/rebuild/latest`，触发后 2538s 采样）：
```json
{"job_id":"aee718df-5cf3-40fb-a9cf-09969ad1bc31","status":"done","phase":"done","total":1000,"processed":1000,"summarized":153,"summarize_total":153,"threads":153,"error":null}
```
- 阶段耗时：cluster ≈19 分钟（processed 6→1000 单调），summarize ≈23 分钟（153 条线索摘要）；轮询序列 0 次回退（watch 日志 regressions=0）。
- 结果核验：`GET /api/threads` 返回线索列表（默认分页 100 条），均带标题与摘要。

## 附录 B：QA 清理核对
- 注销：4 账号 `DELETE /api/auth/me` 均 200 `{"ok":true}`。
- 远程 D1 逐表 SELECT count（条件：user_id/note_id 归属 4 个 QA 账号或 name LIKE '%QA-R139%'），全部为 0：
  users / notes / attachments / thread_jobs / threads / note_embeddings（按 note_id 关联）/ entities / edges / daily_reviews / weekly_reports / user_preferences / push_subscriptions / thread_backfill / push_daily_log / wechat_mp_bindings / wechat_mp_bind_codes / wecom_kf_bindings。
- R2 原件：注销端点级联 `MEDIA.delete`（源码 backend/src/index.ts /api/auth/me 分支），且 QA token 已失效、r2.dev 公共访问关闭，外部不可再取。
- `auth_rate_limits`：注销后残留 14 行 QA 相关 key（级联未覆盖，见第六节），已手动 DELETE 并复查为 0。

## 附录 C：证据清单
- 录屏：R139 镜像老板旅程 UI 走查（时间流/问答/周报/线索/待办，含 4 条失败断言）
- 截图：问答全量枚举+银行卡明文引用、洞察页、周报详情、时间流分拣、真实 API 设置页等
- QA 脚本与日志留存于审查机（不入库）：burst/gen/watch/mirror 脚本、rebuild-watch 轮询日志
