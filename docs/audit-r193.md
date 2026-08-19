# 碎念 R193 独立审查报告（周期性复审轮）

- 审查日期：2026-08-19（UTC）
- 审查对象：生产环境 Web https://suinian.zalize.com 、API https://suinian-api.zalize.com （worker `suinian-api`、Pages `suinian`）
- 代码基线：`main` @ `7afed23`（含 R191 报告 PR #214）
- 角色：审改分离的「审」方，**只审不改**：本 PR 只新增本报告，未改任何产品代码、未部署、未改生产配置，GitHub Actions 保持禁用
- 与 R192 修改轮的边界：R192 在修「空格分隔台账逃逸 / 聚类评估校准 / 3 个无障碍 P2」，本轮**刻意不复测这三项**；§6 抽测中的台账问题为**另一条逃逸路径（负数行）**，根因与 R192 的分隔符解析不同，见 P1-1
- QA 口径：全部使用新注册的 `[QA-R193]-*` 账号（8 个），**未触碰 `u_boss`**；测毕逐表自清并注销，见附录 B。报告不含任何 token/密钥/口令原值

---

## 0. 结论（GO / NO-GO）

**GO（有条件）**。安全侧本轮**零 P0**：跨账号越权（笔记/附件/线索/报告/批量操作/问答）全线守住，token 轮换与恢复码找回的旧凭据全部失效，敏感附件无未授权直链，默认备份对敏感明文与敏感原件闭包成立，账号注销后逐表零残留（D1 实查）。微信三通道**探针如实**：未配置的公众号/企微如实 404、bridge 如实报 `waiting_scan` + HTTP 503，无伪装在线。

条件（建议 R194 收口）：
1. **P1-1**：含退款/负数行的台账笔记逃过「多行台账合计」判定，序数问答以**肯定语气**把合计 ¥454 报成「第 2 大的一笔支出」（真值 ¥155）——直接伤害「可靠找回」承诺，且 R192 正在修的分隔符路径**不覆盖**该根因。
2. **P2-1**：备份 zip 导出了 `threads.json` / `reports.json`，但恢复流程**静默不导入**，「无损搬家」实际有损。
3. **P2-5**：`POST /api/bridge/heartbeat` 只要任意合法用户 token 即可写入**全局** bridge 状态，可把真实故障伪装成 `online` 骗过 `/health?probe=bridge` 与外部监控。

---

## 1. 方法与口径（先说清「验证过什么 / 没验证过什么」）

证据分级贯穿全文：

| 标签 | 含义 |
| --- | --- |
| 【生产实测】 | 对生产 API/Web 真实调用或真实浏览器操作，响应原文留档 |
| 【本地测试】 | 在审查机上跑仓库代码/单测得到的确定性结论 |
| 【源码检查】 | 只读代码得出的结论，未在生产触发 |
| 【模拟】 | 用构造条件近似真实场景（如 DevTools 断网模拟弱网） |
| 【未验证】 | 本轮未验证，如实声明，不做「通过」推断 |

- 生产写操作仅发生在 `[QA-R193]-*` 自有数据上；对生产共享状态（如 bridge 心跳行）**只做不改状态的边界验证**，见 §5。
- 证据文件留在审查机 `/home/ubuntu/qa-r193/`（含 QA 凭据，故不入仓库），清单见附录 A。
- PWA 部分由测试子代理在真实 Chrome 中执行并录屏，录屏与截图路径见 §4。

---

## 2. §1 安全渗透周期复审

账号：`[QA-R193]-pen`（受害者，含敏感笔记 + 敏感附件 + 周报 + 线索）、`[QA-R193]-pen2`（攻击者）。

### 2.1 跨账号越权 ✅【生产实测】

`pen-authz.json`：11 类攻击面全部守住，且**零受害者数据泄漏**。

| 攻击面 | 结果 |
| --- | --- |
| `GET /api/notes/{他人 id}` ×4 | 404 `not found` |
| `PATCH` / `DELETE` 他人笔记 | 404 |
| `GET /api/notes/{他人 id}/file`（附件原件） | 404 |
| 自有笔记 id + 他人 attachment id | 404 `no attachment` |
| `POST /api/notes/restore` / `purge` 他人 id | 200 但 `restored:0` / `purged:0`（零行受影响） |
| `POST /api/notes/batch`（`delete`/`add_tags`/`set_category`） | 200 但受影响 0 行；受害者侧复查内容/标签/分类未变 |
| `GET /api/threads/{他人线索}` | 404 |
| `GET /api/reports`（攻击者视角） | 只见自身（空） |
| `POST /api/ask` 追问受害者敏感内容 | 无任一受害者字段出现在响应中 |

