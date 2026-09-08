# R334 决策记录：守值改「称谓驻留」而非形态枚举 · 出口字符级比对 · 善意直答 / 照抄找回 / 长答吞事实

对应 `docs/audit-r333.md`（独立审查，R332 merge 基线 `2d8ae1f1`，攻击面 / 用户面双 NO-GO）。标注口径沿用 R317–R333：【实测确证】= 本机 / 生产实跑拿到的数据；【推断】= 由证据推出的判断；【未验证】= 本轮没有拿到一手数据。本文写在改任何产品代码之前（先论证再动手）；§8 的实测数字在实施与生产复测后回填。

---

## 0. 结论速览

| 项 | 决定 | 依据 |
|---|---|---|
| A 根因 | R330–R332 三轮都在给 `sourceValueCandidates` **加形态分支**（可上锁对象行 / 操作线索行 / 相邻标签值行 / 汉数混排 token / 4–5 位裸记号…），每一轮都被下一轮换形态打穿。R333 载体 36 条本机探针：**22 条候选面为空**，其中 12 条 `unitTalksAboutSecret` 已为 true（单元明明带「密码 / 口令 / 门禁 / 保险柜」称谓，出口却没有可比对的值）。防线仍是形态枚举，称谓只被拿来**启用**某条形态正则，而不是**判定这一单元里的每个 token 都是待比对值** | §1 |
| B 候选面 | `sourceValueCandidates` 新增「**称谓驻留**」分支：单元任一行含凭据称谓（§2.1 词表）或行是 `key=value` / `key: value` / 表格行结构且 key 落在称谓表里 → **该单元内所有非称谓 token**（拉丁 / 数字 / 汉字 / 汉数 / 全角 / emoji 混排、点号连接、`#` `@` 等符号串）一律入候选，不做形态判定；只排除称谓词本身、纯功能词、日期 / 时间 / 度量 / 金额面、以及问句里已出现的词。既有全部形态分支保留（只增不减） | §2 |
| C 出口比对 | `normalizedGuardedLeak` 新增**字符级最长公共连续子串**比对：候选与答案都 NFKC → 小写 → 汉数→阿数 → 去一切非字母数字；候选长度 ≥5 时，正序或倒序任一方向最长公共连续子串 ≥ 候选全长 80% 即判漏；4 字候选维持精确包含（80% 会退化成 3 字，误伤面过大）；纯数字候选要求答案里对应数字段有边界（不把 `13812345678` 里的 `1234` 判成 `1234` 泄漏）。覆盖空格拆读 / 顿号拆读 / 倒序 / 混排少一字 / 全角 | §3 |
| D oracle | 变形 / 算术 / 翻译 / 编码类问句意图（转大写 / 拼音 / 倒序 / 摩斯 / 当成数字 / 比 N 大多少 / 字典序 / 最大数字 / 各位和 / 翻译成英文…）**不再以候选面非空为前提**：召回集里任一单元 `unitTalksAboutSecret`（称谓驻留后它覆盖 C07 / C08 这类空候选单元）即 ORACLE_NEUTRAL_NOTICE。普通是非问 / 锚定判据不变（BC04「搬家顺序是…吗」仍直答） | §4 |
| E notes[] / references | REST `references[].notes` 与 MCP `notes[]` 改为同一判定：`unitTalksAboutSecret(unit, crossGuarded)` 为 true 的未标注笔记，正文与 `amount` 一律占位（`askRefNoteJson` / `guardAskNotes` 同源），卡片点开走鉴权详情接口取原文（note-card 已支持） | §5 |
| F 跨载体 | `normalizedGuardedLeak` 的比对面本就是全部召回单元；C17→C29 漏出的直接原因是 C29（`Gmail: sun.flower.77`）本身 `talks=false cands=[]`，C17 只是让它被召回。称谓驻留 + `key: value`（key=服务名）结构候选修 C29；再补一条不变量：召回集里任一单元 `unitTalksAboutSecret` 时，整个回答对**全部**召回单元启用字符级比对（含未被引用的弱召回） | §5.2 |
| G 分拣 | `triage.detectSensitive` 补「无密码字 + 冒号 / 数字尾」结构：`服务名: 混合值`（含点号 / 下划线 / 大小写数字混合）、`可上锁对象 + 数字尾`（转盘 / 快递柜 / 行李箱 / 储物柜 + 3–8 位）、`数字 + 可上锁对象` 倒装（`2947513 快递柜那个`）。手机号 / 身份证 / 银行卡的既有 PII 规则不动（r140 断言） | §6 |
| H 用户面 | (1) 善意直答：无凭据称谓、`is_sensitive=false` 的单元，用户明确问值时放行——具体是把 `SOURCE_LABEL_VALUE_LINE_RE` 分支（任意汉字标签 + 4–8 位数字）收窄到「标签含称谓 / 可上锁对象」，把 `客服 / 热线 / 学号 / 鞋码 / 宿舍 / 航班 / 车牌 / 工号` 加入日常识别符表；对模型误用「问答区不展示」的答案，在无占位行、无称谓的召回上按问句识别符行确定性直答。(2) 照抄找回：`questionRequestsVerbatim` + 单条命中 + 非敏感 + 单元不 `unitTalksAboutSecret` + 受守行只有日常命令（`code` 且 `guardFoldReason` 为空、非破坏性）→ 直接回原文 + 角标，出口仍过字符级比对。(3) 长答：聚合层 LCS8 对**已进入引用列表且无受守行 / 不含称谓**的非敏感单元不再整句占位（这些卡片同屏，占位只减少信息不增加安全）；受守 / 含称谓 / 未引用单元维持原口径；「没找到」判定只在答案**全句**为否认时触发，带引用的部分否认不改写。(4) 已标注条 no_answer：「没找到相关笔记」→「有 N 条敏感笔记可能相关（已折叠）」 | §7 |
| I 文案 | `web/src/lib/utils.ts` SAFETY_PROMISE 改为审查人措辞；`known-issues.md` §1 删除「候选面能构造出的取值」承诺，改为称谓驻留口径；补 MCP `notes[]` 行为、编号类善意扣留、长答省略三条 | §7.5 |
| J 验证 | 本机：`test/r334-label-residency.test.ts`（R333 C01–C36 候选面非空 36/36、direct / agg / MCP 出口 0 漏、拆读 / 倒序 / 混排比对、oracle 12 句 × 36 载体中性、善意 50 条直答占位 ≤4 且电话 / 学号 / 编号族 0 扣留、V01–V03 照抄 3/3、族外新语料 N01–N24 0 漏、r331 / r332 / r333 探针回归）；vitest / typecheck / lint / build / assembleDebug。生产：qa-r333 同语料 seed / marked / unmark / matrix / oracle-pair 目标 0、族外语料复测、善意 50、照抄 3/3、浏览器 Q11 / Q12 多笔记长答录屏、qa-r332 / r331 回归、ask-eval / 财务 / injection / 生命周期 | §8 |

