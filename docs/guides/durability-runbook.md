---
title: Durability & Restore Runbook (Litestream)
subsystem: ops
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-04
verified_against: 71117a3
source_paths:
  - src/lib/db/durability.ts
  - src/lib/db/index.ts
  - litestream.yml
---

# Durability & Restore Runbook

sheet-llm stores accounts in SQLite on the application volume. **Litestream**
streams the WAL to object storage so a volume wipe or host loss is recoverable.
This is the **hard launch gate**: it must be live before `SL_ACCOUNTS_ENABLED`
is flipped on.

## Launch-gate checklist (before flipping accounts on)

1. Object-storage bucket created; `LITESTREAM_REPLICA_URL` + credentials set.
2. `litestream.yml` `path` matches the app's `DATABASE_URL` file path.
3. Litestream runs as the container entrypoint, supervising the app:
   `litestream replicate -config /etc/litestream.yml -exec "node server.js"`.
4. The app is booted with **`SL_REQUIRE_WAL=1`** — a non-WAL journal then becomes
   a **fatal boot error** (`assertJournalModeForReplication`, `src/lib/db/durability.ts`),
   so the app refuses to start unreplicated rather than silently lose writes.
5. The data volume is **non-ephemeral and snapshotted** (Litestream is
   point-in-time recovery, not a substitute for a durable disk). WAL requires a
   **local, writable, non-network** filesystem — NFS/overlay breaks it.
6. A **restore drill** has been run on a throwaway instance (below) and verified.

## Why WAL is mandatory

Litestream replicates by tailing the WAL; a `journal_mode` of `delete`/`memory`
(e.g. WAL couldn't create its sidecar files on a read-only/network FS) means
**every write is unreplicated** and lost on a wipe. With replication configured,
the boot check promotes that from a warning to a fatal error.

## Migrations on deploy

- Preferred: run **`pnpm db:migrate`** (drizzle-kit) as a **pre-deploy
  stop-then-start step** so the new code boots already-migrated.
- The app's boot migrate (`ensureMigrationsApplied`) is then a no-op, and is
  wrapped in **retry-with-backoff** (`migrateWithRetry`): a transient writer lock
  from a sibling process on a deploy crossover retries with exponential backoff
  (100ms → 800ms, up to 5 attempts, capped at 2s) instead of crash-looping. A
  genuine migration error still throws immediately.

## Restore procedure

On a fresh instance with the same `LITESTREAM_REPLICA_URL` + credentials, BEFORE
starting the app:

```sh
# 1. Restore the latest replicated state to the DB path.
litestream restore -config /etc/litestream.yml /data/sheet-llm.db

# (or, by URL, without the config — export LITESTREAM_ACCESS_KEY_ID and
#  LITESTREAM_SECRET_ACCESS_KEY first, since there's no config to read them from:)
litestream restore -o /data/sheet-llm.db ${LITESTREAM_REPLICA_URL}

# 2. Start Litestream + app (replicate -exec). NOTE: `replicate -exec` does NOT
#    auto-restore a missing DB — step 1 is REQUIRED on a cold start, or the app
#    comes up empty and replicates that empty DB over the good backup. The
#    container entrypoint (deploy/docker-entrypoint.sh) runs step 1 automatically
#    with `-if-replica-exists` (a no-op on the first-ever boot, before any
#    replica exists). For PITR, add `-timestamp 2026-06-03T12:00:00Z` to step 1.
```

**Verify** after restore: the app boots, `GET /api/auth/session` returns
`{enabled:true}`, and a known account can log in (or check row counts against the
last-known good). Only then route traffic to it.

## RPO / RTO

- **RPO** ≈ `sync-interval` (1s) — at most ~1s of writes lost on an abrupt host
  loss.
- **RTO** ≈ download the latest snapshot + replay WAL since it (seconds–minutes,
  bounded by `snapshot-interval`).

## Secret rotation & breach response

See [auth-data-lifecycle.md](../subsystems/auth-data-lifecycle.md#breach-response--what-to-rotate)
for which secret to rotate on which compromise (the replica credentials are an
object-storage secret — rotate at the provider and update the env).
