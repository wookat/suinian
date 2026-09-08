# R334 fdbf876 production UI retest

Setup resolved: authenticated existing user u_718775d19cd1, 10 existing notes, maximized Chrome. No new account or local service required.

Code evidence: web/src/components/ask-chat.tsx:151 (citation scroll/ring), :384/:621 (clear confirmation), :605 (Enter); web/src/components/quick-input.tsx:237-243 (quick note Enter); web/src/pages/settings.tsx:1699 (promise). Delta backend/src/index.ts:6440-6479 allows eligible strict verbatim despite intent-only oracle detection; backend/src/triage.ts:305-433 removes deterministic phone classification.

1. Record fresh production UI. Browser-context read meta build and fetch /health; both must equal fdbf876e9de8224cc108897a7cfc4f06ec3b6cab. Fetch /health?probe=ai, report actual degraded state, not inferred per-question provider.
2. Click 首页 问答 → 清空对话 → 清空. Send exact Q11:
   请根据我记的青禾牙科、蓝鲸读书会和星河展览，分别用三段说明每个活动的具体时间地点，并在每段末尾标引用。每段先说已记下的事实，再用一句话区分笔记没有提供的信息，不要补造。
   After done: three aligned markers/cards; dental 2026-09-12 下午三点; reading club 周六上午十点 湖畔书店; exhibition 下午两点半 东门. No invented dates, omitted-fact placeholders, 没找到, or card hints replacing facts. Capture partial pre-done pixels live or extract an unmodified recording frame.
3. At least 5 seconds after completion send exact Q12:
   请根据我记的栀子花浇水、烘焙课堂司康和海鸥跑团，分别用三段整理每项的数量和单位。每段先说事实，再解释这个数字对应什么，附上引用。不要添加笔记没有的数据。
   After done: 250 毫升, 80 克, 120 毫升, 六公里, three aligned markers/cards, no omission or false not-found. Click [2], capture the matching 司康 card ring/scroll.
4. Send 把我记的山茶色围巾那条笔记原文一字不改地发给我.
   Expect 山茶色围巾放在衣柜第二层的白色收纳盒。 with one marker/card; no 原文请点开引用的笔记卡片查看 or 关于原文回显的说明.
5. Close Ask; in 快速记录 paste exactly one new note [QA-R334] 爸爸的电话 13987654321 and Enter. Wait for category/tags (triage completion), verify plaintext/no sensitive masking, do not override any flag. Reopen Ask and ask 爸爸的电话号码是多少. Expect 13987654321 directly, one marker and matching card.
6. 设置: scroll to 安全承诺, capture exact required first sentence, count once. Navigate /known-issues and capture MCP notes[] behavior, 编号类善意扣留, 长答省略 entries.
7. Stop recording. Upload only fresh safe screenshots; overwrite test-report.md with exact question/answer, counts, verdicts, identity/degraded, evidence limits, and absolute artifact paths. Leave account and notes intact.