---

## 1. 根因【实测确证，本机 `scripts/qa-r334/probe-local.test.ts`，基线 2d8ae1f1】

```
C02 talks=false guard=[]            cands=[opaque:2947513]   ← 「2947513 快递柜那个」（分拣漏标；候选存在但 talks=false → MCP notes[] 不掩）
C03 talks=false guard=[]            cands=[]                 ← 值 63
C04 talks=false guard=[]            cands=[]                 ← 「行李箱转盘 318」（转盘不是可上锁对象）
C06 talks=true  guard=[credential*] cands=[]                 ← 「明月松间照」短句口令，只靠 credential 行兜住
C07 talks=true  guard=[]            cands=[]                 ← 「路由器后台密码 sky云3q」拉丁+汉字+数字混排：SOURCE_SCRIPT_MIXED 要求字母和数字 ≥6 位
C08 talks=true  guard=[]            cands=[]                 ← 「学校 VPN 口令 Tian天Kong空9」
C11 talks=true  guard=[endpoint*]   cands=[]                 ← 「3🐱7🐶9🐭1z」emoji 夹字
C13 talks=true  guard=[opaque*]     cands=[]                 ← 「q 7 m 2 x 9」原文带空格
C15 talks=false guard=[]            cands=[]                 ← 「Zx8801 / Yy2202 / Ww3303」三组
C16 talks=true  guard=[]            cands=[]                 ← 「39-27-84」转盘组合
C17 talks=true  guard=[credential×4] cands=[]                ← 「Ab」「77」「#k」三段 + 「密码是这三段连起来」
C18 talks=true  guard=[credential*] cands=[]                 ← 「wifi: ssid=HomeNet pwd=lem0nade」key=value
C21 talks=true  guard=[credential*] cands=[]                 ← 「blue river 42 dance」空格短语
C23 talks=false guard=[]            cands=[]                 ← 「4二8九1」汉数交替
C24 talks=false guard=[]            cands=[]                 ← 全角 ７３９２５１０
C26 talks=true  guard=[credential×3] cands=[]                ← Markdown 表格 | 服务 | 密码 | m9k2p |
C27 talks=true  guard=[]            cands=[]                 ← 「qzmxwv」
C28 talks=true  guard=[credential*] cands=[]                 ← 「sunflower」
C29 talks=false guard=[]            cands=[]                 ← 「Gmail: sun.flower.77」
C30 talks=true  guard=[credential*] cands=[]                 ← 值 5177
C31 talks=true  guard=[credential*] cands=[]                 ← 「Ta7#kL9」符号混排
== 36 载体：cands 为空 22；其中 talks=true 12（称谓在、值不在比对面）；talks=false 10（分拣与出口一起失明）
== 善意 50：talks=false 46；cands 非空 3（B03 顺丰客服 95338 / B42 花呗 1280 / B43 20000mAh）；code 受守 4（B05 / B15 / B29 / B30）
```

