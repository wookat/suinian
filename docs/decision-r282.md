# R282 判定内核决策：从「命令字面枚举」到「能力识别 + 语义主判」

对应审查：`docs/audit-r281.md`（R281 独立审查，对 R280 复评 NO-GO）。
本文档只写**根因、选型论证、实现口径与验证方式**；每条结论标注「实测确证 /
未验证 / 推断」。

---

## 1. F-1 根因：字面枚举内核的结构性缺陷

R280 自称「行为语义判定」，实现（`backend/src/prompt-armor.ts`）的内核仍是四张
正则清单：`EXEC_PIPELINE_RE`（下载管道）、`EXEC_FETCH_RE`（取码工具名）、
`EXEC_SINK_RE`（管道落到解释器）、`NET_BACKCONNECT_RE`（`/dev/tcp`、`nc -e`、
`socat exec:`、`bash -i >&`、`mkfifo|sh`、字面 `reverse shell`）。

R281 实测的四条绕过（perl / php / python / powershell 原生 socket 反弹 shell）
的共同特征是：**没有任何一个被枚举的字面**——没有 `curl`/`wget`（不取远程码，
载荷就在内联脚本里）、没有管道 sink（解释器自己就是 sink）、没有 `/dev/tcp`
（用语言自带的 socket 原语建连）。因此 `hasExecIntent()` 直接返回 false，
整段原文原样返回，无警示无隔离。**（实测确证：audit-r281 §F-1）**

这不是「清单漏了几条」，而是判定域选错了：

- 枚举的是**工具名与写法**，攻击者可自由选择的正是工具名与写法。危险行为
  （建立出站连接、执行远程获取的代码、把 shell 交给对端）在每种解释器里都有
  等价原语，语言数 × 原语数 × 拼写变形是组合爆炸，枚举必然落后于新写法。
- 判定与**语义无关**：`nc -e /bin/sh` 命中而 `perl ... connect ... exec` 不命中，
  两者行为完全相同。任何以字面为主判的规则，都可以用「换一种等价写法」穿透，
  而这类改写成本极低（公开的 reverse shell cheatsheet 就是现成的改写字典）。
  **（推断，但被 R279→R280→R281 三轮实测反复印证：每轮补清单，下一轮换语言即穿透）**

结论：字面清单只能作为**兜底**（fail-closed 的最后一层），不能作为主判。

---

## 2. 新内核：能力识别（capability recognition）

判定对象从「这条命令长什么样」改为「这段代码/命令运行后**能做什么**」。识别
互相正交的能力位（`execCapabilities()`，`prompt-armor.ts`）：

| 能力位 | 含义 | 覆盖示例 |
|---|---|---|
| `net` | 主动建立出站连接的网络原语 | `socket()/AF_INET/SOCK_STREAM`、`socket.connect`、`fsockopen`、`stream_socket_client`、`IO::Socket`、`TCPSocket`、`System.Net.Sockets.TCPClient`、`net.connect`、`/dev/tcp/`、`/inet/tcp/`、`python -m http.client/socket/telnetlib` |
| `exec` | 命令/进程执行、动态求值 | `exec*`、`system`、`shell_exec`、`popen`、`os.system`、`subprocess.*`、`child_process`、`spawn`、`IO.popen`、`Process.Start`、`eval`、`IEX`/`Invoke-Expression`、`pty.spawn`、`os.execute` |
| `shellio` | 把进程 stdio 交给网络对端 | `dup2`、`open(STDIN,">&S")`、`>&N`、`GetStream()`、`StreamWriter/Reader`、`setsid` |
| `fetch` | 取远程内容 | `curl/wget/iwr/irm/tftp/scp`、`urllib/requests/http.client`、`Net::HTTP`、`LWP`、`file_get_contents(http…)`、`WebClient` |
| `inline` | 解释器内联脚本调用 | `perl/php/python/ruby/node/lua/pwsh/bash… -e/-c/-r/--command/-EncodedCommand`、`awk BEGIN{}` |
| `hostport` | 主机+端口共现 | `1.2.3.4 4444`、`host:4444`、`port 4444` |
| `lolbin` | 系统自带程序下载/执行载荷 | `certutil -urlcache`、`bitsadmin /transfer`、`mshta http…`、`rundll32 javascript:`、`regsvr32 /i:`、`wmic process call create`、`DownloadString/DownloadFile`、`Start-BitsTransfer` |
| `priv` | 赋权（配合执行） | `chmod +x`、`icacls` 等（沿用 `PRIV_CHANGE_RE`） |
| `sink` | 管道落到解释器/执行位 | 沿用 `EXEC_SINK_RE` |

判危险执行 = **能力组合**成立（`hasExecIntentReason()`，返回可解释理由）：

