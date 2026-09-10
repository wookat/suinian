# decision-r347：归因 / 敏感召回比对面折叠汉字变体——繁体问句归因到自己的（简体）卡

日期：2026-09-10 · 基线：#408（R346）分支 · 状态：已实施（比对面只读折叠 + 字表扩至 zhconv 全单字表；不改任何回显 / 模型视图 / 笔记内容）

## 1. 一手证据（R346 分支静态探针 `/home/ubuntu/qa-r336-untracked/probe-r347-attrib.mts`）

R346 只折叠了问句**判定**入口。问句判定对了之后，取值闸门与敏感召回还要拿问句话题词去笔记正文里**归因**——这一层没折叠。
简体笔记「健身房储物柜密码 4471」+ 一张不相干的普通卡，同一话题的简繁问句：

| 问句 | `attributableTopicTerms` | `guardedTopicHits` | `ownTopicCards` | `sensitiveTermScore` |
| --- | --- | --- | --- | --- |
| `储物柜密码是多少` | `["储物柜"]` | 命中储物柜卡 | 储物柜卡 | 1 |
| `儲物櫃密碼是多少` | `["儲物櫃密碼"]`（称谓剥不掉） | **空** | 两张都留（无收窄） | **0** |

后果（`index.ts` 取值闸门 5355–5369 行、预言机闸门 5316–5322 行、`recallSensitiveNotes`）：

- 受守普通卡：`topicHits.length === 0 && attribTopics.length > 0` ⇒ `offTopic` ⇒ 自己那张储物柜卡被当「向量召回凑来的别人的秘密」**整条出候选**，答案只剩不相干的卡 / 「没找到」；
- 敏感标注卡：`sensitiveTermScore` 0 ⇒ 根本召不回；
- 方向无泄漏（fail-closed 一侧），但繁体用户问自己记的东西得到「没找到」，与 R346 目标（简繁同口径）不一致。

反向同样成立：笔记是繁体（港台用户手写）、问句简体，`hasTerm` 子串 / 二元组比对全部不中。

## 2. 方案

| 方案 | 结论 |
| --- | --- |
| A. 存储时把笔记正文折成简体 | 改用户原文，否 |
| B. 抽词模型 / 向量兜 | 敏感卡没有向量（decision-r326），只有子串 / 二元组近似；抽词模型降级时是朴素整句词，同样比不中 |
| **C. 比对面两侧同时折叠（采用）** | 归因 / 召回的比对函数把话题词与 haystack 各折一份副本再比；返回的仍是原卡对象、原文不动。与 R346 同一张字表、同一个 `foldHanVariants`，一对一、长度不变 |

字表：R346 表按 `prompt-armor.ts` 的简体字反查（728 对）——对**判定正则**够用，对**归因**不够：话题词是用户任意名词（`貓糧 / 銀行 / 郵箱 / 週三`），`貓 / 糧` 不在正则词汇里就折不了。本轮把字表换成 zhconv `zh2Hans` 全部**单字**映射（4702 对）经四条过滤：

1. 键、值都是 BMP 内 CJK 统一表意文字（`\u4e00–\u9fff`）——去掉 1368 条标点（`「→“`）、扩展区 / 增补平面字（代理对会改变 `.length`）；
2. 键不同时是任何值（一对一、幂等；脚本断言 0 冲突）；
3. R346 既有 728 对优先（`帳→账` 保留，zhconv 是 `帳→帐`；`著→着 / 甚→什` 问句专用折叠保留）；
4. 排除与假名相邻出现在代码 / 测试正则字面量里的字 `係 葉 証 効`（日文标签 `暗証番号 / 合言葉`），否则 r324 日文取值用例翻转（R346 第 2 提交已确证）。

结果 **3334 对**，字符串常量约 6.7k 字（UTF-8 ≈ 20 KB），`HAN_VARIANT_RE` 单字符类；折叠仍是一次 `String.replace`。

## 3. 修法

