# decision-r349：笔记侧结构判定在折简副本上做——繁体称谓 + 值 与简体同口径，返回行仍是原文

日期：2026-09-10 · 基线：#410（R348）分支 · 状态：已实施（`prompt-armor.ts` 十处调用点改判定输入，不新增正则、不改任何出口文本 / 存储 / 模型输入）

## 1. 一手证据（R348 分支静态探针 `/home/ubuntu/qa-r336-untracked/probe-r348-trad.mts`，116 条历轮语料整体转繁体）

R346（问句入口）/ R347（归因比对面）/ R348（答案归一化比对面）把三层比对都折了简繁，但**笔记单元自身的结构判定**
（这行是不是「称谓 + 值」、要不要驻留、值候选怎么抽）仍在原文 / NFKC 面上跑简体正则。繁体笔记 + 任何问法：

| 语料 | 笔记（繁体） | R348 结果 | 根因 |
| --- | --- | --- | --- |
| qa-r340 U04 | `門禁密碼（2046）` + 問 `門禁密碼是多少？` | `dg=[] gv=false talks=false` ⇒ 候选答案 `門禁密碼是 2046 [1]` **原样放行**（真实 ask 出口） | `directGuardKindOfLine` / `secretLabelLine` 在 NFKC 面跑 `SECRET_LABEL_RE`，标签表只有简体「密码」 |
| qa-r340 W04 | `錢包助記詞：apple river …` | `talks=false` ⇒ MCP notes[] / references 不守 | 同上（助记词标签） |
| qa-r340 W10 | `行李箱密碼鎖 0-7-3` + 問 `行李箱鎖是幾？` | `gv=false` 走普通生成 | `SOURCE_LOCK_CUE_RE` / 锁具称谓正则简体 |
| qa-r336 L02/L05/L07/L08 | `酒店訂單號 HT20260912A8` / `會議號 812 4471 0392` / `順豐運單 SF…` / `新車牌 粵B·7Q3K9` | 善意直答被换成 `〔凭证略〕`（4 条误伤） | `identifierContextWindow` 的日常识别符表（订单号 / 会议号 / 运单 / 车牌）简体，繁体标签旁的记号失去豁免 |

U04 是**真实取值泄漏**（取值问 + 原值原样出现在答案）；四条 L 族是**善意误伤**。两者同源：判定正则的字面是简体，
笔记是繁体。问句侧（R346）同一问题的对策已被证明有效——折一份副本判定，原文不动。

对照面：同一 116 条语料保持简体时 `[zh] 善意 52/52 · 安全 58/58 · 非 answer 出口漏 3/58（基线已知 title fold 口径）· 出口误伤 0/52`。

## 2. 方案

| 方案 | 结论 |
| --- | --- |
| A. 逐条给 `SECRET_LABEL_RE` / `RESIDENCY_LABEL_RE` / `SOURCE_LOCK_CUE_RE` / `SOURCE_IDENTIFIER_NEAR_RE` … 内联繁体别名 | R346 §2 已否：十几条正则 × 每个汉字的变体组合，漏一条即回到今天；且笔记侧比问句侧正则更多（≥30 条含汉字字面）。否 |
| B. 存储 / 召回时把笔记折成简体 | 改用户原文，返回卡片 / 标题 / 原文替换全部失真；且 `SUINIAN_ENC_KEY` 加密存储不允许二次改写。否 |
| **C. 在判定函数入口折一份副本，只用副本跑正则；输出（行文本 / 区间下标）沿用原文（采用）** | `foldHanVariants` 是逐字一对一（R347 字表 3334 对已过滤掉长度变化的映射），行数、行内下标与原文一一对应；正则字面不动，判定面统一为简体；简体输入是恒等（301 条历轮简体笔记判定表 diff 为空） |

### 2.1 为什么不是「入口简单折叠」（R348 §5 的担忧）

R348 时的担忧是：`directGuardLines` 返回的 `line` 会被出口拿去做原文替换 / LCS 比对，折叠后的行文本对不上原文。
本轮的做法是把**判定输入**与**返回文本**分开：`computeDirectGuardLines` 对每一行同时持有 `line`（原文）与 `judge`（折简），
只用 `judge` 判类别，`out.push({ line, … })` 仍是原文。其余九处调用点（见 §3）的返回值都是布尔 / 类别 / 拉丁记号 /
归一化候选，没有原文回写面，可以直接对入参折叠。