口径修正（如实记录审查自身的失误）：首轮批量测试误用了不存在的 `action: tag_add`，生产正确返回 400 `invalid action`；改用合法动作（`delete`/`add_tags`/`remove_tags`/`set_category`/`restore_categories`）重测才得到上表结论。首轮问答测试误用 `q` 字段，生产返回 400 `question required`，改用 `question` 重测。

### 2.2 限流 ✅【生产实测】

`pen-ratelimit.json`：

- 登录暴破：错误密码连打 8 次 → `401,401,401,401,401,429,429,429`，**第 6 次起 429**（与 `RATE_LIMIT_MAX = 5` 一致【源码检查】）；限流窗口内即使输入**正确密码**仍 429，即窗口对账号维度生效。
- `/api/ask` 连打 12 次未触发 429，与 `ASK_RATE_LIMIT_MAX = 15`【源码检查】一致，非缺陷。
- 敏感明文整包导出限 5 次/用户、导入/恢复走 `bulk_ingest` 限流【源码检查】；本轮多次恢复未越限。
- **口径污染声明**：「不存在账号登录」用例在暴破窗口内执行，返回 429 而非账号不存在的常规响应，**因此本轮不能据此评价账号枚举防护**；「不存在账号找回」用例漏传合法长度 `new_password`，返回 400 `新密码需 8-128 个字符`，同样无效。两项列为【未验证】。

### 2.3 token 重置与恢复码 ✅【生产实测】

`pen-token-lifecycle.json`：轮换后旧 token 401 / 新 token 200；第二设备 token 可独立签发使用；重生成恢复码后**被覆盖的旧恢复码** 401；正确恢复码找回成功后**旧密码登录 401、此前全部 3 个 token（原始/轮换后/第二设备）全部 401**；恢复码一次性（重放 401）。

### 2.4 敏感附件与 R2 直链 ✅【生产实测】

`pen-r2.json`：owner 下载敏感附件原件 200，响应头 `Cache-Control: private, no-store`、`Content-Disposition: attachment`；未授权/他账号 token 直取 r2 key 路径（`/media/...`、`/files/...`、`/api/media/...`）全部 404/401；R2 无公开自定义域直链【生产实测 + 源码检查：`/api/notes/:id/file` 先按 `user_id` 校验笔记归属，再按 `note_id` 校验 attachment 归属】。

### 2.5 备份 zip 敏感闭包 ✅【生产实测】

`pen-backup-closure.json`：

- 默认备份（`GET /api/backup`）：条目 `manifest/notes/threads/reports`，敏感笔记 content/title 均为 `[已加密内容]`、tags 清空，`attachments_redacted: 1`，**敏感附件原件不入包**；正则全文扫描 zip：敏感口令值与敏感附件内容标记均**未出现**。
- 完整备份（`?include_sensitive=true`）：无密码 403 `password_required`、错密码 403、正确密码 200 且包含 `media/<note>/0-*.txt` 原件与明文——分级如设计。
- `/api/export` 同一口径（默认脱敏、完整需密码）。

---

## 3. §2 备份 → 恢复 → 注销全生命周期

账号：`bk1`（源，35 条混合语料）、`bk2`（完整恢复目标）、`bk3`（脱敏恢复目标）、`bk4`（报告/线索专项）。语料含敏感文本 5 条、附件 3 个（含敏感 txt、普通 txt、PNG）、待办（含到期时间/已完成）、记账（多币种/负数/多行台账）、链接剪藏、想法、数据类。

### 3.1 保真度 ✅【生产实测】

`lifecycle-seed.json` / `lifecycle-restore.json`：

