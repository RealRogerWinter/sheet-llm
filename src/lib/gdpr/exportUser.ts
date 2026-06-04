import { eq } from 'drizzle-orm'
import type { getDb } from '@/lib/db'
import {
  authSessions,
  authTokens,
  messages,
  oauthAccounts,
  requestQuota,
  scoreVersions,
  sessions,
  users,
} from '@/lib/db/schema'

/**
 * Schema version for the export envelope. Bump whenever the wire shape
 * (not just the columns) changes meaningfully — gives future tooling a
 * stable way to dispatch on format.
 */
export const EXPORT_SCHEMA_VERSION = 1

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
 * TODO(PR-14, prepaid-credits): the financial-PII tables added in migrations
 * 0009 (credit_purchases, usage_ledger, credit_holds) and 0011
 * (refund_counters) are NOT yet in this export envelope. Account ERASURE
 * already covers those five (the single `DELETE FROM users` FK-cascades them),
 * but GDPR Art. 15 ACCESS must add them when the credits feature ships — land a
 * `foreign_key_list`-introspection guard test then so a future users-FK'd table
 * can't silently escape the export, and decide anonymize-vs-delete for the
 * immutable financial ledgers against record-retention.
 *
 * SEPARATE CASE: `stripe_events` (0012, the webhook inbox) DELIBERATELY has NO
 * users FK, so erasure does NOT cascade it — its payload carries PII (Stripe
 * customer email/address) but it is a financial/tax record with a retention
 * basis. PR-14 + the launch attorney memo must settle the retention window and
 * whether erasure redacts the payload vs. keeps it under a legal-obligation
 * lawful basis. Do NOT add a naive cascade here without that decision.
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
