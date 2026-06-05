import { eq } from 'drizzle-orm'
import type { getDb } from '@/lib/db'
import {
  authSessions,
  authTokens,
  creditHolds,
  creditPurchases,
  creditWallets,
  messages,
  oauthAccounts,
  refundCounters,
  requestQuota,
  scoreVersions,
  sessions,
  stripeEvents,
  usageLedger,
  users,
} from '@/lib/db/schema'

/**
 * Schema version for the export envelope. Bump whenever the wire shape
 * (not just the columns) changes meaningfully — gives future tooling a
 * stable way to dispatch on format.
 *
 * v2 (PR-14, prepaid credits): added the billing sections — creditWallet,
 * usageLedger, creditPurchases, creditHolds, refundCounters, stripeEvents — and
 * user.freeFullPieceUsedAt.
 */
export const EXPORT_SCHEMA_VERSION = 2

export interface UserExport {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION
  exportedAt: number
  user: {
    id: string
    externalId: string | null
    email: string | null
    emailVerified: number
    tier: string
    displayName: string | null
    claimedAt: number | null
    createdAt: number
    lastSeenAt: number
    // PR-14: epoch-seconds the account consumed its one-time free full piece
    // (NULL = never). The internal owner token (free_full_piece_claim_token) is an
    // implementation marker, not personal data, and is never exported.
    freeFullPieceUsedAt: number | null
    // NOTE: password_hash is intentionally NEVER exported — it is credential
    // material, not user-facing personal data. Same for every token_hash.
  }
  /**
   * Every session row owned by the user, INCLUDING soft-deleted ones.
   * GDPR Art. 15 covers all stored personal data regardless of our UI
   * soft-delete hiding.
   */
  sessions: Array<{
    id: string
    title: string | null
    headVersionId: string | null
    forkedFromSessionId: string | null
    forkedFromVersionId: string | null
    createdAt: number
    updatedAt: number
    lastMessageAt: number
    deletedAt: number | null
  }>
  /**
   * Every message row owned by the user (via session FK). `contentJson`
   * is kept as the opaque string the DB stores — re-parsing only to
   * re-serialize would cost CPU + risk losing whitespace fidelity a
   * future restore tool might depend on.
   */
  messages: Array<{
    id: string
    sessionId: string
    seq: number
    role: string
    contentJson: string
    toolUseId: string | null
    scoreVersionId: string | null
    isSynthetic: number
    streamStatus: string
    errorCode: string | null
    createdAt: number
  }>
  /** Every score_versions row, with scoreJson left as opaque string. */
  scoreVersions: Array<{
    id: string
    sessionId: string
    parentVersionId: string | null
    scoreJson: string
    scoreHash: string
    source: string
    messageId: string | null
    coalesceKey: string | null
    idempotencyKey: string | null
    createdAt: number
  }>
  /**
   * Login sessions (PR-1). `token_hash` is REDACTED — it is the credential,
   * not disclosable personal data. Metadata (device, truncated IP, timestamps)
   * IS personal data and is included.
   */
  authSessions: Array<{
    id: string
    createdAt: number
    expiresAt: number
    idleExpiresAt: number
    lastUsedAt: number
    userAgent: string | null
    ip: string | null
    revokedAt: number | null
  }>
  /** Linked OAuth identities (PR-1). */
  oauthAccounts: Array<{
    id: string
    provider: string
    providerAccountId: string
    createdAt: number
  }>
  /**
   * Email-verify + password-reset tokens (PR-1). `token_hash` is REDACTED
   * (credential material); purpose + timestamps are included.
   */
  authTokens: Array<{
    id: string
    purpose: string
    expiresAt: number
    consumedAt: number | null
    createdAt: number
  }>
  /**
   * Hosted daily-quota counters keyed to this account ('u:<userId>' rows). Only
   * userId-linked rows are exported; anonymous 'a:' rows carry no subject and are
   * unlinkable (covered by short retention). Empty unless the quota feature is on.
   */
  dailyQuota: Array<{
    quotaKey: string
    windowStart: number
    count: number
    updatedAt: number
  }>
  /**
   * Prepaid-credit WALLET (PR-14). One row keyed to the account, or null if the
   * user never touched the paid path. `available` = balance − held (derived).
   */
  creditWallet: {
    balance: number
    held: number
    available: number
    version: number
    updatedAt: number
  } | null
  /**
   * The immutable USAGE LEDGER — one row per billed action (charge or refund).
   * The customer charge (creditsCharged), token usage, tier/model, and post-debit
   * balance are the user's data and are included. Our RAW Anthropic cost
   * (cost_micro_usd) is our internal cost basis / margin — NOT the subject's
   * personal data — so it is omitted; the internal idempotency_key is too.
   */
  usageLedger: Array<{
    id: string
    sessionId: string | null
    requestId: string
    holdId: string | null
    kind: string
    reason: string | null
    model: string | null
    generationTier: string | null
    inputTokens: number | null
    cachedInputTokens: number | null
    cacheCreationInputTokens: number | null
    outputTokens: number | null
    creditsCharged: number
    balanceAfter: number | null
    createdAt: number
  }>
  /**
   * Credit PURCHASES (Stripe / promo / refund / manual). `external_ref` (the
   * Stripe checkout-session / PaymentIntent id) is a Stripe-internal identifier
   * and is REDACTED — `source` records that it was a Stripe purchase and the
   * amount / credits / date fully describe it.
   */
  creditPurchases: Array<{
    id: string
    source: string
    creditsDelta: number
    amountMinorUsd: number | null
    currency: string | null
    status: string
    createdAt: number
  }>
  /** Pre-authorization credit HOLDS (the reserve → settle/release lifecycle). */
  creditHolds: Array<{
    id: string
    requestId: string
    credits: number
    status: string
    expiresAt: number
    createdAt: number
    settledAt: number | null
  }>
  /** Per-day service-refund counters (abuse-ceiling bookkeeping). */
  refundCounters: Array<{
    day: number
    refundCount: number
    refundCredits: number
    updatedAt: number
  }>
  /**
   * The user's Stripe webhook events (PR-14), REDACTED. The Stripe event id and
   * the RAW payload (Stripe-internal customer / payment-intent / session ids, plus
   * a duplicate of the purchase) are dropped; only the user-meaningful outcome is
   * disclosed. NOTE: unlike the cascade-deleted credit tables, stripe_events has
   * NO users FK and is RETAINED past account erasure as a financial/tax record
   * (lawful basis; see the billing subsystem doc) — disclosed for ACCESS (Art. 15)
   * but not removed on erasure (Art. 17(3)(b)).
   */
  stripeEvents: Array<{
    type: string
    status: string
    creditsGranted: number | null
    reason: string | null
    receivedAt: number
    processedAt: number | null
  }>
}

