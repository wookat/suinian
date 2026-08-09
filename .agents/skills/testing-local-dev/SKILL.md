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
- Note: typing CJK text via computer-use `type` into the textarea may drop characters; use ASCII text for reliability.

## Repo checks
- backend: `npm test` (vitest), `npm run typecheck`
- web: `npm run lint` (oxlint, warnings ok), `npm run build` (tsc + vite)

## Production caution
Never test against https://suinian-api.zalize.com unless explicitly allowed; if unavoidable, use a `[QA-...]`-prefixed account and delete it after.