| 项 | 结果 |
| --- | --- |
| 源笔记数 | 35 |
| 完整备份恢复到 `bk2` | `notes_total 35 / imported 35 / skipped 0 / sensitive_skipped 0 / media_imported 3 / media_failed 0` |
| 逐项比对（content / category / tags / title / source / raw_type / url / url_title / is_sensitive / todo_due / todo_done / done_at / amount / currency / created_at） | **field_diffs = 0**，`missing_in_dest = []`，`duplicated_in_dest = []` |
| 附件字节比对（3 个） | 源/目标 `Content-Length` 与内容**逐字节一致** |
| 重复恢复（同 zip 再导入一次） | `imported 0 / skipped 35 / media_skipped 3` — 幂等，无重复笔记 |
| 脱敏备份恢复到 `bk3` | `imported 30 / sensitive_skipped 5 / media_imported 2` — 敏感占位不落库（fail-closed），与 manifest `attachments_redacted:1` 自洽 |

### 3.2 P2-1：`threads.json` / `reports.json` 导出但恢复静默丢弃 ⚠️【生产实测 + 源码检查】

- `bk1` 备份 manifest：`threads: 3`；`bk4` 专项备份 manifest：`reports: 1`，zip 内 `reports.json` 确含 `week_start = 2026-08-17` 的周报。
- 恢复到新账号后：`bk2` 的 `/api/stats` 显示 `thread_count: 1`（重建产生，非导入）、`/api/reports` 为空；`bk4` 侧恢复带 1 份周报的 zip 后 `/api/reports` 仍为空（`reports-fidelity.json`）。
- 根因【源码检查】：`backend/src/backup.ts` 的 `restoreBackup` 只消费 `notes.json` 与 `media/`，`RestoreStats` 无 threads/reports 字段，恢复结果里**也不报告丢弃**（不是 fail-loud，是静默）。
- 影响：跨账号/跨环境「无损搬家」实际丢历史周报与线索归组，用户侧不可见。定级 **P2-1**（数据不是不可恢复地丢失——笔记仍在，可重新生成；但承诺与实际不符且无提示）。

### 3.3 注销与残留 ✅【生产实测】

见附录 B：8 个 QA 账号逐个「软删全部笔记 → 清空回收站（硬删）→ `DELETE /api/auth/me`」，随后 token 全部 401；D1 实查 `[QA-R193]` 用户 0 行、含 `QA-R193` 笔记 0 行、12 张派生表孤儿行全部 0。

---

## 4. §3 剪藏扩展 + MCP 双入口回归

账号：`[QA-R193]-dual`。证据：`mcp-ext.json` / `sens-matrix.json` / `sens-flake.json` / `sens-leak.json`。

### 4.1 MCP（生产 `/mcp`）✅【生产实测】

- `initialize` 200，协议 `2025-06-18`，`serverInfo.name = suinian`；工具列表 11 个：`save_note / search_notes / ask / list_threads / get_thread / get_weekly_report / list_todos / complete_todo / set_todo_due / delete_note / restore_notes`。
- 敏感内容经 MCP 写入：返回体 content/title 均为 `[敏感内容已脱敏]`、`is_sensitive: true`；`search_notes` 命中 0 条；`ask` 不返回内容，只声明「另有 1 条加密的敏感笔记可能相关」。
- `delete_note` 为软删，`restore_notes` 可恢复；跨账号 `delete_note` / `get_thread` 均返回包裹 HTTP 404 `not found` 的 MCP 错误，受害者笔记复查完好。
- **确认约定**：生产后端 `delete_note` 描述含完整约定原文（「这是破坏性操作，调用前必须先用 search_notes 找到具体笔记，向用户复述将删除的笔记内容摘要并得到明确同意；用户指令含糊（如「清理一下」）时绝不得自行批量删除。」）✅

### 4.2 P3-1：本地 stdio MCP 的 `delete_note` 描述缺确认约定 ⚠️【源码检查】

`mcp/src/server.ts` 的 `delete_note` 描述只讲软删与 30 天可恢复，**没有**后端那段「必须复述摘要并取得同意/含糊指令不得批量删除」的约定；而 MCP 客户端的模型正是靠 description 决定调用姿势。两个入口的安全护栏不等价。定级 **P3-1**（默认部署形态是后端 `/mcp`；本地 stdio 为自托管路径，影响面小但属护栏漂移）。

### 4.3 去重与来源过滤 ✅【生产实测】

