#!/usr/bin/env bash
# Run every check in checks/. Each check self-alerts (throttled); this runner
# just sequences them and exits non-zero if any failed, so `systemctl status
# sheetllm-monitor` and the journal also reflect failures.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
rc=0
for check in "$DIR"/checks/*.sh; do
  [ -f "$check" ] || continue
  if ! bash "$check"; then
    rc=1
  fi
done
exit "$rc"
