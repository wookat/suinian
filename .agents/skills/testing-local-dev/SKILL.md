---
name: suinian-local-dev-testing
description: How to run and test suinian (backend Worker + web SPA) fully locally with mock AI
---

# Local dev testing for suinian

## Start services
- Backend: `cd backend && npm ci && cp .dev.vars.example .dev.vars && npm run dev:init && npm run dev` → http://127.0.0.1:8787 (`/health` returns `{"ok":true}`). `.dev.vars` default `AI_MODEL=mock` gives deterministic triage: category `idea` + tag `本地开发` (see backend/src/ai.ts mockChatResponse).
- Web: `cd web && npm ci && cp .env.example .env.local && npm run dev` → http://localhost:5173.

## Known pitfall
`wrangler dev` (4.119.x) may crash at startup with `Incorrect type for map entry 'RETRIAGE_TIME_BUDGET_MS': not of type 'function or ExportedHandler'` — workerd rejects non-function exports from the entry module (backend/src/index.ts exports consts like `RETRIAGE_TIME_BUDGET_MS`, `SOFT_DELETE_RETENTION_DAYS` for tests). Workaround for local testing: temporarily remove `export` from those consts (revert before running `npm test`, which imports `SOFT_DELETE_RETENTION_DAYS`). Proper fix: stop exporting constants from the Worker entry module (re-export from a separate module).

