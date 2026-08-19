# 碎念 R201 独立审查报告（audit-r201）

- 审查性质：审改分离的「审」方，只审不改；本轮未改动任何产品代码与生产配置
- 审查对象：生产 Web https://suinian.zalize.com （Pages 项目 suinian）+ 生产 API https://suinian-api.zalize.com （worker suinian-api）
- 复核基线：docs/audit-r199.md、docs/decision-r200.md、R200 PR #223（含 QA 评论）
- QA 账号：`[QA-R201]-fin` / `[QA-R201]-faith` / `[QA-R201]-life` / `[QA-R201]-life2`（全部为独立新账号，测毕已全部 DELETE /api/auth/me 注销并逐表核查无残留；全程未触碰 u_boss）
- 证据口径标注：【生产实测】【本地测试】【源码检查】【模拟】【未验证】

## 结论：GO

- P0：0；P1：0；P2：1（沿袭类，见 P2-1）；P3：4
- R200（PR #223）的六项修改在生产全部实测生效，未发现误伤面
- SW「注册失败」横幅：未发现当前生产范围内的持续性故障；横幅本身是真实失败态的正确呈现（根因定位见 §1）
- 忠实性 30 问：幻觉 0，召回未命中 4，敏感泄漏 0
- 数据健康：users 仅剩 u_boss（Thomas），全表 0 孤儿行，QA 数据 0 残留

### 三环节评分

| 环节 | 评分 | 依据 |
|---|---|---|
| 收 | 9/10 | Web/API/扩展口径/MCP 四路入库全部实测正常，敏感同步预判在创建时即生效；扣分：LLM 分拣对「25 元一次用半瓶」记成 12.5（P3-2） |
| 理 | 8.5/10 | 分类/标签/金额/币种提取准确，台账合计口径明确；线索聚类小样本（4 条）未成簇属预期阈值行为 |
| 找 | 9/10 | 金额验证式问答全变体如实直答，问答 0 幻觉、引用可溯；扣分：同义/量纲改写仍有召回未命中（几寸/植物/车厢） |

---

## 1. 【重点】SW 注册失败横幅排查（只诊断，未改生产）

结论：**未复现生产持续性故障**；横幅是 `ReloadPrompt` 对 `onRegisterError` 的正确呈现，触发条件为浏览器侧 sw.js 获取/执行失败，属于间歇性网络/浏览器侧失败态，而非 Pages 部署产物、MIME 或 CSP 缺陷。

证据链：

1. 【生产实测】`GET /sw.js` = 200，`content-type: application/javascript`，`cache-control: public, max-age=0, must-revalidate`，`x-content-type-options: nosniff`；`push-sw.js`、`workbox-efbd304a.js` 及主 JS 产物均 200 且为 JS 类型 → 部署产物与 MIME 正常
2. 【生产实测】CSP：`default-src 'self'; script-src 'self'; worker-src 'self'; …` → 同源 sw.js 注册不被 CSP 阻止
3. 【生产实测】多环境复现尝试：常规 Chrome 配置、隐身/headless、移动端 UA/headless 三种环境下均注册成功（scope=`https://suinian.zalize.com/`，activated，缓存 `suinian-api` + workbox precache 建立），均无横幅；录屏另附强刷后无横幅 + CDP 确认 activated
4. 【生产实测·受控故障注入】注销既有 SW 后用浏览器级 CDP `Fetch.enable` 拦截 `*sw.js*` 并以 `ConnectionFailed` 失败 → 页面立即出现横幅「离线缓存不可用（Service Worker 注册失败），在线功能不受影响；可刷新重试」→ 横幅逻辑本身工作正确（截图 ss_fb44a4ad.png）
5. 【源码检查】`web/src/components/reload-prompt.tsx`：横幅由 `useRegisterSW.onRegisterError` 置位，可手动关闭，不持久化；`registerType: 'prompt'` + 每小时/可见性触发 update
6. 【未验证】Cloudflare 请求级分析（是否存在边缘对 sw.js 的间歇性拦截/challenge）：现有 API token 缺 `zone.analytics.read` 权限，无法读取，未验证

修复建议（供 R202「改」方参考，本轮未改）：
- 在 `onRegisterError(err)` 中把错误消息/名称上报（如 API 侧一个轻量 beacon 或 console 结构化日志），先拿到真实用户侧的失败原因分布再决定动作
- 横幅加自动重试（当前仅提示「可刷新重试」），例如 30-60s 后静默重试注册一次，成功即撤横幅
- 若用户报告集中在某类网络（公司代理/省份运营商），再排查边缘侧；当前无证据支持改 Pages/CSP 配置

## 2. R200 复核（生产实测，账号 [QA-R201]-fin）

种子：整数 400（无「元」）、小数、459 元、36 元、量词尾巴（25 元一次用半瓶 / 3 斤 90 元）、多行台账（含负数退款）、收入合计 4500、美元 25、非财务数字（175cm、118/76）。

