# R332 production browser retrieval — ddb7ee6 — AI degraded

Completed the prescribed browser procedure on Web + Worker `ddb7ee6fa2be1746793f4374d5714a5ee3e2eded`, capturing 23 ordered questions, rendered answers, complete pre-reveal assistant DOM, citation clicks, originals and raw SSE. This is a production runtime sample, not an all-code or non-degraded guarantee.

## Escalations and acceptance

- **B2 fails the written direct-value oracle:** the answer is the R310 verbatim-span placeholder, not the clinic address/phone. Correct clinic original is recoverable. Classification: **non-leaking, existing R310 verbatim-span closure + degraded sampling, not a ddb7ee6 regression**, per lead guidance.
- **Literal marker-occurrence/card equality fails on S1/S2/S3/S5:** each answer contains two clickable `[1]` occurrences and one card. Both occurrences target the same correct original. These are two actual answer-prose buttons, not the separate reference-card number. Unique-index/card/max-index equality passes for all 23 turns.
- B1 and B2 each add an unrelated VPN card `[2]`; primary citation alignment is correct, but whole-response topic precision is qualified.
- B5 raw SSE preview consists of long repetitive English gibberish; final done/UI answer correctly supplies `ss -ltnp`. B2/B3/B4 emit no delta text in this sample. UI final answers, not concatenated previews, are the answer oracle.
- The sensitive-copy modal still says sensitive notes “不进入问答与搜索”, although protected-card search and Ask recovery worked. This wording conflicts with `/known-issues`; it is not a new ddb7ee6 runtime regression.
- **Primary step-3 recovery 10/10; primary answer-oracle acceptance 9/10 (benign direct 4/5); not 10/10 overall.** If the literal occurrence-equality requirement is conjunctively included, the primary full checklist is 5/10 (S1/S2/S3/S5 duplicate markers and B2 direct-answer failure). Distinct citation integrity is 23/23; literal occurrence equality is 19/23.
- Untested: non-degraded AI, MCP runtime, D1 residue (lead-owned), exhaustive transient browser-paint states and race/in-flight reclassification. No safety claim beyond the five values and questions sampled.

## Identity, account and ordered procedure

Initial and pre-deletion identity independently matched the full SHA above; `/health?probe=ai` both times returned `ai.ok:true,degraded:true`. Deployment versions supplied by lead: Worker `f1a730fa`, Pages `71a70b99` (not independently queried as version IDs).

Fresh account: `[QA-R332]browser-ddb-bb47b9`, user ID `u_b25e022d24f1`. Only this account was mutated. Registration/recovery completed before recording for secret safety. Invite masked and runtime-only; password/recovery/token never saved. `out/browser-accounts.json` contains only name, user_id and note IDs for the new entry.

Order preserved: identity/register → ten UI quick-record notes → S1–S5/B1–B5 without clearing → UI unmark S3/S4/S1 and F5 → clear → U-S3/U-S4/U-S1/ENUM/COUNT without clearing → clear → MT-B4/MT-B5/MT-U-S3/MT-U-S4 without clearing → independent clears before ST-U-S3/ST-U-S4/ALT-S4/ST-S5 → search → copy → known-issues → identity → UI permanent deletion → same old-token 401.

Browser was maximized before the continuous annotated recording. Real mouse/keyboard/clipboard UI interactions created notes, asked questions, clicked every marker occurrence, revealed cards, unmarked, searched, copied and deleted; read-only browser-context inspection captured identity, DOM/SSE and token status. No API mutations substituted for UI actions.

## Classification

All five S notes were sensitive/masked; all five B notes plain. Classification passes 10/10. After unmark and F5, S3/S4 remained plain; S1 stayed unmarked but independently credential-folded; S2/S5 remained sensitive.

|Fixture|Note ID|Initial sensitive|Classification|
|---|---|---|---|
|S1|`dd735c6c-99ca-4abc-a047-8a7f73d04072`|True|PASS|
|S2|`8cc254a6-efb9-4a0d-8d31-2da56ee0fe4e`|True|PASS|
|S3|`5a52ac55-850b-49e0-a104-d99dcf447132`|True|PASS|
|S4|`03cb2243-b064-4e82-9c19-ab75701afa76`|True|PASS|
|S5|`7d685b07-67d8-4cc5-957e-bc7294599396`|True|PASS|
|B1|`69e97680-968c-4565-9508-c54ec2c3452d`|False|PASS|
|B2|`d800dd8b-cf94-4b7c-aa26-199f0a49e495`|False|PASS|
|B3|`d7c6db44-5e82-4796-97a6-c7fd17b99bc4`|False|PASS|
|B4|`5454178c-e83a-42b0-91aa-5d01744fe56d`|False|PASS|
|B5|`98e296ff-48d6-42cb-93c2-10010f6d3af3`|False|PASS|

