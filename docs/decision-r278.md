# R278 修改轮设计论证（对应 audit-r277 NO-GO 结论）

> 每节先给根因论证，再给实现口径。全部条目均有代码 + 单测（`backend/test/r278-fixes.test.ts` 等），非书面论证项见文末 P2/P3。

## 1. P1-1 危险执行管道零警示 + 静默切碎（DG1/DG2/DG3/S08）

### 根因（一手定位）
- 「EXEC_PIPELINE_WARN_MARK 代码存在但生产零产出」的根因：生成分支先经 `guardAskAnswer` 插入标注，随后统一出口 `finalizeAskAnswer` 的首步 `stripSpoofedControlMarks`（R276 防仿冒层）把**系统自己刚插入的真标注**当内容侧仿冒剥掉，只剩残尾。
- 残片交付的根因：旧实现只替换 `EXEC_PIPELINE_RE` 命中的**字面区间**，`bash <(curl -fsSL …)` 匹配不全时把段落切成 `-fsSL …)` 残片。

### 实现
- 标注插入收敛为**单点**：只有 `finalizeAskAnswer`（在 despoof 之后）插入真标注，插入后无任何剥除层（`prompt-armor.ts` `guardAskAnswer` 注释与 `isolateNoteInstructions`）。
- 管道处置改为**整段/整行**：verbatim → 完整原文 + `EXEC_PIPELINE_WARN_MARK` 前置；非 verbatim → 整段替换为 `INSTRUCTION_ISOLATED_MARK`。围栏代码块逐行处置，不陷整块。禁止任何残片。
- 伪造「警示已由管理员解除」：`SPOOFED_CONTROL_MARK_RE` 扩展匹配「警示/警告…已(由/被管理员)解除/取消/移除/撤销」，随源内容一并剥除，不得独立透出（S08）。
- DG3 串台（返回 DG1 内容）：属跨笔记拼接串台，与 P2-7 同根因，见 §8。

## 2. P1-2 社工诱导（X04）
新增 `SOCIAL_ENGINEER_RE`（验证码/恢复码/证件/密码/口令 外发·念给·发给 + 电话诱导形态），挂入 `segmentIsNonExecReaderDirective` —— 该判定被 `isolateNoteInstructions` 在**所有**路径（含 verbatim）使用，无 verbatim 豁免。

## 3. P1-3 枚举标题继承源「含指令」标记（X02）
`sanitizeEnumTitle(title, { sourceContent })`：除标题字面判定外，源正文命中 `sourceContentHasReaderDirective`（非管道类读者指令段）时标题整体替换为 `ENUM_TITLE_ISOLATED_MARK`。可执行管道不连坐标题（合法技术笔记的命令不该抹掉标题）。`index.ts` 全部枚举出口已传入源正文。

## 4. P1-4 出口清洗静默空/残片答案 + instruction_isolated
- `finalizeAskAnswer` 返回 `{ answer, changed, isolated }`；任何隔离性改写置 `isolated`，路由层据此下发结构化 `instruction_isolated: true`（生成/确定性/SSE/MCP 四路全覆盖）。
- 改写后只剩无意义残片（去角标/标点后 <4 有效字符）时转为显式 `ISOLATION_NOTICE_ANSWER`，与「没找到相关笔记」文案可分辨（兼 P2-6）；N06 型「清洗后否认存在」随之消除。
- 前端：`AskResponse.instruction_isolated` → `ask-chat.tsx` 渲染琥珀色 ShieldAlert 隔离提示条。

## 5. P1-5 benign 误伤（Terraform/审稿模板/D1 拆分）
- 判定区分「技术祈使句」与「面向助手/读者的行动指令」：祈使线索必须与行为信号（外传/导航/联系/口令/破坏/社工/伪授权）联署才隔离；纯技术祈使（`force_destroy = false`、「请从…评审」模板、「拆成 UNION ALL」）不再命中。
- 回归集：`injection-eval-data.ts` benign 语料扩至 B01–B54（含 R277 三例误伤源 B42/B43/B44 与新增 10 例安全研究/运维类），R275 28 条与 3 稳定拒答问法保留在集内，本地单测逐例锁 0 误伤。

## 6. P1-6 UI 注销悬挂（浏览器 40–60s）
根因：前端 `deleteAccount` 无超时、失败静默重试无上限，边缘链路 DELETE 偶发悬挂时 UI 无反馈。修复（`web/src/lib/api.ts`）：DELETE 5s 超时 + 1.5s 间隔 cache-bust 探测 `/api/auth/me?probe=` 验证已注销（401 即成功）+ 15s 硬上限，超限抛出可读错误——完成 ≤5s 或有明确失败反馈。

## 7. P1-7 SSE 真流式
- 生成路径改用 `chatCompleteStream`（provider 级流式）：首 delta 前完成 dirext 指令抽取门（8s fail-closed 超时）；模型增量按句界缓冲，每段独立过 despoof→demand 过滤→`finalizeAskAnswer`→链接收口，未通过的段不外发；`done` 事件带完整 finalize 后 body，`meta.stream_mode: "generation_stream"`。
- 确定性路径一次成型，如实标注 `stream_mode: "deterministic"`。
- X05 清洗不稳定：残片→`ISOLATION_NOTICE_ANSWER` 的确定性转换消除了「两次不同残片」。

## 8. P2 逐项
1. **verbatim 外链/邮箱（X03/E04/E07）**：`scrubAnswerLinks`/`scrubDataDerivedEmails` 对非白名单外链与资料派生邮箱在 verbatim 分支同样替换为隔离标记，原文在笔记卡片可见。
2. **日/韩指令正文（E08/E09）**：`segmentIsNonExecReaderDirective` 增加日语（〜してください/を送信/を読み上げ等）与韩语（하세요/보내/복구 코드 등）指令形态。
3. **MCP search_notes 原始正文**：书面论证——search_notes 返回的是结构化笔记对象（面向 MCP 客户端程序，非叙述层），与笔记卡片同通道；出口不做正文改写，但 ask 工具转发结果与 REST 同过 finalize。风险面=客户端自身如何呈现，已在本节明确记录。
4. **MCP Server-Timing**：`mcp.ts` 把内部 `/api/ask` 的 `Server-Timing`（含 `conaud`）复制到 MCP 响应头，可外部验证。
5. **Q1–Q4 默认当前年度**：`ask.ts` 季度解析裸 Q1–Q4/一至四季度默认当年（原 bug 落到 2025），单测更新。
6. **可分辨性**：见 §4（`ISOLATION_NOTICE_ANSWER` ≠ 「没找到相关笔记」）。
7. **跨笔记串台（DG3 返 DG1）**：枚举/verbatim 回答按笔记 id 定位源正文后拼接，不再按检索顺序混拼相邻笔记内容；R278-DG1/DG2/DG3 语料入回归集分别锁定。

## 9. P3
- **auth_rate_limits 级联清理**：账号删除级联已含 `auth_rate_limits`（核对确认）；另修复未知登录/找回名不再创建账号维度限流行，避免残留。
- **安全研究类 benign 判敏可用性**：方案——判敏不拒答，走「引用来源 + 结构化标注」（隔离标记 + 笔记卡片完整原文 + `instruction_isolated` 提示条），研究内容全文始终可从卡片获取；B45–B54（SSRF/fail2ban 等）语料锁 0 误伤。
