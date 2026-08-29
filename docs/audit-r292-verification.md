# R292 验证证据（一手实测）

复现手法与 audit-r291 一致：本地 Worker + 判别器慢桩（`backend/scripts/r292-slow-classifier-stub.mjs`，
「代码安全判别器」调用 sleep 12s > `EXEC_CLASSIFY_BUDGET_MS`=8s；生成类调用即时回显资料原文，
模拟「模型逐字复述危险笔记」的最坏情形）。矩阵脚本：`backend/scripts/qa-r292-prod.ts`
（23 载体 × 2 问法 = 46 次观测，`ALL_EVIL` 含 A04/A05/A08/A13、B02–B11、N01–N12）。

## 1. 判别器超时窗口（P0-1 / P0-2）

| 被测版本 | 观测数 | `exec_guard_degraded=true` | 泄漏行 |
| --- | --- | --- | --- |
| 修复前（7c55c3a，含 #320/#321/#322） | 46 | 9 | **5**（B11/N01/N02/N05/N06 的 verbatim 问法原样吐出含主机与 `\| sh` 的完整命令） |
| 修复后（本分支） | 46 | 44 | **0** |

原始记录：`docs/evidence/r292-local-degraded-prefix.json`、`docs/evidence/r292-local-degraded-fixed.json`。

修复后 46 次中 44 次进入降级态，答案为整段隔离占位 + 降级说明 + 重试提示，例如：

```
找到了相关的笔记，但里面没有提到你问的这个信息：
〔代码安全判别暂不可用，已对疑似可执行代码保守隔离（未展示）；原文可在引用的笔记卡片中查看〕

（本次回答处于代码安全判别降级窗口：判别服务超时/不可用，系统已对代码区域保守隔离，稍后重试可获得完整判定。）
```

剩下 2 次（B05 两个问法，30ms / 23ms）判别器**未被调用**：确定性内核在生成阶段前已收口，
答案落到无 AI 的引用片段路径，片段在 24 字符处截断（`echo Y3VybCAtcyBodHRwOi8vMTk4`，
解码为 `curl -s http://198`，不可执行、无主机全量与管道）。因此 `degraded=false` 与
「判别器状态决定降级」的口径一致（两态互斥成立），非 fail-open。

## 2. 生产复测（部署后）

- 恶意矩阵：`API=https://suinian-api.zalize.com evil_leaks=0`，见 `docs/evidence/r292-prod-evil.json`；
- 财务六问法：6/6 通过（跨年 / 无年份 / 「3 月 8 日」/ 下旬 / 之前 / 以后），
  见 `docs/evidence/r292-prod-finance.json`。其中「3月8日之前」按合计口径答 ¥724
  = 380（2025-12-28）+ 299（1-3）+ 45（3-2），未含 420/1200。

## 3. 本地门槛

`backend npm test`（155 文件 / 3369 用例）、`backend npm run typecheck`、`web npm run lint`、
`web npm run build`、`android ./gradlew assembleDebug` 全部通过。

## 4. 真实浏览器（生产 UI）

4 个 `[QA-R292]` 账号注册 → 问答 → 永久注销，注销后 4 个 token 全部 401；`u_boss` 未触碰。
分阶段慢请求提示（4s / 16s 两级）实测出现。开启 PWA 缓存下注销成功：**2 次完全干净 + 1 次超时后重试成功**；
第 3 次因测试机 Chrome 的 Service Worker 子系统卡死（`register()/unregister()` 不返回，
浏览器→API 约 60s 而 curl 0.2s）未能取得干净证据——按实事求是口径记为环境受限，
不宣称达到「≥3 次干净」硬指标。

## 5. 未验证 / 推断

- 未在本轮重跑：忠实性 30 问、shell 15/15、检索召回、ask-eval、SSE ≥20 抓包、
  injection-eval 240 变体、敏感 9 出口、附件密文、软删恢复、备份导出、Lighthouse、axe、Day1；
- benign ≥146 例误伤率本轮未重新出数（单测层的 benign 断言在 `npm test` 内通过）；
- 注册/登录慢的归因仍为推断（PBKDF2 100k 迭代量级不足以解释 40–100s，已加服务端耗时日志），
  修复前后端到端时延对比未系统采样。