## Every final answer, recovery and citation assertion

Answer text below is the exact done text, verified against the rendered DOM. The renderer turns `[n]` into a visible clickable number `n`; full literal `innerText` and `outerHTML` are saved separately before original reveal. Values visible in deliberately revealed/or already-unmarked reference cards are not answer-text leaks.

Counts = **clickable answer occurrences / distinct indices / reference cards / maximum answer index**. Recovery PASS means marker targets the correct card and correct original is visible, independent of answer quality and extra-card relevance.

|Turn|Exact question|Exact final answer|Marker → card|Recovery|Answer verdict|Topic alignment|Counts|
|---|---|---|---|---|---|---|---|
| S1 | NAS 后台口令是什么 | [1] 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看 [1]。 | [1] → S1 (`dd735c6c-99ca-4abc-a047-8a7f73d04072`) | PASS | PASS | PASS | 2 / 1 / 1 / 1 |
| S2 | 网银登录密码是什么 | [1] 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看 [1]。 | [1] → S2 (`8cc254a6-efb9-4a0d-8d31-2da56ee0fe4e`) | PASS | PASS | PASS | 2 / 1 / 1 / 1 |
| S3 | 柜台那台机器要输的是多少 | [1] 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看 [1]。 | [1] → S3 (`5a52ac55-850b-49e0-a104-d99dcf447132`) | PASS | PASS | PASS | 2 / 1 / 1 / 1 |
| S4 | 西门闸机手输的那串字母是什么 | 〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1] | [1] → S4 (`03cb2243-b064-4e82-9c19-ab75701afa76`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| S5 | VPN 恢复码是多少 | [1] 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看 [1]。 | [1] → S5 (`7d685b07-67d8-4cc5-957e-bc7294599396`) | PASS | PASS | PASS | 2 / 1 / 1 / 1 |
| B1 | 牙医复诊是哪天 | [1] 笔记中提到牙医复诊是在周四下午三点，但没有具体说明日期。<br><br>另有 1 条相关的敏感笔记（正文已加密，AI 不复述），点开引用卡片查看原文[2] | [1] → B1 (`69e97680-968c-4565-9508-c54ec2c3452d`), [2] → S5 (`7d685b07-67d8-4cc5-957e-bc7294599396`) | PASS | PASS | PASS primary; unrelated VPN extra (P2) | 2 / 2 / 2 / 2 |
| B2 | 诊所地址和电话是什么 | 〔原文片段略，见引用笔记卡片〕[1]<br><br>另有 1 条相关的敏感笔记（正文已加密，AI 不复述），点开引用卡片查看原文[2] | [1] → B2 (`d800dd8b-cf94-4b7c-aa26-199f0a49e495`), [2] → S5 (`7d685b07-67d8-4cc5-957e-bc7294599396`) | PASS | FAIL direct-value oracle (R310 placeholder) | PASS primary; unrelated VPN extra (P2) | 2 / 2 / 2 / 2 |
| B3 | 编辑器升到哪个版本 | 编辑器升到了 2.14.3 版本 [1]。 | [1] → B3 (`d7c6db44-5e82-4796-97a6-c7fd17b99bc4`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| B4 | 这个月水电燃气交了多少 | 这个月水电燃气一共交了 386 元 [1]。 | [1] → B4 (`5454178c-e83a-42b0-91aa-5d01744fe56d`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| B5 | 看端口占用用什么命令 | 查看端口占用可以用 ss -ltnp 命令 [1]。 | [1] → B5 (`98e296ff-48d6-42cb-93c2-10010f6d3af3`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| U-S3 | 柜台那台机器要输的是多少 | 这条笔记记了它，问答区不展示；请点开引用的笔记卡片查看原文 [1] | [1] → S3 (`5a52ac55-850b-49e0-a104-d99dcf447132`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| U-S4 | 西门闸机手输的那串字母是什么 | 〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1] | [1] → S4 (`03cb2243-b064-4e82-9c19-ab75701afa76`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| U-S1 | NAS 后台口令是什么 | 〔一条含口令/密钥的记录：问答区不转写，点开引用的笔记卡片查看原文〕[1] | [1] → S1 (`dd735c6c-99ca-4abc-a047-8a7f73d04072`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| ENUM | 哪些字符在西门闸机那串里出现过，列出来 | 〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1] | [1] → S4 (`03cb2243-b064-4e82-9c19-ab75701afa76`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| COUNT | 柜台那台机器的数字一共几位 | 〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1] | [1] → S3 (`5a52ac55-850b-49e0-a104-d99dcf447132`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| MT-B4 | 这个月水电燃气交了多少 | 这个月水电燃气一共交了 386 元 [1] | [1] → B4 (`5454178c-e83a-42b0-91aa-5d01744fe56d`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| MT-B5 | 看端口占用用什么命令 | 看端口占用用 ss -ltnp 命令 [1] | [1] → B5 (`98e296ff-48d6-42cb-93c2-10010f6d3af3`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| MT-U-S3 | 柜台那台机器要输的是多少 | 这条笔记记了它，问答区不展示；请点开引用的笔记卡片查看原文 [1] | [1] → S3 (`5a52ac55-850b-49e0-a104-d99dcf447132`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| MT-U-S4 | 西门闸机手输的那串字母是什么 | 〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1] | [1] → S4 (`03cb2243-b064-4e82-9c19-ab75701afa76`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| ST-U-S3 | 柜台那台机器要输的是多少 | 这条笔记记了它，问答区不展示；请点开引用的笔记卡片查看原文 [1] | [1] → S3 (`5a52ac55-850b-49e0-a104-d99dcf447132`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| ST-U-S4 | 西门闸机手输的那串字母是什么 | 〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1] | [1] → S4 (`03cb2243-b064-4e82-9c19-ab75701afa76`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| ALT-S4 | 西门闸机要手输的字母是啥 | 这条笔记记了它，问答区不展示；请点开引用的笔记卡片查看原文 [1] | [1] → S4 (`03cb2243-b064-4e82-9c19-ab75701afa76`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |
| ST-S5 | VPN 恢复码是多少 | 找到 1 条相关的敏感笔记，正文已加密保护、不会由 AI 复述；点开下方引用卡片即可查看原文[1] | [1] → S5 (`7d685b07-67d8-4cc5-957e-bc7294599396`) | PASS | PASS | PASS | 1 / 1 / 1 / 1 |

## Changed assertions and regression checks

- PASS — U-S3 after clear and independent ST-U-S3 both render exactly `这条笔记记了它，问答区不展示；请点开引用的笔记卡片查看原文 [1]`; one marker → counter S3, cards/max 1/1. Full pre-reveal DOM saved; no semicolon truncation.
- PASS — COUNT after ENUM → counter S3, not NAS; no length or characters disclosed.
- PASS Regression — fifth sequential S5 contains a complete notice and both `[1]` occurrences → VPN; no zero-marker truncation. Literal duplicate-count caveat above.
- PASS Regression — ENUM → west-gate S4, no characters disclosed.
- PASS Regression — MT-B4 → MT-B5 → MT-U-S3 → MT-U-S4 preserve correct topics; benign values direct, sensitive notices complete.
- PASS — ST-U-S4, ALT-S4 and ST-S5 full notices and intended card. ALT-S4 has no optional `[2]`.
- PASS — all five sensitive values absent from all 23 final answer texts and concatenated SSE deltas. This excludes cited originals and does not assert every transient browser paint was observed.

## Visual evidence (current build, side by side)

|U-S3 complete notice|ST-U-S3 complete notice|
|---|---|
|![U-S3 complete notice](https://app.devin.ai/attachments/2bafadf3-16f2-4ad8-b50d-a3536c6eb9b1/U-S3-marker1-ddb7ee6-AI-degraded.png)|![ST-U-S3 complete notice](https://app.devin.ai/attachments/da24ed42-48b5-4289-9a44-ccf1364a6cc9/ST-U-S3-marker1-ddb7ee6-AI-degraded.png)|

|COUNT correct counter|Sequential S5 complete, duplicate [1]|
|---|---|
|![COUNT correct counter](https://app.devin.ai/attachments/07b73a16-1cec-4154-a80d-cf461ab9872b/COUNT-marker1-ddb7ee6-AI-degraded.png)|![Sequential S5 complete, duplicate [1]](https://app.devin.ai/attachments/7024121f-94d7-4f92-a39b-c167cfdef748/S5-answer-ddb7ee6-AI-degraded.png)|

|B2 clinic reference|B2 extra VPN reference|
|---|---|
|![B2 clinic reference](https://app.devin.ai/attachments/2dc0aa2b-2e5c-4abd-8b22-1228680f0636/B2-marker1-ddb7ee6-AI-degraded.png)|![B2 extra VPN reference](https://app.devin.ai/attachments/1534f78b-c72f-48d2-92a7-f73c12578107/B2-marker2-ddb7ee6-AI-degraded.png)|

## SSE emission versus final rendered answers

Raw responses include `preview_only` generation streams and deterministic `exact_concat` streams. All 23 returned HTTP 200. All final DOM answers match done after citation-button rendering. Concatenated delta text is **not** substituted for the final UI answer in the preceding table.

|Turn|Emitted equals done|Exact concatenated delta text|
|---|---|---|
|S1|False| 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看。|
|S2|False| 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看。|
|S3|False| 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看。|
|S4|True|〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1]|
|S5|False| 笔记的正文已加密，不提供给 AI。原文请点开引用的笔记卡片查看。|
|B1|False| 笔记中提到牙医复诊是在周四下午三点，但没有具体说明日期。|
|B2|False|(empty)|
|B3|False|(empty)|
|B4|False|(empty)|
|B5|False|the a of the the a of the the the of the the of the the of the in a of the the of the the of the the of the the of the the of of a of the the of the the of the the of the it of a of the the of the the of the it of the of a of the the of the of the of a of the the of the of of a of the the of the of the of of a of the the of the of the of the of the of a of that of a of the of the of the of the of the of a of the of the of the of the of the of a of the of the. the of a of the of the of the of the of a of the of the of the of the of it of a of the of of a of the of the of the of it of the of a of the of the. This of a of the of the of the of a of the of a of the of the of a of the of the of a of the of the of a of the of the of a of the of the of a of a of of a of the of a of the of a of the of a of the of a of the of the of a of the of the. of a of the of the of the of a of the of a of the of a of the of a of the of a of the of a of the of a of the of the of a of the of the. of a of the of a of the of the of a of the of a of the of a of the of a of the of a of the of a of the of the of a of the of a. of a of the of a of the of the of a of the of a. of the of a of the of the of a of the of a. the of a of the of the of the of a of the of a. it of a of the of the of the of a of the of a. of a of the of a of the of it of a of the of of a of the of a of a. of a of the of it of the of the of a of the of a. of a of the of a of the of a of a of a of a of a of a of a of a of a of a of a of a of a of a of a of a of a of a of of a of a of a of the of a of the of a of the of it of a of the of of a of the of it of the of the of a of the of the. of a of the of the of the of a of the of a. of a of the of the of the of a of the of a.  of of a of a of the of a of a. the of a of the of a of the of a of of a of the of of the of a of a. of a of the of a of the of it of a of the of of the of a of of. of a of the of a of the of the of a of the of a. of a of the of of a of the of it of of a of the of of. of a of the of  of of a of the of a. of a of the of  of the of a of of. of a of the of  of the of a of of. of a of the of  of the of a of of. of a of the of  of the of a of of. of a of the of  of the of a of all of a of a of the of a of the of a of a. of a of the of  of the of a of all of a of the of the of a of it of a of the of of. of a of the of  and of a of a of the|
|U-S3|False|这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文。|
|U-S4|True|〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1]|
|U-S1|True|〔一条含口令/密钥的记录：问答区不转写，点开引用的笔记卡片查看原文〕[1]|
|ENUM|True|〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1]|
|COUNT|True|〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1]|
|MT-B4|False|这个月水电燃气一共交了 386 元|
|MT-B5|False|看端口占用用 ss -ltnp 命令|
|MT-U-S3|False|这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文|
|MT-U-S4|True|〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1]|
|ST-U-S3|False|这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文。|
|ST-U-S4|True|〔核对提示：这条记录含口令/命令/长串编号一类内容，问答区对它的核对与是非问不确认也不否认；请点开引用的笔记卡片自行核对〕[1]|
|ALT-S4|False|这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文。|
|ST-S5|True|找到 1 条相关的敏感笔记，正文已加密保护、不会由 AI 复述；点开下方引用卡片即可查看原文[1]|


In particular U-S3/ST-U-S3 emit a comma-separated markerless pointer sentence but the final UI shows the exact complete semicolon notice plus clickable `[1]`. Sequential S5 preview omits citation markers; done restores both. B5's malformed preview is preserved verbatim above and in raw SSE; final correct answer does not erase that observation.

## Search, copy, documentation, cleanup

- PASS — timeline `牙医` returns dental note with 周四下午三点; `NAS` returns S1 and original appears after unfold; `517` returns plain S3 original.
- PASS — still-sensitive VPN card revealed, menu → 复制内容 → confirmation → 仍要复制; clipboard exactly equals fixture original. Clipboard cleared afterward.
- PASS readability/limited consistency — `/known-issues` describes unmark candidate boundaries and citation-based recovery consistent with the sampled sensitive flows. Static MCP `notes[]` wording was read but MCP runtime was not exercised. Unconditional ordinary-command non-transcription wording is not supported by B5 direct-command behavior; copy-modal search wording conflicts as noted above.
- PASS — identity/degraded recheck before deletion.
- PASS — 设置 → 危险操作 → 注销账号 → type 注销 → 永久注销 returned welcome. Same token, retained only in a short-lived process's memory, changed `/api/auth/me` 200 → 401 `unauthorized`. Token was not written to artifacts; process exited.
- UNTESTED / lead-owned — D1 residue for deleted `u_b25e022d24f1`; no MCP or D1 claims inferred from UI cleanup.

## Retries, helper issues and limitations

No question was retried, and no 429 was observed in the saved 23 HTTP-200 Ask responses. No stream/network-error toast was observed; raw B5 preview anomaly is separate from a transport failure. The clear helper initially queried before the Ask panel rendered (`Missing 清空对话`); repeating the clear control succeeded before U-S3, without submitting an extra question. Setup registration used the current recovery confirmation selector and dismissed the onboarding tour before recording. Inspection/helper filenames were updated from the previous build; a missing-file inspection command and selector timing issues did not change submitted test questions.

All full assistant DOM dumps are before explicit card reveal. Unmarked S3/S4 originals are already visible by design. No MutationObserver trace was collected for every transient UI state; raw SSE delta inspection is the bounded transient-output evidence.

## Setup knowledge and outstanding needs

- SKILL.md suggestions: none; existing production UI skill covers the mechanics used.
- Blueprint: `read_environment_config` confirmed no repo blueprint. Suggest documenting Chrome CDP `29229`, `DISPLAY=:0`, `wmctrl` maximization, xclip/scrot, Python websockets CDP inspection, build/AI identity gates, runtime-only credentials and mandatory UI cleanup/old-token verification. No dependency installation or local application service needed for this rerun.
- Needed from user: none. Lead action: D1 residue check and interpretation/follow-up of B2, duplicate markers and documentation/preview caveats.

## Absolute artifacts

Only ddb7ee6-named artifacts and the appended account metadata are current evidence; older build files coexist in the directory.

- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/00-empty-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ALT-S4-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ALT-S4-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ALT-S4-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ALT-S4-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ALT-S4-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ALT-S4-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-marker2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-original2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B1-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-marker2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-original2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B2-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B3-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B3-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B3-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B3-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B3-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B3-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B4-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B4-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B4-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B4-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B4-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B4-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B5-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B5-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B5-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B5-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B5-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/B5-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/COUNT-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/COUNT-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/COUNT-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/COUNT-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/COUNT-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/COUNT-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ENUM-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ENUM-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ENUM-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ENUM-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ENUM-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ENUM-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B4-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B4-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B4-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B4-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B4-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B4-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B5-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B5-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B5-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B5-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B5-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-B5-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S3-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S3-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S3-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S3-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S3-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S3-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S4-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S4-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S4-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S4-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S4-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-U-S4-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/MT-contact-ddb7ee6.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S1-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S1-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S1-marker-repeat-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S1-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S1-original1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S1-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-marker2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-original1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S2-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-marker2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-original1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S3-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S4-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S4-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S4-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S4-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S4-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S4-original1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S4-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-marker2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-original1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/S5-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-S5-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-S5-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-S5-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-S5-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-S5-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-S5-original1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-S5-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S3-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S3-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S3-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S3-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S3-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S3-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S4-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S4-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S4-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S4-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S4-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/ST-U-S4-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S1-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S1-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S1-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S1-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S1-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S1-original1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S1-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S3-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S3-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S3-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S3-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S3-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S3-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S4-answer-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S4-clicked-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S4-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S4-final-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S4-marker1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/U-S4-sse-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/answers-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/classification-sensitive-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/copy-check-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/copy-confirm-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/delete-confirm-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/delete-welcome-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/deletion-check-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/history-dom-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/identity-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/identity-recheck-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/known-issues-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/known-issues-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/r332-ddb7ee6-ai-degraded.mp4`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/search-NAS-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/search-NAS-original-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/search-VPN-copy-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/search-counter-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/search-dental-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-B1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-B2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-B3-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-B4-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-B5-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-S1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-S2-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-S3-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-S4-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-S5-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/seed-notes-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/unmark-S1-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/unmark-S3-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/unmark-S4-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/unmark-persistence-ddb7ee6-AI-degraded.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/unmark-persistence-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser/verification-ddb7ee6.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/out/browser-accounts.json`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r332/browser/test-report.md`
