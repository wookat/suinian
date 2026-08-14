# audit-r121 — 碎念 Suinian 独立审查报告（R121 轮）

- 角色：独立评审官（审改分离，只审不改；本报告为唯一落库产物，未改任何产品代码、未部署）
- 对象：生产环境 https://suinian.zalize.com / https://suinian-api.zalize.com ，main @ `7772e79`（含 R120 #141）
- 方法：4 个独立 QA 账号 `[QA-R121]-main` / `-victim` / `-race` / `-pwa`（全部测毕注销并逐表 remote 核清，见附录 C）；新构对抗语料 40+ 条生产实测 + 浏览器录屏实测（PWA/离线/弱网）+ 源码走读 + D1 remote 只读核对。**全程未触碰 u_boss**。
- 证据分级：【生产实测】接口/浏览器一手观测；【D1 实查】远端库只读查询；【代码证据】仅走读源码未在生产验证；【未验证】明确标注。

## 一、总览与三环节评分

| 环节 | 评分 | 一句话结论 |
|---|---|---|
| 什么都能丢 | 8 / 10 | Web/API/MCP/导入/恢复入口都收得住，写入无静默丢数据；**扣分：离线写入没有队列与自动重发**，断网时"能丢"退化为"记住要重发一次"（§四）|
| AI 自动整理 | 7 / 10 | R120 transfer 三态对内转/提现/借入命中率高（13/15）；**扣分：入账型归还（"还给我了"）仍记 income、押金退回记 income、信用卡/花呗/白条还款记 expense 与"资金平移"口径自相矛盾**——本月合计里 85% 的"收入"与 72% 的"支出"不是真实收支（§三.2）|
| 可靠找回 | 8.5 / 10 | 精确聚合、引用出处、软删/恢复/彻底删除后派生数据（嵌入/线索/图谱/统计）完全一致（§六）；扣分：备份恢复入口把敏感元数据明文重新装回库并经列表/标签接口外泄（§五.1）|

核心主线「什么都能丢 → AI 整理 → 可靠找回」整体成立。本轮 2 个 P0 无、3 个 P1：**恢复入口绕过 R120 敏感洗净与写入期 fail-closed 预检**（安全）、**入账型归还/退款仍污染收支合计**（整理）、**离线捕获无队列**（能丢）。R120 四项修复本身经复核**均真实生效**，问题都出在"同一语义的另一个入口没跟上"。

## 二、R120 复核（重点 1）

### 2.1 敏感元数据 0 泄漏：8 条新构对抗语料逐出口验证【生产实测 + D1 实查】

新构 8 条含真实形态秘密值的语料（路由器密码、VPN 账密、OpenAI key、信用卡号+CVV+有效期、支付密码、阿里云 AK/SK、老家 wifi、邮箱密码），逐出口扫描秘密值原文：

| 出口 | 结果 |
|---|---|
| `GET /api/notes` 列表（title/tags/content） | ✅ 8/8 `title=null`、tags 只留主题词、content 为 `[加密内容]` |
| 关键词搜索 `?q=<秘密值>` | ✅ 0 命中原文 |
| `GET /api/tags` 标签云 | ✅ 无秘密值 |
| `GET /api/stats` / `GET /api/threads` / `GET /api/review/today` | ✅ 0 泄漏 |
| `GET /api/export`（默认脱敏 / markdown） | ✅ 全部 `[已加密内容]` |
| `GET /api/backup` zip（manifest/notes/threads/reports 全文逐字节扫描 62.6KB） | ✅ 0 泄漏 |
| MCP `search_notes`（含直接搜秘密值） | ✅ content/title 均 `[敏感内容已脱敏]`、tags 清空 |
| `POST /api/ask`（直接追问密码） | ✅ 拒答并只给"可能有 1 条敏感笔记匹配"提示 |
| **嵌入/图谱/线索派生层**【D1 实查】 | ✅ `note_embeddings`、`edges`、`entities`、`threads` 中敏感笔记 0 行、0 实体、`thread_id` 全 NULL |
| **存储层**【D1 实查】 | ✅ `content='[加密内容]'`、`content_enc='v1:...'`（AES-256-GCM）、`title=NULL` |

