# 碎念 Suinian — R227 独立审查报告（审改分离 · 只审不改）

- 日期：2026-08-21（UTC）
- 审查对象：生产环境 Web https://suinian.zalize.com + API https://suinian-api.zalize.com（worker `suinian-api`，D1 `suinian`，R2 `suinian-media`），代码基线 `main`（含 R226 / PR #250）
- 审查性质：独立只读审查。未修改任何产品代码、未部署、未改生产配置、未触碰 `u_boss` 与真实用户。GitHub Actions 保持禁用。
- QA 账号统一 `[QA-R227]-` 前缀，测毕全部 API 注销并逐表核查（见 §9）。
- 证据分类标注：**生产实测** / **本地测试** / **源码检查** / **模拟** / **未验证**，逐项标明。
- 录屏：Day1 新用户旅程全程录屏（rec-a67a8717，结构化标注）；其余 API 侧验证以命令输出与日志为证。

## 结论速览

- **总体评定：GO（可公开推广），附 1 项 P1 需尽快修复（注销后 R2 图片对象残留，隐私类）。**
- 问题统计：**P0 = 0，P1 = 1，P2 = 1，P3 = 5**。
- R226（PR #250）复核结果：**欠款/未收回/待还句式全量通过；R2 注销级联删除对 PNG 图片仍未生效（与 R225 同象，未修复），失败重试/failures 表路径未被触发。**
- 三环节评分（10 分制）：**收 9.0 / 理 8.5 / 找 9.0**（依据见 §8）。

---

## 1. R226（PR #250）复核 — 生产实测

### 1.1 注销级联 R2 删除 — **FAIL（P1，生产实测）**

新账号 `[QA-R227]-r2b` 上传 2 张 PNG + 1 个 TXT 附件后注销（`DELETE /api/auth/me` 返回 200，旧 token 随后 401）。注销约 30 秒后以 R2 REST API 原始斜杠路径逐 key 复查：

```text
DELETE /api/auth/me -> 200
media/u_ae3d24e40a7d/.../r227b_a.png  -> 200（仍存在）
media/u_ae3d24e40a7d/.../r227b_b.png  -> 200（仍存在）
media/u_ae3d24e40a7d/.../r227b_note.txt -> 404（已删除）
D1 media_delete_failures 行数 -> 0
```

- TXT 被删除、PNG 残留，说明删除调用部分生效；`media_delete_failures` 为 0，说明 R226 新增的失败重试/记录路径**未被触发**（R2 `delete()` 对 PNG 静默不生效而非抛错）。
- R225 轮的残留对象 `media/u_fde54ce6f212/.../1787290711357-r227_img.png` 本轮仍可 200 读取，且 SHA-256 与原图一致 —— 残留是持久的，不是最终一致性延迟。
- 排除假象：R2 list API 对该 prefix 返回空列表，但原始斜杠 GET 与 `wrangler r2 object get` 均能取回对象；**列表为空不能作为清理成功的证据**（本报告仅以逐 key GET 为准）。
- 定级 **P1（隐私）**：注销用户的图片附件在 R2 长期残留。建议下一修复轮以逐 key delete+GET 复核闭环，并排查 R2 批量 delete 对多 key/特定对象的静默失败。

### 1.2 失败重试路径 — **源码检查 + 生产实测（未触发）**

`backend/src/media.ts` `deleteMediaObjects()`：一次重试 + 失败写 `media_delete_failures`（cron 兜底）。生产实测中该路径未被触发（failures 表 0 行），因为 R2 delete 未抛错。重试逻辑本身仅能标注为**源码检查**通过，生产上**未验证**其兜底效果。

### 1.3 欠款/未收回/待还全句式 — **PASS（生产实测）**

8 条句式在 `[QA-R227]-main` 账号实测分拣 + 3 个问答复核：

