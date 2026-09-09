# R337 local UI regression walkthrough

Completed the requested browser walkthrough against the local production-build preview at `http://localhost:4173`, using built-in demo/mock data, at desktop 1280px and mobile 375×812. **Corrected after production verification:** the preview served stale dist predating the source-filter fix; Auth and typed account-deletion behavior were intentional, not defects. Mock-mode restrictions still leave coverage gaps.

Production retest at build `3fbe6e309fa4bf19d7381d6c36ba37006584d025` passed Android (2 cards), Web 速记 (3), and 微信 (3), with every source label matching the selection. See `/home/ubuntu/qa-r337/test-report-prod.md`. Historical observations below are retained for provenance, not current product defects.

- PR: https://github.com/wookat/suinian/pull/384
- Branch: `devin/1788907842-r337-ui-design-system`
- Session: https://app.devin.ai/sessions/d5edb26550e34b46aca84a97fa164597
- No production hosts were visited, no credentials submitted, no backend started, and no source files changed.
- Runtime UI testing only; no unit-test or performance-audit claims are made here.

## Historical observations and corrected interpretation

### Superseded: stale preview Android source-filter result

Reproduction: timeline → 筛选 → 来源筛选 → Android. The trigger changes to **Android**, and reopening the DropdownMenu visibly shows Android selected. The DOM independently confirms Android's `role="menuitemradio"` has `aria-checked="true"` and all other sources are false.

The list nevertheless retains non-Android cards:

| Card remaining in the list | Visible category/tag badges | Source icon title / accessible label |
|---|---|---|
| Newly captured `git status` | 想法, #随手记 | 来自 Web 速记 |
| 碎片笔记的差异化：分拣与线索 | 想法, #产品思考, #碎念, #AI | 来自 Web 速记 |
| flomo 101：持续不断记录，意义自然浮现 | 收藏, #竞品, #flomo, #笔记 | 来自微信 |
| 提交碎念 Web R1 PR | 待办, #碎念, #开发 | 来自 Android |

The last card is legitimately Android; its presence is not itself a defect. The two Web cards and 微信 card establish the mismatch in that stale preview only. Ordinary cards show a **source icon**, not a persistent source-text badge; the exact strings above were read from the icon's `title`/`aria-label`. This is not a current product defect: production retesting passes all three source filters.

