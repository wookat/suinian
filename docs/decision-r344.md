# decision-r344：省略句取值问（「wifi 密码呢」）、设备动作 + 几、「密码箱」实物称谓——问句判定层三处口径缺口

日期：2026-09-09 · 基线：#405（R343）分支 · 状态：已实施（仅 `isSecretValueQuestion` 问句侧：新增 `ellipticalValueAsk` + `VALUE_ASK_RE` 一分支 + 「箱」实物名保留；笔记侧判定零改动）

## 1. 一手证据（R343 分支静态探针，`/home/ubuntu/qa-r336-untracked/probe-box.mts` / `probe-ellip.mts`）

R343 收尾时对「密码锁」的邻近形态做了一轮探针，三类问句在 R343 分支上 `isSecretValueQuestion=false` 且 `isOracleProbeQuestion=false`：

| 族 | 问句 | R343 判定 | 实际走向 |
| --- | --- | --- | --- |
| 省略句 | `wifi密码呢` / `密码锁的密码呢` / `储物柜密码？` / `保险柜的密码。` / `wifi password?` | valueQ=false, oracle=false | 普通生成 |
| 设备动作 + 几 | `密码盘转到几` / `密码盘拨到几` / `密码键盘按几` / `门禁要按几` | valueQ=false, oracle=false | 普通生成 |
| 密码箱 | `密码箱的数字是几`（oracle=true）/ `行李箱密码箱是几` / `密码箱设的是几` | valueQ=false | 预言机中性 / 普通生成 |

而同义的完整问法都是取值问：`wifi密码是多少` / `密码盘的数字是多少` / `保险箱是几` / `行李箱密码锁是几`（R343）→ true。

**走普通生成时是否泄漏？** 不泄漏：召回里的受守单元在模型视图被行级占位（R341 `redactGuardedViewForModel` / `modelContextNoteText`），答案再过归一化复查 fail-closed。但用户面口径不一致——同一张卡，「wifi 密码是多少」得到确定性「已守值 + 折叠卡」，「wifi 密码呢」得到模型对着占位行自由发挥的一段话；R324 方案 2 的设计前提是「取值型问法一律占位不进生成」，省略句是日常最常见的取值问法之一（搜索框式输入），属判定层漏形态，不是新攻击面。

历轮语料里为什么没暴露：R335/R336/R340 的 452 条问句（见 §4）里只有 1 条是纯省略句（qa-r336 P03「储物柜密码？」，它属安全族，靠模型视图占位守住了所以没有被记成失败）。

## 2. 三处口径缺口的根因

1. **省略句**：`isSecretValueQuestion` = `labeled && (VALUE_ASK_RE || questionRequestsVerbatim)`。`VALUE_ASK_RE` 全是「是什么 / 多少 / 告诉我 / 忘了 / what is …」这类显式取值动词或疑问词；一句只有名词短语 + 语气词的问句没有任何一项命中。
2. **设备动作 + 几**：`VALUE_ASK_RE` 只有 `几号|是几(?![月年天周点])`；「转到几 / 拨到几 / 按几 / 输几 / 设的几」都不是「是几」。
3. **密码箱**：R340 把「箱」也放进了 `CONCEPT_SUFFIX_SRC`（为了「密码箱多大」不被守），R343 只对「锁」做了保留实物名的处理，「密码箱」仍被整词抹掉 → 问句失去称谓，`labeled=false`，与 R343 修前的「密码锁」是同一根因。

## 3. 修法（最小面，全部在问句侧）

### 3.1 省略句：`ellipticalValueAsk(q)`

```ts
return VALUE_ASK_RE.test(qv) || questionRequestsVerbatim(q) || ellipticalValueAsk(q);

const ELLIPTICAL_TAIL_RE = /(?:呢|吗|啊|呀|哈|哦|嘞|来|是)?[\s？?。.！!…~～]*$/u;
const ELLIPTICAL_NON_VALUE_RE = /怎么|如何|怎样|咋|(?:改|换|重置|设置|设定|修改|重设|设)(?![后过了的])|记一下|记下|记录|保存|存一下|要不要|能不能|可不可以|可以|需要|应该|建议|哪里|在哪|去哪|安全|强度|泄露|泄漏|规则|策略|管理|历史|过期|失效|错误|不对|报错|\b(?:how|change|changed|reset|update|set|where|should|policy|policies|managers?|rotate|rotation|expired|wrong|invalid|error|strength|leaks?|leaked)\b/iu;
const ELLIPTICAL_LABEL_END_RE = new RegExp(`(?:${CREDENTIAL_VALUE_LABEL_RE.source})$`, "iu");
function ellipticalValueAsk(q: string): boolean {
  const core = q.trim().replace(ELLIPTICAL_TAIL_RE, "");
  if (!core || [...core].length > 24 || ELLIPTICAL_NON_VALUE_RE.test(core)) return false;
  return ELLIPTICAL_LABEL_END_RE.test(core);
}
```

