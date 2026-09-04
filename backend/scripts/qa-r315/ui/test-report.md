# R315 独立审查 — 生产 UI 复验报告（只审不改）

- 环境：https://suinian.zalize.com（Pages 944fc695）/ https://suinian-api.zalize.com（Worker cb57f6e1），真实 Chrome（CDP 29229，1600×1069 CSS px，最大化），全程录屏。
- 录屏：`/home/ubuntu/screencasts/r315-ui/r315-ui-edited.mp4`
- 证据目录：`/home/ubuntu/qa-r315-ui/`（截图 `shots/`，API 抓取 `*.json`，剪贴板 `clip-ctrlA.txt`，401 结果 `auth-401.txt`）。密码/恢复码/token 均未出现在屏幕与本报告中。
- 剪贴板判定法：每次危险复制前 `printf CANARY | xclip -selection clipboard`，事后 `xclip -o -selection clipboard`。

## 总览

| 项 | 结果 |
|---|---|
| T1 六条笔记卡片形态 | **部分失败**：N1/N2 destructive 高警示卡 ✅；N3 敏感遮罩→取消敏感后 credential 折叠卡 ✅；N6 普通卡 ✅；**N4 未成 code 备忘卡、N5 未折叠**（都渲染为普通「资料」卡） |
| T2 复制确认矩阵 | 卡片内三路径（菜单/选中 Ctrl+C/右键复制）对 N1/N2/N3 全部弹确认 ✅；**(e) 页面 Ctrl+A+Ctrl+C 无提示带走危险原文 ❌**；N4/N5 因未分类，所有路径无任何提示 ❌（相对预期）|
| T3 问答 | 破坏性答案带〔警示…〕✅；凭证答案不露 `zr4t8vq2` ✅ 引用卡折叠 ✅；引用卡展开后 Ctrl+C 弹确认 ✅；**答案区命令文字选中 Ctrl+C 无确认 ❌**；`done` 无 `isolated_refs` 字段（记录） |
| T4 线索 | 重建后线索标题「中继机配置与登录」，不含危险原文 ✅；但首页「今日回顾」卡直接展示 N5 原文 `relay7.example.net`（观察） |
| T5 账号 B Day1 + Outbox | ✅ 全通过（离线 2 条 → banner「2 条离线记录」+ 预览 → 在线恰重放 1 次、`meta.client_id` 存在、同 client_id 重发返回同 id） |
| T6 账号 C Day1 + Push | Day1 ✅；**Push 订阅 / 30 分钟观测 untested**：生产 Service Worker 安装失败（「重试超时」），无法进入订阅 |
| T7 账号 D 375px Day1 | ✅ 注册+3 笔记+问答+设置全程 375px，`scrollWidth 375 <= innerWidth 375`（首页/设置） |
| T8 注销 | ✅ 4 账号 UI 永久注销，4 个 token `/api/auth/me` 均 401 |

---

## T1 账号 A：六条笔记卡片形态（截图 `shots/T1-*.png`）

| # | 笔记 | 预期 | 实际 | 判定 |
|---|---|---|---|---|
| 1 | 清盘备忘 `sudo rm -rf … && sudo dd …` | strict 折叠 或 destructive 高警示 | **destructive 高警示卡**：红框 + ⚠ + 「破坏性命令（会删除/覆写数据）：请勿直接执行，先核对对象与参数」，原文默认展开在红框内。API `fold=true`、Ask 侧 `fold_reason=broad:destructive` | pass |
| 2 | 重建库 `DROP DATABASE app_prod;` | destructive 高警示卡 | 同上红框高警示卡 | pass |
| 3 | 跳板用 zr4t8vq2 登录，端口 2222 | 敏感遮罩 或 credential 折叠 | 入库先为**敏感遮罩**（锁形「敏感内容，点击查看」）；菜单「取消敏感」后变为 **credential 折叠卡**「🔑 含口令/密钥类内容，已折叠 / 展开查看 / 这条笔记含口令、密钥或连接串口令段…问答区只给占位，不逐字转写」。展开后有黄色提示「含口令/密钥类内容，建议标为敏感笔记加密保存」+ 原文（`T1-n3-credential-expanded.png`） | pass（两态均截图） |
| 4 | 看端口 `ss -lntp \| grep 8080` | code 备忘卡（灰字「命令备忘：复制或执行前请核对来源与参数」） | **普通「资料」卡**，正文直出，无任何备忘提示（`T1-destructive-vs-code-cards.png`）。API `fold=false` | **fail（分类未命中 code）** |
| 5 | 中继机是 relay7.example.net，端口 4444 | strict/broad 端点折叠 | **普通「资料」卡**，未折叠，原文直出。API `fold=false` | **fail（端点未折叠）** |
| 6 | 明天下午三点和小李开会讨论周报 | 普通卡 | 普通「待办」卡，带 09-05 15:00 到期，无警示 | pass |

