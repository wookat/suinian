# 碎念 Suinian · 交接上下文（handoff-context）

> 目的：换会话/换负责人时注入本文档即可接手。**每轮迭代结束时更新本文档**。
> 最后更新：2026-08-13（R94）

## 一句话
开源可自部署的 AI 收件箱：微信/Web/Android/浏览器剪藏/MCP 什么都能丢，AI 自动分拣（想法/待办/收藏/资料）、把碎片聚成思考线索，每周一出周报、每天出今日回顾。

## 仓库结构
| 目录 | 内容 | 构建/测试 |
|---|---|---|
| `backend/` | Cloudflare Workers (Hono + D1 + R2 + Workers AI)，全部 API 与 cron | `npm ci && npx tsc --noEmit && npm test`（vitest，300+ 用例） |
| `web/` | React + Vite + Tailwind v4 + shadcn/ui，PWA | `npm ci && npm run build` |
| `android/` | Kotlin + Jetpack Compose + Material 3，minSdk 26 | `./gradlew assembleDebug testDebugUnitTest`（需 ANDROID_HOME） |
| `extension/` | 浏览器剪藏扩展（WXT，MV3，Chrome/Edge） | `npm ci && npm run build`（产物 `.output/chrome-mv3/`） |
| `mcp/` | MCP server（远程 + stdio），Claude/Cursor/Codex 直连 | `docs/mcp.md` |
| `skill/` | 微信 ClawBot bridge + ClawHub skill | `skill/README.md` |
| `docs/` | SPEC、自部署、导入迁移、图谱设计等 | — |

## 线上资源（生产）
- **API**：https://suinian-api.zalize.com （worker `suinian-api`）
- **Web**：https://suinian.zalize.com （Pages 项目 `suinian`，deploy 必须 `--branch main`）
- Cloudflare 账号 ID 见密钥库（`CLOUDFLARE_ACCOUNT_ID`）；worker 部署用 secret `CLOUDFLARE_WORKERS_API_TOKEN`，Pages 用 `CLOUDFLARE_GLOBAL_API_TOKEN`（zone routes 报错可忽略）
- D1 数据库 `suinian`（迁移 `backend/migrations/`，remote 用 `npx wrangler d1 migrations apply suinian --remote`）
- R2 桶 `suinian-media`（媒体/文件原件）；Workers AI（bge-m3 嵌入）；Vectorize 未启用（D1 暴力余弦兜底）
- Worker secrets：`DEEPSEEK_API_KEY`（分拣/摘要/问答）、`SUINIAN_ENC_KEY`（敏感内容 AES-256-GCM）、`ADMIN_TOKEN`（admin 端点）
- cron（wrangler.toml）：周一 00:00 UTC 周报；每月 1 日 00:00 UTC 月报；每日 20:00 UTC 今日回顾+线索重整；每 10 分钟 兜底补处理（重分拣/链接抓取/嵌入/图谱）
- GitHub Actions 因账号付款问题**不运行**，交付前本地全量测试即可（汇报注明）

