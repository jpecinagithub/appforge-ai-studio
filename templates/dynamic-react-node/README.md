# templates/dynamic-react-node — ESQUELETO (Fase 2, no implementado)

This template is intentionally empty. It is a placeholder reserved for
Phase 2 of AppForge AI Studio.

## Intended shape (Phase 2)

- `frontend/` — Vite + React + TypeScript app (same base as
  `templates/static-react/`), configured to call the project backend via a
  configurable API URL.
- `backend/` — Node.js + TypeScript API server (Fastify):
  - REST endpoints for the app's own domain logic.
  - Per-project SQLite database (WAL mode), stored outside the container
    volume so rebuilding doesn't lose data.
  - `Dockerfile` for isolated execution.
  - `.env.example` with its own variables.

## Current state

- No code exists yet. Do not treat this directory as a working template.
- Creating "dynamic" projects is disabled until Phase 2 is implemented.

See `docs/ARCHITECTURE.md` and the project roadmap in `README.md`.