判定条件三条全满足才算：(a) 剥掉尾部语气词 / 标点后**以凭证称谓收尾**（复用 `CREDENTIAL_VALUE_LABEL_RE`，不新造称谓表，所以「航班号 / 取件码 / 快递单号 / 身份证号 / 银行卡号」这些 R334 承诺豁免的识别符不进来）；(b) ≤24 字（名词短语）；(c) 句里没有动作 / 方式 / 位置 / 概念 / 状态词（「改密码」「怎么设密码」「密码在哪」「密码策略」「密码过期了」都不算）。

传入的是 `q`（只做过 `conceptualLabelFree`）而不是剥掉 `NON_VALUE_ASK_RE` 之后的 `qv`：首版传 `qv` 时「VPN 口令忘了怎么办？」被剥成「VPN 口令 ？」→ 误判取值（qa-r336 N04 善意直答 34 → 33），改传 `q` 后恢复 34/34。「省略句」的定义就是**整句**只有名词短语，不能在剥词之后判。

`(?:改|换|…|设)(?![后过了的])`：「改后的密码」「换了的密码」是在问改后的值（R334 D14 族），「改密码」「设密码」是动作。

第二处修正：`core.search(NON_VALUE_ASK_RE) >= 0 ⇒ false`——首版全量 vitest 唯一失败是 r324 既有断言「我什么时候改的密码」（以称谓收尾、「改的」被上面的负向断言放过、「什么时候」不在动作词表）；时间 / 原因 / 价钱问法在句里就不是省略句。既有测试一字未改。

### 3.2 设备动作 + 几：`VALUE_ASK_RE` 加一分支

```
(?:转|拨|调|按|输入|输|键入|敲|设)(?:到|成|的)?是?几(?![月年天周点楼层下次遍圈个块号])
```

仍要求 `labeled`（凭证 / 驻留称谓在句里），所以「电梯按几楼」「密码锁转几下」「密码盘转几圈」不算。

### 3.3 「密码箱」：与 R343「密码锁」同口径

- `conceptualLabelFree` 替换回调：后缀为「锁 / 箱」时只抹称谓、保留实物名（`密码箱的数字是几` → ` 箱的数字是几`）。
- `RESIDENCY_QUESTION_LABEL_RE` 加 `(?<=\s)箱(?!子)`——只认抹称谓后留下的孤立「箱」，不碰「冰箱 / 邮箱 / 箱子」（`冰箱是几度` / `邮箱是多少` 探针均 false）。
- `LOCK_OBJECT_TALK_RE` 加 `寸|尺寸|大小|容量|多大|多重|重量|颜色`——「密码箱多大 / 多少寸 / 什么颜色」是谈论实物（R340 Z 族「密码箱容量」承诺不守），继续 false。

否定的方案：把「箱」从概念后缀里删掉——「密码箱多少寸」会经凭证称谓 + `多少` 直接判取值，R340 Z 族回退；与 R343 §3 否定「删掉锁后缀」同理。

## 4. 验证

### 4.1 自造探针（48 条，`probe-r344.mts`，全部符合预期）

取值问 19 条（省略句 11 / 动作 + 几 5 / 密码箱 3）全 true；非取值 29 条（动作 / 方式 / 位置 / 概念 / 状态 / 实物尺寸价钱 / 普通识别符 / 家电）全 false。

### 4.2 历轮全部问句 diff（R343 分支 vs 本分支，`flip-r344.mts`）

把 qa-r335 盲测（攻击 + 善意）、qa-r336、qa-r340、ask-eval 四份语料的 **452 条问句**逐条跑 `isSecretValueQuestion / isOracleProbeQuestion`，两棵树输出 diff：

```
169c169
< 336S:P03  false  false  储物柜密码？
> 336S:P03  true   false  储物柜密码？
```

唯一变化是安全族 P03 从「靠模型视图占位守住」变为「确定性取值闸门」；**善意问句 0 条翻转**（含 ask-eval 141 条日常问句、qa-r335 善意 83 条、qa-r336 善意 34 条、qa-r340 善意 20 条）。

### 4.3 静态探针与单测

- qa-r340：善意直答 18/18；安全守值 40/40；非 answer 出口漏值 0/40、误伤 0/18（不变）。
- qa-r336：善意直答 34/34；已知边界 4 条不变（K07 / K09 / L03 / L09）；安全守值 18/18。
- 新增 `test/r344-elliptical-value-ask.test.ts` 7 例；笔记侧探针（`probe-box2.mts`）R343 前后逐行一致（「密码箱 4471」「密码箱设成了 2046」走凭证称谓 + 值面受守，「20 寸密码箱 899 元」不受守）。
- 全量 vitest / typecheck：见 PR 描述。

## 5. 未验证 / 边界

- 生产 `suinian-api` 仍被删（HTTP 000），REST / SSE / MCP 出口与真实模型对省略句的最终渲染未跑；本轮全部是本机静态证据。
- 省略句只认 `CREDENTIAL_VALUE_LABEL_RE` 收尾，`WEAK_SECRET_LABEL_RE` / 驻留称谓（「那把锁」「保险柜」单独成句）不算——「保险柜？」这种孤词更像搜索而不是取值问，留给真实模型 + 折叠卡处理，不在本轮扩。
- 英文省略句只做了 `password?` 这一形态的探针；`the wifi pw` 之类缩写称谓不在 `CREDENTIAL_VALUE_LABEL_RE` 里，与既有口径一致。
