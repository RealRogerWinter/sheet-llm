import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// All timestamps are Unix-epoch seconds (INTEGER) — portable, sortable,
// timezone-free. UUIDs come from crypto.randomUUID(); idempotency tokens
// are nanoid(32).

// ============================================================================
// users — anonymous-cookie-identified accounts.
// The cookie value itself is a signed JWT whose `sub` claim is `id` — there
// is intentionally no separate cookie_token column, because we'd never
// look it up (the JWT is self-contained).
// external_id reserves space for a future email / OAuth claim flow without
// requiring a migration once auth ships.
// ============================================================================
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    externalId: text('external_id').unique(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    // last_recovery_nonce holds the most recently CONSUMED recovery
    // nonce. Restore rejects any token whose nonce equals this value
    // (already used → single-use enforcement). On successful restore,
    // we mint a fresh recovery token with a new nonce and set this
    // column to the now-consumed value.
    lastRecoveryNonce: text('last_recovery_nonce'),
    // --- Accounts (PR-1). All nullable/defaulted so existing anonymous rows
    // stay valid; the migration is a pure ADD COLUMN (no table rebuild). ---
    // Login identity once an anonymous account is "claimed". Stored LOWERCASED
    // by every writer (signup/login/oauth/reset funnel through one helper) so
    // the plain unique index below enforces case-insensitive uniqueness without
    // an expression index. NULL for anonymous users; SQLite treats multiple
    // NULLs as distinct, so unclaimed rows never collide.
    email: text('email'),
    emailVerified: integer('email_verified').notNull().default(0),
    // Argon2id hash (PR-2). NULL for anonymous and OAuth-only accounts.
    passwordHash: text('password_hash'),
    // Product/paywall tier. Plain TEXT (no CHECK) so adding tiers later never
    // forces a SQLite table rebuild; validated in app. See generationTier.ts.
    tier: text('tier').notNull().default('free'),
    displayName: text('display_name'),
    // Set when an anonymous identity is upgraded to a real account (email or
    // OAuth). Once set, the anonymous recovery-token path is REFUSED — a leaked
    // 1-year recovery token (or a stale sl_uid) must not re-authenticate a
    // password-protected account. See api/auth/restore/route.ts + getRequestUser.
    claimedAt: integer('claimed_at'),
    // PR-7b-3: epoch-seconds the account consumed its ONE-TIME free full piece
    // (NULL = never used). A charge-SKIP grant, OFF the money path — never a
    // credit grant (which would open refund farming; red-team #7).
    freeFullPieceUsedAt: integer('free_full_piece_used_at'),
    // PR-13: per-claim OWNER token for the free-piece reservation, minted by
    // reserveFreePiece alongside used_at and matched by releaseFreePiece. Scopes
    // the un-claim to THIS request's reservation, so a late/duplicate release
    // (or a future 2nd release path) can never clear a different request's fresh
    // claim. NULL when the grant is unclaimed; lingers after a kept (delivered)
    // claim as an audit of which reservation consumed it.
    freeFullPieceClaimToken: text('free_full_piece_claim_token'),
  },
  (table) => [
    index('users_last_seen').on(table.lastSeenAt),
    // Case-insensitive by convention (values stored lowercased); NULLs distinct.
    uniqueIndex('users_email_unique').on(table.email),
  ],
)

