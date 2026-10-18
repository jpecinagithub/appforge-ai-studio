#!/usr/bin/env bash
# Fail-closed readiness gate for the real 7C.3 Oracle certification.
# It writes only non-sensitive evidence and deliberately rejects shared hosts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
EVIDENCE_DIR="$ROOT_DIR/.appforge-evidence"

usage() { echo "usage: $0 [--env PATH] [--compose PATH] [--evidence-dir PATH]" >&2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) [ "$#" -ge 2 ] || { usage; exit 2; }; ENV_FILE="$2"; shift 2 ;;
    --compose) [ "$#" -ge 2 ] || { usage; exit 2; }; COMPOSE_FILE="$2"; shift 2 ;;
    --evidence-dir) [ "$#" -ge 2 ] || { usage; exit 2; }; EVIDENCE_DIR="$2"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

fail() { echo "7c-readiness: FAIL: $*" >&2; exit 1; }
step() { echo "7c-readiness: $*"; }

[ "$(uname -s)" = Linux ] || fail "Linux is required"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
[ -d "$ROOT_DIR/.git" ] || fail "repository checkout is required"
[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ] || fail "repository must be clean"

commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "HEAD is not a full commit"
ref="$(git -C "$ROOT_DIR" describe --tags --exact-match HEAD 2>/dev/null || true)"
[ -n "$ref" ] || fail "HEAD must have an exact release tag"

step "running the production preflight"
bash "$ROOT_DIR/infra/scripts/preflight.sh" --env "$ENV_FILE" --compose "$COMPOSE_FILE" >/dev/null

# Docker-socket access is host-equivalent, so Compose-level separation is not
# enough: §9.24 requires the whole VM to be dedicated to AppForge.
foreign="$(docker ps --format '{{.Names}}' | awk '
  $0 == "appforge-studio" || $0 == "appforge-caddy" || $0 ~ /^appforge-app-/ { next }
  { print }
')"
[ -z "$foreign" ] || fail "dedicated VM check failed: unrelated running containers exist"

[ "$(docker inspect --format '{{.State.Health.Status}}' appforge-studio 2>/dev/null || true)" = healthy ] \
  || fail "appforge-studio is not healthy"
[ "$(docker inspect --format '{{.State.Status}}' appforge-caddy 2>/dev/null || true)" = running ] \
  || fail "appforge-caddy is not running"

install_evidence="$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name 'install-*.json' -print 2>/dev/null | sort | tail -n1)"
[ -n "$install_evidence" ] || fail "sanitized installation evidence is missing"
grep -Fq "\"commit\":\"$commit\"" "$install_evidence" \
  || fail "installation evidence does not match HEAD"

admin_token="$(awk -F= '$1 == "APPFORGE_ADMIN_TOKEN" { print substr($0, index($0,"=")+1); exit }' "$ENV_FILE" | tr -d '\r')"
[ "${#admin_token}" -ge 32 ] || fail "administrative token is missing"
driver_json="$(curl --fail --silent --show-error \
  -H "Authorization: Bearer $admin_token" http://127.0.0.1/api/deployment-driver)"
unset admin_token
printf '%s' "$driver_json" | grep -Eq '"configured"[[:space:]]*:[[:space:]]*true' \
  || fail "the real deployment driver is not configured"
printf '%s' "$driver_json" | grep -Eq '"name"[[:space:]]*:[[:space:]]*"docker"' \
  || fail "the configured driver is not Docker"

mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
docker_version="$(docker version --format '{{.Server.Version}}')"
arch="$(uname -m)"
evidence="$EVIDENCE_DIR/readiness-$timestamp.json"
printf '{"schema":1,"checkedAt":"%s","commit":"%s","ref":"%s","host":{"arch":"%s"},"docker":{"version":"%s","driver":"docker"},"checks":{"preflight":"pass","dedicatedVm":"pass","studioHealth":"pass","edge":"pass","installEvidence":"pass"}}\n' \
  "$timestamp" "$commit" "$ref" "$arch" "$docker_version" >"$evidence"
chmod 600 "$evidence"
step "PASS: sanitized evidence written to $evidence"