层级对比（N2 vs N4，`T1-destructive-vs-code-cards.png`）：N2 红框 + 红字 + 三角图标；N4 无任何框/图标/提示。「破坏性警示卡层级高于普通命令备忘卡」在视觉上成立，但**N4 根本没渲染成命令备忘卡**，所以「备忘卡」这一层级在本轮生产数据上不可验证。

## T2 复制确认矩阵（账号 A）

确认框文案（三档均抄录自页面）：
- destructive（N1/N2）：标题「复制破坏性命令？」，正文「这条笔记含会删除/覆写数据的命令（如 rm -rf / dd / DROP TABLE）。复制后请先核对目标对象与参数，确认无误再决定是否执行。」按钮「取消」/「仍要复制」。
- credential（N3）：标题「复制口令/密钥类内容？」（`T2-n3-ctrlc-confirm.png`），按钮「取消」/「仍要复制」。

| 笔记 | 路径 | 弹确认 | 取消后 xclip -o | 确认后 xclip -o | 判定 | 截图 |
|---|---|---|---|---|---|---|
| N1 | (a) 菜单「复制内容」 | 是 | `CANARY` | `[QA-R315] 清盘备忘：sudo rm -rf /var/lib/data && sudo dd if=/dev/zero of=/dev/sda bs=1M`（全文） | pass | `T2-n1-menu-copy-confirm.png` |
| N1 | (b) 折叠态 | N/A（destructive 卡默认展开） | – | – | n/a | |
| N1 | (c) 拖选 + Ctrl+C | 是 | `CANARY` | 所选段 `：sudo rm -rf /var/lib/data && sudo dd if=/dev/zero of=/dev/sda bs=1M` | pass | `T2-n1-ctrlc-confirm.png` |
| N1 | (d) 选中 → 右键 → Copy | 是 | `CANARY` | （未再确认，同 (c) 对话框） | pass | `T2-n1-rightclick-confirm.png` |
| N2 | (a) 菜单 | 是 | `CANARY` | 全文 | pass | `T2-n2-menu-copy-confirm.png` |
| N2 | (c) Ctrl+C | 是 | `CANARY` | 原文 | pass | `T2-n2-ctrlc-confirm.png` |
| N2 | (d) 右键 Copy | 是 | `CANARY` | 原文 | pass | `T2-n2-rightclick-confirm.png` |
| N2 | (f) 375px 拖选 + Ctrl+C | 是 | `CANARY` | 原文 | pass；触摸长按选择 **untested**（xdotool 无触摸，未用 Input.dispatchTouchEvent 模拟长按菜单） | `T2-375-cards.png`, `T2-375-n2-ctrlc-confirm.png` |
| N3（取消敏感后） | (b) 折叠态拖选 + Ctrl+C | 折叠卡整体是 `<button>`，拖选变为点击展开，无原文可选；剪贴板仍 `CANARY`；DOM 折叠态仅占位文案，无 `zr4t8vq2` | – | – | pass | |
| N3 | (c) 展开后拖选 + Ctrl+C | 是（credential 文案） | `CANARY` | 原文 | pass | `T2-n3-ctrlc-confirm.png` |
| N3 | (a) 菜单 / (d) 右键 | 未单独复跑（时间原因；同一 CopyGuard 容器，(c) 已证明拦截） | | | **untested** | |
| N4（code 预期） | (a) 菜单 | **否**，直接写入 | – | `[QA-R315] 看端口：ss -lntp \| grep 8080` | 无确认符合 code 预期，但**无任何「已复制：执行前请核对…」警告 toast**（因未分类为 code） | |
| N4 | (c) Ctrl+C | 否，无提示 | – | `口：ss -lntp \| grep 8080` | 同上（记录） | |
| N4 | (d) 右键 Copy | 否，无提示 | – | `口：ss -lntp \| grep 8080` | 同上（记录） | `T2-n4-rightclick-noprompt.png` |
| N5（relay7） | (a) 菜单 | **否**，直接写入 | – | `[QA-R315] 中继机是 relay7.example.net，端口 4444` | **fail（预期 strict/broad 折叠 + 确认）** | `T2-n5-menu-copy-noprompt.png` |
| N5 | (c)(d) | 卡未折叠、无 CopyGuard，与 N4 同行为（未逐一复跑） | | | untested/同 (a) | |
| N6 | (a) 菜单 | 否 | – | `[QA-R315] 明天下午三点和小李开会讨论周报` | pass | |
| N6 | (c) Ctrl+C | 否 | – | 同上全文 | pass | |
| **全部** | **(e) 页面 Ctrl+A + Ctrl+C** | **否，无任何提示** | – | 整页文本，含 `sudo rm -rf … dd …`、`DROP DATABASE app_prod;`、`relay7.example.net` 原文；N3 折叠态时 `zr4t8vq2` 不在其中（`clip-ctrlA.txt`） | **fail（R313 未测路径；CopyGuard 只挂在卡片容器上，全选复制目标为 body）** | `T2-ctrlA-fullpage-select.png` |