`backend/src/sensitive-recall.ts`（新增 `import { foldHanVariants } from "./prompt-armor"`，无环：prompt-armor 不依赖本模块）：

```ts
function cmpText(s) { return collapseCjkSpace(foldHanVariants(s)).toLowerCase(); }   // 只用于比对
sensitiveTopicTerms / attributableTopicTerms：let r = foldHanVariants(t); … 再剥称谓 / 元词（称谓表是简体）
hasTerm：const t = foldHanVariants(term).toLowerCase();
hasTermOrUnlabeled：const bare = foldHanVariants(term).replace(SENSITIVE_LABEL_STRIP_RE, "")
sensitiveTermScore / sensitiveTopicHits：const hay = cmpText(sensitiveRecallHaystack(…));
plainTopicHitCards：tops = topics.map(cmpText)；hay = cmpText(title\ncontent\ntags)
```

`backend/src/prompt-armor.ts`：`guardedTopicHits` 的 `specific` 与 `hay` 各折一份；`HAN_VARIANT_PAIRS` 换成 §2 的 3334 对（生成脚本见 §4）。

`attributableTopicTerms` / `sensitiveTopicTerms` 的返回值是折叠后的词：grep 其全部调用点（`index.ts` 5168 / 5316 / 5358 / 6050，`sensitive-recall.ts` 274）只用于 `guardedTopicHits / topicHitCards / ownTopicCards / noteHitsTopic / sensitiveTopicHits` 比对，不进答案文本、不进建议标签、不进模型上下文。

**不改**：`askTopicTerms`（ask.ts，聚合 / 时间虚词剥离）、`noteHitsTopic`（普通笔记建议 / 枚举命中）、向量召回、LIKE 召回、笔记存储、任何出口序列化。

## 4. 验证（全部本机静态；生产 suinian-api 仍被删，REST / SSE / MCP 与真实模型未跑）

- 字表生成 / 核验（python + zhconv，仅本机工具不进依赖）：3334 对，键值全在 `\u4e00–\u9fff`、无代理对，重复键 0，键同时是值 0；`cur≠zhconv` 仅 `帳`（保留 R346 的 `账`）。
- `probe-r347-attrib.mts`：`儲物櫃密碼是多少` 与简体同结果（attrib `储物柜`、`guardedTopicHits` 命中、score 1）；`保險箱密碼呢` 对储物柜卡仍不命中（不是放宽成「都命中」）。
- 新增 `test/r347-attribution-han-fold.test.ts` 5 用例：简繁话题词双向归因、敏感召回打分、`ownTopicCards / topicHitCards / plainTopicHitCards` 收窄、返回原对象且正文未改、日文 / 拉丁话题不受影响。
- R346 / R324 用例在新字表下仍绿（含 `書斎の金庫の暗証を教えて`）；`probe-r346.mts` 35 对 mismatch 仍 1；历轮 452 条问句判定 diff 为**空**（字表扩大没有翻转任何问句判定）。
- R340 探针 18/18 + 40/40、非 answer 出口 0/40 漏 / 0/18 误伤；R336 探针 34/34 + 18/18（未回退）。
- 全量 vitest / tsc 见 PR 自测栏。

## 5. 不做 / 边界

- 词级地区差异（`網路 / 網絡`、`軟體 / 软件`）仍不折：单字表做不到，也不在归因的主要失败面里。
- 日文汉字整体不做语言检测：日文问句里的 `書 / 金庫` 会被折成 `书 / 金库`，但日文标签正则的字（`証 / 葉 / 係 / 効`）排除在表外，r324 日文用例逐条验证；日文用户的归因面本就是日文笔记对日文问句，两侧同折不影响命中。
- 这一层是「找回自己的卡」，不是放宽守值：折叠只让同话题的简繁写法互认，`sensitiveRecallHaystack` 抹值、`guardedTopicHits` 的称谓剥离、`offTopic` 出候选逻辑全部原样。
