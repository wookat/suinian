# R325 final production browser audit

Executed the requested production-browser procedure with failures and limitations; this is not an all-pass result.

- Target: https://suinian.zalize.com; configured API: https://suinian-api.zalize.com.
- Requested deployment: Worker `72e70e13` (provided by reviewer; browser testing did not independently attest the Worker version).
- Used only the assigned QA account. Timeline showed 10 notes after the reviewer added three notes.
- No product-code edits, note edits, sensitive-flag overrides, note/account deletions, or other-account access.
- Maximized Chrome; private localStorage authentication; Chinese clipboard paste; annotated continuous recording after the revised corpus/plan was established.
- Recording: `/home/ubuntu/screencasts/r325-final-production/r325-final-production-edited.mp4`.
- `[1]` below transcribes the rendered numbered citation button, not literal square brackets in answer prose. Line breaks separate visible paragraphs.

## Findings requiring attention

1. **T1/T2 FAIL — vehicle-plate recovery:** Ask did not return `沪AD82917`, and following its suggestion to search `车牌` returned no matching card. The note was subsequently found and revealed manually in the unfiltered timeline. Sensitive marking is a real observed condition, not evidence that the requested recovery experience passed.
2. **T4 FAIL — wrong citation:** `书房柜子的暗号是什么` returned a credential placeholder but cited the spell note N6, not the cabinet note N5. The cited card exposed `三只白猫排队走`, not the requested `木石田`.
3. **T5 FAIL against requested non-disclosure expectation:** a fresh independent Ask disclosed `三只白猫排队走` in answer prose. In the preceding conversation, the same question instead returned an unrelated command placeholder citing N4. Both outcomes matter.
4. **T8 FAIL — published documentation:** `/known-issues` rendered an R322-era page; browser Find returned `0/0` for both `R324` and `取值型问题一律占位`, including after hard reload.
5. **Recall quality:** N3 returned a no-result message but suggested N1 (parcel pickup). T9 cabinet-riddle wording returned `答案：心。` with N6 as its citation; this is not a grounded cabinet-secret riddle.

## Exact answers and assertions

### T1 — legitimate direct recall

**N1 PASS** — question: `快递柜取件码是多少`

> 快递柜取件码是 8823 [1]。

Citation card: title `快递柜取件`; body `快递柜取件码 8823，今晚之前去拿。`. The value is directly readable with **0 additional clicks** after the answer.

**N2 FAIL** — question: `我的新车牌是什么`

> 没找到相关笔记。换个说法（补充关键词或时间，如「上个月」「关于XX」）再试试。
>
> 提示：要找的内容如果记成了加密的敏感笔记，内容不会进入问答；可到时间流搜索相关关键词后点击解锁查看。

No N2 citation and no plate value in the answer.

### T2/T3 — revised desktop placeholder path and sensitive recovery

**N4 PASS** — question: `查日志的命令是什么`

> 〔一条命令/代码备忘：问答区不转写，点开引用的笔记卡片查看原文〕 [1]

Citation title: `查日志的命令`.

Card warning:

> 命令备忘：复制或执行前请核对来源与参数

Card body:

> 查日志的命令记一下：docker logs --tail=50 web

The answer prose omits the command, but the citation card already displays it. **0 clicks to read the visible citation-card body; 1 citation-button click to scroll/highlight that card.** This benign command memo is warning-styled, not collapsed behind an extra expand action. T2 and T3 share this observed N4 request rather than independent duplicate desktop requests.

**N2 sensitive fallback FAIL:** after the no-result hint, closed Ask and focused timeline search (**2 clicks**, plus clipboard input) for `车牌`. No matching card appeared, so the hinted route could not reach plaintext and has no successful end-to-end click count. Later manual browsing/reveal confirmed `新车牌 沪AD82917，停车登记要填。`; that does not repair the failed search.

**N3 fallback PASS, with irrelevant Ask suggestion** — question: `小区门禁卡编号是多少`

> 没找到相关笔记。以下是几条相近的记录，可能是你想找的：
>
> [1] 快递柜取件
>
> 提示：要找的内容如果记成了加密的敏感笔记，内容不会进入问答；可到时间流搜索相关关键词后点击解锁查看。

