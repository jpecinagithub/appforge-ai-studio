#!/usr/bin/env bash
# AppForge 7C unattended installer for a dedicated Ubuntu/Debian Oracle VM.
# Required inputs: APPFORGE_REF (immutable tag/full SHA) and one LLM API key.
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-$HOME/appforge-ai-studio}"
REPO_URL="${REPO_URL:-https://github.com/jpecinagithub/appforge-ai-studio.git}"
APPFORGE_REF="${APPFORGE_REF:-}"
APPFORGE_PUBLIC_ORIGIN="${APPFORGE_PUBLIC_ORIGIN:-}"
APPFORGE_SITE_ADDRESS="${APPFORGE_SITE_ADDRESS:-:80}"

fail() { echo "install: FAIL: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[ "$(uname -s)" = Linux ] || fail "Linux is required"
[ -n "$APPFORGE_REF" ] || fail "APPFORGE_REF must be an immutable tag or full commit SHA"
[[ "$APPFORGE_REF" =~ ^[0-9a-fA-F]{40}$|^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$ ]] || fail "invalid APPFORGE_REF"
[[ "$APPFORGE_PUBLIC_ORIGIN" =~ ^https?://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(:[0-9]{1,5})?$ ]] \
  || fail "APPFORGE_PUBLIC_ORIGIN must be one explicit origin without a path"
case "$APPFORGE_PUBLIC_ORIGIN$APPFORGE_SITE_ADDRESS${GROQ_API_KEY:-}${OPENROUTER_API_KEY:-}" in
  *$'\n'*|*$'\r'*) fail "configuration values cannot contain line breaks" ;;
esac
groq_key="${GROQ_API_KEY:-}"
openrouter_key="${OPENROUTER_API_KEY:-}"
if [ ! -e "$APP_DIR/.env" ]; then
  [ "${#groq_key}" -ge 20 ] || [ "${#openrouter_key}" -ge 20 ] || fail "provide GROQ_API_KEY or OPENROUTER_API_KEY"
fi
if [ "${#groq_key}" -ge 20 ]; then llm_provider=groq; else llm_provider=openrouter; fi
command -v sudo >/dev/null 2>&1 || fail "sudo is required"
sudo -n true >/dev/null 2>&1 || fail "passwordless sudo is required for unattended installation"

. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) fail "only Ubuntu/Debian are supported" ;; esac
[ -n "${VERSION_CODENAME:-}" ] || fail "distribution codename is unavailable"

step "Installing Docker Engine and Compose from Docker's signed apt repository"
sudo -n apt-get update -qq
sudo -n apt-get install -y -qq ca-certificates curl git openssl
sudo -n install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" \
  | sudo -n tee /etc/apt/keyrings/docker.asc >/dev/null
sudo -n chmod a+r /etc/apt/keyrings/docker.asc
arch="$(dpkg --print-architecture)"
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
  "$arch" "$ID" "$VERSION_CODENAME" \
  | sudo -n tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo -n apt-get update -qq
sudo -n apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo -n systemctl enable --now docker

step "Fetching the requested immutable source"
if [ -e "$APP_DIR" ] && [ ! -d "$APP_DIR/.git" ]; then
  fail "$APP_DIR exists and is not a Git checkout"
fi
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --filter=blob:none "$REPO_URL" "$APP_DIR"
fi
[ -z "$(git -C "$APP_DIR" status --porcelain)" ] || fail "repository has local changes"
git -C "$APP_DIR" remote set-url origin "$REPO_URL"
git -C "$APP_DIR" fetch --force --tags origin
resolved="$(git -C "$APP_DIR" rev-parse --verify "$APPFORGE_REF^{commit}")" || fail "APPFORGE_REF cannot be resolved"
if [[ "$APPFORGE_REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
  [ "${resolved,,}" = "${APPFORGE_REF,,}" ] || fail "resolved commit differs from APPFORGE_REF"
fi
git -C "$APP_DIR" checkout --detach "$resolved"

env_file="$APP_DIR/.env"
if [ ! -e "$env_file" ]; then
  step "Creating a protected production environment file"
  admin_token="$(openssl rand -hex 32)"
  docker_gid="$(stat -c '%g' /var/run/docker.sock)"
  {
    echo 'PORT=3001'
    echo 'DATA_DIR=/data/appforge'
    printf 'APPFORGE_ADMIN_TOKEN=%s\n' "$admin_token"
    printf 'CORS_ORIGIN=%s\n' "$APPFORGE_PUBLIC_ORIGIN"
    echo 'APPFORGE_BROWSER_EXECUTABLE=/usr/bin/chromium'
    echo 'APPFORGE_PRODUCTION=1'
    printf 'DOCKER_GID=%s\n' "$docker_gid"
    echo 'APPFORGE_MAX_CONCURRENT_DEPLOYS=1'
    printf 'APPFORGE_SITE_ADDRESS=%s\n' "$APPFORGE_SITE_ADDRESS"
    printf 'LLM_PROVIDER=%s\n' "$llm_provider"
    echo 'LLM_MODEL='
    echo 'LLM_TEMPERATURE=0.2'
    echo 'LLM_MAX_TOKENS=8000'
    echo 'LLM_TIMEOUT_MS=120000'
    printf 'GROQ_API_KEY=%s\n' "$groq_key"
    printf 'OPENROUTER_API_KEY=%s\n' "$openrouter_key"
    echo 'APPFORGE_LLM_STUB='
    echo 'VITE_API_URL='
  } >"$env_file"
  chmod 600 "$env_file"
  unset admin_token
else
  [ -f "$env_file" ] && [ ! -L "$env_file" ] || fail ".env must be a regular non-symlink file"
  chmod 600 "$env_file"
  step "Keeping the existing protected environment file"
fi

unset groq_key openrouter_key GROQ_API_KEY OPENROUTER_API_KEY

step "Running fail-closed production preflight"
bash "$APP_DIR/infra/scripts/preflight.sh" --env "$env_file" --compose "$APP_DIR/infra/docker-compose.yml"

step "Building and starting AppForge"
sudo -n docker compose --env-file "$env_file" -f "$APP_DIR/infra/docker-compose.yml" up -d --build

step "Waiting for the trusted Studio healthcheck"
for _ in $(seq 1 90); do
  status="$(sudo -n docker inspect --format '{{.State.Health.Status}}' appforge-studio 2>/dev/null || true)"
  [ "$status" = healthy ] && break
  [ "$status" != unhealthy ] || { sudo -n docker logs --tail 100 appforge-studio >&2; fail "Studio became unhealthy"; }
  sleep 2
done
[ "$(sudo -n docker inspect --format '{{.State.Health.Status}}' appforge-studio)" = healthy ] || fail "Studio health timeout"
sudo -n docker exec appforge-studio curl --fail --silent http://127.0.0.1:3001/healthz >/dev/null

evidence_dir="$APP_DIR/.appforge-evidence"
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
cat >"$evidence_dir/install-$timestamp.json" <<EOF
{"schema":1,"installedAt":"$timestamp","commit":"$resolved","ref":"$APPFORGE_REF","health":"ok"}
EOF
chmod 600 "$evidence_dir/install-$timestamp.json"

echo "install: OK: AppForge commit $resolved is healthy at $APPFORGE_PUBLIC_ORIGIN"
