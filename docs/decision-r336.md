# decision-r336 —— R335 §14 双侧修复的设计论证

对应审查：`docs/audit-r335.md`（双 NO-GO）。基线 main `6bad5dd`。本文先给证据与判定层根因，再给函数级最小修改面、族外语料与验证口径；代码只在论证通过的面上动。

## 0. 结论先行

| # | R335 确证问题 | 根因层 | R336 处置 |
|---|---|---|---|
| 1 | no-answer 分支 `notes[]` 未占位 | `index.ts` 7 处 refNote 序列化绕开 `askGuardedRefNoteJson` | 全部改走同一 guarded 判定（含财务聚合的 `noteToJson` 直传） |
| 2 | 线索图谱把口令值提成实体 | `graph.ts::extractGraph` 只看 `is_sensitive`；出口 `getThreadGraph / graphExpand` 无过滤 | 抽取前接 `unitCarriesGuardedValue`（与引用卡同一判定）；实体名二次过滤；出口按同一判定 fail-closed；桥接查询不带受守实体名 |
| 3 | 善意 83 条仅 50 中 | 不是缺白名单，是三处判定层缺陷（§2） | 逐族修判定：取值引导误判散文、称谓概念词、识别符豁免未落到最终判定 |
| 4 | 「密码学课笔记 / API key 文章」整单元占位 | `secretValueFace` 的 CJK 取值引导 `是…` 把「今天讲了…」当值；`CREDENTIAL_VALUE_LABEL_RE` 把概念词当称谓 | 概念词后缀剥离（无结构值面时）+ 取值引导排除散文标记 |
| 5 | 取件码/车牌/订单号承诺豁免实测占位 | `shortValueExempt` 只认「识别符标签紧邻值」的形态，`车牌 沪A·12345`、`端口改成了 2222` 落网；取件码则是 R334 有意为之 | 识别符词出现在同一短语窗口即豁免（无凭证标签同现时）；取件码：改承诺（保留 R334 称谓驻留守值，known-issues 从「有意豁免」名单中移出，见 §2.4） |
| 6 | 折叠计数句 0/9 | 只在「敏感卡漏引」时补句；已被引用的敏感/受守卡不补计数 | 生成出口按实际折叠卡（sensitive / guarded）统一补计数句 + 角标去重 |
| 7 | 同会话连续问陈旧占位卡 | 前端逐消息保存 refs、无缓存复用（§4 排除前端）；后端 `isSecretValueQuestion(q, historyText)` 只要历史里出现过「密码」字样，后续任何含「什么/多少」的问句都算取值型问句，把上一轮的受守卡重新拉成占位卡 | 历史只在**追问形态**（指代 / 再 / 第 N 位 / 变换）下借出称谓 |

## 1. 证据（一手，本机静态探针 `backend/scripts/qa-r336/static-probe.ts` 前身）

对 R335 语料逐条跑 `directGuardLines / guardFoldReason / residencyTriggered / sourceValueCandidates / unitTalksAboutSecret / unitCarriesGuardedValue / isSecretValueQuestion`：

```
G04 车牌 沪A·12345            dg=[] res=false cands=[opaque:12345]        gv=true   ← 候选层放行失败
G12 酒店订单号 HT20260912A8    dg=[opaque] fold=null                       gv=true   ← lineCarriesOpaqueToken
G17 快递柜取件码 482913（…）   res=true cands=[opaque:482913,…]            gv=true   ← 驻留标签含 取件码
G47 SSH 端口改成了 2222        cands=[opaque:2222]                         gv=true   ← 操作提示词路径无识别符豁免
G51 身份证号 1101…1234         dg=[credential] fold=broad:credential       gv=true   ← SECRET_LABEL_RE 含 身份证号
G52 银行卡号 6222 0212 …       dg=[credential] fold=broad:credential       gv=true   ← SECRET_LABEL_RE 含 银行卡
E01 密码学课笔记：今天讲了…    dg=[credential] fold=broad:credential       gv=true   ← secretValueFace 命中 「是 跑了/讲了…」类散文
E02 …API key 管理…文章          dg=[] gv=false 但 valueQ=true                          ← 问句「那篇 API key 文章讲了什么」被判取值型
E06 储物柜的密码今天忘带了，还是跑了 3 公里   dg=[credential]                       ← 「还是 跑了 3 公里」被 CJK 取值引导当成值
```

