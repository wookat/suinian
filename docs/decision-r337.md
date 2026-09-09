# decision-r337 —— 复合问句（普通事实 + 凭据取值）拆句的设计论证（提案，未动代码）

对应记录：`docs/known-issues.md`「复合问句走预言机中性分支」（PR #392）、R336 test-report §7.5 / §9-3。基线 main `b37b8d1`。本文只做证据 + 根因 + 方案对比 + 验证口径；**代码待论证通过后再动**（SOP-02）。

## 0. 结论先行

| 现象（R336 生产录屏，主模型 swe-1.7，已验证） | 根因层（本机静态探针，已验证） | 提案 |
|---|---|---|
| 「家里 Wi-Fi 密码和我的航班号分别是什么」⇒ 只回中性核对提示 + 敏感卡，航班号不作答 | 整句被 `isOracleProbeQuestion(q,{anchored:true})` 判为预言机形态（`分别是什么` 命中枚举/逐位试探正则），走 `oracleGate()`，普通候选不进 `references` | 生成前对问句做**确定性拆句**：按 `、，；和/以及/还有/跟/与/分别` 切分并把共享谓语分配到各子句；逐子句复用现有 `isSecretValueQuestion / isOracleProbeQuestion` 判定；**只有凭据子句走闸门**，普通子句照常生成并引用普通卡；答案 = 普通子句回答 + 中性/占位行 + 折叠计数句 |
| 「路由器放在哪、两组密码是什么」⇒ 只回占位 + 敏感卡，路由器位置不作答 | 整句被 `isSecretValueQuestion` 判为取值型（`密码…是什么`），走 `valueProbe` 分支整体扣留 | 同上 |

安全不变量不变：凭据子句仍**不进生成**、候选值仍剥离、对/错候选同一输出；拆句是纯确定性字符串操作，不引入 LLM 环节（R322 生产实测：预言机链路上任何 LLM 环节都会让对/错候选走出不同路径）。

## 1. 一手证据

### 1.1 生产（b37b8d1，主模型口径，浏览器录屏 `r336-b37b8d1-primary-swe17-edited.mp4`）

- 步骤「Wi-Fi 密码 + 航班号」复合问：answer 只有 `〔核对提示：…〕[1]`，`references` 仅敏感卡；航班号（普通笔记）零引用、零作答。
- 步骤「路由器位置 + 两组密码」复合问：answer 只有类别占位 + 角标 + 计数句；路由器位置（普通笔记）零引用、零作答。
- 两步均**无泄漏**（answer / notes[] / SSE 无口令原值），属 UX 缺失而非安全问题。

### 1.2 本机静态探针（`isSecretValueQuestion` / `isOracleProbeQuestion(q,{anchored:true})`，b37b8d1 源码直接调用）

```
"家里 Wi-Fi 密码和我的航班号分别是什么"      value=true  oracle=true   ← 整句：oracle 优先，走 oracleGate
"路由器放在哪、两组密码是什么"              value=true  oracle=false  ← 整句：走 valueProbe
"wifi密码是多少，还有下周去上海的航班是几号"  value=true  oracle=false
"路由器放在哪、密码是多少、宽带账号是什么"    value=true  oracle=false
--- 子句单独判定 ---
"家里 Wi-Fi 密码是多少"                     value=true  oracle=false
"我的航班号是多少"                          value=false oracle=false
"路由器放在哪"                              value=false oracle=false
"两组密码是什么"                            value=true  oracle=false
"下周去上海的航班是几号"                    value=false oracle=false
"办公室门禁多少"                            value=true  oracle=false
"会议室在几楼"                              value=false oracle=false
--- 谓语分配的必要性 ---
"家里 Wi-Fi 密码"（无谓语）                 value=false oracle=false  ← 拆句后若不把「分别是什么」分配回去，凭据子句会被漏判 ⇒ 不安全
--- 必须保持整体闸门的形态 ---
"wifi 密码和门禁码分别是什么"               value=true  oracle=true   ← 两子句皆凭据：拆后仍全部走闸门（结果与现状一致）
"保险柜口令的每个字分别是什么"              value=true  oracle=true   ← 单凭据逐字试探：不含并列连词，不拆（与现状一致）
"那串和航班号分别是什么"                    value=true  oracle=true   ← 指代子句「那串」拆后仍命中 VALUE_ANAPHORA_RE ⇒ 闸门
```

结论：**现有子句级判定器已经能正确区分普通子句与凭据子句**；缺的只是「把复合问句拆成子句再判」这一层。根因不是 fallback 关键词抽取（R336 报告 §9-3 已修正此前推断）。

### 1.3 根因定位到正则

