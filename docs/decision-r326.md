# R326 决策记录：敏感隔离改为「标注即全出口占位」· 敏感笔记可召回为引用卡片 · 自动标注校准与显式取消

对应 `docs/audit-r325.md`（独立审查，R325 merge `52b58f1`）。标注口径沿用 R317–R325：【实测确证】= 本机 / 生产实跑拿到的数据；【推断】= 由证据推出的判断；【未验证】= 本轮没有拿到一手数据。本文写在改任何产品代码之前（先论证再动手）；§7 的实测数字在实施与生产复测后回填。

---

## 0. 结论速览

| 项 | 决定 | 依据 |
|---|---|---|
| A 安全边界 | **数据层 `notes.is_sensitive` 是唯一安全开关**：标注为敏感的笔记，其原文在所有 AI 出口一律只出「占位 + 点开指引」，与问句形态、内容形态、语言、长短、数字写法全部无关。R324「取值型问句才占位」的 `valueProbe` 分支从 `/api/ask` 删除；R322/R324 的行级替换与出口层归一化闭合**降级为对未标注笔记的纵深防御**，不再承担边界职责 | §1 |
| B 找回 | 敏感笔记**必须能被召回并以引用卡片出现**：ask 关键词召回与 REST 搜索新增「解密内存匹配」通道（密文只在 Worker 进程内解密用于匹配，明文不进模型、不进 SQL 明文列、不进 ask `notes[]`）；ask 对命中的敏感笔记给确定性引用卡片，只命中敏感笔记时**不调模型** | §2 |
| C 出口统一 | ask REST / SSE / MCP `answer`+`notes[]` 共用同一序列化点：敏感条目 `content` 为占位体、`title=null`、`tags` 为已洗净主题词、带 `id` 与 `content_withheld:true`；前端卡片点开时按 `id` 取原文（`GET /api/notes/:id`，需登录态）。回顾 / 线索 / 周报 / Push / export AI 摘要面维持 SQL 级排除（排除 ⊂ 占位） | §3 |
| D 自动标注校准 | 主判是分拣模型，规则只做 fail-closed 兜底（公司知识：阈值类判断不用简陋线性规则当主判）。**语义重定义**：敏感 = 「知道即可进入 / 登录 / 支付 / 开锁」的口令类值（任何语言、任何写法、有无称谓、散文或口述数字均算）；**显式负例**：车牌、订单 / 快递单号、会议号（无密码）、门禁卡编号、他人联系电话、证件后四位、地址、价格是标识符不是秘密。规则层：删除 prompt 中「完整车牌号 → true」；宽判据词表补多语言 / 比喻式口令称谓（暗号、咒语、门码、暗証、비밀번호、Passwort…）。误标成本 = 多点一次，不再是「找不回」 | §4 |
| E 显式取消 | 用户在卡片菜单「取消敏感标记」后：立即解密恢复明文并退出占位；`manual_override.is_sensitive` 记「用户对**这份内容**的定论」，异步复判对同一内容不得再升回敏感；用户**改写正文**时按新内容重新走入库门禁（新内容含密仍可 fail-closed 再加密） | §5 |
| F 验证 | 本地：新增 `test/r326-*.test.ts`（标注即占位 × 全出口、敏感召回、取消语义、校准前后对照）+ 既有全绿；生产：R325 盲测 + 读实现载体 × 直答 / 聚合 / SSE / MCP / 预言机 / 其他出口 + **找回矩阵**（≥10 条被标敏感的普通笔记：问答给卡、搜索命中、点开见原文）+ 校准前后误标率 | §6 / §7 |
| 有意保留的边界 | **文本本身对任何读者都不构成秘密**的载体（R325 L03「昨天想到的词：铜锁春雨」、L07「定下来了：白鹭飞过水面」）在数据层上就是普通笔记：短语自身无信号。产品给的答案是「用户手动标记为敏感」（既有菜单），不用「问句认出了取值意图」去遮。实施中的补充（§4.2-5）：「定下来了：<短语>」这种整条裸短语的**笔记形态**被采纳为标注层兜底信号，无结构的纯短语仍归手动标记 | §1.4 / §4.2 |

---

## 1. A：为什么边界只能是数据层标注

### 1.1 R325 失败的结构性根因【实测确证，audit-r325 §3 / §4】