三条结论：
1. `unitCarriesGuardedValue` 把 `sourceValueCandidates` 的任意 kind（含 `opaque`）视为受守，而 `opaque` 正是识别符类候选的降级去处——候选层「降级」与最终判定「一刀切」自相矛盾，这是 G04/G47 的直接根因。
2. `secretValueFace` 的 `CJK_VALUE_LEAD_RE`（`是|叫|为|改成|还是… + 汉字串`）不区分「是 木石田」（口令）与「是跑了 3 公里 / 今天讲了 RSA」（散文）。
3. 称谓判定（`SECRET_LABEL_RE / CREDENTIAL_VALUE_LABEL_RE / ORACLE_LABEL_RE`）对「密码学 / API key 管理 / 密码策略」这类**概念词**与「路由器密码」同权。

## 2. 判定层修复（不加样例白名单）

### 2.1 概念词剥离 `conceptualLabelFree(line)`
称谓紧跟概念后缀（学|课|作业|讲座|论|史|原理|算法|管理|策略|规则|规范|政策|要求|轮换|泄露|安全|强度|复杂度|生成器|文章|书|讨论|话题|培训|课程|考试 / management|policy|rotation|hygiene|strength|manager|leak|best practice|article|course|lecture|theory）且**本行没有结构值面**（无 ≥4 位数字串、无含数字的 ASCII token、无 `key=value` / 引号取值）时，把「称谓+后缀」整体从行内抹掉再做称谓判定。有结构值面时不剥离——`密码重置成 Xk9!p2` 仍按称谓+值守。
应用点：`secretLabelLine / secretLabelValueLine / secretValueFace 的 label tail / unitCarriesSecretLabel / isSecretValueQuestion / guardedLabelAnchor / isDeterministicRecallProbe`。

### 2.2 CJK 取值引导排除散文 `cjkLeadValue(tail)`
`是/叫/为/改成/设成…` 引导的汉字串若含散文标记（了|着|过|吗|呢|吧|和|与|或|但|而|就|都|也|很|会|要|讲|说|等|因为|所以|然后|时候|需要|可以|应该|已经|今天|明天|昨天|上周|下周|每|次|公里|小时|分钟）则不算取值面；`改成了 青山绿水` 的前导「了」先剥再判（否则「改成了」形态漏守）。「还是」前接 或/要/不/若/才/也/倒 时不算引导。真口令短语（明月松间照 / 天王盖地虎 / 木石田）都不含这些标记。

### 2.3 识别符豁免落到最终判定
- `shortValueExempt`：识别符词（取件码|验证码|会议号|订单号|单号|运单|快递|车牌|卡号|账号|工号|学号|编号|序号|房号|门牌|邮编|航班|座位|电话|手机|号码|尾号|端口|port）出现在值前 12 字窗口且窗口内**无** `SECRET_LABEL_RE / RESIDENCY_LABEL_RE` 时豁免（`银行卡号 6222…` 因 `银行卡` 是 SECRET 标签不豁免——见 2.5）。
- `unitCarriesGuardedValue`：`sourceValueCandidates` 只有 `credential` kind 才守；`opaque` kind 单独不足以整单元占位（它们仍受出口归一化比对 `normalizedGuardedLeak` 的纵深覆盖，且驻留/锁具/直接受守行三条路径不变）。
- `directGuardKindOfLine`：`lineCarriesOpaqueToken` 命中的行，若 token 前 12 字含识别符词且无凭证/驻留标签 → 不算 opaque（G12 `酒店订单号 HT20260912A8`）。