## 3. 修法（`backend/src/prompt-armor.ts`）

| 函数 | 改动 | 返回面是否含原文 |
| --- | --- | --- |
| `computeDirectGuardLines` | 判定在 `judged = foldHanVariants(unit)` 上做（`guardFoldReason` / `unitLabeled` / `directGuardKindOfLine`），`out[].line` 仍取原文行 | 是（原文行，未变） |
| `guardedValueCandidates` | own 行先折再抽取值候选 | 候选只进 `normalizeForLeakCompare` 比对（R348 已折） |
| `sourceValueCandidates` | 入参单元先折 | 候选只进归一化比对 / 拉丁记号提取 |
| `residencyTriggered` | NFKC 后折 | 布尔 |
| `unitCarriesSecretLabel` / `unitCarriesGuardedValue` | 标签 / 驻留 / 锁具载体 / 候选四路在折简副本上判；`crossGuarded` 行集合仍用原文比对（那是别的单元的原文行） | 布尔 |
| `broadFoldReason` | 入口折（`guardFoldReason` 经它调用） | 类别 |
| `directUnitValueTokens` | NFKC 后折（识别符豁免窗口在折简面判） | 拉丁记号（折叠不碰拉丁） |
| `opaqueTokenSpans` | 答案 NFKC 后折用于标签面判断与句切分；`source` 行同样折。区间下标沿用（一对一折叠长度不变，`nfkc.length !== answer.length` 的 fail-closed 分支保留） | 区间下标（对应原答案） |

未动：`normalizeForLeakCompare`（R348）、问句判定入口（R346）、归因 / 敏感召回（R347）、任何回显 / 模型视图 / 存储 / `foldHanVariants` 字表。

## 4. 验证（均为本机静态 / 单测证据；生产 suinian-api 仍被删未恢复）

- 116 条历轮语料整体转繁体（`probe-r348-trad.mts hant`）：善意 48→**52/52**、安全 55→**58/58**、非 answer 出口漏 10→**3/58**（与简体基线相同的 3 条 title fold 已知口径）、出口误伤 4→**0/52**；与简体 `[zh]` 逐项一致。
- 台湾用词变体 `tw`：51/52 —— 唯一差异 L04「SSH **埠**改成了 2222」（端口→埠是词汇差异不是字形变体，`改成了 2222` 触发驻留），本轮不处理、记为词汇边界。
- 301 条历轮**简体**笔记的笔记侧判定表（`directGuardLines` 类别/own、`unitCarriesGuardedValue`、`unitTalksAboutSecret`、`residencyTriggered`、`guardFoldReason`、`broadFoldReason`、候选值）base vs 本分支 diff：仅 qa-r340 **T03**（本身就是繁体笔记 `密碼：Ｍｚ８ｑＷ２`）多出一条重复候选，判定 0 翻转。
- 452 条历轮问句判定 diff：空。
- R340 探针 18/18、40/40、出口 0/40 漏、0/18 误伤；R336 探针 34/34、18/18：未回退。
- 新单测 `backend/test/r349-note-side-han-fold.test.ts`（4 条）在 R348 基线上 3 条失败（`門禁密碼（2046）` dg 为空 / `酒店訂單號` 落 opaque / `門禁密碼是 2046 [1]` 原样放行），本分支全过。
- 既有测试一字未改；`tsc --noEmit` 绿；全量 vitest 见 PR 描述。

## 5. 边界与后续

- 词汇级差异（埠 / 端口、軟體 / 软件、滑鼠 / 鼠标）不是字形变体，`foldHanVariants` 不覆盖；仅当它们出现在称谓正则里才有影响，目前只见 L04 一条，未修。
- 日文标签字（係 / 葉 / 証 / 効）沿用 R347 排除，R324 日文入口测试未回退。
- `opaqueTokenSpans` 的 `token` 字段只做拉丁 / 数字比对，折叠不会让它带上简体汉字；若将来有汉字 token 进入该字段，需改回从原答案切片。
