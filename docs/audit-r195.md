# R195 独立生产审查报告（R192/R194 复核 + 忠实性 30 问 + 防漂移抽测）

- 审查日期：2026-08-19（UTC）
- 审查对象：生产 Web `https://suinian.zalize.com`（Pages 项目 suinian）+ 生产 API `https://suinian-api.zalize.com`（worker suinian-api）
- 代码基线：main `e0a1684`（R194，PR #217）；对照 `a7c88b7`（R192，PR #216）
- 审查方式：审改分离，只审不改。全部 QA 用独立 `[QA-R195]` 前缀新账号（8 个），未触碰 u_boss（含只读）。测毕全部注销并逐表核查残留（见 §7）。未部署、未改任何生产配置，GitHub Actions 保持禁用。
- 证据类型标注：**【生产实测】**（真实生产站 API/UI 操作）/ **【CDP 模拟】**（生产站上用 CDP 模拟异常网络条件）/ **【本地测试】** / **【源码检查】** / **【未验证】**
- 原始证据 JSON 均落盘审查机 `/home/ubuntu/qa-r195/`（fin-\*.json、faith-30q.json、drift-\*.json、sens-\*.json、clu-threads.json、bk-restore\*.json、bridge-auth.json、axe-results.json、cleanup.json、residue.json）；UI 侧全程录屏（带注解）。

## 0. 结论总览：有条件 GO

核心三环节（收/理/找）主链路在生产可用且大部分修复真实生效，但本轮发现 **2 个 P1**（含退款行的净正额台账被方向兜底改判 income、多轮追问出现可复现幻觉），其中 P1-2 直接击穿「30 问 0 幻觉」门槛。两项都有明确 RCA 和小改动修法，建议 R196 修复后复验；不构成停摆级风险，评定**有条件 GO**。

| 环节 | 评分（/10） | 依据 |
|---|---|---|
| 收（capture） | 9.0 | 文本/URL/文件/剪藏入库全通；剪藏外壳凭证 6/6 判敏感、控制组 4/4 不误伤；离线图片 outbox 排队+自动补发可用；备份/恢复（含 threads/reports 新口径）幂等可用 |
| 理（organize） | 7.0 | 台账金额口径（含负数行、混合分隔、无合计行、全角逗号）全部正确；聚类三主题清晰无巨簇；**但方向兜底把含「退款」字样的净正额台账改判 income（P1-1），污染收支合计** |
| 找（retrieve） | 7.5 | 极值/序数全组合 7/7 正确且口径声明透明；敏感零泄漏（问答/MCP 双入口）；**但多轮追问把标签「家电」演绎成「在家电商店买的」（P1-2 幻觉）**；台账行级明细问答答非所问（P2-1） |

## 1. 分级发现

### P1-1 含退款行的净正额台账被方向兜底改判 income，污染收支合计（【生产实测】+【源码检查】RCA）

R194 修复了台账负数行的**金额**口径（本轮实测全部正确），但**方向（category）**在一类常见形态上系统性出错：台账含「退款」字样行、且全文没有任何支出动词（买了/花了/付了…）时，被确定性改判为 income。

生产复现（fin 账号，8/8 全部复现，分隔符无关）：

| 内容形态 | 生产分拣结果 | 期望 |
|---|---|---|
| `上周办公台账：打印纸 120 / 工位绿植 368.5 / 快递退款 -34.5 / 合计 454`（空格分隔，重放 5 次） | **income ¥454** ×5 | expense ¥454 |
| 同表词面、逗号分隔（`打印纸,120…`） | **income ¥454** | expense ¥454 |
| `二组采购台账：胶带 20 / 标签纸 45.5 / 运费退款 -12`（无合计行） | **income ¥53.5**（金额=带符号求和，正确） | expense ¥53.5 |
| 同表 + 标题加「都买了」三字 | expense ¥454（正确） | —（对照组） |
| `本周餐饮台账：…请客团建烧烤,286.5 / 外卖退款,-33.5…`（含「请客」支出词） | expense ¥420.5（正确） | —（对照组） |

