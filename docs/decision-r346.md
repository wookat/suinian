# decision-r346：问句侧汉字变体折叠——繁体 / 港台写法的问句与简体同口径

日期：2026-09-09 · 基线：#406（R344）分支 · 状态：已实施（仅问句判定入口：`foldHanVariants` + 四处接入；不改任何回显 / 模型视图 / 笔记侧判定）

## 1. 一手证据（R344 分支静态探针，`/home/ubuntu/qa-r336-untracked/probe-r346.mts` / `probe-trad.mts`）

对历轮语料里的取值 / 预言机 / 善意问句逐条做简→繁转写后过 `isSecretValueQuestion` / `isOracleProbeQuestion`，35 对里 **23 对判定不一致**：

| 方向 | 简体 | 繁体 | 实际走向 |
| --- | --- | --- | --- |
| 漏判（取值问走普通生成） | `wifi密码是多少` v=true | `wifi密碼是多少` v=false | 普通生成（模型视图占位 + 归一化复查兜住，无泄漏；口径与简体不一致） |
| 漏判 | `保险箱的密码是什么` / `储物柜密码？` / `门禁密码是几` / `密码锁转到几` / `备用码是什么` v=true | 繁体全部 v=false | 同上 |
| 误判（善意被判取值） | `密码箱多少钱` v=false | `密碼箱多少錢` v=true | 走取值闸门 ⇒ 占位 + 点开卡片，善意误伤 |
| 误判 | `门禁卡多少钱一张` / `VPN口令忘了怎么办` v=false | 繁体 v=true | 同上 |

复合问句（队列合并模拟树，含 R337）：`我的航班号和wifi密码分别是什么` 拆成 `{guarded:["wifi密码是什么"], plain:["我的航班号是什么"]}`；繁体 `我的航班號和wifi密碼分別是什麼` 返回 `null`（整句走预言机中性分支，普通子句不作答）。

**为什么会半边繁体**：笔记侧标签正则（`SECRET_LABEL_RE` / `RESIDENCY_LABEL_RE` / `CODE_LABEL_RE`）自 R3xx 起内联了繁体变体（`密碼|口令|門禁|保險櫃…`），所以受守笔记的**守值**不受影响（`probe-trad-notes.mts`：繁体笔记 `unitCarriesGuardedValue` 与简体逐条一致）。而问句侧十几条正则——`CREDENTIAL_VALUE_LABEL_RE`（部分）、`VALUE_ASK_RE`、`NON_VALUE_ASK_RE`、`LOCK_OBJECT_TALK_RE`、`ELLIPTICAL_NON_VALUE_RE`、`HISTORY_FOLLOWUP_RE`、`ORACLE_PROBE_RE`、`ORACLE_ANCHOR_RE`、`CONCEPT_SUFFIX_SRC`——只有简体；`RESIDENCY_QUESTION_LABEL_RE` 有繁体称谓但配套的 `LOCK_OBJECT_TALK_RE`（钱 / 价 / 寸 / 颜色…）没有，于是「密碼箱多少錢」的「錢」漏网 ⇒ 误判取值。

## 2. 方案比较

| 方案 | 结论 |
| --- | --- |
| A. 逐条正则内联繁体变体 | 十几条正则、几百个字面量，且每轮新增分支都要同步两份；R340→R344 已连续四轮在问句侧加分支，全靠人工同步不可持续，本轮的不一致正是这样漏出来的 |
| B. 引入 OpenCC 一类繁简库 | 词级转换会改变字符数与下标（「裡→里」一对一，但词库转换含多对多与地区词），与判定层大量依赖 `search()` 下标 / 长度阈值（省略句 ≤24 字、值区 6–12 字）的做法冲突；新增依赖 |
| **C. 问句判定入口逐字一对一折叠（采用）** | 一张字表（728 对）、长度与下标不变、只在四个判定函数入口调用；用户原文 / 回显 / 模型视图 / 引用卡不经过折叠；笔记侧一律不动 |

C 的边界如实写明：逐字表不覆盖词级地区差异（「網路 / 網絡」「軟體」）——这些词不在判定正则里，不影响口径；表里只收 R3xx 问句正则涉及的字及常见高频字，缺字时退化为 R344 现状（走普通生成 / 模型视图占位兜底），不会新增泄漏面。

## 3. 修法（`backend/src/prompt-armor.ts`）

```ts
const HAN_VARIANT_PAIRS = "萬万兩两個个為为…";           // 728 对，「繁 简」相邻
const HAN_VARIANT_MAP: ReadonlyMap<string, string> = …;  // 逐对建表，无重复键、无键同时是值（脚本核验）
export function foldHanVariants(text: string): string;   // 逐字一对一替换，长度不变

isOracleProbeQuestion:        const q = foldHanVariants(question.normalize("NFKC").trim());
isDeterministicRecallProbe:   const q = conceptualLabelFree(foldHanVariants(question.normalize("NFKC").trim()));
isSecretValueQuestion:        const q = conceptualLabelFree(foldHanVariants(question.normalize("NFKC").trim()));
  历史借称谓分支：            CREDENTIAL_VALUE_LABEL_RE.test(foldHanVariants(historyText.normalize("NFKC")))
```