结论：R120 P1-1（敏感元数据洗净 + 存量修复）在**写入路径**上确实闭环，派生层与存储层同样干净，这是本轮最扎实的一处。**但恢复入口是缺口，见 §五.1（P1）。**

### 2.2 并发注册压测【生产实测】

- 同名同密码 5 并发 → 1 个 201 创建 + 4 个 200 幂等返回同一账号，**0 重复用户**；`idx_users_name_unique` 生效【D1 实查：`users` 无同名行】。
- 同名不同密码 3 并发 → 3 个 409 `NAME_TAKEN`，不泄漏"用户是否存在"以外的信息。
- 结论：R119 的并发重名缺陷已根治 ✅。

### 2.3 transfer 三态：15 条新构易混语料【生产实测】

| 语料（`[QA-R121]` 前缀） | 实际 | 判定 |
|---|---|---|
| 零钱通里的钱转到银行卡 600 / 支付宝余额宝里取出 3000 到工商银行卡 / 定期存款到期本金 30000 转回活期 | transfer | ✅ |
| 从公积金账户提取了 12000 到还房贷的卡里 / 券商账户转入 5 万准备打新 / 把年终奖里的 20000 挪去买了国债逆回购 | transfer | ✅ |
| 跟同事借了 200 块吃饭 / 借给小张 500 应急 / 我把 800 转给小李他下周还 | transfer | ✅ |
| 上次借小王的 1000 今天还给他了 / 妈妈把我借她的 5000 转回来了 | transfer | ✅ |
| 帮朋友代付了机票 1350，他微信转我了 | transfer | ✅ |
| 老板私下先垫给我 2000 差旅费，回来报销冲抵 | transfer | ✅（可辩，垫付会冲抵，净额为 0）|
| 周末桌游六人平摊 366，我先刷的卡 | expense **61** | ✅ AA 净额正确（R119 的 AA 算错已修）|
| **表弟把上次借的 1500 还给我了** | **income** | ❌ 与"妈妈把我借她的 5000 转回来了"同语义却判两态 |
| **房东退了押金 3500 到我微信** | **income** | ❌ 押金退回是资金平移，不是新收入 |
| **信用卡还款 4200（全部是上月消费）/ 花呗自动还款 1260 / 京东白条还款 780** | **expense ×3** | ⚠️ 见 §三.2（设计口径自相矛盾）|

R120 的 transfer 命中 13/15；`fixTransferMisfile` 的确定性兜底（`INTERNAL_TRANSFER_RE` / `BORROW_IN_RE`）【代码证据 triage.ts:288-297】覆盖"内转/提现/借入"，**但不覆盖"归还入账"（还给我/还回来/退回）**，而 `INCOME_DIRECTION_RE` 含 `给我|退了`【代码证据 triage.ts:283】会把这类主动判成 income——实测与代码一致。

### 2.4 首跑通知引导【生产实测（录屏）】

- 引导确实由 4 步扩到 5 步，第 5 步「开启每日回顾推送」文案清晰、导航正常、完成后刷新不再弹 ✅
- **❌ 缺兜底超时**：点击「开启」→ 浏览器权限弹窗出现 → 选择"允许"后，按钮永久 disabled + 转圈，既不出现绿字「已开启，每天早上见」也不出现红字错误。根因：`enablePush()` 里 `await navigator.serviceWorker.ready` 在 SW 未激活时**永不 settle**，`catch` 分支根本不会触发【代码证据 web/src/lib/push.ts:47 + first-run-tour.tsx:75-85】。首跑第一屏就卡死转圈，对新用户的第一印象伤害大。判 **P1**（§七）。