// ============================================================================
// sessions — one row per "chatId" in today's API; what the sidebar lists.
// head_version_id makes "what's the current score?" an O(1) lookup.
// forked_from_* preserves provenance for the pointer-model fork.
// deleted_at is soft delete; fork descendants must outlive their parent.
// ============================================================================
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    headVersionId: text('head_version_id').references(
      (): AnySQLiteColumn => scoreVersions.id,
      { onDelete: 'set null' },
    ),
    forkedFromSessionId: text('forked_from_session_id').references(
      (): AnySQLiteColumn => sessions.id,
      { onDelete: 'set null' },
    ),
    forkedFromVersionId: text('forked_from_version_id').references(
      (): AnySQLiteColumn => scoreVersions.id,
      { onDelete: 'set null' },
    ),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastMessageAt: integer('last_message_at').notNull(),
    deletedAt: integer('deleted_at'),
    /**
     * M3.5-PR-4 — per-session opt-out of the replacement-confirmation
     * gate. Flipped to 1 when the user picks "Replace anyway and don't
     * ask again this session" in the confirmation modal. Reset on
     * new sessions (defaults to 0). Read by the orchestrator each
     * turn before invoking `detectReplacement`.
     */
    replacementGateSuppressed: integer('replacement_gate_suppressed')
      .notNull()
      .default(0),
  },
  (table) => [
    index('sessions_user_activity')
      .on(table.userId, table.lastMessageAt)
      .where(sql`deleted_at IS NULL`),
    index('sessions_user_forked').on(table.userId, table.forkedFromSessionId),
  ],
)

// ============================================================================
// messages — native Anthropic content blocks preserved verbatim in
// content_json. tool_use_id and score_version_id are denormalized so fork
// lookups and score back-refs are indexed point queries, not JSON scans.
// is_synthetic preserves the toolu_orch_* skip semantics from the legacy
// in-memory store (see prepareMessagesForLLM in api/chat/route.ts).
// ============================================================================
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(), // 'user' | 'assistant'
    contentJson: text('content_json').notNull(),
    toolUseId: text('tool_use_id'),
    scoreVersionId: text('score_version_id').references(
      (): AnySQLiteColumn => scoreVersions.id,
      { onDelete: 'set null' },
    ),
    isSynthetic: integer('is_synthetic').notNull().default(0),
    streamStatus: text('stream_status').notNull().default('complete'), // 'complete' | 'partial' | 'errored'
    errorCode: text('error_code'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('messages_session_seq').on(table.sessionId, table.seq),
    index('messages_tool_use')
      .on(table.sessionId, table.toolUseId)
      .where(sql`tool_use_id IS NOT NULL`),
    index('messages_streaming')
      .on(table.streamStatus, table.createdAt)
      .where(sql`stream_status = 'partial'`),
  ],
)

// ============================================================================
// score_versions — every LLM checkpoint AND every coalesced user edit.
// parent_version_id represents the linear path from head back to root;
// orphan branches (undone-then-replaced) remain in DB but are unreachable
// from head — by design, see plan §"Score version chain & restore semantics".
// idempotency_key makes retries safe via INSERT … ON CONFLICT DO NOTHING.
// ============================================================================
export const scoreVersions = sqliteTable(
  'score_versions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references((): AnySQLiteColumn => sessions.id, { onDelete: 'cascade' }),
    parentVersionId: text('parent_version_id').references(
      (): AnySQLiteColumn => scoreVersions.id,
      { onDelete: 'set null' },
    ),
    scoreJson: text('score_json').notNull(),
    scoreHash: text('score_hash').notNull(),
    source: text('source').notNull(), // 'llm' | 'edit' | 'import' | 'fork-seed' | 'revert'
    messageId: text('message_id').references(
      (): AnySQLiteColumn => messages.id,
      { onDelete: 'set null' },
    ),
    coalesceKey: text('coalesce_key'),
    idempotencyKey: text('idempotency_key').unique(),
    createdAt: integer('created_at').notNull(),
    /**
     * Score-JSON schema version. 0 = pre-Phase-1 (legacy schema with
     * no required event ids, step:'rest' rest hack, etc.). 1 =
     * post-PR-12 (ensureEventIds() applied, ready for spans).
     * Migration is lazy on first read; backfill helpers in
     * lib/db/migrateScores.ts can pre-migrate all rows in one pass.
     */
    schemaVersion: integer('schema_version').notNull().default(0),
    /**
     * Sidecar copy of score_json BEFORE the Phase 1 migration was
     * applied. Populated only when migration runs against a v0 row.
     * Used by rollbackScoreVersionToV0 if a defect in the migration
     * corrupts data — preserved verbatim for ~90 days (retention
     * enforced by lib/db/migrateScores.ts trimMigrationSidecars).
     */
    preMigrationScoreJson: text('pre_migration_score_json'),
  },
  (table) => [
    index('sv_session_created').on(table.sessionId, table.createdAt),
    index('sv_session_hash').on(table.sessionId, table.scoreHash),
    // Without this CHECK, a typo at insert (`fork_seed` vs `fork-seed`) becomes
    // silent data corruption: downstream filters miss rows and analytics undercount.
    check(
      'score_versions_source_valid',
      sql`source IN ('llm', 'edit', 'import', 'fork-seed', 'revert')`,
    ),
  ],
)