- 折叠发生在 `conceptualLabelFree` **之前**：`CONCEPT_SUFFIX_SRC`（学 / 策略 / 管理 / 锁 / 箱…）是简体，先折叠才能正确抹掉「密碼學」「密碼策略」的概念后缀并保留「鎖 / 箱」实物名。
- `splitCompoundQuestion`（#394，本分支无该祖先，未改一字）的子句分类调用 `isSecretValueQuestion` / `isOracleProbeQuestion`，自动受益：队列合并模拟树上 8 对简繁复合问句 guarded / plain 分段数逐对一致。残余差异是 R337 自己的连词 / 共享谓语正则（`還有` 不剥、`分別是什麼` 不识别为共享谓语 ⇒ 普通子句「我的航班號」不补谓语），只影响子问句措辞、不影响分类与闸门；留待 #394 合并后在 R337 入口同样折叠一次（下一轮）。
- 不折叠的地方（有意）：`question` 原文进召回 / 生成 / 回显；`historyText` 只在 `CREDENTIAL_VALUE_LABEL_RE` 借称谓一处折叠，`conversationAnchorsGuarded` 走笔记侧标签（已含繁体）不动；笔记侧 `unitCarriesGuardedValue` / `residency*` / 折叠标题全部不动。

## 4. 验证（全部本机静态；生产 suinian-api 仍被删，REST / SSE / MCP 与真实模型未跑）

- 字表核验：1456 字 / 728 对，重复键 0，键同时是值 0（`node -e` 脚本）。（R347 为归因面把字表换成 zhconv 全单字表 3334 对，见 decision-r347 §2。）
- 字表覆盖口径（第 2 提交）：初版 412 对是人工按问句正则词汇列的；用 zhconv（仅本机核对工具，不进依赖）的单字 `zh2Hans` 表反查 `prompt-armor.ts` 全部 1561 个简体字的繁体变体，其中 319 个 TRADONLY 变体（`註銷 / 簽名 / 隱藏 / 溫度 / 狀態 / 匯款 / 録 / 綫 / 説`…）不在表内 ⇒ 补齐 316 个；`証 / 係 / 葉` 三个是日文标签正则里的字（`暗証`），折了会把日文取值问「書斎の金庫の暗証を教えて」折成 r324 用例不认的写法，故排除（规则：与假名相邻出现在代码正则里的汉字不进表）。与 zhconv 唯一不一致是 `帳→账`（zhconv 给 `帐`；本文件正则只有「账号 / 账户」，按正则词汇折）；`著→着 / 甚→什` 是问句判定专用折叠、zhconv 不折。补表后历轮 452 条问句判定 diff 为空、35 对探针仍 1 mismatch。
- 简繁配对探针：`probe-r346.mts` 35 对 mismatch 23 → **1**（`恢复码呢` 简繁均 false，R344 省略句只收强称谓的既有边界，非本轮回退）；`probe-trad.mts` 22 对 mismatch → 1（同一条）。
- 历轮 452 条问句（R335 盲测 / R336 / R340 语料 + ask-eval-data）R344 base vs 本分支判定 diff：**仅 R340 安全族 T03「密碼是什么？」false→true（正是本轮要修的漏判），善意 0 翻转**。
- R340 探针 18/18 + 40/40、非 answer 出口 0/40 漏 / 0/18 误伤；R336 探针 34/34 + 18/18（未回退）。
- 本分支 vitest 206 文件 / 4638 全绿 + 新增 `r346-han-variant-fold.test.ts` 5 用例；tsc 绿。
- 队列合并模拟树（#392→…→#406 + 本 delta，`git apply --3way` 干净）：tsc 绿、全量 vitest 210 文件 / 4710 全绿（含 R337 P12 拆句）；8 对简繁复合问句分段一致。

## 5. 不做 / 边界

- 不改回显、不改模型提示、不改笔记侧：折叠结果只活在四个判定函数的局部变量里。
- 日文汉字（「暗証番号」「合言葉」）与韩文不经折叠影响：表里的键都是繁体 / 异体，日文正则字面量（`パスワード|暗証番号`）本身不含表内键；`foldHanVariants("パスワード")` 恒等（单测）。
- 「恢复码呢 / 恢復碼呢」省略句均不判取值（R344 边界），如需收进属于 R344 `ELLIPTICAL_LABEL_END_RE` 的称谓范围问题，与本轮无关。
