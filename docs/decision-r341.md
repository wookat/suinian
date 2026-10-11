# decision-r341 —— 报告 / 线程 / 复盘的模型视图补 ask 同款 fail-closed（三轮语料 106 条安全 × 非 answer 出口）

基线 main `b37b8d1` + R340（#402，含 §3.4）。R340 §3.4 用 60 条语料查了三条非 answer 出口后只补了转盘一族；本轮把
R335（盲测 `blind-corpus.mjs`）+ R336 + R340 共 **106 条安全笔记 / 137 条善意笔记** 全部过同样三条出口
（列表 / 报告行标题折叠、叙述模型视图、聚合闭合），按 R335 §14「answer 出口守住 ≠ 其他出口守住」逐条对账。

## 0. 结论先行

| 出口 | 修前（9094e1e） | 修后 | 说明 |
|---|---|---|---|
| 聚合闭合 `closeAggregateOutlet` | 0/106 漏 | 0/106 | 无改动 |
| 叙述模型视图（报告 / 线程 / 复盘） | **1/106 漏**（R336 P12） | 0/106 | 补 ask 已有的归一化比对 fail-closed（R324 B） |
| 列表 / 报告行标题折叠 | 14/106 未折（12 条裸不透明串 + P05 + P12） | 不改 | 见 §3：这是卡片默认折叠（UX 层），不是安全边界；接驻留 / 行级 own 进宽判据会撞 R336 §2.3 识别符承诺 |
| 善意 137 条 | 模型视图误伤 0（边界 K07 / L09 除外） | +2（E13、G17＝L03 同文） | 与 ask 出口误伤集合完全一致（同一判据），不是新增判定 |

## 1. 一手证据（`scripts/qa-r336/_outlets-tmp*.ts`，临时探针，未入库）

```
--- 安全：宽判据 null（列表标题原文展示）
P05 res=true  own=opaque | "Gmail: quiet.river.88 / Tq8#vL2m"
P12 res=true  own=       | "宿舍柜子的锁改成了 0731"
Q02 res=false own=opaque | "Hq7!zR2wT9pL"
r335:A01/A03/A04/A06/A09/A16/B03/B06/B08/A02#1  own=opaque   （裸不透明串一族）
r335:A02#0 own=          | "路由器管理后台的密码我等下单独记一条，别弄丢"   （无值，本就不该折）
安全总 106：宽判据未折 14，其中 residency 可补 2，own 行可补 12

--- 安全：模型视图仍含原值
catch P12 red=0 | "宿舍柜子的锁改成了 0731"
安全 106：模型视图漏 1，fail-closed 可拦 1

--- 善意：fail-closed 会误伤
bd L03 / !! r335:G17  快递柜取件码 482913（今天下午前取）      ← R336 §2.4 设计内边界（取件码是设备短码）
!! r335:E13           账号：我要把微博账号注销掉，太浪费时间   ← residencyServiceKeyValue 把整句当值（ask 出口已有的同一误伤）
善意 137：fail-closed 误伤 2
```

## 2. 根因

`redactGuardedLinesForModel` 只替换 `directGuardLines` 的 own 行；P12「锁改成了 0731」是 **弱称谓 + 引导 + 4 位数** 的
驻留形态（`residencyAssignment`），没有行级 own 命中（`dg=[]`），于是原文进了叙述模型上下文。

ask 出口早在 R324 B 就为此加了第二道：`modelContextNoteText` 在替换后再跑 `normalizedGuardedLeak(text, [unit])`，
候选面含驻留值（`sourceValueCandidates`），比对得到就整条只留占位（`ask-context.ts:44`）。报告 `modelRowTitle`、
线程 `rebuildThreadSummary`、复盘 `reviewComment` 三处直接调 `redactGuardedLinesForModel(...).text`，没有这一道。
同一条笔记，ask 模型看不到、报告模型看得到——正是 R335 §14 的「出口不同口径」。

## 3. 方案（最小、同源）

- `prompt-armor.ts` 新增 `redactGuardedViewForModel(text, unit, extraGuarded?)`：先 `redactGuardedLinesForModel`，再
  `normalizedGuardedLeak(text, [unit])`，命中即 `{ text: MODEL_REDACTED_LINE, redacted: n + 1, withheld: true }`——
  与 `modelContextNoteText` 的 fail-closed 同一判据、同一占位文案。
- `reports.ts` / `threads.ts` / `review.ts` 三处模型视图改调新函数。ask 路径不动（它已有该层且顺序更细：替换 → 中和 → 截断 → 复查）。
- **不做**：把驻留 / 行级 own 接进 `broadFoldReason`。理由：(a) 折叠只决定卡片默认态与标题占位，安全边界是取值闸门 +
  受守行替换 + 出口闭合（源码注释 R324 A3 明写）；(b) 实测接入代价是 137 条善意里新折 3–6 条，且全部落在
  R336 §2.3 明示不折的识别符族（订单号 / 合同编号 / 护照号 / 取件码）和散文（E13 / E20），违背「不得靠加白名单」原则；
  (c) 12 条裸不透明串（`Hq7!zR2wT9pL`）是用户自己列表里自己的笔记，模型视图已占位、聚合已闭合，列表原样是笔记应用的正常态。
- E13「账号：我要把微博账号注销掉」是 `residencyServiceKeyValues` 把冒号后整个无空格汉语句当值（classes≥2 因含「，」）——
  ask 出口既有误伤，本轮只记录，下一轮单独论证（候选修法：冒号分隔的值若为纯汉字 ≥ 8 字且含句读则不算值）。

## 4. 复验口径

- 新单测 `test/r341-model-view-fail-closed.test.ts`：P12 三处模型视图占位；R336 + R340 安全语料模型视图零原值；
  普通善意（非 boundary）模型视图零占位（E13 属 R335 语料，另作显式边界断言，防止无声漂移）。
- 既有测试一字不改；`qa-r340/static-probe.ts` 模型视图列改走新函数。
- 生产 suinian-api 仍被删，本轮全部为本机静态证据。

## 5. 复验结果（本机静态）

- `r341-model-view-fail-closed.test.ts` 7 项：安全 106 条（R336 18 + R340 40 + R335 攻击 47 用例展开 48 条）模型视图零原值；
  R336 + R340 普通善意（非 boundary）视图即原文、redacted=0；R335 善意 79 条中仅 E13 / G17 两条 fail-closed（显式钉住）。
- `r340-out-of-family.test.ts` 70 项不变；R340 探针 18/18 + 40/40，非 answer 出口安全漏值 0/40、善意误伤 0/18；
  R336 探针 34/34 + 18/18、已知边界仍为 K07/K09/L03/L09 四条。
- typecheck 通过；全量 vitest / web lint+build / Android assembleDebug 见 PR 描述。
- 临时探针 `_outlets-tmp*.ts` 已删除，未入库。