模拟扩展客户端行为（`extension/utils/api.ts::findDuplicateNote` 的口径：`GET /api/notes?url=<url>&source=extension&limit=20` 后按 content 精确比对）：同 URL + 同 content 的二次剪藏被判重（返回既有 note id，不重复建条）；`source=extension` 过滤只回扩展来源；不同 content/同 URL 不误判为重复。

### 4.4 P2-2：凭证类剪藏在「剪藏语境」下漏判非敏感，明文经 MCP search 原样返回 ⚠️【生产实测 + 源码检查】

同一凭证形态，分类结果随**措辞外壳**摆动，且两入口一致（即入口本身无差异，问题在分拣召回）：

| 语料 | 入口 | 分拣后 `is_sensitive` |
| --- | --- | --- |
| `测试环境后台 admin / Sx-R193-mx-77` | web / extension | **true**（category `data`） |
| `测试环境后台账号 admin，密码 Sx-R193-mx` | web / extension | true（写入时即 true，fail-closed 生效） |
| `后台登录：用户名 ops-r193，凭证 Sx-R193` | web / extension | true |
| `[QA-R193] 剪藏含凭证：测试环境后台 admin / Ext-R193-clip-7742`（+ 摘录/URL 尾巴） | extension ×3 / web ×3 | **false**（6/6 复现，category `collect`/`data`） |

漏判后果【生产实测】：该笔记明文（含凭证串）在 MCP `search_notes` 结果中**原样返回**（`sens-leak.json`），未走 `redactNote`；问答未逐字吐出口令，但返回的 note 对象含明文。根因方向【源码检查】：`backend/src/triage.ts` 的 `SENSITIVE_TOPIC_RE`/`SENSITIVE_ASSIGN_RE` 依赖「密码/口令/密钥/token…」等主题词与赋值句式，`admin / <串>` 这类**无主题词的斜杠凭证对**在被更长的剪藏外壳包裹时由模型判定，模型判为 `collect` 后 fail-closed 窗口解除、明文恢复可见。

口径说明：本轮对「漏判笔记的明文是否进入默认备份」的检查因测试串编号与实际入库串不一致而**未取得有效证据**，列为【未验证】——但按设计，非敏感笔记明文本就应进默认备份，故这不是额外缺陷，风险点在**漏判本身**。定级 **P2-2**。

---

## 5. §4 PWA 离线 / 弱网复审

由测试子代理在生产 Web + 真实 Chrome 执行【生产实测 + 模拟（DevTools 断网）】。录屏：`/home/ubuntu/screencasts/rec-e6089ba1-25b8-4ab5-badb-6b12e1bca469/rec-e6089ba1-25b8-4ab5-badb-6b12e1bca469-edited.mp4`（审查机本地，含逐步标注）。

| 用例 | 结果 |
| --- | --- |
| T1 离线文本写入队列（3 条中文速记） | ✅ 提示原文「3 条离线速记待同步，联网后自动补发」；恢复网络后 3/3 自动补发，API 侧确认全部落库（截图 `ss_zoom_ff5fe264.png` / `ss_5de6931b.png`） |
| T1 离线图片上传 | ❌ 见 P2-4：报「网络连接失败，请检查网络或 API 地址」，IndexedDB `media` store 计数保持 0（截图 `ss_zoom_90345c1a.png`） |
| T1 离线语音 | 【未验证】审查机无麦克风 |
| T2 SW 缓存身份隔离（A→登出→B） | ✅ A 账号 4 条 `suinian-api` 缓存均带 A 的 `sn_uid`；登出后缓存清零；B 登录后仅 3 条 B 的 `sn_uid`；离线重载以 B 身份**未出现任何 A 笔记**（截图 `ss_783ddeba.png` / `ss_c10d6651.png`）。与 `web/src/lib/api-cache.ts` 的 URL 分区 + `scrubApiCache` 设计一致【源码检查】 |
| T3 SW 失败态可见化 | ❌ 见 P2-3：注销 SW 后离线重载 → Chrome 通用「无网络」恐龙页，无任何应用内解释（截图 `ss_d636aeaf.png`） |
| T4 离线读 + 离线追写 | ✅ 暖缓存下离线可渲染时间流并追加速记、联网补发（截图 `ss_87893e61.png` / `ss_zoom_833902a3.png`）；但界面无「当前离线」指示，见 P3-2 |

