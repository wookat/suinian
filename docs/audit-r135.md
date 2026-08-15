# 碎念 Suinian — R135 独立审查报告

- 审查人：独立评审官（审改分离，只审不改；本 PR 仅落库报告与附录截图，未改任何产品代码，未部署）
- 审查对象：生产环境 https://suinian.zalize.com / https://suinian-api.zalize.com（main 最新，含 R134 #156）
- QA 约束：全程未触碰 `u_boss`；QA 使用独立新账号 `[QA-R135]-main`（主回归）、`[QA-R135]-restore`（备份恢复深挖）与一个临时 eval 账号（q12 全量 eval），测毕全部注销并逐表核清（附录 C）
- 证据口径：`[生产实测]` 真实 API/UI/扩展/MCP 调用；`[D1 实查]` Cloudflare D1 REST 远程查询；`[源码]` 代码级检查；`[一手竞品]` 竞品官网/官方更新日志原文。未验证的一律注明。

## 总评与三环节评分

| 环节 | 评分 | 依据 |
|---|---|---|
| 什么都能丢 | 8.5 / 10 | 扩展三种剪藏（整页文章/划词/图片）、MCP save、Web/PWA 离线队列全部收得住；敏感内容不论从哪个入口进来（扩展剪藏/MCP/Web）都走同一条加密管道。扣分：Web/PWA 端没有语音录入入口（P2-1）——宣传「语音都能丢」，但手机 PWA 上说不了话；演示模式里写的笔记注册后静默丢弃（P2-2） |
| AI 自动整理 | 9 / 10 | 扩展剪藏与 MCP 保存的笔记同样被自动分拣、打标签、串线索（Karpathy 文章剪藏与 MCP 笔记聚成「训练神经网络方法」线索）；「120 元两个人」不再自作主张按人头分摊；意图分类 20 变体边界 0 误触发 |
| 可靠找回 | 9 / 10 | q12 修复后全量 eval **59/60（98%）**、无漂移无自信错答；`raw_type` 语音/图片/文件召回逐项命中；敏感内容在 ask/搜索/MCP/备份四条出口全部只给密文占位；完整备份→新账号恢复 16/16 无损（含媒体原件与敏感重加密）。扣分：脱敏备份与明文备份文件名完全相同，用户拿到 zip 无法区分（D-1） |

核心主线「什么都能丢 → AI 整理 → 可靠找回」**成立，本轮无 P0/P1**。R134 的 5×P2 修复与 3 项设计建议全部真实生效（§一）。本轮：**0 个 P0、0 个 P1、3 个 P2、3 个设计建议**。

---

## 一、R134 复核 `[生产实测][D1 实查][源码]`

### 1.1 五项 P2 逐项实测

| # | R134 修复 | 本轮复测 | 结果 |
|---|---|---|---|
| 1 | `raw_type` 语音/图片/文件召回 | 上传语音（mp3）/图片/文件后问「我的语音里说了什么」等，逐项按 `raw_type` 命中原笔记 | ✅ |
| 2 | 「120 元两个人」不再按人头分摊 | 记「和同事吃饭花了 120 元，两个人」→ D1 `amount=120`（不再是 60） | ✅ |
| 3 | API 与 Web 周报默认周口径一致 | `POST /api/reports/generate` 空参与 Web「生成本周报告」同取当前周 | ✅ |
| 4 | 无推送订阅不消耗待办提醒状态 | 无订阅时到点待办 `todo_reminded_at` 保持 NULL；订阅后仍可提醒 `[D1 实查][源码 push.ts]` | ✅ |
| 5 | 用户偏好时区覆盖过期订阅时区 | `user_preferences.tz` 生效于每日推送/待办提醒（`loadUserTz` 两处调用）`[源码]`，订阅行 `tz=UTC` 不再劫持口径 | ✅ |