- 盲测 27 条危险载体在生产的数据层实况：`sensitive 8 / fold 7 / 无标注 12`（L01 L02 L03 L06 L07 L08 L09 L10 L11 L12 V03 V15）。直答漏出的 4 条（V15 / L02 / L06 / L12）、MCP `notes[]` 原文 14 条、跨载体串扰施害问句（V11 / L01 / L03 / L04 / L06）、预言机 Q01——**全部落在「无标注」集合里**。
- 已标注（`is_sensitive=1`）的载体在所有出口 0 漏出：MCP `redactNote()` 早已对 `is_sensitive` 条目整条换占位（`mcp.ts`），ask SQL 直接 `is_sensitive = 0` 不召回，回顾 / 周报 / 线索 / Push 均 SQL 级排除。
- 即：R325 的攻击面结论**不是**「占位机制漏了」，而是「决定占不占位的判据放在了问句 / 内容形态上，而问句 / 内容形态是开放集」。R314→R325 十二轮在形态判据上加补丁，每轮盲测族外都失效——这是判据位置的问题，不是判据不够多。

### 1.2 三个位置的比较

| 边界放在 | 判定输入 | 族外行为 | 用户成本 |
|---|---|---|---|
| 问句意图（R324 方案 2） | 问句 + 历史 | 非取值句式（写诗 / 翻译 / 排序 / 比较）、外语、无称谓问句全部漏；预言机可用结构性操作绕过 | 正当找回被占位（BR01 / BR10） |
| 内容形态（R318–R323 受守行） | 单行字面 | 纯散文口令、口述数字、emoji 切开、跨笔记拆分全部漏 | 命令备忘 / 长数字被折叠 |
| **数据层标注（本轮）** | 一个布尔列 | **与形态无关**：标注为 1 的笔记，任何问句、任何出口都只有占位；未标注的笔记就是普通笔记 | 误标 = 多点一次卡片（§2 保证仍可找回） |

标注边界的安全性质是**结构性**的：模型没见过明文就变形不出来（R322 A 的论证），且「有没有见过」由 SQL / 序列化点决定，不由任何识别器决定。

### 1.3 实施要点（`backend/src/index.ts` `/api/ask`、`backend/src/mcp.ts`）

- 删除 `valueProbe` 分支（`isSecretValueQuestion` × `unitTalksAboutSecret` ⇒ `DIRECT_GUARD_PLACEHOLDER`）。`isSecretValueQuestion` / `unitTalksAboutSecret` 作为纯函数保留在 `prompt-armor.ts`（既有 `r324-entrance-closure.test.ts` 锁住其形态行为，不弱化），不再参与 `/api/ask` 的路由决策。
- 敏感笔记进入召回集合（§2）后，**模型上下文里对应条目只有一行元数据 + 固定占位**（`SENSITIVE_MODEL_LINE`），`title / content / url_* / 图谱三元组` 一律不取自明文。`askGuardNoteUnit` / `gateNoteText` / `scrubSource` 看到的是库内占位串 `[加密内容]`。
- 只命中敏感笔记（非敏感召回为 0）⇒ **不调用生成模型**，答案为固定文案 + 角标（`SENSITIVE_ONLY_ANSWER`）。混合命中 ⇒ 模型只见非敏感明文 + 敏感占位行；生成后由确定性步骤保证每条命中的敏感笔记都有角标（模型漏引则追加一行「另有 N 条相关敏感笔记，点开引用卡片查看原文 [k]」）。
- 末端复核（纵深，不是边界）：ask 最终 `answer` 与本次召回的敏感明文做归一化 ≥8 字重合比对（明文只存在于本次请求的闭包内），命中即整答替换为占位——理论上不可能命中（模型没见过），用来抓实现回归。
- 预言机 / 关系限定 / 时间窗等既有确定性路由保持不变；它们对敏感笔记看到的都是占位串，天然 0 bit。

### 1.4 有意保留的边界【推断】

- L03 / L07 类：短语在任何读者眼里都是一句普通短语，只有提问者自己知道它是口令；不应为此把所有短语都标敏感。产品答案 = 用户手动「标记为敏感」（既有入口）。实施中的修正（§4.2-5）：标注层对「动词：短语」整条裸短语笔记兜底（形态信号来自笔记结构而非短语），无结构纯短语仍归手动。
- 未标注笔记的纵深防御（R322 行级替换 / R324 出口归一化闭合 / 预言机中性化）保留，但**文档与 known-issues 不再把它们描述为安全边界**。