## 三、财务语义（重点：AI 整理）

### 3.1 合计口径【生产实测】

`POST /api/ask`「我这个月一共花了多少钱」返回：`支出 ¥8601、收入 ¥5900、结余 ¥-2701（另有 13 笔资金往来不计入合计）`——transfer 确实被 `reports.ts:117` 排除在合计外 ✅，口径与周/月报一致 ✅，文案主动交代了 transfer 笔数，诚实 ✅。

### 3.2 但合计里的钱大部分不是真实收支（P1）

同一份 15 条语料下：

- "收入 ¥5900" = 卖旧手机 900（真实）+ 表弟归还借款 1500（应 transfer）+ 押金退回 3500（应 transfer）→ **85% 虚增**
- "支出 ¥8601" = 房租 2300 + 桌游 61（真实）+ 信用卡还款 4200 + 花呗 1260 + 白条 780 → **72% 是"还款"**

前两项是明确缺陷（§2.3）。第三项是**设计口径矛盾**：prompt 一边定义 transfer 为"钱没有真正花掉"，一边显式规定「"还了信用卡 3000"仍是 expense（还款是钱出去给银行清偿消费）」【代码证据 triage.ts:135】。可信用卡/花呗/白条消费**在刷卡当时若已被记为 expense，还款再记一次就是重复计账**；若当时没记，那"支出"又依赖用户是否恰好记了刷卡那一条——同一笔钱记一次还是两次取决于用户的记录习惯，账本不可对账。反问「是否真的最适合」：更自洽的做法是把"信用卡/花呗/白条还款"归 transfer（负债结清＝资金平移），并在问答/月报里单列"负债还款"一行；若坚持记 expense，则必须在同一句里识别"这笔消费此前是否已记账"，而这在碎念的"随手丢"场景里不可实现。**建议改判 transfer**（设计建议 D1）。

## 四、PWA 离线与弱网（重点 3）【生产实测（录屏 + 截图）】

| 场景 | 结果 |
|---|---|
| manifest（碎念 Suinian / 碎念 / standalone / start_url `/` / 192+512+maskable） | ✅ |
| Service Worker `activated and is running`；设置页「离线可用：页面已缓存，断网也能打开」 | ✅ |
| Chrome 地址栏安装图标 | ✅ |
| 离线重载：应用仍可打开并渲染缓存时间流（NetworkFirst） | ✅ |
| 离线写入：**无静默丢数据**，内容退回输入框 + 红字「网络连接失败，请检查网络或 API 地址」 | ✅ |
| 离线刷新后草稿仍在（localStorage 草稿） | ✅ |
| **恢复网络后自动重试/同步** | ❌ **未实现**：全代码库无 `navigator.onLine` 监听、无离线写入队列、无 Background Sync【代码证据：web/src 全量检索仅命中线索作业的 `queued` 状态】；必须用户手动再回车一次 |
| 手动重发后落库（201）、刷新+搜索可查 | ✅ |
| 弱网（Slow 3G）问答：「正在思考…」加载态 → 约 15s 返回答案 + 引用 [1]，无白屏无死循环 | ✅ |
| 弱网写入：乐观清空 + spinner，落库并被分拣 | ✅ |
| 暗色模式 / 375px 窄屏 | ✅ 无对比断裂、无横向溢出、底部导航可用 |
| iOS 真机「添加到主屏幕」 | 【未验证】无 iOS 真机；iOS 提示文案受 UA 门控，桌面 Chrome 不渲染 |
| Android 真机安装/分享入口 | 【未验证】仅桌面 Chrome |

结论：**"离线可读"做到了，"离线可写"没有做到。** 详见设计质疑 D2（P1）。

## 五、安全渗透专项复审（重点 2）

### 5.1 【P1】备份恢复入口绕过 R120 敏感洗净与写入期 fail-closed 预检【生产实测】

构造一个"上一代备份"zip（notes.json 两条），用 `POST /api/backup/restore` 恢复到隔离账号，返回 `notes_imported:2`：