- **P2-3（SW 失败态不可见）**【生产实测 + 源码检查】：`web/src/components/reload-prompt.tsx` 的 `useRegisterSW` 只处理 `onRegisteredSW`，**没有 `onRegisterError`**；SW 注册失败/被清除时应用没有降级提示，用户看到的是浏览器错误页，无法区分「我的网断了」与「离线能力坏了」。
- **P2-4（离线图片/文件不入队）**【生产实测 + 源码检查】：`web/src/lib/outbox.ts` 有 `media` store 与 `enqueueMedia`，但离线图片上传路径未入队，失败即丢——同一屏内文本能排队、图片直接失败，语义不一致，且「什么都能丢」承诺在图片上不成立。
- **P3-2（无离线指示）**【生产实测】：离线读态下无全局离线标识，用户不知内容是缓存快照。

---

## 6. §5 微信三通道防腐化核查

证据：`wechat-probe.json`【生产实测】+ `backend/src/wechat-mp.ts` / `wecom-kf.ts` / `index.ts`【源码检查】。

| 通道 | 生产探测 | 判定 |
| --- | --- | --- |
| 公众号 `GET/POST /wechat/mp` | 404 `not found`（含带伪造 `signature`/`echostr` 的请求） | ✅ 未配置即整体关闭（`WECHAT_MP_TOKEN` 缺失时直接 404），未伪装可用 |
| 企微客服 `GET/POST /wechat/kf` | 404 `not found`（含伪造 `msg_signature`） | ✅ `wecomKfConfigured` 三个 secret 全备才开放 |
| 绑定状态 `GET /api/wechat/binding` | `{configured:false, bound:false, kf_configured:false, kf_bound:false}` | ✅ 如实上报未配置，不谎称可绑 |
| 生成绑定码 `POST /api/wechat/bind-code` | 404 `微信通道未配置`（含机器可读 code） | ✅ 拒绝且给出真实原因 |
| iLink bridge `GET /health?probe=bridge` | **HTTP 503** + `{"ok":false,"bridge":{"status":"waiting_scan","last_seen_at":"2026-08-19 09:05:27","detail":"login attempt round 322 failed: The operation was aborted due to timeout"}}` | ✅ **等扫码不伪装在线**：仅 `status==="online"` 才 200/ok，`stale`（>5min 无心跳）与 `never_reported` 均如实降级 |

签名/加解密口径【源码检查】：明文模式 `sha1(sort(token,timestamp,nonce))`、安全模式 `sha1(sort(token,timestamp,nonce,encrypt))`，校验失败 403；企微 echostr 需解密成功才回显，解密失败 400。

### 6.1 观察项 O-1：生产 bridge 实际处于长期扫码失败态【生产实测】

`detail` 显示「login attempt round 322 failed: timeout」，即 iLink bridge 已连续 322 轮登录失败，个人微信通道**当前不可用**。探针如实反映（不定级为缺陷，属运维事实），但建议确认是否还要维持该通道。

### 6.2 P2-5：任意登录用户可写全局 bridge 心跳，可伪装 `online` ⚠️【生产实测（授权边界）+ 源码检查】

- `POST /api/bridge/heartbeat` 挂在 `/api/*` 的 bearer 中间件之后，**只校验「是某个合法用户」**，不校验是否是 bridge 本体（对比：`/api/admin/*` 用独立 `ADMIN_TOKEN`）。写入的是全局共享行 `cron_heartbeats('wechat_bridge')`，`/health?probe=bridge` 与外部监控（UptimeRobot）读同一行。
- 生产授权边界实测（**刻意不改状态**）：无 token → 401；非法 token → 401；**普通 QA 用户 token + 非法 status** → **400 `status must be one of: online/waiting_scan/starting`**，即请求已通过鉴权、仅被参数校验拦下；复查 `/health?probe=bridge` 状态与 `last_seen_at` 未变。
- 未执行的一步（如实声明）：**未**用 QA token 写入 `status:"online"` —— 那会覆盖生产真实故障态、可能掩盖真实告警，超出只读审查授权。因此「可伪装在线」是**基于鉴权已通过 + 写入无归属校验**的推断，定级 **P2-5**，建议改为独立 bridge 密钥（或 admin token）后由修改方自验。