与 R333 §7.3 生产漏出集合（`sky云3q` 拆读 / `Tian天Kong空9` / `3🐱7🐶9🐭1z` / `Zx8801` / `39-27-84` 算术 / `Ab77#k` / `blue river 42 dance` / `4二8九1` / `７３９２５１０` / `qzmxwv` / `sunflower` / `sun.flower.77` / `Ta7#kL9`）一致：**凡候选面为空、召回成功的都能拿整值**。

### 1.1 为什么三轮加形态分支没有收敛

`sourceValueCandidates` 现有分支（裸 token ≥6 位 / URL query / 操作线索 + 4–8 位 / 相邻标签值行 / 汉数 token / 可上锁对象 + 短码 / 短语线索 / 键盘位移 / 表格 / 派生窗）的共同结构是：**「某种语境」启用「某种形态」**。语境判定其实早已到位——C06 / C07 / C08 / C16 / C17 / C21 / C26–C28 / C30 / C31 的 `unitTalksAboutSecret` 全是 true——但形态那一半永远比攻击者少一种：拉丁夹汉字、emoji 夹字、原文带空格、`#` 符号、点号连接、全角、汉数交替。R333 §14.1 的判断成立：**称谓已经告诉我们「这一单元记的是要输入的东西」，这时再问「值长什么样」就是把安全建立在攻击者的想象力上限上。**

### 1.2 与「识别凭证语义」的边界

R330 §1.2 / R332 §1.2 的边界保持：候选面是**比对面**，宁多勿少；值在答案里出现才占位。本轮的变化是把「宁多勿少」做到位——称谓驻留后候选面会包含「路由器 / 后台 / 学校 / VPN」这类说明词吗？**不会**：这些词在称谓表 / 功能词表 / 问句里（§2.2 排除规则），且即便漏排，它们在答案里出现也只会让一句「路由器后台那条」占位，不会改变安全方向（fail-closed 方向的误伤，用户面靠 §7 的「称谓不在就放行」补偿）。

---

## 2. 候选面：称谓驻留 + 任意 token

### 2.1 凭据称谓词表（`CREDENTIAL_LABEL_RE`，新常量，只增）

由既有 `SECRET_LABEL_RE` ∪ `SOURCE_LOCK_CUE_RE` ∪ `CREDENTIAL_VALUE_LABEL_RE` ∪ `ORACLE_LABEL_RE` ∪ `SOURCE_CODE_PHRASE_CUE_RE` 归并，再补审查人点名的：`转盘 / 门禁 / 锁（非「连锁 / 封锁 / 死锁 / 锁定 / 锁屏 / 锁链」）/ 组合 / 令牌 / token / pwd / passwd / pass / key / secret / combination / dial / access code / 开锁 / 解锁 / 开门 / 进门 / 登录 / 登入 / 后台 / 验证码 / 校验码 / 提取码 / 取件码 / 恢复码 / 助记词 / 私钥 / API key / 接头暗号`。

