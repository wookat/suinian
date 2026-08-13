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

## Devin Secrets Needed
- `CLOUDFLARE_WORKERS_API_TOKEN` (+ account id auto-resolved) for wrangler d1 remote queries and worker deploys.
