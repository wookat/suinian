# R83 Test Plan (PR #99 — docs-only release readiness)

All local; do NOT touch production.

## Test 1: Local-dev walkthrough from docs/self-host.md「本地开发」works as documented
Steps (shell):
1. `cd backend && cp .dev.vars.example .dev.vars && npm run dev:init && npm run dev` (port 8787)
   - Pass: dev:init applies migrations without error; `curl http://127.0.0.1:8787/health` returns ok.
2. `cd web && cp .env.example .env.local && npm run dev` (port 5173)
   - Pass: Vite serves http://localhost:5173.

## Test 2 (browser, recorded): Register local account and mock AI triage
1. Open http://localhost:5173, onboarding modal appears; choose「注册新账号」→ lands on #/auth.
   - Pass: auth page shows API 地址 field prefilled/settable to http://127.0.0.1:8787.
2. Register user `qa-r83-local` with a password (≥8 chars).
   - Pass: registration succeeds and app enters real (non-demo) mode with empty timeline.
3. In the quick-capture box, submit a note like「测试本地 mock 分拣：明天买牛奶」.
   - Pass: note appears; within a few seconds AI triage badge shows category「想法/idea」and tag「本地开发」(exact mock output from backend/src/ai.ts:22-36). If badge never appears or shows no tag, FAIL.

## Test 3 (shell): Repo checks
- backend: `npm test` and `npm run typecheck` both exit 0.
- web: `npm run lint` and `npm run build` both exit 0.
