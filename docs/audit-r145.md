# 碎念 Suinian — R145 审查报告（独立评审官 · 只审不改）

- 日期：2026-08-15（UTC）
- 审查对象：生产环境 https://suinian.zalize.com（API https://suinian-api.zalize.com）
- 基线：main `c23f9b6`（含 R144 PR #166 `7973c30`：全端附件原图/语音/文件渲染、恢复码找回、migration 0024）
- 方式：生产实测（独立 QA 账号 `[QA-R145]-main` + 新用户旅程账号 `[QA-R145]-journey`）、Android 模拟器（API 35，debug APK 实装）、本地 mock（微信公众号回调）、D1/R2 远程实查、源码走读；测毕两账号均已注销并逐表验证清理。
- 证据口径：逐项标注【生产实测】【D1 实查】【R2 实查】【mock 实测】【源码走读】【未验证】，不以"有代码"当"验证过"。

## 总结论

**GO（无条件项）。** R143 的两个 P1（附件原图全端不渲染、无密码找回通道）在 R144 均已修复，且本轮 Web 生产 + Android 模拟器实测全部复核通过；恢复码链路的安全性质疑（熵、暴力破解、token 失效、重放）逐项实测无缺陷。本轮未发现 P0/P1；新增 2 个 P2 与 3 条设计建议。

三环节评分（10 分制）：

| 环节 | 分数 | 变化 | 依据 |
|---|---|---|---|
| 记录（什么都能丢） | 9.0 | 持平（R143: 9.0） | 图/语音/文件三类附件原件入库与展示全端打通；octet-stream 边角（P2-1）不损数据 |
| 检索/问答（可靠找回） | 9.0 | ↑（R143: 8.5） | R143 P1-1/P1-2 修复实测确认：附件原图可见可播可下载、恢复码找回闭环；找回完整度短板补齐 |
| 管理/回顾（AI 整理） | 8.5 | 持平 | 首条笔记 AI 分拣打标正常；本轮未发现整理侧回归 |

---

## 1. R144 复核

### 1.1 附件三类渲染 — Web 生产实测 ✅【生产实测】
- 图片（image/png）：卡片缩略图渲染，点击弹出全屏 lightbox，可关闭。
- 语音（audio/mp4）：原生 `<audio>` 播放器渲染，实际播放走完进度（0:00→0:02）。
- 文件（text/plain）：文件卡片展示（名称+大小），下载成功且内容与上传 fixture 逐字节一致。
- 接口口径：`/api/notes/:id/file?inline=1` 仅对 image/audio/video 返回 `Content-Disposition: inline`，其余强制 attachment；`Cache-Control: private, no-store`；未认证 401、跨笔记 attachment id 404。【生产实测】

### 1.2 附件三类渲染 — Android 模拟器实测 ✅【生产实测·API 35 debug APK】
- R143 遗留欠账（未做模拟器附件实测）本轮补齐：图片缩略图+点击全屏、audio/mp4 播放（audio_flinger 确认 active track）、文件卡片（TXT · 50 B + 下载图标）均通过。
- 跨端差异：octet-stream 语音附件 Android 端 `NoteMedia.kt` 按文件扩展名回退判定 → **显示播放器且可播**；Web 端仅按 mime 判定 → 无播放器。详见 §2。
- 偶发：首次登录后时间流长时间停留骨架屏，重启应用后正常（复现 1 次，疑首拉竞态，见 P2-2）。

### 1.3 敏感附件遮罩 ✅【生产实测】
- Web：敏感笔记（content 含银行卡密码、带图片附件）卡片显示 •••• 遮罩+"敏感内容，点击查看"；遮罩态 Performance entries 中无该笔记的 file 请求（媒体组件未挂载，非 CSS 遮挡）；解锁后正文+图片正常显示，再隐藏恢复遮罩。
- Android：同口径通过（遮罩→解锁显示正文+图片→重新遮罩）。
- 设计观察：附件元数据（文件名/mime/size）与 R2 对象本身不加密，owner 鉴权下 file 端点对敏感笔记仍 200（合理：仅 owner 可取）；但若文件名本身含敏感信息，遮罩态列表接口仍会返回该名称。现阶段可接受，记为观察项不定级。【源码走读+生产实测】