// ============================================================================
// orchestrator_turns — persistent forensic log of every orchestrator turn.
// One row per `logTurn`/`recordTurn` invocation. Captures classification,
// dispatch decision, handler model, latency, token usage, and a small
// score-diff payload (counts + booleans + measure-identity retention ratio).
// FKs to sessions / messages / score_versions keep this table additive —
// no JSON duplication of the score itself, just references.
//
// Why: when a production bug like the triplet-demo replacement happens
// ("add 4 more bars" → wholesale new score), stdout-only logs are lost.
// This table makes any session replayable via `npm run replay`.
// ============================================================================
export const orchestratorTurns = sqliteTable(
  'orchestrator_turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // NULL when the turn was logged BEFORE the assistant message was
    // persisted (e.g. fall-through / refuse paths).
    messageId: text('message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
    }),
    requestId: text('request_id').notNull(),
    /**
     * Unix epoch MILLISECONDS (ms-resolution; differs from other tables
     * which use seconds — needed for sub-second turn ordering when
     * multiple orchestrator turns land inside the same wall-second).
     */
    createdAt: integer('created_at').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    finalStatus: text('final_status').notNull(), // 'ok' | 'refused' | 'fell_through' | 'error'
    classificationKind: text('classification_kind'), // TaskKind | 'unknown'
    classificationConfidence: real('classification_confidence'),
    handler: text('handler'),
    handlerModel: text('handler_model'),
    composePatchDispatch: text('compose_patch_dispatch'), // 'patch' | 'regen' | 'skipped'
    beforeScoreVersionId: text('before_score_version_id').references(
      (): AnySQLiteColumn => scoreVersions.id,
      { onDelete: 'set null' },
    ),
    afterScoreVersionId: text('after_score_version_id').references(
      (): AnySQLiteColumn => scoreVersions.id,
      { onDelete: 'set null' },
    ),
    diffAlgoVersion: integer('diff_algo_version').notNull().default(1),
    measureCountBefore: integer('measure_count_before'),
    measureCountAfter: integer('measure_count_after'),
    /**
     * Sum of voice counts across every staff (staff 0 + staff 1 + ...).
     * Single value, NOT per-staff — a grand-staff score with 2 voices
     * per staff stores `4` here, indistinguishable from a single-staff
     * score with 4 voices. PR-7 (review M1) considered adding
     * per-staff columns; deferred — the conflation is acceptable for
     * the forensic-replay use case (operators read both rows alongside
     * `score_versions` to see the actual layout), and the column count
     * would creep monotonically as more layouts get added.
     */
    voiceCountBefore: integer('voice_count_before'),
    voiceCountAfter: integer('voice_count_after'),
    // Nullable on purpose: when only one side of the diff is present
    // (e.g. fresh generation with no prior score), the "did this metadata
    // change?" question is meaningless. Writing 0 there would falsely
    // imply the field was unchanged. NULL = "no comparison was possible".
    keyChanged: integer('key_changed'),
    meterChanged: integer('meter_changed'),
    titleChanged: integer('title_changed'),
    retainedEventRatio: real('retained_event_ratio'),
    appliedOpsCount: integer('applied_ops_count'),
    inputTokens: integer('input_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    outputTokens: integer('output_tokens'),
    // Cache-WRITE (cache_creation) input tokens, billed at 1.25x. Captured at
    // the provider since PR-2; persisted here for the first time.
    cacheCreationInputTokens: integer('cache_creation_input_tokens'),
    // Raw Anthropic API cost for the WHOLE turn, in micro-USD (1e-6 USD),
    // summed across every provider call (dispatcher + handler + retries) via
    // the request-scoped usage meter. This is our COST, not the customer
    // charge (billing marks it up). NULL when no priced call ran this turn.
    costMicroUsd: integer('cost_micro_usd'),
    error: text('error'),
    /**
     * M3.5-PR-4 — telemetry flag. Set to 1 when the
     * replacement-as-confirmation gate fired on this turn
     * (`detectReplacement` returned isReplacement=true and the route
     * surfaced a confirmation modal to the user). Lets us measure
     * gate noise vs. real-replacement frequency in production.
     */
    replacementBlocked: integer('replacement_blocked').notNull().default(0),
  },
  (table) => [
    index('orchestrator_turns_session_created').on(table.sessionId, table.createdAt),
    index('orchestrator_turns_status').on(table.finalStatus, table.createdAt),
    // The credit paywall (PR-7b) settles a non-streaming turn off its cost by
    // request_id; request_id is NOT unique (a streaming turn + its backfill
    // share one), so this is a plain index, not a uniqueIndex.
    index('orchestrator_turns_request').on(table.requestId),
    check(
      'orchestrator_turns_status_valid',
      sql`final_status IN ('ok', 'refused', 'fell_through', 'error')`,
    ),
  ],
)

