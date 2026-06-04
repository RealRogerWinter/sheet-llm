---
title: Persistence & Score Versioning — Context Card
subsystem: persistence-db
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/db/schema.ts
  - src/lib/db/index.ts
  - src/lib/db/durability.ts
  - src/lib/llm/conversations.ts
  - src/lib/orchestrator/scoreVersion.ts
  - src/app/api/sessions/[id]/versions/route.ts
  - src/app/api/sessions/[id]/versions/batch/route.ts
  - src/lib/chat/persistenceQueue.ts
  - src/app/api/chat/fork/route.ts
  - src/app/api/chat/revert/route.ts
  - src/app/api/chat/confirm-replacement/route.ts
  - src/lib/db/migrateScores.ts
  - src/lib/music/migrateScoreV1.ts
  - src/lib/db/janitor.ts
related:
  - orchestrator-dispatch
  - score-model
  - chat-api
  - auth-session
  - score-migration
---

SQLite (better-sqlite3 + Drizzle), single file. 8 tables; the spine is an
append-only chain of versioned Score-JSON checkpoints with an O(1)
`head_version_id` per session, CAS-guarded + idempotent writes.

## Files
- `src/lib/db/schema.ts` — 8 tables: core 5 (`users`, `sessions`, `messages`, `scoreVersions`, `orchestratorTurns`) + accounts trio `authSessions`/`oauthAccounts`/`authTokens` (PR-1; auth subsystem). `users` gained `email`/`emailVerified`/`passwordHash`/`tier`/`displayName`/`claimedAt`. Indexes, CHECKs, inferred types. Read first.
- `src/lib/db/index.ts` — lazy HMR-safe singleton; `getDb`, `setDbForTesting`, `ensureMigrationsApplied` (WeakSet-gated, wraps `migrate` in `migrateWithRetry`), `resolveDbPath` (`file:*` only). `openDb` sets WAL + `foreign_keys=ON` and runs the PR-11 durability gate (refuse `:memory:` + WAL-FATAL under replication).
- `src/lib/db/durability.ts` — PR-11 launch gate: `isReplicationConfigured` (`LITESTREAM_REPLICA_URL` / `SL_REQUIRE_WAL=1`), `assertJournalModeForReplication` (FATAL if not WAL under replication), `migrateWithRetry` (boot-only `SQLITE_BUSY` backoff).
- `src/lib/llm/conversations.ts` — repository core. `appendMessages`→`insertMessagesInTx`→`tryInsertScoreVersionForAssistant` writes msgs + version + bumps head in one tx. Also `appendStreamingAssistant`/`finalizeStreamingMessage`, `getConversation`, `deleteConversation`.
- `src/lib/orchestrator/scoreVersion.ts` — `scoreHash(score)`: key-sorted canonical SHA-256, 32 hex chars.
- `src/app/api/sessions/[id]/versions/route.ts` — single manual-edit write; 3-layer CAS + idempotency; 409 `stale_parent`.
- `src/app/api/sessions/[id]/versions/batch/route.ts` — batch write (queue + beacon); chains N in one tx. `MAX_VERSIONS_PER_BATCH=64`, `MAX_SCORE_JSON_BYTES=1MB`.
- `src/lib/chat/persistenceQueue.ts` — client FIFO; coalesces by `coalesceKey`, retries 5xx, rewrites base once on 409, `sendBeacon` on unload.
- `src/app/api/chat/{fork,revert,confirm-replacement}/route.ts` — fork (new session, `fork-seed`), revert (same session, `revert`), gate resolution.
- `src/lib/db/migrateScores.ts` + `src/lib/music/migrateScoreV1.ts` — lazy Score-JSON v0→v1 migration; `CURRENT_SCORE_SCHEMA_VERSION=1`; sidecar rollback.
- `src/lib/db/janitor.ts` — 4 reapers: `reapStalePartials` (partial→errored 600s), `reapOrphanSessions` (user-only >30min), + auth GC pair (PR-9) `reapExpiredAuthTokens` (dead `auth_tokens` >7d) / `reapExpiredAuthSessions` (dead `auth_sessions` >30d). Wrapped opportunistically by `maybeReap.ts` (`maybeReapStalePartials` + `maybeReapAuth`).