### 2.4 取件码：改承诺（不改行为）
R334 §2.6 把「取件码」列入驻留标签是为了 qa-r333 C24（`取件码 ７３９２５１０`）的**称谓驻留**口径，但 `docs/known-issues` 把取件码列在「有意豁免」名单里；R335 §8.3 实测 G17 占位。本轮先试过「修行为」（把 `取件码` 从 `RESIDENCY_LABEL_RE` 移出）：`r334-label-residency / r330-short-credential / r332-closure / r328-output-closure` 四个既有套件同时失守——C24 候选消失、快递柜取件码的出口比对判漏、算术 / 位数属性提示重新可算，这些不是「样例断言」而是 R333 生产实测的泄漏面（audit-r333 §3 取件码 C24 为跨出口漏值案例）。取件码与门禁码同属「要输入设备的短码」，被人拿到就能取走包裹，且与「快递柜」可上锁对象同现——按 R330 可上锁对象行口径本就该守。**结论：保留守值（answer 记号级占位 + 引用卡整卡占位），改文案**：`docs/known-issues.md` 把取件码从「有意豁免」名单移出、明示「取件码 / 快递柜码按凭证守」；`shortValueExempt` 的识别符族保留 `取件码` 一词只用于「无凭证 / 驻留标签同现」的窗口判定（`RESIDENCY_LABEL_RE` 含取件码，故实际总是被驻留路径先接住）。qa-r336 L03 计为「设计内扣留」。

### 2.5 身份证号 / 银行卡号（G51 / G52）：**不改行为，改承诺**
两者是「个人证件/账户号码」，虽非登录凭证但外泄后果接近凭证（可用于身份冒用/转账验证），R334 之前一直按凭证守。R336 保留守值，known-issues 明示「证件号 / 银行卡号 / 社保卡号按凭证守」——R335 G51/G52 计为「设计内扣留」而非误伤。

### 2.6 问句侧历史借称谓收窄（问题 7）
`isSecretValueQuestion(q, historyText)` 的历史分支改为：历史含称谓/受守锚点 **且** 当前问句是追问形态（`那|它|这个|上面|刚才|之前|再|呢|一遍|第 N 位|倒着|拆|逐字|每位|大写|拼音|翻译|编码|换成|改写|念|读`）。`再念第 2、4、6 位` 仍命中；`我的航班号是多少`、`班主任电话是多少`、`下周三交什么作业` 不再因上一轮问过密码而被判取值型（修前函数级复现：`isSecretValueQuestion("我的航班号是多少？", <含占位答复的 history>)` = true，修后 = false；`isDeterministicRecallProbe` 的历史分支本就要求「几位 / 长度」类预言机形态，不受影响）。

## 3. 出口修复

### 3.1 refNote 序列化统一（index.ts 7 处）
4584（财务聚合 `noteToJson`）、4836、5024、5209、5371、6024 全部改 `askGuardedRefNoteJson(n, askGuardNoteUnit(n), cross)`，`cross` 取该分支候选集的 `crossUnitGuardedLines`。5139 敏感卡分支 `askRefNoteJson` 对 `is_sensitive` 行与 guarded 版等价，保留。`safeSuggestionLabel`（no-answer 建议标签）的受守判定同样从 `directGuardLines` 扩为 `|| unitCarriesGuardedValue`。

### 3.1.1 生产候选实测追加（out-cand-a7cbb80 → bae75a5）
候选版 `NA4`「帮我找找和 Gmail 有关的笔记」direct/agg 两格 `notes[]` 卡片仍带原文（`Gmail: quiet.river.88 / Tq8#vL2m`，`withheld=false`）。函数级复现：`unitCarriesGuardedValue` / `directGuardLines` 对该单元均为受守（`opaque`），即**判定层已正确**，漏点在 `/api/ask` 处理器内 14 个确定性分支（关键词枚举 `tRefRows`、统计 / 清单 / 时间线 / 财务 / 联系人 / 待办 / 清藏 / 主题等）的 `notes: rows.map(noteToJson)` 直传——§3.1 只改了 6 处 `askRefNoteJson`，漏掉了这批 `noteToJson`。修法同口径：全部改 `askGuardedRefNotes(rows)`（内部逐行 `askGuardNoteUnit` + `crossUnitGuardedLines` 判定），并加源码级断言（`r336-dual-side.test.ts`：`app.post("/api/ask")` 体内不得再出现 `notes:` 行直传 `noteToJson|askRefNoteJson`，唯一例外是 `sensRecall.rows`——全为 `is_sensitive=1`，`askRefNoteJson` 对其固定输出加密占位）。复测 `bae75a5`：security 82 格 leak=0、qa-r335 安全全出口 188 格 leak=0 / oracle 26 格 differential=0 / outlets 16 格 / MCP 52 格均 0。

