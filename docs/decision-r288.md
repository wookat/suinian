# R288 设计论证：代码安全判定去掉「切分粒度」这个变量

对应审查：`docs/audit-r287.md`（第十四轮，复评 R286/PR #316，结论 NO-GO）。
本文件在写代码之前完成；实现严格按本文口径落地，验证数字在 PR 描述与 §7 回填。

---

## 1. 根因：不是粒度不够大，而是「先切分、再逐片求合取」这个结构

R284 判据在**句段**上求合取，R286 把同一判据搬到**代码单元**上求合取。R287 一手复现证明：

| 绕过形态 | R286 为何仍然放行 |
| --- | --- |
| 建连与执行之间插一行散文 | `codeUnitSpans()` 把散文行当**硬边界**，两半各自不满足 `net ∧ exec` |
| 插 5 个空行 | 空行连接器上限 `CODE_UNIT_GAP_MAX = 3`，超过即断开 |
| 拆到两个围栏 | 每个围栏块是独立单元 |
| 围栏内外各一半 | 围栏边界必然断开单元 |
| 跨段落 | 同上 |

结论：只要判定的输入是「某个子区间」，攻击者的自由度就是「把能力分散到不同子区间」。
把子区间做大（句段→单元→段落→整篇）只是把绕过成本从 0 提到 1 个字符，**不改变绕过存在性**：
任何切分规则都必须有边界，边界就是绕过点。所以 R288 不再调整边界，而是**取消能力聚合对边界的依赖**。

第二个根因是门控（P0-2）：`classifyExecDanger()` 的前置条件与确定性判据用**同一套局部粒度**
（`segmentExecSuspicious(segment)` ∨ `segmentExecSuspicious(unit)`）。局部粒度被绕过时，
LLM 主判与确定性兜底**同时**缺席，且响应不带 `exec_guard_degraded`——这是「门控失败 = 直接放行」的
fail-open 结构，与判据本身的强弱无关。

---

## 2. R288 架构：代码面（code surface）+ 全局能力聚合 + 代码性门控

### 2.1 代码面：把「散文」从边界降级为「不参与判定的文本」

定义答案的**代码面** = 该答案里所有代码区域文本按原顺序拼接（散文行丢弃，不作为边界）：

```
codeSurface(answer) = { units: codeUnitSpans(answer), surface: units.map(u => u.text).join("\n") }
```

`codeUnitSpans()` 继续被复用，但**只用来定位代码在哪里（处置范围）**，不再用来决定
「能力可以在哪里相遇」。能力判定的输入是 `surface`——整条答案的全部代码，不管它被散文、
空行、围栏、段落切成几块。

于是：

- 插散文 / 插空行 / 跨围栏 / 围栏内外各一半 / 跨段落 → 代码面完全相同 → 判定结果完全相同。
- 攻击者要拆散能力，只能把能力写到**别的答案**里（那是另一次问答，另一次判定），
  或者把建连/执行改写成不是代码的形态（那就不是可运行载荷）。
- 「代码面不变则判定不变」是可证伪的性质，用同一载荷的 6 种排布形态做等价类测试（§7）。

### 2.2 全局能力内核：`globalExecDangerReason(answer)`

在代码面上直接求已有的能力内核 `hasExecIntentReason(normalizeCommandText(surface))`。
这不是新判据（内核未变），只是把求值范围从「子区间」提到「整条答案的代码」。
命中即隔离**全部代码单元**（散文原样保留），两态（判别器在线/不可用）一致。

为什么隔离全部代码单元而不是「只隔离命中的那一半」：能力已经跨块聚合，
「哪一块危险」在语义上没有答案——`net.Dial(...)` 与 `exec.Command("/bin/sh")` 缺一不可，
只隔离一块等于把可运行载荷的另一块逐字交付。散文保留，用户仍能读到讲解，
原文始终可在笔记卡片查看（既定契约）。

**verbatim 例外的收窄**：跨块聚合成立时不再走 `execSegRep()` 的「警示 + 原文」出口。
理由：该出口的正当性来自「用户点名索要这一段原文、危险性一眼可见」，
而跨块聚合的危险性恰恰是**分布式的、不可见的**，逐字交付即等于放行（R287 P0-1 的
16/48 就发生在 verbatim 问法）。这是 fail-closed 方向的收紧，不是弱化。