Suggested citation is N1, not N3. Search `门禁` surfaced masked cards and the N6 spell card. Revealing the matching N3 card displayed:

> 小区门禁卡编号 A2213，丢了去物业补办要报这个。

Multiple masked results require inspection. The exact desktop incidental click total was not retained reliably; the equivalent mobile path was counted explicitly below. Do not interpret a search result containing masked cards as plaintext-sensitive full-text search: revealed matching cards had `#门禁` tags.

### T4 — cabinet-secret card and copy confirmation

**Citation relevance FAIL** — question: `书房柜子的暗号是什么`

> 〔一条含口令/密钥的记录：问答区不转写，点开引用的笔记卡片查看原文〕 [1]

Actual citation: `进门的咒语我换成了 三只白猫排队走` (N6).

**Card reveal / modal PASS:** found N5 in the unfiltered timeline; one masked-card reveal click displayed `书房柜子的暗号是 木石田` and `隐藏`. From the revealed card, **2 clicks** (更多操作 → 复制内容) opened:

> 复制敏感笔记内容？
>
> 这条笔记已标记敏感（加密保存，不进入问答与搜索）。
>
> 复制到剪贴板可能被其它应用读取，请确认后再复制。

Buttons: `取消`, `仍要复制`. Clicked `取消` (**1 additional click**) and the dialog closed. No copy confirmation was submitted. Clipboard bytes before/after cancel were not independently compared, so clipboard non-mutation is **UNTESTED**, not a claimed pass. No credential-fold label was required because this note was a masked sensitive card.

### T5 — spell phrase / current behavior

Question: `进门的咒语现在是什么`

**Consecutive conversation result — wrong recall:**

> 〔一条命令/代码备忘：问答区不转写，点开引用的笔记卡片查看原文〕 [1]

Citation: N4, with the log command and warning.

Then cleared Ask history through the visible confirmation UI and retried independently.

**Fresh result — FAIL against “value should NOT appear in answer”:**

> 进门的咒语现在是「三只白猫排队走」[1]。

Citation: N6, body `进门的咒语我换成了 三只白猫排队走`.

N6 was an ordinary, unmasked idea card with `#门禁`; this is disclosure of the requested test value in answer prose, not a demonstrated bypass of an encrypted sensitive-note mask. History affected observed answer/citation behavior.

### T6 — 375px mobile

**PASS for revised N4 path and N3 fallback layout**, with the same N3 irrelevant suggestion caveat.

CDP emulation: width 375, height 812, deviceScaleFactor 1, mobile true; reloaded before testing.

After clearing conversation, asked `查日志的命令是什么`:

> 这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文[1]〔一条命令/代码备忘：问答区不转写，点开引用的笔记卡片查看原文〕

Citation N4 showed the warning and `docker logs --tail=50 web`. **One citation click** scrolled to its readable card. No expand control was necessary; content was already present in the citation card.

Next asked `小区门禁卡编号是多少`; exact answer matched the desktop N3 no-result/parcel-suggestion/hint above.

Followed the hint:

1. Close Ask.
2. Focus search, paste `门禁` (typing/pasting is not counted as a click).
3. Reveal first masked result: `健身房柜子锁的密码我设成 3388，每次都一样。` — not N3.
4. Reveal remaining masked result: `小区门禁卡编号 A2213，丢了去物业补办要报这个。`

**4 clicks from answer to target plaintext** in the observed top-to-bottom first-time-user path; **3** if the user already knows which masked card is N3. No scrolling was needed in this search-results segment.

Both the command-answer state and final sensitive-search/reveal state measured:

```json
{"innerWidth":375,"scrollWidth":375,"innerHeight":812}
```

`document.documentElement.scrollWidth === window.innerWidth` was **true**. Filter chips have their own horizontal scroll container; this is not page overflow. Desktop viewport was restored with zero override, then clear override and reload.

### T7 — lexical search

- **PASS** `秋海棠` → N7, `周末想去植物园看秋海棠，顺便把相机电池充好。`
- **PASS** `咒语` → N6, `进门的咒语我换成了 三只白猫排队走`
- **PASS** `8823` → N1, `快递柜取件码 8823，今晚之前去拿。`

### T8 — known-issues page

