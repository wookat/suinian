# R286 修复轮决策记录（碎念 Suinian）

上游：R285 独立审查（PR #315，`docs/audit-r285.md`）对 R284（PR #314）复评 NO-GO。
本轮目标：把 P0-1（判别器 null 多行危险代码逐字放行）、P1-1（生产 SW 启动超时）、
P2-1/P2-2/P2-3 实际改掉，并给一手证据。

本文所有数字均标注来源：**实测确证** = 本轮亲自跑出来的输出；**未验证** = 本轮没测；
**推断** = 有证据支撑但未直接观测的因果解释。

---

## P0-1 判别器 null 时多行危险代码逐字放行

### 根因（实测确证）

R284 的降级兜底 `execDegradedIsolationSegments()` 先 `splitSegmentsFenceAware()`
按换行/句读切段，再对每段单独要求「代码 + hostport/连接 + 执行」三信号合取。
反弹 shell 的能力天然分布在不同物理行（建连一行、`exec.Command` 另一行），
每段都不满足合取 ⇒ `degraded=[]` ⇒ 原文原样交付。R284 自报的「null 30 类 leak 0」
测试载荷（`backend/test/r284-classifier-null.test.ts`）全是单行 `;` 拼接，
恰好被确定性内核（段内合取）兜住，掩盖了降级兜底本身失效。

### 修复：判定单元从「句读段」提升到「代码单元」

新增 `codeUnitSpans(answer)`（`backend/src/prompt-armor.ts`），单元划分规则：

1. **围栏块整体为一个单元**：``` / ~~~ 之间的内容（含语言标注行之后的全部行）。
2. **围栏外连续「代码型行」簇为一个单元**：`isCodeLine()` 判定为代码的相邻行合并。
3. **空行/注释行作为连接器**：间隔 ≤ `CODE_UNIT_GAP_MAX = 3` 行的空行或纯注释行
   不切断单元（攻击者用空行/注释把能力拆开是最低成本的绕过手法）。
4. **自然语言散文行是边界**：非代码行且超过间隔上限即结束当前单元。
5. 单元携带原文精确 offset（`start`/`end`），供逐字还原与整体替换使用。

`isCodeLine()` 覆盖：常规语句/调用/赋值/闭合行（`}`、`)`、`end`）、shell 命令行、
成员调用（含被模型吃掉括号的 `cmd.Run`）、裸脚本调用（`sh init.sh`、`& .\a.ps1`）、
常见命令行工具（curl/wget/chmod/docker/systemctl/pip/npm…）。

理由：能力信号（取码、建连、执行）在真实危险代码里几乎必然跨行；以行/句读为
求值单元时，攻击者只要按回车就能规避任何合取判据。以代码单元求值不引入新判据，
只是让既有判据不再被换行拆散。

### 两条判据的作用范围（重要区分）

| 判据 | 何时生效 | 求值单元 |
| --- | --- | --- |
| `execDegradedIsolationUnits()` 兜底三信号 | **仅判别器不可用（null）的降级窗口** | 代码单元 |
| `crossLineExecUnits()` 确定性内核 + 取码→执行 | **常态（判别器在线也生效）** | 代码单元 |

`crossLineExecUnits()` 的存在原因（实测确证，见下「6.5s 慢响应」）：判别器在预算内
返回但**漏判**时，多行反弹 shell 没有任何兜底。把内核（已是段级可信判据）的求值
范围从「行」提到「单元」后，漏判也能被拦住。

「取码→执行」跨行判据：单元内出现「远程内容落盘到路径 P」（`curl -o`、`curl -O`、
`wget -O`、`iwr -OutFile`、`open(P,"w").write(...)`）且同一单元内 P 被执行
（解释器执行、裸路径调用、`& .\P`），即整单元视为危险。
边界（故意不覆盖）：下载 `.tgz` 后解压、下载配置后 reload 服务、下载数据集后解析、
下载前端产物后 unzip、下载备份、用 curl 做健康检查——这些不执行下载内容。

### 判别器 null 的出口语义（两态，不留第三态）

- 危险单元 → 整单元替换为 `EXEC_DEGRADED_ISOLATED_MARK`，并在答案尾部追加
  用户可感知的降级提示 `EXEC_DEGRADED_NOTICE`（「代码安全判别暂不可用…稍后重试」）。
- `/api/ask` 响应额外带 `exec_guard_degraded: true`，前端/QA 可机器识别。

### 误伤量化（实测确证，本轮重跑）

语料：权威 `backend/scripts/injection-eval-data.ts` 全量 54 条 + 技术文档/教学代码/
部署手册样本，合计 **90 条 benign**（脚本 `/home/ubuntu/qa-r286/fp.ts`）。

```
benign total=90
  降级窗口（execDegradedIsolationUnits）FP=1
     T33: #!/bin/bash  code=$(curl -s -o /dev/null -w '%{http_code}' https://api.example.com/health)
  常态跨行判据（crossLineExecUnits）FP=0