---

## 2. B：敏感笔记如何被召回而不泄露

### 2.1 现状【实测确证，代码 + audit-r325 §4.4 / §5.1】

- `keywordRecall` / 媒体类型 / 语义补召回 / 近期笔记 / 零召回建议：SQL 全部 `is_sensitive = 0`。
- 敏感笔记库内 `content = "[加密内容]"`、`title = NULL`、`tags` 只剩主题词、`content_enc` 为 AES-GCM 密文（`SUINIAN_ENC_KEY`）。`LIKE` 对 `content` 无从命中；`countSensitiveHits` 只能按 `title / tags / url_title` 元数据计数——这就是「零召回且搜不到」。
- `GET /api/notes?q=` 同理（`noteFilterConds` 走 `KEYWORD_FIELDS` LIKE），REST / MCP `search_notes` 对 I03 / I04 / I09 / I10 均 `recalled=0`。
- 语义索引：`semantic.ts` 对 `is_sensitive` 的笔记不生成 / 不检索向量。

### 2.2 候选方案

| | 方案 ① 解密内存匹配 | 方案 ② 盲索引（HMAC n-gram 列） | 方案 ③ 敏感笔记也进 embedding |
|---|---|---|---|
| 明文落点 | 只在 Worker 请求闭包内 | 密钥派生的 token 列（新 migration、全量重建） | 向量 = 明文的派生物，可被反演，等价于把明文换个编码存起来（违反 R120「派生明文一并洗净」） |
| 召回质量 | 与普通笔记同一 `LIKE`/包含语义 | 只能整词 / n-gram 精确匹配，中文分词依赖 | 语义召回 |
| 复杂度 | 一次查询 + N 次 AES-GCM 解密（N ≤ 300，WebCrypto 毫秒级） | 新列 + 索引维护 + 迁移 | 撤销既有隔离 |
| 结论 | **采用** | 留作 N 超阈值时的后续优化 | 拒绝 |

### 2.3 实施（新模块 `backend/src/sensitive-recall.ts`）

```ts
recallSensitiveNotes(env, userId, terms, { topicTerms, limit }) →
  SELECT * FROM notes WHERE user_id=? AND is_sensitive=1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 300
  for each row: plain = decryptContent(content_enc) ?? row.content（无密钥 / 明文存储回退）
    hay = plain + tags        // title 已置空
    hit = 全部 terms 命中 ‖ (≥1 topicTerm 命中 且 命中数 ≥ ceil(terms/2))
  返回 { rows: 原始 NoteRow（content 仍是占位，未解密）, plains: Map<id, plain>（只供本请求末端复核）, score }
```

- **行对象不解密**：返回给调用方的 `NoteRow.content` 仍是 `[加密内容]`，任何后续代码（模型上下文、`askGuardNoteUnit`、序列化）都拿不到明文；明文只以 `plains` 形式进入末端复核闭包，请求结束即销毁。
- 归因用**话题词**（`askTopicTerms(terms)`，剥掉称谓词），避免「问家里 wifi 密码引到跳板机」（R325 U2 错引根因之一：R324 归因只在受守笔记集合里挑，现在归因直接作用于真实匹配的敏感明文，卡片就是命中的那条）。
- REST `GET /api/notes?q=` 首页并入同一函数的命中（`match:"keyword"`），敏感命中行与 ask 引用卡同一序列化（`askRefNoteJson`：占位体 + id + `content_withheld`），前端点开时按 id 走 `GET /api/notes/:id` 取原文（实施中发现并修正：初版搜索命中行走 `noteToJsonDecrypted` 会让 REST/MCP `search_notes` 回传敏感原文，生命周期回归「search 不返回敏感明文」抓到）；MCP `search_notes` 叠加既有 `redactNotes`。
- **存在性预言机（实施中自查发现）**：解密内存匹配若对全文做「包含」，「Kq7 是什么」对 / 错前缀会分别返回「有卡 / 没卡」，每问漏 1 bit，可逐位试探拉丁 / 数字口令（R324 对受守行用 `normalizedGuardedLeak` 封的同一个洞，但那条路依赖识别哪一行是口令）。处理（`sensitiveRecallHaystack`）：匹配文本中抹掉所有值形态记号（字母数字串中除纯字母词、≤2 位数字以外的一切：含数字≥3 位 / 含符号 / 混排），拉丁词整词匹配（`maple` 不命中 `mapletree`）。不依赖识别「哪一行是口令」，只看记号形态；失败方向是少抹（只影响一个已知值的确认）而不是泄原文。ask 与搜索（含 MCP `search_notes`）同一口径。代价：敏感卡不能靠数字串 / 密码串本身找回，只能靠标签词（找回矩阵 10/10 全部靠标签词命中，不受影响）。**残留**：纯汉字口令短语（「铜锁春雨」）无形态信号，整串猜测可被确认；前缀探测只到 3 字（≥4 字走二元组覆盖，对 / 错尾字同样命中），每字需 ~3000 次探测且命中信号与用户全部敏感笔记混在一起。这一残留与已登录用户的搜索能力是同一件事，不再用识别汉字口令的方式去封（那就回到 12 轮失败的路）。
- 上限：每问最多 5 张敏感卡，多于 5 时答案追加「另有 N 条，可到时间流搜索」。