---

## 7. §6 R181–R190 修复防漂移抽测

账号：`[QA-R193]-drift`（11 条语料 + 2 次导入）。证据：`drift.json` / `drift-ledger.json`。跳过 R191/R192 在改的空格分隔台账与聚类项。

| 轮次 | 抽测 case | 结果 |
| --- | --- | --- |
| R180 | 乐观锁 409 文案 | ✅ 陈旧 `base_updated_at` → 409 +「该笔记刚被更新（可能来自其他设备或后台自动整理），已返回最新内容，请基于最新内容重试」并回带最新笔记；新鲜值 → 200 |
| R181 | 搜索 `%`/`_` 通配符透传 | ✅ `%`、`_`、`%%`、`%R193%`、`a_b%` 五种查询 `hits=0`，未命中全库 |
| R182 | 软删笔记不参与召回 | ✅ 删除后问答不再命中该笔记（改为「关键词没找到记账记录…不做心算合计」，并给出全量口径统计）；`restore` 后恢复 |
| R183 | 二进制伪装文本导入 | ✅ PNG 以 `source=text` 上传 → 400「文件不是文本内容（疑似图片/压缩包等二进制文件）…」 |
| R183/R189 | 多行台账合计不参与单笔排名（逗号分隔、全正数） | ✅ 极值与序数答案均附「另有 1 条多行台账笔记的金额为多笔合计，未参与单笔比较」 |
| R183/R189 | 同上，但台账**含负数行**（退款） | ❌ **P1-1**，见下 |
| R184 | GBK / Big5 导入编码嗅探 | ✅ `预算三千五百元，负责人张伟`、`專案預算兩萬元，負責人陳先生` 均无乱码入库，检索可回读 |
| R185 | 多轮追问指代解析 | ✅ 首轮「空气炸锅花了多少钱」→ ¥459 精确统计；追问「它是在哪买的」→「在京东自营买的 [1]」 |
| R186 | 线索计数一致性 | 【未验证】本轮语料未形成线索（`/api/threads` 为空），无法抽测 |
| R187 | 分拣准确率 | ✅ 11/11 正确（expense ×5、多行台账 expense、todo、idea、collect、两条凭证类 data 且 `is_sensitive:true`） |
| R188/R190 | 凭证类问答口径 | ✅ 「路由器管理后台密码是多少」→ 不吐明文，答「另有 1 条加密的敏感笔记可能相关（内容不会进入问答），可到时间流搜索…点击解锁查看」；全响应扫描无口令原值 |

### 7.1 P1-1：含退款/负数行的台账逃过聚合判定，序数问答以肯定语气报错数 ❌

- 语料（逗号分隔，含一行退款）：
  ```
  [QA-R193-D] 上周办公台账：
  打印纸,120
  工位绿植,368.5
  快递费,-34.5
  合计,454
  ```
  入库后 `amount = 454`（= 合计）。
- 【生产实测】同一账号内单笔支出为 459/155/88/68/36：
  - 「我最贵的一笔支出是多少？」→ ¥459 ✅（正确，但**未**声明台账被排除）
  - 「我第二贵的一笔支出是多少？」→ **「你金额第 2 大的一笔支出是 ¥454…：上周办公台账」**，语气为「数据库精确查询结果」。真值应为 **¥155**（单笔），¥454 是 4 行台账的合计。
  - 对照实验：另建一条**全正数**逗号台账（合计 1708）后再问，两问答案均附「另有 1 条多行台账笔记的金额为多笔合计，未参与单笔比较」——即排除机制**只对被识别的台账生效**，未识别的那条继续冒充单笔。
- 【本地测试】对 `backend/src/triage.ts::parseLedgerCore` 直接取值（vitest，临时测试文件已删除，未入仓库）：
  ```
  comma_with_negative_row  -> null        # 含 -34.5 的台账：识别失败
  comma_all_positive       -> {amount:488.5, rows:2}
  space_separated          -> null        # R192 正在修的分隔符路径
  comma_negative_no_total  -> null
  ```