### 3.1.2 分拣层自动标敏不在本轮修复面（如实记录）
候选 benign 组 34 条非边界善意笔记中 `L04`（SSH 端口 2222）、`N03`（改路由器密码后重连打印机）、`N05`（保险柜密码记在日记本）、`N08`（序列号 XXXX-YYYY-ZZZZ 已激活）在写入 40s 后被**分拣**判为 `is_sensitive=1`（两次候选跑分别 3 条 / 4 条，`N05` 不稳定）。`triage.ts` 的正则兜底 `detectSensitive` 对这四条都不命中（`密码改过了` / `记在日记本` 不是赋值连接词，`端口` 不是称谓），标敏来自**降级模型**的 JSON 判断；问答层随后按用户/分拣标记折叠属设计内（标记优先）。这不属于 audit-r335 §14 的问答判定层修复面，且主模型未验证，留待 `degraded:false` 后用同一语料复核；本轮不改分拣提示词。

### 3.2 图谱三道
- 抽取：`extractGraph` 在模型抽取前 `unitCarriesGuardedValue(askGuardNoteUnit(note))` → 删图 + 标记已抽取；抽取结果实体名/别名再过 `graphNameGuarded`（自身 `unitCarriesGuardedValue || directGuardLines.length>0`）。
- 出口：`getThreadGraph(env, userId, notes)` 用同一判定过滤实体/关系/mentions（历史脏数据 fail-closed）；`graphExpand` 的桥接查询与 triples 只用通过过滤的实体名。
- 存量：不做离线删表清洗，改为**出口过滤 fail-closed**（上一条）——存量脏实体即使仍在 `entities` 表里也不会再出现在 threads/:id、MCP list_threads、`graphExpand` 桥接查询任何出口；生产基线只有 `u_boss` 6 条笔记，终版用 wrangler d1 只读核对其 `entities` 无受守值即可（不改 `u_boss` 任何数据）。
- 边界（与基线 main 相同，不属本轮回退）：无任何凭据称谓、也不与可上锁对象「设/用/是」同现的短值（`健身房柜子那组 SKY云3q`）在基线上 `unitCarriesGuardedValue` 亦为 false，图谱同一判定自然也不守——这正是 known-issues「无称谓短值请标敏感」承诺；本轮不为它扩大守值面（会重新吞掉 L 族日常识别符）。

### 3.3 计数句 + 角标去重
生成出口 `refNotes` 计算完成后：`folded = refNotes.filter(n => n.content_withheld)`；若 `folded.length>0` 且答案里尚无计数句 → 追加 `其中 N 条引用为敏感/受守笔记（正文已折叠，AI 不复述），点开引用卡片查看原文[i]…`。`references` 按 `note_id` 去重（保留首个 index），答案文本里重复 `[n][n]` 折叠为一个。

