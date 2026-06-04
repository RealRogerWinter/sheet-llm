#!/usr/bin/env bash
# cf-ufw-refresh staleness guard. The origin firewall allow-list of Cloudflare IP
# ranges is refreshed by the cf-ufw-refresh timer. Failure modes we catch:
#   - the timer/service unit is missing            → mechanism absent
#   - the timer is disabled or not active          → it will never run
#   - a KNOWN last run is older than CFUFW_MAX_AGE_DAYS
# If the last-run time can't be determined (e.g. the timer hasn't fired since
# setup), we do NOT alert on age as long as the timer is enabled + active — that
# is healthy, not stale.
set -euo pipefail
CHECK_NAME=cf-ufw
# shellcheck source=../lib/common.sh
. "$(cd "$(dirname "$0")" && pwd)/../lib/common.sh"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not present; skipping"; exit 0
fi

if [ -z "$(systemctl list-unit-files "${CFUFW_SERVICE}.timer" --no-legend 2>/dev/null)" ]; then
  alert "cf-ufw refresh timer ${CFUFW_SERVICE}.timer not found — origin CF-IP allow-list is not being maintained"
  exit 1
fi

problems=()
systemctl is-enabled --quiet "${CFUFW_SERVICE}.timer" 2>/dev/null || problems+=("${CFUFW_SERVICE}.timer is not enabled")
systemctl is-active  --quiet "${CFUFW_SERVICE}.timer" 2>/dev/null || problems+=("${CFUFW_SERVICE}.timer is not active")

# Most-recent run we can find, across the service's and timer's timestamps.
last=""
for prop_unit in "ExecMainExitTimestamp:${CFUFW_SERVICE}.service" \
                 "InactiveEnterTimestamp:${CFUFW_SERVICE}.service" \
                 "ActiveExitTimestamp:${CFUFW_SERVICE}.service"; do
  val="$(systemctl show "${prop_unit#*:}" -p "${prop_unit%%:*}" --value 2>/dev/null || true)"
  [ -n "$val" ] && { last="$val"; break; }
done

if [ -n "$last" ]; then
  last_epoch="$(date -d "$last" +%s 2>/dev/null || echo 0)"
  age_days=$(( ( $(date +%s) - last_epoch ) / 86400 ))
  if [ "$last_epoch" = 0 ] || [ "$age_days" -ge "$CFUFW_MAX_AGE_DAYS" ]; then
    problems+=("last successful run ${age_days}d ago (>= ${CFUFW_MAX_AGE_DAYS}d), at '${last}'")
  fi
else
  log "no recorded run yet; relying on the timer being enabled+active"
fi

if [ "${#problems[@]}" -gt 0 ]; then
  alert "cf-ufw refresh problem: $(printf '%s; ' "${problems[@]}")Check ${CFUFW_SERVICE}.timer."
  exit 1
fi
clear_alert
echo "cf-ufw OK"