// ============================================================================
// auth_sessions — server-side, REVOCABLE login sessions (PR-2 mints these).
// Distinct from the `sessions` table above, which is MUSIC chat sessions. The
// cookie carries an opaque 32-byte random token; only its SHA-256 hash is
// stored here, so a DB read cannot replay a session. logout/logout-all/reset
// set revoked_at (the row is kept for audit; the janitor GCs it later).
// ============================================================================
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    // Absolute expiry — the session dies at this wall-clock second no matter
    // how active it is. idle_expires_at slides forward on use (throttled).
    expiresAt: integer('expires_at').notNull(),
    idleExpiresAt: integer('idle_expires_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    userAgent: text('user_agent'),
    // Truncated to /24 (IPv4) or /64 (IPv6) by the writer; dropped on revoke.
    ip: text('ip'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    index('auth_sessions_user').on(table.userId),
    index('auth_sessions_expires').on(table.expiresAt),
  ],
)

// ============================================================================
// oauth_accounts — links a user to an external OAuth identity (PR-6). A user
// may have several (one per provider). provider is validated in app (no CHECK,
// so adding a provider never forces a SQLite table rebuild).
// ============================================================================
export const oauthAccounts = sqliteTable(
  'oauth_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'google' | 'github' (validated in app)
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('oauth_provider_account').on(
      table.provider,
      table.providerAccountId,
    ),
    index('oauth_accounts_user').on(table.userId),
  ],
)

// ============================================================================
// auth_tokens — single-use, hashed, short-TTL tokens for email verification
// and password reset (PR-5). Only SHA-256(token) is stored; the raw token is
// emailed. consumed_at enforces single-use via an atomic CAS update. purpose
// is validated in app (no CHECK → no rebuild when purposes are added).
// ============================================================================
export const authTokens = sqliteTable(
  'auth_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(), // 'email_verify' | 'password_reset'
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('auth_tokens_user').on(table.userId)],
)

