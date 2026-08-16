# R153 独立审查报告（审改分离·只审不改）

- 审查对象：生产 https://suinian.zalize.com / API https://suinian-api.zalize.com
- 代码基线：main `ab855d9`（R152 PR #174 合并后，实现提交 `b8c1796`）
- 审查方式：源码审计 + 生产实测（独立 QA 账号 `[QA-R153]-*`，测后逐表注销自清）+ Android 模拟器/PWA 实测（见附录）
- 对照：docs/audit-r151.md（R151 遗留 P1×1、P2×3）
- u_boss：仅只读检查，未做任何写操作

## 结论（TL;DR）

R152 的 token 哈希化实现正确、生产无明文残留，R151 的 P1 与三项 P2 全部修复并复测通过。备份-恢复-注销全生命周期在哈希化后行为正确。本轮无新 P0/P1；新增 P2 两项、设计建议若干（见下）。核心主线「什么都能丢→AI 整理→可靠找回」在 Web/REST/MCP 路径全部实测通过。

三环节评分：
- 什么都能丢（采集）：9.5/10
- AI 整理：9/10（财务 tag 污染/追问抽取修复后提升）
- 可靠找回：9/10（小库语义阈值修复后无跨库噪声）

## 1. R152 复核：token 哈希化（R151 P1 → 已修复）

结论：实现正确，生产无明文残留，日志与备份导出均不泄 token。

源码审计（backend/src/auth.ts、index.ts、mcp.ts、migrations/0026）：
- 生成：24 随机字节 → 48 位 hex（`generateToken`），熵充足。
- 存储：`api_tokens.token_hash` 存 SHA-256 hex，UNIQUE 约束；`users.api_token` 改为哨兵 `hashed:<user-id>`。
- 比对路径：`authenticateToken` 先查哈希表；未命中回退查 `users.api_token` 明文（仅旧账号），命中则在同一 D1 batch 中写入哈希行 + 覆盖哨兵（首验透明迁移，幂等 `INSERT OR IGNORE`）。
- 注册/登录/恢复/rotate 均只回传一次性明文 token；恢复与 rotate 先 `DELETE FROM api_tokens WHERE user_id=?` 再插入新哈希（全量吊销）。
- MCP 路由改用同一 `authenticateToken`，无独立明文查询残留。
- `USER_ID_TABLES` 已含 `api_tokens`，注销级联覆盖。
- SHA-256（非 PBKDF2）对 192-bit 随机 token 是合理选择：token 本身高熵，暴力不可行，且需要每请求低延迟比对。设计上无问题。

生产验证（只读 D1 + QA 新号）：
- D1：`SELECT count(*) FROM users WHERE api_token NOT LIKE 'hashed:%'` → 0（无明文残留）；`api_tokens` 每用户仅哈希行。
- QA 新号三入口鉴权全通过：REST `Authorization: Bearer`（无 token 401 / 错 token 401 / 对 token 200）、MCP `/mcp` initialize（对 200 / 错 401）、扩展 header 形式（`authorization: Bearer ${apiToken}`，与 REST 同路径）。
- 备份导出（普通 zip 与 include_sensitive zip）均不含 token 字段；后端无 `console.log(token)` 类泄漏点（grep 复核）。

## 2. R151 P2 三项复测（均已修复）

1. 财务 tag 污染：给燃气费笔记人为加「水电费」tag 后，问「水电费一共多少」仍答 ¥600（3 条直接命中），并明确披露「仅 tag 命中、未计入合计」的燃气笔记。`subsetDirectHit` 直接命中优先、tag-only 降级披露的设计合理。✅
2. 财务追问抽取：「包括打车费吗」「你算上打车费在内了吗」两种问法均正确走澄清路径并给出打车费记录，代词/方位前后缀剥离生效。✅
3. 小库语义阈值：3 条笔记的小库搜「跑步」只返回直接命中，无咖啡/待办噪声（`semanticMinScoreFor`：<20 条时阈值抬到 0.6）。✅

## 3. 备份-恢复-注销全生命周期（重点复审）

结论：token 哈希化未破坏任何生命周期路径。全部生产实测：