| 构造条目 | 恢复后的实际状态 | 泄漏出口 |
|---|---|---|
| ① `is_sensitive:true`，`title:"路由器密码 Zq9KtmLP4x77"`，`tags:["路由器","Blu3RainVpn8821"]` | content 被重新加密 ✅，**但 title 与 tags 明文原样入库** | `GET /api/notes` 返回 `title:"路由器密码 Zq9KtmLP4x77"`；`GET /api/tags` 返回 `{"tag":"Blu3RainVpn8821","count":1}`——**即 R120 P1-1 想关掉的那条元数据通道被重新打开**（MCP 与 /api/export 出口仍有独立脱敏，未泄漏）|
| ② 明显含凭据的 content，但 `is_sensitive:false` 且 `category:"data"`（非 NULL） | **永久明文入库**：写入路径的 fail-closed 预检（`maybeSensitive` → 立即加密）在恢复路径完全不存在；且因 `category` 非 NULL，cron retriage 的选取条件 `category IS NULL OR needs_retriage=1` 永不选中它【代码证据 index.ts:3316】——**永远不会被重新判敏** | 明文出现在 `GET /api/notes`、`GET /api/export`（默认脱敏导出里也是明文，因为兜底条件要求 `category===null`）、`GET /api/review/today`、`POST /api/ask` 答案正文、MCP `search_notes`，并会被写进嵌入与图谱 |

- 根因【代码证据 backend/src/backup.ts:416-486】：`restoreBackup` 直接 INSERT `title`/`tags`，既不调 `sanitizeSensitiveTags`、也不清 title，更不对 `is_sensitive:false` 的 content 跑 `maybeSensitive` 预检；`/api/import` 同样无预检，只是因为它把 `category` 写成 NULL 才被 cron retriage 兜住【代码证据 import.ts:405】。
- 现实触发面：**不需要攻击者**。任何用户恢复一份 R120 之前导出的备份（那时敏感笔记的 title/tags 就是明文密码），洗净成果立刻失效，且 0021 迁移是一次性存量修复、不会再跑。跨账号越权无（数据仍归本人），故不判 P0；但它直接推翻 R120 的"各出口 0 泄漏"结论，判 **P1**。
- 建议：恢复/导入两条入口复用写入路径的同一段 `applyTriage` 敏感口径（title 置空 + `sanitizeSensitiveTags` + `maybeSensitive` fail-closed 预加密），而不是各自实现一份——正是"如无必要勿增实体"的反面（详见 D3）。

### 5.2 鉴权 / IDOR / 注销后数据【生产实测】

| 项 | 结果 |
|---|---|
| 无 token / 畸形 `Authorization` / 无效 token / 篡改 1 字节的合法 token | 401 ×4 ✅ |
| token 放 query string（`?token=`/`?api_token=`） | 不认证 ✅ |
| 用户 token 打 `/api/admin/*` | 拒绝 ✅ |
| 跨账号 IDOR：GET/PATCH/DELETE/`/file`/`refetch-link`/`retry-media`/线索/报告 ×8 | 全部 404 或影响 0 行，不泄漏存在性 ✅ |
| 注销后（`DELETE /api/auth/me`）旧 token 打 me/notes/export/stats/threads/tags/backup/写入/ask ×9 | 401 ×9 ✅；原用户名密码重登 401 ✅ |
| 注销级联【D1 实查】 | 被注销账号在 notes/threads/entities/edges/note_embeddings/daily_reviews/user_preferences/users 全部 0 行；全库 `note_embeddings` 无孤儿行 ✅ |
| 级联清单完整性【代码证据 account.ts】 | `USER_ID_TABLES`+`NOTE_ID_TABLES` 已覆盖当前所有含 `user_id`/`note_id` 外键的表（`wecom_kf_state`/`auth_rate_limits` 非用户维度，无需清） ✅ |

