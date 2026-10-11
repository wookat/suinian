# decision-r338：主模型熔断（primary breaker）——慢失败后直走 fallback，半开重试

状态：提案 + 实现（同 PR）。范围仅 `backend/src/ai.ts` provider 链 + `/health?probe=ai` 管理员视图一字段，不触碰 guard/召回/出口任何判定。

## 1. 一手证据

R336 主模型口径（`AI_BASE_URL=https://api.aicdks.com`，`AI_MODEL=swe-1.7`）生产 `wrangler tail` 实录（b37b8d1，2026-09-09 08:36–09:01 UTC，本机 `tail-filter.py` 汇总）：

| 观测 | 数值 |
| --- | --- |
| 主模型超时/网络失败后回落 `workers-ai` 的请求 | 114 条 / 25 分钟 |
| 故障窗口长度 | 最短约 1 分钟，最长约 11 分钟；12:29–12:49 UTC 连续 20 分钟 `/health?probe=ai` degraded:true |
| 每条失败请求付出的额外等待 | 20 s（`AbortSignal.timeout(opts.timeout_ms ?? 20_000)`，非流式；流式同值） |
| 本机直连同一中转 | 一次 200 耗时 6.8 s、一次 30 s 超时 |

窗口内**每一条** `/api/ask`（含 R337 拆句后的两个子请求）都独立等满 20 s 再回落——同一隔离实例前一秒刚超时的事实对下一条请求零复用。用户面表现为 R336 报告 §9-1 记的「主模型口径 benign/fold 段落在过一个窗口」以及浏览器录屏中的长等待。

## 2. 根因

`chatComplete` / `chatCompleteStream` 的链是纯无状态的「先主后备」：

```ts
const primary = await runModel(env, model, opts);   // 每次都等满
if (primary !== null) return primary;
return runModel(env, fallback, opts);
```

现有超时策略（超时不重试、429/5xx 重试一次）只优化单次调用内部，不跨请求记忆。

## 3. 方案：单实例内存熔断器

- **状态**：模块级 `primaryOpenUntil`（时间戳）+ `primaryTrips`（计数，仅观测）。Worker 每个隔离实例一份，不做 KV/D1 共享——共享会引入一次额外 I/O 且窗口只有 60 s，实例间各自学习一次即可。
- **触发（trip）**：主模型**慢失败**——超时、网络异常、429/5xx（重试一次后仍失败）、流式零文本。**不触发**：缺 key、401/402/403/4xx 等快失败（这些一次返回即回落，不值得跳过；402 余额不足是 R336 常态，仍需每次探主模型以便充值后立刻恢复）。
- **窗口**：`AI_BREAKER_MS`（默认 60 000；`"0"` 关闭；非法值回落默认）。窗口内 `chatComplete`/`chatCompleteStream` 直接走 fallback，不发主模型请求。
- **半开**：窗口到期后下一条请求正常试主模型；成功 ⇒ 闭合（`primaryOpenUntil = 0`）；再慢失败 ⇒ 重新计窗（trip +1）。
- **仅在有 fallback 时生效**：`AI_FALLBACK_MODEL=none` 或主模型本身就是 fallback 时不熔断——跳过主模型没有替代，结果只会是 null。
- **探针绕过**：`aiProbe` 始终探主模型，`/health?probe=ai` 的 `degraded` 语义不变（仍是「本次探针由谁应答」）；探针成功闭合熔断器，探针失败**不**触发（探针 8 s 超时比业务 20 s 短，6.8 s 的边缘成功不应把业务流量推去 fallback）。管理员视图新增 `ai.breaker: { open, until, trips }`（探针成功即闭合，故 `open:true` 只会与 `degraded:true` 同现）；公开视图不变（不暴露配置指纹，沿 R166 P2-5）。

## 4. 安全不变量（不变）

- 熔断器只决定「由哪个 provider 生成」，不改任何 guard/oracle/占位/折叠/出口判定；fallback 路径本身就是 R134 以来的常态基线，R333–R337 全部零漏矩阵都在 degraded 口径下跑过。
- 不新增任何日志字段含用户内容或 key；日志只有模型名、窗口毫秒、trip 序号。
- mock 模型不触碰熔断器；R94 既有降级链测试逐字不变。

## 5. 验证

- 新增 `backend/test/r338-ai-breaker.test.ts`（10 例）：一次超时熔断→窗口内主模型 fetch 计数不增→到期半开成功闭合；半开再失败重新计窗；5xx/429 熔断、401/402 不熔断；无 fallback 不熔断；`AI_BREAKER_MS=0` 关闭；自定义/非法窗口；流式与非流式共用同一熔断器；流式成功闭合；`aiProbe` 绕过+闭合+不触发；mock 不触碰。
- 既有 `r94-ai-fallback` / `r176-fixes` 未改一字，全绿。
- 生产验证待 `suinian-api` 恢复（2026-09-09 15:00 UTC 被删，见 handoff-context）。恢复后口径：在 swe-1.7 故障窗口内取 tail，期望同窗口第二条起 `breaker open, using workers-ai` 且无 20 s 等待；`/health?probe=ai`（admin）观察 `breaker.open` 与 `degraded` 的组合。

## 6. 不做的事

- 不做并发内 hedging（同时发主备取先到）：成本翻倍，且与 R336 的 provider 证据分级（primary/fallback 需可辨）冲突。
- 不做跨实例共享熔断状态（见 §3）。
- 不改 20 s 主模型超时——缩短会误伤 swe-1.7 正常 6–8 s 的长答；熔断器已把「等满一次」的代价从每条请求降到每窗口一次。