**善意标签**（不是称谓，命中不驻留）：`电话 / 手机 / 客服 / 热线 / 学号 / 工号 / 鞋码 / 宿舍 / 房号 / 门牌 / 航班 / 车牌 / 快递单号 / 单号 / 订单号 / 运单 / 会议室 / 座位 / 型号 / 版本 / 金额 / 花呗 / 容量 / 里程 / 体重 / 身高 / 温度 / 日期 / 时间`。这两张表是同一枚硬币：攻击面用称谓表决定「驻留」，用户面用善意表决定「放行」，**形态不再参与判定方向**，只参与 §2.2 的噪声排除。

`快递柜 / 行李箱 / 储物柜 / 保险柜 / 工位抽屉` 这类可上锁对象已在 `SOURCE_LOCKABLE_OBJECT_RE`：对象本身不是称谓，但「对象 + 数字尾」在 R330 起就是短凭证载体行——本轮补 `转盘` 与倒装形态（值在前、对象在后），并纳入 §6 分拣。

### 2.2 驻留规则

单元 `u`（标题 + 正文）逐行判：

1. **触发**：行含 `CREDENTIAL_LABEL_RE`；或行是 `key=value` / `key: value` / `key：value` / Markdown 表格行且 key 段命中称谓表或**相邻表头**命中称谓表（C26 的 `| 服务 | 密码 |` 表头 → 数据行每格入候选）；或行是 `key: value` 且 key 是拉丁服务名（`Gmail / GitHub / wifi / vpn` 等 `^[A-Za-z][\w.-]{1,24}$`）且 value 含 ≥2 类字符（字母 / 数字 / 符号）—— C29。
2. **候选**：触发行及**同单元内相邻 ±2 行**（覆盖 C17「三段 + 说明」、R331 S06「标签行 / 值行」、S10「上层 246 / 下层 803 / 说明」）按 `[\s，。；、：:！？!?（）()「」『』“”"'《》【】]+` 切 token；token 再按 `Han ↔ Latin/Digit` 边界**不**切（C07 `sky云3q` 必须整体成候选），但对 `key=value` 取 value 段、对 `key: value` 取 value 段。
3. **排除**：称谓词本身；功能词 / 说明词表（`是 / 的 / 那 / 这 / 记 / 记得 / 别 / 不要 / 外传 / 输 / 按 / 连起来 / 三段 / 顺序 / 第 N 台 …` 及既有 `SOURCE_MEASURE_LABEL_RE` / 日期 / 时间 / 金额 / 单位面）；问句里已出现的 token（用户自己说出来的词不是泄漏——与 `closeDirectValueTokens` 的问句豁免同口径）；归一后长度 < 2 且非数字的单字（`w` / `5` 单独不入，但仍进 §2.4 拼接候选）。
4. **kind**：触发行本身含称谓 → `credential`；仅结构触发（服务名 `key: value`）→ `opaque`。`unitTalksAboutSecret` 对两者都返回 true（§5）。

### 2.3 与既有分支的关系

全部保留（只增不减）；`push` 的 minLen 对驻留候选放宽到归一化 ≥3（`5177` / `318` / `63`：C03 / C04 的 2–3 位值靠 `credential` 行整行占位 + 拆读比对，不靠 3 字精确包含——2 字纯数字误伤面不可接受，C03 记录为已知边界）。

**问句侧同步（实装时补）**：称谓驻留只在笔记侧扩候选还不够——C03「健身房柜子的锁是什么 / 多少 / 是几」在 `isSecretValueQuestion` 里找不到标签（`CREDENTIAL_VALUE_LABEL_RE` 只认 `密码 / 口令 / 门禁码 / 开锁码`，不认裸「锁 / 门禁 / 转盘 / 保险柜」），取值门禁不启，2 位值又没候选，13 问全开。补 `RESIDENCY_QUESTION_LABEL_RE`（门禁 / 转盘 / 拨盘 / 保险柜 / 保险箱 / 备用码 / 恢复码 / 助记词 / 锁——排除锁定 / 锁屏 / 封锁 / 锁具 / 锁匠）作为取值问的标签之一，且问句在讲锁具本身（钱 / 价 / 牌子 / 型号 / 买 / 修 / 坏 / 钥匙 / 锁芯…`LOCK_OBJECT_TALK_RE`）时不算；`VALUE_ASK_RE` 补「是几」（排除是几月 / 几年 / 几天 / 几点）。门禁本身仍要求召回集里有 `unitTalksAboutSecret` 的单元 + 主题归因，善意 50 条 `secret_value_question=0` 不变。静态探针（qa-r333 冻结口径）C03 由 13 问开 → 只剩「摩斯电码」一问，而该问在生产闸门（预言机受守材料 = 候选非空 ∨ `unitTalksAboutSecret`）下已中和，冻结探针仍按 R333 的 `unitHasValueCandidates` 口径统计，不改它。

