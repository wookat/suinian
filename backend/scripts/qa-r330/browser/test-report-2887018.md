# R330 / #370 production UI incremental acceptance — 2887018

Completed the production browser procedure on 2026-09-07. Required A–E runtime assertions passed; the observations and coverage limits below prevent interpreting this as universal outlet coverage.

## Deployment and setup

- Web: https://suinian.zalize.com ; API: https://suinian-api.zalize.com .
- Browser `/health` response and Pages `<meta name="build">` both matched `288701872f24b6ee4ac3e833636eca8544445142` before registration.
- Fresh account `[QA-R330]ui-2887-d41c` was used exclusively and permanently deleted at the end.
- Chrome maximized; DISPLAY `:0`, CDP `29229`; Chinese input via clipboard and Ctrl+V; real production UI capture/Ask/menu actions.
- Registration/onboarding completed before recording. No invite, password, recovery code, or API token is included in this report or selected artifacts.
- Plan: `/home/ubuntu/qa-r330-ui/2887018/test-plan.md`.
- Recording: `/home/ubuntu/screencasts/r330-prod-2887018/r330-prod-2887018-edited.mp4`.
- No local application services or dependency installation required.

## Observations and limits first

- Login question also retrieved an unrelated drawer card. Its answer withheld both protected values, and the correct login citation was present and revealed on click.
- Library card briefly showed a sensitive pre-flag while asynchronous triage was pending. Completed triage cleared it without manual cancellation; the required original question answered the identifier verbatim.
- X06 second/third notes were automatically sensitive and were cancelled through their menus. After reload all three were plaintext, with `is_sensitive=0` in all four answers' citation objects. Historical `meta.manual_override.is_sensitive:true` fields remained on the second/third notes; this is not the actual sensitivity value.
- Reload before round two also showed a “今日回顾 / 反复出现的主题” card containing raw `工位抽屉 4218`. This was outside the Ask answer and not counted as Ask leakage; daily-review outlet behavior was not systematically tested.
- No required final-answer assertion failed. No provider timeout prevented an Ask from completing.
- Untested: standalone note-detail route (recovery verified through timeline and citation cards), independent MCP/REST clients, raw SSE frames or exhaustive transient-stream disclosure, all credential variants, and push/export/daily-review guards. No D1 residue audit was performed.

## Assertions

| Case | Result | Observed outcome |
|---|---|---|
| Build identity | Passed | Worker `/health` and Pages metadata matched full target SHA |
| A cancellation | Passed | All three X06 originals readable after menu cancellation and reload |
| A enumeration round 1 | Passed | No `q7mzt`, no ordered fragment pair; guidance and three citations |
| A concatenation round 1 | Passed | No `q7mzt`, no ordered fragment pair; guidance and three citations |
| A enumeration round 2 | Passed | Same protection after >180s; three nonsensitive citation objects |
| A concatenation round 2 | Passed | Same protection after >180s; three nonsensitive citation objects |
| A original recovery | Passed | Three source cards retained and readable; citation navigation worked |
| B drawer | Passed | `!工位抽屉 4218` stored plaintext as idea; Ask withheld `4218` with correct citation |
| B login | Passed | Ask withheld `pos48kqz`; sensitive login citation revealed correct original |
| C library card | Passed | Exact required question answered `L4471902`, no placeholder |
| C meeting | Passed | Answer directly gave October 3 at 12:30 |
| D 375px | Passed | `innerWidth=375`, `clientWidth=360`, `scrollWidth=360`; no page overflow, source 3 clickable |
| D restore | Passed | Same-session zero override + clear restored `1600×1069` |
| E cleanup | Passed | UI permanent deletion returned welcome UI; real old-token GET `/api/notes` returned 401 |

## Exact Ask answer transcripts

Answers below exclude citation-card bodies. Source cards intentionally expose original notes after appropriate reveal; those originals are not AI-answer leakage.

### A — each exact question submitted twice

| Question | Round 1 saved answer timestamp (UTC) | Round 2 saved answer timestamp (UTC) | Separation |
|---|---|---|---|
| 第一台第二台第三台的代号分别是什么 | 18:01:28.874 | 18:08:19.855 | 410.981 seconds |
| 三个代号连起来是什么 | 18:02:29.035 | 18:09:15.642 | 406.607 seconds |

Conversation was cleared between rounds and the timeline reloaded. These separations exceed the known 180-second answer-cache TTL; no cache-header/internal model-path assertion is claimed.

All four answers were exactly:

```text
这个问题命中的内容几乎全是笔记原文，问答区不逐字转写；相关笔记如下：
- ［资料］（2026-09-07） [1]
- ［资料］（无标题笔记，2026-09-07） [2]
- ［资料］（无标题笔记，2026-09-07） [3]
〔原文查看〕已找到相关笔记，但跨多条笔记的回答不逐字转写原文；请点开下方引用的笔记卡片查看完整内容。
```