## UI flow
- First visit shows onboarding modal → choose「注册新账号」→ #/auth with API 地址 prefilled to http://127.0.0.1:8787; register username + password (≥8 chars); app auto-configures token and enters real mode.
- Dump a note in the quick-capture textarea (Enter to save); mock triage badge (想法 + #本地开发) appears within seconds.
- Note: typing CJK text via computer-use `type` into the textarea may drop characters (xdotool cannot type CJK); to enter Chinese, put it on the clipboard (`printf '中文' | xclip -selection clipboard -d :0`) and paste with Ctrl+V, verifying the text landed before pressing Enter.
- Mobile-viewport testing: Chrome's minimum window width (~500px) prevents resizing the window to 375px; use DevTools device toolbar (F12 → Ctrl+Shift+M) and set dimensions to 375×667 instead.

## Repo checks
- backend: `npm test` (vitest), `npm run typecheck`
- web: `npm run lint` (oxlint, warnings ok), `npm run build` (tsc + vite)

## Production caution
Never test against https://suinian-api.zalize.com unless explicitly allowed; if unavoidable, use a `[QA-...]`-prefixed account and delete it after (设置页 → 危险操作 → 注销账号, confirm prompt requires typing 「注销」 — CJK typing into native prompts drops characters; put 注销 on the clipboard via `xclip` and Ctrl+V instead).

## Production testing tips (learned R89)
- Timezone-sensitive tests: set the OS timezone before launching Chrome (`sudo timedatectl set-timezone Asia/Shanghai`), then restart Chrome so `Intl` picks it up; verify with `Intl.DateTimeFormat().resolvedOptions().timeZone`. Restore UTC afterwards.
- Prod `/api/notes/batch?stream=1` (add_tags/remove_tags) is intermittently slow — anywhere from ~1s to 60s+. UI toasts (incl. the 撤销 undo button) auto-dismiss after 6s, so an agent's click roundtrip often misses the undo window. Workaround for testing undo: in the console stretch the timeout (`const ost=setTimeout; window.setTimeout=(fn,ms,...r)=>ost(fn, ms===6000?90000:ms, ...r)`), or click undo within the same computer-use action batch.
- Inline `#tag content` quick-capture: only some notes keep the literal tag — AI triage may strip/replace it; verify each note's chips before relying on them for batch-tag tests.
- Login against prod can time out once with 「请求超时，请用相同用户名密码重试一次」; simply retry.
- Repeatable evals: `cd backend && npx tsx scripts/ask-eval.ts` (registers + deletes its own qa-r79-eval-* prod account, ~5 min, prints per-category recall score); `scripts/triage-eval.ts` needs `SUINIAN_TOKEN`.

## Production testing tips (learned R91)
- Launch Chrome with `DISPLAY=:0` (the VNC display) and `--remote-debugging-port=9222` if you need `browser_console`/CDP; verify page timezone with `Intl.DateTimeFormat().resolvedOptions().timeZone` before timezone tests.
- Any CJK text (notes, ask questions, the 「注销」 confirm prompt) must go via clipboard: `printf '文本' | DISPLAY=:0 xclip -selection clipboard` then Ctrl+V — direct computer-use typing drops CJK chars. Register-form passwords: avoid special chars like `!` (a first attempt failed with 两次输入的密码不一致); plain alphanumerics type reliably.
- d1 remote checks: `cd backend && CLOUDFLARE_API_TOKEN="$CLOUDFLARE_WORKERS_API_TOKEN" npx wrangler d1 execute suinian --remote --json --command "..."`. `users` has `name` (not `username`). Post-deletion cascade audit: iterate `USER_ID_TABLES`/`NOTE_ID_TABLES` from backend/src/account.ts. Also check for leftover `[QA-*]` users from earlier rounds and clean them (children first).
- R90 persistent undo bar: after batch tag/untag a bar docks at the top of the timeline, does NOT auto-dismiss and survives F5 (localStorage `suinian:pending-undo`, 5 min TTL) — no need for the old setTimeout-stretch hack when testing undo.
- Lighthouse: `npx -y lighthouse https://suinian.zalize.com --preset=desktop --quiet --chrome-flags="--headless --no-sandbox" --output=json` (R91 scored 100/100/100/100 desktop).

## Production testing tips (learned R92)
- Native `window.confirm`/`window.prompt` dialogs (account-deletion flow) are auto-dismissed by the browser automation layer — they never appear on screen and the handler silently cancels. Workaround: stub them in the console before clicking (`window.confirm=()=>true; window.prompt=()=>"注销"`) then trigger the button (computer-use click may also not register on that button; `btn.click()` via console works).
- The settings 「下载完整备份」 button may not save a file to ~/Downloads under automation; use the same endpoint directly: `curl https://suinian-api.zalize.com/api/backup -H "Authorization: Bearer $TOKEN" -o backup.zip` (default = sensitive redacted; add `?include_sensitive=true` for plaintext).
- `/api/graph` and `/api/insights` do NOT exist (404) — graph data is served inside thread-detail responses; insights UI uses `/api/stats`.
- Sensitive redaction placeholders differ by layer: D1 `notes.content` at rest = `[加密内容]` (crypto.ts ENC_PLACEHOLDER); backup export uses `[已加密内容]`. Grep for both.
- Prod graph tables are `entities`/`edges` (not graph_*); `edges` cols: src_type,src_id,dst_type,dst_id,relation,note_id; `daily_reviews` cols include note_id,kind,comment; `weekly_reports` has `content_md`. Check `sqlite_master` before writing queries.
- Admin endpoints for forcing derivations: `POST /api/admin/reconcile-threads`, `POST /api/admin/run-daily-reviews` with `Authorization: Bearer <ADMIN_TOKEN>` (worker secret; lead can rotate via `wrangler secret put`).

## Production testing tips (learned R94)
- Fastest way to get a QA account token for triage-eval / API tests: 设置页「复制我的 API token」button + `DISPLAY=:0 xclip -selection clipboard -o` (48-char token). Read the clipboard in the same `exec` call that uses it — shell variables don't survive across calls.
- Voice-note path without a mic: `espeak-ng` to wav → `ffmpeg` to mp3 → `curl -F type=audio -F file=@x.mp3 https://suinian-api.zalize.com/api/ingest/media -H "Authorization: Bearer $TOKEN"` (omitting `type` fails with "type must be audio, image or file"). Whisper transcribes, correctTranscript may normalize to Chinese.
- Note-card 「⋯」 menu button is `md:opacity-0` (visible only on hover) but always clickable — click just right of the timestamp (~x=694).
- AI health probe: `GET /health?probe=ai` → `{ok, ai:{provider: "primary"|"fallback", model}}`, 503 when the whole chain is down. Account deletion now uses an in-app confirm (type 「注销」 via clipboard paste) — no more native prompt stubbing needed.

## Production testing tips (learned R96)
- Registering usernames containing `[` etc. via xdotool direct typing can drop characters (`[QA` became `[Q`); paste the username via clipboard (xclip) instead.
- `browser_console` may attach to a different Chrome instance (shows chrome://new-tab-page); to verify login state, use 设置页「复制我的 API token」+ xclip + curl instead.

## Production testing tips (learned R98)
- Thread reconciliation is async but fast: after posting 2 related notes, the thread chip (note-card bottom, `#/threads?id=...`) appears within ~1 min after an F5; no admin reconcile call needed.
- The intranet-link message 「本地/内网链接无法抓取正文，链接本身已保存」only renders once `meta.link_status != "ok"` — the crawl is async, so F5 a few seconds after saving the note.
- Browser TZ stays UTC if Chrome was pre-launched; todo_due without offset is pinned +08:00 (web/src/lib/utils.ts parseDue), so a 16:00 Asia/Shanghai due displays as 08:00 under UTC — that is correct conversion, not a bug.
- Ask sensitive count-only hint: question 「我的银行卡密码是多少」on an account with one sensitive 银行卡 note yields 拒答 + 「另有 1 条加密的敏感笔记可能相关（内容不会进入问答）…」.
- Account deletion UI: 设置 → 危险操作 → 注销账号（删除全部数据） → paste 「注销」 into the inline input → 永久注销; afterwards the old token returns 401.

## Production testing tips (learned R100)
- QA API token: after 设置页「复制我的 API token」, save it in the SAME exec call (`TOKEN=$(DISPLAY=:0 xclip -selection clipboard -o)`) — clipboard gets overwritten by later CJK pastes and shell env does NOT persist across exec calls even with the same shell_id; stash to a chmod-600 temp file and `rm` it before account deletion.
- 409 optimistic-lock conflict simulation: load timeline/todos in UI first (stale copy), then `PATCH /api/notes/:id` via curl with the current `base_updated_at` (200, updated_at bumps), then edit the same note in UI without refreshing → toast/error 「这条笔记刚被其他设备修改，已刷新为最新内容，请重新编辑」 and card refreshes. A curl PATCH with the old base_updated_at returns 409 with `{error, note}` (latest copy). There is no `GET /api/notes/:id` (returns "not found"); web getNote() fetches the list.
- Right rail (记录统计/标签云) is `xl:` only (≥1280px CSS). On a 1024px screen use Ctrl+minus zoom-out AND an F5 afterwards — the rail may not appear until reload.
- Markdown import with historical created_at: sections split by `---`, and the FIRST line of each section must be a bare date `YYYY-MM-DD HH:MM` (backend/src/import.ts LEADING_DATE_RE); dates embedded mid-line are ignored.
- Ask eval: `cd backend && npx tsx scripts/ask-eval.ts` runs ~10 min against prod, self-registers and self-deletes its account; R100 scored 43/44 (98%).

## Production testing tips (learned R103)
- Threads cluster ONLY `category='idea'` notes (backend/src/threads.ts). Two "same-topic" notes may triage as 想法+收藏 and never form a thread — post 2+ notes that clearly read as 想法 (e.g. 「…想法：想…」). To force clustering: `POST /api/threads/rebuild` (body `{}`) then poll `GET /api/threads/rebuild/:job_id` until `status:"done"`; the threads-page 重建线索 button does the same but gives little feedback. There is no `/api/threads/reconcile` (admin-only `/api/admin/reconcile-threads`).
- Re-show the first-run tour: set `tourSeen:false` inside localStorage key `suinian.settings` and reload (only shows right after registration otherwise).
- `browser_console` may attach to the wrong Chrome; direct CDP works: `requests.get('http://127.0.0.1:9222/json')` + `websocket.create_connection(url, suppress_origin=True)` (plain origin gets 403) then `Runtime.evaluate`.
- 409 conflict UI (R102+): after a stale save the editor stays open with your input, plus an amber 「最新版本：…」 panel and a 「放弃我的输入，改用最新版本」 button that backfills the textarea; manual merge + re-save then succeeds. Same component on timeline and todos pages.
- DevTools device toolbar width also serves for ≥1280px checks (set 1280×800) since the physical screen is 1024 wide.

## Production testing tips (learned R104)
- `scripts/thread-cross-eval.ts` (Workers AI via REST) needs a token with Workers AI Read/Run: `CLOUDFLARE_WORKERS_API_TOKEN` returns code 10000 Authentication error on `/ai/run/*`; use `CLOUDFLARE_GLOBAL_API_TOKEN` (org secret) instead — pass it via a custom env var name in the exec tool's `env` (auto-injected secrets can shadow `CLOUDFLARE_API_TOKEN` set directly). Expected: A 40%R/40%P, B 100%R/48%P, B' 87%R/54%P, ~54 LLM confirm calls, ~2 min.
- wrangler d1 remote may exit 1 after printing the account table when it can't resolve the account; set `CLOUDFLARE_ACCOUNT_ID=ddff52d24ee44e21a021c15eaffcc86d` explicitly. DB name is `suinian` (not suinian-db).
- Search empty-state 「用 AI 问问看」 should only prefill+focus the ask textarea (no auto-send; wait ~5s to confirm no answer appears), while quick-capture `?问题` still auto-sends — both live in web/src/pages/timeline.tsx (initialInput vs initialQuestion).
- With WeChat channel unconfigured in prod, 设置页 push-prefs card text and both hints contain no 「微信」 and the WeChat binding card is hidden entirely (fail-closed via getWechatBinding()).
- Occasionally a quick-capture submit fails and the content is returned to the textarea (R88 fail-return behavior) — just resubmit.

## Production testing tips (learned R116)
- Insight scope bar (`data-testid="insight-scope"`, 洞察 page top): time select + tag select + 重置. To force the 「该范围内没有记录」 empty state on a fresh account (all notes today), backdate one note via d1: `UPDATE notes SET created_at = datetime('now','-10 days') WHERE user_id=... AND content LIKE ...`, then pick 近 7 天 + that note's tag. Backdating also triggers a 今日回顾 card on the timeline.
- d1 compound SELECT is limited (~10 terms): a 17-table residue audit as one UNION ALL fails with `too many terms in compound SELECT`; loop per table instead (USER_ID_TABLES + NOTE_ID_TABLES from backend/src/account.ts — 15 user_id tables + attachments/note_embeddings by note_id).
- wrangler d1 works with `CLOUDFLARE_API_TOKEN=$CLOUDFLARE_WORKERS_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID=ddff52d24ee44e21a021c15eaffcc86d` (personal-scope secret `secret:personal:CLOUDFLARE_WORKERS_API_TOKEN`).
- R116 refusal wording: asking a detail absent from recalled topic notes (e.g. 吉他颜色 when only brand/price noted) must yield 「找到了相关的笔记，但里面没有提到你问的这个信息：」+ suggestion cards; plain 「没找到相关笔记」 is only for zero recall.
- Trash page is off-nav: fastest route is URL `#/trash` (or 设置 → 打开最近删除). 全部彻底删除 uses an inline 确认清空 confirm in the header row, no modal.

## Production testing tips (learned R120)
- Prod login API returns the token under `api_token` (not `token`): `SUINIAN_TOKEN=$(curl -s -X POST .../api/auth/login -H 'content-type: application/json' -d '{"name":...,"password":...}' | jq -r .api_token)` — handy for `scripts/triage-eval.ts`.
- `browser_console`/CDP may fail to attach even with `--remote-debugging-port=9222` up; plan token extraction via the login API rather than localStorage.

## Production testing tips (learned R122)
- wrangler d1 remote: `CLOUDFLARE_WORKERS_API_TOKEN` may return 7403 "account not authorized"; fall back to `CLOUDFLARE_GLOBAL_API_TOKEN` (org secret) as `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID=ddff52d24ee44e21a021c15eaffcc86d`.
- `scripts/triage-eval.ts` fetch window fixed in R122 follow-up (limit=100; must stay ≥ corpus size). Still run it on a dedicated fresh account (register via `/api/auth/register`, delete via `DELETE /api/auth/me`) so pre-existing notes don't eat the window.
- The unified sensitive gate (backend/src/ingest.ts): skip_triage (`!` raw-save) uses only the high-precision detector — a bare "口令 P@ss2026" (no assignment verb like 改成了/是/：) stays plaintext BY DESIGN; use "口令改成了 X" style samples to exercise that path. `/api/notes/:id/retry-media` returns 该笔记无需重试 unless extraction actually failed — hard to exercise on prod.
- Sensitive notes scrub `meta.raw_transcript` (fixed in R122 follow-up): createNote pre-check / applyTriage / retry-media all delete it; non-sensitive notes keep it intact.
- bulk_ingest rate limit: import and restore share one 3/min bucket; 4th call in a minute → 429.
- Offline queue (R122 P1-3): DevTools Network → Offline, quick-capture shows "N 条离线速记待同步"; back to No throttling auto-flushes (201s) — notes appear without reload.

## Production testing tips (learned R126)
- 竞态编辑 UI 手法：速记后在同一 computer-use action batch 内点 ⋯→编辑→Ctrl+A→粘贴→保存，可压到创建后 ~1-2s；若编辑落在分拣写回之后会弹 409 冲突面板（「这条笔记刚被其他设备修改…」），保留输入再点保存即可成功。
- 分拣写回带 CAS（R126 P0）：窗口内编辑过的笔记内容永不回滚，但 AI 标题/分类可能延迟（meta.needs_retriage 交 cron 复判），「AI 分拣中…」徽标残留属设计内。
- R2 残留核对：Cloudflare REST `GET /accounts/<id>/r2/buckets/suinian-media/objects?prefix=media/<uid>/`——WORKERS token 返回 10000 Authentication error，需用 `CLOUDFLARE_GLOBAL_API_TOKEN`。
- ask 精确统计路由（R126）：极值（最早/最新/最长）、分类计数（待办/想法/收藏/资料）、敏感计数、日均、绝对月份「7 月」（可带空格）均走 SQL，答案带「数据库精确查询/统计」口径。

## Devin Secrets Needed
- `CLOUDFLARE_WORKERS_API_TOKEN` (+ account id auto-resolved) for wrangler d1 remote queries and worker deploys.
- `CLOUDFLARE_GLOBAL_API_TOKEN` (org) for Workers AI REST calls (`/ai/run/*`, used by thread-cross-eval.ts) and as fallback for wrangler d1.