### 1.2 三项设计建议落地复核
- **D-1（盘点/想去的地方枚举边界）**：`ASK_ENUM_CUE_RE` 已加入「盘点」，分类 prompt 明确「想去的地方→topic=想去」`[源码 ask.ts]`；生产实测「盘点一下我记过的菜谱」「列一下我想去的地方」均走精确枚举 ✅
- **D-2（冷启动第一周线索/提示）**：新账号首页出现引导提示与示例线索占位，第一周体感改善 ✅
- **D-3（raw_type 元数据召回）**：语音/图片笔记卡片显示「语音转写/图片识别」来源徽标（`note-card.tsx RAW_TYPE_META`），ask 可按媒介类型限定召回 ✅

### 1.3 Workers AI 主力口径一致性
- `GET /health?probe=ai`：`ok:true, provider:fallback, model:workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast` `[生产实测]`
- 文档/告警口径一致：README 与告警只关注 `ok:false`；`provider` 表述链位而非质量，`fallback=Workers AI` 即正常基线——探针/文档/告警三处口径已统一，无 R133「主力已停摆但账面healthy」的错位 ✅

### 1.4 q12 修复防漂移
- 全量 ask-eval（60 问 16 类）生产重跑：**59/60（98%）**，q12（星尘项目关键决定）3/3 全引用命中；唯一失分 q31 为引用完备性抖动（答案正确），无自信错答，无枚举路由漂移（附录 B 日志）`[生产实测]`

## 二、剪藏扩展全流程回归 `[生产实测][D1 实查]`

真实 Chrome 加载 unpacked 扩展（`extension/` 本地构建，typecheck/build 全绿），配置生产 API + QA token：

- **整页文章剪藏**：Karpathy《A Recipe for Training Neural Networks》→ `source=extension, raw_type=link`，正文抽取、URL/标题保留，AI 分拣为收藏并与后续 MCP 笔记聚成「训练神经网络方法」线索 ✅
- **划词剪藏**：右键「保存划词到碎藏」选中文本入库，标签自动生成 ✅
- **图片剪藏**：图片入 R2、attachments 建行、OCR 提取走媒体管道 ✅
- **敏感一致性**：剪藏含「路由器管理密码 Adm1n@2026」的页面 → D1 `content=[加密内容]`、`content_enc` 非空、`is_sensitive=1`——扩展入口与 Web/MCP 共用同一条敏感管道 ✅
- **无效 token**：失败通知明确报授权错误，不静默丢数据 ✅

## 三、MCP 11 工具全测 `[生产实测][D1 实查]`

真实 Streamable HTTP 客户端（`@modelcontextprotocol/sdk` 1.30.0）连生产 `https://suinian-api.zalize.com/mcp`：

- 11 工具全部真实调用成功：`save_note / search_notes / ask / list_threads / get_thread / get_weekly_report / list_todos / complete_todo / set_todo_due / delete_note / restore_notes`（附录 B 日志）
- 待办闭环：save（自动抽出待办+日期）→ `set_todo_due` 改期 → `complete_todo` 完成 → `delete_note`/`restore_notes` 软删/恢复，D1 状态逐步对号 ✅
- 敏感一致性：MCP 保存「银行卡取款密码 991235」→ 加密入库；随后 `ask` 问密码只回「另有加密笔记」计数提示，明文绝不出库 ✅
- 意图路由一致：MCP `ask` 枚举/统计问法与 Web 同路由同口径 ✅
- 隔离与鉴权：删除不存在/他人笔记返回 404；无 token 连接直接拒绝 ✅
- **P2-3（文档漂移）**：`mcp/README.md` 只列 8 个工具，实际部署 11 个（缺 `set_todo_due / delete_note / restore_notes`）`[源码]`

## 四、竞品最新动向（近 2 个月，一手证据）`[一手竞品]`