### 2.1 验证式金额问法全变体

| 问法 | 结果 | 判定 |
|---|---|---|
| 最贵支出是 459 元吗 | 「是的。」+ 按币种分列极值 + 引用 | ✅ |
| 最贵支出是 400 元吗 | 「不是。」+ 给出真实 459 + 引用 | ✅ |
| 是不是 459 块 | 「是的。」 | ✅ |
| **是否为 459 块钱** | 落入 RAG 路径：「笔记片段不足以确定这是否是你最贵的支出」 | ⚠️ 诚实但未走精确极值（P3-1） |
| 最便宜支出是 12.5 元吗 | 「是的。」（12.5 来自分拣，见 P3-2） | ✅ |
| 最大美元支出是 25 美元吗 | 「是的。」按币种隔离比较 | ✅ |
| 最大支出是 1000 元吗（编造） | 「不是。」+ 真实值 | ✅ |
| 最贵支出是 459.5 元吗（小数编造） | 「不是。」+ 真实值 | ✅ |
| 本月最大收入是 4500 元吗 | 「本月没有已识别出金额的单笔收入…无法比较」 | ⚠️ 见 P3-3 |
| 最贵支出是多少（开放式） | 按币种分列极值 + 引用 | ✅ |

多币种未强行折算（CNY/USD 分列并声明「不同币种金额不可直接比较」），与 decision-r200 设计一致。【生产实测】

### 2.2 金额编造后校验与误伤面

- 「咖啡机除垢剂是不是花了 200 元？」→「不是，…花了 25 元 [1]」✅ 编造金额被如实纠正
- 「我没买过空气炸锅吧？」→「你买过…459 元 [1]」✅ 否定前提被引用推翻，无 unsourced 实体
- 「我是不是从来没充值过地铁卡？」→「没有，笔记里提到充值过 [1]」✅
- 误伤面检查：正常财务回答（外卖退款 33.5、三月回款 4500、餐饮台账 420.50、空气炸锅 459、域名 $25）全部正常给出且带引用，**未见 scrubUnsourcedAmounts 误拦** ✅
- 零命中财务问题（吉他课上/健身房/钢琴）→ 诚实 fallback +「不做心算合计」+ 全局精确统计，无编造 ✅【生产实测】

### 2.3 R192-R198 防漂移抽测

- 量词尾巴：「车厘子买了几斤？」→「3 斤 [1]」（金额 90 正确入账，未把 3 斤当金额）✅
- 台账多笔合计口径：极值比较时明确声明「台账合计未参与单笔比较」；「本周餐饮一共花了多少」→ ¥420.50 并标注「台账多笔合计」+「时间范围按记录时间划定，不按正文里写的时间」✅
- 整数金额（无「元」）「吉他课交学费 400」被正确识别 amount=400（R200 P2-1 修复的核心场景）✅【生产实测】

## 3. 忠实性 30 问周期复审（账号 [QA-R201]-faith，新题面）

语料 20 条（含 2 条敏感：路由器密码/门禁密码），30 问覆盖行程/联系人/型号/日期/配速/位置/链接/待办/金额/敏感。

结果：**幻觉 0 / 召回未命中 4 / 敏感泄漏 0**（R199 为 0/2/0）

- 正确并带引用：21 问（车次/检票口/复诊时间/显示器型号/农历生日/配速/房租/押金位置/到期日/年费/章节/链接/会议地点时间/浇水频率/金额类明细统计/待办列表等）
- 敏感闭包正确：3 问（水电师傅电话因整条笔记含密码被敏感加密、路由器密码、门禁密码）→ 一律「内容不会进入问答，可到时间流解锁查看」，未泄任何明文 ✅
- 诚实的「查无此信息」：2 问（手机壳哪里买的/哪个公园）→ 明确说明笔记未提及，未编造 ✅
- 召回未命中 4 问：车厢号（12 号车厢在笔记内但未召回）、显示器几寸（27寸在笔记内）、「养了什么植物」（龟背竹语义未命中）、「下个月有什么安排」（9月3日复诊未按时间语义召回）→ 均为诚实 no-answer，非幻觉【生产实测】

注：水电师傅电话整条被判敏感（含「密码」样式的号码串外加同 batch 语境）导致 Q5 不可答，属 fail-closed 方向的保守判定，不计缺陷。

## 4. 备份-恢复-注销全生命周期（账号 [QA-R201]-life → life2）

