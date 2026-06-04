#!/usr/bin/env bash
# Litestream replication health: the container is up, a litestream process is
# supervising inside it, and there are no replication ERROR lines in the recent
# logs (R2 auth/network/bucket failures surface there). We check for *errors*
# rather than raw "lag" because Litestream only writes a WAL segment when the DB
# changes, so an idle period is not a fault.
set -euo pipefail
CHECK_NAME=litestream
# shellcheck source=../lib/common.sh
. "$(cd "$(dirname "$0")" && pwd)/../lib/common.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not present; skipping"; exit 0
fi

problems=()

# NB: capture-then-match (not `| grep -q`): with `set -o pipefail`, grep -q
# closing the pipe early makes the producer exit on SIGPIPE → false negative.
running="$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || true)"
if [ "$running" != "true" ]; then
  alert "Litestream check: container $APP_CONTAINER is not running"
  exit 1
fi

# A litestream process must be alive inside the container (it is the supervisor
# via `litestream replicate -exec`; if it died the container would too, but
# verify explicitly). Use `docker top` (host-side ps) since the slim runtime
# image has no ps/pgrep of its own.
top_out="$(docker top "$APP_CONTAINER" 2>/dev/null || true)"
case "$top_out" in
  *litestream*) ;;
  *) problems+=("no litestream process in $APP_CONTAINER") ;;
esac

# Recent replication errors?
errs="$(docker logs --since "$LITESTREAM_LOG_WINDOW" "$APP_CONTAINER" 2>&1 \
  | grep -iE 'level=ERROR|replica error|cannot (write|sync)|failed to (write|sync|upload)' \
  | grep -i 'litestream\|replica\|wal\|s3' | tail -3 || true)"
[ -z "$errs" ] || problems+=("litestream errors in last ${LITESTREAM_LOG_WINDOW}: ${errs}")

if [ "${#problems[@]}" -gt 0 ]; then
  alert "Litestream replication problem: $(printf '%s | ' "${problems[@]}")"
  exit 1
fi
clear_alert
echo "litestream OK"