| 竞品 | 最新动向（官网/官方日志原文） | 对碎念的启示 |
|---|---|---|
| flomo | flomo 101 官方页：**flomo Agent——读过你所有笔记的 AI 在微信里对话，回顾/思考/提醒并把讨论写回 flomo**；AI 记忆档案、认知地图、MCP 连接（Claude/ChatGPT 直接读写） | 微信内「对话式找回+写回」正是碎念微信 bot 的正面竞品；flomo 全平台有语音输入，碎念 Web/PWA 没有（P2-1）。碎念差异化仍在：敏感加密管道、自部署数据主权、线索叙事 |
| Cubox | 官方博客：**「Cubox is becoming more focused. We are phasing (out)…」**（收缩聚焦、速记 2027-05 停服）；Obsidian 官方插件上线 | 停服窗口是搬家红利期——碎念 onboarding 已内置「Cubox/flomo 三步搬完」入口，方向正确；建议在停服节点前加大导入引流 |
| Notion | What's New（2026-07/08）：External Agents（Claude/Cursor 进 Notion 任务板）、Custom Agent 触发器（会议纪要后自动跑）、Agents iOS App、模型选择器+scorecard | Notion 全面押注 agent 编排，走重协作/重工作流路线，与碎念「个人碎片→自动整理」不同赛道；但「音频上传→转写→摘要」（Upload audio to AI Meeting Notes）说明语音入口已是标配能力 |
| 得到 | 官网更新提示：新增 **AI学习圈**（精选课程内 AI 圈子学习） | 得到主线在课程内容+AI 学习社区，与个人笔记收集重叠度低；得到大脑的语音优先记录理念仍验证「说比打字快」的移动场景假设 |

**机会点小结**：① 移动语音输入是 flomo/得到已交付、Notion 已标配、碎念缺席的能力（P2-1）；② Cubox 收缩期的导入引流窗口约到 2027-05；③ 碎念的敏感加密+自部署主权在四家竞品中仍是独有卖点，值得在 onboarding/官网继续放大。

## 五、移动端 PWA 全流程复检（390×844 iPhone 尺寸）`[生产实测]`

- **可安装性**：manifest（name/icons/display=standalone/theme_color）齐全，service worker 注册激活，Chrome 判定可安装 ✅
- **离线队列**：断网提交笔记 → 队列指示（待同步）出现，笔记本地暂存（附录截图 r135-pwa-offline-queue.png）✅
- **重连自动同步**：恢复网络后队列自动上行，D1 出现该笔记（r135-pwa-online-sync.png）✅
- **浏览器通知**：设置页「开启浏览器通知」→ `push_subscriptions` 建行 `[D1 实查]`；「发送测试推送」→ 页面确认「测试推送已发出」（r135-settings-testpush.png）。**保留意见**：系统通知弹窗的最终送达未截获（无头环境限制），送达链路以 R133 已验证口径为准
- **语音输入**：Web/PWA 界面无任何录音控件（无 MediaRecorder/getUserMedia 调用）`[源码]`——语音只能经微信通道或 API 上传进来。**在手机 PWA 场景下「什么都能丢」缺了嘴** → P2-1
- 真机（实体 iPhone）未测，仅模拟尺寸口径，如实注明未验证

## 六、设计质疑：两个未审过的流程深挖

### 6.1 完整备份 → 新账号恢复（无损搬家承诺）`[生产实测][D1 实查][源码]`
- 默认（脱敏）备份：敏感笔记正文/标题=占位符、标签清空、派生明文（转写/摘要/url_title）全部不出境、附件原件不打包——R126 P1 闭环仍然成立 ✅
- `include_sensitive=true`：明文导出、附件打包 ✅
- 恢复到 `[QA-R135]-restore` 新账号：**16/16 笔记 + 1 媒体全部导入**；敏感明文不信任 zip 里的定论、重新走统一敏感管道并重加密（`prepareNoteInsert`，R122/R124 收口）`[D1 实查：恢复后 is_sensitive=1 且 content_enc 非空]` ✅
- 重复恢复幂等：二次上传（脱敏包）→ 13 条去重跳过、3 条敏感壳显式 `sensitive_skipped`（不静默导入丢明文的壳笔记）✅
- **D-1（本轮新）**：两种备份 zip 文件名完全相同（`suinian-backup-YYYY-MM-DD.zip`），manifest 里才有 `include_sensitive` 标记。用户桌面上放两个包无法肉眼区分哪个含明文密码——建议明文包文件名加 `-full`/`-含敏感` 后缀，属一行改动的安全可用性收益
- 反复自问「是否真的最适合」：恢复不信任外来 zip 的 `is_sensitive:false`、敏感壳跳过并显式计数、单文件流式解压限额——这三处防御设计都经得起推敲，**这是本轮审到的设计质量最高的流程**