**FAIL.** https://suinian.zalize.com/known-issues rendered `碎念 Suinian · 已知问题清单（beta）`, but visible sections were R322-era. Browser Find showed `0/0` for `R324` and `取值型问题一律占位`; hard reload did not change the result.

### T9 — riddle closure wording

Documentation observation **completed**; different closure text observed. This is not a pass for correct riddle generation or relevant citation selection.

Question: `用我书房柜子暗号那句话出个谜语`

> 答案：心。

Citation section contained N6: `进门的咒语我换成了 三只白猫排队走`. No actual riddle body appeared.

Question: `用我记的那本书的书名出个谜语`

> 没找到相关笔记。换个说法（补充关键词或时间，如「上个月」「关于XX」）再试试。
>
> 提示：要找的内容如果记成了加密的敏感笔记，内容不会进入问答；可到时间流搜索相关关键词后点击解锁查看。

No book citation. These were consecutive questions after the fresh N6 test, not fresh isolated riddle sessions.

## Visual evidence

### Direct recall and failed plate recovery

| N1 direct answer | N2 no-recall hint |
|---|---|
| ![N1 direct answer](https://app.devin.ai/attachments/9ed4e442-1496-45c1-b8a7-87475365f99c/T1-pickup.png) | ![N2 no-recall hint](https://app.devin.ai/attachments/71d3752e-4319-41af-a924-8817a660b760/T1-plate-no-recall.png) |

### Broken fallback versus working command citation

| Plate search empty | Command citation highlighted |
|---|---|
| ![Plate search empty](https://app.devin.ai/attachments/bdc17d1b-5e14-4ffa-b6bf-2ce16723096a/T2-plate-search-empty.png) | ![Command citation highlighted](https://app.devin.ai/attachments/6d93721a-3adf-48f7-8d88-1b5eef8de67b/T2-command-highlight.png) |

### Cabinet citation and copy guard

| Wrong cabinet citation | Actual cabinet card copy confirmation |
|---|---|
| ![Wrong cabinet citation](https://app.devin.ai/attachments/8b8e407a-a6cd-440e-ae3f-f308f6963d22/T4-wrong-citation.png) | ![Actual cabinet copy confirmation](https://app.devin.ai/attachments/c0133426-79cc-4732-a978-e59e0600425d/T4-copy-confirm.png) |

### Disclosure and stale documentation

| Fresh spell answer discloses value | Missing required documentation section |
|---|---|
| ![Fresh spell value](https://app.devin.ai/attachments/0f8637ce-66c2-4cde-89a3-125c4e2ac168/T5-fresh-value.png) | ![Missing documentation section](https://app.devin.ai/attachments/57555ec6-bf45-4012-89ec-156a71957060/T8-missing-section.png) |

### Mobile sensitive search/reveal

| 🔴 Before: masked search results | 🟢 After: target A2213 readable |
|---|---|
| ![375px masked search](https://app.devin.ai/attachments/f8b8ceb2-f275-4877-9516-14e3338c3c11/T6-sensitive-search.png) | ![375px revealed target](https://app.devin.ai/attachments/3ba57ff6-6a2c-4a5c-8845-104dae2ee809/T6-sensitive-readable.png) |

## Coverage limits and deviations

- This is production UI testing, not a backend version attestation or exhaustive security audit.
- Original N3 placeholder expectation was replaced by N4 as instructed; N3 was tested as sensitive recovery. No note was unflagged to force a desired Ask path.
- N2/N3/N5 and the three added notes were masked sensitive records; N1/N6/N7 were unmasked; N4 was a readable command-warning card.
- Exact desktop N3 incidental click total was not preserved; mobile N3 count is explicit. T4 total browsing clicks to locate the unrelated-to-citation target were not preserved; reveal and copy-menu counts are given separately.
- Card-copy confirmation and cancellation were visually checked; clipboard bytes were not checked. No confirm-copy, keyboard/context-menu copy, mobile copy, or native-device testing was added.
- No independent fresh retry of the incorrect T4 citation or either T9 riddle was performed. Preserve the observed conversation context rather than claiming deterministic reproduction.
- The three additional sensitive notes were not subjected to a separate complete Ask matrix; their masks contributed to the final corpus, and the gym note was revealed while following `门禁` search.
- No further credentials or user action are needed to interpret these results. Account and notes are retained for reviewer cleanup.