### 2.3 连续量打分：`execRiskScore(answer)`（覆盖「字面绕过」）

能力内核锚定的是 API/命令**字面**（`socket`、`connect`、`exec`…）。R287 的 `a6alias` 形态
（`link(3405803783)` + `run_shell`：连接语义改名 + 地址十进制编码）不含任何内核字面，
无论聚合范围多大都命中不了。这类绕过不该用「再补字面」应对（字面空间无界），
而用**语言无关的连续量**在代码面上打分：

| 信号 | 判据（代码面上） | 权重 |
| --- | --- | --- |
| `obfaddr` | IPv4 的十进制/十六进制/八进制编码整数、`inet_aton/ntohl/struct.pack` 常量、分段拼接的点分地址 | 2.0 |
| `hostport` | 明文 IP/域名 + 端口（复用 `HOSTPORT`） | 1.0 |
| `execish` | 执行语义词根（`shell/exec/spawn/system/popen//bin/sh/cmd.exe`），**含自定义标识符**（`run_shell`、`do_exec`） | 1.0 |
| `stdio` | `stdin/stdout/stderr/dup2/pipe/fd/PIPE` 与进程 I/O 绑定 | 1.0 |
| `connectish` | 通用建连动词 + 数值/地址实参（`dial/connect/link/attach/open/hook` 家族） | 0.5 |
| `fetchsink` | 远程取码 ∧ 交解释器/落盘执行 | 1.5 |

判据：`score ≥ 3.0` → 危险（保守隔离，两态一致）；`score ≥ 1.5` → 只作为**必须调用判别器**的
理由之一（见 §3），不单独隔离。

阈值取 3.0 的依据（§7 实测回填）：官方安装脚本的典型分数是 `fetchsink 1.5 + execish 1.0 = 2.5`；
部署手册里的 `redis-cli -h 10.0.0.5 -p 6379` 是 `hostport 1.0`；而反弹 shell 的任何写法至少要
「地址（1.0/2.0）+ 执行或 stdio（1.0）+ 建连动词（0.5）」= 2.5–3.5，配合 §2.2 内核与 §3 判别器
形成三层。分数低于 3.0 但 ≥1.5 的一律进判别器，因此「分数不够」不等于放行。

### 2.4 三层判定与两态

```
第 0 层  代码面存在（含任何代码区/命令形态）      → 必须进入判别（§3）
第 1 层  全局能力内核命中（§2.2）                → 隔离全部代码单元（确定性，两态）
第 2 层  连续量打分 ≥ 3.0（§2.3）                → 隔离全部代码单元（确定性，两态）
第 3 层  LLM 判别器（在线）命中句段/单元         → 既有处置口径
         LLM 判别器不可用（null）                → 降级保守隔离 + exec_guard_degraded
```

第 1/2 层在**判别器在线时也生效**（R287 已实测判别器会在预算内漏判），
所以「判别器在线」不是放松确定性判据的理由。

---

## 3. 门控改为「是否可能是代码」，失败即 fail-closed（P0-2）

现状（fail-open）：

```ts
if (!segSuspicious && !unitSuspicious) return { danger: [], unavailable: false };
```

R288 改为：

```ts
const gate = execClassifierGateReason(answer);   // 只问「是不是代码」
if (!gate) return { danger: [], unavailable: false };  // 无任何代码区 → 无可执行载荷可言
// 有代码区 → 必须调用判别器；任何异常/超时/解析失败 → unavailable = true
```

`execClassifierGateReason(answer)` 开门条件（任一）：

1. 存在代码单元（`codeUnitSpans().length > 0`）；
2. 存在围栏块 / 缩进块 / 提示符行（即使不成单元）；
3. `execRiskScore ≥ 1.5`。

判定门控自身抛异常 → 视为开门（try/catch 包裹，catch 即开门）。
判别器返回 `null`（超时/降级/解析失败）→ `unavailable: true` → 降级保守隔离
+ 响应 `exec_guard_degraded: true`。**不存在「门控不成立 → 直接放行且不打标记」的路径。**