// ============================================================================
// request_quota — durable per-identity DAILY request counter for the hosted
// abuse-gating layer (HOSTED sheetllm.com ONLY; OFF by default — see
// dailyQuota.ts / SL_DAILY_QUOTA_ENABLED). One row per quota key:
//   'u:<userId>'  verified logged-in free tier (keyed on the account)
//   'a:<hash>'    anonymous (keyed on the pseudonymized, normalized client IP)
//   'd:<userId>'  per-anon-DEVICE bucket keyed on the stable signed sl_uid, so a
//                 mobile wifi<->cellular IP switch can't mint a fresh anon allowance
//                 (additive to 'a:'; user_id stays NULL like 'a:' — see dailyQuota.ts)
//   '*'           optional instance-wide anonymous ceiling
// Unlike the in-memory burst limiter (requestRateLimit.ts), this MUST be durable:
// the single container is redeployed frequently and an in-memory counter resets
// on every deploy, refilling everyone's 24h budget. 'a:' rows are short-lived IP
// PII and are reaped (janitor.ts#reapExpiredQuotaCounters); 'u:' rows carry
// user_id so account deletion FK-cascades them (GDPR). The whole feature is inert
// unless SL_DAILY_QUOTA_ENABLED is set, so self-hosted/local installs never write
// a row.
// ============================================================================
export const requestQuota = sqliteTable(
  'request_quota',
  {
    // Class-prefixed identity key. The prefix prevents an 'a:'/'u:' collision if
    // an IP string ever equals a userId. 'a:' values are HMAC-pseudonymized.
    quotaKey: text('quota_key').primaryKey(),
    // Set ONLY for 'u:' rows so GDPR erasure is automatic via the users FK
    // cascade (foreign_keys=ON). NULL for anonymous ('a:'), per-device ('d:'),
    // and instance ('*') rows, which carry no subject and rely on short retention.
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Epoch seconds of the first counted hit in the current window. Reset to now
    // when now >= window_start + WINDOW_SEC (fixed window anchored at first hit).
    windowStart: integer('window_start').notNull(),
    // Hits counted in the current window; incremented via a guard-in-the-write
    // UPDATE ... WHERE count < limit so the stored value can never exceed limit.
    count: integer('count').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    // Bounds the retention reaper scan (DELETE WHERE window_start < cutoff).
    index('request_quota_window').on(table.windowStart),
  ],
)

// ============================================================================
// PREPAID CREDITS (HOSTED sheetllm.com ONLY; the whole paid layer is OFF by
// default behind SL_* flags — self-hosted / BYOK installs never write a row).
//
// Money is NEVER a float. The customer-facing unit is an integer CREDIT
// (1 credit = 1 cent of customer value); our raw Anthropic cost is tracked
// separately in micro-USD. Three append-only ledgers — credit_purchases
// (money in), usage_ledger (money out), credit_holds (in-flight reservations)
// — plus one mutable cache (credit_wallets.balance) reconcilable from them.
// All FK users.id ON DELETE cascade so GDPR erasure is automatic.
// ============================================================================

// credit_wallets — the single MUTABLE money row: spendable balance per user.
// `available = balance - held`. Debited via guard-in-the-write
// (UPDATE ... WHERE balance - held >= :n) so an overdraft is structurally
// impossible. Reconcilable from SUM(credit_purchases) - SUM(usage_ledger).
export const creditWallets = sqliteTable(
  'credit_wallets',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Spendable balance, integer CREDITS (1 credit = 1 cent of value).
    balance: integer('balance').notNull().default(0),
    // Sum of currently-active holds (reserved, not yet settled).
    held: integer('held').notNull().default(0),
    // Bumped on every write — optimistic-concurrency guard / drift audit.
    version: integer('version').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  () => [
    // Overdraft AND a hold exceeding the balance are both impossible at the
    // storage layer — available = balance - held can never go negative. The
    // settle path updates balance + held in ONE atomic UPDATE so it never
    // transiently violates this.
    check('credit_wallets_solvent', sql`balance >= 0 AND held >= 0 AND held <= balance`),
  ],
)