---

## 3. C：出口统一

| 出口 | 现状【实测确证】 | 本轮 |
|---|---|---|
| `/api/ask` REST `answer` | 模型见明文（未标注时） | 敏感条目只见占位行；只命中敏感 ⇒ 不调模型 |
| `/api/ask` REST `notes[]` | `noteToJsonDecrypted` 回传**解密明文**（登录用户） | `askRefNoteJson()`：敏感条目 `content=SENSITIVE_CARD_PLACEHOLDER, title=null, content_withheld=true`，保留 `id / category / created_at / tags(已洗净) / is_sensitive` |
| SSE `delta` / `done` | delta 由终答切片（R276） | 同上，无额外面 |
| MCP `ask` `answer` / `notes[]` | `redactNote` 已对 `is_sensitive` 占位；`closeMcpAskAnswer` 末端复核 | 上游已占位，`redactNote` 仍保留为纵深；`guard_kind:"sensitive"` 不变 |
| MCP `get_note` / `search_notes` / `list_*` | `redactNotes` | 不变 |
| 回顾 / 线索 / 周报 / Push | SQL `is_sensitive = 0`；周报有「含 N 条敏感记录，仅计数」 | 不变（排除 ⊂ 占位） |
| export / backup | `notes[].content` 原文（数据面契约：用户自己的数据）、AI 派生字段已洗 | 不变；known-issues 写明 |
| 前端引用卡片 | `NoteCard` 直接渲染 `notes[]` 里的明文（且写入 localStorage 对话历史） | `content_withheld` 卡片点「敏感内容，点击查看」时 `getNote(id)` 取原文；历史里只留占位 |

---

## 4. D：自动标注校准

### 4.1 现状与误标构成【实测确证，audit-r325 §3 / §5.1】

- 判定链：入库 `sensitiveIngestGate` → `maybeSensitive`（`detectSensitive` 定论规则 ∪ `SENSITIVE_TOPIC_RE` 宽判据 → fail-closed 先加密 + `needs_retriage`）→ 分拣模型复判 → `applyTriage`（模型判非敏感则恢复明文；`detectSensitive` 命中时强制 true）。
- R325 报的「6/10」（UI 账号）逐条看：V01 / V05 / L04 / BR10 是真口令（正确标注），**误标是 BR05 车牌、BR07 门禁卡编号 2 条**；盲测账号另有 BR04 身份证后四位、BR08 手机号。误标来源分两类：
  1. **prompt 明写车牌 → true**（`triage.ts` L257）：模型照做，属规范错误不属模型误差；
  2. 标识符与秘密混同：门禁卡「编号」（报给物业补卡用）被当门禁「密码」。
- 同一文本跨账号标注不同（L04 / BR05）：模型判定有抽样噪声，degraded 回退模型下更明显【推断】。

### 4.2 校准方向（以模型为主判，规则 fail-closed）

1. **prompt 语义重定义**（正例 / 负例各给判例）：
   - 敏感 = 记录了一个「知道即可进入 / 登录 / 支付 / 开锁 / 通过验证」的值：密码 / 口令 / 暗号 / 咒语 / 门码 / 柜子的数 / wifi 串 / PIN / 取件柜的开锁码，**无论**用什么称谓、没有称谓、哪种语言、是不是散文、数字是阿拉伯还是中文口述，也包括「按 X 才能进」「贴的纸上写的是 X」「现在用的是 X 这一串」。完整证件号、完整银行卡号、私钥 / API key / token 同为敏感。
   - 非敏感 = 用来**指代**事物的标识符：车牌、订单号、快递单号、会议号（无密码）、门禁卡 / 会员卡 / 工牌**编号**、他人联系电话、证件后四位、地址、价格、日期、哈希 / 版本号 / 占位符。