后果（【生产实测】）：`我总共花了多少钱？` → 「支出 ¥2579.50，**收入 ¥454**」——幻影收入直接进入全账合计与周报口径。

RCA（【源码检查】`backend/src/triage.ts`）：R118 的词面方向兜底 `fixFinanceDirection` 用 `INCOME_DIRECTION_RE`（含「退款|退了」）对整条内容做正则；台账的一行退款明细被当成整表「钱进来」的证据，而表内名词式明细行（打印纸/绿植）不含任何 `EXPENSE_DIRECTION_RE` 支出动词 → out=false, inn=true → expense 被翻成 income。R194 的单测只断言 `parseLedgerTable` 的金额，未覆盖 category 组合，故未拦住。修法方向：`parseLedgerCore` 命中多行台账时跳过（或行级化）词面方向兜底。

### P1-2 多轮追问可复现幻觉：标签「家电」被演绎成「在家电商店买的」（【生产实测】，3/3 复现）

种子笔记：`买了戴森吸尘器 V12，花了 3299 元`（无任何商家信息；分拣标签为「家电」）。

多轮追问：`戴森吸尘器是什么型号？`（回答正确）→ 追问 `它是在哪家店买的？` → 生产回答（3 次重放一致）：

> 戴森V12吸尘器是**在家电商店买的** [1]。

「家电商店」是笔记中不存在的编造事实（疑似把标签「家电」当来源演绎），且带 [1] 引用背书。违反 30 问审查「0 幻觉」门槛。期望行为：与同轮其它零命中问法一致地回答「笔记里没有提到」（同账号 `体检需要空腹吗？` 追问即正确 fail-closed）。

### P2-1 台账行级明细问答返回整表合计，答非所问（【生产实测】）

`台账里团建烧烤花了多少钱？` →「支出 **¥420.50**（本周餐饮台账，台账多笔合计）」。行值应为 ¥286.5。口径标注虽透明（明示是多笔合计），但用户问的是行明细，返回整表合计属于答非所问；同轮 `上周办公台账里最贵的一项明细是什么？` 能正确答出行级「工位绿植 368.5」，说明行级能力存在但未接入关键词聚合路径。附带：该正确回答后还跟了一句「根据给出的片段不足以确定…」的自我矛盾附注（P3-3）。

### P2-2 时间流过滤 chips 无选中态 ARIA 语义（【生产实测】，R192 无障碍复核 A3c 不通过）

时间流过滤 chips（全部/想法/待办/收藏/资料/支出/收入/资金往来）8/8 均无 `aria-pressed/aria-selected/aria-current`，选中态仅视觉可见，屏幕阅读器用户无法得知当前过滤器。主导航（`aria-current="page"`）与报告页 tab（`aria-selected`）均已正确实现，仅 chips 缺失。建议选中 chip 加 `aria-pressed="true"`。

### P2-3 axe serious 违规非 0：color-contrast 共 21 处（【生产实测】axe-core 4.13.0 CDP 注入）

| 页面 | serious | moderate |
|---|---|---|
| 时间流 `#/` | 2（color-contrast） | 1（landmark-unique） |
| 时间流 + 问答面板打开 | 3（color-contrast） | 1 |
| 设置 `#/settings` | 16（color-contrast） | 1 |

违规集中在 `bg-primary text-primary-foreground` 绿底主按钮（对比度 <4.5:1），调一次 `--primary` 即可全站消除。无 critical。完整节点见 `/home/ubuntu/qa-r195/axe-results.json`。

### P3-1 双导航 landmark 不唯一 + aria-current 命中 2 元素（【生产实测】）