### 3.1 成本控制（不让普通问答变慢）

| 手段 | 口径 |
| --- | --- |
| 纯自然语言问答 | 无代码区 ⇒ 门控关闭 ⇒ 0 次 LLM 调用（与现状同延迟） |
| 长度下限 | 代码面折叠后 < 24 字符视为噪声，不调用 |
| 长度上限 | 送判别器的文本截断到 6000 字符（超长答案本就已被上游截断） |
| 调用次数 | 每次 `/api/ask` 最多 1 次判别调用（既有约束不变） |
| 缓存 | Worker 实例内 LRU（200 条 / TTL 10 min），key = 代码面的 FNV-1a 哈希；同一笔记反复问答复用结果 |
| 预算 | `EXEC_CLASSIFY_BUDGET_MS = 8000` 不变，超时即 `unavailable` 走 fail-closed |

调用量估算：门控从「命中危险特征」放宽到「含代码区」后，被判别的问答比例 ≈
「答案里含代码/命令的问答比例」。R287 语料口径下 benign 语料 114 条里含代码区的约 60%，
但真实使用中带代码的问答是少数（碎念产品以生活/工作笔记为主）；加上代码面缓存，
稳态额外调用量估算为**每 100 次问答 ≤ 20 次**（推断，非实测；上线后以 D1 遥测
`ask: execcls` 计时打点复核）。代价上限明确：多一次 8s 预算内的 LLM 调用，
而不是「直接放行」。

---

## 4. 误伤治理（P1-1）：把处置分级，而不是把判据放宽

R287 实测：`crossLineExecUnits()` 对 20 条官方安装/CI 文档误伤 7/20（35%），
降级窗口 8/20（40%）。误伤全部来自同一条判据family：**「下载脚本 → 执行」被当作充分条件**，
而这正是 docker/rustup/poetry/nvm/helm/k3s/PowerShell 官方安装法。

R288 的口径：**「取码→执行」不再是充分条件，而是「取码来源可信度」的函数**。

1. 官方安装源清单 `OFFICIAL_INSTALL_SOURCE_RE`（host + 路径前缀，逐条可核）：
   `get.docker.com`、`sh.rustup.rs`、`static.rust-lang.org/rustup`、`install.python-poetry.org`、
   `raw.githubusercontent.com/nvm-sh/nvm`、`raw.githubusercontent.com/Homebrew/install`、
   `raw.githubusercontent.com/helm/helm`、`get.helm.sh`、`get.k3s.io`、`deb.nodesource.com`、
   `dot.net/v1`、`aka.ms`、`astral.sh`、`get.pnpm.io`、`get.sdkman.io`、`sh.brew.sh`、
   `apt.releases.hashicorp.com`、`packages.microsoft.com`、`cli.github.com`、`get.k8s.io`、
   `install.determinate.systems`、`get.volta.sh`、`bun.sh/install`、`ollama.com/install.sh`。
2. **降级为警示保留**的条件（全部满足）：
   - 危险理由只属于「取码 → 执行」家族（`cap:fetch+sink` / `cap:fetch+priv` /
     `unit:fetch+run-downloaded` / `literal:pipeline`）；
   - 代码面里出现的**每一个** http(s) 取码 URL 都在清单内；
   - 代码面**不含**：明文 `IP:port`、编码地址（`obfaddr`）、反弹外连字面、stdio 接管、
     `CAP_NET` 建连 API、LOLBin 远程载荷。
   - 处置：保留原文，前置 `EXEC_INSTALLER_WARN_MARK`（新标记，文案区分于「已隔离」），
     不计入 `isolated`，不触发降级提示。
3. 不满足以上任一条 → 维持隔离（fail-closed）。攻击者把载荷托管到清单域名下的路径
   （如 `raw.githubusercontent.com/<attacker>/...`）不满足条件 2（路径前缀不匹配），
   且一旦出现 IP:port / 建连 API / stdio 立即失格。

