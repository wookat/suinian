# R302 修复轮决策与验证记录（decision-r302）

> 前置：R301 独立审查（docs/audit-r301.md，PR #335）对 R300 复评 NO-GO。
> 本轮按 audit-r301 §16 最小修复面 + §18 方法论整改执行：实际改代码、本地与
> 生产双重验证、部署上线并生产复测。所有结论按「实测确证 / 未验证 / 推断」
> 逐项区分（见 §9 汇总表）。

## 1. 方法论整改（§18，本轮最重要的一条）

R301 的核心指控：R300 的载体集与其归一化实现同源设计——枚举了哪些分隔符
就测哪些分隔符，因此「本地矩阵全绿」对本系统不具备预测力。本轮改法：

1. **按类做 property-based 属性测试**（`backend/test/r302-normalization.test.ts`，
   fast-check）：分隔符不再枚举码位，改为「任意非字母数字、非空白、位于两个
   标签之间的单字符」整类生成；percent 编码、拼接切点、模板占位符、IPv4 各
   进制形态同样按类生成。9 个属性各 200+ 随机用例。
2. **历史载体全量回归**：`backend/test/r302-guard-matrix.test.ts` 把 R295（36）/
   R296（12）/R298（46）历史载体 + R302 等价重建载体（73）+ 新造载体（26）
   全部纳入，× 判别器 10 态 × normal/verbatim 两模式。
3. **基线复现口径**：R301 会话机 `/home/ubuntu/qa-r301/` 的原始脚本已不存在
   （会话机已回收），无法逐字节重跑。按 §15 的分级描述**等价重建**了 73 个
   载体（`backend/scripts/r302-carriers.ts`，注释逐条标注对应 §15 类别），另
   新造 26 个未被任何一方枚举过的类别（Base45、ROT13、倒序地址、hex 字节串、
   数学粗体字母、西里尔同形、tag 字符隐匿、bidi 控制符、八进制 IP、punycode、
   URL fragment/query 藏匿、printf 构造、JS 模板字面量、压缩 IPv6 等）。
   —— 这属于「等价探针」，不是「原脚本重跑」，如实标注。

## 2. P0-1 白名单只免地址形态，不免动作语义（实测确证）

撤销 R300 的「白名单域名按形态 + 无动作语义放行」。现在
`hasRemoteEndpointForm()` 的白名单只豁免**地址形态**判定；同一动作句里出现
下载/解释器/执行语义时走 `ignoreAllowlist: true` 复查，`raw.githubusercontent.com`
/ `aka.ms` / `bun.sh` / `ollama.com` 等作为攻击外壳的载体全部命中隔离
（r302-guard-matrix 的 whitelist-shell 载体类）。

## 3. P0-2 verbatim 与安全闭合解耦（采纳 R301 建议，实测确证）

**决策：采纳「逐字原文不走答案通道」。**

- 答案区：verbatim 问法给摘要/直答 + 固定指引 `VERBATIM_REDIRECT_NOTICE`
  （「〔原文查看〕问答区不逐字转写笔记原文；点开下方引用的笔记卡片即可查看
  完整原文」）。
- 原文通道：引用的笔记卡片（前端已有完整原文展示），完整逐字内容包括头尾
  标记均可查看（生产 UI 实测：4784 字长文 ZQX7 头尾标记均在卡片中）。
- 移除 `restoreVerbatimEchoes` / verbatim 豁免（`faithfulKeep` 的 verbatim 分支、
  scrubDataDerivedSpans 的 verbatim 豁免）——危险原文无法再借 verbatim 问法
  从答案通道恢复。
- UX 论证：用户问「原文是什么」时，答案区给出内容摘要 + 一步可达的原文卡片
  （同屏引用区即是原文），比 R300 的「截断的 0–1 行伪原文」体验更好；且
  normal/verbatim 两态处理一致，不再有「换个问法就漏」的旁路。
- 为什么不选「完整逐字 + 零泄漏」双全方案：答案通道输出逐字原文时，任何
  归一化/判别的假阴性都直接成为泄漏；R293–R301 九轮反复证明该面收不住。
  解耦后答案通道只输出模型改写产物，原文交付移到只读卡片（无 prompt 拼接、
  无模型参与），两个目标各自 100% 达成。