### 5.3 【P1】写入限流只挡住了一个入口【生产实测】

- `POST /api/notes`：第 1-60 条 201，第 61 条起 429 ✅；换用同账号新轮换 token 仍 429（按 userId 计窗）✅
- **同一账号在 429 期间**：`POST /api/import`（3 条）**全部成功**、MCP `save_note`**成功**——【生产实测】
- 根因【代码证据 index.ts:1137 是唯一的 `note_write` 限流点】：`/api/import`、`/api/backup/restore`、`/mcp` 的 save、`/api/notes/batch`、`/api/ingest/media`、`/api/threads/rebuild`、`/api/reports/generate` 全部无限流，而这些入口同样会触发 AI 分拣/嵌入/图谱/线索管线。
- 该限流的自述目的是「bounds AI-quota abuse from a leaked token」【constants.ts:17】。一个泄漏 token 可以走 import 无限灌数据，**目的没有达成**——控制措施与其声称的威胁模型不匹配，判 **P1（成本/滥用面，不是数据泄漏）**。建议在中间件层按 userId 对"会触发 AI 管线的写入"统一计量（按条数而非按请求数），而不是逐个 handler 加。

### 5.4 SQL 注入面【生产实测】

`q` / `tag` / `category` / `date` / `cursor` / `tz` 六个入口注入 `' OR 1=1--`、`%'`、`") UNION SELECT`、`; DROP TABLE` 等 12 个探针：无 500、无结果集变宽、无跨账号数据；非法 cursor 返回 400。全部走 D1 预编译绑定【代码证据：检索 index.ts 无字符串拼接进 WHERE 的用户输入】✅

### 5.5 扩展出口【代码证据】

- **API token 存在 `browser.storage.sync`**【extension/utils/api.ts:12-27】：会随浏览器账号同步到 Google/Firefox 云端，明文。碎念 token **永久有效、单一、等价于全量读+全量销毁权**（`DELETE /api/auth/me` 只校验 token，无二次密码确认【代码证据 index.ts:816】）。设置页输入框用了 `type="password"` ✅，但存储位置抵消了这份小心。判 **P2**（建议 `storage.local` + 明示"此设备"语义），并见 D3。
- 扩展的 `CATEGORY_OPTIONS` / `Category` 仍是 6 类，**没有 transfer**【extension/utils/api.ts:29-38】；Android 的 `categories`/`CATEGORY_LABEL` 同样缺 transfer【NoteCard.kt:64-77、InsightsScreen.kt:57-66】，`categoryLabel()` 回落到原样返回，**Android 用户会在分类胶囊上看到英文 "transfer"**，且筛选器里没有该分类。R120 的第七态只落到 backend + web。判 **P2**（影响"AI 整理"的跨端一致体验）。

## 六、数据一致性抽查（重点 4）【生产实测 + D1 实查】

以一条 income 笔记（房租 2800）走全生命周期，每步都读 stats/搜索/问答/回收站/导出：

| 路径 | 统计 | 关键词+语义搜索 | 问答 | 回收站/导出 |
|---|---|---|---|---|
| 基线 | income 4、total 95 | 命中 | 引用该条 | — |
| 软删 `DELETE /api/notes/:id` | income 3、total 94 | 10→9 条且 0 命中 | 不再引用该条（改答其它房租笔记）| 回收站 1 条 ✅ / 导出不含 ✅ |
| 恢复 `POST /api/notes/restore` | income 4、total 95 | 重新命中（keyword+semantic 双通道）| 重新引用 ✅ | — |
| 彻底删除 `purge` | income 3、total 94 | 0 命中 | 不引用 ✅ | — |
| 派生数据【D1 实查】 | purge 后该 note 的 `note_embeddings` 0 行；全库 `note_embeddings`/`edges`/`attachments` 孤儿行 **0** | | | |
| 注销 | 见 §5.2，逐表 0 残留 ✅ | | | |
| 导入 / 备份恢复 | 落库、去重、时间保真均正常；**但恢复路径的敏感口径缺失见 §5.1** | | | |

