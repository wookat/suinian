# 碎念 Suinian R175 独立审查报告

- 审查人：独立评审官（审改分离，只审不改；本报告为本轮唯一落库产物）
- 日期：2026-08-17
- 对象：生产环境 https://suinian.zalize.com / https://suinian-api.zalize.com（main 含 R174 #196：财务极值主题限定、ask SSE 流式）
- 方法：生产实测（独立 QA 账号 `[QA-R175]-main` 等，测毕已注销并逐表核零）+ 源码对照 + 原始 provider 流抓取。凡「验证过/未验证」在文中逐项如实区分。
- 核心主线：什么都能丢 → AI 整理 → 可靠找回。

## 结论概要

R174 的两项主改动（主题极值、SSE 流式）方向正确且大体落地：极值变体全部通过、ask-eval 69/69 无回归、Slow 3G 严格档下 SSE 仍可用。但「找回」环节存在两个真实缺陷：**角标粘连已定位为后端流式解析读错 provider 字段（P1-1，必现而非偶发）**，以及**追问改写污染导致答非所问（P1-2，本轮新发现）**。备份-恢复-注销全生命周期与剪藏/MCP 双入口复审全部通过。

## 三环节评分

| 环节 | 评分 | 依据 |
|---|---|---|
| 什么都能丢（收集） | 9/10 | Web/API/扩展/MCP/媒体入口实测全通；敏感 fail-closed 预检在扩展/MCP 源同样生效；仅单条 GET 合同漂移（P2-1） |
| AI 整理 | 9/10 | 分拣/金额/标签/todo_due 实测正确；ask-eval 69/69；备份恢复后派生数据可重建 |
| 可靠找回 | 6.5/10 | 确定性路由极值/变体全对且秒回；但流式角标必现粘连致引用漏配（P1-1）、追问被历史污染答非所问（P1-2）、极值词表缺口致同类问法路由不一致（P2-2） |

---

## P0（阻断核心主线）

无。

## P1

### P1-1 SSE 流式角标粘连：根因已定位——读错 Workers AI 流字段，非模型漏括号、非网络丢字【影响核心主线】

R174 遗留待决项。本轮抓原始 provider 流归因，**9/9 次生成型流式回答全部复现**，不是「偶发」。

**证据链（生产实测 + 直连 provider）**：

1. 生产 `/api/ask`（SSE）问「最近几次打车分别是去哪的？各花了多少钱」，delta 事件序列（节选）：
   ```
   2.334 " 45 元"
   2.366 {"text":[3]}   ← text 不是字符串，是 JSON 数组 [3]
   2.402 "。"
   ```
   done.answer 变成 `…45 元3。`（括号丢失），references 从 3 条掉到与残存角标一致的数量。
2. 直连 Workers AI 同模型流式接口，问题 token 的原始 SSE 记录同时含两个字段：
   ```json
   {"choices":[{"delta":{"content":" [3]"}}], "response":[3]}
   ```
   `choices[0].delta.content` 是正常字符串 `" [3]"`；`response` 字段对形如 `[3]` 的 token 输出的是**未加引号的 JSON 数组**（provider 侧序列化怪癖）。
3. 代码归因：`backend/src/ai.ts` 的 `extractWorkersAiDelta` 只读 `response` 且无类型守卫：
   ```ts
   const j = JSON.parse(data) as { response?: string };
   return j.response ?? null;
   ```
   数组 `[3]` 被当作文本拼进全文（字符串化为 `3`，括号丢失），再原样转发给客户端 delta。`reconcileAskCitations` 只能识别带括号的角标，无法从 `45 元3` 恢复引用 → 引用对账漏配。
4. UI 复现 3 次（录屏+截图）：「45 元3」「458 元2 / 599 元3」（Slow 3G 下且引用列表只剩 1 条）「链接3」。

**排除项**：模型输出无括号——排除（canonical delta.content 含完整 `[3]`）；流式网络丢字——排除（应用层 delta 序列完整，坏 token 是结构化数组而非缺字节）。

**修复建议**（评审建议，不代改）：
- `extractWorkersAiDelta` 改为优先读 `choices[0].delta.content`（OpenAI 兼容字段，始终是字符串），`response` 仅在其为 `typeof === "string"` 时兜底；
- `consumeSseBody` 的 `extract` 返回值加字符串守卫，非字符串一律丢弃并告警；
- 补一条流式对账测试：模拟含 `response:[n]` 的 provider 帧，断言 done.answer 角标完整、references 数量不缩水。

### P1-2 追问被历史污染：无关追问被改写成上一轮问题，答非所问【影响核心主线，本轮新发现】

UI 实测：先问「我金额最大的一笔支出是什么」（正确），追问「我最近在想什么？帮我总结一下」→ **再次返回「你金额最大的一笔支出是 ¥2200 … HHKB」**，完全答非所问。API 复现（同 history）：回答变成「你最近在想你金额最大的一笔支出是什么 [1]…」——召回与生成都被上一轮主题吞没。

