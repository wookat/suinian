# R337 production UI walkthrough

Completed the deployed SPA browser walkthrough at desktop 1280px and mobile 375×812 using the explicitly requested built-in demo mode. This is not a full production-account acceptance: no invite was available, so authenticated flows remain untested.

- Deployment: https://suinian.zalize.com / https://suinian-api.zalize.com
- PR: https://github.com/wookat/suinian/pull/384 (merged)
- Session: https://app.devin.ai/sessions/d5edb26550e34b46aca84a97fa164597
- Plan: `/home/ubuntu/qa-r337/test-plan-prod.md`
- Recording: `/home/ubuntu/screencasts/r337-prod-walkthrough/r337-prod-walkthrough-edited.mp4`
- Browser was maximized before recording; viewport sizes were set through Chrome's device toolbar.
- No source changes, production account creation, authenticated API mutation, or access to `u_boss`.

## Escalations and coverage limits

- **Untested — authenticated flows:** registration policy returned `invite_required:true`; secret references/environment names contained no invite or `QA_INVITE_CODE`. Real capture, sensitive masking with backend data, delete persistence, real Ask, real-data Insights, token-copy confirmation, logout, account deletion, and D1 residue verification were not exercised. No account exists from this run to clean up.
- **Untested — Trash clear/restore/undo:** demo explicitly reports `演示模式不支持最近删除，请先配置真实 API`. The route's limitation state rendered, but this is not a passing restore/clear test. Delete feedback/undo affordance appeared; successful restoration was not established.
- **Known follow-up, deliberately excluded:** native Settings confirmations for logout, token rotation, recovery regeneration, and tag merge/delete. User requested these not be tested on production yet.
- **Untested — SW upgrade lifecycle:** default offline/PWA opt-in was off. No active worker was found; this rules out a stale active worker in this browser, but does not prove upgrading an already-installed older worker.
- **Partial — motion/accessibility:** reduced-motion media emulation and route rendering passed; frame-by-frame animation suppression, capture under reduced motion, first-run tour-specific gating, and comprehensive screen-reader coverage were not established. Code-classified copy guard and account-only switches remain untested.
- **Performance opportunities:** Lighthouse mobile Performance 89, not 100. Both audits flag unused JS (~49 KiB), forced reflow, network dependency tree and render-blocking opportunities. These are audit findings, not observed functional failures.

## Scenario verdicts