## 能力清单（R39–R51 增量；更早见 docs/SPEC.md 与 git log）
- R39：注册幂等+明确报错、回顾兜底与 sweep 统计、admin 手动触发、编辑后标题重算、批量"全部匹配"、bridge `!`/`#tag`/help 指令
- R40：浏览器剪藏扩展（extension/）、记账收支+月报
- R41：MCP server（mcp/，远程 + stdio）
- R42：自部署体验（setup.sh、wrangler dev、mock AI、CORS、贡献者文档）
- R44：Web 速记框内联指令、回顾 cron 心跳表（`cron_heartbeats`）、报告口径统一、SEO、Cubox 倒计时
- R45：Android 对齐 R39-R44（记账展示、月报切换、内联指令、批量全选、帮助页）
- R46：线索/图谱体验打磨、每日回顾落库复查与降级放宽、重聚补强
- R47：Agent 玩法（回顾洞察技能化、问答写回闭环、待办提醒与推送偏好 `user_preferences`）
- R49：注销级联修复（user_preferences/daily_reviews）、增量聚类移碎片后旧线索 reconcile
- R50：全量备份导出（zip 含媒体）+ 备份恢复导入 + cron 心跳复查
- R51：390px 图谱标签避让（fitView 计入标签宽度）、剪藏快捷键实测、Android 今日回顾有内容态实测、标签改名/删除后首页自动刷新、心跳闭环证据、本文档
- R53：敏感笔记界面侧遮罩全覆盖、Chrome Issues 面板告警根因修复
- R54：ask 评测集（backend/scripts/ask-eval.ts，golden+holdout）、时间范围召回过滤、诚实「没找到」带相近建议
- R85：微信接入普通用户化——公众号官方回调 `/wechat/mp`（验签+AES 安全模式）、6 位绑定码流程（设置页「微信绑定」）、文字/链接/图片/语音入库走现有管线；`WECHAT_MP_TOKEN` 未配置时整体关闭；路线对比与配置指南 docs/wechat-integration.md；iLink bridge 保留给自部署极客
- R88：用户研究（R87）6 角色发现的 P0/P1 修复——①待办时区：`user_preferences.tz`（migration 0019）+ web 自动 syncTimezone，分拣按用户时区理解相对时间（跨时区回归 backend/test/r88-timezone.test.ts）；②问答可靠性：chatComplete 对 429/5xx/网络错误重试一次，/api/ask 失败返回 503+可读中文+retryable，web ask 自动重试+重试按钮；③冷启动：交互式 embed 8s 超时降级关键词召回；④连发：速记框提交即清空+并发保存计数，失败内容退回；⑤标签污染：分拣 prompt 不硬套已有标签；⑥数字召回：关键词/答案 prompt 保留并直给原始数字（禁 hedge），eval 新增 num1+q57-59；⑦微信设置未配置显示「即将开放」。线上回归 8/8 过，ask-eval 57/59 (97%)（PR #103）
- R89：R88 遗留清理——①全站时间戳按本地时区显示：web `parseServerTime`（lib/utils.ts，无偏移 SQL 时间一律按 UTC 解析），formatTime/时间流 dayLabel/线索 timelineDate/今日回顾 noteDateLabel 均改用（周报/月报/回收站/设置页本就正确）；②问答历史按账号隔离：localStorage key `suinian-ask-chat-v2:<apiBase|token FNV 指纹>`，旧 v1 共享 key 读到即删；③多选栏新增「移除标签」（chip 选已有标签或手输，支持全部匹配，带撤销只补回原有该标签的笔记）。线上回归（Asia/Shanghai）全过，ask-eval 57/59 (97%)
- R91：全量线上评审（只测不改）——R88–R90 全部回归 PASS、安全抽查过、注销级联 14 表清零、Lighthouse 桌面 100/100/100/100、体验评分 记录4.9/整理4.9/找回4.9/首次4.8；无 P0/P1，P2 观察见 qa-report-r91.md；顺手清理了上轮遗留账号 `[QA-R88]-repro`
- R92：大语料敏感隔离专项验证（生产 102 条语料含 12 条敏感，8 个隔离面——图谱/线索/回顾/周报/洞察/问答/嵌入/默认导出——全部 0 泄漏且阳性对照成立，报告 qa-report-r92.md；月报未覆盖）+ 注册页密码不一致字段级红框/内联提示 + 【排查】[QA-R88]-repro 残留系会话未执行注销非接口缺陷；生产 ADMIN_TOKEN 已轮换
- R94：AI 多 provider 降级链（R93 P0 DeepSeek 余额耗尽应对）——chatComplete 主模型失败自动 fallback 到 Workers AI llama-3.3-70b（`AI_FALLBACK_MODEL` 可换/`none` 关闭，每次先试主模型→充值后自动回主）；`GET /health?probe=ai` 探针（primary/fallback/503）；兑底 cron 扫 `needs_retriage`，pending 超 1h 落 FALLBACK_TRIAGE+标记；前端 pending 超 10min 显示「分拣延迟」；删除文案修正；注销改应用内确认（弃 window.prompt）。生产已删 AI_MODEL 手工覆盖，当前 provider=fallback；线上回归全过，ask-eval 42/44 (95%)、triage-eval category 21/21（todo_due 3/5，fallback 模型时区语义偏差）（PR #110）
- R114：落实 R113 审查（PR #133 audit-r113.md）——①财务合计意图以原始问题为准（改写只服务召回，带历史不再误走 fail-closed），时间范围同理优先原始问题；②检索强命中却拒答时去历史重试一次（仍拒答才诚实「没找到」），拒答判定补「没提到/未提及」措辞；③重复线索合并对 0.62-0.76 边界相似度加 LLM 同题确认（与聚类同一把关，直并阈值不降）；④wecomKfConfigured 补 WECOM_KF_SECRET、清空对话加确认弹窗、报告页提示同周期重复生成覆盖；eval 新增 q67-69（多轮财务/长历史数字召回）+ forbidAnswerContains 校验
- R130：落实 R129 审查（audit-r129.md）——①主题枚举精确路由（P1×2）：「我都存过哪些 X」类问题走关键词 LIKE 全量筛选（topicEnumIntent，与计数/财务精确路由同家族），精确总数+最多 50 条展示，敏感笔记只计数不露内容，0 命中回退语义召回；序数追问靠既有历史改写，不设序数状态实体；②财务口径澄清追问（P2）：上轮精确合计后问「包括 X 吗」直答 包括/不包括/部分包括 + 逐笔归因（financeClarifyTerms）；③FACT_QUERY_RE 补 哪几条/为什么/依据（q31 误路由计数 fail-closed 修复）；④导入可观测：图片超限 assets_dropped、2000 条截断 truncated 透出到 Web 完成文案；Notion CSV 同名行按 md 页计数去重不再误跳（P2-4）；⑤文案/视觉：Web 回收站操作后清理 pending-undo（P3-a）、标题正文完全相同只展示一次（P3-b）；Android 删除弹窗改 30 天可恢复（P2-b）、备份说明补默认脱敏口径（P2-c）、月报空态分段控件固定顶部（P3-c）、小组件加 initialLayout 占位避免「Can't load widget」（P3-d）；eval 新增 q87-q91（主题枚举/序数追问/财务澄清）
- R142：落实 R141 审查（audit-r141.md）——①Android 奇偶性（P1×2）：首页速记栏新增 麦克风录音（MediaRecorder AAC/m4a，上限 10 分钟对齐 Web，RECORD_AUDIO 运行时权限，停止后走 `/api/ingest/media type=audio` 既有 Whisper 转写管线）+ 相册选图（Photo Picker，免权限）+ 拍照（FileProvider `${applicationId}.fileprovider` + cache-path，TakePicture）→ 均复用既有 `sendImage/ingestMedia` 图片管线，读取/权限/超限/上传失败均有可见 toast；②Android 回收站：剩余天数改向上取整对齐 Web `Math.ceil`（刚删除即显示完整 30 天），首页顶栏新增一级「最近删除」入口（原设置页入口保留）；③分享失败可见化：ShareActivity 读取失败/超限/上传异常计入失败数并展示首个原因，混合成功/失败显示「N 条已上传，M 条失败：原因」；④flomo zip 导入（迁移承接卖点）：import-zip 新增 `parseFlomoZip`（memo 块解析 + 本地图片重写为【图片：名】并作为 ImportAsset 走既有 R2/attachments 管线，外链图剔除保留文字），`/api/import` source=flomo 接受 zip，Web 设置页文案与 accept 更新，测试 backend/test/import-zip.test.ts 新增 flomo 套件；⑤待办提醒补投（D-2）：sweepTodoReminders 全部投递失败时释放 `todo_reminded_at` 让下轮 cron 在 24h 回看窗内重试（任一成功仍至多一次；全部订阅 gone 回到无渠道语义），站内兜底=待办页已过期/今天分组（Web/Android 已有，无需新实体）；⑥聚类边界确认健壮化：deepseekPickNumber 改取回复中第一个整数（容忍「答案：3」「3.」等前缀，此前解析失败会放弃 0.62-0.76 边界并线索）；导入后聚类覆盖归因见「已知问题」
- R144：落实 R143 审查（audit-r143.md）——①P1-1 全端附件原件展示：notes/search/random 响应附带 `attachments`（仅 id/name/mime/size，不透出 r2_key/公链），`GET /api/notes/:id/file` 新增 `att=<附件id>` 选附件 + `inline=1` 仅对 image/audio/video 生效（Cache-Control: private, no-store，R2 保持私有）；Web note-card 图片缩略图+点击 lightbox、语音原生 `<audio>` 播放（web/src/components/note-media.tsx，blob 经 Bearer 鉴权拉取），Android NoteCard 对齐（NoteMedia.kt：BitmapFactory 缩略图+全屏 Dialog 预览、MediaPlayer 播放，OkHttp Bearer 拉流）；文件类沿用既有下载；敏感笔记 masked 分支不挂载媒体组件（不发请求不外显）；②P1-2 无密码找回：恢复码方案（16 字符 31 字母表去 0/O/1/I/L ≈79bit，拒绝采样无模偏差，PBKDF2 只存哈希，明文仅生成时展示一次）——migration 0024 `users.recovery_hash`，注册即发码，`POST /api/auth/recover`（限流 IP+账号、统一错误、成功即改密+轮换 token+换发新码防重放）、`POST /api/auth/recovery-code` 登录态重生成；Web 注册/找回一次性码卡片+设置页重生成，Android 登录页「找回」模式+一次性码弹窗+设置页重生成；③P2-2 图片描述 prompt 改一到两句；P2-3 Whisper 静音幻觉（"Thank you."/字幕 by 等短样板）过滤为 null；P2-4 /api/import query 传 source 给出参数用法提示；P2-1（敏感提示复合词漏提示）与 D-2（聚类口径/可能相关弱建议）评估后暂缓，论证见 PR
- R55：CJK 长问句 LLM 关键词抽取（extractAskKeywords，eval 28/28 全过）、ask 召回排除敏感笔记（含标题）、新手引导 4 步 tour（settings.tourSeen，仅新注册）、空态一键丢入 #示例 笔记+一键清除、周报提示词升级（主线/想法关联/悬而未决）