// credit_purchases — IMMUTABLE, append-only: every credit grant (Stripe
// payment, promo, refund as a NEGATIVE row, manual adjustment). external_ref is
// the Stripe event / PaymentIntent id, UNIQUE so a replayed webhook can't
// double-credit (INSERT ... ON CONFLICT DO NOTHING).
export const creditPurchases = sqliteTable(
  'credit_purchases',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // 'stripe' | 'promo' | 'refund' | 'manual' (app-validated)
    externalRef: text('external_ref').unique(), // Stripe event/PI id → webhook idempotency
    creditsDelta: integer('credits_delta').notNull(), // +grant / -refund
    amountMinorUsd: integer('amount_minor_usd'), // money paid, cents; NULL for non-cash grants
    currency: text('currency'), // 'usd'
    status: text('status').notNull().default('settled'), // 'settled' | 'pending' | 'reversed'
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('credit_purchases_user_created').on(table.userId, table.createdAt)],
)

// usage_ledger — IMMUTABLE, append-only: one row per BILLED (settled) action.
// The FINANCIAL record: carries BOTH our raw cost (cost_micro_usd) and the
// customer charge (credits_charged), plus the post-debit balance for drift
// detection. idempotency_key (UNIQUE) makes a retried settle a no-op.
export const usageLedger = sqliteTable(
  'usage_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    requestId: text('request_id').notNull(),
    // The hold this debit settled (NULL for a direct debit with no prior hold).
    // Durable link for reconciliation/replay — request_id alone is non-unique
    // (sectional generation places one hold + one ledger row per section).
    holdId: text('hold_id').references((): AnySQLiteColumn => creditHolds.id, {
      onDelete: 'set null',
    }),
    idempotencyKey: text('idempotency_key').notNull().unique(), // retried request must not double-debit
    kind: text('kind').notNull(), // 'chat_generate' | 'chat_edit' | 'refund' (app-validated)
    // Typed reason for a NON-standard row. On a refund row (kind='refund',
    // credits_charged NEGATIVE) it is the failure class we refunded for —
    // 'error' | 'refused' | 'cost_split' — so ops can audit WHY credits were
    // returned without parsing kind. NULL on a normal charge.
    reason: text('reason'),
    model: text('model'),
    generationTier: text('generation_tier'), // 'free' | 'pro' at time of call
    inputTokens: integer('input_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    cacheCreationInputTokens: integer('cache_creation_input_tokens'),
    outputTokens: integer('output_tokens'),
    costMicroUsd: integer('cost_micro_usd'), // our RAW Anthropic cost
    creditsCharged: integer('credits_charged').notNull(), // the CUSTOMER charge (markup applied)
    balanceAfter: integer('balance_after'), // wallet balance after this debit (drift check)
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('usage_ledger_user_created').on(table.userId, table.createdAt),
    index('usage_ledger_request').on(table.requestId),
  ],
)

// credit_holds — durable pre-authorization holds. We debit BEFORE an Anthropic
// call by placing a hold (true cost is only known once the stream finishes),
// then SETTLE to the actual cost or RELEASE on failure. Durable so a crash
// between hold and settle is recoverable: a janitor releases 'active' holds
// past expires_at (those credits were never really spent).
export const creditHolds = sqliteTable(
  'credit_holds',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    // Idempotency for hold PLACEMENT — a retried request (or a sectional
    // section) re-finds its hold instead of stacking duplicates. UNIQUE.
    idempotencyKey: text('idempotency_key').notNull().unique(),
    credits: integer('credits').notNull(), // reserved credits (conservative worst-case at hold time)
    status: text('status').notNull().default('active'), // 'active' | 'settled' | 'released'
    expiresAt: integer('expires_at').notNull(), // crash-recovery janitor releases 'active' holds past this
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
  },
  (table) => [
    index('credit_holds_user').on(table.userId),
    index('credit_holds_expires').on(table.expiresAt), // bounds the reaper scan
  ],
)