type Db = ReturnType<typeof getDb>

/**
 * Build the full GDPR export for `userId`. Caller decides what to do
 * with it (HTTP response, CLI dump, etc.). Synchronous-by-result —
 * everything streams from SQLite via Drizzle so memory cost is one
 * full materialization of the user's data.
 *
 * For a power user with 100 sessions × 100 versions × 5 KB JSON each,
 * worst case ≈ 50 MB in memory. Realistic p99 well under 5 MB. NDJSON
 * streaming deferred until somebody hits this ceiling in production.
 *
 * PR-14 (prepaid credits): the export now includes the billing tables — the
 * credit_wallets row, usage_ledger, credit_purchases, credit_holds, and
 * refund_counters (all users-FK'd; ACCESS Art. 15) — with Stripe-internal ids and
 * our raw cost basis redacted (see the UserExport billing sections). A
 * `foreign_key_list`-introspection guard test (api-me-gdpr.test.ts) fails if a
 * future users-FK'd table is added without also being exported here.
 *
 * stripe_events (0012, the webhook inbox) DELIBERATELY has NO users FK, so account
 * ERASURE does not cascade it — it is RETAINED as a financial/tax record (lawful
 * basis). Its user-meaningful fields ARE disclosed for ACCESS, keyed off its plain
 * `user_id` column and redacted (no Stripe event id, no raw payload). The
 * erasure-time redaction-vs-retain decision for the retained payload stays gated on
 * the launch attorney memo; do NOT add a naive users cascade here without it.
 */
