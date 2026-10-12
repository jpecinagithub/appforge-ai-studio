#!/usr/bin/env bash
# AppForge AI Studio — installer for Oracle Cloud Linux (Ubuntu/Debian based).
# Run as a user with sudo rights:  bash infra/scripts/install.sh
# Idempotent where practical; safe to re-run.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/appforge}"
REPO_URL="${REPO_URL:-https://github.com/jpecinagithub/appforge.git}"

echo "==> Updating apt and installing base packages"
sudo apt-get update
sudo apt-get install -y curl git ca-certificates

echo "==> Installing Node.js 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v2[24]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version
npm --version

echo "==> Fetching the repository into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "    repo already present — pulling latest"
  git -C "$APP_DIR" pull --ff-only
elif [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  echo "    using existing non-empty directory (assuming the repo is already there)"
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Creating .env from .env.example (if missing)"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "    created $APP_DIR/.env — EDIT IT before starting (keys, admin token)"
else
  echo "    $APP_DIR/.env already exists — leaving untouched"
fi

if [ "${INSTALL_CADDY:-0}" = "1" ]; then
  echo "==> Installing Caddy (reverse proxy)"
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo apt-get install -y caddy
fi

cat <<EOF

Done. Next steps:

  1. cd $APP_DIR
  2. Edit .env — set at least:
       APPFORGE_ADMIN_TOKEN   (private access to the studio API)
       GROQ_API_KEY           (or OPENROUTER_API_KEY)
       CORS_ORIGIN            (your studio frontend URL)
  3. Start with Docker:
       cd infra && docker compose up -d --build
     or run the backend directly:
       npm install && npx tsx apps/server/src/index.ts

The studio API will listen on port 3001.
For HTTPS, point a domain at this host, uncomment the TLS block in
infra/Caddyfile, and reload Caddy.
EOF
