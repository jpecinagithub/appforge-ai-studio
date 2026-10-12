# AppForge AI Studio — backend container
FROM node:22-slim

# ---------------------------------------------------------------------------
# Environment variables (all documented; see .env.example at repo root):
#   PORT                 API listen port (default 3001)
#   DATA_DIR             data root: projects + appforge.db (default /data/appforge)
#   APPFORGE_ADMIN_TOKEN if set, every /api/* and /p/* route requires
#                        Authorization: Bearer <token>
#   CORS_ORIGIN          allowed frontend origin (default "*" in dev)
#   LLM_PROVIDER         groq | openrouter (default groq)
#   LLM_MODEL            model id (provider default if empty)
#   LLM_TEMPERATURE      default 0.2
#   LLM_MAX_TOKENS       default 8000
#   LLM_TIMEOUT_MS       default 120000
#   GROQ_API_KEY         LLM credential (never leaves the backend)
#   OPENROUTER_API_KEY   LLM credential (never leaves the backend)
#   APPFORGE_LLM_STUB    =1 enables a deterministic fake LLM provider.
#                        FOR AUTOMATED TESTS ONLY. Never real AI.
# ---------------------------------------------------------------------------

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install workspace dependencies first so this layer is cached.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspaces --include-workspace-root

# tsx runs the TypeScript server entrypoint without a compile step.
RUN npm install -g tsx@4

# Backend sources only. The studio frontend (apps/studio) ships separately
# to Vercel; it is intentionally NOT baked into this image.
COPY apps/server apps/server
COPY apps/worker apps/worker
COPY packages/shared packages/shared
COPY templates templates

VOLUME /data/appforge
ENV DATA_DIR=/data/appforge
EXPOSE 3001

CMD ["npx", "tsx", "apps/server/src/index.ts"]