桌面侧栏与移动端底部导航同时存在于 DOM（仅 CSS 隐藏其一）：每页 1 处 axe moderate `landmark-unique`；`[aria-current="page"]` 每路由命中 2 个元素。建议两个 nav 加不同 `aria-label`，隐藏侧 `aria-hidden`。

### P3-2 /health?probe=bridge 公开暴露上轮 QA 写入的 detail 字段（【生产实测】）

无鉴权的 `/health?probe=bridge` 返回 `detail:"[QA-R194] auth smoke"`——R194 审查轮 smoke 测试写入的全局 bridge 状态至今公开可见。detail 属运维自由文本，公开暴露无必要且可能带内部信息，建议 probe 响应里去掉 detail 或做白名单。

### P3-3 正确回答附加自我矛盾的低置信附注（【生产实测】）

见 P2-1 附带：`上周办公台账里最贵的一项明细是什么？` 正确答出「工位绿植 368.5 [1]」后又补「但根据给出的片段不足以确定…可能存在其他未列出的明细」。答案与附注互相矛盾，削弱可信度。同型：`空气炸锅花了多少钱？什么牌子？` 只答金额与明细（明细里含「海氏」），未显式回答「什么牌子」。

## 2. R192 复核（§1）

### 2.1 空格/混合分隔台账 × 极值/序数全组合（【生产实测】，通过）

fin 账号种入 5 条单笔支出（459/155/88/68/36）+ 5 种台账形态（空格、逗号、tab、全角逗号+负数、混合分隔+负数）。金额口径全部正确：

| 台账 | 分隔符 | 生产金额 | 验证 |
|---|---|---|---|
| 上周办公台账（含合计行 454） | 空格 | 454 ✓（取合计） | 但 category 见 P1-1 |
| 本周餐饮台账（12.5+286.5-33.5+155） | 半角逗号 | 420.5 ✓ | expense ✓ |
| 五月出行台账（553+420+96） | tab | 1069 ✓ | expense ✓ |
| 家居台账（含合计行 250、负数行） | 全角逗号 | 250 ✓ | expense ✓ |
| 数码周边台账（129+45-199+59） | 空格+逗号+tab+全角分号混合 | 34 ✓ | expense ✓ |

极值/序数全组合 7/7 正确（`最贵/第二贵/第 2 大（带空格）/第三贵/最便宜/倒数第二/按金额排第 3 名`→ 459/155/155/88/36/68/88），且每答都声明「台账多笔合计未参与单笔比较」的口径。台账合计直问（办公 454、餐饮 420.5、数码周边 34）全部正确。

### 2.2 聚类新口径抽测（【生产实测】，通过）

clu 账号种入 3 主题 15 条混合笔记（装修/日语学习/睡眠 + 干扰项），rebuild 后：`家居装修计划`（5 条）/`日语学习计划`（4 条）/`睡眠改善`（3 条），主题纯净、无巨簇、无跨主题错并，摘要忠实。

### 2.3 无障碍复核（【生产实测】，部分通过）

- skip link：Tab 出现「跳过导航，直达主要内容」，Enter 后焦点落 `#main-content`、hash 不改写 —— 通过。
- Esc：问答面板 Esc 关闭且焦点归还「问答」按钮 —— 通过。
- 选中态语义：主导航 `aria-current="page"`、报告页 tab `aria-selected` 正确；**过滤 chips 缺失（P2-2）**。
- axe：serious 21 处 color-contrast（P2-3）、moderate landmark-unique（P3-1），无 critical。

## 3. R194 复核（§2）

### 3.1 退款/负数行台账用例集（【生产实测】，金额通过 / 方向发现 P1-1）

- 分隔符×正负号×序数组合：负数行在空格/逗号/tab/全角逗号/混合分隔下金额全部正确（带符号求和或取合计行），无合计行的净额 53.5 正确，「第 2 大」带空格问法正确路由（¥155）。
- **方向维度新发现 P1-1**（见 §1）：含「退款」行 + 无支出动词的净正额台账 8/8 被改判 income。R194 单测只覆盖 `parseLedgerTable` 金额，未覆盖与 R118 方向兜底的组合。

