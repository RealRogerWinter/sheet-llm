#!/bin/sh
# Container entrypoint for sheet-llm.
#
# Responsibilities, in order:
#   1. (as root) make the mounted /data volume writable by the unprivileged
#      'app' user, then drop privileges via gosu. A named Docker volume mounts
#      root-owned by default; without this, better-sqlite3 cannot create the WAL
#      sidecar files and the durability gate FATALs at boot.
#   2. (as app) on a COLD start only, restore the SQLite DB from the Litestream
#      replica. `litestream replicate -exec` does NOT auto-restore, so the
#      restore is explicit. `-if-replica-exists` makes the very first ever boot
#      (empty bucket) a no-op instead of an error.
#   3. (as app) run `node server.js` under continuous Litestream replication.
#      Litestream is the supervisor: when node exits it performs a final WAL
#      sync. tini (PID 1) forwards SIGTERM so shutdown is clean.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
DB_PATH="${DATABASE_FILE:-${DATA_DIR}/sheet-llm.db}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"

# Step 1 — privilege drop (runs only on the first, root, invocation).
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R app:app "$DATA_DIR"
  # Re-exec this same script as 'app'; everything below runs unprivileged.
  exec gosu app "$0" "$@"
fi

# Step 2 — cold-start restore (only when no local DB and a replica is set).
if [ ! -f "$DB_PATH" ] && [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  echo "[entrypoint] cold start: restoring ${DB_PATH} from Litestream replica…"
  litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$DB_PATH"
fi

# Step 3 — run the app under Litestream supervision.
echo "[entrypoint] starting app under Litestream supervision…"
exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "node server.js"
