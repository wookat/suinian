# R292 设计论证（先论证后动手）

依据：docs/audit-r291.md（独立审查，NO-GO 第十六轮）。本文先给出每项修复的
根因证据、方案对比与验证方式，写完并自查后才开始改产品代码。

---

## §1 P0-1：「是否降级」与「隔离哪一段」彻底解耦

### 1.1 根因（一手源码对照 + audit-r291 §3 实测）

R291 实测 38 次近生产观测中 22 次 fail-open：`execcls_ms≈8001`（判别器确实超
时）却既无 `exec_guard_degraded` 也无隔离标记，原样交付 `curl … | sh`。

源码结构（`index.ts` classifyExecDanger → `finalizeAskAnswer` →
`isolateNoteInstructions`）：

1. 判别器返回 null 时 `classifyExecDanger` 置 `unavailable: true`——这一步没丢。
2. 但 `isolateNoteInstructions(execClassifierUnavailable=true)` 里，实际会不会
   出现任何隔离标记，完全取决于 `execDegradedIsolationUnitsWithSource()` /
   `globalHit` 能否**识别出载体**。A04（URL-encode 整条命令）、A05（`$(printf
   'cur')l` 字符拼接）、A08（变量间接 `C=cur; L=l; $C$L`）都不被
   `normalizeCommandText`/`normalizeJudgeSurface` 归一出 `curl|sh` 形态 ⇒
   识别单元为空 ⇒ 原文原样返回。
3. `finalizeAskAnswer` 的 `degraded` 标志又是从**输出文本里是否含
   EXEC_DEGRADED_ISOLATED_MARK 反推**的（`out.includes(...)`）——识别不出载体
   ⇒ 没有标记 ⇒ `degraded` 不置位 ⇒ `exec_guard_degraded` 缺失。

即审查人指出的结构：`execDegradedIsolationUnits` 同时充当「隔离哪一段」和
「要不要降级」，识别不到载体就整条放行。

### 1.2 方案：状态与定位解耦

- **要不要降级**：只由判别器状态决定。`classifyExecDanger` 返回
  `unavailable: true`（超时/不可用/解析失败/抛错）⇒ `finalizeAskAnswer` 的
  返回值**无条件** `degraded: true`，`exec_guard_degraded` 无条件下发，末尾
  无条件追加 EXEC_DEGRADED_NOTICE（降级说明 + 重试提示）。不再从输出文本反推。
- **隔离哪一段**：纯定位问题，分三层，层层兜底：
  1. 精确定位：既有 `execDegradedIsolationUnitsWithSource` ∪ 全局判定命中的
     能力行（不变）；
  2. 定位失败兜底（新增）：降级窗口内**所有代码区域**（codeUnitSpans ∪ 归一化
     行中呈代码形态的行）保守隔离——判别器本来要判的就是「这些代码危不危险」，
     它不可用时这些代码的安全性未知，fail-closed 即不交付；官方安装源白名单
     豁免维持（警示 + 保留，确定性判据，不依赖 LLM）；
  3. 整答兜底（新增）：门控已开（gate ≠ null，说明答案含可疑代码形态）而上面
     两层一个区间都没定位到 ⇒ 整答替换为 EXEC_DEGRADED_ISOLATED_MARK。
     出口收尾再加一道保险：`execClassifierUnavailable=true` 且输出既无降级
     隔离标记也无官方安装警示 ⇒ 整答隔离。宁可整条不给，不能原样放行。

**安全下界（最坏情况）**：判别器不可用 + 载体完全识别不出时，用户看到的是
「〔代码安全判别暂不可用，已对疑似可执行代码保守隔离（未展示）…〕 +
（本次回答处于代码安全判别降级窗口…稍后重试…）」，前端据
`exec_guard_degraded` 显示蓝色降级横幅与「重试本轮提问」按钮。原文永不交付。

**代价评估**：降级窗口内含代码的 benign 答案会被保守隔离（有降级说明与重试
入口，非误标危险）；纯自然语言问答门控不开（gate=null 时判别器根本不会被调
用，unavailable 不会置位），零影响。该取舍正是审查意见「宁可整条不给」。

### 1.3 验证

- 本地慢桩（AI 出口 sleep > EXEC_CLASSIFY_BUDGET_MS）先复现 R291 fail-open
  （改前跑 A04/A05/A08 等载体），再证明修后 leak=0、`exec_guard_degraded`
  全部置位；