## T3 问答（账号 A）— `ask-done.json`

- 「我的清盘备忘怎么写的」：答案 `〔警示：以下为破坏性命令（会删除/覆写数据），请勿直接执行，先核对对象与参数〕 你的清盘备忘是这样写的：清盘备忘：sudo rm -rf /var/lib/data && sudo dd if=/dev/zero of=/dev/sda bs=1M [1]`，引用卡 [1] 为红框高警示卡 → **pass**（`T3-ask-destructive-answer.png`）。
  - 答案区选中 `sudo rm -rf …` + Ctrl+C：**无确认**，剪贴板直接得到命令 → **fail**（`T3-ask-answer-ctrlc-noprompt.png`）。
  - 引用卡内选中 + Ctrl+C：弹「复制破坏性命令？」 → pass（`T3-ask-citation-ctrlc-confirm.png`）。
- 「跳板口令是什么」：答案 `这是一条关于跳板登录信息的笔记，包括用户名和端口号，但口令并未直接给出 [1]。原文请点开引用的笔记卡片查看。` 不含 `zr4t8vq2`；引用卡为 credential 折叠卡 → **pass**（`T3-ask-credential-answer-folded.png`）。注意：并非题述的〔凭证略…〕占位文案，而是改写句式（记录）。
  - 引用卡展开后拖选 + Ctrl+C：弹「复制口令/密钥类内容？」 → pass（`T3-ask-credential-citation-ctrlc-confirm.png`）。
- `done` 关键字段（两问相同）：`trust_tier="single_note_direct"`，`verbatim_closed_spans=0`，`exec_gate="none"`，`sse_held={finalize_rewrite:1}`；**`isolated_refs` 字段不存在**（payload 仅有 trust_tier / verbatim_closed_spans / exec_gate / references / notes(fold, fold_reason)）。notes.fold_reason 分别为 `broad:destructive`、`broad:credential`。

## T4 线索（账号 A）

- 线索页「重建线索」后：单条线索「中继机配置与登录」(3 条碎念)，标题/摘要不含 `rm -rf` / `DROP` / `zr4t8vq2` / `relay7`，无空标题/「未命名线索」 → **pass**（`T4-threads-rebuilt.png`）。
- 观察：首页「今日回顾」卡直接展示 N5 全文 `[QA-R315] 中继机是 relay7.example.net，端口 4444`——这是 N5 未被折叠分类的连带结果（N5 若被折叠，是否会在回顾里出现未验证）。