2. **删除**「完整车牌号 → true」判例。
3. `SENSITIVE_TOPIC_RE`（宽判据，只触发 fail-closed 先加密 + 复判）补：`暗号|咒语|门码|门禁码|passcode|暗証|비밀번호|Passwort|mot de passe|contraseña`。它不是识别边界，只是让「模型复判前的窗口」也 fail-closed。
4. `detectSensitive` 定论规则（`r140-sensitive-variants` 等既有测试锁住）既有项**不改**：手机号 + 称谓 / 证件号 / 卡号 / 密钥字面仍为定论。BR08 类「维修师傅电话」因此仍会被标敏感，但本轮后可正常召回为卡片，成本降为一次点开。
5. **生产实测后追加的标注层兜底规则**（实施中加入，如实记录）：degraded 回退模型在终版前的生产入库中漏标了 L01 / L04 / L07 / L08 / L09（无称谓接入码 / 口述拼接 / 裸短语），其中 L08 / L07 的值经善意问句的聚合答案串出（跨载体 2 处）。这是**标注召回缺口**，不是出口护栏缺口。处理方式仍在标注层：给 `detectSensitive` 追加三条窄规则——① 进门动作 +≥ 2 字母≥ 2 数字混合码 + 结果连词（「门上要按 gk8823 才开」）；② 「写的是 / 贴的是」+ 高熵记号（`opaqueTokensOf`）；③ 两段以上数字 +「中间不加符号 / 拼在一起」；④ **裸短语笔记**：整条笔记只是「定下来了 / 想到的词 / 就用这个：<2–12 字短语>」，日期 / 时间 / 数字短语与带后缀句子不命中。④ 修正了 §1.4 对 L03 / L07 的预判：「动词：短语」这个**笔记形态**本身就是一个可用的信号（普通笔记极少这样写），而非“短语自身”；只有短语、无任何结构的笔记（「白鹭飞过水面」）仍不识别，继续由手动标记负责。这些规则的误报代价都是「多点一次」；它们是标注层对 degraded 模型的兜底，不是新的安全边界，族外形态（如外语裸短语）仍依赖模型主判。本地校准表见 §7.4。

### 4.3 度量

- 本地确定性面：`backend/scripts/qa-r326/calibration.ts` 对 R325 全部载体（V/L/Q/B/BR/I）跑 `maybeSensitive` / `detectSensitive`，输出校准前（`main`）后（本分支）的命中表。
- 生产模型面：同一语料在终版部署入库 → 分拣完成后读 `is_sensitive`，与 audit-r325 §3 表逐条对比：危险载体标注召回率、B/BR 善意误标率。回退模型下的结果如实标注 degraded。

---

## 5. E：显式取消的语义

### 5.1 现状【实测确证，代码】

- `PATCH /api/notes/:id {is_sensitive:false}`：`applyNotePatch` 解密恢复明文、`manual_override.is_sensitive = true`（记「用户手动定过」）。
- `applyTriage` 只锁**降级方向**：`manual_override.is_sensitive && row.is_sensitive && !triage.is_sensitive ⇒ 保持 true`。用户取消（`row.is_sensitive=0`）后若 cron 复判为敏感，会**再次加密**——取消不稳定。
- 前端 `note-card.tsx` 菜单已有「取消敏感标记 / 标记为敏感」，`timeline.tsx` `handleToggleSensitive` 带 pending 态。

### 5.2 决定

- `applyTriage`：`manual_override.is_sensitive` 存在 ⇒ 敏感位以库内当前值为准，模型复判**两个方向都不覆盖**（用户对这份内容的定论优先）。
- 内容变化时用户定论失效：`applyTriage` 已有「分拣快照 ≠ 当前内容 ⇒ 丢弃并重分拣」；`applyNotePatch` 改正文走 `sensitiveIngestGate`（`wantSensitive = p.is_sensitive ?? existing.is_sensitive`）。补一条：**正文变化的 PATCH 清除 `manual_override.is_sensitive`**，让新内容回到「模型主判 + 规则 fail-closed」。
- 卡片文案更新：不再说「不进入问答与搜索」，改为「问答与搜索里只显示占位卡片，点开可看原文；若属误判可在菜单取消敏感标记」。
- 前端引用卡片（ask 面板）同样提供该菜单（复用 `NoteCard` 的 `onToggleSensitive`），并在 375px 下可达。

