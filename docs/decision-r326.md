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
| 有意保留的边界 | **文本本身对任何读者都不构成秘密**的载体（R325 L03「昨天想到的词：铜锁春雨」、L07「定下来了：白鹭飞过水面」）在数据层上就是普通笔记：模型与规则都不可能、也不应该把它们标敏感。对这类内容产品给的答案是「用户手动标记为敏感」（既有菜单），本轮验收对它们单列统计（§6.3），不用「问句认出了取值意图」去遮 | §1.4 |

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

- L03 / L07 类：文本在任何读者眼里都是一句普通短语，只有提问者自己知道它是口令。标注层（模型 + 规则）不可能识别，也不应为此把所有短语都标敏感。产品答案 = 用户手动「标记为敏感」（既有入口）。§6.3 单列计数，并用「手动标记后再问」验证管线。
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
- REST `GET /api/notes?q=` 首页并入同一函数的命中（`match:"keyword"`），返回沿用 `noteToJsonDecrypted`（登录用户对自己数据的既有契约，前端卡片默认遮罩 + 点开查看）；MCP `search_notes` 走既有 `redactNotes`，敏感条目占位（契约不变）。
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
4. `detectSensitive` 定论规则（`r140-sensitive-variants` 等既有测试锁住）**不改**：手机号 + 称谓 / 证件号 / 卡号 / 密钥字面仍为定论。BR08 类「维修师傅电话」因此仍会被标敏感，但本轮后可正常召回为卡片，成本降为一次点开。

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

`survive=0` 对「文本本身不含任何秘密信号」的载体（L03 / L07）只能在**用户手动标记后**成立（§1.4）。报告里把这两条单列为「需手动标记」，并附「手动标记后再问 ⇒ 占位」的实测；其余 25 条危险载体（含 V15 / L01 / L02 / L06 / L08 / L09 / L10 / L11 / L12 / V03 无称谓 / 比喻 / 外语 / 口述数字族）要求自动标注 + 占位达成 `survive=0`。若模型（含 degraded 回退）对其中某条未标注，如实记录为**标注召回缺口**而不是用形态规则补丁遮住——这正是本轮要停止的做法。

---

## 7. 实测回填（实施后）

（待填：本地 vitest / typecheck / lint / build / assembleDebug；ask-eval / 财务 / injection / 生命周期；生产各矩阵数字；校准前后对照表；degraded 状态；wrangler 版本。）