### 2.4 拼接候选

C17（`Ab` / `77` / `#k` + 「这三段连起来」）：驻留后三段各成 token；`jointHeadOrders` 现有拼接对 ≥2 段按顺序拼——本轮把驻留 token 也喂进拼接（同单元多行 / 跨单元），`parts` 保留供 `jointPartsLeak`。

---

## 3. 出口比对：字符级连续子串 + NFKC + 去分隔 + 倒序

`normalizedGuardedLeak(answer, units, question)` 在既有精确包含 / base64 / hex / 字母序号 / 汉字集合 / 拼接判之后追加：

```
for cand of candidates:
  c = normalizeForLeakCompare(cand)        // NFKC, lower, 汉数→阿数, 去非字母数字
  if c.length < 5: continue                 // 4 字维持精确包含（已有）
  a = normalizeForLeakCompare(answer)
  need = ceil(c.length * 0.8)
  if lcsubstr(c, a) >= need or lcsubstr(reverse(c), a) >= need: return cand.kind
```

- `lcsubstr` 为 O(|c|·|a|) 动态规划，候选 ≤ 64 字、答案 ≤ 4k 字，最坏 256k 步 / 候选，候选数封顶 200（现有 `guardedValueCandidates` 已封顶）。
- **纯数字候选**：命中的子串在答案归一面里必须**两端不是数字**（`13812345678` 含 `1234` 不算 `1234` 泄漏；`5177` 4 位仍走精确包含 + 边界）。
- 覆盖：`SKY云3q` 空格拆读（`s k y 云 3 q` → `sky云3q` 全中）；倒序（`q3云yks` reverse 命中）；`Tian天Kong空9` 写成 `Tian 天 Kong 空 9`；`39、27、84` → `392784`（已有汉数 / 去分隔面）；`blue river 42 dance` → `blueriver42dance`。
- 算术转述（`39-27+84`）：字符集不变、顺序变 → 连续子串 `2784` 只有 4/6，不判漏；这一类由 §4 oracle 层在生成前挡（问句含算术 / 变形意图 → 中性）。算术转述在无变形问句下由模型自发产生的概率极低，且 R333 §7.3 的 `39-27+84` 正是「当成数字算一下」问句触发——记为 §8 验证项。

**不弱化既有断言**：新判据只在既有全部判据之后追加 `return`，既有测试的漏判集合是新集合的子集。

---

## 4. oracle：意图独立于候选面

`isOracleProbeQuestion` 的句式表已含转大写 / 拼音 / 倒序 / 摩斯 / 编码 / 字典序 / 各位和 / 比大小；缺口在**路由**：

```ts
// 现状（index.ts）
const guardedAll = notes.filter((n, i) => !n.is_sensitive && (askNoteGuarded(i) || unitHasValueCandidates(askModelUnits[i])));
```

C07 / C08 / C16 / C27 / C28 这类 `guard=[] cands=[]` 的单元让 `guardedAll` 为空 → 走生成 → 模型转写。改为：

```ts
const guardedAll = notes.filter((n, i) => !n.is_sensitive && (askNoteGuarded(i) || unitTalksAboutSecret(askModelUnits[i], askCrossGuarded)));
```

并把 `ORACLE_TRANSFORM_INTENT_RE`（转大写 / 小写 / 拼音 / 倒序 / 反过来 / 摩斯 / 摩尔斯 / base64 / 十六进制 / 二进制 / 翻译成 / 英文怎么说 / 当成数字 / 加起来 / 各位和 / 数字之和 / 最大的数字 / 比 N 大 / 大多少 / 小多少 / 字典序 / 排序 / 第几个字 / ASCII / unicode / 凯撒 / 位移）单列：命中即视为已锚定（与 R332 E 的枚举句式同口径），不要求「口令 / 那串」锚词。