- 根因【源码检查】：`parseLedgerCore` 的金额列判定 `isMoney(s) = LEDGER_MONEY_RE.test(s) && parseFloat(...) > 0` 要求**该列每一行都是正数**；一行退款/负数即让整表不成台账 → `isLedgerAggregateNote` 返回 false → 合计金额以单笔身份进入极值/序数比较。
- 与 R192 的关系：R192 修的是**空格分隔**导致的解析失明，本条是**负数行**导致的解析失明，两者根因不同，**修分隔符不会顺带修好本条**。
- 定级 **P1-1**：与 R191 P1-1 同一用户可见症状（序数问答给出肯定语气的错误数字），直接违反「可靠找回」口径承诺；退款行在真实记账里常见。

---

## 8. 问题分级汇总

| 编号 | 级别 | 问题 | 证据类型 | 建议归属 |
| --- | --- | --- | --- | --- |
| P1-1 | P1 | 含负数/退款行的多行台账逃过聚合判定，序数问答把合计当「第 2 大的一笔支出」肯定作答（真值 ¥155→答 ¥454） | 生产实测 + 本地测试 + 源码检查 | R194（与 R192 分隔符修复合并成一套台账识别用例集） |
| P2-1 | P2 | 备份 zip 导出 `threads.json`/`reports.json`，恢复流程静默不导入且不上报丢弃 | 生产实测 + 源码检查 | R194 |
| P2-2 | P2 | 凭证类内容在剪藏外壳下被判非敏感（6/6 复现），明文经 MCP `search_notes` 原样返回 | 生产实测 + 源码检查 | R194（补 `admin / <串>` 无主题词凭证对的确定性规则 + 固定评估集） |
| P2-3 | P2 | SW 注册失败无 `onRegisterError` 处理，离线重载只见浏览器恐龙页，失败态不可见 | 生产实测 + 源码检查 | R194 |
| P2-4 | P2 | 离线图片上传不入 outbox（文本可入队），失败即丢 | 生产实测 + 源码检查 | R194 |
| P2-5 | P2 | `POST /api/bridge/heartbeat` 只需任意用户 token 即可写全局 bridge 状态（可伪装 `online` 骗过探针/外部监控） | 生产实测（授权边界）+ 源码检查 | R194（改独立 bridge 密钥） |
| P3-1 | P3 | 本地 stdio MCP `delete_note` 描述缺后端已有的确认约定 | 源码检查 | 顺手对齐 |
| P3-2 | P3 | 离线缓存读态无「当前离线」指示 | 生产实测 | 顺手 |
| O-1 | 观察 | 生产 iLink bridge 连续 322 轮扫码登录失败，个人微信通道实际不可用（探针如实） | 生产实测 | 运维决策 |

**零 P0**。

---

## 9. 未测范围（如实声明）

- 账号枚举防护口径（不存在账号的登录/找回响应）：本轮两次用例分别被限流窗口污染与参数写错，**未验证**。
- 离线语音录入入队：审查机无麦克风，**未验证**。
- R2 桶内孤儿对象直查：可用的 Cloudflare token 均无 R2 管理/列举权限（`d1 execute` 可读，R2 API 403），**未验证**；间接证据为 D1 侧 `attachments` 孤儿行 0、注销路径对全部 r2 key 调用 `MEDIA.delete`【源码检查】。
- 线索聚类质量/评估校准、空格分隔台账：**刻意不测**（R192 在改）。
- 无障碍/视觉终检：**刻意不测**（R192 在改 3 个 P2）。
- 线索计数一致性抽测（R186）：语料未形成线索，**未验证**。
- cron 到点提醒/推送实际到达、微信通道端到端收发（需真实公众号/企微配置）：**未验证**。
- 漏判凭证笔记的明文是否进入默认备份：证据无效，**未验证**（见 §4.4）。

---

## 10. 给 R194 的建议排期

1. P1-1 台账识别：把负数行/退款行纳入金额列判定（负数是合法记账方向，不该让整表失明），与 R192 的分隔符修复合并为**同一套台账形态用例集**（逗号/空格/制表/含负数/含合计/多合计歧义），并补进 ask-eval。
2. P2-1 恢复完整性：导入 `threads.json`/`reports.json`，或在 `RestoreStats` 中显式上报 `threads_skipped`/`reports_skipped` 并在 UI 提示——**要么补齐，要么不再声称无损**。
3. P2-5 bridge 心跳鉴权：改用独立 bridge 密钥，避免任意用户篡改全局健康信号。
4. P2-2 敏感召回：为「无主题词的凭证对」补确定性规则并建固定评估集（本报告 §4.4 表可直接作种子）。
5. P2-3 / P2-4 PWA：补 `onRegisterError` 降级提示 + 图片/文件离线入队（`enqueueMedia` 已存在，接上即可）。
6. P3-1 / P3-2 顺手对齐。

