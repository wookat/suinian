# 碎念 Suinian · 交接上下文（handoff-context）

> 目的：换会话/换负责人时注入本文档即可接手。**每轮迭代结束时更新本文档**。
> 最后更新：2026-08-10（R85）

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
- R55：CJK 长问句 LLM 关键词抽取（extractAskKeywords，eval 28/28 全过）、ask 召回排除敏感笔记（含标题）、新手引导 4 步 tour（settings.tourSeen，仅新注册）、空态一键丢入 #示例 笔记+一键清除、周报提示词升级（主线/想法关联/悬而未决）

## 已知问题 / 观察项
- GitHub Actions 不运行（账号付款问题）——所有验证本地做
- `daily_review:cron` 心跳：cron_heartbeats 表 2026-08-07 23:54 UTC 才在生产建表，首个常规 20:00 UTC 跑批在 2026-08-08；R51 已用一次性 cron 在生产验证写入正常
- Vectorize 未启用（个人量级 D1 余弦够用）；公众号/小红书正文抓取受反爬限制，有兜底
- 扩展未上架商店，开发者模式加载（extension/README.md）

## 等老板事项
- GitHub Actions 付款问题（恢复后 CI 才会跑）
- 扩展是否上架 Chrome Web Store（需开发者账号 $5）
- 微信 bot 实例长期托管方式（当前 skill/bridge 自托管）
- 【R85】公众号资源：注册公众号（个人订阅号即可起步）、提供 AppID/AppSecret、在公众号后台回填服务器配置（URL/Token/EncodingAESKey）；开发验证可微信扫码领测试号。清单见 docs/wechat-integration.md 第五节

## 测试约定
- 测试数据一律 `[QA-R55]`（按轮次改前缀），测完调 `DELETE /api/auth/me` 注销自清；**绝不动 u_boss 数据**
- QA 账号命名建议：用户名允许字符为中英文、数字、`._-[]`（2-32 字符，R60 起支持 `[]`）。建议 QA 账号命名 `[QA-R<轮次>]-<用途>`（如 `[QA-R60]-migrate-a`），**务必记录密码**，测完自助注销；若密码遗失需手动用 wrangler d1 按 `backend/src/account.ts` 的级联口径清理（children 先删，附前后 SQL 证据）
- 老板测试 token 由老板在会话中提供附件，勿写入仓库/日志
- admin 端点：`POST /api/admin/run-daily-reviews`、`POST /api/admin/reconcile-threads`（Bearer `ADMIN_TOKEN`）
