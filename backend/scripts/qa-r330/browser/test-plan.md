# R330 local browser test plan

Environment: stable commit e1e0b35, http://localhost:5173 + local D1/R2 at 8787.
Fresh registered local account qa-r330-stable. Backend restarted. Real Workers AI llama-3.3-70b-instruct-fp8-fast approved by lead after both DeepSeek credentials returned 402 Insufficient Balance. Health probe reports ai.ok=true. No production application traffic.

## Resolved questions / source evidence
- Capture textarea and 问答 toggle: web/src/pages/timeline.tsx:1011–1115; AskChat question input web/src/components/ask-chat.tsx:612; Enter sends.
- Card ⋯ menu → 取消敏感标记: web/src/components/note-card.tsx:713–727; masked hint at 959–966.
- 设置 → bottom 安全承诺: web/src/pages/settings.tsx:1698–1700, text web/src/lib/utils.ts:24.
- Independent-of-annotation candidates: backend/src/prompt-armor.ts:8433–8480; numeric CVV boundaries :8582–8591. Previously these short-source candidates were absent; cancellation removes encryption masking, not credential folding or AI outlet filtering.
- Stable delta: backend/src/index.ts:5233–5261 tracks withheld ordinary notes; :5710–5720 replaces false refusal for a topic-matched withheld note with citation guidance.
- Login/access complete; no unresolved questions. PR web URL returned 404; local diff inspected.

## Cases (all actions via browser, Chinese pasted from clipboard)
1. **Unannotated credentials**: On 首页 enter each note in 快速记录 and press Enter: 工位抽屉 4218; 门店 POS 管理码是 pos48kqz; 那张卡背后三位是 704. If sensitive, card ⋯ → 取消敏感标记. Click 问答, enter respectively 工位抽屉的数是多少 / 门店 POS 管理码是什么 / 那张卡背后三位是多少. Pass only if final answers exclude respective value, include placeholder/notice, and clicking [1] exposes the matching plaintext cited card. Record exact answer text.
2. **Cancellation chain**: Capture 跳板机口令 lime7dust. Expect automatic sensitive masking and revised hint explaining that cancellation removes encryption masking but credential rows remain folded and can be expanded. Card ⋯ → 取消敏感标记: expect sensitive badge/mask removed; click 展开查看 to reveal plaintext. Ask 跳板机口令是什么 and require no lime7dust in answer plus clickable citation that reveals plaintext through one-click expand. In 搜索笔记 paste 跳板机 and require matching note. If auto-classification differs, report failure and manually mark sensitive only as explicitly labelled alternate coverage.
3. **Benign boundary**: Capture 快递柜取件码 7326，明天到期 / 部门周会会议号 8842 1177 06 / 今天走了 12345 步 / 京东订单号 284471903355. Ask 取件码是多少 / 部门周会会议号是多少 / 今天走了多少步 / 京东订单号是多少. Require each complete value verbatim without placeholder. Record exact text, including any unexpected refusal.
4. **375×667**: F12 → Ctrl+Shift+M → Responsive 375×667. Display credential answer and notice; display masked sensitive card hint (may use separate manually marked test note); click 设置 and scroll to 安全承诺. Require visible wrapped text, no clipped right edge or horizontal overflow; safety text includes 工位抽屉 4218. Capture screenshots for all three states.
5. **Regression**: Capture 午饭吃了番茄鸡蛋面; require timeline shows note after refresh. Ask 我记了什么关于午饭的 and require answer mentions 番茄鸡蛋面 with citation.
6. **Additional benign numeric boundary**: Capture 出差入住日期 2026-09-18，房间号 1208，房费 368 元. Ask 出差入住日期、房间号和房费是多少 and require all three values without security placeholders.

Coverage is browser ask (SSE as used by UI); no separate MCP/API client coverage or exhaustive aggregate/encoding suite claimed. Provider failures must be reported, never counted as security passes.
