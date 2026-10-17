#!/usr/bin/env bash
# AppForge 7C production preflight. It never sources or prints the env file.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
DOCKER_PREFIX=()

usage() {
  echo "usage: $0 [--env PATH] [--compose PATH]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) [ "$#" -ge 2 ] || { usage; exit 2; }; ENV_FILE="$2"; shift 2 ;;
    --compose) [ "$#" -ge 2 ] || { usage; exit 2; }; COMPOSE_FILE="$2"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

fail() { echo "preflight: FAIL: $*" >&2; exit 1; }
ok() { echo "preflight: OK: $*"; }

read_env() {
  local key="$1" count value
  count="$(awk -v k="$key" '
    /^[[:space:]]*#/ { next }
    index($0, "=") == 0 { next }
    { p=index($0,"="); n=substr($0,1,p-1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", n); if (n==k) c++ }
    END { print c+0 }
  ' "$ENV_FILE")"
  [ "$count" -le 1 ] || fail "duplicate key $key in env file"
  [ "$count" -eq 1 ] || return 1
  value="$(awk -v k="$key" '
    /^[[:space:]]*#/ { next }
    index($0, "=") == 0 { next }
    { p=index($0,"="); n=substr($0,1,p-1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", n); if (n==k) { print substr($0,p+1); exit } }
  ' "$ENV_FILE")"
  printf '%s' "$value" | tr -d '\r'
}

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

[ "$(uname -s)" = Linux ] || fail "Linux is required"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail "env file must be a regular non-symlink file"
[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail "compose file must be a regular non-symlink file"

mode="$(stat -c '%a' "$ENV_FILE")"
[ "$mode" = 600 ] || fail "env file permissions must be 600 (found $mode)"
owner="$(stat -c '%u' "$ENV_FILE")"
[ "$owner" = "$(id -u)" ] || fail "env file must be owned by the deployment user"

admin_token="$(read_env APPFORGE_ADMIN_TOKEN || true)"
[ "${#admin_token}" -ge 32 ] && [ "${#admin_token}" -le 512 ] || fail "APPFORGE_ADMIN_TOKEN must be 32-512 characters"
case "$admin_token" in *$'\n'*|*$'\r'*) fail "APPFORGE_ADMIN_TOKEN contains a line break" ;; esac

stub="$(read_env APPFORGE_LLM_STUB || true)"
[ "$stub" != 1 ] || fail "APPFORGE_LLM_STUB is forbidden in production"
groq="$(read_env GROQ_API_KEY || true)"
openrouter="$(read_env OPENROUTER_API_KEY || true)"
[ "${#groq}" -ge 20 ] || [ "${#openrouter}" -ge 20 ] || fail "one LLM API key of at least 20 characters is required"

cors="$(read_env CORS_ORIGIN || true)"
[[ "$cors" =~ ^https?://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*)(:[0-9]{1,5})?$ ]] \
  || fail "CORS_ORIGIN must be one explicit http(s) origin without a path"

site="$(read_env APPFORGE_SITE_ADDRESS || true)"
[ "$site" = :80 ] || [[ "$site" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9]$ ]] || fail "invalid APPFORGE_SITE_ADDRESS"

command -v docker >/dev/null 2>&1 || fail "docker CLI is not installed"
if docker info >/dev/null 2>&1; then
  DOCKER_PREFIX=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  DOCKER_PREFIX=(sudo -n docker)
else
  fail "Docker daemon is unavailable (directly and through passwordless sudo)"
fi

server_version="$("${DOCKER_PREFIX[@]}" version --format '{{.Server.Version}}')"
version_ge "$server_version" 24.0.0 || fail "Docker server >=24.0.0 required (found $server_version)"
"${DOCKER_PREFIX[@]}" compose version >/dev/null 2>&1 || fail "Docker Compose plugin is required"
[ -S /var/run/docker.sock ] || fail "/var/run/docker.sock is not a Unix socket"

socket_gid="$(stat -c '%g' /var/run/docker.sock)"
configured_gid="$(read_env DOCKER_GID || true)"
[ "$configured_gid" = "$socket_gid" ] || fail "DOCKER_GID does not match the Docker socket group"

available_kb="$(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}')"
[ "${available_kb:-0}" -ge 5242880 ] || fail "at least 5 GiB free disk is required"

"${DOCKER_PREFIX[@]}" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet

unset admin_token groq openrouter
ok "Linux, secrets file, Docker $server_version, Compose, socket, disk and compose model"