export async function buildUserExport(
  db: Db,
  userId: string,
): Promise<UserExport | undefined> {
  const user = await db
    .select({
      id: users.id,
      externalId: users.externalId,
      email: users.email,
      emailVerified: users.emailVerified,
      tier: users.tier,
      displayName: users.displayName,
      claimedAt: users.claimedAt,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      freeFullPieceUsedAt: users.freeFullPieceUsedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .get()
  if (!user) return undefined

  // No deletedAt filter — GDPR wants all data, hidden or not.
  const sessionRows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      headVersionId: sessions.headVersionId,
      forkedFromSessionId: sessions.forkedFromSessionId,
      forkedFromVersionId: sessions.forkedFromVersionId,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
      lastMessageAt: sessions.lastMessageAt,
      deletedAt: sessions.deletedAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))

  const sessionIds = sessionRows.map((s) => s.id)

  // Two follow-up reads; for typical accounts the count is small. If
  // this ever becomes a perf hotspot, replace with a single CTE-style
  // join. For now: clarity beats cleverness.
  const messageRows: UserExport['messages'] = []
  const scoreVersionRows: UserExport['scoreVersions'] = []
  for (const sessionId of sessionIds) {
    const rows = await db
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        seq: messages.seq,
        role: messages.role,
        contentJson: messages.contentJson,
        toolUseId: messages.toolUseId,
        scoreVersionId: messages.scoreVersionId,
        isSynthetic: messages.isSynthetic,
        streamStatus: messages.streamStatus,
        errorCode: messages.errorCode,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
    messageRows.push(...rows)
    const vRows = await db
      .select({
        id: scoreVersions.id,
        sessionId: scoreVersions.sessionId,
        parentVersionId: scoreVersions.parentVersionId,
        scoreJson: scoreVersions.scoreJson,
        scoreHash: scoreVersions.scoreHash,
        source: scoreVersions.source,
        messageId: scoreVersions.messageId,
        coalesceKey: scoreVersions.coalesceKey,
        idempotencyKey: scoreVersions.idempotencyKey,
        createdAt: scoreVersions.createdAt,
      })
      .from(scoreVersions)
      .where(eq(scoreVersions.sessionId, sessionId))
    scoreVersionRows.push(...vRows)
  }

  // Account-scoped rows (PR-1). These FK directly to users.id, so each is a
  // single indexed read — no per-session fan-out. token_hash columns are
  // deliberately NOT selected (credential material, never exported).
  const authSessionRows = await db
    .select({
      id: authSessions.id,
      createdAt: authSessions.createdAt,
      expiresAt: authSessions.expiresAt,
      idleExpiresAt: authSessions.idleExpiresAt,
      lastUsedAt: authSessions.lastUsedAt,
      userAgent: authSessions.userAgent,
      ip: authSessions.ip,
      revokedAt: authSessions.revokedAt,
    })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
  const oauthAccountRows = await db
    .select({
      id: oauthAccounts.id,
      provider: oauthAccounts.provider,
      providerAccountId: oauthAccounts.providerAccountId,
      createdAt: oauthAccounts.createdAt,
    })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.userId, userId))
  const authTokenRows = await db
    .select({
      id: authTokens.id,
      purpose: authTokens.purpose,
      expiresAt: authTokens.expiresAt,
      consumedAt: authTokens.consumedAt,
      createdAt: authTokens.createdAt,
    })
    .from(authTokens)
    .where(eq(authTokens.userId, userId))

  // Hosted daily-quota rows for this account (userId-scoped; anon 'a:' rows are
  // subject-less and excluded). Empty when the quota feature is off.
  const dailyQuotaRows = await db
    .select({
      quotaKey: requestQuota.quotaKey,
      windowStart: requestQuota.windowStart,
      count: requestQuota.count,
      updatedAt: requestQuota.updatedAt,
    })
    .from(requestQuota)
    .where(eq(requestQuota.userId, userId))

  // ── Billing / prepaid-credit tables (PR-14). All users-FK'd → single indexed
  // reads. Stripe-internal ids (external_ref, stripe event id/payload) and our raw
  // cost basis (cost_micro_usd) are deliberately NOT selected (redacted).
  const walletRow = await db
    .select({
      balance: creditWallets.balance,
      held: creditWallets.held,
      version: creditWallets.version,
      updatedAt: creditWallets.updatedAt,
    })
    .from(creditWallets)
    .where(eq(creditWallets.userId, userId))
    .get()
  const creditWallet = walletRow ? { ...walletRow, available: walletRow.balance - walletRow.held } : null

  const usageLedgerRows = await db
    .select({
      id: usageLedger.id,
      sessionId: usageLedger.sessionId,
      requestId: usageLedger.requestId,
      holdId: usageLedger.holdId,
      kind: usageLedger.kind,
      reason: usageLedger.reason,
      model: usageLedger.model,
      generationTier: usageLedger.generationTier,
      inputTokens: usageLedger.inputTokens,
      cachedInputTokens: usageLedger.cachedInputTokens,
      cacheCreationInputTokens: usageLedger.cacheCreationInputTokens,
      outputTokens: usageLedger.outputTokens,
      creditsCharged: usageLedger.creditsCharged,
      balanceAfter: usageLedger.balanceAfter,
      createdAt: usageLedger.createdAt,
    })
    .from(usageLedger)
    .where(eq(usageLedger.userId, userId))

  const creditPurchaseRows = await db
    .select({
      id: creditPurchases.id,
      source: creditPurchases.source,
      creditsDelta: creditPurchases.creditsDelta,
      amountMinorUsd: creditPurchases.amountMinorUsd,
      currency: creditPurchases.currency,
      status: creditPurchases.status,
      createdAt: creditPurchases.createdAt,
    })
    .from(creditPurchases)
    .where(eq(creditPurchases.userId, userId))

  const creditHoldRows = await db
    .select({
      id: creditHolds.id,
      requestId: creditHolds.requestId,
      credits: creditHolds.credits,
      status: creditHolds.status,
      expiresAt: creditHolds.expiresAt,
      createdAt: creditHolds.createdAt,
      settledAt: creditHolds.settledAt,
    })
    .from(creditHolds)
    .where(eq(creditHolds.userId, userId))

  const refundCounterRows = await db
    .select({
      day: refundCounters.day,
      refundCount: refundCounters.refundCount,
      refundCredits: refundCounters.refundCredits,
      updatedAt: refundCounters.updatedAt,
    })
    .from(refundCounters)
    .where(eq(refundCounters.userId, userId))

  // stripe_events has NO users FK, but its plain user_id column resolves the
  // subject. The Stripe event id + raw payload are NOT selected (redacted).
  const stripeEventRows = await db
    .select({
      type: stripeEvents.type,
      status: stripeEvents.status,
      creditsGranted: stripeEvents.creditsGranted,
      reason: stripeEvents.reason,
      receivedAt: stripeEvents.receivedAt,
      processedAt: stripeEvents.processedAt,
    })
    .from(stripeEvents)
    .where(eq(stripeEvents.userId, userId))

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Math.floor(Date.now() / 1000),
    user,
    sessions: sessionRows,
    messages: messageRows,
    scoreVersions: scoreVersionRows,
    authSessions: authSessionRows,
    oauthAccounts: oauthAccountRows,
    authTokens: authTokenRows,
    dailyQuota: dailyQuotaRows,
    creditWallet,
    usageLedger: usageLedgerRows,
    creditPurchases: creditPurchaseRows,
    creditHolds: creditHoldRows,
    refundCounters: refundCounterRows,
    stripeEvents: stripeEventRows,
  }
}