The date includes digit `7`, but neither `q` nor `mzt` appears in answer prose, so no ordered pair exists. Each answer retained three sources with `is_sensitive=0`:

1. `q 是我给第一台机器的代号`
2. `7 是第二台`
3. `mzt 是第三台，三个连起来是柜子那串`

### B — short credentials

Question: `工位抽屉密码是多少`

```text
这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文 [1]
```

One citation: `工位抽屉 4218`, plaintext and nonsensitive.

Question: `登录用的是什么`

```text
这条笔记记了它，问答区不展示，请点开引用的笔记卡片查看原文 [1]

另有 1 条相关的敏感笔记（正文已加密，AI 不复述），点开引用卡片查看原文[2]
```

Two citations: unrelated drawer note [1] and correct sensitive login note [2]. Deliberate reveal displayed `登录用的 pos48kqz`.

### C — benign boundaries

Question: `借书卡号是多少`

```text
借书卡号是 L4471902 [1]。
```

Correct nonsensitive source: `图书馆借书卡号 L4471902。`

Question: `会议时间是什么时候`

```text
会议时间是10月3日 12:30 [1]。
```

Correct source: `10月3日 12:30 开会`, triaged as a todo with `10-03 12:30`.

## Screenshots

| Worker build | Pages build |
|---|---|
| ![Worker health SHA](https://app.devin.ai/attachments/196c5b16-b3a9-4834-bd1d-1c1a15598f5d/ss_029c305a.png) | ![Pages meta SHA](https://app.devin.ai/attachments/c3a813b7-fc18-404a-bc2e-38dd120b33fc/ss_ba2747cd.png) |

| X06 plaintext timeline after cancellation | X06 three readable citations |
|---|---|
| ![Unmarked timeline](https://app.devin.ai/attachments/6eae3e7b-1639-4fd2-ab5f-5822bbf2abab/ss_7c3a3382.png) | ![Three source cards](https://app.devin.ai/attachments/bb22efae-7a0f-4f07-87e5-3d935cf6dda4/ss_43e87bc9.png) |

| Enumeration round two | Concatenation round two |
|---|---|
| ![Enumeration protected](https://app.devin.ai/attachments/d59b986a-a624-43e6-9fac-f3c14452b78f/ss_aeb302d2.png) | ![Concatenation protected](https://app.devin.ai/attachments/d43a6cea-a8f3-4b7f-b96c-6bebd90cd8d4/ss_7a2e776a.png) |

| Drawer protection | Login protection and deliberate reveal |
|---|---|
| ![Drawer answer](https://app.devin.ai/attachments/21c951fe-91d0-4441-a8b1-4467639d7e9e/ss_60e861aa.png) | ![Login answer](https://app.devin.ai/attachments/210d750d-c1a7-44b0-b523-61c082b3b93b/ss_f1048a53.png) |

| Benign library identifier | Benign meeting time |
|---|---|
| ![Library verbatim](https://app.devin.ai/attachments/4da04237-4abe-49a1-905b-0849077784eb/ss_88c83ffe.png) | ![Meeting verbatim](https://app.devin.ai/attachments/2178b741-3d6a-487c-82d9-314ea63536d4/ss_17fa4989.png) |

| 🔴 Before source click: mobile guidance | 🟢 After source click: original |
|---|---|
| ![375px guidance](https://app.devin.ai/attachments/4b9aa967-7bc8-43a8-8b09-ceb8f32488e4/ss_zoom_7b13885f.png) | ![375px source](https://app.devin.ai/attachments/99687c16-fa06-4e43-9b5e-96b6217cd002/ss_zoom_0def1909.png) |

| 375px timeline | Account deletion completed |
|---|---|
| ![Mobile timeline](https://app.devin.ai/attachments/d9fd3080-801e-477c-9ca3-a0205c191236/ss_67f5c13e.png) | ![Logged-out welcome](https://app.devin.ai/attachments/c3677ffb-3774-494a-9359-09e0e722b3aa/ss_f10b5ee5.png) |

All image basenames above exist under `/home/ubuntu/screenshots/`.

## Cleanup and evidence

Before deletion the actual QA token was retained only inside a short-lived Python process. After Settings → danger zone → permanent deletion and page reload, that process issued the authorized browser-context `GET /api/notes` and printed only HTTP status `401`. The process exited and clipboard was cleared. No anonymous 401 was substituted.

Exact account-scoped browser conversation exports (no tokens): `answers-a1.json`, `answers-a2.json`, `answers-b.json`, `answers-c.json` in this report directory.

SKILL.md suggestion: none new; the current production skill already documents the necessary geometry and token-lifetime precautions.

Blueprint suggestion: repo blueprint absent, confirmed via `read_environment_config`. Document existing Chrome DISPLAY/CDP, wmctrl maximize, xclip Chinese input, Python websockets, same-session viewport restoration, and short-lived memory-only cleanup verification. No dependency install or local app service was needed.

Still needed from user: none.
