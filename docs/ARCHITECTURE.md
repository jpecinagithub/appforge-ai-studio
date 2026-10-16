# AppForge AI Studio — Architecture

Single source of truth for integration: `CONTRACT.md`.
This document explains the *why* behind the design decisions.

## 1. System overview

```
                         ┌──────────────────────────────────────────┐
                         │  apps/studio  (Vite + React, on Vercel)  │
                         │  chat · workspace · library · settings   │
                         └───────────────┬──────────────────────────┘
                                         │ HTTPS / REST + SSE
                         ┌───────────────▼──────────────────────────┐
                         │  Oracle Cloud VM (single server)         │
                         │                                          │
                         │   Caddy :80/:443 ──► Fastify API :3001   │
                         │                      apps/server         │
                         │                        │                 │
                         │   ┌────────────────────┴──────────────┐  │
                         │   │  apps/worker (single orchestrator) │  │
                         │   │  LLM agent + tool registry        │  │
                         │   │  builds · preview gateway         │  │
                         │   └────────────────────┬──────────────┘  │
                         │                        │                 │
                         │   SQLite WAL ($DATA_DIR/appforge.db)     │
                         │   $DATA_DIR/projects/{id}/frontend/...   │
                         └──────────────────────────────────────────┘
                                         │ (Phase 3)
                         ┌───────────────▼──────────────────────────┐
                         │  Vercel — generated apps (frontend)      │
                         │  Oracle containers — dynamic backends    │
                         └──────────────────────────────────────────┘
```

- **One server, no distributed plumbing.** No Kubernetes, no Redis, no
  message broker. A Fastify API plus an in-process worker backed by a
  database-backed queue is enough for the load of a single-user studio.
- **Frontend and backend are fully decoupled.** The studio frontend talks
  to the backend only over REST + SSE, so it can live on Vercel while the
  backend runs on Oracle.
- **Phase 1 builds and runs generated apps locally on the server.** Previews
  are served by the backend itself from each project's `dist/`
  (`GET /p/:id/*`, SPA fallback), so nothing depends on the user's
  `localhost`.

## 2. Anatomy of an agent run (step by step)

A run starts at `POST /api/projects/:id/runs {prompt}` and is tracked in
the `runs` table (`queued → running → done|error|cancelled`).

1. **Register.** The server creates the run row (`queued`) and the worker
   claims it (one active run per project; a second one gets `409
   RUN_ACTIVE`).
2. **Load context.** The worker reads the project's `PROJECT_CONTEXT.md`,
   the file tree, and the last 20 chat messages. It does NOT dump the
   whole repo into the prompt.
3. **Interpret.** The LLM classifies the request: new app vs. incremental
   change, static vs. dynamic, required features, persistence needs.
4. **Plan (internal, ≤5 tasks).** One short internal plan; the model is not
   allowed to spend several calls re-planning.
5. **Act loop.** The model emits OpenAI-style function calls against the
   tool registry (`list_files`, `read_file`, `write_file`,
   `patch_file`, `delete_file`, `create_directory`, `search_code`,
   `install_dependencies`, `run_command` (allowlist `npm,npx,node`, no
   shell, project `cwd`, timeout), `run_build`, `start_preview`,
   `create_revision`). Every call is confined to the active project
   (`..` and absolute paths are rejected) and recorded as a `run_event`
   streamed over SSE (`tool_call` / `tool_result`).
6. **Validate.** After generation: essential files present → `tsc` →
   `npm run build` → HTTP smoke test of `dist/`. Failures go to a
   bounded repair loop (see §5).
7. **Preview.** `start_preview` = ensure a good build exists and mark the
   preview ready at `/p/:id/`. If `dist/` is missing, the preview route
   returns a diagnostic page (Rebuild / View logs), never a bare JSON
   error.
8. **Deliver.** The agent writes a summary to the chat: what was built,
   features, test results, preview state, limitations. Stats
   (iterations, LLM calls, tokens, timings) are stored in
   `runs.stats_json`.

The frontend subscribes to `GET /api/runs/:runId/events` (SSE): first a
replay of stored `run_events` ordered by `seq`, then live events, with a
`:ping` comment every 15 s, closing on `done`/`error`.