### 3.2 备份 zip threads/reports 恢复新口径（【生产实测】，通过）

bk1 种 8 条（含 1 条敏感 + 1 个文本附件），生成周报 + rebuild 线索后导出默认（脱敏）备份：zip 含 `manifest.json/notes.json/threads.json/reports.json/media/*`，manifest counts `{notes:8, threads:1, reports:1, attachments:1}`，敏感明文未出现在 zip 任何字节（扫描确认）。恢复到 bk2：

- 首次：`notes_imported:7, sensitive_skipped:1, reports_imported:1, threads_rebuilt:1, media_imported:1` —— reports/threads 不再被静默丢弃（R193 P2-1 已修）；bk2 侧 `/api/reports` 出现同 week_start 周报、线索重建成功。
- 二次（幂等）：`notes_skipped:7, reports_skipped:1, media_skipped:1` —— 去重口径正确。
- 观察（不计分级）：恢复侧重建线索 note_count=2 vs 原账号 3（脱敏包少 1 条敏感笔记 + URL 笔记聚类差异），属预期口径差。

### 3.3 剪藏外壳凭证敏感判定（【生产实测】，通过）

R193 的 6 个复现句式（extension×3 + web×3 剪藏外壳包裹 `admin / <串>`）生产分拣 **6/6 `is_sensitive:true`**；3 条直书凭证同判敏感；4 条控制组（`进度 12/34`、`日期 2026/08/19`、`A/B 测试方案`、`磁盘 sda1 / sda2`）**0 误伤**。问答与 MCP search 双入口对凭证内容零泄漏（`sens-mcp.json`：搜索返回空集，无凭证字符串外泄；注：该搜索未命中任何笔记，属「未观察到泄漏」而非召回保证）。

### 3.4 PWA：SW 注册失败提示 + 离线图片 outbox（【CDP 模拟】+【生产实测】，通过）

- SW 注册失败（CDP Fetch 阻断 sw.js 后强刷）：页面底部出现可见横幅「离线缓存不可用（Service Worker 注册失败），在线功能不受影响；可刷新重试」，设置页同步显示降级文案（R193 P2-3 已修）。
- 离线图片 outbox（CDP 离线）：离线上传图片立即出现「1 条离线记录（含图片/文件/录音）待同步，联网后自动补发」排队提示（兼作离线可见指示，R193 P3-2）；恢复在线后无需手动操作自动补发成功，图片笔记出现且完成 AI 识别（R193 P2-4 已修）。测试中还顺带验证了提示条「点击立即重试同步」的手动重试路径可用。
- SW 正常态（生产实测）：`navigator.serviceWorker.controller` 激活，设置页「离线可用：页面已缓存」。

### 3.5 bridge heartbeat 鉴权（【生产实测】，通过；心跳中断如实记录）

`POST /api/bridge/heartbeat`：无凭证 → 401；伪造 token → 401；**普通用户 api_token → 401**（R193 P2-5 已修，用户 token 不能再写全局心跳）。`/health?probe=bridge` 当前 503 `status:"stale"`（last_seen 2026-08-19 10:35:41）——与任务说明一致：BRIDGE_TOKEN 已配置在 worker 但 VPS 侧尚未同步，心跳暂时中断，**如实记录，不计新问题**；附带发现 probe 公开暴露 detail 字段见 P3-2。

## 4. 问答忠实性 30 问周期复审（§3）：29/30 过，1 幻觉（P1-2）→ 未达标

faith 账号种 17 条事实笔记（时间/数字/电话/链接/敏感凭证×2），31 问混合（事实 19 + 财务/序数 11（fin 账号）+ 多轮追问 4，其中敏感探测 3）：