结论：软删/恢复/彻底删除/注销四条路径的派生数据一致性**没有发现任何缺口**（这是 R117/R119 以来最干净的一次），嵌入在软删时会随查询过滤、purge 时被真删，线索计数随之收敛。

## 七、设计质疑：两处此前未审流程深挖

### D1（设计建议）「负债还款」缺一态，账本无法对账 —— 见 §3.2

现状：七态里 expense/income/transfer 三财务态，还款被硬性归 expense。反问"有没有更好的方式"：碎念的定位是"随手丢"，用户不可能保证刷卡当时也记了一条；把还款计 expense 意味着**同一笔钱被记 1 次还是 2 次取决于用户当时手快不快**。建议：`transfer` 明确吸收"信用卡/花呗/白条/分期还款"，问答与月报里单列一行"负债还款 ¥X（不计入支出）"。收益：合计口径变得可对账；代价：仅 prompt 判例 + 一条兜底正则，无新增实体。

### D2（P1）离线捕获链路：`localStorage` 草稿不是队列 —— 见 §四

现状：断网写入失败 → 内容退回输入框 + 存 localStorage 草稿；恢复网络无任何自动重发【生产实测 + 代码证据】。反问"是否真的最适合"：核心承诺第一句是"什么都能丢"，而移动 PWA 最典型的使用场景（地铁、电梯、地下车库）恰好是断网；此时产品把"记下来"的责任还给了用户——用户以为丢进去了，实际只有一条草稿，且**只能存最后一条**（再写第二条会覆盖/挤掉），刷新虽保留但换页面/关标签就没有稳定保证。这是三环节里唯一一处"核心承诺在最需要它的场景下失效"。建议：写入失败即入一个 IndexedDB 的 outbox（多条、带本地时间戳），`online` 事件与应用启动时各扫一次，服务端已有的"内容+created_at 去重"逻辑天然幂等，可直接复用；UI 上显示"N 条待同步"。收益远大于成本，且不需要 Background Sync API（iOS 不支持）。

### D3（设计建议）"多入口各写一份口径"是本轮所有安全/一致性缺陷的共同根因

把本轮四处缺陷并排看：敏感洗净（写入 ✅ / 恢复 ❌ / 导入 ⚠️）、transfer 七态（backend+web ✅ / 扩展 ❌ / Android ❌）、写入限流（`/api/notes` ✅ / import·MCP·restore ❌）、凭据面（web 有 rotate ✅ / 扩展存 storage.sync ❌）。它们不是四个独立 bug，而是**同一个结构问题**：入口（web/API/MCP/扩展/Android/导入/恢复）在增长，而"一条笔记进入系统时必须发生什么"（敏感预检 → 分类口径 → 配额计量）没有收敛成单一函数，每加一个入口就重抄一份，抄漏就成缺陷。反问"如无必要勿增实体"：真正该增的实体是**一个 `ingestNote(env, userId, payload, opts)` 收口函数**（现在的 `createNote` 已经很接近，只是 import/restore 绕开了它），真正该删的实体是各客户端自己维护的分类枚举（应由 `/api/meta/categories` 或共享包下发）。建议 R122 先做这一层收口，再谈新功能——否则每轮审查都会在新入口上重新发现同型问题（R117→R119→R121 已连续三轮）。

## 八、缺陷清单

