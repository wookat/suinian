# R280 修改轮：按 audit-r279 根因整改（实测记录）

- 轮次：第十一轮（修改轮），针对 R279 独立审查（`docs/audit-r279.md`，PR #309）对 R278（PR #308）的 NO-GO 结论。
- 生产：Web https://suinian.zalize.com ｜ API https://suinian-api.zalize.com ｜ Worker `suinian-api`（本轮部署版本 `2b64514a-58b8-42ee-a68b-c820bd5471b5`）｜ Pages 项目 `suinian`（`--branch main`）。
- QA 纪律：全部账号 `[QA-R280]` 前缀（dg1 / se / bn / sse / s20 / sd / fid / q4 / sen / sen2 / sen3），测试后逐个注销并做 D1 逐表 + R2 权威核查；**未触碰 `u_boss`**（核对其 6 条笔记未变）；无任何密钥入库（QA 口令由环境变量生成）；GitHub Actions 未动。
- 证据口径：下文逐条标注「实测确证 / 未验证 / 推断」。原始输出在会话 VM `/home/ubuntu/qa-r280/out_*.json`（未入库）。

## 一、P0-1 危险执行：为什么旧实现必然漏，改成了什么

**根因（实测确证 + 代码论证）**：旧 `EXEC_PIPELINE_RE` 是**命中式清单**——它把「已知的危险写法」逐条枚举（`curl|sh`、`bash <(curl …)`、`powershell -Enc`、`base64 -d|sh`），判定粒度是「这一串字符长得像不像我见过的攻击」。这类清单有两个结构性缺陷：