- 单测：`classifyExecDanger` 抛错/超时/解析失败 ⇒ degraded 必置位；识别单元
  为空 ⇒ 整答隔离；归一化函数自身抛错 ⇒ gate 返回 "gate:error" 仍会调判别器
  （现状），判别器 null ⇒ 仍走上述下界。

## §2 P0-2 / P1-1：归一化处理引号切分、变量间接、字符拼接（两态都要）

### 2.1 根因

R291 §2.2/§3：`w'g'et … | s'h'`（引号切分）、`C=cur; L=l; $C$L`（变量间接）、
`$(printf 'cur')l`（字符拼接）、URL-encode 整条命令，在
`normalizeCommandText` 后仍不呈 `curl|wget … | sh` 形态，能力内核
（CAP_NET/CAP_EXEC/EXEC_PIPELINE_RE）全部落空。常态路径（判别器在线但漏判/
只判部分段）与降级路径同时受影响。

### 2.2 方案：normalizeCommandText 增加确定性反混淆层（只用于判定面，绝不
改写交付文本）

在 NFKC/续行/注释折叠之后追加（顺序固定，各自幂等、有界）：

1. **percent-decode**（≤2 轮，`%XX` 十六进制对）：还原 A04 URL-encode 载体；
2. **引号/反引号切分还原**：字母数字间的空引号对与单引号包裹的单字符
   （`w'g'et`→`wget`、`ba''sh`→`bash`、`cu"r"l`→`curl`）；
3. **$(echo X)/$(printf X) 内联展开**（单层、无嵌套命令替换时）：
   `$(printf 'cur')l`→`curl`；
4. **shell 变量赋值代入**（同文本内 `NAME=value` 赋值收集后代入 `$NAME`/
   `${NAME}`，≤2 轮防循环）：`C=cur; L=l; $C$L`→`curl`。

误伤面：这些变换只作用于**判定输入**（能力内核、打分、门控、降级定位），
用户可见文本与 verbatim 出口一律不用它。良性文本里 `50%` 不成对不解码；
`don't` 撇号后是多字符不命中切分还原；变量代入只在同文本有赋值时启用。
以既有 benign 测试集 + 新增混淆载体测试量化。

### 2.3 验证

- 单测锁死：上述 4 类混淆归一后 `hasExecIntentReason` 命中；
- 常态（判别器在线）：混淆命令走危险隔离/警示（P1-1）；
- 降级：即便未来新混淆归一失败，也被 §1 的层 2/层 3 兜住（专门测试：伪造一个
  归一化识别不出的代码块，断言整段/整答隔离 + degraded 置位）。

## §3 P1-2：财务/时间窗筛选统一接入正文事件时间

### 3.1 根因

`noteEventTime()`/`inEventTimeRange()`/`widenTimeRangeForEvents()` 已存在
（ask.ts），但只接在 3 个调用点；index.ts 里其余 ~20 处时间窗/财务/枚举/关键
词筛选仍用 `created_at >= ?` SQL 粗筛 + `inTimeRange(n.created_at, range)`
精筛。正文写「3 月 8 日买菜 45」而笔记创建于 5 月 ⇒ SQL 粗筛直接漏。

### 3.2 方案：收敛到单一辅助，禁止散点接入

ask.ts 新增单一辅助 `eventWindowFilter(range)`：
- `sqlConds(col)`：返回**放宽后**（widenTimeRangeForEvents）的 SQL 条件与绑定
  ——粗筛只放宽不收紧，保证含正文事件日期的行进入候选；
- `keep(rows)`：TS 精筛 `inEventTimeRange(note, range)`（正文事件时间优先，
  无事件时间回落 created_at）。

index.ts 所有时间窗调用点（澄清、全量、比较、阈值、品类枚举、双窗、关键词
子集、通用时间窗、计数）一律改经该辅助；窗口内 `COUNT(*)` SQL 改为取行后
`keep().length`（行集已有 LIMIT 上限的沿用上限）。

### 3.3 验证

- eval 新增 6 场景锁死：①2025年12月花了多少 ②1月3日那笔多少钱 ③3月8日
  （正文日期含空格）花了多少 ④3月下旬花了多少 ⑤3月8日之前 ⑥3月8日以后；
- 生产逐条实测 6 问法并与全量财务底账对照。