## 3. Key decisions

### Why Fastify
Express would do the job, but Fastify gives schema-based validation
(works naturally with the `zod` validation requirement), lower overhead
for the SSE/event endpoints, and a plugin model that keeps the single
server file small. The contract does not mandate either; Fastify is the
recommended default.

### Why SQLite in WAL mode
The whole studio state (projects, messages, runs, events, builds,
revisions, settings) fits comfortably in one file. WAL mode gives
concurrent readers while the worker writes, and a single file makes
backups trivial (`cp appforge.db`). The schema is deliberately
Postgres-friendly (UUID text keys, ISO 8601 text dates, JSON columns), so
migrating later means swapping the driver layer, not rewriting the app.

### Why a single orchestrator agent
Multi-agent coordination (planner + coder + reviewer…) spends more
tokens on coordination than on code for the app sizes this studio
targets. One orchestrator with tools is faster, simpler to debug, and
sufficient. The tool registry is designed so a second agent could be
added later without changing the tools.

### Why SSE instead of WebSockets
The event flow is strictly server → client (run progress, logs, tool
results). SSE is simpler, auto-reconnects, works through any reverse
proxy, and replays from the `run_events` table on reconnect.

### Why no shell in `run_command`
`run_command` takes `{cmd, args}` — never a shell string — and only
allows `npm`, `npx`, `node`. This eliminates shell-injection entirely and
keeps the allowlist check trivial. Timeouts (`cmdTimeoutMs`) kill
runaway commands.

## 4. Isolation (honest status)

- **Phase 1 (this repo, this environment): there is NO Docker available.**
  Build/execution isolation is therefore:
  - confined working directory (`$DATA_DIR/projects/{id}/`, `..` rejected
    by every tool and by the file API),
  - `run_command` allowlist without shell (`npm`, `npx`, `node` only),
  - timeouts on commands, builds, LLM calls and total run time,
  - generated code is never executed in the main server process.
- **On Oracle (Phase 2+):** `infra/Dockerfile` + `infra/docker-compose.yml`
  run the studio itself in a container; generated-app builds and dynamic
  backends get their own containers with non-root user, CPU/RAM limits,
  restricted filesystem and network, no Docker socket, no studio secrets,
  no cloud metadata access (see §6 for the full checklist). The
  containerization files are already in place; they are not yet exercised
  in this environment.

## 5. Anti-loop limits

Hard limits from the contract (all configurable in Settings):

| Limit | Default |
|---|---|
| Max agent iterations per run | 8 |
| Max auto-repair attempts per failure | 2 |
| LLM call timeout | `LLM_TIMEOUT_MS` (120 000 ms) |
| Command timeout | `cmdTimeoutMs` (180 000 ms) |
| Build timeout | configured per run |
| Total run timeout | `runTimeoutMs` (900 000 ms) |
| Token cap per operation | `LLM_MAX_TOKENS` (8 000) |

Loop detection: 3 identical consecutive tool calls, the same build error
twice, or rewriting the same files with no progress → stop after at most
one alternative strategy, finish with a diagnosis, **keep every
generated file** (a failed generation never destroys the project).
Cancellation: a flag in the DB checked between loop iterations.

## 6. Security checklist

- `APPFORGE_ADMIN_TOKEN`: when set, all `/api/*` and `/p/*` require
  `Authorization: Bearer <token>` (simple private access, no user system).
- Secrets live only in the backend env; Settings returns
  `{configured:true|false}`, never values.
- Rate limit 120 req/min/IP on `/api`; CORS from `CORS_ORIGIN`; `zod`
  validation on all inputs; path traversal rejected (`400
  INVALID_PATH`).
- ZIP export excludes `node_modules/`, `dist/`, `.git/`, `*.db`,
  `*.log`, secrets.
- Generated code is treated as untrusted until validated.
- Container checklist (Oracle): non-root user, CPU/RAM limits, timeouts,
  restricted filesystem, restricted network, no Docker socket, no studio
  keys, no cloud credentials, no metadata endpoint access, per-project
  data isolation.

## 7. Phases — honest table