**归因（源码 + 实测，改写中间文本未抓取、属合理推断）**：`/api/ask` 用 `rewriteAskQuestion` 把追问改写为独立问题用于召回；`index.ts:2910` 在原问题无财务词时回退用**改写后的问题**判定财务极值意图：

```ts
const finExtreme = financeExtremeIntent(question) ?? (FINANCE_WORD_RE.test(question) ? null : financeExtremeIntent(recallQuestion));
```

「我最近在想什么」不含财务词，恰好触发回退分支；改写器把上一轮的「金额最大的支出」措辞注入改写结果 → 误路由到确定性极值答案。R113 已确立「意图判定以原始问题为准」，R148/R174 为极值开的这个回退口子正是这次被咬到的地方。

**修复建议**：
- 改写器提示词明确：追问不含指代/省略时**原样返回**，禁止引入历史里的新主题；
- 极值回退分支收紧：原问题命中「总结/最近在想/在想什么」等元问题模式时跳过回退；或干脆回归 R113 原则，删除 recallQuestion 回退（极值追问「里面最贵的呢」可靠 history 财务词判定）。

## P2

### P2-1 单条笔记 GET 合同漂移：敏感内容不解密返回 `[加密内容]`

`GET /api/notes/:id` 用 `noteToJson`（不解密），同一账号同一 token 下：列表 `GET /api/notes` 返回敏感明文（客户端遮罩+点按显示），单条 GET 返回 `[加密内容]` 占位。生产实测确认。Web 不用单条 GET 所以无感，但 PATCH（MCP `complete_todo`/扩展补分类同路径）返回解密后内容——三个读路径三种口径。不影响主线（无泄露，fail-closed 方向），但属接口合同漂移，第三方按文档合理调用会拿到密文占位。建议统一为 `noteToJsonDecrypted`（授权读本来就该拿到明文，遮罩是客户端职责）。

### P2-2 财务极值词表缺口：同类问法路由不一致

生产实测：「打车最便宜的一次花了多少」→ 确定性 SQL 秒回（带「数据库精确查询结果」标注）；「打车里最贵的一次是多少钱」→ 走 LLM 生成（2.1s，无标注）。归因：`financeExtremeIntent` 先要求 `FINANCE_WORD_RE` 或「买」命中，「多少钱/打车」都不算财务词 → 极值意图漏判。本次 LLM 恰好答对 88 元，但确定性保证（币种分组、不猜极值）对这类问法失效。建议把「多少钱/花费/费用」纳入财务词，或极值措辞命中时放宽 gating。

## R174 复核（生产实测）

| 项 | 结果 | 证据 |
|---|---|---|
| 主题极值变体 | 通过 | 「键盘里最贵」¥2200、「键盘里最便宜」¥458、「打车最便宜」¥23，均单引用、正确主题限定 |
| 既有极值不回归 | 通过 | 「金额最大的一笔支出」¥2200、「最小的一笔开销」¥23（全局），0.15-0.19s |
| 零命中主题 | 通过 | 「钢琴里最贵」不幻觉，如实说没有钢琴记录 |
| ask-eval 全量 | 通过 | 69/69（100%），本轮独立重跑，eval 账号自建自删 |
| SSE 体感 | 通过 | 生成型首 delta 1.6-3.3s（一次尾部离群 6.0s），完整 2.4-3.9s；JSON 路径需等完整 2.4-3.9s——首字体感提前约 0.8-1.5s；确定性路由仍整段 JSON 秒回 |
| 流式角标渲染完整性 | **不通过** | 见 P1-1，9/9 API 复现 + 3 次 UI 复现 |
| 弱网严格 Slow 3G | 通过 | DevTools「3G」档（旧 Slow 3G）下 /api/ask 仍走真 SSE（Content-Type: text/event-stream），首字约 3-5s、完成 7.3s，渐进渲染正常无报错；客户端另有 content-type 识别 + 60s 超时降级逻辑（源码确认，剥流场景未实测） |
| Android JSON 路径 | 部分验证 | API 合同级验证：不带 `Accept: text/event-stream` 的 POST /api/ask 全部返回整段 JSON、角标/引用完整（多次实测）。Android App 本体未跑（无模拟器环境），如实标注未验证 |

## 备份-恢复-注销全生命周期复审（距 R163 十二轮）

全部通过，生产实测：

