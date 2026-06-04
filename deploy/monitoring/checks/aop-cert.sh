#!/usr/bin/env bash
# Authenticated Origin Pulls cert-expiry guard. If the Cloudflare origin-pull CA
# that Caddy trusts (client_auth) expires, EVERY request from Cloudflare fails
# the mTLS handshake → 100% origin outage. Alert well ahead of AOP_MIN_DAYS so
# there is time to re-download and reload.
set -euo pipefail
CHECK_NAME=aop-cert
# shellcheck source=../lib/common.sh
. "$(cd "$(dirname "$0")" && pwd)/../lib/common.sh"

if [ ! -f "$AOP_CERT_PATH" ]; then
  echo "no AOP cert at $AOP_CERT_PATH; skipping"; exit 0
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not present; skipping"; exit 0
fi

end="$(openssl x509 -enddate -noout -in "$AOP_CERT_PATH" 2>/dev/null | cut -d= -f2)"
if [ -z "$end" ]; then
  alert "Could not read AOP cert expiry from $AOP_CERT_PATH"
  exit 1
fi
end_epoch="$(date -d "$end" +%s 2>/dev/null || echo 0)"
now_epoch="$(date +%s)"
days_left=$(( (end_epoch - now_epoch) / 86400 ))

if [ "$end_epoch" = 0 ] || [ "$days_left" -lt "$AOP_MIN_DAYS" ]; then
  alert "AOP origin-pull cert ($AOP_CERT_PATH) expires in ${days_left}d (< ${AOP_MIN_DAYS}d), on ${end}. Re-download from Cloudflare and reload Caddy."
  exit 1
fi
clear_alert
echo "aop-cert OK (${days_left}d left)"