- **Passed — build identity:** Web `<meta name="build">` and browser-context API `/health` both returned `3fbe6e309fa4bf19d7381d6c36ba37006584d025`; health `ok:true`. Matches supplied Pages deployment `b40f86ef` and deployment log. The deployed R337 shell was visible; no stale-shell hard reload was needed.
- **Passed — default cache state:** `sn_offline_cache` was null; Service Worker registrations were `[]`, with no active controller; Cache Storage contained `suinian-api`. This is the documented opt-in-off state, not an SW failure.
- **Passed — onboarding:** first-visit gate remained after Escape and overlay interaction; demo entry rendered fixture notes. This does not independently cover the separate first-run tour.
- **Passed — source filtering regression:** Android radio selection returned exactly 2 cards, both `来自 Android`; Web 速记 returned exactly 3 cards, all `来自 Web 速记`; 微信 returned exactly 3 cards, all `来自微信`. Labels were verified from rendered source-icon title/accessible text; cards do not have permanent source-text badges.
- **Passed — category:** 想法 displayed exactly three idea cards, excluding bookmark and Todo cards.
- **Passed — sensitive semantics:** router fixture began masked; explicit reveal displayed `192.168.31.1`; 隐藏 restored the mask.
- **Passed — demo capture/delete UI:** a `[QA-R337UI] demo capture` card appeared; note menu exposed red 删除; delete confirmation and deletion feedback rendered. This verifies browser-local demo behavior, not server persistence. An initial typing interaction was unreliable; no server duplicate semantics are inferred.
- **Passed — command palette:** sidebar search/Ctrl+K opened the palette; keyboard navigation/Enter reached a route and Escape dismissed it.
- **Passed — Todos:** completion state changed and completed section expanded/collapsed.
- **Passed — Threads:** list and first-thread detail rendered.
- **Passed — Reports:** weekly/monthly tabs switched content/empty state.
- **Passed — Insights:** line/bar charts rendered and a tooltip was displayed. This is visual tooltip evidence, not a complete mouse-versus-touch hover compatibility matrix.
- **Passed — appearance:** light/dark/system controls changed selection; observed dark surfaces remained legible. Root font sizes were 14, 16, 18 and 20px for 小/标准/大/特大. Restored system theme and 16px.
- **Passed — Auth:** intentional 注册新账号 / 登录 / 找回 forms rendered labels; empty submit displayed `用户名至少 2 个字符` validation. `role=alert` was confirmed. No credentials were submitted. Token management belongs in Settings; no missing-tab defect.
- **Passed — Ask demo:** mobile question `我最近在想什么` produced an explicitly labeled Mock reply. No assertion is made about real retrieval/AI correctness.
- **Passed — responsive routes:** all eight routes rendered at desktop and mobile without blank screens. At mobile, every measured document scroll width was exactly 375px, equal to viewport width.
- **Passed — mobile navigation:** each of the six primary routes had exactly one correct `aria-current="page"` item. Auth and Trash had no primary active item, as they are not primary bottom-nav entries.
- **Passed — reduced-motion smoke:** DevTools emulated `prefers-reduced-motion: reduce`; `matchMedia` returned true and Todos rendered after navigation. Emulation was reset; query returned false.
- **Passed — console observation:** no application runtime exceptions appeared in collected logs. This is bounded to this traversal, not proof of absence of every possible browser warning/error.

### Mobile layout measurements

| Route | Viewport / document width | Primary active navigation |
|---|---|---|
| `#/` | 375 / 375 | 首页 |
| `#/todos` | 375 / 375 | 待办 |
| `#/threads` | 375 / 375 | 线索 |
| `#/reports` | 375 / 375 | 报告 |
| `#/insights` | 375 / 375 | 洞察 |
| `#/settings` | 375 / 375 | 设置 |
| `#/auth` | 375 / 375 | none |
| `#/trash` | 375 / 375 | none; unsupported-demo message |

## Visual evidence

### Source filter correction (historical local evidence versus deployed production)

The earlier local preview was stale, predating source-filter commit `76f87e5`. The local report has been corrected; the old image below is not a current-production defect or a pre-redesign baseline.