1. **敏感导出双闸**：`/api/backup?include_sensitive=true` 无密码头 → 403 `password_required`；带 `x-suinian-password` → 200 含明文。默认备份敏感笔记为 `[已加密内容]` 壳。
2. **全量备份 → 新号恢复**：13 条笔记（含敏感、todo、附件图片）恢复 `13/13 imported`；逐字段核对 category/tags/amount/currency/is_sensitive/created_at/title/todo_due **13/13 完全保真**；附件经 R2 重传后下载与原件**字节一致**（cmp 通过）。
3. **脱敏壳保护**：把脱敏备份再恢复 → `sensitive_skipped: 1`（壳笔记拒绝入库防明文永久丢失）、其余 12 条按 created_at+content 去重跳过。
4. **注销级联**：DELETE /api/auth/me → 旧 token 立即 401；同名重注册得到全新空账号（notes/threads/stats 全零）。级联实现为单事务 batch、children-first，`account-cascade.test.ts` 会扫描 migrations 防表清单漂移（源码确认）。
5. **逐表核零**（wrangler d1 remote，只读）：全部 QA 账号（含 eval 自建号）注销后，notes/threads/weekly_reports/entities/edges/user_preferences/push_subscriptions/push_daily_log/thread_jobs/thread_backfill/api_tokens/daily_reviews/attachments/note_embeddings/wechat_mp_bindings/wechat_mp_bind_codes/wecom_kf_bindings 计 0 残留，auth_rate_limits 无可归属残留；users 表仅剩 u_boss（未动）。

## 剪藏扩展 + MCP 双入口复审（距 R157 十八轮）

全部通过：

- **与主管线一致性**：扩展 = `POST /api/notes`（source=extension），MCP = 同端点（source=mcp）——都走 `createNote` 单一管线（分拣/敏感闸/线索），无旁路实体。远程 MCP（/mcp Streamable HTTP）与 stdio 版工具集一致（11 个工具，签名相同）。生产 /mcp 端点 initialize/tools/list/tools/call 实测正常。
- **敏感管道**：经扩展形态提交「root 密码」笔记 → 入库即 `is_sensitive: true`（fail-closed 预检）；MCP `save_note` 存支付密码 → 返回体即时脱敏为 `[敏感内容已脱敏]`；MCP `search_notes` 命中敏感笔记（经标签）→ content/title/tags 全脱敏、待分拣笔记也按 `[待分拣]` 保守处理。
- **同页去重**：扩展去重探询 `GET /api/notes?url=…&source=extension` + 内容精确比对，生产实测二次剪藏正确识别重复。**设计质疑见 D-2**。

## 设计质疑（2 个未审流程深挖）

### D-1 追问改写管线：一个 LLM 改写既服务召回又能反向劫持路由，是否真的最适合？

现状：`rewriteAskQuestion` 的产物 `recallQuestion` 有三个消费方——关键词召回、时间范围解析、以及（原问题无财务词时的）极值意图回退。前两个是它的本职；第三个把「召回辅助产物」升格成了「路由裁决输入」，等于让一个无 schema 约束的自由文本 LLM 输出拿到了确定性路由的方向盘，P1-2 正是这个结构性问题的实例。更好的方式：改写产物只许进召回（R113 原则一以贯之）；追问场景的意图判定改用「原问题 + 结构化 history 特征（上一轮路由类型）」做显式状态机——追问「里面最贵的呢」在上一轮是枚举时才继承主题，元问题（总结/最近在想）永远走生成。高内聚：路由逻辑集中在确定性代码；低耦合：LLM 只产出召回词。

### D-2 剪藏同页去重放在客户端 best-effort：是否如无必要增了实体，还是该增没增？

现状（R164 P2）：去重是扩展侧「先查后写」两步——查询失败静默放行、两次并发剪藏必然穿透、popup/快捷键/右键三个入口各自依赖同一段客户端逻辑。而服务端已有 `import_fp`（内容指纹）实体和唯一判重语义（本轮备份恢复实测其 created_at+content 去重工作正常）。同一「防重复入库」问题在导入/恢复路径是服务端保证，在剪藏路径却是客户端尽力而为——口径分裂。建议：`POST /api/notes` 接受可选 `dedupe_key`（或复用 import_fp 对 source=extension + url 组合自动判重），服务端返回 200+已有笔记而非新建；扩展侧两步查询可整体删除（少一个实体，语义反而更强）。代价是一次索引查询，收益是三个剪藏入口 + 未来任何新客户端免费获得幂等。

## 附录：证据与测试留痕

- 录屏（生产 UI 全程）：会话附件 `rec-386eb95a…-edited.mp4`——登录、流式渐进渲染两帧对比、角标点击跳转高亮、确定性秒回、Slow 3G SSE、角标粘连 3 次复现、追问误路由。
- 原始流抓取脚本与 9 次运行记录：QA 机 `~/qa-r175/sse_capture.py`、`sse-runs-*.json`（含逐 delta 时间戳与坏帧原文）。
- ask-eval 独立重跑日志：69/69。
- 本轮未验证项（如实声明）：Android App 本体行为（仅验证其 JSON API 合同）；SSE 通道被中间层剥流时的客户端降级（仅源码审阅）；改写器对 P1-2 场景输出的中间文本（据路由代码+复现行为推断）。
- QA 数据自清：3 个 `[QA-R175]` 账号 + 1 个 eval 账号全部经产品注销流程删除，17 张表逐表核零（见上），未触碰 u_boss（只读 users 一次核对残留）。
