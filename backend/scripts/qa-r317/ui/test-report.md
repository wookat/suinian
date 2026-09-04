# R317 独立审查 — 生产真实浏览器复测报告

- 目标：https://suinian.zalize.com（API https://suinian-api.zalize.com）
- 日期：2026-09-04（服务器时间）；Chrome 131 / Ubuntu，窗口最大化 1024x768（375px 部分用 CDP 设备模拟）
- 页面 bundle：`assets/index-Cmg8jLma.js`（CSS `index-Bqt3S7ST.css`）；API 根 `{"name":"suinian-api","status":"ok"}`、`/health {"ok":true}`（无版本号暴露；cf-ray 见 PDX 节点）
- 只测不改产品代码；QA 账号 `[QA-R317]ui1..ui4`，密码随机字母数字未落盘；未注销任何账号；未触碰非 [QA-R317] 账号
- 录屏：`/home/ubuntu/screencasts/r317-ui/r317-ui-edited.mp4`
- 截图目录：`/home/ubuntu/qa-r317/shots/`
- 账号文件（不含密码）：`backend/scripts/qa-r317/out/prod-ui{1,2,3,4}-account.json`
  - ui1 `u_7c9023494d97` · ui2 `u_1ae4cf128933` · ui3 `u_52b7ddc7f5fe` · ui4 `u_c7cddecabbb4`
- 剪贴板核对法：`printf CANARY-R317 | xclip -selection clipboard` → 执行复制 → `xclip -o`

## 结论速览

| 项 | 结果 |
|---|---|
| A Day1 ×4 | ui1/ui2/ui4 通过；ui3 问答软失败（金额问题未直答） |
| B 破坏命令卡 ① 五路径 | 全部通过（弹「复制破坏性命令？」，取消后剪贴板不变） |
| B 凭证卡 ② 四路径 | **全部失败**：无任何确认，明文口令直接进剪贴板（根因：被后端判为 `is_sensitive:true` 走「敏感加密」卡，不走 exec-guard 凭证折叠/复制守卫） |
| B code 备忘 ③ | 菜单复制弹确认对话框，拖选 Ctrl+C 只显示行内提示 → 强度**不一致** |
| B 普通文字 ④ | 通过（无任何提示） |
| B 绕过 a/b | 通过（扩选到危险卡后仍弹确认）；c 拖到地址栏：浏览器原生，不经守卫（记录）；d DevTools copy()：绕过（非用户路径，记录） |
| B 编辑态绕过（新发现） | **失败**：点击/长按危险卡进入编辑 textarea 后 Ctrl+A/Ctrl+C 直接复制原文，无确认 |
| C 警示卡 | ① 通过；② 折叠形式为「敏感内容，点击查看」而非承诺文案中的「口令/密钥折叠」；问答 ① 警示行通过；问答 ② 未命中（「没找到相关笔记」+ 敏感提示）而非 `〔凭证略…〕` |
| D 承诺文案 | 逐句见 §D；「复制这类内容…都会先提醒」对凭证类不成立 |
| E 375px | 布局无溢出通过；拖选 Ctrl+C 弹确认通过；CDP 触摸长按 → 进入编辑态（未出现选区/菜单），编辑态内可无提示复制 → 失败 |
| F SW/离线/Push | SW 默认 0 注册；断网 F5 = Chrome「No internet」页（无半空白壳）；Push 按钮可点，提示需先开启离线缓存 |

---

## A. 4 账号 Day1

步骤（每账号相同）：首页 → 「注册新账号」→ 填名/随机密码 → 「注册并开始使用」→ 恢复码卡输末 4 位 → 「我已安全保存，继续」→ 首次引导 → 快速记录发中文日常 + 一条英文 → 搜索 → 问答 → 待办页 → 设置页 → 复制 API token → `GET /api/auth/me` 取 user_id。