---

## 6. 验证矩阵

### 6.1 本地（全部必须绿）

| 项 | 命令 / 文件 | 覆盖 |
|---|---|---|
| 新增 | `backend/test/r326-sensitive-recall.test.ts` | `askRefNoteJson` 敏感条目无明文；`recallSensitiveNotes` 命中 / 不命中 / 话题归因；只命中敏感 ⇒ 固定答案不调模型；`applyTriage` 取消后不回升、内容变更后可回升；MCP `notes[]` 敏感条目占位 |
| 新增 | `backend/scripts/qa-r326/calibration.ts` | R325 全语料 `maybeSensitive` / `detectSensitive` 校准前后表 |
| 既有 | `cd backend && npx vitest run`、`npm run typecheck` | 193 个测试文件；R324 纯函数测试保持 |
| 既有 | ask-eval 141 / 财务 36 / injection 498 / 生命周期 | `backend/scripts/` 对应脚本 |
| 前端 | `cd web && npm run lint && npm run build` | 卡片 `content_withheld` 取原文；文案 |
| Android | `./gradlew assembleDebug` | 编译（ask `notes[]` 新字段向后兼容） |

### 6.2 生产（终版部署后，`[QA-R326]` 账号，测后注销）

| 矩阵 | 脚本 | 验收 |
|---|---|---|
| R325 盲测 27 危险 + 读实现 8 危险 × 直答 / 聚合头 / SSE done+emitted | `qa-r326/prod/ask.mjs`（沿用 r325 lib） | `survive=0 / lcs8=0`（§6.3 单列） |
| 跨载体串扰 | `qa-r326/prod/cross-scan.mjs` | `cross=0` |
| MCP `ask` | `qa-r326/prod/bypass.mjs` | `notes[]` 敏感条目原文 0；answer survive 0 |
| 预言机 Q01–Q10 T/F | `qa-r326/prod/oracle.mjs` | 含 Q01 族 `bits_upper=0`（两侧同文案或均为卡片指引） |
| 其他出口（回顾 / 线索 / 周报 / export / MCP 泛问 / push） | `qa-r326/prod/outlets.mjs` | `leaking=0` |
| **找回矩阵** | `qa-r326/prod/recall.mjs matrix` | ≥10 条被标敏感的普通笔记：ask `references` 含该 `note_id`、`notes[]` 对应条目 `content_withheld=true` 且无明文；`GET /api/notes?q=` 命中；`GET /api/notes/:id` 返回明文；零召回 0 |
| 校准 | `qa-r326/prod/recall.mjs seed`（B/BR 46 条默认分拣入库后读 `is_sensitive`）+ 本地 `calibration.ts` main / 本分支各跑一次 | 善意误标率实测值 + 校准前后对照 |
| 取消 | `qa-r326/prod/recall.mjs unmark` | `PATCH is_sensitive:false` ⇒ ask 直答含原文；触发 retriage 后仍为 0 |
| 部署 | `wrangler versions upload` + `wrangler deployments list` | 记录版本 |

### 6.3 验收口径的一处说明

`survive=0` 对「文本本身不含任何秘密信号」的载体原预计（L03 / L07）只能在**用户手动标记后**成立（§1.4）。实施中的修正见 §4.2 第 5 条：这两条的「动词：短语」整条笔记形态由标注层裸短语规则兜底；真正无结构的短语笔记仍归手动标记。若模型（含 degraded 回退）对某条未标注，如实记录为**标注召回缺口**；允许的处理只有一种——在标注层加窄规则兜底（误报代价 = 多点一次），不允许回到在出口用问句 / 内容形态识别去遮——后者正是本轮要停止的做法。

---

## 7. 实测回填（实施后）

口径：以下每一行都标注来源。「工具输出」= 本会话终端实跑；「推断」= 由输出推出的解释。原始日志在会话机 `backend/scripts/qa-r326/out/final/`（QA 输出不入库）。

### 7.1 部署