#### 3.3.1 终版 8b3c3de 生产实测追加（out-final-8b3c3de）
候选 bae75a5 fold 9/9 里 F02 的第 3 条善意笔记（「两个邮箱都开了两步验证…」）被分拣层降级模型误标敏感，实际走的是 `sensitiveCardsBody`（自带计数句）；终版部署后分拣未误标，同题走 **生成前预言机中性分支**（`oracleGate` → `ORACLE_NEUTRAL_NOTICE + 角标`），2 张折叠卡 0 计数句（fold 6/9）。根因：§3.3 的追加只挂在生成出口，生成前的三个确定性占位返回（预言机中性 / 取值扣留 `DIRECT_GUARD_PLACEHOLDER[kind]` / 出口层裸是非改写）各自拼 `占位 + 角标`，没有走同一条计数句。修法：抽 `withFoldedRefCount(answer, references, refNotes)`，四处共用；`sensitiveCardsBody` 自带计数句（`FOLDED_REF_COUNT_RE` 命中不重复追加）。静态单测锁定 index.ts 内不再有 `ORACLE_NEUTRAL_NOTICE / DIRECT_GUARD_PLACEHOLDER[kind]` 直拼角标的 answer。
F02 `fact=false`（两步验证事实未答）为预言机中性分支的既定 fail-closed 行为（问句同时是取值问 + 对含口令单元的是非问），不在本轮改。

## 4. 问题 7 的前端排除证据
`web/src/components/ask-chat.tsx`：refs 逐消息保存在 `AskChatMessage.refs`，渲染 key 为 `m.id`（`crypto.randomUUID()`）；`askStream` 为 POST 不经 SW/HTTP 缓存；`selectAskContext` 只挑 10 分钟内非 error 消息进 history。前端无任何跨消息复用引用卡的路径 → 陈旧卡只能来自后端对 `history` 的使用。后端 `historyText` 参与 3 处：`isDeterministicRecallProbe`、`isSecretValueQuestion`、`sensitiveRecallTerms`。前两处按 §2.6 收窄；第三处 R332 已按本轮话题词收窄。复现方式：REST `history=[{user:"路由器密码是什么"},{assistant:"〔…占位…〕[1]"}]` + 问「我的航班号是多少」 → 修前判成取值型问句（函数级复现见 §2.6），召回里上一轮的受守卡重新以占位形态返回；修后直答。终版生产浏览器录屏同会话连续问验证。

## 5. 安全不回退检查面
answer 文本、SSE delta/done、MCP ask/notes[]、oracle differential、跨载体/跨笔记、照抄找回 3/3、泛「没找到」——沿用 qa-r335 `run.mjs` 的安全组语料 + qa-r336 新增族外安全组（`corpus.ts` `SECURITY`：路由器/口令短语/储物柜/保险柜/门禁/Gmail/银行预留/跨笔记拼合等新写法）。判定层松动点（2.2/2.3）都用这些语料反向验证：任何一条 `secretHits>0` 即回退该松动。

## 6. 验证计划
- 静态：`qa-r336/static-probe.ts` 对 `corpus.ts`（族外新造善意 + 安全）输出 `gv / talks / valueQ / dg` 矩阵，善意目标 ≥90% 直答（剩余逐条以 `boundary` 字段说明为设计内扣留：L03 取件码、K07 讲座 PIN 样例、K09 称谓驻留单元碰「出现在…哪一年」预言机形态、卡号形订单号），安全目标 100% 守。
- 预言机锚同样剥概念后缀（§2.1 应用点补 `isOracleProbeQuestion` anchored 分支）：「公司口令策略要求几位」是策略条款问句而非对某个口令的位数试探；「那串口令几位 / 路由器密码是几位 / 倒着念」仍为预言机形态。
- 单测：`test/r336-dual-side.test.ts` 覆盖 §2.1–2.6、§3.1（7 处 refNote 均 guarded）、§3.2（实体过滤）、§3.3（计数句/去重）、问题 7 两条回归（同会话不相关连续问）。
- 本机 runtime（mock AI）：`qa-r336/prod/run.mjs` 对 localhost 跑 REST/SSE/MCP 全出口（含 no-answer notes[]、图谱实体、oracle、照抄、泛没找到）。
- 生产候选：同脚本对生产跑（先 `/health?probe=ai` 记 degraded；degraded:false 时同一矩阵即为主模型口径）。
- 终版：合并 → deploy-sync → SHA 三同 → 同矩阵重跑 + 浏览器录屏（同会话连续问）+ D1/R2 基线 + 清理。

## 7. 明确不做
- 不新增任何样例白名单；不改任何既有测试的断言（C24/BR03 保持受守，见 §2.4）。
- 不启用 Actions；不直推 main。