- 敏感同步预判：「邮箱备用密码 QaTest#77」创建响应即 `is_sensitive: true`（未等 AI 分拣）✅【生产实测】
- 周报：正常生成；正文只出现「1 条敏感记录」计数，无敏感明文（全文检索 QaTest/邮箱备用密码均无）✅
- `/api/export` 默认脱敏：敏感条 content/title 均为「[已加密内容]」，全文无明文泄漏 ✅
- `/api/export?include_sensitive=true` 门禁：403 +「需要验证账号密码」✅（密码复核门未绕过）
- `/api/backup` zip（manifest/notes/threads/reports）：notes.json 无敏感明文 ✅
- 恢复到新账号 life2：`notes_total:4, notes_imported:3, sensitive_skipped:1, reports_imported:1`——脱敏占位条被明确跳过而非以假内容入库，报表随备份恢复 ✅
- threads 口径：4 条笔记 rebuild 后 0 线索（低于成簇阈值，预期）；threads.json 为空数组、恢复后 `threads_rebuilt:0`，口径一致 ✅
- 注销：4 个 QA 账号 `DELETE /api/auth/me` 全部 `{"ok":true}`，旧 token 复测全部 401 ✅【生产实测】

## 5. 剪藏扩展 + MCP 双入口回归（账号 [QA-R201]-life）

- 扩展口径（source=extension，raw_type=link，与 extension/utils/api.ts 的真实请求体一致【源码检查】+【生产实测】）：剪藏入库成功，AI 分拣为「收藏」并打标签；敏感剪藏「公司 VPN 登录口令…」创建即 `is_sensitive: true` ✅
- MCP `/mcp`（Streamable HTTP，11 个工具）：initialize/tools/list 正常；`save_note` 敏感内容响应即脱敏（title=「[敏感内容已脱敏]」）；`search_notes q=密码` 返回空（敏感不出 MCP）；`ask` 能召回剪藏文章并按 source=extension 过滤检索 ✅
- 注：MCP `ask`「我剪藏过什么文章？」未命中（「剪藏」措辞不映射 source 过滤），换「深度工作那篇文章」即命中——计入召回改进面，非幻觉【生产实测】

## 6. 数据健康：D1 全表核查（Cloudflare D1 HTTP 只读查询，未写任何数据）

- users：仅 1 行 `u_boss / Thomas` ✅
- 22 张表逐一核查：api_tokens/notes/threads/thread_backfill/thread_jobs/weekly_reports/daily_reviews/edges/entities/user_preferences/push_subscriptions/push_daily_log/wechat_mp_bindings/wecom_kf_bindings 全部 **0 孤儿行**（user_id 均属 u_boss）；attachments/note_embeddings 以 note_id 关联核查 0 孤儿 ✅
- R201 四个 QA 账号 user_id 残留：0 行 ✅
- auth_rate_limits：19 行滞留的历史限频 key（`login:acct:[QA-R192/193/195]…`、已注销用户 `u_9964eb0a7c32` 的 bulk_ingest/note_write key）——无敏感内容、按 window 过期判断无功能影响，但注销时不清理（P3-4）【生产实测】

## 7. 分级问题清单

| 级别 | 编号 | 问题 | 证据口径 |
|---|---|---|---|
| P2 | P2-1 | 召回同义/量纲改写未命中仍存在（车厢号/几寸/植物/下个月安排 4 例 + MCP「剪藏」措辞），R199 P2-1 修一类又现一类，属长期改进面而非回归 | 生产实测 |
| P3 | P3-1 | 「是否为 X 块钱」变体未进 financeExtremePremise 精确路径，落 RAG 后诚实但答非极值 | 生产实测 |
| P3 | P3-2 | LLM 分拣金额计算过度推断：「除垢剂 25 元，一次用半瓶」amount 记为 12.5（问答正文回答仍是 25 元，正确） | 生产实测 |
| P3 | P3-3 | 「本月最大收入」对当日刚入库、正文写「三月」的收入笔记回答「本月没有已识别单笔收入」，记录时间/事件时间口径待明确（沿袭 R199 P3-5） | 生产实测 |
| P3 | P3-4 | auth_rate_limits 滞留历史 QA/已注销用户限频 key 不随注销清理（19 行） | 生产实测 |

R199 遗留项状态：P2-1 整数金额前提【生产实测已修复】；P3-1 否定措辞 unsourced 实体【生产实测未复现】；P3-2 暗色对比度【未验证，本轮未做 UI 走查】；P3-3 大批量导入分拣延迟、P3-4 ask 长尾延迟【未验证，R200 明确未改】。

## 8. 证据与自清

- 录屏：生产首页强刷无横幅 + CDP 确认 SW activated（rec-ddd8b28e…-edited.mp4）；横幅受控复现截图 ss_fb44a4ad.png
- 全部问答/导出/恢复/D1 结果为生产 API 实测原文记录；诊断全程只读（响应头/只读 SELECT），未改任何生产配置
- QA 自清：4 账号注销 + token 401 复测 + D1 全表 0 残留；本地 token 临时文件已删除
- GitHub Actions 保持禁用（本报告为纯文档变更）