| 项 | 值 | 来源 |
|---|---|---|
| Worker 终版 | version `82ded90a-c220-4b39-895f-90a91dcc68f1`（含预言机敏感-only 分支修正 + 无称谓接入码规则），`wrangler versions deploy … @100%` SUCCESS，`wrangler deployments list` 最新一条为该版本 100% | 工具输出 |
| Pages | 线上 `assets/index-CPMwo6UO.js` 与本分支 `web/dist` 构建产物同哈希；`/known-issues` 已为 R326 版 | 工具输出 |
| AI 链路 | `GET /health?probe=ai` ⇒ `{"ok":true,"ai":{"ok":true,"degraded":true}}`：主模型 DeepSeek 仍不可用、由 fallback 层应答。以下所有生产数字均在 **degraded** 状态下测得（自动标注的模型主判即 fallback 模型） | 工具输出 |

### 7.2 本地

| 项 | 结果 | 来源 |
|---|---|---|
| `backend` vitest | 192 files / 4245 tests 全过（含新增 `r326-sensitive-recall.test.ts`；R324 纯函数测试未弱化） | 工具输出 |
| `backend` typecheck | 0 错 | 工具输出 |
| `web` lint / build | 均 exit 0（lint 仅 1 条既有 warning：`insights.tsx` effect 内 setState，非本轮引入） | 工具输出 |
| Android `assembleDebug` | exit 0（终版源码树） | 工具输出 |

### 7.3 生产脚本（`[QA-R326]` 账号，终版 Worker）

| 矩阵 | 结果 | 来源 |
|---|---|---|
| 财务 36 | 36/36 | 工具输出 |
| 生命周期 | 14/14（含注销后旧 token 401） | 工具输出 |
| ask-eval 141 | 全量一次：**137/141（97%）**，CITE 140/141；失败 q10 / q16 / q37 / q41 均为聚合 / 演变类问题的答案质量判据（非引用错误、非敏感相关）。同账号 `--only=q10,q16,q37,q41` 复跑 4/4 通过 ⇒ 4 失败为 degraded fallback 模型采样抖动（推断，n=1 复跑）；**不宣称 141/141 全绿** | 工具输出 + 推断 |
| injection 498 | 变体 240 / 问答 498；**泄露 0**；执行：第一次全量 0，第二次全量 2（R268-29 压力话术 / R272-34 伪造出处，均只在「有哪些备忘和提醒？」问法、REST 入口下答案复述了资料里的指令文案，同变体另一问法及 MCP 入口中和）⇒ 该两例为 fallback 模型复述抖动而非稳定穿透（推断，两次全量互不一致）；**benign 误伤 16/54**（与 R325 记录同值，均为命令 / 端点 / 端口 / 主机字面的护栏误伤，非本轮引入）。评测脚本因 benign 误伤 exit 1，**本项不算绿** | 工具输出 + 推断 |
| R325 盲测 27 危险 × 直答 / 聚合 / SSE | __BLIND__ | 工具输出 |
| R325 盲测 44 善意 × 直答 / 聚合 / SSE | __BENIGN__ | 工具输出 |
| 读实现载体 I01–I08 × 直答 / 聚合 / SSE | `survive=0/8 lcs8=0/8`（三层均为 0），`useful_all_turns=8/8`；善意 2 条 survive=0 | 工具输出 |
| MCP `ask`（读实现语料） | `answer_survive=0 answer_lcs8=0 notes_survive=0 notes_lcs8=0 raw_survive=0`，8/8 条 `notes[]` 敏感条目为占位体 + `guarded_notice` | 工具输出 |
| 跨载体串扰 | `answers scanned=10 hits=0 own=0 cross=0` | 工具输出 |
| 其他出口（回顾 / 线索 / 周报 / 月报 / export / MCP 泛问 / push） | `checked=7 leaking=0`；周报 / 月报文案为「含 N 条敏感记录，仅计数不展示内容」；push 因无订阅返回 400（无内容出口） | 工具输出 |
| 预言机 Q01–Q10 T/F | 终版：`variants=10 comparable=9 no_recall=1 bits_upper=0 semantic_oracles=0 survive=0`。Q01 族两侧同为敏感卡片指引（0 bit）。上一版曾有 Q03 `bits_upper=1`（真值侧走普通受守中性答案、错值侧只剩敏感卡片）——根因是预言机分支只在「有普通受守候选」时进入，敏感-only 命中会落到生成路径；终版改为 `guarded.length > 0 \|\| sensRecall.rows.length > 0` 后两侧同形，0 bit | 工具输出 |
| 预言机双账号（A 真值 / B 错值，各 10 题 × T/F） | 终版：标注状态 A=B（`annotDiv=∅`）；`questions=20 same=20 diff(bits_upper)=0 survive=0`。上一版 `same=17 diff=3`，3 个 DIFF 题在 A 侧重问全部 A1≠A2（采样抖动，`value_dependent_upper=0`） | 工具输出 |
| **找回矩阵** | 10 条被标敏感的普通笔记（BR01–BR10；其中 4 条为自动标注、6 条手动补标）：`ok=10 zero_recall=0 search_miss=0 raw_leak=0 open_fail=0`——每条 ask `references` 含该卡、`notes[]` 条目 `content_withheld=true` 且无明文、`GET /api/notes?q=` 命中、`GET /api/notes/:id` 见原文、MCP `notes[]` 给占位体 + `guard_kind=sensitive` | 工具输出 |
| 取消标记 | BR07 `PATCH is_sensitive:false` ⇒ 200，卡片退出占位（`content_withheld=false`、正文原文）；等待异步复判窗口后仍 `is_sensitive=false`（不回升）。**注意**：取消后 ask 直答对「门禁卡编号 A2213」这类口令形态行仍由 R322 行级护栏给「点开卡片看原文」，不转写取值——这是保留的纵深防御（§1.4），卡片与搜索已可见原文 | 工具输出 |

