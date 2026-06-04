#!/usr/bin/env bash
# Disk-full guard: alert when any watched filesystem exceeds DISK_PCT_MAX. A full
# disk breaks SQLite writes (and thus the app) and Litestream's local WAL.
set -euo pipefail
CHECK_NAME=disk
# shellcheck source=../lib/common.sh
. "$(cd "$(dirname "$0")" && pwd)/../lib/common.sh"

problems=()
for path in $DISK_PATHS; do
  [ -e "$path" ] || continue
  pct="$(df -P "$path" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  [ -n "$pct" ] || continue
  if [ "$pct" -ge "$DISK_PCT_MAX" ]; then
    problems+=("$path at ${pct}% (>= ${DISK_PCT_MAX}%)")
  fi
done

if [ "${#problems[@]}" -gt 0 ]; then
  alert "Disk usage high: $(printf '%s; ' "${problems[@]}")"
  exit 1
fi
clear_alert
echo "disk OK"