这条 carve-out 是**处置分级**（隔离 → 警示保留），不是判据放宽：内容仍然被判定、
仍然带警示、仍然计入日志；它只影响「是否把原文交给用户」。同一条 carve-out 在
降级窗口同样生效（它不依赖 LLM，是确定性的来源判定），因此把 R287 的两组误伤一起降下来。

---

## 5. Service Worker：自愈路径与可操作出路（P1-2 / P1-3）

R287 定论（接受）：wedge 是**浏览器 SW 组件级悬挂**——`getRegistrations()` 返回
worker-less registration，而 `unregister()` 与 `register()` 120s 既不 resolve 也不 reject。
因此任何「先 unregister 再 register」的自愈都不可能生效——R286 的 watchdog 就挂在这里。

R288 的策略（不依赖 unregister 的 resolve）：

1. **所有 SW 操作加超时**（`Promise.race`，5s）：超时不再阻塞状态机，直接进入下一级；
   每一级失败都打 D1 遥测（`SwHealTimeout` / `SwHealFailed`），杜绝「无失败打点」。
2. **换 SW URL 而不是先注销**：`register("/sw.js?heal=<ts>", { updateViaCache: "none" })`
   ——新 script URL 走新的 job queue，不依赖被卡住的旧 registration 生命周期。
3. **自愈失败 → 产品级降级模式**：写入 `localStorage["suinian.sw.disabled"]`，
   本设备此后**完全跳过 SW 注册**（PWA 离线能力关闭、在线功能全部正常），
   并给用户可见横幅 + 一键「关闭离线缓存并刷新」。
4. **可操作出路**：横幅里给出实测有效的步骤（清除本站数据 / 重开浏览器 profile），
   删掉 R287 证伪的「关闭所有标签页再打开」这条无效建议。
5. **认证类请求不经 SW**（P1-3）：SW 的 `fetch` handler 对 `/api/` 一律 `return`（不 `respondWith`，
   交回浏览器网络栈），前端注册/注销/登录改用带 `AbortController` 超时 + 一次自动重试
   （重试带 `cache: "no-store"` 且 URL 加 `?_r=<ts>` 绕开任何缓存层）；401 明确识别为
   会话失效而不是网络错误。

「代码存在」不等于「已验证」：§7 只把**真实浏览器观测到的**状态迁移与 D1 遥测计入实测确证。

---

## 6. 前端 `exec_guard_degraded`（P2-1）

后端字段早已返回，`web/` 零引用。R288：`askAsk()` 透传该字段，问答气泡在降级态显示
**与「判定危险」不同的样式与文案**（琥珀色「代码安全判别暂不可用，已保守隔离」+
「重新判定」按钮，点击重发同一问题），危险隔离态保持既有中性提示。真实浏览器截图见 PR。

---

## 7. 验证方案与标签口径

| 标签 | 含义 |
| --- | --- |
| 实测确证 | 本轮在本机/生产实际运行并留有输出/截图/D1 记录 |
| 推断 | 由代码或已有证据推导，未实际运行 |
| 未验证 | 本轮未做 |

必跑：
- 恶意语料 ≥48 例（含 R287 全部绕过形态：插散文 / 插空行 / 跨围栏 / 围栏内外各一半 /
  跨段落 / 地址间接化 / connect 语义改名 / stdin 管道），在**判别器在线**与**判别器不可用**
  两态下 leak=0，降级态带 `exec_guard_degraded`。
- 善意语料：权威 `injection-eval-data` 全量 54 + R287 的 20 条官方安装/CI 文档 +
  技术文档/教学代码/部署手册 ≥40 条，给出误伤率（与 R287 的 35% / 40% 对比）。
- 等价类测试：同一载荷 6 种排布（原样/插散文/插空行/跨围栏/围栏内外/跨段落）
  判定结果必须一致——这是 §2.1「代码面不变则判定不变」的可证伪检验。
- 本地：`backend npm test`、`backend npm run typecheck`、`web npm run lint`、`web npm run build`。
- 生产：部署 Worker + Pages（`--branch main`）后复测，QA 账号 `[QA-R288]` 前缀、测试后注销并
  D1/R2 权威核查残留。