- 备份导出：普通导出敏感笔记内容为 `[已加密内容]` 占位；`include_sensitive=true` 才含明文（显式选择，合理）。导出不含 token/密码哈希/恢复码。
- 恢复导入：默认跳过敏感占位笔记（防止把占位符当正文导入），计数披露；正常笔记全量恢复，附件/分类/标签保持。
- 恢复码：一次性；使用后旧恢复码失效、全部旧 token 401、发新 token + 新恢复码。与 PBKDF2 哈希存储一致。
- 多设备：两次登录各得独立 token，互不影响；rotate 后两者同时 401，仅新 token 200（全量吊销语义明确）。
- 注销：DELETE /api/auth/me → 用户行、api_tokens、notes 等逐表清空（D1 只读复核 0 残留），旧 token 立即 401。带恢复导入数据的账号注销同样级联干净。

设计确认：恢复码重置后不自动重发备份提醒——用户换新 token 后旧设备静默 401，Web/扩展/Android 均会引导重新登录，可接受。

## 4. Android 全量回归（模拟器实测，证据见附录）

方式：本机 Android 35 x86_64 模拟器（headless）实测 android/ debug 包 → 生产 API；因会话桌面引擎故障无法录屏，降级为 adb screencap 逐步截图取证（基础设施限制，非产品问题）。

实测结果（全部 pass）：
- token 登录（Onboarding 填生产 URL+token）→ 时间流 17 条语料加载 ✅
- 中文速记 → 入流，~1 分钟后分类角标「想法」+ #运动 #跑步 + AI 标题 ✅
- 关键词搜索「咖啡」仅命中目标；分类筛选「待办」仅待办笔记 ✅
- 敏感遮罩：Wi-Fi 密码笔记显示「••••••••/敏感内容，点击查看」，UI dump 无明文；点击临时查看、可再隐藏 ✅
- 附件三类入口：文本分享、单图分享（真实 Files app 路径，后端生成 image_description）、多图 SEND_MULTIPLE（2 图→2 条 image 笔记） ✅
- 离线队列：断网速记 → Room pending_notes 入队（sqlite3 验证）；恢复网络 ~20s 自动重试清零、笔记到达生产并完成分拣 ✅（入队 toast 文案为瞬时 Toast，截图未捕到文字本体，logcat 佐证其出现，该子断言 inconclusive）
- 模拟器无法测：语音速记（无麦克风）、拍照（无真实相机）、桌面小组件长期驻留 — untested

新发现（均不阻断主线）：
- **P2-3 敏感笔记遮罩态仍显示标签 chips**：本例标签含 `#77`——恰是密码后缀「Secret#77」的一部分（本例标签来自导入 tags，但同类风险也适用于 AI 从敏感内容提标签的场景）。遮罩承诺正文/标题不露出，但标签可携带内容衍生信息；Web 端同样。建议：敏感笔记遮罩态隐藏标签，或入库时对敏感笔记标签做同样清洗（后端 ingest 已清洗 AI 标签，但导入 tags 未覆盖）。
- P2/观察：分拣完成后 Android 时间流不自动刷新，「分拣中」徽标滞留至手动下拉（后端 <1min 已完成）。
- 观察：分享确认页图片项显示「[图片] msf:…」（URI id）而非文件名；搜索框回车不触发搜索，必须点右侧图标（与 Web 行为不一致）。

## 5. PWA 离线/弱网复审（证据见附录）

方式：headless Chrome + CDP `Network.emulateNetworkConditions` 对生产实测（QA 主账号 token 登录）。

- 离线重载：SW activated，应用外壳+缓存时间流正常渲染，非断网页 ✅
- 离线速记 → 横幅「1 条离线速记待同步，联网后自动补发」 ✅
- 恢复网络 → ~15s 自动补发，笔记入流且到达生产（source=web） ✅
- Slow-3G 首屏：15s 内完整可用、无白屏 ✅（带保留：首屏由 SW 缓存即时服务，未能测出纯网络冷启动路径）

## 6. 设计质疑（两个未审过的流程深挖）

### 6.1 敏感内容加密/解密生命周期（backend/src/crypto.ts、ingest.ts、note-store.ts）