// refund_counters — per-user-per-DAY abuse ceiling for SERVICE refunds (we
// failed → credits back, recorded as a NEGATIVE usage_ledger row). A failure
// the user can trigger on demand is a credit-printing press without a cap, so
// refund() increments this with a guard-in-the-write (UPDATE ... WHERE
// count+1 <= MAX AND credits+:n <= MAX) and refuses past either ceiling. `day`
// is the epoch DAY (floor(epochSec / 86400)); old rows are disposable.
export const refundCounters = sqliteTable(
  'refund_counters',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(), // epoch day = floor(unixSec / 86400)
    refundCount: integer('refund_count').notNull().default(0),
    refundCredits: integer('refund_credits').notNull().default(0), // sum refunded that day
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day] }),
    check('refund_counters_nonneg', sql`refund_count >= 0 AND refund_credits >= 0`),
  ],
)

// stripe_events — raw Stripe webhook INBOX (red-team #5). EVERY signature-verified
// event is persisted (event_id PK = delivery idempotency) BEFORE processing, so a
// crash mid-grant leaves a replayable row and a redelivery is a no-op. `status`
// tracks the processing outcome and the reconciliation reaper re-runs un-processed
// rows. The credit GRANT itself is separately idempotent (credit_purchases.
// external_ref = the Stripe checkout-session id), so double-processing an event
// can't double-credit. `user_id` is plain TEXT (NO FK): a financial record we
// retain for accounting/tax even after the subject is erased — see PR-14 GDPR +
// the launch attorney memo for the retention basis.
export const stripeEvents = sqliteTable(
  'stripe_events',
  {
    eventId: text('event_id').primaryKey(), // Stripe event.id — delivery idempotency
    type: text('type').notNull(), // event.type
    status: text('status').notNull().default('received'), // received | processed | ignored | failed
    payload: text('payload').notNull(), // raw event JSON (audit / replay)
    userId: text('user_id'), // resolved subject; no FK (retained financial record)
    creditsGranted: integer('credits_granted'), // credits granted by this event, if any
    reason: text('reason'), // ignored/failed reason or last error
    receivedAt: integer('received_at').notNull(),
    processedAt: integer('processed_at'),
  },
  (table) => [
    index('stripe_events_status').on(table.status), // bounds the reconciliation reaper
    index('stripe_events_received').on(table.receivedAt),
  ],
)

export type CreditWallet = typeof creditWallets.$inferSelect
export type NewCreditWallet = typeof creditWallets.$inferInsert
export type CreditPurchase = typeof creditPurchases.$inferSelect
export type NewCreditPurchase = typeof creditPurchases.$inferInsert
export type UsageLedgerRow = typeof usageLedger.$inferSelect
export type NewUsageLedgerRow = typeof usageLedger.$inferInsert
export type CreditHold = typeof creditHolds.$inferSelect
export type NewCreditHold = typeof creditHolds.$inferInsert
export type RefundCounter = typeof refundCounters.$inferSelect
export type NewRefundCounter = typeof refundCounters.$inferInsert
export type StripeEvent = typeof stripeEvents.$inferSelect
export type NewStripeEvent = typeof stripeEvents.$inferInsert

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type ScoreVersion = typeof scoreVersions.$inferSelect
export type NewScoreVersion = typeof scoreVersions.$inferInsert
export type OrchestratorTurn = typeof orchestratorTurns.$inferSelect
export type NewOrchestratorTurn = typeof orchestratorTurns.$inferInsert
export type AuthSession = typeof authSessions.$inferSelect
export type NewAuthSession = typeof authSessions.$inferInsert
export type OAuthAccount = typeof oauthAccounts.$inferSelect
export type NewOAuthAccount = typeof oauthAccounts.$inferInsert
export type AuthToken = typeof authTokens.$inferSelect
export type NewAuthToken = typeof authTokens.$inferInsert
export type RequestQuota = typeof requestQuota.$inferSelect
export type NewRequestQuota = typeof requestQuota.$inferInsert
