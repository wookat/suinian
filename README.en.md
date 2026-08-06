<div align="center">

# Suinian (碎念)

**Open-source, self-hostable AI inbox: dump anything into WeChat, AI sorts it, threads recurring thoughts, and sends you a weekly report.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Live demo](https://suinian.zalize.com) · [Self-host in ~3 minutes](docs/self-host.md) · [中文 README](README.md)

<img src="docs/assets/screenshot-timeline-light.png" alt="Suinian timeline" width="80%" />

</div>

Suinian is a self-hosted AI note inbox that auto-sorts anything you dump in (ideas, todos, links, sensitive data), clusters recurring thoughts into threads, and sends weekly "what have you been thinking about" reports. Runs on Cloudflare Workers + D1.

## Why Suinian?

- **Zero-friction capture**: send a message to a WeChat bot (optional bridge), share from any Android app, or use the Web quick-capture box / REST API. No new habit required.
- **AI auto-sorting**: every note is automatically classified (idea / todo / collect / data) and tagged by DeepSeek — no manual tagging.
- **Thought threads** (the soul feature): fragments about the same topic scattered across weeks are automatically clustered into threads (bge-m3 embeddings + AI confirmation), so you can see how an idea grows.
- **Weekly reports**: every Monday, an AI-written report on "what you've been thinking about this week".
- **Sensitive-content encryption**: notes detected as sensitive (passwords, keys, card numbers) are stored AES-256-GCM encrypted.
- **Self-hosted & free**: full stack runs in your own Cloudflare account (Workers + D1, free tier is enough for personal use); bring your own DeepSeek API key. MIT licensed.
- **API-first / agent-ready**: the REST API can be plugged into Claude, OpenClaw, or any agent as a personal memory source — see [docs/integrations.md](docs/integrations.md).

Compared to flomo (Agent locked behind the paid MAX tier, manual tagging, no thread view), Cubox (read-later only, subscription), and OmniBox (closed source, moving to paid): Suinian is the only combination of **auto-sorting + automatic thought-thread clustering + encryption + open-source self-hosting**, for free.

## Screenshots

| Thought threads | Weekly report |
|---|---|
| <img src="docs/assets/screenshot-threads.png" alt="Thought threads" /> | <img src="docs/assets/screenshot-reports.png" alt="Weekly report" /> |

## Quick Start (~3 minutes)

Requirements: a Cloudflare account + a [DeepSeek API key](https://platform.deepseek.com/). Full guide: [docs/self-host.md](docs/self-host.md).

```bash
git clone https://github.com/wookat/suinian.git && cd suinian

# 1) Backend: D1 + Workers
cd backend && npm install
npx wrangler d1 create suinian          # put the returned database_id into wrangler.toml
npx wrangler d1 migrations apply suinian --remote
npx wrangler secret put DEEPSEEK_API_KEY
openssl rand -base64 32 | npx wrangler secret put SUINIAN_ENC_KEY
npx wrangler deploy                     # remove/replace the custom-domain routes in wrangler.toml first
npx wrangler d1 execute suinian --remote --command \
  "INSERT INTO users (id,name,api_token) VALUES ('u_me','me','$(openssl rand -hex 24)')"

# 2) Web app: Cloudflare Pages
cd ../web && npm install && npm run build
npx wrangler pages deploy dist --project-name suinian

# 3) Open the web app → fill in API URL and token on the Settings page → start dumping notes
```

The WeChat entry point is optional (see [skill/README.md](skill/README.md)); Web + API alone is a complete experience.

## Repository layout

| Directory | Contents | Stack |
|---|---|---|
| [`backend/`](backend/) | notes API, DeepSeek sorting pipeline, thread clustering, weekly reports, encryption | Cloudflare Workers + Hono + D1 |
| [`web/`](web/) | timeline / todos / threads / reports views, PWA | React 19 + Vite + Tailwind v4 + shadcn/ui |
| [`skill/`](skill/) | WeChat bot bridge (standalone process) + OpenClaw skill | Node.js / Docker |
| [`android/`](android/) | share receiver, home-screen widget, native viewer | Kotlin + Jetpack Compose |
| [`docs/`](docs/) | [self-hosting guide](docs/self-host.md), [SPEC](docs/SPEC.md), [agent integrations](docs/integrations.md) | — |

## API & agent integration

All endpoints are documented in [backend/README.md](backend/README.md) — notes CRUD, natural-language Q&A (`POST /api/ask`), thread rebuild, on-demand report generation, and full export (JSON or Markdown). [docs/integrations.md](docs/integrations.md) shows how to use Suinian as a personal memory source for Claude, OpenClaw, or any agent with curl examples.

## Contributing & license

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Released under the [MIT License](LICENSE).