- 机制：AES-256-GCM（`v1:iv:ct`），入库时 `content` 置 `[加密内容]` 占位、密文入 `content_enc`；敏感标题置空、tag 清洗、raw transcript 元数据擦除——纵深做得细。
- 设计确认：API 对持有 token 的请求返回解密后内容，遮罩是客户端 UI 层（点击解锁）。即服务端加密目标是 **at-rest 保护**（D1 备份/导出/内部查询不见明文），不是访问控制。这个边界定义清晰、与威胁模型（防数据库泄露而非防 token 泄露）匹配，合理。
- ⚠️ 设计建议 D-1：`SUINIAN_ENC_KEY` 缺失或加密异常时敏感笔记 **fail-open 明文入库**（is_sensitive=1 但 content 是明文）。托管环境已配 key 无实际影响；自托管漏配 key 时用户以为加密实际明文。建议：无 key 时至少在 `/api/auth/me` 或健康检查中暴露告警标志。不影响核心主线。

### 6.2 媒体/文件摄取管线（backend/src/media.ts、files.ts）

- 三类附件（audio/image/file）统一 10MB 上限、multipart 与 JSON-base64 双路径、MIME-扩展名兜底；音频走 Whisper、图片走视觉模型、文件（PDF/TXT/MD/DOCX）≤600 字直取、超长 AI 摘要+截断兜底；AI 失败/超时给诚实占位而非假成功；原件永存 R2、每日 R2↔attachments 孤儿对账（48h 宽限、单日 2000 对象上限）。失败兜底与对账设计成熟。
- ⚠️ P2-1：10MB 上限对现代手机原图（12MP+ 常见 >10MB）是可预期的 UX 悬崖——Android 分享原图会 413。报错文案诚实但用户无压缩指引。建议：客户端侧压缩或提示「请选择压缩后图片」。影响采集环节体验，不阻断主线（可改发文字/小图）。
- ⚠️ P2-2：敏感检测作用于**提取文本**（转写/OCR 结果），但含敏感信息的**原始图片/音频文件本体**不加密存 R2，经鉴权 proxy 可取原件。与 6.1 的 at-rest 边界不一致：正文加密了、拍了密码的原图仍明文在 R2。建议：敏感笔记的附件原件同样加密或至少在文档中明示该边界。不影响核心主线。

## 7. 分级汇总

| 级别 | 项 | 影响核心主线 |
|---|---|---|
| P0 | 无 | — |
| P1 | 无 | — |
| P2-1 | 10MB 附件上限对手机原图的 UX 悬崖（无压缩指引） | 采集体验，不阻断 |
| P2-2 | 敏感笔记附件原件不加密（与正文 at-rest 边界不一致） | 否 |
| P2-3 | 敏感遮罩态标签 chips 可泄内容衍生信息（Android/Web 同） | 否 |
| P2-4 | Android 分拣完成后不自动刷新，「分拣中」徽标滞留 | 体验，不阻断 |
| 设计建议 D-1 | 无 ENC key 时敏感内容 fail-open 明文，无告警 | 否（自托管场景） |

R151 遗留：P1 token 明文 ✅ 修复；P2×3 ✅ 全部修复。

## 8. QA 自清记录

- `[QA-R153]-lc`：注销后 users/api_tokens/notes 计数均 0，旧 token 401 ✅
- `[QA-R153]-main`、`[QA-R153]-small`：注销后旧 token 均 401 ✅
- D1 只读复核：`users` 中 QA-R153 账号 0 条；全库仅剩 u_boss 1 行；15 个 user_id 表 + 2 个 note_id 表孤儿行扫描全部为 0（all-zero）✅
- u_boss：全程只读，未修改。
- 本地临时 token/备份文件已删除。

## 附录：证据清单

截图共 31 张（a0–a6 Android、b0–b4 PWA），已随汇报附送；关键张：
- Android：a1-after-login（token 登录+时间流）、a2-triaged（分拣结果）、a3-search / a3-filter-todo、a4-sensitive-masked / a4-revealed / a4-rehidden、a5-text-confirm / a5-img1-confirm / a5-multi-confirm、a6-typed-offline / a6-final-timeline
- PWA：b1-offline-reload、b2-offline-queued、b3-online-synced、b4-slow3g-15s
- 录屏：本轮因会话桌面引擎故障（computer-use engine 无法初始化）不可用，降级为逐步截图取证。
