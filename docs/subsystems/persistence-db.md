---
title: Persistence, Schema & Score Versioning
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
  - src/lib/db/maybeReap.ts
  - src/lib/db/observabilityRetention.ts
  - src/instrumentation.ts
  - src/app/api/sessions/route.ts
  - src/app/api/sessions/[id]/route.ts
related:
  - orchestrator-dispatch
  - score-model
  - chat-api
  - auth-session
  - score-migration
---

The persistence layer is a single-file SQLite database (better-sqlite3 + Drizzle)
that stores every user, chat session, transcript message, and — its reason for
existence — an **append-only chain of versioned Score-JSON checkpoints**. Each
session keeps an O(1) `head_version_id` pointer to its current score; new
checkpoints insert a row whose `parent_version_id` chains back to the prior head,
then advance the pointer. Manual edits and LLM turns both write through the same
chain, guarded by CAS on the head pointer and idempotency keys so retries,
`sendBeacon` replays, and concurrent writers are all safe. Around that spine sit
lazy Score-schema migration with rollback sidecars, soft-delete reaping of stuck
streams and orphan sessions, and an additive forensic log (`orchestrator_turns`)
that references — never duplicates — the score JSON.

## Entry points

Read in this order to understand the subsystem:

1. `src/lib/db/schema.ts` — all 8 tables with inline rationale for every
   non-obvious column. This is the source of truth.
2. `src/lib/llm/conversations.ts` — the repository layer.
   `appendMessages` → `insertMessagesInTx` → `tryInsertScoreVersionForAssistant`
   is the head-pointer write core.
3. `src/app/api/sessions/[id]/versions/route.ts` — the CAS + idempotency model in
   its clearest single-write form.
4. `src/lib/orchestrator/scoreVersion.ts` — `scoreHash`, small and foundational.
5. `drizzle/0000_curious_hiroim.sql` (initial physical schema).

Tests boot through `tests/factories/db.ts:makeTestDb` — a fresh migrated
`:memory:` DB per test.

## Key files

