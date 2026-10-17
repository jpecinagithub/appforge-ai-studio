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
  templates/static-react/   # ✅ VERIFIED: Vite+React+TS+plain CSS base template
  templates/dynamic-react-node/ # ✅ VERIFIED: dynamic pilot — Fastify+SQLite backend, Argon2 auth, migrations, Dockerfile (3 E2E passes on Oracle, 2026-10-16)
  infra/                    # Dockerfile, docker-compose.yml, Caddyfile, scripts/
  docs/ARCHITECTURE.md      # design decisions, run flow, limits, security
  .env.example              # all environment variables, documented
```

## Phase 1 acceptance tests — status

The backend + agent exist and run on Oracle (see `AUDIT_2026-10-13.md`).
Live re-runs use `scripts/acceptance.mjs`: `start` launches the generation
cases, `status` inspects them, `compat` checks the technology gate without
consuming LLM tokens, `verify` asserts no-Tailwind output, successful build,
reachable preview and thumbnail, and a real Chromium `test_preview` in the
run's event log.

| Test | Scenario | Status |
|---|---|---|
| A | Static app (tic-tac-toe vs AI): prompt → code → build → preview, playable | ✅ verified on Oracle 2026-10-13 (audit); re-run with `acceptance.mjs start` + `verify` |
| B | Dynamic app (task manager + persistent DB) | ⏳ Phase 2 |
| C | Incremental change ("add completed filter") without full regen | ⏳ pending live re-run (agent supports `patch_file`) |
| D | Controlled build error → limited repair → rebuild → report | ⏳ pending live re-run |
| E | Server restart: interrupted runs and builds recovered, files preserved | ✅ implemented (`reconcileInterruptedRuns`/`reconcileInterruptedBuilds`) + unit-tested |
| F | ZIP download: complete code, lockfile, README, no secrets/artifacts | ✅ verified on Oracle 2026-10-13 (audit, 22 KB ZIP) |
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
  execution, full-stack preview. (`templates/dynamic-react-node` is
  implemented and verified: 3 E2E passes on Oracle, 2026-10-16; the
  compatibility gate admits the dynamic stack since then.)
- **Phase 3** — Deployments: Vercel for frontends, Oracle containers for
  backends, deployment states and history.
- **Phase 4** — Agent improvements: smarter context, diffs, restores,
  token optimization, metrics.
- **Phase 5** — Final polish: responsive, PWA, i18n (ES/EN), analytics,
  docs, tests.

## Deploying the studio itself (Oracle Cloud)

Production is installed from an exact tag or full commit. The installer creates
the protected admin token, installs Docker/Compose, runs the fail-closed
preflight, starts the hardened stack and waits for health. It does not print
the supplied LLM key or generated token.

```bash
export APPFORGE_REF=fase7c-stable            # use the released 7C tag
export APPFORGE_PUBLIC_ORIGIN=http://203.0.113.10
export GROQ_API_KEY='provided-out-of-band'   # or OPENROUTER_API_KEY
bash infra/scripts/install.sh
```

For a domain already pointing at the VM, also set
`APPFORGE_SITE_ADDRESS=appforge.example.com` and use the corresponding HTTPS
origin. Caddy then manages TLS automatically. A domain is not required for the
Oracle/IP certification.

On `SIGTERM`/`SIGINT`, Studio stops admitting work and gives owned agent runs,
builds and deployments 30 seconds to finish (`APPFORGE_SHUTDOWN_TIMEOUT_MS`).
Docker allows 40 seconds before forcing termination. Work that exceeds the
budget is closed from persisted state by startup reconciliation; source files
and the last healthy live deployment remain the recovery authority.
