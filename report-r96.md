# 碎念 Suinian R96 修改轮报告

落实 audit-r95.md 审查结论。原则：系统性权衡后统一实施，高内聚低耦合，如无必要勿增实体。

## 1. P1-1 外部监控（已上线）

**选型：UptimeRobot 免费版（v3 API）**。权衡：
- UptimeRobot：现成账号（zalize 全站其它产品已在用，同一告警邮箱联系人），免费 50 个监控 + keyword 监控 + 邮件告警，零成本零维护，无需在 Cloudflare 侧新增任何实体。
- Cloudflare Health Checks：需付费计划；Workers cron+邮件：要自建告警通道（邮件 API/密钥），引入新实体且可靠性不如托管服务。均不如 UptimeRobot。
- 注：UptimeRobot v2 API 在当前套餐返回 access_denied，改用 v3 API（Bearer 认证）创建成功。

已建 3 个监控（5 分钟间隔，均挂邮件告警联系人）：

| Monitor ID | 类型 | URL | 语义 |
|---|---|---|---|
| 803734663 | HTTP | https://suinian.zalize.com/ | Web 存活 |
| 803734696 | HTTP | https://suinian-api.zalize.com/health | API 存活 |
| 803734666 | KEYWORD（`"provider":"primary"` 不存在即告警） | https://suinian-api.zalize.com/health?probe=ai | AI 主链路：降级到 fallback 或全断均告警，兼报「降级中」与「全断」两态 |

当前 AI probe 监控为 DOWN 属预期：DeepSeek 余额未回，线上仍由 fallback（Workers AI）兜底，正是该监控要暴露的状态。

## 2. R95 P2 / 设计建议逐条评估

| 项 | 决定 | 说明 |
|---|---|---|
| P2-1 fallback 生成质量（线索标题错配、回顾评语泛化） | ✅ 本轮修（prompt 工程） | `threads.ts` 线索总结 prompt 增加强约束：标题须用碎片中实际关键词、禁泛化标题；summary 须讲递进/演变、禁标题串联。`review.ts` 回顾评语 prompt 要求引用笔记具体内容（关键词/数字/事件）、禁空话。分拣 prompt 同时收紧标签泛化（禁一律套「购物」）。 |
| P2-2 AI 降级链无熔断 | ❌ 不修 | 采纳审查结论：当前主链路失败为快速失败（余额类秒退），串行 fallback 延迟可接受；有状态熔断（DO/KV 计数）新增实体与复杂度，收益不成比例。若未来出现超时型故障再议。 |
| P2-3 timeline.tsx 千行单体 / 无状态管理层 | ❌ 本轮不动 | 大范围重构（TanStack Query 等）与「修改轮」定位不符，风险大于收益；挂账为独立技术债轮次处理。本轮仅做点状修复不扩散。 |
| P2-4 375px 批量操作栏溢出 | ✅ 本轮修 | 操作按钮组改为可换行（`flex-wrap justify-end`），窄屏自动折行不再溢出。 |
| D-1① 一键纠正分拣 | ❌ 不新增 | 笔记卡编辑态已可改分类（等价能力已存在），再加独立一键入口属重复实体。 |
| D-1② 用户纠正记录反哺分拣 prompt | ✅ 本轮修 | 新增 `loadCategoryCorrections`：取用户最近 5 条手动改过分类的笔记（meta.manual_override.category，排除敏感条目），作为 few-shot 偏好注入分拣 prompt，同类内容优先照用户既定归类。复用现有 meta 字段，无新表无新实体。 |
| D-2 搜索无结果→AI 问答升级 | ✅ 本轮修 | 搜索空结果 EmptyState 增加「用 AI 问问看」按钮，复用现有 askPrefill 机制直接把搜索词转问答，无新实体。 |
| D-3① 线索活跃度展示 | ✅ 本轮修 | /api/threads 列表补 `first_note_at`、`week_new_count`（两个子查询，无 schema 变更）；线索卡展示「跨越 N 天/月/年」与「本周 +N」徽标。 |
| D-3② 时间流笔记卡加所属线索 chip | ❌ 本轮不做 | 需 notes 列表接口 join threads（列表热路径加查询），且时间流卡片信息密度已高；价值待验证，挂账。 |

## 3. R93 遗留视觉项复核

| 项 | 状态 |
|---|---|
| 暗色模式图谱关系标签对比度不足 | ✅ 本轮修：关系标签改 `--foreground` + 背景描边（与节点标签同法），字号 9→10 |
| 亮色模式图谱节点标签偏小 | ✅ 本轮修：实体 11→12、碎片 9→10，碎片标签同改 `--foreground`；fitView 标签宽度估算同步更新 |
| 设置页「每日回顾推送」375px 折行错位 | ✅ 本轮修：勾选项改顶对齐 + label/hint 收进同一可折行容器，窄屏折行不再错位 |
| 删除确认用原生 confirm 与应用内风格不一 | ✅ 本轮修：新增轻量 `ConfirmDialog`（应用内弹窗，Esc/遮罩取消），笔记卡删除与时间流批量删除均改用；设置页标签合并/删除、token 轮换等低频操作挂账下轮统一 |

## 4. 回归验证

（本地验证 + QA 全链路结果见本节，GitHub Actions 保持禁用，本地全绿为准。）

- backend：`npx tsc --noEmit` / `npm test`（含新增 r96-prompts.test.ts）/ eval
- web：`npm run lint` / `npm run build`
- QA：[QA-R96] 独立账号全链路，测毕注销并逐表核清，u_boss 未触碰