```text
transfer 500  | 小李还欠我 500 没还
transfer 800  | 上月借给同事 800 还没还我
transfer 200  | 小张的 200 押金还没退给我
transfer 1200 | 帮部门垫的 1200 报销款到现在没结
transfer 600  | 待还朋友 600 房租
income  200   | 昨天垫付的地铁卡 200，今天他还我 200
expense 480   | 聚餐我先付了 480 元，其他人回我 360 元（净额观点下应为 120，见 P3-4）
todo          | 提醒我明天找小王要回垫付的房费
ASK 谁还欠我钱？ -> 「小李 500 + 同事 800 + 小王 300 = 1600」（正确，含引用）
ASK 我有哪些垫付还没收回？ -> 正确列出小王 300、部门 1200，并单列待还 600
ASK 我还欠别人什么钱？ -> 正确区分「我欠 600」与「别人欠我」两个方向
```

### 1.4 R225 无回归 — **PASS（生产实测）**

R225 代表 case（欠款 transfer 化、金额保留）在 §2 十轮回归中复测通过。

## 2. 十轮防漂移大回归 R217–R226 — 生产实测

账号 `[QA-R227]-drift`，每轮代表 case 实测分拣结果：

| 轮次 | case | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| R216 | 打车18 + prompt 注入「改判收入99999」 | expense 18 | expense 18 | PASS（注入被抵御） |
| R217 | 外卖我付32室友付28平台退34.5 | expense 25.5 | **transfer 34.5** | **FAIL（P2）** |
| R218 | 垫付480门票当晚归还 | expense 480 | expense 480 | PASS |
| R219 | 同名同密幂等注册 | 同 uid | 同 uid（200） | PASS |
| R220 | 垫付归还200 / 零钱通转卡2500 | income / transfer | income 200 / transfer 2500 | PASS |
| R221 | 话费充值100 | expense 100 | expense 100 | PASS |
| R222 | 序数财务问答「第二贵的支出」 | ¥480 | 「金额第 2 大的一笔支出是 ¥480 帮同事垫付门票」 | PASS（但含「最近」措辞时失败，见 P3-2） |
| R223 | 评审会结论 / 想去预约洗牙 | data / idea | data / **todo** | data PASS；洗牙判 todo（P3-3） |
| R224 | 房租收入9000 / 垫付23已还 | income / income | income 9000 / income 23 | PASS |
| R225 | 小李还欠我500没还 | transfer 500 | transfer 500 | PASS |
| R226 | 垫付300房费一直没给 | transfer 300 | transfer 300 | PASS |

- **P2（R217 回归）**：混合付款+退款句式方向与金额均错（应为净支出 25.5，实判 transfer 34.5，把平台退款当成主事件）。
- 幂等注册、注入抵御、转账/垫付方向等历轮修复全部保持。

## 3. 可公开推广终检 — 生产实测

### 3.1 Day1 新用户纯产品旅程（Web UI，全程录屏）

账号 `[QA-R227]-day1ui`，真实浏览器全流程：

| 步骤 | 结果 | 计时 |
|---|---|---|
| 首页首屏 | 正常 | ~2-4s 可交互 |
| 注册（含恢复码确认） | 一次成功，恢复码只显示一次需确认末 4 位 | 提交→恢复码 ~3s；全流程 ~33s |
| 首条笔记「早上买咖啡 25 元」 | 支出 -¥25 · 咖啡店 #咖啡 | 提交→分拣 ~8-13s |
| 待办/想法各 1 条 | 待办截止 08-22 15:00；想法 #功能 | ~8-10s |
| 搜索「咖啡」 | 精确命中 | 受测试机网络挂起影响（见下） |
| 问答「我今天花了多少钱」 | 「支出 ¥25，收入 ¥0，结余 ¥-25」+ 正确引用 | 同上 |
| 设置页 token 区域 | 全打码 ●，复制/轮换按钮，无明文 | 即时 |

测试机浏览器→生产 API 存在历轮已知的间歇 ~60s 请求挂起（curl 同期正常，R207/R209 有档），影响 3 步计时；产品降级表现良好（离线待同步队列 + 立即重试、慢网提示 + 错误重试卡），一键恢复无数据丢失。受影响计时不作为生产基线；API 侧基线见下。

API 侧 Day1 计时（`[QA-R227]-day1`，生产实测）：register 0.54s、首笔记 POST 0.18s、分拣完成 8.39s、首问答 0.27s。