- 事实类 19/19 正确：日期、时长（28 分 30 秒）、型号（RT-AX57）、电话（021-6688-2233）、定价+负责人（89 元/月、老周）、农历生日、链接、剩余节数（7 节）等全部逐字忠实，均带引用。
- 财务/序数 11/11 数字正确（见 §2.1），但全账合计含 P1-1 的幻影收入 ¥454（口径污染记在 P1-1，不重复计）。
- 敏感 3/3 零泄漏：路由器密码/网银 U 盾口令均不进入问答，回复引导到时间流解锁查看；无关问题（特斯拉股票）正确答「没找到」不编造。
- 多轮追问 4 问中 3 过 1 幻觉：`体检需要空腹吗？` 正确 fail-closed；**`它是在哪家店买的？` 编造「家电商店」（P1-2）**。

结论：0 泄漏 ✓、0 数字错误 ✓、0 幻觉 ✗（1 例可复现）→ 本项不通过，触发 P1-2。

## 5. R185-R194 修复防漂移抽测（§4，每轮 1 case）

| 轮次 | 代表 case | 结果 | 证据 |
|---|---|---|---|
| R185（P1→R186 修）| 代词追问零命中不兜底全账合计 | 未漂移：`那它的滤芯多少钱？` 按关键词并集口径透明作答，未吐全账合计 | 【生产实测】drift-cases.json |
| R186 | 同上（代词追问改写产物 fail-closed） | 未漂移 | 【生产实测】 |
| R187（AI 整理周期复审）| 周报忠实生成 | 未漂移：bk1 周报数字（8 条/类别分布/敏感 1 条）与实际一致 | 【生产实测】bk-restore1.json + 报告正文 |
| R188 | 小票合计双计锁回合计值 | 未漂移：`水果,68/牛奶,32/合计,100` → amount 100 | 【生产实测】drift-triage.json |
| R189（安全渗透复审）| 敏感凭证问答零泄漏 | 未漂移：路由器密码问答不泄漏、指引解锁 | 【生产实测】drift-cases.json |
| R190 | 极值序数路由 + 台账合计不参与单笔比较 | 未漂移：`第二贵` → 139（山姆牛排），台账 100 正确排除 | 【生产实测】drift-cases.json |
| R191（鲁棒/忠实专项→R192 修）| 空格台账识别 | 未漂移（金额口径）：空格台账 5 种形态金额全对；方向新问题记 P1-1 不算漂移（R192 未覆盖方向） | 【生产实测】§2.1 |
| R192 | 全组合复测 | 见 §2，金额/序数/聚类/skip link/Esc 均保持 | 【生产实测】 |
| R193（审查轮→R194 修）| 6 句式剪藏凭证 | 未漂移：6/6 敏感 | 【生产实测】§3.3 |
| R194 | 负数行台账金额 + bridge 鉴权 + 备份新口径 | 金额/鉴权/备份保持；方向组合缺口记 P1-1 | 【生产实测】§3 |

十轮抽测无历史修复回退；P1-1 属 R194 修复与 R118 旧兜底的**组合缺口**（新发现），非漂移回退。

## 6. UI 侧录屏与环境观察

全程录屏（带注解）+ 关键截图存档于审查机；axe 原始 JSON `/home/ubuntu/qa-r195/axe-results.json`。关键截图：