### 1.4 恢复码找回全链路 + 安全性质疑 ✅【生产实测+源码走读】
- UI 闭环：登录页找回入口→输入用户名+恢复码+新密码→展示一次性新恢复码卡片（可复制、需确认）→新密码登录成功。设置页"重新生成恢复码"有确认弹窗+旧码作废文案。
- 熵：31 字符字母表（剔除易混淆字符）× 16 位 ≈ 79.3 bit；`generateRecoveryCode` 用 rejection sampling 消除取模偏差；仅存 PBKDF2 哈希（`users.recovery_hash`），明文只在注册/找回成功/重新生成三个时点返回一次。【源码走读】
- 暴力破解：`/api/auth/recover` 按 IP+账号双维度限流，实测 5 次/分钟后第 6、7 次 429；79 bit 熵 + 5 次/分钟在线爆破不可行。固定分钟窗口在窗口边界最多放行 2×5 次，相对熵量级可忽略。【生产实测】
- 凭据轮换：找回成功后旧 api_token 401、旧密码 401、新 token/新密码 200；已消耗恢复码重放 401；未知用户名与错误恢复码返回同一 401 文案（不泄露账号存在性）。重新生成恢复码接口按 userId 限流（第 6 次 429）。【生产实测】
- 结论：设计与实现均扎实，无缺陷。

## 2. 待裁量项：API 直传音频无 Content-Type → octet-stream 不渲染播放器

- 复现【生产实测】：`POST /api/ingest/media` 上传 .m4a 不带 type → `attachments.mime = application/octet-stream`；`file?inline=1` 返回 `Content-Disposition: attachment`；Web 端该笔记无播放器（仅转写文本）。带 `type=audio/mp4` 时全部正常。
- 影响面：
  - Web/Android 官方客户端上传总是带 mime，不受影响。【源码走读】
  - 受影响的是 API/MCP/bridge 等直传调用方省略 type 的场景；此外微信公众号与企微媒体下载在响应无 content-type 时也兜底为 octet-stream（`wechat-mp.ts:294`、`wecom-kf.ts:239`），同样会落入无播放器路径。【源码走读】
  - Android 已有扩展名回退 → 同一条笔记两端表现不一致（Web 无播放器 / Android 可播）。【生产实测】
- 裁量结论：**采纳"服务端按扩展名兜底"**，在入库处（`storeOriginal`/`parseMediaRequest`）对 octet-stream + 已知扩展名（.m4a/.mp3/.amr/.jpg/.png/...）统一映射，一处修复、两端一致、历史口径可顺带写正；Android 端回退可保留作为双保险。定级 **P2**（数据不受损、转写不受影响，仅播放体验缺失；核心主线轻微受损）。

## 3. 新用户端到端旅程 ✅【生产实测】

注册 `[QA-R145]-journey` → 一次性恢复码强提示（整卡展示、可复制、需勾选确认才能继续，引导得体）→ 5 步 tour → 首条文本笔记入库并被 AI 分拣打标 → UI 上传图片生成缩略图笔记 → 搜索关键词命中该笔记。视觉与文案未见失当。
（备注：自动化输入环境丢失 CJK 字符，正文仅落 ASCII 部分，属测试环境限制，非产品缺陷。）

## 4. 微信 bridge/公众号/企微三通道核查

- 生产现状【生产实测】：公众号未配置（`/wechat/mp` GET/POST 404）、企微未配置（`/wechat/kf` 404）、`/api/wechat/binding` 返回 `configured:false, kf_configured:false`、`/api/wechat/bind-code` 404 `MP_NOT_CONFIGURED`；bridge `/health?probe=bridge` 返回 `ok:false`、状态 `waiting_scan`、detail 为登录尝试超时（运维事项：长期滞留 waiting_scan，需重新扫码或明确下线，非代码缺陷）。
- 状态展示是否如实【生产实测】：两通道均未配置时，Web 设置页整张微信卡片隐藏，无误导文案 ✅。单通道配置时另一通道显示"即将开放"（源码分支，本轮生产不可达）——建议改为"未开通"类中性表述，避免无日期承诺（设计建议 D-2）。
- 回调/绑定路径 mock 实测【mock 实测·本地 wrangler + WECHAT_MP_TOKEN】12 项全过：GET echo 签名校验 200 / 错误签名 403、subscribe 欢迎+绑定引导、未绑定文本引导、6 位码绑定成功、无效码提示、绑定后文本入库、`?` 消息拒绝被动应答并引导用 Web 问答、链接入库、无 AppSecret 时语音诚实降级提示、解绑成功。
- 腐化审查【源码走读】：`wechat-mp.ts`/`wecom-kf.ts` 结构清晰（签名/AES 安全模式/XML 解析/绑定码/媒体下载分层），近十轮未见随演进腐化；XML 用正则解析偏简但有测试覆盖，当前消息面足够，不建议引入 XML 库（如无必要勿增实体）。

## 5. 设计深挖（2 个未审过流程）

