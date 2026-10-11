# decision-r342 —— 「服务名：值」结构触发里冒号后的纯汉字句子不是取值（R335 E13 误伤根因）

状态：实施完成，本机静态验证；生产 suinian-api 仍被删，未生产复验。
前置：decision-r341 §3 把 E13 列为下一轮独立问题。

## 0. 结论先行

- R335 盲测善意 E13「账号：我要把微博账号注销掉，太浪费时间」在 ask 出口与 R341 三处模型视图上被整单元扣留，根因唯一：
  `residencyServiceKeyValues` 的冒号分支对任何 `\S{4,64}` 值只看「≥2 类字符 或 长度 ≥6」，纯汉字句子「我要把微博账号注销掉」
  （10 字）满足长度即被当成 opaque 取值，进而 `residencyTriggered` = true、`sourceValueCandidates` 出候选、
  `unitCarriesGuardedValue` = true。
- 最小修：冒号后的**纯汉字**值改按 R334 值区口径——6–12 字，且首 1–2 字不在 `RESIDENCY_HAN_STOP`（代词 / 虚词 / 指代）；
  其余分支（拉丁 / 数字 / 混合、空白分隔）一字不动。
- 四轮语料（R333 / R335 / R336 / R340，348 条）里走到「服务键 + 冒号 + 纯汉字」的只有 E13 这 1 条，安全侧 0 条依赖该分支：
  全部纯汉字守值（明月松间照 / 木石田 / 田七八九六 / 青山不改 / 三七零九一 / 我爱你）都由强称谓（口令 / 密码 / 暗号 / 保险柜）路径守住。

## 1. 一手证据（本机探针，未入库）

对 348 条语料逐行套 `residencyServiceKeyValues` 的正则，筛「值为纯汉字」：

```text
benign   r335:E13#0  sep=:  han=10  v="我要把微博账号注销掉"  res=true  cands=["opaque:我要把微博账号注销掉"]
rows=348 pure-Han service-key values: 1
HAN-SECRET r336:P06 "明月松间照" | 银行预留口令 明月松间照
HAN-SECRET r336:P07 "木石田"     | 备用邮箱密码：木石田
HAN-SECRET r335:C02#0 "田七八九六" | 支付宝手势口令：田七八九六
HAN-SECRET r333:C05 "青山不改"   | 银行预留口令『青山不改』
HAN-SECRET r333:C06 "明月松间照" | 和老王的接头暗号是明月松间照
HAN-SECRET r333:C22 "三七零九一" | 保险柜 三七零九一
HAN-SECRET r333:C36 "我爱你"     | 口令 wo3ai4ni3
```

修后同探针：E13 `res=false cands=[]`；其余 347 条判定不变。

边界样例（修前 → 修后）：

```text
账号：我要把微博账号注销掉，太浪费时间      true  → false   （首字「我」∈ HAN_STOP）
账号：这个月要把会员退了                      true  → false   （首二字「这个」∈ HAN_STOP）
支付宝：山有木兮木有枝心悦君兮君不知呀        true  → false   （17 字 > 12，散文长度）
微信：视频会议                                false → false   （4 字 < 6，原本就不成值）
微博：明月松间照清泉石上流                    true  → true    （10 字、非句式：仍守）
微信：青山不改绿水长流                        true  → true
Gmail: quiet.river.88                         true  → true    （拉丁分支不动）
```

## 2. 根因

`residencyServiceKeyValues` 的三个分支里，空白分隔分支明确排除汉字（「京东 618」「微信 群聊」不算），冒号分支却没有
对纯汉字做任何形态判断：`classes >= 2 || v.length >= 6`——汉字只有 1 类字符，全靠长度兜；而中文句子天然 ≥6 字，
「账号：」后接一句话就被当成登录凭据。这与 R334 §2 对值区纯汉字的口径（2–12 字、剔语法 / 指代词）不一致。

## 3. 方案

```ts
} else if (/^\p{Script=Han}+$/u.test(v)) {
  const chars = [...v];
  if (chars.length < 6 || chars.length > 12
    || RESIDENCY_HAN_STOP.has(chars[0]) || RESIDENCY_HAN_STOP.has(chars.slice(0, 2).join(""))) continue;
  out.push(v);
} else if (classes >= 2 || v.length >= 6) out.push(v);
```

- 下限 6 与修前一致（不扩守值面）；上限 12 与 R334 值区一致（>12 字纯汉字是散文）。
- 只剔「起头是代词 / 虚词 / 指代」的句子，不按词表白名单放行；不改 `RESIDENCY_SERVICE_KEY_RE`、不改强称谓路径。
- 影响面：`residencyTriggered` / `residencyCandidates` / `unitCarriesGuardedValue` 三处同源，ask 出口与 R341 模型视图同时修正。

否定的替代：把「账号 / 账户 / 登录 / 后台」这类泛词从 `RESIDENCY_SERVICE_KEY_RE` 摘掉——R335 攻击语料 C 族有依赖「账号: <拉丁值>」
结构的守值样例，摘词会回退安全面。

## 4. 复验（本机静态）

- 新单测 `test/r342-service-key-han-prose.test.ts` 10 项：E13 不触发 / 无候选 / 不携守值、三处模型视图与 ask 上下文原文；
  句式 / 过长 / 过短 4 例不成值；6–12 字非句式 2 例与拉丁分支仍守；四轮安全语料 154 条含守值的仍含守值、纯汉字守值逐条在候选里。
- `r341-model-view-fail-closed.test.ts` R335 善意边界集合由 {E13, G17} 收为 {G17}（本轮的预期变化，不是削弱断言）。
- 既有测试一字未改；全量 vitest / typecheck / R336 与 R340 静态探针 / web lint+build / assembleDebug 见 PR 描述。
- 生产 suinian-api 仍被删，ask 出口真实召回 + 主模型口径的 E13 直答未复跑。
