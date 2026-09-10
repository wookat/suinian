# decision-r343：锁具取值问——「密码锁」抹称谓不抹「锁」（R340 概念后缀与 R337 拆句的交叉回归）

日期：2026-09-09 · 基线：#404（R342）分支 · 状态：已实施（仅 `conceptualLabelFree` 替换回调 1 行 + r343 单测）

## 1. 一手证据

把待合并队列 #392 → … → #402 → #403 → #404 按顺序合到本机模拟树（无文本冲突）后全量 vitest，唯一失败：

```
FAIL test/r337-compound-split.test.ts
P12 行李箱密码锁的数字和托运限重各是多少
AssertionError: expected null not to be null
```

逐层探针（同一问句，两棵树）：

| 树 | isSecretValueQuestion | isOracleProbeQuestion | splitCompoundQuestion |
| --- | --- | --- | --- |
| 仅 R337（#394） | true | true | guarded=[行李箱密码锁的数字是多少] plain=[托运限重是多少] |
| 合并 R340 之后 | **false** | true | **null** |

R342 分支上再拆到问句层（`conceptualLabelFree` 输出 → 判定）：

```
行李箱密码锁的数字是多少   → "行李箱 的数字是多少"   secretValueQ=false  oracle=true
行李箱密码锁是几           → "行李箱 是几"           secretValueQ=false  oracle=false   ← 走普通生成
储物柜密码锁设的几位数是啥 → "储物柜 设的几位数是啥" secretValueQ=false  oracle=true
行李箱锁是几               → 原样                    secretValueQ=true                  ← 同义句却是取值问
密码锁密码多少             → " 密码多少"             secretValueQ=true
```

## 2. 根因

R340 §3.3 为了让「密码锁多少钱」「那把密码锁什么型号」不被当取值问，把「锁」加进了 `CONCEPT_SUFFIX_SRC`，于是 `conceptualLabelFree` 把「密码锁」整词抹成空格。结果问句里**锁具称谓本身**也没了：`RESIDENCY_QUESTION_LABEL_RE`（含 `锁`）命不中，`isSecretValueQuestion` 直接 `labeled=false`。而 R340 真正用来区分「问锁的值」与「谈论锁具」的是 `LOCK_OBJECT_TALK_RE`（钱 / 价 / 牌子 / 型号 / 买 / 修 / 坏 / 钥匙 …），它根本没机会生效——「密码锁」路径和「行李箱锁」路径口径不一致。

R337 的拆句器只对「至少一个子句是取值问」的复合句拆分，P12 的凭据子句判定翻成 false 后 `splitCompoundQuestion` 返回 null，整句回落 R324 预言机中性分支（无泄漏，但普通子句「托运限重」不作答，正是 R337 要修的用户面问题）。

「行李箱密码锁是几」更差一步：oracle 也命不中 → 走普通生成。守值靠模型视图（`unitCarriesGuardedValue` 仍 true，行被占位）与答案归一化复查兜住，不泄漏，但用户拿不到「已守值 + 折叠卡」的一致体验。

## 3. 修法（最小面）

`conceptualLabelFree` 的替换回调：概念后缀为「锁」时只抹称谓词、保留「锁」；其余后缀（学 / 课 / 管理 / 长度 / 箱 / 本 …）行为不变。

```ts
- return text.replace(CONCEPT_LABEL_RE, " ");
+ return text.replace(CONCEPT_LABEL_RE, (m) => (/锁$/u.test(m) ? " 锁" : " "));
```

这样「密码锁 X」和「行李箱锁 X」进入同一条判定：`RESIDENCY_QUESTION_LABEL_RE`（锁）命中 → `LOCK_OBJECT_TALK_RE` 排除谈论锁具 → `VALUE_ASK_RE` 看是否问值。

否定的备选：
- 在 `LOCK_OBJECT_TALK_RE` 或 `isSecretValueQuestion` 加「数字 / 几位 / 组合」专项分支——等于为「密码锁」再造一套口径，仍与「行李箱锁」两套并存。
- 从 `CONCEPT_SUFFIX_SRC` 删掉「锁」——R340 Y05/Z 族「密码锁多少钱」会回退成称谓+取值面判定（R340 §3.3 一手证据），且笔记侧「买了一把密码锁 89 元」也会重新进入称谓判定。

## 4. 修后探针（R342 分支）

```
true  行李箱密码锁的数字是多少 / 密码锁的数字是多少 / 行李箱密码锁是几 / 储物柜密码锁设的几位数是啥 / 密码锁的组合是多少 / 密码锁密码多少 / 行李箱锁是几
false 行李箱密码锁多少钱 / 密码锁什么牌子 / 那把密码锁什么型号 / 密码锁坏了怎么办 / 密码锁的钥匙在哪 / 密码锁怎么改密码
```

边界（如实记）：「密码锁一般是几位数」修前 oracle=true（中性分支），修后 secretValueQ=true（取值闸门）——两者都不直答，用户面无回退；这是「几位数」问法在 R334 起就 fail-closed 的既有口径。

笔记侧零变化：`行李箱密码锁 0-7-3` / `4471` / `设成了 2046` 仍 residency+carry+broad 折叠；`买了一把密码锁 89 元` / `密码锁换了个新的` / `密码锁一般 3 位转盘` 仍不受守不折叠（`structuralValueFace` 分支在这些行上的走向没变，只是无值面行的抹除结果多了一个「锁」字，后续称谓判定对「锁 + 无值」不触发）。

## 5. 复验

- 本分支：`npx vitest run`（全量）、`tsc --noEmit`、qa-r340 静态探针 18/18 + 40/40、非 answer 出口 0/40 漏 + 0/18 误伤、qa-r336 探针 34/34 + 18/18。
- 合并模拟树（#392 → … → #404 + 本补丁）：r337 / r340 / r336 / r341 / r342 / r343 单测 222/222，全量 vitest 见 PR。
- 生产 suinian-api 仍被删未恢复，本轮仍是本机静态证据；REST/SSE/MCP 出口与真实模型对 P12 的合并渲染待恢复后补。

## 6. 教训

跨 PR 的判定层修改（R337 在问句层拆句、R340 在称谓层抹词）各自本地全绿不等于合并后全绿——以后每开一个判定层 PR，先在本机把待合并队列顺序合一遍再跑全量，再宣本地全绿。