`prompt-armor.ts` 预言机枚举形态正则含 `分别(?:出现|是几|是什么|是哪)`（原意：「口令的每个字分别是什么」逐位试探）。「X 和 Y 分别是什么」这一最常见的中文并列问法与之同形，被整句判为逐位试探 ⇒ `oracleProbe=true` ⇒ `oracleGate()` 在生成前短路。`valueProbe` 分支同理：`VALUE_ASK_RE` 只要在整句任意位置命中「是什么/多少」且句中任一处有凭据称谓即整句取值。

## 2. 方案对比

| 方案 | 做法 | 安全 | UX | 结论 |
|---|---|---|---|---|
| A. 确定性拆句 + 逐子句判定（提案） | 生成前 `splitCompoundQuestion(q)` → 各子句复用现有判定 → 凭据子句集合走闸门（现有 `oracleGate/valueProbe` 逻辑不变，只把输入换成凭据子句拼接）；普通子句集合走现有生成链路（召回/改写/生成全部只看普通子句）；出口合并 | 凭据子句链路与现状逐字相同；普通子句链路不接触受守卡（受守卡从普通链路候选中整条剔除，沿用 `offTopic` 现有 drop 逻辑） | 普通事实作答 + 普通卡引用；凭据部分仍中性/占位 + 计数句 | **采用** |
| B. 不拆句，只放普通候选进 `references` | 闸门分支里把 `plainOnTopic` 一并塞进 references | 需在闸门分支里加入普通卡，但 answer 仍是中性文案，用户拿到卡却无回答 | 半吊子：有卡无答 | 否 |
| C. 让模型作答后出口守值 | 复合问整句进生成，靠出口层 `verbatim closure` 兜底 | 违反 R320 B1 / R322 B「凭据取值/预言机形态不进生成」不变量；对/错候选会因模型抖动走出不同路径 | — | **否（安全回退）** |
| D. 改 `分别…` 正则排除并列 | 只修 oracle 误判，`valueProbe` 整句扣留仍在 | 只解一半，且削弱逐位试探识别 | 部分 | 否（可作为 A 的组成，不单独做） |

## 3. 方案 A 的函数级设计

### 3.1 `splitCompoundQuestion(q): string[] | null`（新增，`prompt-armor.ts`）

- 输入 NFKC 归一后的问句（**先** `stripOpaqueTokens`，候选值里的顿号/逗号不参与切分——O02 教训）。
- 切分符：`、` `，` `；` 以及连词 `和|以及|还有|跟|与|及|和\s*我的|then|and`；仅在**两侧都含 ≥2 字实词**时切；遇到 `每个字|每一位|第\s*N\s*位|逐字|逐位|哪几个字` 等逐位形态**不切**（保持整句预言机）。
- 共享谓语分配：句尾谓语（`分别是什么|分别是多少|分别在哪|各是…|是什么|是多少|在哪|几号|多少`）复制到每个缺谓语的子句尾部（§1.2「家里 Wi-Fi 密码」无谓语即漏判，这是安全前提）。
- 子句 < 2 或任一子句剥谓语后为空 ⇒ 返回 `null`（不拆，行为等同现状）。
- 纯字符串操作，无 LLM、无随机；同一输入恒同一输出。

### 3.2 `index.ts /api/ask` 接线（最小面）

```
const parts = metaQuestion ? null : splitCompoundQuestion(question);
if (parts && parts.length >= 2) {
  const guardedParts = parts.filter(p => isOracleProbeQuestion(p,{anchored:true}) || isSecretValueQuestion(p, historyText));
  const plainParts   = parts.filter(p => !guardedParts.includes(p));
  if (guardedParts.length > 0 && plainParts.length > 0) compound = { guardedQ: guardedParts.join("，"), plainQ: plainParts.join("，") };
}
```

- 有 `compound` 时：
  1. 现有 `oracleProbe / valueProbe` 判定与 `oracleGate()` / valueProbe 分支的**输入问句改为 `compound.guardedQ`**，其余逐字不变，但结果不 `return`，改为暂存 `gateResult`（answer 行 + references + refNotes + `value_withheld / oracle_neutral` 标志）。
  2. 普通链路（归一/改写/召回/生成）的输入问句改为 `compound.plainQ`；候选集在进入生成前剔除全部 `unitTalksAboutSecret` 与 `is_sensitive` 笔记（沿用 §5354–5371 现有 drop 代码路径）——普通链路**看不到**任何受守卡。
  3. 出口合并：`answer = plainAnswer + "\n" + gateResult.answerLine`，references 先普通后受守并重编号，`withFoldedRefCount` 统一补计数句、角标去重（R336 §3.3 已有）。响应带 `compound_split: true`、`value_withheld`/`oracle_neutral` 沿用。
