# AppForge AI Studio

An AI-assisted development environment: describe a web app in natural
language, and an autonomous agent creates, modifies, builds, previews and
packages it. Real generated code, real builds, real previews — no mockups.

**Created by jpecina.**

> Status: **Phase 1 in development.** The studio backend/frontend are being
> built by another team against `CONTRACT.md`. This repo currently contains
> the verified project templates, infrastructure, and docs.

## How it works

1. **Create App** — write a prompt describing the app you want.
2. **Chat** — the agent asks only when a decision is truly unavoidable,
   then generates files, installs dependencies, builds and validates.
3. **Preview** — a live preview of the real app opens in the workspace
   panel (`/p/:projectId/`).
4. **Iterate** — request changes in the chat; the agent patches files
   incrementally and rebuilds.
5. **Ship** — download a ZIP (Phase 1) or deploy to Vercel (Phase 3).

## Quickstart (local dev)

Requirements: Node.js 22+, npm, git. A Groq or OpenRouter API key.

```bash
git clone <this-repo> appforge && cd appforge
cp .env.example .env        # then edit .env (see below)
npm install                 # once apps/server, apps/worker, packages/shared exist
./infra/scripts/dev.sh       # starts backend (tsx :3001) + studio frontend (vite)
```

Open the studio frontend URL printed by Vite. If `APPFORGE_ADMIN_TOKEN` is
set in `.env`, the studio shows a login screen — paste the token once; it
is stored in `localStorage['appforge_token']`.

## Getting an LLM API key

AppForge consumes AI through APIs (no local inference). The default
provider is **Groq** (fast, generous free tier):

1. Go to https://console.groq.com/keys and create an API key.
2. Put it in `.env` as `GROQ_API_KEY=...`
3. (Alternative) Use OpenRouter: https://openrouter.ai/keys → set
   `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY=...`.

The provider and model can be changed at any time from **Settings** in the
studio UI — no code changes needed. For automated tests only, the backend
supports `APPFORGE_LLM_STUB=1`, a deterministic fake provider that is
explicitly **not** real AI.

## Project layout

```
appforge/
  CONTRACT.md               # the single source of truth (API, DB, agent, tools)
  apps/studio/              # React frontend (Vercel) — other team
  apps/server/              # Fastify API + coordination — other team
  apps/worker/              # agent orchestrator + tool registry — other team
  packages/shared/          # shared TS types — other team
  templates/static-react/   # ✅ VERIFIED: Vite+React+TS+Tailwind v4 base template
  templates/dynamic-react-node/ # Phase 2 placeholder (intentionally empty)
  infra/                    # Dockerfile, docker-compose.yml, Caddyfile, scripts/
  docs/ARCHITECTURE.md      # design decisions, run flow, limits, security
  .env.example              # all environment variables, documented
```

## Phase 1 acceptance tests — status

| Test | Scenario | Status |
|---|---|---|
| A | Static app (tic-tac-toe vs AI): prompt → code → build → preview, playable | ⏳ pending (needs backend+agent) |
| B | Dynamic app (task manager + persistent DB) | ⏳ Phase 2 |
| C | Incremental change ("add completed filter") without full regen | ⏳ pending (needs backend+agent) |
| D | Controlled build error → limited repair → rebuild → report | ⏳ pending (needs backend+agent) |
| E | Server restart: projects, chats, builds, interrupted runs recovered | ⏳ pending (needs backend) |
| F | ZIP download: complete code, lockfile, README, no secrets/artifacts | ⏳ pending (needs backend) |
| G | Deploy static app to Vercel, verify URL | ⏳ Phase 3 |

**Verified so far:** `templates/static-react` installs cleanly and
`npm run build` (typecheck + production build) succeeds, producing
`dist/index.html` (checked 2026-10-12). The `infra/` Docker/Caddy files
are syntactically valid YAML/shell but have **not** been exercised —
there is no Docker available in this environment, so container behavior
is untested until Oracle.

## Roadmap

- **Phase 1** — Studio UI, agent with Groq/OpenRouter, static-app
  generation, builds, previews, library, ZIP download, SQLite persistence.
- **Phase 2** — Dynamic apps: per-project Node backend + SQLite, isolated
  execution, full-stack preview. (`templates/dynamic-react-node` is the
  placeholder.)
- **Phase 3** — Deployments: Vercel for frontends, Oracle containers for
  backends, deployment states and history.
- **Phase 4** — Agent improvements: smarter context, diffs, restores,
  token optimization, metrics.
- **Phase 5** — Final polish: responsive, PWA, i18n (ES/EN), analytics,
  docs, tests.

## Deploying the studio itself (Oracle Cloud)

```bash
bash infra/scripts/install.sh   # apt, Node 22, git, repo, .env (optional Caddy)
# edit .env, then:
cd infra && docker compose up -d --build
```

Caddy reverse-proxies `:80 → studio:3001`; uncomment the TLS block in
`infra/Caddyfile` and set your domain for automatic HTTPS.