| Capability | Phase 1 (this repo) | Phase 2 | Phase 3 |
|---|---|---|---|
| Static apps (Vite+React+TS) | ✅ generate → build → preview → ZIP | ✅ | ✅ |
| Dynamic apps (Node backend + SQLite) | ❌ template is a placeholder | 📝 spec closed (CONTRACT §9); build in Phases 3–4 | ✅ |
| LLM agent (single orchestrator) | ✅ Groq / OpenRouter | ✅ + better context/diffs | ✅ |
| Preview | ✅ served from `dist/` at `/p/:id/` | ✅ full-stack | ✅ |
| Revisions (git checkpoints) | ✅ | ✅ | ✅ |
| Deploy to Vercel / Oracle | ❌ `501 PHASE_3`, manual ZIP only | ❌ | ✅ |
| Docker isolation of builds | ❌ workdir+allowlist+timeouts | ✅ | ✅ |
| Multi-user / teams | ❌ single admin token | ❌ | ❌ (out of scope) |

Anything marked ❌ must not be presented in the UI as working (contract
§21: no fake buttons).

## 8. Data layout

```
$DATA_DIR/
  appforge.db                 # SQLite WAL: projects, messages, runs,
                              # run_events, builds, revisions, deployments, settings
  projects/{id}/
    frontend/                 # generated app (copied from templates/static-react)
    backend/                  # Phase 2+
    metadata/
    revisions/                # revision bookkeeping (git lives in frontend/)
    logs/
    PROJECT_CONTEXT.md        # agent's persistent technical summary
```

## 9. Dynamic apps — Phase 2 design rationale (spec only)

CONTRACT.md §9 is the closed spec; this section explains the *why*.

### Why the Studio proxies project containers (no nginx changes)

Each dynamic project gets its own container, but exposing it does NOT
require touching nginx, DNS, or certificates: the Studio reverse-proxies
`/a/:projectId/*` → `http://appforge-app-<id8>:8080/*` over the internal
Docker network. Rationale: one fewer moving part per deploy, no reload
of the host reverse proxy, no wildcard certs. Trade-off: the Studio is
in the request path — acceptable for a single-user studio with a
handful of apps; revisit if traffic ever justifies it.

### Why one live slot + an ephemeral verify container (not blue-green)

Blue-green with a shared database breaks on schema changes (new code
migrates the DB, then a rollback serves old code against a new schema).
The spec instead uses: build → migrate a scratch DB → boot an ephemeral
`-verify` container → health + API + authenticated-flow tests → destroy
it → back up the live DB → migrate live → swap the single live slot.
Rollback = restore the pre-migration backup + boot the previous image.
Simple, auditable, and every step leaves the system in a known state.

### Why `node:sqlite` and `hash-wasm` in the generated template

`better-sqlite3` needs node-gyp (python/make/g++) and prebuilt binaries
often don't exist for linux/arm64 — the exact failure hit on this
server before. `node:sqlite` is built into Node 22.5+: zero native
deps, zero build tools in the generated image. Same logic for
`hash-wasm` (pure-WASM Argon2id) instead of the native `argon2`
package. The generated template must `npm ci` cleanly on a slim image.

### Why the Studio needs Docker access but project containers must not

Someone has to build images and manage containers; that someone is the
Studio's audited Docker module (fixed arg vectors, no shell, validated
ids — never the LLM). On Oracle the Studio deployment therefore mounts
the Docker socket: a deliberate, single, documented point of access.
Project containers get the opposite treatment: no socket, no Studio
keys, no cloud credentials, no metadata endpoint, no egress
(`internal: true` network).

### Why migrations run at container startup AND as an explicit operation

Running pending migrations in the entrypoint makes every boot
self-healing (a restarted container converges to the right schema).
The explicit `run_migrations` operation exists for the agent's
development loop and for observability (the Studio's `migrations`
table). Both use the same runner and the same checksum discipline, so
they can't disagree.

### Why the compatibility gate stays closed until 3× clean E2E

Opening "backend + database + auth" in the UI is a promise the system
must keep. The spec therefore requires the full pipeline (scaffold →
migrate → build → test → verify → promote → rollback drill) to pass
three times from zero, unattended, before the gate admits dynamic
capabilities. Until then §9 is ink, not behavior.
