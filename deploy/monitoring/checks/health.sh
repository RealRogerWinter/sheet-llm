#!/usr/bin/env bash
# Liveness: the app answers /api/health on loopback AND Caddy is up. (A true
# off-host external probe of https://sheetllm.com/api/health should also be run
# from an uptime service — see docs/guides/monitoring.md; the origin can't probe
# itself through Cloudflare because of the CF-IP firewall + hairpin.)
set -euo pipefail
CHECK_NAME=health
# shellcheck source=../lib/common.sh
. "$(cd "$(dirname "$0")" && pwd)/../lib/common.sh"

problems=()

code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_LOOPBACK_URL" 2>/dev/null || true)"
[ "$code" = "200" ] || problems+=("app health on ${HEALTH_LOOPBACK_URL} returned '${code:-no-response}' (expected 200)")

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet "$CADDY_SERVICE" || problems+=("caddy service ($CADDY_SERVICE) is not active")
fi

if [ "${#problems[@]}" -gt 0 ]; then
  alert "Health check failed: $(printf '%s; ' "${problems[@]}")"
  exit 1
fi
clear_alert
echo "health OK"