---

## 附录 A：证据文件清单（审查机 `/home/ubuntu/qa-r193/`，含 QA 凭据故不入仓库）

| 文件 | 内容 |
| --- | --- |
| `pen-seed.json` / `pen-authz.json` | 渗透语料与 11 类越权用例响应原文 |
| `pen-ratelimit.json` / `pen-token-lifecycle.json` | 限流曲线、token 轮换与恢复码全链路 |
| `pen-r2.json` / `pen-backup-closure.json` | 敏感附件响应头与直链探测、备份闭包扫描 |
| `lifecycle-seed.json` / `lifecycle-restore.json` / `reports-fidelity.json` | 35 条语料、跨账号恢复逐项比对、报告/线索专项 |
| `bk1-full.zip` / `bk1-redacted.zip` / `bk-pen-full.zip` / `bk-pen-redacted.zip` / `dual-redacted*.zip` | 生产备份原始 zip |
| `mcp-ext.json` / `sens-matrix.json` / `sens-flake.json` / `sens-leak.json` | MCP 双入口、敏感分拣矩阵与 6/6 复现、明文回流证据 |
| `wechat-probe.json` | 三通道探测与 bridge 心跳授权边界 |
| `drift.json` / `drift-ledger.json` | R181–R190 抽测与台账对照实验 |
| `cleanup.json` | 逐账号自清与注销后 401 校验 |
| 录屏 `~/screencasts/rec-e6089ba1-.../*-edited.mp4`、截图 `~/screenshots/ss_*.png` | PWA 离线/弱网实测过程 |

## 附录 B：QA 数据自清记录【生产实测】

`cleanup.json`：8 个账号（`pen`/`pen2`/`bk1`/`bk2`/`bk3`/`bk4`/`dual`/`drift`）逐个执行「批量软删 → `POST /api/notes/trash/empty` 硬删 → `DELETE /api/auth/me`」：

- 硬删条数：4 / 1 / 35 / 38 / 30 / 2 / 17 / 14；执行后各账号 `notes=0`、`trash=0`、`threads=0`。
- 注销后 `GET /api/auth/me` 全部 **401**；用原密码登录返回 401「用户名或密码错误」（3 个账号因登录限流窗口返回 429，非账号存活证据）。
- D1 远端实查（只读 SELECT，`wrangler d1 execute suinian --remote`）：

  | 检查项 | 结果 |
  | --- | --- |
  | `users` 含 `QA-R193` | 0 |
  | `notes` 含 `QA-R193` | 0 |
  | 孤儿 `notes` / `attachments` / `api_tokens` / `threads` / `weekly_reports` | 0 / 0 / 0 / 0 / 0 |
  | 孤儿 `note_embeddings` / `entities` / `edges` / `daily_reviews` / `user_preferences` / `push_subscriptions` / `thread_jobs` / `thread_backfill` / `push_daily_log` / `wechat_mp_bindings` / `wecom_kf_bindings` / `wechat_mp_bind_codes` | 全部 0 |

- 向量库：QA 笔记均已随注销走 `VECTORIZE.deleteByIds`【源码检查】，且 D1 侧 `note_embeddings` 孤儿 0；Vectorize 直查无可用凭据，**未独立验证**。
- R2：**未验证**（可用 token 无 R2 权限），间接证据见 §9。
- `u_boss` 全程未被访问、未被修改。

## 附录 C：本地验证（公司验收标准）

- 本 PR 仅新增 `docs/audit-r193.md`，无产品代码变更；`git status` 干净（抽测用的临时 vitest 文件已删除）。
- 抽测期间在 `backend/` 本地跑过一次针对 `parseLedgerCore` 的临时单测（结论见 §7.1），未改任何源码、未提交该测试文件。
- GitHub Actions 保持禁用；按公司规则以本地验证为验收基准，不因 CI 不触发而阻塞。
