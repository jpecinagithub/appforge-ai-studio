# AppForge dynamic template — `dynamic-react-node`

Full-stack starter: **Vite + React 19 + TypeScript + plain CSS** frontend,
**Node.js + Fastify + TypeScript** backend, **SQLite** per project
(`node:sqlite`, WAL), **Argon2id** passwords (`hash-wasm`, no native
builds), **HttpOnly cookie** sessions.

This is the reference implementation of `CONTRACT.md` §9. Generated apps
start from here and the agent extends them.

## Layout

```text
frontend/     # Vite app (base './', calls /api/... relatively — no CORS)
backend/src/  # server.ts, config.ts, db/, auth/, routes/, lib/
migrations/   # NNN_slug.sql — versioned, idempotent, checksummed
tests/        # API tests (node --test) — the contract's acceptance flow
data/         # local dev database only (gitignored)
Dockerfile    # multi-stage: frontend build, backend build, slim runtime
```

## One command per operation (project root)

```bash
npm run install   # npm ci in frontend + backend
npm run migrate   # build backend + apply pending migrations
npm run test      # build backend + run tests/ (full auth + CRUD flow)
npm run build     # build frontend + backend
npm run start     # run the built backend (serves frontend/dist too)
npm run dev       # backend in watch mode (frontend: cd frontend && npm run dev)
```

## Environment

Copy `.env.example` to `.env`. Never commit `.env`. In production the
Studio injects these per project at deploy time:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | container-internal port |
| `NODE_ENV` | `development` | `production` enables `Secure` cookies |
| `DB_PATH` | `./data/app.db` | `/data/app.db` in Docker (volume) |
| `PUBLIC_PATH` | `/` | cookie `Path`; `/a/:id/` when proxied |
| `SESSION_COOKIE_NAME` | `af_session` | HttpOnly, SameSite=Lax |
| `SESSION_TTL_DAYS` | `7` | session lifetime |

## API (same origin)

- `GET /healthz` → `{ok, version}` (public, no sensitive info)
- `POST /api/auth/register` `{email, password≥12}` → `201 {user}` + cookie
- `POST /api/auth/login` → `200 {user}` + cookie (rate-limited 10/min/IP)
- `POST /api/auth/logout` → `200` + session revoked
- `GET /api/auth/me`, `GET /api/users/me` → `200 {user}` | `401`
- `GET/POST /api/todos`, `GET/PATCH/DELETE /api/todos/:id` — always
  scoped to the logged-in user (other users' rows → `404`)

Errors are always `{"error":{"code","message"}}`.

## Docker

```bash
docker build -t myapp .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e DB_PATH=/data/app.db -e NODE_ENV=production \
  -v myapp-data:/data myapp
```

The entrypoint runs pending migrations, then starts the server.