## Android/Web 功能奇偶性缺口计划（R129 清单，R130 评估）
- 今日回顾时间流卡片（Android 降级）：需新增 Compose 卡片 + `/api/reviews/today` 接入与点评交互，估 1 个子会话；与下方导出/导入合并一轮 Android 对齐专项更划算
- JSON/Markdown 导出（Android 缺失，仅备份 zip）：后端接口现成（`/api/export?format=json|md`），Android 需加设置页入口 + SAF 保存，低成本但非找回主线，并入对齐专项
- 多源导入（Android 仅备份 zip 恢复）：解析全在后端（/api/import），Android 只需文件选择器+源选择 UI；但大文件上传/流式进度需适配，工程量中，入对齐专项
- 上述三项建议合并为一轮「Android 对齐 R131+」专项（后端零改动，纯客户端）；R130 未动手，避免与本轮问答/导入改动互相干扰

## 已知问题 / 观察项
- GitHub Actions 不运行（账号付款问题）——所有验证本地做
- `daily_review:cron` 心跳：cron_heartbeats 表 2026-08-07 23:54 UTC 才在生产建表，首个常规 20:00 UTC 跑批在 2026-08-08；R51 已用一次性 cron 在生产验证写入正常
- Vectorize 未启用（个人量级 D1 余弦够用）；公众号/小红书正文抓取受反爬限制，有兜底
- 扩展未上架商店，开发者模式加载（extension/README.md）
- 【R89 观察】生产 `/api/notes/batch?stream=1` 偶发 40-60s 才返回——R90 已做撤销入口持久化覆盖慢请求场景；R91 回归未复现慢请求（10 条 ~2s），继续观察；内联 #tag 打标非 100% 保真（AI 分拣偶改标签）
- 【R92】敏感隔离大语料专项已验证全过（见 qa-report-r92.md）；月报隔离未覆盖（生产尚无月报周期数据），待有月报后抽查；`/api/graph`、`/api/insights` 非实际路由，图谱/洞察数据经线索详情与 /api/stats 验证