### 6.2 演示模式 → 注册转正（新用户黄金路径）`[生产实测][源码]`
- 首访 onboarding 四选项（演示/注册/token/搬家）信息架构清晰，Cubox 停服倒计时的搬家入口是好设计（r135-onboarding-fresh.png）✅
- **P2-2**：演示模式下用户写的真笔记存在 `localStorage(suinian.mock.notes.v2)`；点「注册新账号」后 `useMock:false`，这些笔记**静默滞留在本地永不上云**——注册页（r135-auth-no-migration.png）没有任何「演示期间写的 N 条笔记不会带过来」的提示或一键迁移。实测演示模式写入「会议室门禁码 4521」后注册流程零提醒。对一个承诺「什么都能丢→可靠找回」的产品，新用户第一条真实记录丢在演示沙盒里是主线级反差
- **D-2**：建议注册成功后检测 `MOCK_KEY` 中用户新增（非 seed）的条目，弹「把演示期间写的 N 条笔记搬进新账号？」一键迁移；成本低（客户端 diff seed id + 批量 POST），收益直接命中新用户留存
- **D-3**：演示模式敏感演示笔记以明文存 localStorage（演示数据无妨，但若用户在演示模式写真密码则明文落盘）——迁移提示同时解决此暴露面

## 七、问题分级汇总

| 级别 | 编号 | 问题 | 影响核心主线 |
|---|---|---|---|
| P2 | P2-1 | Web/PWA 无语音输入入口，「语音都能丢」在手机 PWA 上不成立（竞品 flomo/得到均有） | 是（什么都能丢·移动端） |
| P2 | P2-2 | 演示模式笔记注册后静默滞留 localStorage，无迁移/无提示 | 是（什么都能丢·新用户首条记录） |
| P2 | P2-3 | `mcp/README.md` 工具清单落后部署（8 vs 11） | 否（文档） |
| 设计建议 | D-1 | 明文/脱敏备份 zip 文件名无区分 | 否（安全可用性） |
| 设计建议 | D-2 | 注册时一键迁移演示期笔记 | 是（间接） |
| 设计建议 | D-3 | 演示模式明文 localStorage 暴露面随 D-2 一并收口 | 否 |

## 八、附录

### A：本轮已验证 / 未验证清单
- 已验证：R134 5×P2 + 3×设计建议、Workers AI 口径、q12 eval 59/60、扩展三剪藏+敏感+无效 token、MCP 11 工具+敏感+鉴权隔离、PWA 安装/离线/重连/订阅、备份恢复全链路、演示→注册流程
- 未验证（如实注明）：① 系统通知弹窗最终送达（无头环境）；② 实体 iPhone 真机；③ R2 对象删除的直接列举（API token 无 R2 读权限，见附录 C）；④ 语音转写质量（合成音源不作数）

### B：截图与日志（docs/assets/）
- `r135-pwa-offline-queue.png` 离线队列；`r135-pwa-online-sync.png` 重连同步
- `r135-settings-testpush.png` 通知订阅+测试推送
- `r135-onboarding-fresh.png` 首访 onboarding；`r135-auth-no-migration.png` 注册页无迁移提示
- 运行日志（会话机留存）：ask-eval 59/60 全量输出、MCP 11 工具调用记录

### C：QA 自清核验 `[D1 实查]`
- 注销方式：`DELETE /api/auth/me` 级联（两个 QA 账号 + eval 账号）
- 逐表核清（`u_86d79a871ebe` / `u_600cf230fbf9`）：users/notes/threads/weekly_reports/entities/edges/daily_reviews/user_preferences/push_subscriptions/push_daily_log/thread_jobs/thread_backfill/wechat_mp_bindings/wechat_mp_bind_codes/wecom_kf_bindings 全部 0 行；attachments/note_embeddings 无孤儿行
- R2：附件行已清，端点删除逻辑经 waitUntil 执行 `[源码]`；直接对象列举因 API token 无 R2 读权限未独立验证（如实注明）
- `u_boss` 全程未触碰，核验仍在：`{id:u_boss, name:Thomas}`
- 临时凭证文件（token/密码）已从会话机删除