| Android visibly checked | Non-Android cards retained after scrolling |
|---|---|
| ![Android radio selected](https://app.devin.ai/attachments/e66fdf69-0839-4b56-abf5-51c7cdb7e3d2/ss_bb07f09c.png) | ![Web and WeChat cards retained](https://app.devin.ai/attachments/e1d829fa-40c3-4c6f-af40-874808267f76/ss_0a03e40b.png) |

### Known follow-up: native Settings confirmations; typed deletion is intentional

Logout opens a native browser confirmation. Account deletion opens an inline gate requiring `注销`, with `永久注销` and `取消`. Both were canceled; no account operation was completed. The user clarified that typed account deletion is intentional and not a defect. Native logout/token rotation/recovery regeneration/tag merge+delete confirmations are a known follow-up; they were excluded from production testing as requested.

| Logout: native confirmation | Account deletion: inline typed gate |
|---|---|
| ![Native logout confirm](https://app.devin.ai/attachments/a74cf97b-e864-47fa-ba20-f4c90abc58ac/ss_035af4c7.png) | ![Inline deletion gate](https://app.devin.ai/attachments/d778028b-7872-4312-a3ad-45ffec226113/ss_3a9cf058.png) |

### Corrected: Auth's three tabs are intentional

`#/auth` renders 注册新账号 / 登录 / 找回. The user confirmed this is correct; token configuration belongs in Settings. Empty-submit validation was exercised without sending credentials. The earlier missing-Token-tab failure is withdrawn.

### Untested / incomplete coverage

- Undo restoration and Trash clear AlertDialog: mock API rejects restore/trash with `演示模式不支持最近删除，请先配置真实 API`. The delete/undo affordance and Trash error UI were checked; actual restore and clear-dialog behavior were not verified.
- Settings Switch controls: no relevant notification/live-account switches were rendered in the tested demo view.
- Code-type copy confirmation: captured benign `git status`, but mock classified it as ordinary 想法. Copy succeeded normally; this does **not** establish a missing code guard. A genuinely code-classified fixture is needed.
- Conventional desktop chart hover: touch-emulated interaction did not establish desktop hover behavior. Tapping a bar did show a tooltip (`想法`, `数量 3 条 · 38%`).
- First-run tour-specific non-dismissal and comprehensive reduced-motion/animation behavior were not separately verified. Onboarding non-dismissal and normal list/page transitions were exercised.
- Real authentication, persistent backend writes, and real destructive operations were intentionally outside this mock-only walkthrough.

| Auth validation and three tabs | Trash mock limitation |
|---|---|
| ![Auth empty validation](https://app.devin.ai/attachments/272f042a-c98a-482e-957e-d6ebc4913c80/ss_5b59b375.png) | ![Trash unsupported in demo](https://app.devin.ai/attachments/a9d44aab-81fd-42c0-8965-d1b55eec288f/ss_939d17a8.png) |

## Regression assertions

- **Passed:** first-visit onboarding stayed open after Escape and overlay click; choosing 先看看演示 opened the demo timeline.
- **Passed:** keyboard focus remained inside the tested onboarding/delete dialogs; visible keyboard focus and Escape dismissal were spot-checked on applicable controls.
- **Passed:** desktop sidebar navigation and all eight routes rendered without blank screens.
- **Passed:** category selection changed timeline content and 全部 restored it.
- **Superseded:** stale preview retained Web/微信 cards under Android; deployed production retest passes.
- **Passed:** Enter saved a mock quick-capture note and a new card appeared. Initial automated typing dropped the prefix of `QA R337 local capture`, leaving `local capture`; subsequent controlled input used clipboard paste. This was treated as input-method unreliability, not attributed to the app.
- **Passed:** note ⋯ menu exposed a red destructive item; delete opened an AlertDialog, cancellation retained the note, confirmation removed it and exposed bottom-center delete feedback/undo UI.
- **Untested:** undo successfully restoring the deleted note, because mock restore is unsupported.
- **Passed:** sidebar search and Ctrl+K opened the command palette; Escape closed it; arrow keys and Enter navigated to a route.
- **Passed:** Todos check/uncheck changed completion state; completed section collapsed and expanded.
- **Passed:** Threads list and first-thread detail rendered.
- **Passed:** Reports 周报/月报 tabs changed active state and displayed corresponding content/empty state.
- **Passed:** Insights line/bar charts rendered, a tapped bar showed its tooltip, and a tag chip navigated to timeline filtering.
- **Untested:** full conventional desktop chart-hover behavior.
- **Passed:** Light/Dark/System theme controls changed selection; light/dark surfaces and text remained readable in observed desktop/mobile states.
- **Known follow-up:** native Settings confirmations. Inline typed account deletion is intentional, not a defect.
- **Untested:** Settings Switch toggles absent from the demo view.
- **Passed:** Auth's existing three forms rendered labels and visible empty-submit `role="alert"` errors.
- **Corrected:** Auth's three tabs and Settings token management match the intentional contract.
- **Passed:** sensitive router note began masked; explicit reveal exposed `192.168.31.1`; hide restored the mask.
- **Untested:** code-type copy confirmation, because the mock-created note was not code-classified.
- **Passed:** at 375px, timeline/todos/threads/reports/insights/settings bottom-nav routes and direct Auth/Trash routes rendered; measured document width equaled viewport width (375px), with no page-level horizontal overflow.
- **Passed:** the six primary mobile routes had the expected active bottom-nav item and `aria-current`.
- **Passed:** mobile Ask accepted a question and displayed a mock answer.
- **Passed:** no application runtime exceptions were observed in the collected console logs during traversal. This is an observation, not an assertion that all possible errors are absent.

| Delete confirmation | Delete feedback / undo affordance |
|---|---|
| ![Delete AlertDialog](https://app.devin.ai/attachments/a8e7d4bc-449a-4203-bacc-8f2375e36218/ss_1bc2b1d7.png) | ![Post-delete feedback](https://app.devin.ai/attachments/d5e24dc2-f247-47ca-b66c-c4455f65d79f/ss_e27aeabb.png) |

| 🔴 Before: sensitive content masked | 🟢 After: explicitly revealed |
|---|---|
| ![Sensitive masked](https://app.devin.ai/attachments/2cc3267a-1f70-4591-b1e5-b69f843e629f/ss_32b32ab1.png) | ![Sensitive revealed](https://app.devin.ai/attachments/124933eb-aa62-4bd9-a969-0c6ca8981d50/ss_62532091.png) |

| Desktop Insights | Mobile Insights |
|---|---|
| ![Desktop chart](https://app.devin.ai/attachments/b3fe3bc6-a9ee-4c52-aff6-749710d2af1c/ss_b6104a03.png) | ![Mobile charts](https://app.devin.ai/attachments/4a004793-d8e7-4f71-abb9-b12653b32a23/ss_54cc8ddd.png) |

## Artifacts

- Annotated recording: `/home/ubuntu/screencasts/r337-local-regression/r337-local-regression-edited.mp4`
- Report: `/home/ubuntu/qa-r337/test-report-local.md`
- Plan: `/home/ubuntu/qa-r337/test-plan-local.md`
- Key screenshot paths are listed below; images embedded above use uploaded URLs so the report is portable.

| Screenshot | Absolute path |
|---|---|
| Onboarding | `/home/ubuntu/screenshots/ss_06f99afc.png` |
| Desktop Android filter mismatch | `/home/ubuntu/screenshots/ss_04fa20ad.png` |
| Android checked | `/home/ubuntu/screenshots/ss_bb07f09c.png` |
| Retained Web/微信 cards | `/home/ubuntu/screenshots/ss_0a03e40b.png` |
| Delete confirmation | `/home/ubuntu/screenshots/ss_1bc2b1d7.png` |
| Delete feedback | `/home/ubuntu/screenshots/ss_e27aeabb.png` |
| Desktop Insights | `/home/ubuntu/screenshots/ss_b6104a03.png` |
| Chart tooltip | `/home/ubuntu/screenshots/ss_a3501874.png` |
| Sensitive masked | `/home/ubuntu/screenshots/ss_32b32ab1.png` |
| Sensitive revealed | `/home/ubuntu/screenshots/ss_62532091.png` |
| Native logout | `/home/ubuntu/screenshots/ss_035af4c7.png` |
| Inline deletion | `/home/ubuntu/screenshots/ss_3a9cf058.png` |
| Auth validation | `/home/ubuntu/screenshots/ss_5b59b375.png` |
| Mobile timeline | `/home/ubuntu/screenshots/ss_95b25622.png` |
| Mobile Auth | `/home/ubuntu/screenshots/ss_f3dd9602.png` |
| Mobile Todos | `/home/ubuntu/screenshots/ss_61ce1f83.png` |
| Mobile Threads | `/home/ubuntu/screenshots/ss_823735c7.png` |
| Mobile Reports | `/home/ubuntu/screenshots/ss_9c07f6a6.png` |
| Mobile Insights | `/home/ubuntu/screenshots/ss_54cc8ddd.png` |
| Mobile Settings | `/home/ubuntu/screenshots/ss_f36c71e0.png` |
| Mobile Trash | `/home/ubuntu/screenshots/ss_939d17a8.png` |
| Mobile Ask | `/home/ubuntu/screenshots/ss_f2cc4677.png` |
| Dark mobile timeline | `/home/ubuntu/screenshots/ss_0e2ccfc4.png` |
| Ordinary note copy | `/home/ubuntu/screenshots/ss_87f47a44.png` |

## Setup / handoff

- SKILL.md suggestions: none. Existing local-dev skill already covers local mock setup and clipboard input.
- Blueprint: `read_environment_config` confirmed no repository blueprint exists. Suggest documenting the verified no-credential demo path and reuse of a same-code Vite preview at port 4173; `web` dev fallback is port 5173. This run reused the existing preview and dependencies, installed nothing, and started no service. Blueprint write permission (`ManageRepoBlueprints`) is unavailable.
- User needs: none for the completed local mock coverage. Filtering and contract findings above are corrected; arrange local fixtures/API support for restore/trash, code-classified copy, and account-only switches to close coverage gaps. No production access was used in the original local run.