```
net ∧ exec            → cap:net+exec                （原生 socket 反弹 shell）
net ∧ shellio         → cap:net+shellio             （stdio 交给对端）
net ∧ inline          → cap:net+inline              （解释器内联建连）
lolbin                → cap:lolbin-remote-payload   （系统程序下载执行）
fetch ∧ sink          → cap:fetch+sink              （下载管道进解释器）
inline ∧ fetch ∧ exec → cap:inline+fetch+exec       （语言内取码再执行）
fetch ∧ priv          → cap:fetch+priv              （下载+赋权+执行）
—— 以上均不成立时，字面清单兜底：
NET_BACKCONNECT_RE / PRIV_THEN_EXEC_RE / EXEC_PIPELINE_RE → literal:*
```

为什么组合而非单能力：单能力会大面积误伤正常技术笔记（`requests.get()` 抓数据
是 `fetch`，`subprocess.run(["npm","build"])` 是 `exec`，都不危险）。危险性来自
**外连/远程取码与执行能力的耦合**，这正是组合条件表达的东西。
**（实测确证：仓库权威 benign 语料 54 条 × 逐行判定 false isolation = 0，见
`backend/test/r282-benign-corpus.test.ts`）**

---

## 3. 主判是 LLM 语义分类器，能力内核作 fail-closed 兜底

能力内核仍然是规则——它的鲁棒性比字面枚举高一个数量级（原语数远少于写法数，
且跨语言同名），但仍有「新语言/新原语未编入」的窗口。按产品既有架构原则
（LLM 主判 + 规则 fail-closed，见 `docs/decision-r268.md`/`decision-r272.md`），
本轮加入独立语义判别器：

- `answer-guard.ts: classifyDangerousCodeSegments()`：把答案按围栏感知句段编号
  后交给独立 LLM，判「这段代码运行后是否会 (a) 主动建立出站连接、(b) 下载/
  获取远程代码并执行、(c) 把 shell/进程 stdio 交给网络对端」，**只看能力，与
  语言/工具/拼写无关**；显式排除本地命令、普通 HTTP 取数据、以及对攻击的文字
  描述与防御建议（防 F-3 类误伤）。
- 抗注入：句段作为不可信数据传入，判别器输出只被解析为**句段序号**，不进入
  任何提示词；被说服的影响面仅限于多隔离/少隔离某段，不构成新执行通道。
- 触发门槛：`segmentExecSuspicious()` —— 只有含代码类能力原语、且**确定性内核
  未命中**的句段才送判别器。普通问答不额外增加一次模型调用。
- 失败语义：判别器超时/不可用/输出不可解析 → 返回 `null` → **不改变任何行为**，
  确定性能力内核仍然独立生效。即「判别器挂掉 = 退回规则」，不存在放行窗口。
  **（实测确证：`backend/test/r282-exec-classifier.test.ts` 覆盖命中/空/乱输出/
  null/越界序号，以及「内核命中而判别器未报告仍隔离」）**

---

## 4. 出口两态，无第三态

`isolateNoteInstructions()` 对危险执行段只有两种处置，判别器命中段与内核命中段
**同一口径**：

- 用户点名索要原文（verbatim）→ **完整原文** + `EXEC_PIPELINE_WARN_MARK`；
- 其余 → **整段**替换为 `EXEC_ISOLATED_MARK`。

禁止「删掉危险片段、留下残句」的第三态：残片既可能仍可运行，又让用户误判。
**（实测确证：`r282-fixes.test.ts` 对 19 条危险样本逐条断言两态且无残片）**

---

## 5. 其余各项的判定口径

### F-2/F-3（社工判定语言无关、否定式一致豁免）

`segmentIsSocialEngineering()` 的角色组合（CRED ∧ DISCLOSE ∧（受体 ∨ 口述 ∨
电话 ∨ 紧邻））与子句级否定作用域本身是语言无关的；R281 观察到的**反向失败**
（把「念出验证码」当有效指引正向复述）与 **FZEN 误隔离**发生在答案层的 LLM
审计口径上：`auditAnswerConduct()` 的 system 指令既没有把「把社工诱导当有效
指引正向转述」列为应报告项，也没有把「任何语言的否定式防骗忠告」明确列为豁免。
本轮把两者写进审计契约（语言无关表述，不枚举句式）。
**（实测确证：确定性层对英/中/日/韩/混合的正向社工样本一致隔离、否定式样本
一致豁免，见 `r282-fixes.test.ts`；答案层审计口径变更属提示词层，效果需生产
实测复核 —— 未验证部分见 §6）**

### F-4（无意义输入）

`isMeaninglessQuestion()` + `MEANINGLESS_QUESTION_ANSWER`，在 `/api/ask` 入口
拦截 `？？？`、`帮我` 等无实义输入，直接返回确定性引导文案，不进入生成，
因此不可能泄漏「资料区」等内部提示词结构词。

### F-5（枚举标题统一策略）

