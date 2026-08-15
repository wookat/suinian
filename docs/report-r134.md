# R134 修改轮报告（落实 audit-r133）

审改分离的「改」方。R133 无 P0/P1，本轮为 5×P2 清理 + 3×设计建议评估 + Workers AI 主力口径正式化 + eval 失分归因。证据口径同审查：`[源码]` `[离线实测]` `[生产实测]`。

## P2 逐条

| 项 | 决定 | 说明 |
|---|---|---|
| P2-1 语音/形态检索失败 | ✅ 已修（与 D-3 合并实施） | 见 D-3 |
| P2-2 「120 元两个人」被记成 ¥60 | ✅ 已修 | 根因 `[源码]`：分拣 prompt 的 AA 判例过宽——只要句中出现人数就可能被套用「净额=总额÷人数」，但「午餐农家菜 120 元两个人」并未声明 AA/平摊/垫付。修法：判例收紧为「只有明确说了 AA/平摊/人均/垫付才折算净额」，并新增反例判例「只提人数、没说平摊 → 按用户实付金额记（120 记 120），绝不自作主张按人头除」（backend/src/triage.ts）。不改代码路径，纯 prompt 判例边界修正，既有 AA 正例保留 |
| P2-3 API 报告默认周期与 Web 不一致 | ✅ 已修 | `POST /api/reports/generate` 空参默认从 `last` 改为 `this`，与 Web「生成本周报告」按钮同口径；显式传 `{"which":"last"}` 行为不变。周一凌晨 cron 走 `reports.ts` 内部默认值（`last`），不经此路由，不受影响 `[源码]`。docs/SPEC.md 同步更新 |
| P2-4 无推送订阅仍消耗待办提醒 | ✅ 已修 | `sweepTodoReminders` 改为「先确认投递通道、再标记 reminded」：无订阅时不再写 `todo_reminded_at`，用户之后订阅即可在 24h 回看窗内收到提醒；用户显式关闭提醒偏好时仍消耗（尊重用户决定，行为不变）。标记仍在实际投递前完成，at-most-once 语义不变。新增单测「no subscription 不消耗」（backend/test/r67-push.test.ts） |
| P2-5 每日推送时区与用户偏好时区不一致 | ✅ 已修 | `sweepDailyReviewPush` 的本地日期/小时判定从「最近订阅的 tz」改为 `loadUserTz`（user_preferences.tz），与回顾生成同一时区来源，推送的「今天」与回顾的「今天」不再可能分叉。单测改为断言偏好时区优先于陈旧订阅时区 |

## 设计建议逐条

| 项 | 决定 | 说明 |
|---|---|---|
| D-1 枚举意图边界扩展（盘点/想去的地方） | ✅ 已实施 | 不堆正则主判、只补分类器：①`ASK_ENUM_CUE_RE` 列举线索闸门补「盘点」（原闸门会把 LLM 正确判出的盘点类枚举拦掉）；②意图分类 prompt 补「盘点一下我记过的菜谱」正例与「想去的地方」类描述性主题的取词指引。规则路由行为不变，LLM 判定仍经既有 fail-closed 校验 |
| D-2 首周空线索引导 | ✅ 已实施（轻量文案） | 审查建议的引导语义 Web 已有 EmptyState 双态文案（有想法未成线索 → 可手动重建；无想法 → 引导去记录），本轮只补「同一主题通常要积累 2-3 条相关想法才会聚成，第一周线索少是正常的」的预期管理一句话（web/src/pages/threads.tsx），不动聚类阈值、不加新组件 |
| D-3 按 raw_type 元属性检索 | ✅ 已实施 | 「语音里我让自己提醒什么事」失败根因：「语音」不在转写正文里，关键词/语义召回都不把 raw_type 当线索。修法（高内聚零新实体）：`mediaTypeIntent`（backend/src/ask.ts）规则识别形态词（语音/录音/口述→voice，图片/照片/截图/拍的→image，文件/文档/附件→file），普通召回阶段把该 raw_type 的最近笔记（≤10 条，尊重时间窗）**并入**候选——只增补、不排除，答案仍由 LLM 依据内容给出，命中排序优先但共享既有 20 条上限。不动召回架构，单测覆盖（r132-ask-intent.test.ts） |

## Workers AI 主力口径正式化（任务 3）

现状：DeepSeek 欠费停摆，生产长期跑 Workers AI。自动切换逻辑**一行未动**（每次调用先试第一链位、失败走 Workers AI、恢复自动切回），只统一表述与监控基线：

- 代码注释：backend/src/ai.ts（provider 链两层表述，Workers AI=服务基线而非 degraded）、/health 探针注释（backend/src/index.ts）——`provider` 报告的是**链位**而非服务质量，`fallback`=Workers AI 是当前常态基线。
- 告警口径：外部监控只告警 `ok:false`；`provider` 变化仅作观察（如 DeepSeek 充值后切回 primary）。写入 docs/self-host.md 与 docs/handoff-context.md（已知问题条目更新为 R94/R134 口径）。
- 文档：README 架构图与子目录表、docs/SPEC.md 架构图与 AI 管线标题改为「Workers AI 主力 + 可选外部 OpenAI 兼容 API 为第一链位」。「降级」字样从 provider 链表述中移除（语义召回失败降级关键词等**其他**降级语义不在本次口径内，保留）。
- API 兼容：`/health?probe=ai` 返回结构（`provider: primary|fallback|mock`）不变，既有监控无需改配置。

## eval 40/43 三失分项归因（任务 4）

| 项 | 归因 `[源码]`+R133 证据 | 处置 |
|---|---|---|
| q12 星尘项目关键决定 | 规则 topicEnumIntent 不命中（「做」不在经历动词表），是 LLM 意图分类把这个**归纳型**问题（问决定内容）判成 topic_enum「星尘项目」，枚举路由按字面 LIKE 筛选，漏掉未写全名的相关笔记 | ✅ 低风险修：分类器 prompt 的 general 分支显式补「归纳/梳理某主题内容（这个项目做过哪些关键决定）→ general」判例；fail-closed 校验不变，误判仍回落普通召回 |
| q31 快闪店依据 | 含「依据」已入 MULTI_HOP_RE 二跳召回；R133 实测答案正确、失分为引用完整性抖动（cafe2/cafe3 需同时被引，语义召回排序在阈值边缘） | ⏸ 不修：调低 `ASK_CITATION_MIN_SCORE`（0.55）或加大召回窗会增加全线噪声引用，为 1 题抖动动全局阈值风险大于收益。q12 修复后分类器少一类误路由，对二跳路径无扰动 |
| q54 暂缓换工作的项目进展 | 同上：「进展」已入二跳门控，答案正确、job3+proj3 双引用抖动 | ⏸ 不修，理由同 q31。部署后跑全量 eval 记录本轮实测分数（见回归） |

## 回归与部署

- backend：typecheck 过、单测 66 文件 724 全过（含本轮新增 P2-4/P2-5/D-1/D-3 用例）；部署后全量 ask-eval `[生产实测]` **58/60（97%）**，仅剩失分即上表 q31/q54 类引用抖动（为什么依据 5/6、多跳 7/8），归纳型问法误路由（q12 类）已消除。
- web：oxlint 过、tsc+vite build 过。
- GitHub Actions 按公司规则保持禁用，本地全绿为验收标准。
- worker `suinian-api` + Pages `suinian`（--branch main）部署上线；QA 用 `[QA-R134]` 独立账号全链路回归后注销并逐表核残留（明细见 PR 描述与录屏）。