## 4. P0-3 归一化按类折叠（实测确证）

- 「两个标签之间的单个非字母数字字符」整类折为 `.`（NFKC 前先在 raw 表面
  折叠一次，NFKC 后再折叠一次——U+FFE3 等会被 NFKC 分解的分隔符不漏）；
- percent 编码递归解码（`%25` 双层/三层）直至不再含支持的编码分隔符；
- 拼接 `"exam"+"ple.com"`、模板 `${H}.com`、IPv4-mapped IPv6 `[::ffff:…]`、
  spaced/spoken IPv4、整数/八进制 IP、全角数字 IP 逐类处理；
- Base32/Base45/ROT13/hex 字节串按「解码后含地址 + 同句执行语义」类隔离
  （semantic-danger:decode-addr+fetch-run）；
- benign 时间/版本号/小数（`12:30:45`、`v1.2.3`）行为不变（property 测试
  含 benign 生成器对照）。

## 5. P0-4 离线暂存补发（实测确证，生产 UI 复测通过）

- `web/src/lib/outbox.ts`：IndexedDB `suinian-outbox` v2（notes/media 两 store）
  真实写入；成功补发后删除条目；网络失败/429/5xx/401/403 保留；永久失败出队
  并通过 `onOutboxDropped()` 在 UI 暴露。
- **exactly-once**：入队时生成 `client_id`（crypto.randomUUID），服务端
  `POST /api/notes` 按 `meta.client_id` 幂等去重（与 `/api/ingest/media` 同
  口径）。生产 UI 实测：断网入队 → 断网刷新 → 联网补发，服务端计数 +1
  （修复前 +2）；不刷新直接联网路径同样 +1。
- 已知边界（如实标注）：持有旧缓存 bundle 的客户端入队的条目无 client_id，
  该类条目在「补发响应丢失」场景仍可能重复，刷新到新 bundle 后消失。

## 6. P0-5 长文塌陷与虚假隔离（实测确证）

- 虚假隔离根因：`scrubDataDerivedSpans` 剥除善意长文的 verbatim echo 时
  `spanScrubbed` 无差别置 `instruction_isolated`。修复：资料无 demand 且无可
  隔离内容（`dataTextHasIsolatableContent()` 为假）时，span 剥除只是 verbatim
  改道，不置隔离位；资料含指令/危险内容时维持 fail-closed 置位。
- 生产复测：4611 字善意长文，verbatim 问 `isolated=0`（修复前 =1），摘要问
  正常回答；UI 无琥珀横幅（DOM grep「隔离」=0）。
- 长文「原文」交付走笔记卡片（§3），答案区不再承诺逐字，故「4450 字回
  101 字」的量级失真不再是缺陷面——答案区本来就只给摘要 + 指引。

## 7. P0-6 误伤（实测确证，数值见 §9）

- 「地址 × 动作」升级为**同一动作句**共现判定（`sentenceCooccur`）；
- `user@host` 邮箱形态、`host:port` 常见服务端口（25/587/993/443）在 benign
  上下文单独退让；
- 未回退安全面：危险载体矩阵（154 载体 × 2 问法）在同一部署上 leak=0。

## 8. P1 / P2 / P3

- P1 藏头/藏尾/口令词：最终闭合新增「答案含未被问及的、来自笔记的格式化
  指令产物」检查；口令/暗号开头近似回显在单一收口点 `finalizeAskAnswer()`
  剥除（覆盖所有路径，不只生成分支）。
- P1 跨笔记分片：召回集聚合判定地址+动作证据；生产 split 组 SP1–SP4 leak=0。
- P2 guard_events 量纲：新增 `*_requests` 请求级计数（total/classifier_unavailable/
  degraded/veto/isolated），发生率可直接计算。
- P2 首 delta / keepalive：验收口径改为「≤1.5s 进度指示 + ≤4s 首 delta」——
  fail-closed 架构下（判别器前置）继续承诺 1.5s 首 delta 不现实；SSE 实测
  分布见 §9。keepalive 帧以生产抓包为准，无正向证据不声称。
