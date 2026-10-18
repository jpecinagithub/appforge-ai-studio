#!/usr/bin/env bash
# AppForge educational installer for an existing shared Ubuntu/Debian Docker host.
# It never installs/reconfigures Docker, never binds 80/443 and never touches
# containers, networks or volumes outside the appforge-edu namespace.
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-$HOME/appforge-ai-studio-edu}"
REPO_URL="${REPO_URL:-https://github.com/jpecinagithub/appforge-ai-studio.git}"
APPFORGE_REF="${APPFORGE_REF:-}"
APPFORGE_PUBLIC_ORIGIN="${APPFORGE_PUBLIC_ORIGIN:-}"
APPFORGE_SHARED_PORT="${APPFORGE_SHARED_PORT:-3201}"

fail() { echo "install-shared: FAIL: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[ "$(uname -s)" = Linux ] || fail "Linux is required"
[ -n "$APPFORGE_REF" ] || fail "APPFORGE_REF must be a full commit SHA or immutable tag"
[[ "$APPFORGE_REF" =~ ^[0-9a-fA-F]{40}$|^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$ ]] || fail "invalid APPFORGE_REF"
[[ "$APPFORGE_PUBLIC_ORIGIN" =~ ^https?://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(:[0-9]{1,5})?$ ]] \
  || fail "APPFORGE_PUBLIC_ORIGIN must be one browser origin without a path"
[[ "$APPFORGE_SHARED_PORT" =~ ^[0-9]+$ ]] \
  && [ "$APPFORGE_SHARED_PORT" -ge 1024 ] \
  && [ "$APPFORGE_SHARED_PORT" -le 65535 ] \
  || fail "APPFORGE_SHARED_PORT must be an unprivileged TCP port"

for command in git docker openssl curl; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  fail "Docker daemon is unavailable"
fi
"${DOCKER[@]}" compose version >/dev/null 2>&1 || fail "Docker Compose plugin is required"
if command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :$APPFORGE_SHARED_PORT" | grep -q .; then
  owned_port="$("${DOCKER[@]}" inspect --format '{{with index .NetworkSettings.Ports "3001/tcp"}}{{(index . 0).HostPort}}{{end}}' appforge-edu-studio 2>/dev/null || true)"
  [ "$owned_port" = "$APPFORGE_SHARED_PORT" ] \
    || fail "127.0.0.1:$APPFORGE_SHARED_PORT is already used by another service"
fi

groq_key="${GROQ_API_KEY:-}"
openrouter_key="${OPENROUTER_API_KEY:-}"
if [ ! -e "$APP_DIR/.env" ]; then
  [ "${#groq_key}" -ge 20 ] || [ "${#openrouter_key}" -ge 20 ] || fail "provide GROQ_API_KEY or OPENROUTER_API_KEY"
fi
if [ "${#groq_key}" -ge 20 ]; then llm_provider=groq; else llm_provider=openrouter; fi

step "fetching immutable source"
if [ -e "$APP_DIR" ] && [ ! -d "$APP_DIR/.git" ]; then fail "$APP_DIR exists and is not a Git checkout"; fi
if [ ! -d "$APP_DIR/.git" ]; then git clone --filter=blob:none "$REPO_URL" "$APP_DIR"; fi
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
  step "creating protected environment file"
  admin_token="$(openssl rand -hex 32)"
  docker_gid="$(stat -c '%g' /var/run/docker.sock)"
  {
    echo 'PORT=3001'
    echo 'DATA_DIR=/data/appforge'
    printf 'APPFORGE_ADMIN_TOKEN=%s\n' "$admin_token"
    printf 'CORS_ORIGIN=%s\n' "$APPFORGE_PUBLIC_ORIGIN"
    echo 'APPFORGE_BROWSER_EXECUTABLE=/usr/bin/chromium'
    echo 'APPFORGE_PRODUCTION=1'
    echo 'APPFORGE_SHUTDOWN_TIMEOUT_MS=30000'
    printf 'DOCKER_GID=%s\n' "$docker_gid"
    echo 'APPFORGE_MAX_CONCURRENT_DEPLOYS=1'
    echo 'APPFORGE_SITE_ADDRESS=:80'
    printf 'APPFORGE_SHARED_PORT=%s\n' "$APPFORGE_SHARED_PORT"
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
  step "keeping existing protected environment file"
  ensure_env_key() {
    local key="$1" value="$2"
    if ! awk -F= -v key="$key" '$1 == key { found=1 } END { exit !found }' "$env_file"; then
      printf '%s=%s\n' "$key" "$value" >>"$env_file"
    fi
  }
  ensure_env_key APPFORGE_BROWSER_EXECUTABLE /usr/bin/chromium
  ensure_env_key APPFORGE_PRODUCTION 1
  ensure_env_key APPFORGE_SHUTDOWN_TIMEOUT_MS 30000
  ensure_env_key DOCKER_GID "$(stat -c '%g' /var/run/docker.sock)"
  ensure_env_key APPFORGE_MAX_CONCURRENT_DEPLOYS 1
  ensure_env_key APPFORGE_SITE_ADDRESS :80
  ensure_env_key APPFORGE_SHARED_PORT "$APPFORGE_SHARED_PORT"
  ensure_env_key APPFORGE_LLM_STUB ''
fi
unset groq_key openrouter_key GROQ_API_KEY OPENROUTER_API_KEY

compose="$APP_DIR/infra/docker-compose.shared.yml"
step "running shared-host preflight"
bash "$APP_DIR/infra/scripts/preflight.sh" --env "$env_file" --compose "$compose"

step "building and starting isolated educational stack"
"${DOCKER[@]}" compose --env-file "$env_file" -f "$compose" up -d --build
for _ in $(seq 1 90); do
  status="$("${DOCKER[@]}" inspect --format '{{.State.Health.Status}}' appforge-edu-studio 2>/dev/null || true)"
  [ "$status" = healthy ] && break
  [ "$status" != unhealthy ] || { "${DOCKER[@]}" logs --tail 100 appforge-edu-studio >&2; fail "Studio became unhealthy"; }
  sleep 2
done
[ "$("${DOCKER[@]}" inspect --format '{{.State.Health.Status}}' appforge-edu-studio)" = healthy ] \
  || fail "Studio health timeout"

evidence_dir="$APP_DIR/.appforge-evidence"
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
printf '{"schema":1,"installedAt":"%s","commit":"%s","ref":"%s","mode":"shared-educational","health":"ok","bind":"127.0.0.1:%s"}\n' \
  "$timestamp" "$resolved" "$APPFORGE_REF" "$APPFORGE_SHARED_PORT" >"$evidence_dir/install-shared-$timestamp.json"
chmod 600 "$evidence_dir/install-shared-$timestamp.json"

echo "install-shared: OK: AppForge $resolved is healthy on 127.0.0.1:$APPFORGE_SHARED_PORT"