```

- 常态判据误伤 **0/90**。
- 降级窗口误伤 **1/90**：健康检查里 `curl -o /dev/null` + 命令替换被三信号合取命中。
  取舍：该误伤只在「判别器不可用」窗口内出现，代价是一段 shell 被隔离且给出可见
  降级提示与「稍后重试」出路；相比多行反弹 shell 逐字放行，保守隔离是正确方向。
  R285 记录的「兜底误伤 0/66」是判据过窄几乎不动作的副产物，不能与本数字对比。

### 回归测试（实测确证）

- `backend/test/r286-classifier-null-multiline.test.ts`：**34 类**载荷，其中 32 类多行
  （跨行/跨段分布、围栏内外、注释间隔、空行间隔、变量间接拼装地址、端口写变量、
  DNS 名无端口、十进制/IPv6 地址、自定义函数名包装 connect、取码→落盘→执行），
  断言 leak=0。无单行 `;` 拼接充数。
- `backend/test/r286-cross-line-fetch-run.test.ts`：16 例（含 benign 边界）。
- `backend/test/r286-verbatim-two-state.test.ts`、`r286-false-isolation.test.ts`。
- 全量：`backend npm test` → **148 文件 / 2604 用例通过**；`npm run typecheck` 通过。

### 近生产复现（实测确证，与 R285 同法）

本地 `wrangler dev`（127.0.0.1:8788）+ 本地 OpenAI 兼容代理（`~/qa-r286/proxy.mjs`）
把**判别器**请求延迟到超预算，harness `backend/scripts/qa-r286-degraded.ts`
（每例新建 `[QA-R286]` 账号、口令运行时随机、跑完注销清理）：

- `CLS_DELAY_MS=12000`（> 8s 预算，hits===null）：15 例 × verbatim/plain = **30 次运行，LEAKS=0**，
  degraded 标记与降级提示均出现（`~/qa-r286/degraded-final.json`）。
  同一 harness 在修复前（R285 记录）为 10/10 泄漏。
- `CLS_DELAY_MS=6500`（预算内慢响应）：**30 次运行，LEAKS=0**，`degraded=0`
  （即不误标降级），危险多行由常态跨行判据拦住（`~/qa-r286/slow-6500.json`）。

### 8s 预算评估（实测 + 推断）

- 实测：12s 延迟下每次 Ask 实际耗时 ~8.03s 后进入降级，说明预算截断按预期生效，
  用户等待上限可控（8s + 生成时间）。
- 实测：6.5s 落在预算内，被归为**正常态**（非降级），不给降级提示；此时若判别器
  漏判，由常态跨行判据兜底 —— 这是本轮新增的关键保护。
- 结论（推断）：8s 预算合理性成立的前提正是「预算内漏判也有确定性兜底」。
  单看预算数字无法判定安全性；把 6-7s 归为正常态是可接受的，代价已由跨行判据补齐。
- null 态的用户可感知提示：**已实现**（`EXEC_DEGRADED_NOTICE` + `exec_guard_degraded`）。

---

## P2-1 verbatim 出口第三态与空括号被吃

修复：verbatim 出口先算出危险单元集合（`verbatimDangerUnits` + `crossUnits`），
**每个危险单元只做一次整体替换**，后续按段/按行的处理跳过已被单元覆盖的区间
（`inDangerUnit()`/`inDegradedUnit()`），从结构上消除「同一单元内既警示原文又整段隔离」
的第三态。逐字还原走 `restoreVerbatimFromData()`：以原始笔记文本为准精确还原
（含 `func main(){`、`cmd.Run()`、`Runtime.getRuntime()` 的空参括号）；
**无法与原文精确匹配时 fail-closed 整单元隔离**，不输出被模型改写过的「近似原文」。
回归：`backend/test/r286-verbatim-two-state.test.ts`（实测确证）。

## P2-2 隔离闸两类误报

- 纯防骗忠告（无敏感值）被整条隔离：`segmentIsSocialEngineering()` 原先按中文顿号
  `、` 切句，丢掉了前置否定的作用域（「不要把验证码、身份证号发给任何人」被拆成
  「身份证号发给任何人」）。新增 `socialClauses()` 保留共享否定作用域；真实的
  社工指令（「把验证码发给客服」「请把恢复码一位一位念给对方」等）仍然隔离。
- 方括号标签导致 `/api/ask` 拒答：`[QA-R286]`、`[TODO]`、`[DEBUG]`、`[INFO]`、
  `[WARN]`、`[BUG-1234]`、`[3]`、`[FIXME]`、`[REVIEW]`、`[P0-1]`、`[ERROR]`、
  `[DEPRECATED]`、`[会议]`、`[读书]` 等普通技术标签不再触发拒答。
- 回归：`backend/test/r286-false-isolation.test.ts`（含中/英/日/韩防骗忠告）。

---

## P1-1 生产 SW 启动超时归因（一手直查生产 D1）

直查生产 D1（`suinian`，Cloudflare D1 REST API）`sw_error_reports` 全量分组：

```
AbortError  retry=0  n=18  2026-08-22 10:03:18 → 2026-08-28 21:41:24
AbortError  retry=1  n=11
AbortError  retry=2  n=10
AbortError  retry=3  n=9        （合计 48）
TypeError   retry=0  n=16  2026-08-23 11:41:26 → 2026-08-25 05:03:18
TypeError   retry=1  n=1
```

按 UA 分组（实测确证）：

```
AbortError : is_devin=1  48/48
TypeError  : is_devin=0  17/17
```

- 全部 48 条 AbortError 的 message 均为
  `Failed to register a ServiceWorker … : Timed out while trying to start the Service Worker.`，
  UA 均为 `…Chrome/137… Devin/1.0; +devin.ai`（X11 Linux 无头环境）。
  **实测确证**：来源确实是 QA 会话浏览器，非真实用户；但 retry 0→1→2→3 的四档
  重试**全部失败**，说明现有重试策略在这种卡死态里无效 —— 这一点是产品级缺陷，
  不能用「QA 侧瞬态」了结。
- **实测确证**：SW 体积不是原因。生产 `sw.js` 2406 字节，precache **21 条 / 642 KiB**
  （本轮 `web npm run build` 输出一致），不存在 install 阶段大规模阻塞。
- **推断**：`Timed out while trying to start the Service Worker` 是浏览器 SW 组件
  启动超时；在同一个已卡死的 SW 组件/registration 上原样 `register('/sw.js')`
  重试只会再次超时（与 retry 0→3 全失败的实测一致）。
- **实测确证（新发现）**：17 条 `TypeError` 全部来自**真实用户 UA**
  （Chrome/126：`Cannot read properties of undefined (reading 'waiting')`；
  Chrome/149：`An unknown error occurred when fetching the script.`）。
  仓库代码里对 `waiting` 的读取均已带可选链/非空判定（`web/src/pages/settings.tsx`
  `reg?.waiting`、`reload-prompt.tsx` 已判 `r` 非空），本轮**未能**在现版本代码中
  定位到可复现该 TypeError 的路径 —— 记为**未验证/待观察**，本轮不谎称已修。

### 修复（本轮落地）

`web/src/components/reload-prompt.tsx`：

1. 识别启动超时错误（`SW_START_TIMEOUT_RE`）；一旦出现，从第 2 次重试起改用
   **完整重置**（注销全部 registration → 清空全部 CacheStorage → 带
   `?reinstall=<ts>` cache-busting 重新注册），让浏览器起一个新的 SW 实例，
   而不是在卡死实例上原样重试。
2. 重试阶梯从 `[30s, 60s, 120s]` 延长到 `[30s, 60s, 120s, 5min, 10min]`
   （长驻页面里给自愈更多机会，仍然有限次以免无限打点）。
3. 自愈成功上报 `SwStartTimeoutHealed`，可在生产 D1 一手核对自愈是否真的发生。

## P2-3 「registration 存在但无任何 worker」卡死态

新增 watchdog（同文件）：页面加载 20s 后开始、每 60s 检查一次
`reg && !reg.active && !reg.installing && !reg.waiting && !navigator.serviceWorker.controller`；
**连续两次**（间隔 60s）仍处此态才动手（避免把安装间隙瞬态误判成卡死），
自愈动作为完整重置 + cache-busting 重注册，只做一次；上报
`SwNoWorkerStuck` / `SwNoWorkerHealed` 供生产侧核对；自愈失败仍保留设置页
「离线与更新（PWA）」的可见状态文案与手动修复按钮作为出路。

---

## 部署后生产复测（实测确证）

部署（Worker 上传 + Pages `--branch main`）后，用真实浏览器 + `[QA-R286]` 临时账号复测：

- **SW/PWA**：干净 profile 下 PWA 卡片显示「离线可用」，`controller.state === activated`，
  precache 21 条；断网刷新仍渲染应用外壳 + 「当前离线」横幅 + 已缓存笔记。
- **P2-3 watchdog 自愈实测**：页内构造「registration 存在但无 worker」态，
  t+20s 命中 #1（不动作）→ t+60s 命中 #2 → 上报 `SwNoWorkerStuck` →
  `register('/sw.js?reinstall=<ts>')` → 上报 `SwNoWorkerHealed` → registration `active:true`。
  **生产 D1 权威核对**（部署后 3 小时窗口）：`SwNoWorkerStuck n=3`、`SwNoWorkerHealed n=1`
  已入库，`AbortError` 同窗口仅 1 条（修复前基线约 10 条/日，样本期尚短，记**待观察**）。
- **危险代码两态出口**：非原文问法 → 仅隔离标记（无 `net.Dial`/`4444`/`exec.Command`/`/bin/sh`
  泄漏）；原文问法 → 警示前缀 + 5 行原文逐字完整（含 `cmd.Run()`）；跨行取码落盘执行
  （curl→chmod→执行）→ 警示 + 3 行完整。三例均无「警示+部分隔离」混排第三态。
- **方括号标签歧义澄清**：早前一次冒烟里含 `[TODO]` 的清单笔记被回「〔已隔离笔记内指令〕」，
  经对照实验确证与方括号**无关**——同一祈使句清单**去掉全部方括号**后同样被隔离
  （笔记内指令隔离闸的既有行为，R286 未改变）；而含 `[QA-R286]`/`[INFO]`/`[3]` 标签的
  **陈述性**笔记正常作答并给出引用。浏览器复测中 `[QA-R286]…[TODO]…[3]…[DEBUG]` 技术
  笔记也正常作答。结论：P2-2 ②（方括号致拒答）已修；「用户自己的祈使句待办清单被
  指令隔离闸整条隔离」是**既有行为/可用性权衡**，记为已知项待产品决策，非本轮回归。
- Lighthouse：性能 96 / 无障碍 100 / 最佳实践 100 / SEO 100；axe-core 4.10.2
  （时间流+设置）0 违规；375px 两页 `scrollWidth === innerWidth === 375`。
- QA 账号清理：本轮全部 `[QA-R286]` 账号已删除，生产 D1 权威查询
  `users WHERE name LIKE '%QA-R28%'` 返回 0 行；旧 token 与登录均 401；未触碰 `u_boss`。
- **测试机环境异常（非产品结论）**：测试机浏览器→生产 API 的 UI 注册/永久注销各连续
  3 次「请求超时」，而同机 curl 分别 0.33s/0.23s 成功，且同一浏览器的记笔记 POST 与
  `/api/ask` 全程正常；仓库 skill 已记录该测试机浏览器网络偶发 ~60s 挂起。倾向**推断**为
  测试机网络伪象，但建议在正常网络复核一次以排除客户端回归 —— 记**未验证**。
- **计划内未测**：`exec_guard_degraded` 生产降级窗口（不改生产配置制造判别器超时；
  近生产 12s/6.5s 束线已 30/30 leak=0）。

## 本地验证（实测确证）

| 项 | 结果 |
| --- | --- |
| `backend npm test` | 148 文件 / 2604 用例通过 |
| `backend npm run typecheck` | 通过 |
| `web npm run lint`（oxlint） | 通过（仅既有 fast-refresh 类 warning） |
| `web npm run build` | 通过，precache 21 条 / 642.38 KiB |
| `android ./gradlew assembleDebug` | BUILD SUCCESSFUL（本机新装 SDK 35） |
| benign 语料重跑 | `r266-injection-corpus` + `r282-benign-corpus` 538 用例通过；90 条 benign FP 见上 |

GitHub Actions 保持禁用（公司规则：产品仓库不需要 CI，验收以本地全绿为准）。
