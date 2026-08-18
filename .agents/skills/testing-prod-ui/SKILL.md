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
- Settings appearance has only theme options (浅色/深色/跟随系统) — no font-size control as of R177.

## Devin Secrets Needed
none (QA accounts are self-registered)
