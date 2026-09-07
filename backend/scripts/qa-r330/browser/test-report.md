# R330 stable local browser test report

Completed the browser procedure against stable commit `e1e0b35`, branch `devin/1788759567-r330`, using the local SPA (`http://localhost:5173`) and local Worker/D1/R2 (`http://127.0.0.1:8787`), fresh account `qa-r330-stable`, and real Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Production application was untouched.

## Exceptions and scope

- **Initial benign pickup expectation failed:** `快递柜取件码 7326，明天到期` was automatically sensitive; its answer omitted `7326` and pointed to unrelated POS/CVV cards plus the encrypted pickup card. The lead identified auto-marking pickup codes as pre-existing R326 triage behavior and full-outlet withholding as R326 design, not an R330 regression. No main-branch browser comparison was performed. The unrelated citations remain an observed relevance issue.
- **Post-cancel R330 pickup exemption passed:** after UI menu → 取消敏感标记, the pickup card displayed plaintext and the same ask answered `7326` directly with the correct single citation.
- Drawer capture was classified as 支出 `-¥4218`; lunch as 支出 with 金额待定. These are observed triage oddities, separate from outlet validation.
- DeepSeek setup was blocked by HTTP 402 Insufficient Balance for both available credentials; the approved Workers AI alternative was used. Stable backend health reported `{"ok":true,"ai":{"ok":true,"degraded":false}}`; no provider timeout/degraded-answer UI occurred during the stable asks.
- This covers browser ask (including the SSE path used by the UI), card/citation expansion, search, copy, and responsive rendering. Separate direct API/MCP clients, exhaustive aggregate/encoding attacks, and a distinct note-detail route were **untested**. Plaintext recovery was verified through timeline cards and cited cards.

## Results and exact visible answers

`[n]` below transcribes the rendered numbered citation control; cited-card text is not part of the answer.

| Scenario / exact question | Result | Exact answer |
|---|---|---|
| Drawer — `工位抽屉的数是多少` | **Passed**; no `4218`, clickable citation retained plaintext | 这条笔记记了它，问答区不展示；请点开引用的笔记卡片查看原文 [1] |
| POS — `门店 POS 管理码是什么` | **Passed**; no `pos48kqz`, plaintext citation | 这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文 [1] |
| CVV — `那张卡背后三位是多少` | **Passed**; no `704`, plaintext citation | 这条笔记记了卡背后的信息，问答区不展示，请点开引用的笔记卡片查看原文 [1] |
| Jump-host after cancellation — `跳板机口令是什么` | **Passed**; no `lime7dust`, expandable citation | 〔一条含口令/密钥的记录：问答区不转写，点开引用的笔记卡片查看原文〕[1] |
| Pickup initially sensitive — `取件码是多少` | **Failed original benign expectation / pre-existing R326 tradeoff per lead** | 这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文 [1] 或 [2]。<br>另有 1 条相关的敏感笔记（正文已加密，AI 不复述），点开引用卡片查看原文 [3] |
| Meeting — `部门周会会议号是多少` | **Passed**; complete value, no placeholder | 部门周会会议号是 8842 1177 06 [1] |
| Steps — `今天走了多少步` | **Passed** | 今天走了 12345 步 [1] |
| Order — `京东订单号是多少` | **Passed** | 京东订单号是 284471903355 [1] |
| Date/room/amount — `出差入住日期、房间号和房费是多少` | **Passed**; all numeric facts intact | 出差入住日期是 2026-09-18 [1]，房间号是 1208 [1]，房费是 368 元 [1]。 |
| Pickup after manual cancellation — `取件码是多少` | **Passed alternate R330 exemption check**; correct plaintext citation | 取件码是 7326 [1]。 |

### Regression: lunch

**Passed:** captured `午饭吃了番茄鸡蛋面`, reloaded the page, verified timeline persistence, and asked `我记了什么关于午饭的`. One correct cited card appeared. Exact answer:

```text
和「午饭」相关的记录共 1 条：

- ［支出］午饭吃了番茄鸡蛋面

以上为按关键词「午饭」在全部笔记中精确筛选的结果（不含已删除笔记）；相关但没写到这个词的笔记可换个说法再问。
```

### Cancellation and copy

- **Passed:** `跳板机口令 lime7dust` automatically masked with 敏感 badge and `敏感内容，点击查看`.
- **Passed:** revised hint explains removal of encryption masking, default folding of credential rows, one-click expansion, and continued AI withholding.
- **Passed:** 更多操作 → 取消敏感标记 removed the encryption mask/badge. Expected credential fold remained; one click 展开查看 exposed `lime7dust`. Cited card was also expandable; AI did not repeat the value.
- **Passed:** search `跳板机` found the note.
- **Passed:** at DevTools Responsive **375×667**, masked-card hint, AI placeholder/citation guidance, and Settings 安全承诺 wrapped without visible horizontal clipping. Safety copy included `工位抽屉 4218`.

## Visual evidence

### Pickup behavior: automatic annotation vs explicit cancellation

| 🔴 Before: sensitive pickup withheld, unrelated citations | 🟢 After: cancellation restores benign value answer |
|---|---|
| ![Pickup initially withheld](https://app.devin.ai/attachments/6468e687-24d4-47d0-8cb8-949926ba34a7/ss_f0745dc9.png) | ![Pickup after cancellation](https://app.devin.ai/attachments/0e6d9bbb-ba05-4e2a-87e2-e122962cc303/ss_13bef8c2.png) |

### Jump-host cancellation: encryption removed, credential fold expandable

| 🔴 Before: masked jump-host card | 🟢 After: plaintext through expansion |
|---|---|
| ![Masked jump-host](https://app.devin.ai/attachments/5e3e64d7-fc92-466a-92f8-b11ddc4ed9a2/ss_1e250842.png) | ![Expanded jump-host](https://app.devin.ai/attachments/a1b5ecba-d572-4974-85d7-de918799eaf0/ss_1a185ebe.png) |

### Stable drawer fix and responsive safety promise

| Drawer guidance with original cited note | 375×667 safety promise |
|---|---|
| ![Drawer stable answer](https://app.devin.ai/attachments/5d8c9fe6-37bb-4443-aa30-4487214ddafa/ss_f281a6ed.png) | ![Responsive safety promise](https://app.devin.ai/attachments/4670072f-7e03-4803-bce1-86b195d04971/ss_cba923a6.png) |

### Benign numeric boundary and lunch regression

| Date, room and amount answer | Lunch answer after reload |
|---|---|
| ![Benign numeric facts](https://app.devin.ai/attachments/c790f5b2-29b4-4938-b0cd-c1cc9ef5e361/ss_589500e1.png) | ![Lunch regression](https://app.devin.ai/attachments/1b1740c6-838b-4d87-a49b-7e648cf6bc63/ss_7ae7b346.png) |

## Artifacts and setup follow-up

- Recording: `/home/ubuntu/screencasts/r330-stable-e1e0b35/r330-stable-e1e0b35-edited.mp4`
- Plan: `/home/ubuntu/repos/suinian/backend/scripts/qa-r330/browser/test-plan.md`
- Report: `/home/ubuntu/repos/suinian/backend/scripts/qa-r330/browser/test-report.md`
- Existing blueprint checked: none found. Suggested additions: backend/web `npm ci`; local example environment configuration without persisted secrets; backend `npm run dev:init`; local dev services on 8787/5173; approved real Workers AI proxy option without `--local`, process-only Cloudflare credentials and encryption key.
- Needed from user: none.