- 【R94/R134】DeepSeek 长期欠费停摆，生产主力=Workers AI（`/health?probe=ai` 报 `provider:"fallback"` 是常态基线而非降级，告警只看 `ok:false`，R134 口径已写入文档/代码注释）；DeepSeek 充值后无需改配置自动切回（每次调用先试第一链位），可用 `/health?probe=ai` 观察 provider 回到 primary；todo_due 在 Workers AI 下偶有时区语义偏差（切回后应消失，观察）

- 【R142 归因】导入后聚类覆盖率低（R141 观察 21 条仅 1 线索）：代码路径完备——导入即 `resetThreadBackfill` 重置游标，10 分钟 cron `backfillThreadClusters` 全量回扫（frugal：embedding 预筛 + 至多一次 LLM 边界确认）。低覆盖为设计内保守行为的叠加：a) 导入笔记先经异步分拣，仅 idea/collect 参与聚类（todo/记账/资料不参与）；b) 直并阈值 SIM_JOIN=0.76 较严，0.62-0.76 需 LLM 确认（此前确认回复带前缀会解析失败而放弃——R142 已健壮化，预期边界并线索率提升）；c) frugal 路径不走 DeepSeek 兜底。属「宁散勿错并」取向，非缺陷；R142 QA 用生产 flomo 样本导入实测覆盖率，后续轮次如仍偏低再评估阈值