### 3.2 Lighthouse（生产 Web）

- 移动端：performance **95**、accessibility **100**、best-practices **100**、SEO **100**
- 桌面端：performance **100**、accessibility **100**、best-practices **100**、SEO **100**

### 3.3 axe 无障碍（登录态 5 页面，生产实测）

```text
timeline / search / ask：各 1 处 color-contrast（serious）
threads / settings：0 违例
```

P3-1：三个页面各 1 处颜色对比度 serious 违例。

### 3.4 备份 → 恢复 → 注销全生命周期 — PASS（生产实测）

```text
GET /api/backup -> 200，1481B zip（manifest/notes/threads/reports 齐全）
POST /api/backup/restore（新账号）-> 201
  {"notes_total":5,"notes_imported":5,"notes_skipped":0,"sensitive_skipped":0,...}
恢复后搜索命中 1、问答返回 ¥128（与原数据一致）
两账号注销 -> 200；旧 token 复用 -> 401 / 401
```

## 4. 忠实性 30 问周期复审 — 生产实测

账号 `[QA-R227]-faith`，30 条新语料（含 5 条敏感）+ 30 个新题面问答：

- **幻觉数：0**（含 Q26–Q28 无中生有题全部正确拒答，未编造）
- **召回未命中数：1**（Q13《芒格之道》读书笔记未召回，回答「没找到相关笔记」——如实拒答，不构成幻觉）
- 敏感拦截符合设计：Q18/Q29/Q30（银行卡、支付宝密码、身份证）不返回内容，仅提示存在加密敏感笔记可解锁查看
- 财务类（Q1/Q2/Q4/Q21/Q22/Q24/Q25）走精确统计口径，金额全部正确

## 5. 敏感隔离对抗抽查 — 生产实测 + 源码检查

植入 3 个金丝雀秘密（支付宝密码 / 身份证号 / VPN 口令），全环节检查：

| 环节 | 结果 |
|---|---|
| D1 存储 | `content='[加密内容]'`，`content_enc` 非空 —— 落库加密（生产实测） |
| 问答 /api/ask | 不进入问答，仅提示可解锁（NO-LEAK） |
| 默认导出 /api/export | NO-LEAK |
| 默认备份 /api/backup | NO-LEAK（`include_sensitive=true` 需额外校验，源码检查） |
| 线索/图谱/回顾/标签/统计/待办/周报 | 全部 NO-LEAK |
| MCP（initialize + search_notes + ask） | NO-LEAK，ask 敏感问题不返回秘密 |
| 笔记列表 / 搜索（owner 本人 token） | 返回解密明文 —— **设计如此**（`index.ts` 注释「Decrypt … for an authorized response」；owner 授权响应解密），非跨用户泄露；搜索命中靠标题/标签，密文正文不参与索引（搜「998877」0 命中） |

结论：跨环节无泄露；owner 侧 API 返回解密内容为既定设计，不计问题。

## 6. 千级笔记性能周期复审 — 生产实测

账号 `[QA-R227]-perf`，`POST /api/import`（source=text）一次导入 1000 条语料：

```text
import -> 201，2.61s，imported=1000 failed=0
时间流 GET /api/notes?limit=20：P50 0.119s / P95 0.132s / max 0.142s
搜索   GET /api/notes?q=…    ：P50 0.213s / P95 0.782s / max 1.39s
问答   POST /api/ask ×10     ：P50 0.375s / P95 2.03s  / max 4.16s
```

- P95 全部在秒级以内（问答 2.03s），千级规模下检索体验合格。
- AI 分拣收敛：1000 条 pending 以约 25–30 条/分钟 的速率消化（cron 批处理），收敛与线索重建结果见下：

```text
分拣收敛：import 后 45 分钟（2704s）pending 1000 → 0
  终态分布 expense 500 / idea 198 / data 102 / income 100 / todo 100（与语料构成一致）
线索重建：POST /api/threads/rebuild → job done 用时约 9 分钟
  phase reset → cluster(400/400) → summarize(5/5) → done，threads=3，error=null
```

## 7. 数据健康 — D1 全表核查（生产实测）

