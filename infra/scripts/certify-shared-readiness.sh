#!/usr/bin/env bash
# Readiness gate for the educational single-user deployment on a shared host.
# It verifies isolation without requiring unrelated containers to be stopped.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.shared.yml"
EVIDENCE_DIR="$ROOT_DIR/.appforge-evidence"

fail() { echo "shared-readiness: FAIL: $*" >&2; exit 1; }
step() { echo "shared-readiness: $*"; }

[ "$(uname -s)" = Linux ] || fail "Linux is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

step "running the common production preflight"
bash "$ROOT_DIR/infra/scripts/preflight.sh" --env "$ENV_FILE" --compose "$COMPOSE_FILE" >/dev/null
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  fail "Docker daemon is unavailable"
fi

container=appforge-edu-studio
[ "$("${DOCKER[@]}" inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)" = healthy ] \
  || fail "$container is not healthy"

# The trusted Studio is the only AppForge component allowed to mount the
# socket. Foreign workloads may exist, but none may join AppForge networks or
# mount AppForge volumes.
socket_mounts="$("${DOCKER[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}{{println .Source}}{{end}}{{end}}' "$container")"
[ "$socket_mounts" = /var/run/docker.sock ] || fail "Studio Docker socket mount is missing or ambiguous"

port_binding="$("${DOCKER[@]}" inspect --format '{{with index .NetworkSettings.Ports "3001/tcp"}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}' "$container")"
case "$port_binding" in 127.0.0.1:[0-9]*) ;; *) fail "Studio must be published on IPv4 loopback only" ;; esac

for network in appforge-edu-control appforge-edu-apps; do
  [ "$("${DOCKER[@]}" network inspect -f '{{index .Labels "com.appforge.managed"}}' "$network" 2>/dev/null || true)" = true ] \
    || fail "$network is not AppForge-managed"
done
[ "$("${DOCKER[@]}" network inspect -f '{{.Internal}}' appforge-edu-control)" = false ] \
  || fail "appforge-edu-control must allow outbound LLM access"
[ "$("${DOCKER[@]}" network inspect -f '{{.Internal}}' appforge-edu-apps)" = true ] \
  || fail "appforge-edu-apps must be internal"

foreign_members="$("${DOCKER[@]}" network inspect -f '{{range $id,$c := .Containers}}{{println $c.Name}}{{end}}' appforge-edu-apps \
  | awk '$0 != "appforge-edu-studio" && $0 !~ /^appforge-app-/ { print }')"
[ -z "$foreign_members" ] || fail "foreign containers joined appforge-edu-apps"

[ "$("${DOCKER[@]}" volume inspect -f '{{index .Labels "com.appforge.managed"}}' appforge-edu-data 2>/dev/null || true)" = true ] \
  || fail "appforge-edu-data is not AppForge-managed"

admin_token="$(awk -F= '$1 == "APPFORGE_ADMIN_TOKEN" { print substr($0, index($0,"=")+1); exit }' "$ENV_FILE" | tr -d '\r')"
[ "${#admin_token}" -ge 32 ] || fail "administrative token is missing"
port="${port_binding##*:}"
driver_json="$(printf 'Authorization: Bearer %s\n' "$admin_token" \
  | curl --fail --silent --show-error -H @- "http://127.0.0.1:$port/api/deployment-driver")"
unset admin_token
printf '%s' "$driver_json" | grep -Eq '"configured"[[:space:]]*:[[:space:]]*true' \
  || fail "the real deployment driver is not configured"
printf '%s' "$driver_json" | grep -Eq '"name"[[:space:]]*:[[:space:]]*"docker"' \
  || fail "the configured driver is not Docker"

mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
commit="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
evidence="$EVIDENCE_DIR/shared-readiness-$timestamp.json"
printf '{"schema":1,"checkedAt":"%s","commit":"%s","mode":"shared-educational","checks":{"preflight":"pass","loopback":"pass","networkIsolation":"pass","volumeOwnership":"pass","studioHealth":"pass","driver":"pass"}}\n' \
  "$timestamp" "$commit" >"$evidence"
chmod 600 "$evidence"
step "PASS: sanitized evidence written to $evidence"