| 级别 | 问题 | 影响核心主线 | 出处 |
|---|---|---|---|
| P1 | 备份恢复入口把敏感 title/tags 明文装回库并经列表/标签接口外泄；`is_sensitive:false` + `category` 非 NULL 的凭据明文永不复判 | 是（可靠找回的信任基础 / 隐私）| §5.1 |
| P1 | 入账型归还（"还给我了"）记 income、押金退回记 income，本月"收入"85% 虚增 | 是（AI 整理）| §2.3 §3.2 |
| P1 | 离线写入无队列、恢复网络不自动同步 | 是（什么都能丢）| §四 D2 |
| P1 | 首跑引导第 5 步「开启通知」在 SW 未激活时永久转圈（`serviceWorker.ready` 无超时兜底）| 否（但首屏体验伤害大）| §2.4 |
| P1 | 写入限流只挡 `POST /api/notes`，import/MCP/restore/batch 等入口无限流，未达成"限制泄漏 token 滥用 AI 配额"的既定目的 | 否（成本/滥用面）| §5.3 |
| P2 | 扩展 API token 存 `browser.storage.sync`（明文云同步）；token 永久有效、注销无二次凭据确认 | 否 | §5.5 |
| P2 | transfer 第七态未落到扩展与 Android：Android 分类胶囊显示英文 "transfer"、无该筛选项 | 否（跨端一致性）| §5.5 |
| 设计建议 D1 | 信用卡/花呗/白条还款应归 transfer 并在报表单列"负债还款" | 是（整理口径可对账）| §3.2 |
| 设计建议 D3 | 收口 `ingestNote` 单一入口 + 分类枚举由服务端下发，终结"多入口各抄一份口径" | 是（结构性）| D3 |

R120 四项修复复核结论：敏感元数据洗净 ✅ 真实生效（写入路径 + 存量 + 派生层）、注册唯一约束 ✅ 生效、transfer 三态 ✅ 主体生效（13/15，残留见 P1）、首跑通知引导 ⚠️ 生效但缺兜底。

## 附录 A：证据与复现

- 语料与探针脚本（仓库外，未落库）：`post.py`（写入+读回）、`leak.py`（8 秘密值 × 9 出口扫描）、`sec.py`（IDOR/SQLi）、`sec2.py`（备份 zip 逐字节 + MCP）、`rl.py`（限流与旁路）、`consist.py`（软删/恢复/purge 一致性）、`restore_test.py`（§5.1 恢复入口构造）、`logout.py`（注销后 9 接口）。
- 生产响应留存：`ev/restore_leak.json`（§5.1 五个出口原始响应）、`ev/main_final.json`（40+ 条语料的分类/金额/标签全量读回）。
- D1 只读核对：`wrangler d1 execute suinian --remote`（仅 SELECT）。
- 所有 §二/§三/§五/§六 结论均可用 `[QA-R121]` 前缀语料在新账号上复现（账号已注销）。

## 附录 B：录屏与截图

- 全程录屏（带 setup/test_start/assertion 标注）：`rec-ad6ff084-…-edited.mp4`（随汇报附送）
- 关键截图（随汇报附送）：离线写入报错 + 内容保留、离线刷新后草稿仍在、恢复网络手动重发落库、离线笔记刷新+搜索可查、弱网问答加载态、弱网问答答案带引用、弱网写入落库并分拣、设置页「离线可用」卡片、暗色时间流、375px 窄屏。
- 环境备注：Devin 托管 Chrome profile 的 SW 子系统本身异常（注册 promise 不 resolve），全部 PWA/离线结论已在全新 clean profile 复测。

## 附录 C：QA 自清核验

- 账号：`[QA-R121]-main`（u_37d460c4c674）、`-victim`（u_fade25abf3d6）、`-race`（u_33e5edb1743f）、`-pwa`（u_5b9d876c6bd1）全部经 `DELETE /api/auth/me` 注销（200），旧 token 复请求 401。
- 逐表 remote 核验【D1 实查】：`users` 仅剩 `u_boss / Thomas`；`notes` 仅 u_boss 6 行；`threads`/`entities`/`edges`/`daily_reviews`/`weekly_reports`/`user_preferences`/`thread_backfill` 非 boss 行均为 0；`note_embeddings` 孤儿行 0；`attachments` 0 行。
- `u_boss` 全程未读写；本轮未改任何产品代码、未部署。