| 🔴 Before: stale local preview retained non-Android cards | 🟢 After: deployed Android filter contains only two Android cards |
|---|---|
| ![Historical stale local preview](https://app.devin.ai/attachments/e1d829fa-40c3-4c6f-af40-874808267f76/ss_0a03e40b.png) | ![Production Android filter](https://app.devin.ai/attachments/8d8423c4-9f09-44c9-9893-5fc6fececd47/ss_43986380.png) |

| Production Web 速记: three cards | Production 微信: three cards |
|---|---|
| ![Web source filter](https://app.devin.ai/attachments/33f9698a-8b88-4b35-b676-0fb3e7c5f309/ss_384548ab.png) | ![WeChat source filter](https://app.devin.ai/attachments/3ee08a35-0b11-4990-bf5e-b3b796f231e5/ss_7ddae17f.png) |

### Deployed sensitive-note before/after

| 🔴 Before: masked/reset state | 🟢 After: explicit reveal |
|---|---|
| ![Sensitive masked](https://app.devin.ai/attachments/378068b9-1a87-41e7-b69f-47b3b1d32a0a/ss_ef2c0805.png) | ![Sensitive revealed](https://app.devin.ai/attachments/c27bd1a1-e67c-47f8-a256-b9d2529d7b97/ss_99c71804.png) |

### Responsive deployed pages

| Desktop Insights, 1280px | Mobile Insights, 375px |
|---|---|
| ![Desktop Insights](https://app.devin.ai/attachments/8698d63d-635a-4387-b91e-62c8f2dd0946/ss_736dd7ba.png) | ![Mobile Insights](https://app.devin.ai/attachments/5ec816ce-b5a3-45a8-99c9-fb0920adbce7/ss_60d6494b.png) |

| Mobile Ask mock reply | Mobile Auth validation |
|---|---|
| ![Ask mock reply](https://app.devin.ai/attachments/43b7e4ec-d043-4928-94ad-bf673ebd9a5e/ss_d0d9381e.png) | ![Auth validation](https://app.devin.ai/attachments/c2025796-b8e9-478a-88ce-35796c5f0e68/ss_86379b05.png) |

## Lighthouse production audits

Both commands completed with no runtime error or run warnings against `https://suinian.zalize.com/`, in clean headless Chrome. These audit the unauthenticated entry/onboarding page, not all demo/authenticated routes.

| Metric | Mobile | Desktop |
|---|---|---|
| Performance | 89 | 100 |
| Accessibility | 100 | 100 |
| Best Practices | 100 | 100 |
| SEO | 100 | 100 |
| Agentic browsing (additional category) | 67 | 67 |
| FCP | 2.6s | 0.6s |
| LCP | 3.1s | 0.7s |
| TBT | 130ms | 0ms |
| CLS | 0 | 0.036 |

Commands used `npx lighthouse https://suinian.zalize.com --chrome-flags="--headless=new --no-sandbox" --output=json --output-path=...`; desktop added `--preset=desktop`.

- Mobile JSON/log: `/home/ubuntu/qa-r337/lh-prod-mobile.json`, `/home/ubuntu/qa-r337/lh-prod-mobile.log`
- Desktop JSON/log: `/home/ubuntu/qa-r337/lh-prod-desktop.json`, `/home/ubuntu/qa-r337/lh-prod-desktop.log`
- Additional audit failure: `llms.txt` recommendations. Render-blocking estimates: mobile 150ms, desktop 40ms.

## Artifact inventory

Report: `/home/ubuntu/qa-r337/test-report-prod.md`. Corrected local report: `/home/ubuntu/qa-r337/test-report-local.md`.

| Evidence | Absolute screenshot path |
|---|---|
| Desktop onboarding | `/home/ubuntu/screenshots/ss_42285b25.png` |
| Mobile onboarding | `/home/ubuntu/screenshots/ss_d9ef1f67.png` |
| Android source filter | `/home/ubuntu/screenshots/ss_43986380.png` |
| Android checked radio | `/home/ubuntu/screenshots/ss_1aa097e3.png` |
| Web source filter | `/home/ubuntu/screenshots/ss_384548ab.png` |
| WeChat source filter | `/home/ubuntu/screenshots/ss_7ddae17f.png` |
| Sensitive masked / revealed | `/home/ubuntu/screenshots/ss_ef2c0805.png` / `/home/ubuntu/screenshots/ss_99c71804.png` |
| Demo capture / delete menu | `/home/ubuntu/screenshots/ss_2f09a06a.png` / `/home/ubuntu/screenshots/ss_b501c104.png` |
| Delete confirmation / feedback | `/home/ubuntu/screenshots/ss_51523dbb.png` / `/home/ubuntu/screenshots/ss_50aef7e5.png` |
| Command palette | `/home/ubuntu/screenshots/ss_9a228c33.png` |
| Desktop Todos completion / expanded | `/home/ubuntu/screenshots/ss_00935531.png` / `/home/ubuntu/screenshots/ss_3935c414.png` |
| Desktop Threads detail | `/home/ubuntu/screenshots/ss_eaf3069d.png` |
| Desktop Reports weekly / monthly | `/home/ubuntu/screenshots/ss_968a4336.png` / `/home/ubuntu/screenshots/ss_a850950e.png` |
| Desktop Insights / tooltip | `/home/ubuntu/screenshots/ss_736dd7ba.png` / `/home/ubuntu/screenshots/ss_35588ac0.png` |
| Settings light / dark | `/home/ubuntu/screenshots/ss_c17dfb42.png` / `/home/ubuntu/screenshots/ss_30ce573c.png` |
| Desktop Auth login / recovery validation | `/home/ubuntu/screenshots/ss_79b17a40.png` / `/home/ubuntu/screenshots/ss_05125cc3.png` |
| Desktop Trash limitation | `/home/ubuntu/screenshots/ss_10d8bbc9.png` |
| Mobile timeline / category | `/home/ubuntu/screenshots/ss_aad977d4.png` / `/home/ubuntu/screenshots/ss_4456e608.png` |
| Mobile Todos / Threads | `/home/ubuntu/screenshots/ss_3f994c9a.png` / `/home/ubuntu/screenshots/ss_2f2fd9be.png` |
| Mobile Reports / Insights | `/home/ubuntu/screenshots/ss_0d1fe1bc.png` / `/home/ubuntu/screenshots/ss_60d6494b.png` |
| Mobile Settings / Trash | `/home/ubuntu/screenshots/ss_26c6e644.png` / `/home/ubuntu/screenshots/ss_6ee0a17a.png` |
| Mobile Auth / Ask | `/home/ubuntu/screenshots/ss_86379b05.png` / `/home/ubuntu/screenshots/ss_d0d9381e.png` |
| DevTools reduced-motion command | `/home/ubuntu/screenshots/ss_2b7887a1.png` |

## Suggested single PR comment

Completed production UI QA at build `3fbe6e309fa4bf19d7381d6c36ba37006584d025`, matched in Web meta and Worker health. Desktop 1280px and mobile 375px demo walkthrough completed; authenticated acceptance remains blocked by the missing invite.

<details open>
<summary>Source-filter correction and deployed UI evidence</summary>

Android / Web 速记 / 微信 now show exactly 2 / 3 / 3 matching-source cards. The earlier local failure came from stale preview dist and the local report is corrected.

| Production Android filter | Production mobile Insights |
|---|---|
| ![Android filter](https://app.devin.ai/attachments/8d8423c4-9f09-44c9-9893-5fc6fececd47/ss_43986380.png) | ![Mobile Insights](https://app.devin.ai/attachments/5ec816ce-b5a3-45a8-99c9-fb0920adbce7/ss_60d6494b.png) |

</details>

<details>
<summary>Checks and limits</summary>

Passed onboarding, sensitive reveal/remask, demo capture/delete UI, palette, Todos/Threads/Reports, chart rendering/tooltip, theme/font controls, Auth validation, Ask mock reply and eight-route mobile no-overflow checks. Lighthouse mobile/desktop Performance: 89/100; Accessibility, Best Practices and SEO: 100/100.

No account created: real capture/Ask/token/cleanup/D1 checks remain untested. Demo Trash/restore is unsupported. Native Settings confirmations were intentionally excluded. Default PWA was off; no stale active SW found, but an installed-worker upgrade was not exercised. Auth's three tabs and typed account deletion are intentional.

</details>

[Walkthrough session](https://app.devin.ai/sessions/d5edb26550e34b46aca84a97fa164597). Recording attachment: `/home/ubuntu/screencasts/r337-prod-walkthrough/r337-prod-walkthrough-edited.mp4`.

## Setup and handoff

- SKILL.md suggestions: none; production skill already documents browser access, clipboard input, responsive measurements, Lighthouse and default PWA opt-in behavior.
- Blueprint: `read_environment_config` confirmed none exists. Suggested knowledge entry: use production UI skill, existing Chrome plus `wmctrl` maximization, `xclip` for Chinese input, and the two Lighthouse commands above. No application service was started or application dependencies installed in this production phase; npx Lighthouse was used. Blueprint update permission is unavailable.
- Still needed from user: a runtime-only `QA_INVITE_CODE` for the requested disposable-account authenticated coverage, if that coverage must be completed. Registration page: https://suinian.zalize.com/#/auth. Do not paste the invite into reports or write it to disk.