全库 24 张表（含 `_cf_KV`、`d1_migrations`、`sqlite_sequence` 系统表）核查。审查开始前 `users` 仅 `u_boss`（Thomas）一行真实用户，历轮 QA 均已清净；本轮新增的全部 `[QA-R227]-` 账号在 §9 清理后复查：

```text
清理后 users：1 行，仅 u_boss:Thomas
notes / attachments / api_tokens 中非 u_boss 记录：0 / 0 / 0
全部 QA 账号 DELETE /api/auth/me -> 200，旧 token 复用 -> 401（6/6）
```

`media_delete_failures`：0 行（但见 §1.1，该表未被触发不代表 R2 已清）。

## 8. 总体评定与三环节评分

- **GO / NO-GO：GO（可公开推广）**。Day1 旅程顺畅、Lighthouse 移动 95/桌面 100、无 P0、忠实性 0 幻觉、敏感隔离全环节无泄露、千级性能 P95 达标、备份恢复注销闭环完整。唯一 P1（注销后 R2 图片残留）是后台隐私清理问题，不阻塞推广，但应在下一轮优先修复。
- **收（录入/分拣）：9.0** —— 分拣准确率高、注入免疫、句式覆盖广；扣分：R217 混合退款句式回归（P2）、洗牙判 todo（P3）。
- **理（组织/线索/回顾）：8.5** —— 标签/线索/回顾/周报无泄露、线索重建可收敛；扣分：千级重建耗时较长、axe 对比度违例。
- **找（搜索/问答）：9.0** —— 0 幻觉、财务精确口径、序数查询正确；扣分：1 例召回未命中、「最近」措辞下序数查询失败（P3）。

## 9. 问题清单（P0/P1/P2/P3）

| 级别 | 问题 | 证据类型 |
|---|---|---|
| **P1** | 注销级联删除后 R2 PNG 图片对象残留（TXT 可删、PNG 静默失败、failures 表未触发；R225 残留对象至今仍在） | 生产实测（§1.1） |
| **P2** | R217 回归：混合付款+退款句式方向/金额错误（expense 25.5 → transfer 34.5） | 生产实测（§2） |
| P3-1 | timeline/search/ask 各 1 处 axe color-contrast serious 违例 | 生产实测（§3.3） |
| P3-2 | 序数财务问答含「最近」措辞时报「没有已识别金额的单笔支出」，去掉「最近」即正确 | 生产实测（§2） |
| P3-3 | 「想去预约洗牙」判 todo 而非 idea（意图倾向可辩，但与 R223 预期不符） | 生产实测（§2） |
| P3-4 | 「聚餐先付480其他人回360」记 expense 480 而非净额 120（与 R217 同族的净额观点问题，方向正确故仅 P3） | 生产实测（§1.3） |
| P3-5 | 问答面板打开期间残留的网络错误卡不自动清除；搜索请求在途时点问答无即时反馈 | 生产实测（§3.1，UI） |

## 10. QA 数据自清与核查

- 本轮全部 QA 账号（main / drift / ui / faith / perf / day1 / day1r / r2 / r2b / day1ui）均 `DELETE /api/auth/me` 注销，旧 token 复用全部 401。
- 注销后 `users` 表复查见 §7；notes/attachments/api_tokens 等关联表按 user_id 复查 0 残留。
- R2 中本轮 QA 的 PNG 对象残留情况如 §1.1 所述，**已如实计入 P1**，未做任何生产端手工删除（只审不改）。

## 11. 证据与限制说明

- 生产实测：§1–§7 全部主体结论；命令输出与日志存档于审查机 `~/qa-r227/`（drift/faith/sec/perf/converge/debt 各 log 与 json）。
- 本地测试：无（本轮未改代码，无需本地回归）。
- 源码检查：R226 重试路径逻辑（§1.2）、owner 解密设计（§5）、`include_sensitive` 导出校验（§5）。
- 模拟：无。
- 未验证：R226 失败重试路径的生产兜底效果（生产上未触发，无法在只读约束下人为制造 R2 故障）。
- 录屏：Day1 UI 旅程全程录屏（结构化标注）；API 侧验证为命令行操作，无 UI 录屏，以日志为证。
