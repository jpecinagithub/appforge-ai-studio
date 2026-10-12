#!/usr/bin/env bash
# AppForge AI Studio — local dev launcher.
# Starts the backend (tsx) and the studio frontend (vite dev) in parallel.
# Usage:  ./infra/scripts/dev.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v node >/dev/null 2>&1 || { echo "error: node is required (v22+)"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "error: npm is required"; exit 1; }

# Load repo-root .env when present (never commit secrets).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${PORT:=3001}"
: "${DATA_DIR:=./data}"
export PORT DATA_DIR

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ -f apps/server/package.json ]; then
  echo "==> backend: tsx apps/server/src/index.ts  (http://localhost:${PORT})"
  (cd apps/server && npx tsx src/index.ts) &
else
  echo "==> backend: apps/server not present — skipping (implemented by another team)"
fi

if [ -f apps/studio/package.json ]; then
  echo "==> frontend: vite dev  (VITE_API_URL should point at the backend)"
  (cd apps/studio && npm run dev) &
else
  echo "==> frontend: apps/studio not present — skipping (implemented by another team)"
fi

wait