## 等老板事项
- GitHub Actions 付款问题（恢复后 CI 才会跑）
- DeepSeek 账户充值（R94 已用 Workers AI fallback 恢复服务不阻塞；充值后自动回主）
- 扩展是否上架 Chrome Web Store（需开发者账号 $5）
- 微信 bot 实例长期托管方式（当前 skill/bridge 自托管）
- 【R85】公众号资源：注册公众号（个人订阅号即可起步）、提供 AppID/AppSecret、在公众号后台回填服务器配置（URL/Token/EncodingAESKey）；开发验证可微信扫码领测试号。清单见 docs/wechat-integration.md 第五节

## 测试约定
- 测试数据一律 `[QA-R88]`（按轮次改前缀），测完调 `DELETE /api/auth/me` 注销自清；**绝不动 u_boss 数据**
- QA 账号命名建议：用户名允许字符为中英文、数字、`._-[]`（2-32 字符，R60 起支持 `[]`）。建议 QA 账号命名 `[QA-R<轮次>]-<用途>`（如 `[QA-R60]-migrate-a`），**务必记录密码**，测完自助注销；若密码遗失需手动用 wrangler d1 按 `backend/src/account.ts` 的级联口径清理（children 先删，附前后 SQL 证据）
- **QA 账号清单核对（收尾强制步骤）**：每轮 QA 收尾时，除逐表验证自己账号级联清零外，必须再跑一次 `SELECT id, name FROM users` 全量核对，确认只剩 `u_boss / Thomas`；发现任何 `[QA-*]` 残留账号（如 R91 发现的 `[QA-R88]-repro`，系该轮会话未执行注销、非注销接口缺陷——账号所有 children 与 users 行均完整保留，说明 `DELETE /api/auth/me` 从未被调用），按 account.ts 级联口径手动清理（children 先删，附前后 SQL 证据）并在报告中注明
- 老板测试 token 由老板在会话中提供附件，勿写入仓库/日志
- admin 端点：`POST /api/admin/run-daily-reviews`、`POST /api/admin/reconcile-threads`（Bearer `ADMIN_TOKEN`）