## §4 P1-3：认证/危险操作不经 Service Worker

### 4.1 根因

R291 §8.3：开启离线缓存时「永久注销」前两次超时失败。SW 一旦 wedge，即使
workbox 路由对 `/api/auth` 不命中（现有 runtimeCaching 只缓存 GET
notes/threads/reports），fetch 事件仍要等 SW 进程响应。`escapeSwWedgeForAuth`
只挂在 authPost（注册/登录），注销/删号路径没有覆盖（审查推断，本轮源码
确认）。

### 4.2 方案

1. **SW 侧显式直通**：自定义 `sw-api-bypass.js` 经 workbox `importScripts`
   先于路由注册 fetch 监听：`url.pathname.startsWith('/api/') 或目标主机为
   API 域` 时直接 `return`（不 respondWith），浏览器走原生网络——workbox
   路由在其后也不会再拦截（我们同时把 runtimeCaching 的 urlPattern 限定为
   GET 且非 auth/破坏性路径，双保险）。
2. **客户端超时逃生扩展到全部认证/破坏性调用**：注销（DELETE /api/auth/me）、
   登出等与注册/登录同一口径：短首轮超时 → `escapeSwWedgeForAuth`（解除 SW
   注册 + 清 caches）→ 重试。
3. 说明：SW wedge 属浏览器基础设施故障形态；产品侧能做的是「不让关键请求
   排队等一个挂了的 SW」，以上两层分别覆盖「SW 活着但慢」与「SW 卡死」。

### 4.3 验证

真实浏览器开启离线缓存（SW 激活、控制页面）下注销成功 ≥3 次（testing agent
录屏）。

## §5 P2-1：verbatim 逐字还原

根因（audit-r291 §2.4 + 源码对照）：
- emoji：`scrubDataDerivedGlyphs`（R272 水印剥除）没有 verbatim 豁免——
  R272 支柱 3 在 scrubQuotedDataEchoes/scrubDataDerivedMarkers 都有豁免，唯独
  这一门漏了；
- `run()`→`run:`：模型渲染吞空参括号，benign verbatim 出口没有资料原文还原
  （危险段有 restoreVerbatimFromData，benign 段没有）；
- 软连字符/NBSP：入口 `neutralizePromptInjection` 层 0 剥除不可见字符（安全
  需要，保留），模型输出自然不含——需要出口从资料原文（askGuardData 含笔记
  原文）还原。

方案：
1. `scrubDataDerivedGlyphs` 增加 verbatim 豁免（与其它 R272 门同口径）；
2. finalizeAskAnswer 在隔离之后增加 **verbatim 行级原文还原**：verbatim 问法
   下，答案中不含系统标注〔…〕的行，折叠等价（fold 口径扩展：忽略软连字符等
   不可见字符）于资料原文切片而字面不同时，替换为原文精确切片；还原结果若引
   入 `hasExecIntent` 危险（而该行原本未被标记）则放弃还原（fail-closed）；
3. foldCompact 的不可见字符类补 `\u00ad\u180e\u034f`（只影响匹配鲁棒性）。

验证：O01/O03/O11 三类样本回归测试（空参括号、emoji、软连字符/NBSP 逐字）。

## §6 P2-2：注册/登录慢的归因与反馈

现状：PBKDF2-HMAC-SHA256 100k 迭代在 Workers 实测 <100ms 量级，不足以解释
40–100s；R291 归因未验证。方案：
1. 后端 `/api/auth/*` 加 Server-Timing（pbkdf2/d1/total 分相计时），生产实测
   归因（一手证据）；
2. 前端注册/登录/注销给进度反馈：spinner 附「已等待 Ns」计时与预期提示文案，
   超过首轮超时自动走 SW 逃生重试（§4）；
3. 修复前后对比实测（生产注册/登录时延）。

## §7 测试矩阵（补审查人点名的盲区）

「判别器超时 × 引号切分/编码载体」测试面：慢桩 harness（本地）+ 单测
（classifyDangerousCodeSegments 桩为 null）双层；载体字典 ≥19（A04/A05/A08/
A13、B02–B11 形态 + 引号切分/变量间接/字符拼接/Base64/hex/URL-encode/同形
异义字/零宽/软连字符/NBSP/嵌套）× 普通/verbatim × 判别器在线/不可用。
指标：leak=0、无残片、两态互斥、降级标记正确；benign ≥146 例误伤率。