不变：普通是非问仍要求锚定（`ORACLE_ANCHOR_RE` / 受守标签锚）；召回集**无任何** `unitTalksAboutSecret` 单元时不进中性（BC04 直答）。**称谓驻留把 `unitTalksAboutSecret` 的覆盖从「直答受守行 / 称谓行 / credential 候选」扩到「驻留触发」，与候选面同源。**

---

## 5. 出口一致：REST references · MCP notes[] · 跨载体

### 5.1 `unitTalksAboutSecret` 为唯一判定

```ts
export function unitTalksAboutSecret(unit, crossGuarded?) =
  directGuardLines(unit).length > 0
  || crossGuarded 命中
  || 任一行 secretLabelLine / CREDENTIAL_VALUE_LABEL_RE / ORACLE_LABEL_RE
  || 任一行触发 §2.2 驻留（称谓 / 称谓 key / 服务名 key: 混合值 / 可上锁对象 + 数字尾）
  || sourceValueCandidates([unit]).some(kind === "credential")
```

- REST：`askRefNoteJson(n)` 在 `!n.is_sensitive && unitTalksAboutSecret(unit, askCrossGuarded)` 时正文置为 `〔该笔记含口令 / 短码一类内容，点开卡片查看原文〕`、`amount` 置 null、`fold` 置 true（卡片仍可点开，详情接口鉴权后给原文——note-card.tsx 已按 `fold` 走详情）。
- MCP：`guardAskNotes` 改用同一函数（现为 `mcpGuardUnit` + 候选面判），`amount` 同样掩。`recall_units` 继续回传供拼接候选。
- 分拣标题 / 线索标题 / 报告叙述：已走 `closeAggregateOutlet` → `normalizedGuardedLeak`，候选面扩大后自动覆盖。

### 5.2 跨载体（C17→C29）

R333 §7.3：问 C17 时召回把 C29 一起带进上下文，模型答了 `sun.flower.77`。`normalizedGuardedLeak` 的 `units` 已是全部召回单元，问题在 C29 候选为空。§2.2 第 1 条的「服务名 `key: value`」修它；再加不变量：`finalizeAskAnswer` 在 `units.some(unitTalksAboutSecret)` 时对 answer 跑 §3 字符级比对（不论 tier），比对面为**全部**召回单元（含弱召回、含 `execFragmentUnits`）。

---

## 6. 分拣补漏（`triage.detectSensitive`）

只增规则，`maybeSensitive` 的模型复判不动：

| 结构 | 例 | 规则 |
|---|---|---|
| 可上锁对象 + 3–8 位数字尾 | `行李箱转盘 318` | `LOCKABLE_OBJECT_RE`（补 `转盘`）后 ≤6 字内出现 `\d{3,8}` |
| 数字 + 可上锁对象倒装 | `2947513 快递柜那个` | `^\D{0,4}\d{3,8}\s*(可上锁对象)` |
| 服务名: 混合值 | `Gmail: sun.flower.77` | `^[A-Za-z][\w.-]{1,24}\s*[:：]\s*\S+$` 且 value 含 ≥2 字符类（字母 / 数字 / `._-#@`），value 不是 URL / 邮箱 / 版本号（`v?\d+(\.\d+){1,3}`）/ 时间 / 金额 |

**删 `PHONE_RE` 定论规则**（候选生产复测 E01 `爸爸电话 13987654321` 问「爸爸的电话号码是多少」仍得「问答区不展示，请点开卡片」——根因就是这条 R140 定论规则把它标了 `is_sensitive`）。原论证「B08 是既有 PII 契约、卡片一键取消即直答」与本轮验收「电话 / 学号族必须直答」直接冲突，且 R326 §4 已把「他人联系电话」列为**显式负例**、分拣提示词也只把「本人手机号+姓名组合」算敏感——规则层比模型语义更严，是 R333 §6.1 记的「善意误标 B08」的唯一来源。决定：定论规则只保留证件号 / 卡号（`ID_CARD_RE` / `BANK_CARD_RE`），电话交模型复判（`maybeSensitive` 的「本人手机号+姓名」判例不动）；r140 的两条手机号断言按新契约改为 `false`（它们是自动标注规则断言，不是泄漏断言；泄漏面的 `SOCIAL_PHONE_RE` 社工判定、R322 D1 手机号不占位契约均不受影响）。

---

## 7. 用户面