/**
 * Hard-delete a user and everything that FK-cascades from them. Returns
 * receipt counts so the route handler can include them in the response
 * (the user has the right to receive proof of deletion).
 *
 * All-or-nothing WITHOUT an explicit transaction: the only write is a SINGLE
 * `DELETE FROM users`, which is atomic on its own and FK-cascades to every
 * child — so it either fully succeeds or removes nothing. The counts taken
 * above it are read-only and best-effort (a row inserted between a count and the
 * delete is still erased by the cascade, just not reflected in the receipt).
 * Cascade chain (SQLite FK definitions, all ON DELETE CASCADE):
 *   users → sessions → messages, scoreVersions
 *   users → auth_sessions, oauth_accounts, auth_tokens, request_quota
 */
export async function hardDeleteUser(
  db: Db,
  userId: string,
): Promise<
  | {
      ok: true
      deletedSessions: number
      deletedMessages: number
      deletedVersions: number
      deletedAuthSessions: number
      deletedOauthAccounts: number
      deletedAuthTokens: number
      deletedRequestQuota: number
    }
  | { ok: false; reason: 'user_not_found' }
> {
  // Count before delete so the receipt is accurate (cascade obliterates
  // everything in one statement).
  const sessionCount = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId))
  if (sessionCount.length === 0) {
    // Could still be a real user with zero sessions — check existence.
    const exists = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .get()
    if (!exists) return { ok: false, reason: 'user_not_found' }
  }
  const sessionIds = sessionCount.map((s) => s.id)
  let messageRows = 0
  let versionRows = 0
  for (const sId of sessionIds) {
    const ms = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.sessionId, sId))
    messageRows += ms.length
    const vs = await db
      .select({ id: scoreVersions.id })
      .from(scoreVersions)
      .where(eq(scoreVersions.sessionId, sId))
    versionRows += vs.length
  }
  // Account-scoped rows (PR-1) FK directly to users.id and cascade on the
  // delete below; count them first so the erasure receipt is accurate.
  const authSessionCount = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
  const oauthAccountCount = await db
    .select({ id: oauthAccounts.id })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.userId, userId))
  const authTokenCount = await db
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(eq(authTokens.userId, userId))
  const requestQuotaCount = await db
    .select({ quotaKey: requestQuota.quotaKey })
    .from(requestQuota)
    .where(eq(requestQuota.userId, userId))

  // Delete the user; FK cascades sweep the rest.
  const result = await db
    .delete(users)
    .where(eq(users.id, userId))
    .returning({ id: users.id })
  if (result.length === 0) return { ok: false, reason: 'user_not_found' }
  return {
    ok: true,
    deletedSessions: sessionIds.length,
    deletedMessages: messageRows,
    deletedVersions: versionRows,
    deletedAuthSessions: authSessionCount.length,
    deletedOauthAccounts: oauthAccountCount.length,
    deletedAuthTokens: authTokenCount.length,
    deletedRequestQuota: requestQuotaCount.length,
  }
}