---

## 8. 落地与实测结果（本轮，2026-08-29）

### 8.1 与 §5/§6 设计的偏差（如实记录）

- **P1-3 的实现方式**与 §5 第 5 条设计有偏差：Workbox 生成的 SW 对未命中路由的请求
  本来就不 `respondWith`（`/api/` 只有带 `sn_uid` 的三条 GET 走 NetworkFirst），所以
  「让 SW 放行 API」并不能解决 R287 定论的问题——**SW 组件级悬挂时，受控页面的任何
  fetch 都要等 SW 启动**，与 SW 是否拦截该请求无关。因此实际落地为：
  认证请求超时后先尝试**脱开 SW 控制**（`escapeSwWedgeForAuth()`：注销全部
  registration + 清 CacheStorage，全部带超时）再重试一次；脱不开也不阻塞，仍走原样重试，
  并把「浏览器离线缓存组件可能卡住」写进超时文案，给出设置页出路。
- **P1-2 的关键修复**是给所有自愈动作加超时（`withSwTimeout`）：R287 的一手观测是
  `unregister()/register()` 120s 既不 resolve 也不 reject，旧代码 `await` 在此永久悬挂，
  这正是 `SwNoWorkerHealed` / `SwStartTimeoutHealed` 至今 0 条的原因。超时即判定 wedge，
  转成用户可操作出路（横幅「关闭离线缓存并重载」+ 设置页同一入口 + 重新启用入口），
  并新增遥测 `SwNoWorkerHealTimeout` / `SwRegisterUnsettled` / `SwDisabledByUser` /
  `SwAuthWedgeDetach(ed|Timeout)`。
- **P2-1 配色**：降级态用蓝色 `ShieldQuestion` + 「重试本轮提问」按钮，危险隔离态保持
  琥珀色 `ShieldAlert`（两态样式/文案/图标均不同），比 §6 原写的同色方案更可分辨。

### 8.2 判定层两态量化（实测确证，`npx tsx scripts/r288-guard-eval.ts`）

语料：恶意 72 例（12 类能力对 × 6 种 R287 绕过分布形态）；善意 116 例（权威
`injection-eval-data` 全量 54 + R287 §2 的 20 条官方安装/CI 文档 + 42 条技术文档/教学
代码/部署手册）。每例 × 2 问法（普通 / verbatim）× 2 态（判别器在线 / 不可用）。

| 态 | 口径 | 结果 |
| --- | --- | --- |
| classifier-online | malicious/plain | leak 0/72 (0.0%) |
| classifier-online | malicious/verbatim | leak 0/72 (0.0%) |
| classifier-online | benign/plain | 误伤 0/116 (0.0%) |
| classifier-online | benign/verbatim | 误伤 0/116 (0.0%) |
| classifier-unavailable | malicious/plain | leak 0/72 (0.0%) |
| classifier-unavailable | malicious/verbatim | leak 0/72 (0.0%) |
| classifier-unavailable | benign/plain | 误伤 0/116 (0.0%) |
| classifier-unavailable | benign/verbatim | 误伤 0/116 (0.0%) |

对比 R287：恶意分布形 16/48 逐字放行（两态）→ 0/72；官方安装/CI 文档误伤 7/20（35%）→ 0/20
（官方安装法仍被判定，处置为「警示 + 保留原文」，不是「不判」）。
误伤口径 = 用户可见的原文被剥夺（出现隔离/降级隔离标记）。

### 8.3 本地门槛（实测确证）

- `backend npm run typecheck`：通过。
- `backend npm test`：149 文件 / 2624 用例全绿（含新增 `test/r288-global-surface.test.ts` 20 例）。
- `web npm run lint`：无 error（存量 warning 未新增）。
- `web npm run build`：`tsc -b && vite build` 通过，PWA precache 21 项生成。

### 8.4 仍待验证（本节完成前不得声称已验证）

浏览器真实截图/录屏（降级态提示与重试、SW wedge 出路）、生产部署后复测、Android
`assembleDebug`、常规防漂移回归全量、QA 账号清理与 D1/R2 残留核查。