标题是 LLM 从正文生成的派生物，其字面无法确定性归一（INSTR-C 被另起为
「部署脚本」，INSTR-D/E 保留原指令标题，都是生成层的随机性）。因此归一放在
**出口**：`sanitizeEnumTitle()` 统一为「标题自身命中危险执行，或源正文含任何
可隔离内容（读者指令 / 危险执行）→ 同一隔离占位」。同一批指令笔记在枚举里
形态一致，与标题由谁生成无关。

### F-7（MCP `Server-Timing` 缺 `conaud`）

根因（**实测确证：代码路径**）：`StreamableHTTPTransport` 返回的响应体是流，
内部 `/api/ask` 在响应体流出**期间**才执行；原实现在拿到 `Response` 后立刻读
`lastServerTiming`，此刻工具尚未执行，故头里只有 `mcp;dur=0`。修复：把响应体
`tee()` 后整体缓冲（JSON-RPC 单次响应体量很小），缓冲完成即代表工具执行结束，
此时内部 `Server-Timing`（含 `conaud`）已就绪，再构造响应头；缓冲超预算则退回
流式透传（只带 `mcp;dur`），不因计时头影响可用性。

### F-8（生产间歇注册/注销 UI 超时窗）

R281 实测：后端 `DELETE /api/auth/me` 6/6 200、0.21–0.38s，而浏览器侧连续 4 次
~26–28s。注销路径在 R278 已做过同类修复（DELETE 预算 5s + cache-bust 探测），
本轮排查覆盖注册/登录路径：`authPost()` 单次预算 60s 且**无重试**，一旦命中
连接级悬挂（与 R221/R278 同型：换一条新连接即刻恢复）就表现为几十秒白等。
修复：注册/登录（服务端幂等，同名同密码重试命中已有账号）单次预算收紧到 15s，
超时立即换新连接重试一次，总预算不超过原 60s；`recover` 会消费一次性恢复码，
不自动重试。SW 侧已核查不参与 `/api/auth/*`（`runtimeCaching` 只匹配 GET 且
路径为 `notes|threads|reports` 且带 `sn_uid`，`navigateFallbackDenylist` 排除
`/api/`）。**（实测确证：SW 规则与前端超时链为代码实查；「连接级悬挂是唯一
残余成因」属推断——生产复现窗口具偶发性，本轮以生产复测数据标注）**

#### F-8 本轮补充：真实浏览器逐层取证（实测确证）

在生产 Web 上用 Playwright 驱动同一台机器上的真实 Chrome（非 headless、SW 正常
注册）逐层测量 `DELETE /api/auth/me`：

| 层 | 样本 | 结果 |
| --- | --- | --- |
| 页内裸 `fetch`（SW active） | 3 | 200，168 / 174 / 221 ms，随后 token 401 |
| 完整 UI 点击链路（设置页「永久注销」→ 跳转） | 1（修复前构建） | 200，189 ms；UI 1.06 s 内跳转 |
| 完整 UI 注册→存笔记→注销 Day-1 链路 | 1（修复前构建） | 注册 2.05 s、存笔记 228 ms、注销 1.06 s |
| 完整 UI 点击链路（修复后已部署构建） | 3 | 200，166 / 179 / 263 ms；UI 1.07 s 内跳转 |

即 **浏览器层、SW 层、CORS 预检、Pages 边缘均未复现 R281 的 26–28 s 窗口**；
同一路径实测均为百毫秒级。结合 R281 当时页面上同时出现的「网络连接失败」
（时间线 GET 也一起失败），证据指向**该次会话的浏览器/连接级瞬时悬挂**，而非
后端、CORS 或 SW 拦截规则。

由于成因是连接级偶发悬挂而非确定性缺陷，本轮采取的是**兜底加固而非"修好某行
bug"**：`deleteAccount()` 的幂等 DELETE 在 5 s 预算超时后**换新请求重试**（带
cache-bust 查询串，迫使独立请求、避开被队头阻塞的同连接），最多 3 次尝试且总
预算仍 ≤15 s。与 R278 的"探测换连接"相比，本轮把"换连接"用到了 DELETE 自身，
悬挂那一条连接不再决定整个注销的成败。

**未验证**：R281 那次 26–28 s 悬挂无法按需复现，因此"重试机制在真实悬挂窗口内
必然救回"只有机制论证与百毫秒级正常路径实测，没有悬挂态下的一手证据。

---

## 6. 证据分级

- **实测确证**：本地 backend 全量测试、typecheck、web lint/build、Android
  assembleDebug、以及本文档引用的各回归测试文件（判定层逐条断言）。
- **未验证 / 待生产复测**：答案层 LLM 审计口径变更（F-2/F-3）对生产真实模型的
  效果；F-8 偶发窗口是否随重试机制消失。
- **推断**：字面枚举必然被新写法穿透（三轮实测印证的归纳结论）；F-8 的边缘
  连接级悬挂成因。