### 5.1 附件生命周期：删除路径的 R2 一致性
【源码走读+R2 实查】单删/批删/回收站清空/cron 硬删/注销账号均会级联清理 attachments 行并调用 `MEDIA.delete`；生产 R2 桶当前 0 对象、D1 无孤儿附件行，实践中闭环成立。
- 是否真的最适合？隐患在失败路径：所有 `MEDIA.delete` 均为 fire-and-forget（catch 后仅 console.error），且执行顺序是**先删 D1 行再删 R2**——一旦 R2 删除失败，r2_key 已随行删除而丢失，孤儿对象永久不可归属、无对账手段。
- 更好的方式：二选一，成本都低——① 先删 R2 成功后再删行（失败则整体报错重试）；② 保留现顺序但把失败 key 写入 tombstone 表，由现有 cron 顺带重试。当前规模下为设计建议（D-1），不定 P 级。

### 5.2 检索找回链路：关键词 LIKE + 语义混合
【源码走读+生产实测】`GET /api/notes?q=` 多词按 AND（词序无关、跨字段）、首页叠加部分命中（全命中优先）与语义召回（Vectorize），语义失败静默降级为纯关键词——降级口径正确。
- 是否真的最适合？两点质疑：① `LIKE '%term%'` 无索引全扫，单用户千条量级无感，但排序是 `created_at` 而非相关度，多词部分命中的排序已有分层，纯关键词页仍是时间序——找"内容最相关"时可能需翻页；② 敏感笔记密文入 `content_enc` 后关键词检索不可达（既有口径，靠标题/标签找回），"可靠找回"对敏感内容天然打折，属加密的合理代价，但值得在帮助文案中向用户说明。
- 更好的方式：现规模不建议引入 FTS5/相关度引擎（如无必要勿增实体）；可先做零成本改进——语义召回已产出 score，关键词首页可用"命中词数+语义分"做轻量重排。记为观察项。

## 6. 问题清单汇总

| 级别 | 编号 | 问题 | 影响核心主线 | 状态 |
|---|---|---|---|---|
| P2 | P2-1 | octet-stream 语音附件跨端不一致：Web 无播放器、Android 扩展名回退可播；建议服务端入库时按扩展名兜底 mime | 轻微（找回播放体验） | 生产实测确认 |
| P2 | P2-2 | Android 首次登录后时间流偶发停留骨架屏，重启应用恢复（疑首拉竞态） | 否 | 模拟器复现 1 次，待稳定复现 |
| 建议 | D-1 | 附件删除先删 D1 后删 R2 且失败仅记日志，R2 删除失败将产生不可归属孤儿；建议调序或加 tombstone 重试 | 否 | 源码走读（生产当前无孤儿） |
| 建议 | D-2 | 微信单通道配置时另一通道"即将开放"文案为无日期承诺，建议中性表述 | 否 | 源码走读 |
| 建议 | D-3 | 敏感笔记的加密不可检索代价建议在帮助/文案中向用户说明（靠标题/标签找回） | 轻微 | 源码走读 |
| 运维 | O-1 | bridge 长期 `waiting_scan` 且登录尝试超时（/health?probe=bridge ok:false），需重新扫码或明确下线该通道 | 否 | 生产实测 |

## 7. QA 数据自清【D1 实查+R2 实查】

两个 QA 账号均 `DELETE /api/auth/me`（200）。终查：`users_total=1`（仅 u_boss/Thomas）、`qa_users=0`；notes/attachments/note_embeddings/threads/daily_reviews/user_preferences/push_subscriptions/wechat_mp_bindings/wecom_kf_bindings 孤儿计数全部为 0；auth_rate_limits 中 QA 相关行（含测试残留 3 行）已清 0；R2 桶 `suinian-media` 对象总数 0。u_boss 全程未触碰。

## 附录：证据清单

- 本地验证：backend `npm test` 756/756 全绿 + `tsc --noEmit` 无错；android `assembleDebug` BUILD OK（GitHub Actions 按公司规则保持禁用，本地即验收标准；本轮未改产品代码，web 构建未涉及）。
- 生产接口原始响应：三类附件 ingest 与 file 端点头部（inline/attachment/no-store）、未认证 401、跨附件 404、找回 5 次限流 429、旧 token/旧密码/旧恢复码 401、微信三通道未配置 404/binding 状态、bridge waiting_scan。
- 录屏：Web 主流程（恢复码找回、登录、三类附件、敏感遮罩、微信卡片、恢复码重生成，带注释；因测试机 X server 中途重启，新用户旅程与 Android 部分无录屏、以逐步截图为证）。
- 截图：journey 一次性恢复码卡/tour/首条笔记分拣/UI 传图缩略图/搜索命中；Android a02–a23（onboarding 找回入口、时间流、图片全屏、文件卡、audio 播放、octet-stream 播放器、敏感遮罩/解锁）。
- 本地 mock：微信公众号回调 12 项断言输出。