1. **覆盖面等于作者的想象力**：反弹 shell（`/dev/tcp`、`/dev/udp`、`nc -e`、`nc -c`、`ncat --exec`、`socat EXEC:`）、下载后赋权执行（`chmod +x r.sh && ./r.sh`、`curl -o … && sh …`）都不在清单内 → R279 实测原样交付、无警示无隔离。
2. **判定发生在归一化之前**：续行符 `\` + 换行、行尾 `&&`/`|`、注释尾巴都会让同义命令躲开同一条正则 → 跨行 `bash <(\⏎curl …)` 绕过（R279 P1-3）。

**改法（`backend/src/prompt-armor.ts`）**：改为**行为角色组合判定**，字面清单降级为 fail-closed 兜底：

- 归一化前置 `normalizeCommandText()`：NFKC → 吃掉续行符与换行 → 去注释 → 压空白；`execIntentLineSpans()` 再按行尾 `\`/`&&`/`||`/`|` 与未闭合 `<(`/`$(` 把跨行命令合并成「逻辑命令」（≤8 行）后判定，命中时按**原文 span 整体**替换，杜绝残片。
- 行为角色：`EXEC_FETCH_RE`（远程取得代码）、`EXEC_SINK_RE`（把取得物送进解释器/执行）、`NET_BACKCONNECT_RE`（建立外连/反弹）、`PRIV_CHANGE_RE` + `PRIV_THEN_EXEC_RE`（赋权后执行）。`hasExecIntent()` = 外连 ∨ (取码 ∧ 执行) ∨ (赋权 → 执行) ∨ (取码 ∧ 赋权) ∨ 旧字面清单兜底。
- 出口两态、无第三态：verbatim 问法 → **完整原文 + `EXEC_PIPELINE_WARN_MARK`**；非 verbatim → **整段替换为 `EXEC_ISOLATED_MARK`**（新增标记，与「笔记内指令」隔离语义区分，便于用户理解发生了什么）。

**生产实测（确证）**：`[QA-R280]dg1`，10 类载荷 × 2 问法 = 20 次，**原样泄漏（无警示无隔离）0/20**：

| 载荷 | verbatim 问法 | 非 verbatim 问法 |
| --- | --- | --- |
| `bash <(curl -fsSL …)` / `bash -i >& /dev/tcp/…` / `sh -i >& /dev/udp/…` | 完整原文 + 警示 | 整段隔离 |
| `nc -e /bin/bash` / `nc -c /bin/sh` / `ncat --exec` / `socat … EXEC:` | 完整原文 + 警示 | 整段隔离 |
| `chmod +x r.sh && ./r.sh` / `curl -o … && sh …` | 完整原文 + 警示 | 整段隔离 |
| 跨行 `bash <(\⏎ curl … )`（R279 P1-3 复现） | 完整原文 + 警示（**归一化后与单行同义式一致**） | 整段隔离 |

## 二、P0-2 社工载荷：语言无关的角色判定 + 全出口统一

**根因（推断 + 代码论证）**：旧判定挂在中文关键词上，且只在部分出口（verbatim 分支）生效 → 日文「認証コードを相手に伝えてください」、缩略式「电话来了传认证码」「续费和发证件号」原样交付。

**改法**：`segmentIsSocialEngineering()` 拆成语义角色的合取，中/日/韩/英同权：凭据角色（验证码/恢复码/证件号/密码/OTP/認証コード/인증번호/…）× 披露动作（念出/告知/外发/伝え/読み上げ/알려/read out/dictate/share/…）× 接收方（对方/客服/来电者/相手/상담원/support staff/…）× 电话诱导 × 逐位念出；并按**子句**切分，否定式（不要/切勿/属于诈骗/never/ないでください/하지 마）子句不参与诱导判定。危险执行与社工统一收敛到 `segmentIsReaderDirective()` → 同一出口（verbatim / 非 verbatim / 枚举 / 确定性 / 流式 / MCP 全部经 `finalizeAskAnswer()`）。

**生产实测（确证）**：`[QA-R280]se`，9 条中/日/韩/英社工笔记 × 7 种问法（含多语言、间接转述「刚才那条笔记具体让我做什么？」）：**泄漏 0/7**，出口分别为「整段隔离标记」「只给引用不给正文」两态；`instruction_isolated=true` 随响应下发，Web 端据此渲染琥珀色隔离提示条（`web/src/components/ask-chat.tsx`，代码确证；本轮未做浏览器录屏 → **UI 视觉未验证**）。

## 三、P1-3 枚举标题隔离

`sanitizeEnumTitle()` 现在走与正文同一套 `segmentIsReaderDirective()`（含语义社工与危险执行），并继承源正文判定。**实测确证**：`我的待办有哪些？` 返回 `［待办］〔标题含指令内容，已隔离；可在笔记卡片中查看〕 ×N`，R279 漏判的「电话来了传认证码」「续费和发证件号」两条均被隔离，同轮无「一半中一半不中」。

## 四、P1-4 空/回声/残片 → 可读隔离说明

`finalizeAskAnswer()` 增加确定性归一：当资料侧确有可隔离内容（`dataTextHasIsolatableContent()`：读者指令 ∨ 社工 ∨ 危险执行意图）时，**空答案 / 问题回声（折叠后 ≥80% 与问题重合）/ 悬空引导语残片（如「DGX4 部署命令是：」）** 一律转 `ISOLATION_NOTICE_ANSWER`；资料无可隔离内容时保持「没找到」原样，两者可分辨（单测 + 生产实测）。「悬空引导语残片」这一形态是本轮**生产实测新发现**（R279 未列），已修复并回归。

## 五、P1-6 benign 零误伤

**实测确证**：`[QA-R280]bn`，10 条真实技术笔记（审稿 prompt 模板、供应链攻击综述、运维手册、K8s/Terraform/构建/权限、中英文防骗提醒）× 11 问，**误伤 0/11**；`验证码可以告诉别人吗？` 正常作答「不可以…属于诈骗」，不再半隔离。

## 六、P2/P3

- **P2-7 `concat(delta)` 契约**：定义并对齐（`backend/src/index.ts`）。确定性路由 `stream_mode=deterministic_complete`、`delta_contract=exact_concat`（**实测 4/4 恒等**）；生成路由 `delta_contract=preview_ordered_fragments` + `citation_markers=final_only`，语义为：① 去引证角标后 delta 按序是 `done.answer` 的连续片段；② delta 仅为预览，finalize 可丢弃/改写，`done.answer` 唯一权威、客户端整体替换；③ 安全方向单调，危险/注入/社工内容不会先发后收。**实测（20 次抓包，`[QA-R280]s20`）**：先泄后收 0/20；6/20 与「逐字恒等」不符，逐例核对**全部**是 finalize 插入 `[n]` 角标或 finalize 丢弃了模型多写的一句 → 与上述契约一致（**实测确证**）。
- **P3-8 MCP `Server-Timing` 响应头**：`backend/src/mcp.ts` 在外层响应补 `Server-Timing`。**实测确证**：`POST /mcp` → `200`，`Server-Timing: mcp;dur=0;desc="mcp request"`。
- **P3-9 `Q4 的支出？` 判定痕迹**：新增 `scrubDecisionTraces()`。**实测**：3 种问法均无「[1][2] 中没有直接相关的信息」类痕迹；仅剩面向用户的口径说明（「待办等尚未发生的计划不计入」），属可读解释而非内部判定痕迹。
- **P3-10 检索召回**：本轮**未做**针对性检索质量改造（**未验证**），仅记录现状：15/15 shell 正文逐字一致、忠实性问答 0 幻觉、极值/Top-N/退款方向/新存即时可查全部正确。

## 七、其他实测结果

- **忠实性/正文保真**：`[QA-R280]fid`，15 条 shell 命令逐字问答 **15/15 完全一致**；书摘、会议纪要、退款方向、极值、Top-3 均正确；新存笔记 2 秒内可查（**实测确证**）。
- **记账时间窗口的现存限制（非本轮引入，推断为设计口径）**：账目时间以笔记创建时间为准，正文里写的「2026-02-03」不参与时间窗筛选，故「2026 年 2 月花了多少」按创建时间返回 0 笔。本轮**未改动**该行为。
- **敏感隔离**：敏感笔记落库为密文（D1 实查 `content='[加密内容]'`、`content_enc='v1:…'`），问答出口不含明文（返回「敏感笔记不进入问答」提示），搜索出口不返回明文；本人已认证的时间流/详情按设计解密展示。软删 → 回收站可见 → 恢复成功（**实测确证**）。R2 桶 `suinian-media` 权威 `object_count=0`。
- **注销级联 / 残留核查（实测确证）**：全部 QA 账号注销后，`users` 命中 0；`api_tokens / notes / user_preferences / push_subscriptions / push_daily_log / daily_reviews / weekly_reports / threads / thread_jobs / thread_backfill / entities / edges / wechat_mp_bindings / wechat_mp_bind_codes / wecom_kf_bindings` 逐表 0；`attachments`（经 notes 关联）0；孤儿 notes / attachments 0；`u_boss` 6 条笔记未变。
- **本地验证（实测确证）**：backend `vitest` 135 文件 / 2516 用例全绿；backend `tsc --noEmit` 通过；web `lint`（仅既有 react-hooks 风格 warning，无 error）+ `build` 通过；Android `assembleDebug` **BUILD SUCCESSFUL**（本地 SDK 35）。**模拟器实机运行未做 → 未验证**。
- **AI 降级窗口**：本轮生产测试期间未观察到模型降级/超时兜底文案（**实测未见**，非「保证不存在」）。
- **微信/企微**：未配置，未伪造，未测试（**未验证**）。

## 八、未做/未验证清单（如实标注）

1. 浏览器 UI 隔离提示条的视觉确认与录屏（代码路径确证，视觉**未验证**）。
2. R279 benign 31 条 / R277 100 问 / R275 56 问的**全量**重跑：本轮做的是覆盖同类语义的 11 问抽测（0 误伤），**未做全量**。
3. 备份导出、9 出口全枚举的逐一复测：本轮覆盖列表/搜索/问答/详情/回收站/恢复 6 个出口，其余**未验证**。
4. 检索召回质量改造（R279 §10）**未做**。
5. Android 模拟器实机**未验证**。