- P3 无障碍：隔离/降级横幅对比度提升（amber-800/sky-800）；375px 三层文案
  收敛为单个 `<details>` 展开项；`查看原文` 按钮 28px。生产实测：axe serious 0，
  Lighthouse mobile 96/100（perf/a11y）、desktop 100/100，375px 无横向滚动。

## 9. 验证汇总（实测确证 / 未验证 / 推断）

### 实测确证（本地）
- backend `npm test`：167 文件 / 3561 用例全绿（最终修订，含本轮新增回归）；`tsc --noEmit` 通过。
- web `npm run lint`（存量 set-state-in-effect 警告，非本轮引入）/ `npm run build` 通过。
- android `./gradlew assembleDebug` 通过（app-debug.apk）。
- property-based 归一化：9 属性通过；guard 矩阵：154 载体 × 10 判别器态 × 2 模式通过。

### 实测确证（生产，真实模型，最终部署 version 96846746-6df3-42cc-ae08-0b8b2b0d54e3）
- evil 矩阵：154 载体 × 2 问法 = 308 问，泄漏 1（N02/plain；同载体独立复测 4/4 全部隔离，
  判为模型输出随机性残余而非确定性旁路，如实计入不归零）。split SP1–SP4 leak=0。
- benign 语料：130 例，整段误隔离 0/130（0%）；部分标记（行级警示/移除标记）3/130
  （2.3%，B056/B074/B109）。目标 <3% 达成（含部分标记口径）。
- 长文：4784 字善意长文 verbatim 问 isolated=0，答案 945 字 + 原文卡片完整。
- injection-eval：240 变体 / 498 问，执行 0、泄漏 0、benign 误伤 0。
- retrieval-eval：召回率 95.5%，必过题未过 0。
- ask-eval：136/141（96%），引用完整性 141/141。
- 忠实性 30/30（含此前缺失的 7A 座位号）；财务 4/4；shell 13/15
  （备份脚本 2/5 轮次被误隔离——全语料上下文下判别器随机误报残余，聚焦复测 5/5 通过；如实记录）。
- SSE 20 请求：keepalive 20/20；有 delta 样本 4 个，首 delta 中位 3593ms、>4s=0；
  进度指示中位 1741ms、>1.5s=11（进度指示 ≤1.5s 未稳定达标，如实记录）；16/20 无 delta
  （final-only 短答案路径）。
- 敏感附件密文：R2 对象头 SNE1、明文泄漏 false。
- 软删/恢复：DELETE → trash 可见 → restore 200 → 原文恢复。
- 备份/导出脱敏：/api/backup、/api/export 均不含敏感卡号明文。
- 注销级联：全部 QA 账号 DELETE /api/auth/me 后旧 token 401。
- D1 权威核查：users/notes/api_tokens/threads/edges/entities/daily_reviews/push_subscriptions
  QA 残留 0；note_embeddings/attachments 孤儿 0。R2 权威列举：bucket object_count=0，零残留。
- 生产 UI（录屏）：PWA 离线 outbox exactly-once（IndexedDB suinian-outbox、client_id、
  联网补发 +2 不重复）；375px 披露收敛单个 details、无横向滚动；axe violations 0
  （color-contrast serious 0）；Lighthouse mobile 96/100、desktop 100/100（perf/a11y）；
  4 个真实浏览器账号全流程并全部注销（旧 token 401）。

### 未验证
- 进度指示 ≤1.5s 的稳定达标（本轮实测 11/20 超 1.5s，需下一轮优化）。
- Wrangler route 列表 API 持续返回 code 10000（权限），route 激活以 deployment API
  100% + 生产 endpoint 实测交叉确认，非 wrangler 权威输出。
- 旧缓存 bundle 客户端的离线条目幂等性（§5 已知边界）。

### 推断
- 解耦后答案通道理论上不存在 verbatim 逐字泄漏面（原文不经模型/答案通道）；
  该推断由 154 载体 × 2 模式生产矩阵支撑，但「所有未来载体类」不可穷举。