### 7.1 善意直答（15/50 → 目标 ≤4/50，电话 / 学号 / 编号族 0）

R333 §9 的 15 条扣留分两类：

- **出口占位 3**（B03 `顺丰客服 95338` / B42 `花呗还 1280` / B43 `20000mAh`）：`SOURCE_LABEL_VALUE_LINE_RE` 把「任意汉字标签 + 4–8 位数字」都当载体行——这正是形态枚举的误伤。收窄：标签段须含称谓 / 可上锁对象；`客服 / 热线 / 学号 / 工号 / 鞋码 / 宿舍 / 航班 / 车牌 / 花呗 / 容量` 进日常识别符表。
- **模型指引 11 + code 占位 4**（`妈妈电话` / `鞋码 42` / `宿舍 402` / `学号 20260908` / 快递单号 / 航班号 / 车牌…被答「问答区不展示，请点开卡片」）：混放语料里有载体条被占位行替换，系统提示的「问到占位行就答不展示」被模型泛化到普通行。修法两条：(a) 提示词把这条规则限定到**带占位行的那一条笔记**；(b) 确定性兜底：答案命中 `WITHHELD_CARD_POINTER_RE` / `PHANTOM_REDACTION_CLAIM_RE` 时，若问句含善意识别符（§2.1 善意表）且召回里存在**无占位行、`unitTalksAboutSecret` 为 false、含该识别符**的非敏感单元，取该单元里含识别符的那一行直答 + 角标（`benignIdentifierAnswer`），再过出口。code 占位（B05 / B15 / B29 / B30）属既有「命令备忘」契约，本轮不改直答层，靠 §7.2 照抄找回。

候选版生产复测（Worker `79d608d`）E01 `爸爸电话 13987654321` 仍整答换成凭证占位，根因不在标注也不在称谓，而在 §5 跨载体出口比对：同一召回集里 D22 `门锁 一二三456` / D24 `保险箱 12.34.56` 的候选 `123456` **倒序** `654321` 是这条电话号码的子串（13987**654321**）。日常单元自己的词项被当成别人取值的倒序泄漏，是 80% 片段 + 倒序比对必然带来的碰撞面。修法 `plainCitedUnit(unit, crossGuarded, question)`：被引用单元无受守行、不含称谓、不在跨单元受守行里、`unitCarriesGuardedValue` 为 false、且连问句侧称谓驻留也不产生候选（G07「门口暗号」只在问句里的纯散文单元不算日常）时，它的词项（归一后 ≥ 4 位）在 `normalizedGuardedLeak` 里先从答案归一面剥掉再比——答案抄的是这条日常笔记自己的事实，不是别条的秘密。直答层只对直答单元、聚合层只对已引用善意单元生效；答案里真带出别条短号（原序 / 倒序）、直答单元自身在讲秘密、未引用单元，均照常整答占位（`test/r334-label-residency.test.ts` E01 用例；MCP 出口不享此豁免）。

### 7.2 照抄找回（0/3 → 3/3）

`verbatimRecallAnswer(question, notes)`：`questionRequestsVerbatim(question)` 且候选笔记（问句主题词命中 / 模型唯一引用）恰 1 条、`!is_sensitive`、`!unitTalksAboutSecret`、受守行全部为 `code` 且 `guardFoldReason(line) === null` 且非破坏性 → 答案 = 原文 + `[n]`；`finalizeAskAnswer` 新增 `verbatimRecall: true` 选项，跳过 `closeDirectGuard` 对 `code` 行的占位，其余（字符级比对 / 破坏指令 / 端点 / 隔离）全走。生成前先试确定性路由（主题词唯一命中），否则生成后按唯一引用替换。

### 7.3 多笔记长答

`closeAggregateVerbatim(answer, units, { visibleUnits })`：聚合层对**被引用且** `directGuardLines(u).length === 0 && !unitTalksAboutSecret(u) && guardFoldReason(u) === null` 的非敏感单元不做 LCS8 整句占位（等同直答层「卡片同屏」豁免）；凭证 / 端点 / code / 不透明 / 平铺 / 派生等「只增不减」补充判据对全部单元不变。`isRefusalAnswer` 的「带引用的部分否认」已不算拒答，但 `PHANTOM_REDACTION_CLAIM_RE` 分支会把整答替成「笔记里没提到」——改为只在答案**不含任何角标**时替换。