- 无 `compound`（全普通 / 全凭据 / 不可拆）⇒ 与现状逐字相同。
- SSE / MCP `ask` / no-answer 分支共用同一 `compound` 结果与同一 `askGuardedRefNoteJson` 序列化（R336 §3.1 不变量）。

### 3.3 历史（多轮）

- 拆句只看本轮问句；`historyText` 仍原样传给凭据子句的 `isSecretValueQuestion`（R336 §2.6 追问形态借称谓不变）。
- 普通子句进 `rewriteAskQuestion` 时历史视图仍走 `rewriteHistoryView` 剥系统指引（PR #391）。

## 4. 安全不变量与风险（逐条）

| 不变量 | 拆句后如何保持 | 验证 |
|---|---|---|
| 凭据取值/预言机形态不进生成（R320 B1 / R322 B） | 凭据子句只进现有闸门分支；普通链路候选剔除全部受守/敏感卡 | vitest：mock 生成器断言其 prompt 中不含任何受守单元 |
| oracle differential = 0（对/错候选同一输出） | 拆句在 `stripOpaqueTokens` 之后；候选值不影响切分点；普通子句不含候选值 | qa-r335 oracle 26×2 差分复测；新增「复合 + 候选值」对/错对 |
| 逐位试探仍整句中和 | 含逐位形态不切（§3.1） | 静态探针「保险柜口令的每个字分别是什么」仍 oracle=true |
| 指代子句仍闸门 | 子句级 `VALUE_ANAPHORA_RE` 命中（§1.2 已验证） | 静态探针 |
| 无谓语凭据子句不漏判 | 共享谓语分配（§3.1）；分配后再判 | 静态探针「家里 Wi-Fi 密码」+ 分配 ⇒ value=true |
| 陈旧敏感卡不随普通话题带出（PR #390） | 普通链路 `recallSensitiveNotes` 输入为 `plainQ`；敏感卡只经凭据子句路径进入 | qa-r336 history S01–S04 复测 |
| notes[] / graph / SSE 出口 guarded（R336 §3.1/3.2） | 合并时 refNotes 全部经 `askGuardedRefNoteJson` | qa-r335 attack 188×2、qa-r336 security 82 复测 |

已识别风险（推断，待实测）：
- 切分误伤：「把密码和账号写在一起的那张便签在哪」——`和` 连接的是名词短语、整体是一个位置问；谓语分配后子句「密码在哪」会被 `RESIDENCY/VALUE_ASK` 判成取值 ⇒ 凭据子句走闸门、「账号写在一起的那张便签在哪」进普通链路。结果比现状（整句可能 valueProbe）不差，但需把此类语料放入族外语料评估误伤率。
- 长句多段（≥4 子句）：拼接后的 `plainQ` 可能改变召回；限制最多拆 3 段，超过不拆。

## 5. 验证计划（先静态、再本机、再生产）

1. 新增族外语料 `backend/scripts/qa-r337/corpus.ts`：族 P（普通 + 凭据并列，≥20 句，含 `和/以及/还有/、/，/分别/各`、含指代、含候选值、含逐位）、族 Q（全凭据并列，须整体闸门）、族 R（全普通并列，须与现状一致）、族 S（名词并列非并列问，误伤评估）。**不得复用 R335/R336 语料宣 GO。**
2. 静态探针 `qa-r337/static-probe.ts`：逐句输出 `split / guardedParts / plainParts`，与人工标签比对，目标族 P 拆分正确率 100%、族 Q/R 与现状零差异、族 S 误伤率如实记录。
3. vitest：`r337-compound-split.test.ts`（切分器 + 接线 + mock 生成器 prompt 不含受守单元 + 出口合并计数句/角标）。
4. 本地全绿：vitest / typecheck / lint / web build / assembleDebug。
5. 生产候选：qa-r336 security 82 + history + fold + graph、qa-r335 attack 188×2 + oracle 26×2（要求 0 漏 / 差分 0）、新增 qa-r337 REST 矩阵；浏览器录屏复现 §1.1 两步须出现普通回答 + 普通卡 + 中性/占位行 + 计数句。
6. 主模型口径（degraded:false）与 degraded 口径各跑一轮并分别标注。

## 6. 明确不做

- 不改 `ORACLE_NEUTRAL_NOTICE` / `DIRECT_GUARD_PLACEHOLDER` 文案。
- 不让任何 LLM 参与切分或子句分类。
- 不放宽 `分别(?:是什么|…)` 逐位正则本身（单凭据逐字试探仍整句中和）。
- 不在闸门分支里「顺带」放行普通卡（方案 B）。

## 7. 前置条件（如实）

本提案的生产验证依赖 `suinian-api` Worker 恢复（2026-09-09 15:00 UTC 被账户级批量删除，见事故记录）。恢复前只能完成 §5 第 1–4 步（静态 / 本机）。
