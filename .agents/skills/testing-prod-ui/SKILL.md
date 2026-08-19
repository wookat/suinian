---
name: testing-prod-ui
description: How to run browser UI / accessibility / cache-identity tests against the suinian production deployment (suinian.zalize.com)
---

# Testing suinian production Web UI

- Prod Web: https://suinian.zalize.com, API: https://suinian-api.zalize.com. Cloudflare blocks non-browser UAs; use a real browser (or curl with a Chrome UA) for API calls.
- QA accounts: register throwaway accounts via 设置 → 账号 → 注册/登录 (username + password, recovery code shown once). Report any created accounts to the user for cleanup. Never touch u_boss or real accounts.
- Chinese input via computer-use `type` may fail; write text to clipboard instead: `printf '中文' | xclip -selection clipboard` then Ctrl+V in the page.
- `read_dom`/`browser_console` may attach to the wrong Chrome window if multiple are open — check `wmctrl -l` and close extras.
- Ask streaming (R174/R176): citations `[n]` are plain text while streaming and become clickable after `done`. Verify markers are separate elements and citation count matches max marker index.
- Sensitive notes: masked by default with `aria-label="敏感内容，点击查看"` button; click reveals plaintext + 隐藏 button.
- Cache identity (R166): cache name `suinian-api`, key param `sn_uid=<first 8 bytes of sha256(token) as hex, i.e. 16 hex chars>`. Cache *writes* come from the Service Worker, but the scrub (`scrubApiCacheForToken`) is app-level (main.tsx load + token change). If prod SW is stuck installing (seen: "#0 trying to install", settings page shows 离线缓存正在安装中), you can still test the scrub by manually seeding an entry via `caches.open('suinian-api').put(url?sn_uid=<fp>)` in console, switching accounts in the UI, and asserting the old-fp entry is deleted.
- Lighthouse: `npx lighthouse https://suinian.zalize.com --chrome-flags="--headless=new" --output=json` (add `--preset=desktop` for desktop). Works headless despite Cloudflare.
- Auth API: login response token field is `api_token` (not `token`); account deletion is `DELETE /api/auth/me` → `{"ok":true}`, after which the token returns 401.
- Settings appearance has theme options (浅色/深色/跟随系统) plus a 字号 control (小/标准/大/特大) as of R195.
- PWA / Service Worker testing (R194/R195):
  - Page-level `page.route('**/sw.js*')` does NOT intercept the SW script fetch (it bypasses the page network stack). Use a browser-level CDP session: `browser.newBrowserCDPSession()` + `Fetch.enable {patterns:[{urlPattern:'*sw.js*'}]}` + `Fetch.failRequest`. Unregister the existing SW first, then hard-reload to trigger `onRegisterError` → banner 「离线缓存不可用（Service Worker 注册失败）…」.
  - Offline emulation via `Network.emulateNetworkConditions {offline:true}` only lasts while the CDP session is attached — keep the node process alive (setInterval) and restore online on SIGTERM. Verify with `navigator.onLine === false` + failing fetch before testing.
  - After a simulated sw.js block, Chrome's SW registration job queue can wedge for the profile: `register()` never resolves, the app's 重试安装离线缓存 button spins forever, and clearing Storage/hard reload/browser restart don't help. Recovery: kill Chrome, `rm -rf '<user-data-dir>/Default/Service Worker'`, relaunch (login in localStorage survives).
  - Offline image outbox: uploading while offline shows 「1 条离线记录（含图片/文件/录音）待同步，联网后自动补发」 under the quick input; going back online auto-resends without user action. The banner doubles as a manual retry button (点击立即重试同步).
- This test box's browser network to the prod API intermittently hangs ~60s per request (status 0) while curl succeeds in 0.2s — retry the UI action or use the outbox retry banner; don't misattribute it to prod.
- Devin-managed Chrome runs on DISPLAY=:0 with `--user-data-dir=/home/ubuntu/.browser_data_dir` and `--remote-debugging-port=29229`; if you must restart it, reuse the full original command line (`cat /proc/$(pgrep -f remote-debugging-port)/cmdline | tr '\0' ' '`) so CDP tools keep working, and re-maximize with `DISPLAY=:0 wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`.

## Devin Secrets Needed
none (QA accounts are self-registered)