| 账号 | 注册/恢复码/引导 | 首条笔记（中+英） | 搜索 | 问答 | 待办/设置 | 结果 | 截图 |
|---|---|---|---|---|---|---|---|
| ui1 | 通过 | 通过，分拣徽标出现 | 「牛奶」命中 | 宽泛问「我今天买了什么」→ 「没找到相关笔记」软失败；改问具体问题命中并有引用卡 | 通过 | 通过（问答 1 软失败） | `A-ui1-onboarding.png` `A-ui1-recovery.png` `A-ui1-first-notes.png` `A-ui1-search.png` `A-ui1-ask-miss.png` `A-ui1-ask-hit.png` `A-ui1-todos.png` `A-ui1-settings.png` |
| ui2 | 通过 | 通过 | 命中 | 「你早上跑了五公里」直答 + 引用卡 | 通过 | 通过 | `A-ui2-first-notes.png` `A-ui2-search.png` `A-ui2-ask-hit.png` `A-ui2-todos.png` `A-ui2-settings.png` |
| ui3 | 通过 | 通过 | 命中 | 「我今晚吃饭花了多少钱」未直答金额，只给相近记录 → 软失败 | 通过 | 部分通过 | `A-ui3-first-notes.png` `A-ui3-search.png` `A-ui3-ask-softmiss.png` `A-ui3-settings.png` |
| ui4 | 通过（引导走「跳过」） | 通过；英文条被分拣为待办并识别日期 10-01 | 命中 | 「老家天气怎么样」→ 「老家下雪了 。」+ 引用卡（答案文本内无 [1] 内联引用角标，与 ui2 不一致；「了 。」前多一空格） | 通过 | 通过 | `A-ui4-first-notes.png` `A-ui4-search.png` `A-ui4-ask-hit.png` `A-ui4-settings.png` |

未见报错、空白页、卡顿；分拣 ≤10s。文案小问题：ui4 问答答案「老家下雪了 。」句号前多余空格。

## B. 复制守卫（ui1，4 条 skip_triage:true 经 API 入库）

入库后实际分级（API `is_sensitive` + DOM）：
- ① `清缓存：\nrm -rf /srv/cache/*` → exec-guard destructive（红框横幅）
- ② `跳板机口令是 Qv8#mk3zz` → **`is_sensitive:true`**，渲染为「敏感」加密卡（`••••••• 敏感内容，点击查看`），**不是** exec-guard credential 折叠卡，因此不带 `[data-copy-guard]`
- ③ `构建：npm ci && npm run build` → code（「命令备忘：复制或执行前请核对来源与参数」）
- ④ 普通

| 卡 | 路径 | 期望 | 实测 | 结果 | 截图 |
|---|---|---|---|---|---|
| ① | 卡片菜单「复制内容」 | 弹「复制破坏性命令？」 | 弹；取消→剪贴板=CANARY-R317；仍要复制→原文 | 通过 | `B1-menu-copy-confirm.png` |
| ① | 拖选 + Ctrl+C | 弹 | 弹，取消不变 | 通过 | `B1-drag-ctrlc-confirm.png` |
| ① | 右键复制 | 弹 | 弹，取消不变 | 通过 | `B1-rightclick-copy-confirm.png` |
| ① | 页面 Ctrl+A + Ctrl+C | 弹 | 弹，取消不变 | 通过 | `B1-ctrlA-ctrlC-confirm.png` |
| ② | 菜单「复制内容」 | 弹「复制口令/密钥类内容？」 | **无对话框，剪贴板直接变为 `跳板机口令是 Qv8#mk3zz`** | **失败** | `B2-menu-copy-no-confirm.png` |
| ② | 展开后拖选 Ctrl+C | 弹 | **无提示，明文入剪贴板** | **失败** | `B2-drag-ctrlc-no-confirm.png` |
| ② | 右键复制 | 弹 | **无提示，明文入剪贴板** | **失败** | `B2-rightclick-no-confirm.png` |
| ② | 展开后再菜单复制 | 弹 | 无提示 | **失败** | 同上 |
| ③ | 菜单「复制内容」 | 一致的 code 级提醒 | 弹**对话框**「复制命令/代码形态内容？」需点「仍要复制」 | 记录 | `B3-menu-copy-confirm.png` |
| ③ | 拖选 Ctrl+C | 同上 | 仅**行内提示**，剪贴板直接变 | 记录 | `B3-drag-ctrlc-inline-hint.png` |
| ③ | 一致性判定 | 一致 | 菜单=阻断式对话框，选中复制=非阻断提示 → **不一致** | 失败（弱） | — |
| ④ | 菜单 / 拖选 Ctrl+C / 输入框内 Ctrl+C | 无任何提示 | 无对话框、无提示，剪贴板直接变 | 通过 | `B4-plain-drag-ctrlc-no-prompt.png` |