| 项 | 截图 |
|---|---|
| A1 skip link 可见 / Enter 后焦点落主内容 | [skip link](https://app.devin.ai/attachments/b400cc4f-7aae-444b-90e8-33a42a9a35d7/ss_0e8ceb73.png) / [after enter](https://app.devin.ai/attachments/fdeab00d-506a-441a-aa0e-e4f3b4297206/ss_edf09e31.png) |
| A2 问答面板打开 / Esc 后关闭焦点归还 | [open](https://app.devin.ai/attachments/f4342d97-4149-404d-9593-8673433235a8/ss_bdca4281.png) / [closed](https://app.devin.ai/attachments/98cd8941-2675-41e0-83ed-bcc7b5962989/ss_1884f9ab.png) |
| B5 SW 注册失败降级横幅 | [banner](https://app.devin.ai/attachments/37284827-de60-4ab7-9264-5d0491d70ea7/ss_1ad9f3ff.png) / [zoom](https://app.devin.ai/attachments/3cb113ea-3f4d-475a-8456-9f6967848ece/ss_zoom_c2a92d94.png) |
| B6 离线排队提示 / 联网自动补发 | [queued](https://app.devin.ai/attachments/0a1a674b-a603-4746-b258-40faae4a7535/ss_zoom_c32d4a47.png) / [resent](https://app.devin.ai/attachments/8f25492b-5f40-4ab4-9623-1ea795c33558/ss_zoom_2c81b371.png) |
| B7 SW 正常注册（前 / 恢复后） | [before](https://app.devin.ai/attachments/aff337a9-f56f-431d-ab2c-a82566bfbfee/ss_0b51537a.png) / [restored](https://app.devin.ai/attachments/8ea32beb-3ae5-4824-9501-9cb55f947e55/ss_zoom_259bee9f.png) |

环境侧观察（不定责生产、不计分级）：

1. 测试容器浏览器对生产 API 偶发 ~60s 请求挂起（status 0），同机 curl 0.2s 成功，疑似容器网络/QUIC 特性；副作用是顺带验证了在线发笔记失败回落离线队列 + 手动重试补发路径可用。
2. CDP 阻断 sw.js 的模拟会让该浏览器 profile 的 SW 注册队列卡死（`register()` 永不 resolve，应用内「重试」无效），需删 profile 的 Service Worker 目录恢复——属浏览器侧行为，非生产缺陷，复测需知。

## 7. QA 数据自清与残留核查（【生产实测】）

8 个 `[QA-R195]` 账号全部：逐条软删笔记 → `POST /api/notes/trash/empty` 清空回收站 → `DELETE /api/auth/me` 注销（token 立即 401）。随后用只读 D1 查询核查（cleanup.json / residue.json）：

- D1 残留（8 个 user_id + `[QA-R195]%` 名称匹配）：users/api_tokens/notes/attachments/threads/thread_jobs/thread_backfill/weekly_reports/daily_reviews/user_preferences/entities/edges/push_subscriptions 全部 **0**；库内总 users 恢复为 2（非 QA）。
- 全局孤儿：attachments 孤儿 0、note_embeddings 孤儿 0。
- R2：8 个用户前缀 `media/<uid>/` 对象数全部 **0**（含 bk1 附件、bk2 恢复附件、ui 离线补发图片）。
- 向量：可用凭证无 Vectorize API 权限（【未验证】直查）；仓库 wrangler.toml 中 VECTORIZE 绑定为注释态、嵌入存于 D1 `note_embeddings`（孤儿 0），间接判定无向量残留（【源码检查】+【生产实测】）。

## 8. 建议修复优先级（供 R196）

1. **P1-1**：`fixFinanceDirection` 对 `parseLedgerCore` 命中的多行台账跳过词面方向兜底（或行级判定）；补「负数行×方向」组合单测。
2. **P1-2**：追问路径收紧引用忠实性——标签等元数据不得作为事实来源；零依据商家/地点类追问统一 fail-closed。
3. P2-1：关键词聚合命中「台账多笔合计」且问句含行级实体时，转行级明细作答。
4. P2-2/P2-3：chips 加 `aria-pressed`；`--primary` 对比度 ≥4.5:1（一次消除 21 处 serious）。
5. P3-1/P3-2/P3-3：双导航 landmark 唯一化；probe=bridge 去掉 detail 公开暴露；矛盾附注与「什么牌子」半答问题。

——审查完毕。本报告为只读审查产物，未改任何产品代码与生产配置；GitHub Actions 保持禁用。