## T5 账号 B：Day1 + Outbox（`T5-*.png`，`notes-b-api.json`，`outbox-idem.json`）

- 4 条普通笔记（待办/支出/想法/待办）+ 问答均正常分拣、回答 → pass。
- 单一持久 CDP 会话 `Network.emulateNetworkConditions offline`：录 2 条 → banner「1 条离线记录」→「2 条离线记录」，展开队列预览两条原文（`T5-outbox-2-queued-preview.png`）→ online → banner 消失、两条出现在时间流（`T5-outbox-replayed-online.png`）。
- `GET /api/notes`（Chrome UA）：总数 6，两条离线记录各恰 1 份；`meta.client_id` = `a38fce06-…`（离线一）、`2b842543-…`（离线二）。
- 同 `client_id=2b842543-3045-409c-b754-3916f74ecc1a` 重发 POST → HTTP 200，返回同一 `id=5a9270e1-39b8-49fc-8eb6-970df6aa2b7e`，总数仍 6 → 幂等 **pass**。

## T6 账号 C：Day1 + Push（`T6-*.png`）

- 3 条普通笔记 + 问答 → pass。
- 设置 → 浏览器通知 → 「开启浏览器通知」：先提示需要 Service Worker/离线缓存（`T6-push-requires-sw.png`）；开启离线缓存后 SW 注册存在但无 active/installing/waiting，UI 最终「安装失败 / 重试超时」（`T6-sw-wedged-retry-timeout.png`）。`Notification.permission="default"`，`pushManager.getSubscription()` 为 null。`GET /api/push/config`：push enabled、VAPID public key 存在。
- **Push 订阅与 ≥30 分钟消失观测：untested**（前置 SW 未就绪，非订阅逻辑本身的结论）。

## T7 账号 D：375px Day1（`T7-*.png`）

- CDP `Emulation.setDeviceMetricsOverride` 375×812，mobile：注册（恢复码只核对末四位，未记录）、3 条笔记、问答「我有什么待办」、设置页全程可用；首页与设置页 `document.documentElement.scrollWidth=375 <= innerWidth=375` → pass；测完 `clearDeviceMetricsOverride` 恢复。

## T8 注销与 401（`auth-401.txt`，`T8-*.png`）

| 账号 | user_id | UI 永久注销 | 保存 token → GET /api/auth/me |
|---|---|---|---|
| `[QA-R315]ui-a` | `u_9add054661d3` | 已注销（设置→危险操作→输入「注销」→永久注销，回到欢迎页） | **401** |
| `[QA-R315]ui-b` | `u_19ec437937c1` | 已注销 | **401** |
| `[QA-R315]ui-c` | `u_fa5bd09f395b` | 已注销 | **401** |
| `[QA-R315]ui-d` | `u_00f7a9ea1d01` | 已注销（375px 下完成） | **401** |

未触碰任何非 `[QA-R315]` 账号。

## 缺陷 / 观察清单（只记录不修）

1. **页面级 Ctrl+A + Ctrl+C 绕过 CopyGuard**：整页文本含 rm -rf / dd / DROP / relay7 原文，无任何提示。（P0-3 承诺的「选中后 Ctrl+C」在卡片外的全选路径不成立）
2. **问答答案区破坏性命令文字选中 + Ctrl+C 无确认**（引用卡内有确认，答案正文没有）。
3. **N4 `ss -lntp | grep 8080` 未判为 code**：无「命令备忘」提示、复制无警告 toast。
4. **N5 `relay7.example.net，端口 4444` 未判为端点折叠**：普通卡直出、复制无确认，且原文进入「今日回顾」。
5. `/api/ask` `done` 缺少 `isolated_refs` 字段。
6. 凭证问答答案为改写句而非〔凭证略…〕占位（功能上未泄露，文案与预期不同）。
7. 生产 PWA Service Worker 安装失败（重试超时）→ Push 无法启用（环境/部署问题，需另查）。