## Key types / exports
`Session`, `Message`, `ScoreVersion`, `OrchestratorTurn`, `AuthSession`, `OAuthAccount`, `AuthToken` (+`New*`) from schema.ts.
`appendMessages`, `getConversation`, `createConversation`, `finalizeStreamingMessage`. `scoreHash`. `getDb`/`ensureMigrationsApplied`.
`source ∈ {'llm','edit','import','fork-seed','revert'}` (SQL CHECK). Write endpoints accept only the first 4; `'revert'` is server-internal.

## Env flags
- `DATABASE_URL` = `file:./data/sheet-llm.db` (`file:*` only, else throws; `:memory:` skips WAL, but is REFUSED at boot under replication).
- `LITESTREAM_REPLICA_URL` / `SL_REQUIRE_WAL=1` (PR-11) → `isReplicationConfigured()`: non-WAL journal becomes a FATAL boot error + `:memory:` refused (Litestream can't replicate non-WAL).
- `ORCHESTRATOR_LOG_SILENT` unset → `1` skips stdout AND `orchestrator_turns` insert.
- `NEXT_RUNTIME` → migrations+boot-reap run only when `'nodejs'`.

## Gotchas
- `orchestrator_turns.created_at` is **ms**; every other table is **seconds**. Retention/queries on it must use ms.
- Orphan version branches (undone-then-replaced, rejected candidates) are intentional — never GC on "no children".
- Circular FK: insert message with `score_version_id=NULL` first, then version, then backfill. Order is load-bearing.
- CAS NULL: SQL `NULL=NULL` is false → single-write route uses `isNull(headVersionId)` when `parentVersionId===null`.
- `skipHeadVersionBump` inserts a candidate but leaves head — only `confirm-replacement` accept advances it.
- Durability gate (PR-11) is FATAL under replication: with `LITESTREAM_REPLICA_URL`/`SL_REQUIRE_WAL`, a non-WAL journal or `:memory:` REFUSES boot (without it, non-WAL is just a warning). Boot `migrate()` retries on `SQLITE_BUSY`.
- Owner resolver is `getRequestUser`/`getExistingRequestUser` (#271); legacy `getOrCreateUserId`/`getExistingUserId` are `@internal` + banned from routes by a guard test.
- Migrations forward-only table rebuilds (no down); Score-JSON rollback is data-level via `pre_migration_score_json` sidecar.

## When editing X, also update Y
- `schema.ts` → run `pnpm db:generate` then **hand-trim** the emitted `.sql` to ONLY your new statements (meta snapshots stop at `0002`, so generate over-produces `orchestrator_turns`/`0003`/`0005`); name it descriptively + hand-add the `_journal.json` entry (round `when`). Keep it additive. New account-scoped tables → also wire into `buildUserExport`/`hardDeleteUser` (redact `token_hash`/`password_hash`) + the GDPR delete receipt.
- New `source` value → CHECK in schema.ts (table-rebuild migration like `0002`) + route Zod `SOURCES` + `AppendOptions.scoreSource`.
- Bump `CURRENT_SCORE_SCHEMA_VERSION` → extend `migrateScoreToV1` (idempotent, populate `original` sidecar) + verify via `migrateAllPhase1`.
- New write path → reuse 3-layer CAS + idempotency; msg-before-version; head bump inside the tx.
- `checkSameOrigin`/`errorResponse`/`UuidSchema`/`synthToolUseId`/`forkSeedToolUseId` live in `@/app/api/chat/route` — changes ripple into fork/revert/confirm/versions.

## Related cards
orchestrator-dispatch · score-model · chat-api · auth-session · score-migration