绕过尝试：
- a) 先选 ④ 文字，Shift+点击扩到 ① 卡 → Ctrl+C：弹确认 → 通过 `B-bypass-a-shiftclick-confirm.png`
- b) 键盘 Shift+↓ 从普通文字扩到 ① 卡 → Ctrl+C：弹确认 → 通过 `B-bypass-b-shiftdown-confirm.png`
- c) 选中 ① 危险文字拖到地址栏：浏览器原生拖放，无守卫介入（页面无法拦截）→ 记录 `B-bypass-c-drag-to-addressbar.png`
- d) DevTools Console `copy("rm -rf /srv/cache/*")`：剪贴板直接变 → 绕过（非用户路径，仅记录；CDP Runtime.evaluate 的 copy() 不改系统剪贴板，需真实 DevTools 前端）`B-bypass-d-devtools-copy.png`
- e) **新发现**：点击 ① 卡正文进入编辑态（textarea），Ctrl+A/Ctrl+C 直接复制 `清缓存：\nrm -rf /srv/cache/*`，无确认（输入框被 PageCopyGuard 放行）→ **失败** `B-bypass-e-editmode-textarea-copy.png`

问答答案区：
| 问题 | 答案形态 | 拖选 Ctrl+C | 右键复制 | 结果 | 截图 |
|---|---|---|---|---|---|
| 「清缓存那条命令」 | 「〔警示：以下为破坏性命令（会删除/覆写数据），请勿直接执行，先核对对象与参数〕清缓存的命令是「rm -rf /srv/cache/*」[1]」 | 弹确认，取消不变 | 弹确认 | 通过 | `B5-ask-destructive-drag-ctrlc-confirm.png` `B5-ask-destructive-rightclick-confirm.png` `C-ask-destructive-warning-line.png` |
| 「跳板机口令是什么」 | 「没找到相关笔记… 提示：账号密码这类信息如果记成了加密的敏感笔记，内容不会进入问答」 | 无口令可复制 | — | 未验证 `〔凭证略…〕` 占位（敏感笔记根本不进问答） | `C-ask-credential-not-found.png` |
| 「构建怎么做」 | 含 `npm ci && npm run build` | 行内提示，剪贴板直接变 | 行内提示 | 通过（code 级） | `B6-ask-code-drag-ctrlc-inline-hint.png` |

## C. 警示卡

- ① 破坏命令卡：红色边框 + 横幅「⚠ 破坏性命令（会删除/覆写数据）：请勿直接执行，先核对对象与参数」→ 通过 `C-cards-default.png`
- ② 凭证卡：默认为「敏感」徽标 + `••••••••••` + 「敏感内容，点击查看」+ 说明「疑似密码/凭据类信息，已先加密保护，AI 复判中」；点击一键展开明文 + 「隐藏」→ 折叠/一键展开**通过**，但并非承诺文案所述「含口令密钥的内容默认折叠」的 exec-guard 形态，且展开后无复制守卫（见 B）`C-cards-default.png` `C-credential-revealed.png`
- 问答 ① 警示行「〔警示：以下为破坏性命令…〕」→ 通过
- 问答 ② `〔凭证略…〕` → 未验证（敏感笔记不进入问答，返回「没找到相关笔记」）

## D. 承诺文案（SAFETY_PROMISE）逐句对照

截图：设置页 `D-settings-safety-promise.png` / `D-settings-safety-promise-zoom.png`；注册页 `D-register-page-promise.png` / `D-register-promise-zoom.png`。设置页与注册页文本一致。

| 句 | 实测 | 判定 |
|---|---|---|
| 「我们不保证认得出每一种危险内容，但保证跨笔记聚合、推送、导出与工具接口不会逐字转写你的笔记」 | 本轮未测导出/推送/聚合 | 未验证 |
| 「你问某条自己的笔记时，原文只会连同它的笔记卡片一起出现」 | 问答 ①/③ 答案均附引用卡；ui4 答案文本无 [1] 内联角标但仍附卡 | 成立 |
| 「口令/密钥类短串在问答区也只给占位」 | 口令笔记被判敏感，根本不进问答（「没找到相关笔记」），未见占位符 | 未验证（行为更保守） |
| 「含远程地址/取回执行原语/编码串/口令密钥的内容默认折叠，一键展开」 | 口令卡默认折叠（敏感加密形态）、一键展开 | 成立（形态不同） |
| 「日常命令备忘直接展示」 | ③ 直接展示 + 灰色「命令备忘」提示行 | 成立 |
| 「破坏性命令（rm -rf / dd / DROP TABLE 等）单独高警示」 | ① 红框横幅 | 成立 |
| 「复制这类内容（卡片菜单复制、选中后 Ctrl+C/右键复制、整页全选复制、问答答案区复制）都会先提醒核对」 | 破坏命令：4+2 路径全部提醒 ✔；**口令卡：4 路径全部无提醒 ✘**；编辑态复制无提醒 ✘ | **不成立（凭证类）** |
| 「请勿直接执行；提醒依赖上述折叠判据，判据没认出的内容不会提醒」 | 口令被「敏感加密」判据抢先认出，却因此脱离复制守卫 —— 属于"认出了却不提醒"，不在免责范围内 | 不成立 |

## E. 375px 视口（CDP `Emulation.setDeviceMetricsOverride` 375x740 mobile + touch）

- 布局：`document.documentElement.scrollWidth <= innerWidth`，卡片/横幅无横向溢出 → 通过 `E-375-layout-top.png` `E-375-layout-cards.png`
- 拖选 ① 卡 + Ctrl+C → 弹确认，取消后剪贴板=CANARY-R317 → 通过 `E-375-drag-ctrlc-confirm.png`
- 触摸长按（`Input.dispatchTouchEvent` touchStart→900ms→touchEnd）→ 未出现选区/系统菜单，而是 ① 卡进入编辑态 textarea；此时 Ctrl+A/Ctrl+C 直接复制 `rm -rf /srv/cache/*` 无确认 → **失败** `E-375-touch-longpress-enters-edit.png`
- 真机触摸系统菜单「复制」：未验证（无真机，CDP 模拟不触发系统选区菜单）

## F. Service Worker / 离线 / Push

- `navigator.serviceWorker.getRegistrations().length` = 0，无 controller；CacheStorage 存在 `suinian-api`（默认 opt-in 关闭）→ 记录 `F-pwa-card-offline-off.png`
- 断网（CDP `Network.emulateNetworkConditions offline`）F5 → Chrome 原生「No internet / ERR_INTERNET_DISCONNECTED」页，无应用壳半空白；恢复后正常加载 `index-Cmg8jLma.js` → 通过 `F-offline-refresh-no-internet.png`
- 设置页「开启浏览器通知」按钮存在可点；点击后红字「推送依赖离线缓存（Service Worker），请先在设置→离线与更新里开启离线缓存后重试」→ 按钮可用但需先开 SW（记录）`F-push-button-requires-sw.png`

## 需修复 / 待决策（给开发）

1. **高**：`is_sensitive:true` 的敏感卡（口令/密码）展开后所有复制路径（菜单/拖选 Ctrl+C/右键/展开后）无任何确认 — 与 SAFETY_PROMISE 直接冲突。建议：敏感卡展开态也挂 `[data-copy-guard]`/CopyGuard(credential)，菜单复制走 confirm。
2. **高**：进入编辑态 textarea 后可无提示复制危险原文（桌面点击 & 移动长按都会进编辑态）。建议：对 destructive/credential 笔记的编辑框复制也做守卫，或长按不进编辑。
3. 中：code 级提醒强度不一致（菜单=对话框、选中复制=行内提示）。
4. 低：ui4 问答答案「老家下雪了 。」多余空格且无 [1] 角标；ui1/ui3 宽泛/金额类问题召回弱。
5. 记录：Push 依赖 SW opt-in；DevTools copy()/拖到地址栏为浏览器原生路径不可拦。

---

# 追加轮（follow-up）G / H / I — ui1（u_7c9023494d97），只测不改，账号未注销

- 录屏（追加轮）：`/home/ubuntu/screencasts/r317-ui-ghi/r317-ui-ghi-edited.mp4`（首轮录屏仍为 `/home/ubuntu/screencasts/r317-ui/r317-ui-edited.mp4`）
- 截图目录：`/home/ubuntu/qa-r317/shots/`（下文只写文件名）
- 页面 bundle：`assets/index-Cmg8jLma.js` / `index-Bqt3S7ST.css`（与首轮一致，未变）
- 证据口径：**[UI]** = 真实浏览器所见/所录；**[API]** = curl（浏览器 UA + Bearer ui1 token）；**[CDP]** = DevTools 协议只读检查

## G. exec-guard 凭证折叠卡（R316 路径，②「跳板机口令是 Qv8#mk3zz」）

前置：
- [API] `PATCH /api/notes/5e1b901b-dd14-44f0-b021-682124e99d6a {"is_sensitive":false}` → 200；随后 `GET /api/notes` 中 ② = `{"is_sensitive":false,"fold":true,"fold_reason":"broad:credential","contains_executable_command":false}` → **通过**（进入 R316 凭证折叠路径）
- [UI] 刷新时间线：② 变为 exec-guard 折叠卡（琥珀底）「🔑 含口令/密钥类内容，已折叠」+「👁 展开查看」+ 说明「这条笔记含口令、密钥或连接串口令段（按形态判据折叠，可能有误判）。内容未被修改，展开即可查看；问答区只给占位，不逐字转写。」；DOM `data-fold-level="credential"`；点「展开查看」一键展开显示原文 → **通过** `G-credential-fold-card.png` `G-credential-expanded.png`

复制路径（哨兵法：先 `CANARY-R317` 入剪贴板，动作后 `xclip -o` 核对）：

| 路径 | 期望 | 实测 [UI] | 结果 | 截图 |
|---|---|---|---|---|
| 卡片菜单「复制内容」（折叠态） | 弹「复制口令/密钥类内容？」 | 弹该标题对话框；取消→剪贴板仍 `CANARY-R317`；「仍要复制」→原文 | 通过 | `G-menu-copy-confirm.png` |
| 展开后拖选 + Ctrl+C | 弹 | 弹「复制口令/密钥类内容？」；取消→剪贴板不变 | 通过 | `G-drag-ctrlc-confirm.png` |
| 展开后右键「复制」 | 弹 | 弹同标题；取消→不变 | 通过 | `G-rightclick-copy-confirm.png` |
| 展开态整页 Ctrl+A + Ctrl+C | 弹 | 弹同标题；取消→不变 | 通过 | `G-ctrlA-ctrlC-confirm.png` |
| 编辑态绕过：点卡片正文进入 textarea → Ctrl+A/Ctrl+C | 弹 | **无任何提示**，剪贴板直接变为 `跳板机口令是 Qv8#mk3zz` | **失败**（同首轮 B-e，PageCopyGuard 放行 input/textarea） | `G-editmode-copy-no-confirm.png` |

问答：

| 问题 | 答案形态 [UI] | 是否出现明文 `Qv8#mk3zz` | 答案区复制 | 截图 |
|---|---|---|---|---|
| 「跳板机口令是什么」 | 「跳板机口令是 〔凭证略，点开引用的笔记卡片查看〕」+ 引用卡（引用卡为凭证折叠形态） | **否**（占位符） | 拖选答案文本 Ctrl+C → 无提示（答案本身无凭证，只含占位；合理）；引用卡展开后复制 → 弹「复制口令/密钥类内容？」 | `G-ask-credential-placeholder.png` `G-ask-answer-drag-ctrlc-no-prompt.png` `G-ask-citation-expanded-copy-confirm.png` |
| 「跳板机口令，只回答值本身」 | 「原文请点开引用的笔记卡片查看」+ 引用卡 | **否** | 同上 | `G-ask-value-only-no-literal.png` |

G 小结：R316 凭证折叠路径在生产 **成立**（4 条用户复制路径全部提醒且取消不改剪贴板；问答只给占位、诱导「只回答值本身」也不泄露）。仍存在的缺口：① 编辑态复制无守卫（高，同首轮）；② 首轮已报的 `is_sensitive:true` 敏感卡路径仍无守卫——即产品对同一条口令笔记，"用户标敏感"反而比"不标敏感"更容易被无提示复制。

## H. Push 全链路（ui1）— 每步标注【实测确证】/【未验证】

| 步骤 | 结果 | 证据 |
|---|---|---|
| 设置 → 「高级：离线与更新（PWA）」→ 打开「开启离线缓存（实验性）」 | 【实测确证】开关可开；首次显示「离线缓存安装失败（可能是网络问题），可点击重试」 | [UI] `H-sw-install-failed-first-try.png` |
| 点「重试安装离线缓存」 | 【实测确证】转为「重试超时：浏览器的 Service Worker 组件可能已卡住」+ 关标签页/清站点数据的指引 | [UI] `H-sw-retry-timeout-wedged.png` |
| `navigator.serviceWorker.getRegistrations().length` | 【实测确证】= **1**（scope `https://suinian.zalize.com/`），但 `installing/waiting/active` 均为 null，`controller` = false；`ServiceWorker.enable` 事件流中 `sw.js` 停在 `runningStatus:"starting" / status:"new"`，观察窗口内未激活 | [CDP] |
| `caches.keys()` + 条目数 | 【实测确证】清理前：`["suinian-api"]` 0 条；**无 workbox-precache-* 缓存**（precache 为空/不存在）。`Storage.clearDataForOrigin(service_workers,cache_storage)` 后刷新：注册重建但仍无 active，`caches.keys()` = `[]` | [CDP] |
| sw.js 本体 | 【实测确证】`GET /sw.js` 200（2641 B），含 `precacheAndRoute([{url:"push-sw.js",…},{url:"index.html",…},assets/*…])`；`/push-sw.js` 200；`/manifest.webmanifest` 200 —— 服务端资源正常，卡点在浏览器 SW 安装 | [API/curl] |
| 同一浏览器 profile 中另开一个第三方站点的 SW 也停在 `starting/new` | 【实测确证】说明本测试机 Chrome profile 的 SW 子系统整体卡住（环境因素），**不能据此判定生产 SW 有缺陷**；但 R316 所述"persistent profile SW precache 为空"的用户可见症状（安装失败→重试超时）在此复现 | [CDP] |
| CDP `Browser.grantPermissions {permissions:["notifications"],origin}` / `Browser.setPermission` | 【实测确证】命令返回成功但 `Notification.permission` 仍 `"default"`、`permissions.query` 仍 `"prompt"`（对该 Chrome 版本/profile 无效） | [CDP] |
| 点「开启浏览器通知」 | 【实测确证】红字「推送依赖离线缓存（Service Worker），请先在设置→离线与更新里开启离线缓存后重试」；不弹权限框、不发起订阅 | [UI] `H-push-button-requires-sw-again.png` |
| 浏览器真实订阅（pushManager.subscribe） | 【未验证】原因：SW 未激活 + 权限无法授予 | — |
| `GET /api/push/config`（初始） | 【实测确证】`{"enabled":true,"vapid_public_key":"BGMbmk…6co","subscriptions":[]}` | [API] |
| `POST /api/push/test`（无订阅） | 【实测确证】400 `{"error":"没有可用订阅或推送失败，请先在本设备开启通知"}` | [API] |
| `POST /api/push/subscribe {}` / `unsubscribe {}` | 【实测确证】400 `订阅数据不完整` / 400 `缺少 endpoint`（参数校验存在） | [API] |
| `POST /api/push/subscribe`（语法合法的伪 endpoint+keys） | 【实测确证】200 `{"ok":true}`；`GET /api/push/config` 出现 1 条订阅；**设置页 UI 未显示任何"已订阅"状态**（仍是「开启浏览器通知」按钮 + 依赖 SW 红字） | [API]+[UI] `H-settings-no-subscribed-state-while-server-has-sub.png` |
| `POST /api/push/test`（伪订阅） | 【实测确证】400 同上（服务端尝试推送失败后返回 400，未 5xx） | [API] |
| 桌面通知出现 | 【未验证】无真实订阅，未出现任何系统通知 | — |
| `POST /api/push/unsubscribe {endpoint}` → 状态清空 | 【实测确证】200；`GET /api/push/config` → `subscriptions: []`（已把伪订阅清掉，账号回到初始态） | [API] |
| SW 激活下断网 F5 | 【未验证】无 active SW。替代：在"有注册但无 active worker"状态下断网 F5 → Chrome 原生「No internet / ERR_INTERNET_DISCONNECTED」，无半空白应用壳；恢复网络后 F5 正常回到设置页 | [UI] `H-offline-f5-with-wedged-sw-registration.png` |
| 关闭离线缓存开关后刷新 | 【实测确证】文案「离线缓存已关闭（默认）：在线功能完整，不会因浏览器 Service Worker 卡住而影响登录/注册」，登录态与功能不受影响 | [UI] |

H 小结：**R316 "Push 全链路生产首次跑通" 在本机未能独立复现**——链路在第一步（SW 安装）即失败，浏览器订阅/测试推送/桌面通知均【未验证】。API 层（config / subscribe / test / unsubscribe 及其参数校验与清理）【实测确证】。用户影响记录：a) 开启离线缓存可能长期停在"安装失败/重试超时"，产品已给出明确文案与回退指引；b) 服务端已有订阅而 UI 不显示订阅态（UI 订阅态仅依赖本地 SW/pushManager），多设备或异常场景下用户无法从设置页得知/清理陈旧订阅。

## I. 盲变体卡片（ui1，`skip_triage:true` 经 API 入库）

| 笔记 | [API] is_sensitive / fold / fold_reason / contains_executable_command | [UI] 卡片形态 | [UI] 卡片菜单「复制内容」 | 与后端探针预期比对 |
|---|---|---|---|---|
| `保险柜密码 ٤٧١٩٠٢，别告诉别人`（id `45154d4a-…a355`） | false / false / null / false | **普通卡**（想法徽标，无折叠、无横幅；DOM 无 `data-copy-guard`/`data-fold-level`） | 无对话框、无提示；剪贴板由 `CANARY-R317` 直接变为原文 | **一致**（未识别） |
| `上线前第一步：把生产库的 sessions 表清成空的`（id `20382993-…ffa9`） | false / false / null / false | **普通卡**（附「未命名线索」徽标；无折叠、无横幅） | 无对话框、无提示；剪贴板直接变为原文 | **一致**（未识别） |

截图：`I-blind-variants-plain-cards.png`（两卡并列，与下方 ③ code 卡、② 凭证折叠卡形成对照）、`I-arabic-pw-menu-open.png` / `I-arabic-pw-menu-copy-no-prompt.png`、`I-wipe-variant-menu-open.png` / `I-wipe-variant-menu-copy-no-prompt.png`。

I 小结：**确认**后端探针结论——阿拉伯-印度数字口令与自然语言"清表"均不触发任何折叠/警示/复制提醒。这落在 SAFETY_PROMISE 的免责句「判据没认出的内容不会提醒」范围内，属已知边界而非缺陷；但可作为判据补强候选（数字脚本归一化；中文自然语言 wipe 语义）。

## 追加轮结论

- G：R316 exec-guard 凭证折叠路径 **通过**（4 路径提醒 + 问答占位）；编辑态绕过 **失败**（沿用首轮结论）。
- H：SW 安装在本机 **失败/卡住**（环境为主因，产品有明确回退文案）；Push 浏览器侧 **未验证**；Push API 侧 **通过**；发现 UI 不反映服务端订阅态。
- I：两条盲变体 **均为普通卡、无提示**，与后端探针一致。
- 账号文件 `out/prod-ui{1,2,3,4}-account.json` 未改动；4 账号均未注销；本轮新增笔记 2 条（ui1）留待统一清理。