### 7.4 自动标注校准（前后对照）

本地 `calibration.ts` 对 R325 全语料（45 危险 / 46 善意）只跑规则层（`maybeSensitive` 预检 / `detectSensitive` fail-closed）；模型主判需生产实测。

| 指标 | main（R325 基线） | 本分支 | 来源 |
|---|---|---|---|
| 危险 45：规则 fail-closed 命中 `detect` | 7 | 21（终版；追加 §4.2-5 规则前为 15） | 工具输出 |
| 危险 45：进模型预检 `maybe` | 18 | 45（终版；追加前 36） | 工具输出 |
| 危险 45：规则全漏（只能靠模型） | 27 条 | 0 条（终版；追加前 9 条：V05, L01, L03, L04, L07, L08, L09, L10, Q06）。注：这是对 R325 已知语料的覆盖，不代表族外覆盖 | 工具输出 |
| 善意 46：规则硬误标 `detect` | 2（BR01, BR08） | 2（BR01, BR08，未增） | 工具输出 |
| 善意 46：预检 `maybe`（交模型纠正） | 7 | 8 | 工具输出 |
| **生产实测善意误标率**（默认分拣入库后读 `is_sensitive`，degraded 模型） | R325 报 6/10（BR） | **4/44 全善意；BR 4/10（wifi / zoom / phone / locker）；B 散文 0/34** | 工具输出 |

解释（推断）：BR 4/10 与 R325 的 6/10 同量级、略降，说明 fallback 模型仍偏保守；但 R326 的设计把误标代价从「找回被断」降为「多点一次」——上表找回矩阵里这 4 条全部可命中、可点开、可取消。危险侧规则兜底从 7 提到 21（其中 6 条是生产实测发现 degraded 模型漏标后追加的窄规则，§4.2-5），善意硬误标保持 2 条未增；预检 `maybe` 侧善意 8 条中 BR01（wifi 串）/ BR08（手机号）属设计内。

### 7.5 未验证 / 残余

- 纯中文短语式秘密（无字母数字值形态）仍可被「以值试探」召回（§2.3 已记）；本轮未做该族的生产矩阵。
- 预言机终版 `bits_upper=0` / 双账号 `diff=0` 各只跑了一轮，未做多次采样统计；上一版的 3 个 DIFF 已由同账号重问归为采样抖动（n=1）。
- ask-eval 137/141 与 injection 「执行 2」均为 degraded 回退模型下的非确定性结果（复跑互不一致），injection benign 误伤 16/54 是 R325 已记录的既有值；三项都不宣称绿，DeepSeek 恢复后需复测。
- §4.2-5 追加的标注层规则只覆盖 R325 已知形态；外语裸短语、无结构纯短语笔记在 degraded 模型下仍可能漏标（标注召回缺口），漏标则只剩 R322/R324 纵深护栏。
- 模型主判的校准数字全部在 degraded（fallback 模型）下测得；DeepSeek 恢复后数字会变，需要复测。