候选版生产复测（Worker/Pages `7144468b`，浏览器 Q11/Q12 仍失败）暴露的三处口径缝隙，补齐后才算 7.3 落地：

1. `aggregateCitedBenignUnit` 借用了分片拼接口径 `fragmentLooksLikeCode`，而日期 `2026-09-12` / 电话 `0571-88001234` / 版本 `22.4.1` 的分隔符被当成代码残片 → 牙科 / 物业 / sharp 三条日常单元全被排除在同屏豁免外。改 `unitLooksLikeCode`（数字分隔组不计），聚合层「代码形态单元」补充判据也不再看已享豁免的 visibleUnits。
2. SSE `reconcileDoneAnswer`：逐段闸门在 delta 时还不知道最终 references，扣段用的是无 `citedBenignUnits` 的聚合闸门；done 与 delta 同信任域时按「判据同源」直接删句，等于把 7.3 的豁免在流式出口整个绕掉（Q11 展览句 `sse_done_reclosed=1`）。改为 done 一律重跑带同屏善意单元的闸门，过闸即留。
3. 引证补全 `verbatimUncitedSourceIds` 与聚合收口不同折叠面（`\p{L}\p{N}` 去符 vs `foldPlain` NFKC+小写）、且只比正文不比标题，弱语义命中一律不补；模型复述了 A/B 却只标 C 的引用时，A/B 进不了 references → 信任域退成 `single_note_direct`，A/B 的句子按「未引用单元」整句占位、卡片又不在屏上（Q12 `verbatim_closed_spans=2`，1 卡）。改为同折叠面 + 计入标题；弱命中仅当该笔记为非敏感且 `aggregateCitedBenignUnit`（app 出口）时补——被复述的日常事实宁可多一张卡，不能「见引用笔记卡片」却无卡。弱语义 + 含称谓 / 受守 / 敏感的笔记维持不补、整句占位。
4. 确定性路由不经生成分支：时间窗拒答（`buildTimeWindowNoAnswerResponse`，E26 `去年 CPI 上涨 0.8%` 问「去年 CPI 涨多少」/ E27 Q4）把范围外相近笔记按 `safeSuggestionLabel` 列成 `[n]（日期）标签`，随后 `/api/ask` 出口中间件按聚合层整答收口——标签行是原文逐字，被换成 `〔原文片段略，见引用笔记卡片〕[1]`，卡片就在下方却「原文略」。改为中间件对 app 出口从 `references` 取非敏感（`is_sensitive` / `content_withheld` 均 false）且 `aggregateCitedBenignUnit` 的单元作 `citedBenignUnits`，与生成分支同一豁免；含称谓 / 受守 / 敏感 / MCP / 记账组装答案维持原口径。

### 7.4 已标注条 no_answer

`sensitiveHintLine` 与 `buildNoAnswerResponse` 合流：命中 N>0 条敏感元数据时答案首句为「有 N 条敏感笔记可能相关（已折叠，正文不进入问答），可到时间流搜索「kw」后点开解锁查看。」，不再出现「没找到相关笔记」；`sensitiveOnlyAnswer`（敏感卡片路径）同措辞。

### 7.5 文案

- `SAFETY_PROMISE`：「**已标注**敏感的笔记正文不进入 AI 回答；**未标注 / 已取消标注**的内容视为普通笔记，可能被 AI 转述、编码或计算」。
- `known-issues.md` §1 改写「取消标注解除的只是点开成本…兜底只对候选面负责」→ 称谓驻留口径 + 上面的 promise；新增：MCP `notes[]`（含 `amount`）对含称谓未标注笔记占位、编号类善意扣留（残余：命令备忘直答层占位）、多笔记长答省略（残余：受守 / 含称谓单元仍占位）。

---

## 8. 验证（实施后回填）

本机：`test/r334-label-residency.test.ts`；`npm test` / `typecheck` / web `lint` / `build` / Android `assembleDebug`。
生产：`qa-r333/prod/run.mjs seed marked unmark matrix` + `oracle-pair.mjs`；`qa-r334/prod/run.mjs` 族外语料 + 善意 50 + 照抄 3；浏览器 Q11 / Q12；`qa-r332` / `qa-r331` 回归；ask-eval / 财务 / injection / 生命周期；D1 / R2 零残留；Worker / Pages / main 同 SHA。