| Path | Role |
| --- | --- |
| `src/lib/db/schema.ts` | The 8 `sqliteTable` definitions: the core 5 (`users`, `sessions`, `messages`, `scoreVersions`, `orchestratorTurns`) plus the accounts trio `authSessions`/`oauthAccounts`/`authTokens` (PR-1; owned by the auth subsystem — see `docs/subsystems/auth-gdpr.md`). `users` gained `email`/`emailVerified`/`passwordHash`/`tier`/`displayName`/`claimedAt`. Indexes, CHECK constraints, inferred TS types (`User`/`Session`/`Message`/`ScoreVersion`/`OrchestratorTurn`/`AuthSession`/`OAuthAccount`/`AuthToken` + `New*`). |
| `src/lib/db/index.ts` | HMR-safe lazy DB singleton. `resolveDbPath`, `openDb`, `getDb`, `setDbForTesting`, `ensureMigrationsApplied` (WeakSet-gated, once per `DbInstance`). `openDb` sets WAL + `foreign_keys=ON` and runs the **durability launch gate** (PR-11): refuses a `:memory:` DB under a replication config and calls `assertJournalModeForReplication` so a non-WAL journal is FATAL when Litestream replication is on. `ensureMigrationsApplied` wraps `migrate()` in `migrateWithRetry` to ride out a transient boot writer lock. |
| `src/lib/db/durability.ts` | Durability launch gate (PR-11). `isReplicationConfigured` (`LITESTREAM_REPLICA_URL` set OR `SL_REQUIRE_WAL=1`), `assertJournalModeForReplication` (FATAL if replication on but `journal_mode !== 'wal'`), `isDatabaseLocked`, `migrateWithRetry` (boot-only sync retry-with-backoff on `SQLITE_BUSY`). Litestream config lives in `litestream.yml`; ops in `docs/guides/durability-runbook.md`. |
| `src/lib/llm/conversations.ts` | Repository layer. `appendMessages`/`appendStreamingAssistant` write transcript rows AND mint `score_versions` + advance head in one transaction. Owns version-chain creation, auto-title, synthetic-id tagging, seq allocation, soft-delete, `finalizeStreamingMessage`. |
| `src/lib/orchestrator/scoreVersion.ts` | `scoreHash(score)`: canonical-JSON (recursively key-sorted) SHA-256 truncated to 32 hex chars. Used for `score_versions.score_hash` and the wire-level stale-edit freshness check. |
| `src/app/api/sessions/[id]/versions/route.ts` | Single-version write endpoint. 3-layer CAS, idempotency dedup, 409 `stale_parent`. The authoritative manual-edit persistence path. |
| `src/app/api/sessions/[id]/versions/batch/route.ts` | Batch version write (serves `persistenceQueue` + `sendBeacon`). Chains N versions in one transaction. `MAX_VERSIONS_PER_BATCH=64`, `MAX_SCORE_JSON_BYTES=1 MB`/version, `MAX_BODY_BYTES=16 MB`. |
| `src/lib/chat/persistenceQueue.ts` | Client-side FIFO queue. Coalesces by `coalesceKey`, batches, retries 5xx with backoff, rewrites base once on 409 `stale_parent`, flushes via `navigator.sendBeacon` on unload. |
| `src/app/api/chat/fork/route.ts` | Fork: new session seeded with a synthetic assistant `render_score` turn carrying a chosen historical score; records `forked_from_session_id`/`forked_from_version_id`; tags seed `source='fork-seed'`. |
| `src/app/api/chat/revert/route.ts` | In-place revert: appends a synthetic user+assistant pair to the SAME session, bumping head to a `source='revert'` row. Transcript preserved. |
| `src/app/api/chat/confirm-replacement/route.ts` | Resolves the replacement-gate modal. accept → advance head; reject → write `source='revert'` chained to prior head; `dont_ask_again_this_session` → accept + set `replacement_gate_suppressed=1`. |
| `src/lib/db/migrateScores.ts` | Lazy + batch Score-JSON migration. `migrateScoreVersionRow`, `migrateAllPhase1`, `rollbackScoreVersionToV0`, `trimMigrationSidecars`. |
| `src/lib/music/migrateScoreV1.ts` | `CURRENT_SCORE_SCHEMA_VERSION=1`, `migrateScoreToV1` (minimal: backfills ids), `rollbackScoreFromSidecar`, `scoreNeedsV1Migration`. |
| `src/lib/db/janitor.ts` | Four sync reapers: `reapStalePartials` (partial→errored after 600s), `reapOrphanSessions` (soft-delete user-only sessions >30min old), plus the auth GC pair (PR-9) `reapExpiredAuthTokens` (hard-delete consumed/expired `auth_tokens` past a 7-day window) and `reapExpiredAuthSessions` (hard-delete revoked/absolute-/idle-expired `auth_sessions` past 30 days). |
| `src/lib/db/maybeReap.ts` | Throttled (5-min) opportunistic wrappers that schedule reaping on a `queueMicrotask`: `maybeReapStalePartials` (stale partials + orphan sessions) and `maybeReapAuth` (the auth GC pair, called from auth routes so account tables get swept even on low-chat-traffic instances). `__resetForTesting` resets both throttles. |
| `src/lib/db/observabilityRetention.ts` | `trimOrchestratorTurns(maxAgeDays=90)` — delete-by-cutoff. **Uses ms math** (that table's `created_at` is ms). |
| `src/instrumentation.ts` | Next.js `register()` boot hook (nodejs runtime only): `ensureMigrationsApplied()` then `reapStalePartials()` once per process. |
| `src/app/api/sessions/route.ts` | GET list (most-recently-active, undeleted, with preview) + POST new empty session. |
| `src/app/api/sessions/[id]/route.ts` | PATCH rename / DELETE soft-delete. |
| `drizzle/` | 7 forward-only SQL migrations (`0000`..`0006`) + `meta/_journal.json`. |

## Core concepts & data flow

### Tables

```
users ──< sessions ──< messages
                  │         ▲
                  │         │ message_id (set null)
                  └──< score_versions ──┘   (circular FK with messages)
                          ▲  │
            head_version_id  └─ parent_version_id (self-FK, the chain)
sessions.forked_from_session_id ─┐ (self-FK)
sessions.forked_from_version_id ─┴─> score_versions
orchestrator_turns ──> sessions / messages / before+after score_versions (all additive refs)
users ──< auth_sessions / oauth_accounts / auth_tokens   (PR-1 accounts; all cascade)
```

All FKs from `sessions` into `score_versions` and the circular `messages ↔
score_versions` edge use `ON DELETE set null`; `sessions`→`users` and the
child→parent edges use `cascade`. `PRAGMA foreign_keys=ON` is set on every
connection (`src/lib/db/index.ts:openDb`).

### Accounts tables (PR-1)

`auth_sessions`, `oauth_accounts`, and `auth_tokens` back the email/password +
OAuth accounts feature; all FK `user_id → users.id` with `ON DELETE cascade`, and
`users` gained `email`/`email_verified`/`password_hash`/`tier`/`display_name`/
`claimed_at`. The lifecycle (revocable opaque `sl_sess` sessions, anon→account
claim, the recovery-vs-claim security gate) is owned by the **auth-gdpr**
subsystem — see `docs/subsystems/auth-gdpr.md`. Persistence-wise the load-bearing
facts are: (1) the cascade means GDPR erasure sweeps them, so they're wired into
`buildUserExport`/`hardDeleteUser` (with every `token_hash` and `password_hash`
**REDACTED** from the export); and (2) enum-ish columns (`tier`/`provider`/
`purpose`) carry **no CHECK** — validated in app so a new value never forces a
`0002`-style table rebuild.

### Head-pointer versioning

Each session has one `head_version_id` FK to `score_versions`; "what is the
current score?" is one O(1) lookup. A new checkpoint INSERTs a `score_versions`
row whose `parent_version_id` chains to the prior head, then UPDATEs
`sessions.head_version_id`. The reachable chain (head → parent → … → root) is the
linear history. **Orphan branches** — undone-then-replaced versions and rejected
replacement candidates — remain in the table but are unreachable from head **by
design** (see Invariants).

### Write path — LLM turn

`conversations.appendMessages` (and the streaming variant
`appendStreamingAssistant`) open a synchronous better-sqlite3 transaction:

```
insertMessagesInTx(tx, sessionId, msgs, startSeq, opts, ts)
  for each msg:
    INSERT messages (score_version_id = NULL)      # circular-FK target first
    tryInsertScoreVersionForAssistant(...)         # only assistant tool_use whose
      ScoreSchema.safeParse(block.input) succeeds   #   input parses as a Score
        → resolvedParent = passed parent OR session head (first iter)
        → INSERT score_versions (hash = scoreHash, source, parent chain)
    UPDATE messages.score_version_id = newId        # backfill the circular FK
  UPDATE sessions SET head_version_id = newHead, updated_at, last_message_at, [title]
```

`seq` is allocated as `MAX(seq)+1` inside the same transaction (so a parallel
writer can't claim the same seq — `messages_session_seq` UNIQUE would otherwise
500). Auto-title is taken from the first eligible non-synthetic user-text message
when `sessions.title` is still NULL.

`AppendOptions.skipHeadVersionBump` (replacement gate) inserts a real
`score_versions` candidate row but **does not** advance head — the candidate is an
intentional orphan until `/api/chat/confirm-replacement` accepts.

### Write path — manual edit (CAS + idempotency)

Client edits flow through `persistenceQueue.enqueue` → coalesce → flush to
`/api/sessions/[id]/versions` (single) or `…/versions/batch`. Each write carries
`parentVersionId`/`baseParentVersionId` (the client's belief of head) and an
`idempotencyKey`. The endpoint:

1. **Ownership + load head** (`session.userId === userId && deletedAt == null`).
2. **Idempotency dedup** — `idempotency_key` is UNIQUE; an already-seen key
   returns the existing row's id at 200 instead of erroring on the constraint.
3. **CAS layer 1 (JS pre-check)** — `parentVersionId !== headVersionId` → 409
   `{code:'stale_parent', currentHead}`.
4. **CAS layer 2 (in-transaction re-read)** — re-select head inside the tx;
   mismatch throws `StaleParentError` (defeats the read-then-write race between
   two writers that both passed step 3).
5. **CAS layer 3 (SQL conditional UPDATE)** — `UPDATE sessions … WHERE id=? AND
   head=parent`; `changes !== 1` throws. The single-write route uses
   `isNull(headVersionId)` when `parentVersionId === null` because SQL `NULL =
   NULL` is false (see Invariants).

The batch route builds the parent chain across N versions in one transaction; the
final head is whatever the last entry resolved to. Already-seen idempotency keys
inside the batch advance the chain pointer without re-inserting; if every entry is
already present the batch short-circuits at 200 (common on a re-sent unloaded
beacon).

### Read path

`getConversation` hydrates the ordered transcript (`ORDER BY seq`) as Anthropic
`ChatMessage`s, attaching `_meta` only for non-`complete` stream rows so the
happy-path shape is identical to the pre-stream-status world. `GET /api/sessions`
lists most-recently-active undeleted sessions with an 80-char preview from the
latest user message. The current score itself is read by following
`sessions.head_version_id → score_versions.score_json` (lazily migrated to v1 on
read by the consumer).

### Fork vs. revert vs. confirm-replacement

| Op | New session? | Mechanism | `source` |
| --- | --- | --- | --- |
| Fork | yes | `createConversation` records `forked_from_*`, then `appendMessages` seeds the historical score. Copies no version rows. | `fork-seed` |
| Revert | no | `appendMessages` adds a synthetic user+assistant pair to the SAME session, bumping head. | `revert` |
| Confirm accept | no | UPDATE head → candidate. | (candidate's existing) |
| Confirm reject | no | INSERT new row chained to prior head (re-asserts current score), bump head to it. Candidate left orphan. | `revert` |

Fork and revert both anchor a seed user+assistant pair: Anthropic's
Messages API enforces user→assistant alternation, so a bare `[assistant]` seed
would be rejected on the next refinement turn. The two seed-id minters
(`forkSeedToolUseId()` / `synthToolUseId()`, imported from `@/app/api/chat/route`)
use **distinct prefixes** and behave differently. `synthToolUseId()` (revert,
orchestrator turns) starts `toolu_orch_`; `conversations.ts` flags any
`toolu_orch_*` tool_use as `messages.is_synthetic=1`, and `prepareMessagesForLLM`
strips it before the next LLM call. `forkSeedToolUseId()` (fork seed) starts
`toolu_fork_` instead, is left `is_synthetic=0`, and is deliberately NOT stripped
— a fork seed is a real prior score the user is choosing to continue from, so it
must survive as a normal assistant turn that the next refinement can anchor
against.

### `source` enum

`source ∈ {'llm','edit','import','fork-seed','revert'}`, enforced by the SQL CHECK
`score_versions_source_valid`. `'revert'` was added in migration `0002` via a
table rebuild. A typo (`fork_seed`) is rejected at insert rather than silently
mis-counting analytics. Note the two write **endpoints** only accept
`['llm','edit','import','fork-seed']` in their Zod `SOURCES` — `'revert'` is
written only by the server-internal revert/confirm paths.

### Score schema version + sidecar migration

`score_versions.schema_version` defaults to `0` (pre-Phase-1) and is bumped to `1`
(`CURRENT_SCORE_SCHEMA_VERSION`) by migration. `migrateScoreToV1`
(`src/lib/music/migrateScoreV1.ts`) is deliberately **minimal** — it backfills
event/technique/annotation/marker/span/volta/jump/segno/coda ids; every other
Phase-1 field is optional so an un-migrated score still parses. Before mutating,
`migrateScoreVersionRow` copies the original JSON into
`pre_migration_score_json` so `rollbackScoreVersionToV0` can restore it. Sidecars
are trimmed after ~90 days by `trimMigrationSidecars`. This migration is at the
**Score-JSON** level and is orthogonal to drizzle's table-DDL migrations.

### Streaming message lifecycle

`appendStreamingAssistant` inserts an assistant row with
`stream_status='partial'` and empty body at SSE-open.
`finalizeStreamingMessage` flips it to `'complete'`|`'errored'` via a conditional
`UPDATE … WHERE stream_status='partial'`. Whoever flips it first wins the
reaper-vs-finalize race; the loser gets `{updated:false}` and only logs.

### Forensic log

`orchestrator_turns` (one row per `recordTurn`, written from
`src/lib/orchestrator/observability.ts`) captures classification, dispatch,
handler model, latency, token usage, before/after `score_version` FKs, and a small
diff payload (counts/booleans/`retained_event_ratio`). It is additive — it
references the score, never duplicates the JSON — and powers `npm run replay`.

## Invariants & gotchas

- **Timestamp unit split.** Every table stores Unix-epoch **seconds** EXCEPT
  `orchestrator_turns.created_at`, which is **milliseconds** (for sub-second turn
  ordering). `observabilityRetention.ts:trimOrchestratorTurns` and any query
  against that column MUST use ms math; mixing units silently mis-cuts retention.
- **Orphan branches are intentional, not leaks.** Undone-then-replaced versions
  and rejected replacement candidates stay in `score_versions`, unreachable from
  head. Do NOT garbage-collect them on a "no children" heuristic — fork/revert
  provenance and forensic replay may still reference them.
- **Circular FK ordering is load-bearing.** `messages.score_version_id ↔
  score_versions.message_id`. `insertMessagesInTx` inserts the message with
  `score_version_id=NULL` FIRST, then the version, then backfills. Reordering
  breaks the FK.
- **CAS NULL handling.** SQL `NULL = NULL` is false, so the single-write route's
  SQL-level head CAS uses `isNull(sessions.headVersionId)` when
  `parentVersionId === null` (new session, no head). A plain `eq()` would never
  match and would falsely report `stale_parent`.
- **`skipHeadVersionBump` leaves head unmoved.** The candidate `score_versions`
  row exists but reading head alone will NOT show it. It is resolved only by
  `/api/chat/confirm-replacement` (accept → advance head; reject → write a
  `revert` row at prior head).
- **Schema-drift guard is scoped to `drizzle/*.sql` only.**
  `drizzle/meta/_journal.json` carries a `when` timestamp and `_snapshot.json`
  gets whitespace-reformatted across drizzle-kit bumps; including them would
  produce false positives. Editing `schema.ts` without running `pnpm db:generate`
  leaves the schema and committed migrations out of sync.
- **Migrations are forward-only table rebuilds.** SQLite can't `ALTER` a CHECK, so
  `0002` adds `'revert'` to the source CHECK by `PRAGMA foreign_keys=OFF`,
  creating `__new_score_versions`, copying rows, dropping + renaming. There is no
  down-migration; Score-JSON rollback is data-level via the
  `pre_migration_score_json` sidecar, not via drizzle.
- **Reaper vs. finalize race.** `reapStalePartials` and `finalizeStreamingMessage`
  both guard on `WHERE stream_status='partial'`, so the first writer wins. A
  late-but-legit stream finish after the reaper marked it `errored` returns
  `{updated:false}`; the row STAYS `errored` — correct, since from any proxy's POV
  it timed out.
- **`reapOrphanSessions` predicate is the safety.** It only targets sessions with
  EXACTLY one user message and no assistant. A normal `[user, assistant]` turn is
  never reaped even if old. It soft-deletes (never hard-deletes) to protect fork
  back-refs.
- **`DATABASE_URL` must be `file:*`.** `resolveDbPath` throws on any other scheme
  and collapses the RFC 8089 `//` authority prefix to a single slash to avoid
  Windows UNC misinterpretation. WAL is skipped for `:memory:` to avoid a silent
  `journal_mode` downgrade.
- **Durability gate is FATAL, not a warning, under replication (PR-11).** When
  `LITESTREAM_REPLICA_URL` or `SL_REQUIRE_WAL=1` is set, `openDb` refuses a
  `:memory:` DB and `assertJournalModeForReplication` throws if WAL didn't stick
  (read-only / network FS) — booting unreplicated would mean every write is lost
  on a volume wipe. WITHOUT replication configured, a non-WAL journal stays a mere
  `console.warn`. `ensureMigrationsApplied` also retries `migrate()` on a transient
  `SQLITE_BUSY` (deploy crossover) via `migrateWithRetry` instead of crash-looping.
- **`ensureMigrationsApplied` is idempotent per-`DbInstance`** via a global
  `WeakSet`, so tests passing their own `:memory:` DB get migrated without
  poisoning the production singleton's flag.
- **Test-only escape hatches bypass user scoping.** `setDbForTesting`,
  `clearAllConversationsForTesting`, and the `__resetForTesting` functions ignore
  ownership entirely — production must never call them.
- **Shared util coupling.** Several routes import `checkSameOrigin`,
  `errorResponse`, `UuidSchema`, `synthToolUseId`, `forkSeedToolUseId` from
  `@/app/api/chat/route`. The chat route is the de-facto shared util module for the
  persistence endpoints; changes there ripple into fork/revert/confirm/versions.

## Env flags

| Flag | Default | Effect |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/sheet-llm.db` | SQLite file path; `file:*` only (other schemes throw). `:memory:` supported and skips WAL (but is REFUSED at boot when replication is configured). |
| `LITESTREAM_REPLICA_URL` | unset | When set, `isReplicationConfigured()` is true: `openDb` refuses `:memory:` and a non-WAL journal becomes a FATAL boot error (Litestream can't replicate non-WAL). Litestream itself reads it via `litestream.yml`. |
| `SL_REQUIRE_WAL` | unset | Hard launch-gate toggle. `=1` forces the same WAL-required behavior as `LITESTREAM_REPLICA_URL` even without a replica destination — set before flipping accounts on. |
| `ORCHESTRATOR_LOG_SILENT` | unset | When `1`, `logTurn`/`recordTurn` skip stdout AND the `orchestrator_turns` DB insert (test runs). |
| `NEXT_RUNTIME` | (set by Next.js) | `instrumentation.register()` runs migrations + boot reaping only when this `=== 'nodejs'` (skips edge runtime). |

## How to extend / common tasks

- **Add a column / table.** Edit `src/lib/db/schema.ts`, then run
  `pnpm db:generate` to emit `drizzle/NNNN_*.sql`, and commit the `.sql`.
  **Caveat (as of `0006`):** the `drizzle/meta` snapshots stop at `0002`, so
  `db:generate` re-emits *everything* since (`orchestrator_turns`, the `0003`/`0005`
  ALTERs, …) on top of your real change, and its `_journal` entry gets a real
  (non-round) `when`. Hand-trim the generated `.sql` to ONLY your new statements,
  give it a descriptive name (e.g. `0006_accounts.sql`), and fix the `_journal.json`
  entry by hand (descriptive `tag` + round-number `when`, matching `0003`–`0005`).
  Keep migrations strictly additive (`ADD COLUMN`/`CREATE TABLE`/`CREATE INDEX`);
  a CHECK change needs a full table rebuild (see `0002`). Forward-only — write a
  data-level rollback path if you mutate existing rows.
- **Add a `source` value.** Update the `text('source')` comment, the CHECK in
  `schema.ts`, the route-level Zod `SOURCES` (if clients may send it), and
  `AppendOptions.scoreSource`. CHECK changes require a table rebuild migration
  (see `0002`).
- **Bump the Score schema version.** Raise `CURRENT_SCORE_SCHEMA_VERSION` in
  `migrateScoreV1.ts`, extend `migrateScoreToV1` (keep it idempotent; populate
  `original` for the sidecar), and verify `migrateAllPhase1` counts on a copy of
  prod data before flipping any read path to require v1.
- **Add a new write path.** Reuse the 3-layer CAS + idempotency model from
  `versions/route.ts`. Always insert messages before the version (circular FK) and
  always update head inside the same transaction.
- **Add a retention/janitor sweep.** Follow `janitor.ts` (sync, index-driven,
  returns `{reaped}` — see the auth GC pair `reapExpiredAuthTokens`/
  `reapExpiredAuthSessions` as the most recent template) and wire it
  opportunistically via `maybeReap.ts` (a throttled+microtask `maybeReap*`
  wrapper, like `maybeReapAuth`) and/or run it on demand (e.g.
  `pnpm trim:orchestrator-turns`, 90-day TTL). Mind the seconds-vs-ms unit of the
  column you cut on.

## Testing

| Test | Covers |
| --- | --- |
| `tests/integration/db/schema.test.ts` | FK cascade, `UNIQUE(idempotency_key)`, `UNIQUE(session_id, seq)`, source CHECK, cross-session seq independence. |
| `tests/factories/db.ts:makeTestDb` | Fresh migrated `:memory:` DB per test. |
| `tests/integration/api-sessions-versions.test.ts` | Version write CAS / idempotency / batch chaining. |
| `tests/integration/api-sessions.test.ts`, `api-sessions-id.test.ts` | Listing, rename PATCH, soft-delete DELETE. |
| `tests/integration/api-chat-fork.test.ts` | Fork provenance + `fork-seed` source. |
| `tests/integration/api-chat-confirm-replacement.test.ts` | Gate accept/reject/dont-ask. |
| `tests/integration/api-chat-synth-id.test.ts` | Synthetic `toolu_orch_*` handling. |

## Related files / See also

- `src/lib/orchestrator/README.md` — orchestrator dispatch + the
  `orchestrator_turns` writer (`observability.ts:recordTurn`).
- `src/lib/music/types.ts` — `ScoreSchema`, the shape every `score_json` parses
  against.
- `src/lib/music/validateScore.ts` — semantic validation the write endpoints run
  after `ScoreSchema`.
- `src/lib/auth/session.ts` — `getRequestUser` / `getExistingRequestUser`, the
  per-request owner resolver used to scope every query (PR-2, #271 replaced the
  legacy `getOrCreateUserId`/`getExistingUserId`, now `@internal` + banned from
  routes by a guard test). `src/lib/auth/sessionStore.ts` backs the revocable
  `auth_sessions` rows.
- `src/lib/gdpr/exportUser.ts` — `buildUserExport` / `hardDeleteUser`: the GDPR
  Art. 15/17 paths the accounts tables wire into (every `token_hash` /
  `password_hash` REDACTED from the export; FK cascade sweeps the account rows on
  hard delete).
- `drizzle/0000_curious_hiroim.sql` … `0006_accounts.sql` — the physical
  schema history.
