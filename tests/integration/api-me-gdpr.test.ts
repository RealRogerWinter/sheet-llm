// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../factories/db'

// Same cookie-jar mock as session.test.ts
type StoredCookie = { name: string; value: string; options?: unknown }
const cookieJar = (() => {
  const map = new Map<string, StoredCookie>()
  return {
    get: (name: string) => map.get(name),
    set: (name: string, value: string, options?: unknown) => {
      map.set(name, { name, value, options })
    },
    has: (name: string) => map.has(name),
    delete: (name: string) => {
      map.delete(name)
    },
    _reset: () => map.clear(),
  }
})()

vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
}))

beforeEach(async () => {
  cookieJar._reset()
  vi.stubEnv('SESSION_SECRET', 'test-secret-please-do-not-use-in-production-32+bytes')
  vi.stubEnv(
    'RECOVERY_SECRET',
    'recovery-test-secret-distinct-from-session-32+bytes-x',
  )
  vi.resetModules()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(makeTestDb())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  const { setDbForTesting } = await import('@/lib/db')
  setDbForTesting(undefined)
})

function origin() {
  return {
    origin: 'http://localhost:3000',
    host: 'localhost:3000',
  }
}

describe('GET /api/me/export', () => {
  it('returns the user record + all owned sessions/messages/scoreVersions as JSON', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const { createConversation, appendMessages } = await import(
      '@/lib/llm/conversations'
    )
    const session = await getOrCreateUserId()
    const chatId = await createConversation(session.userId)
    await appendMessages(session.userId, chatId, [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])

    const { GET } = await import('@/app/api/me/export/route')
    const res = await GET(
      new Request('http://localhost:3000/api/me/export', {
        method: 'GET',
        headers: origin(),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="sheet-llm-export-\d{8}\.json"$/,
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.schemaVersion).toBe(2)
    expect(body.user.id).toBe(session.userId)
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0].id).toBe(chatId)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].contentJson).toContain('hello')
  })

  it('includes soft-deleted sessions in the export', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const { createConversation, deleteConversation } = await import(
      '@/lib/llm/conversations'
    )
    const session = await getOrCreateUserId()
    const aliveId = await createConversation(session.userId)
    const deletedId = await createConversation(session.userId)
    await deleteConversation(session.userId, deletedId)

    const { GET } = await import('@/app/api/me/export/route')
    const res = await GET(
      new Request('http://localhost:3000/api/me/export', {
        method: 'GET',
        headers: origin(),
      }),
    )
    const body = await res.json()
    const ids = body.sessions.map((s: { id: string }) => s.id).sort()
    expect(ids).toEqual([aliveId, deletedId].sort())
    const deleted = body.sessions.find(
      (s: { id: string; deletedAt: number | null }) => s.id === deletedId,
    )
    expect(deleted.deletedAt).not.toBeNull()
  })

  it("does NOT include another user's data", async () => {
    // Seed two distinct users with separate sessions; export user A and
    // verify B's data is absent.
    const { getDb, setDbForTesting } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const { createConversation } = await import('@/lib/llm/conversations')
    const tdb = makeTestDb()
    setDbForTesting(tdb)
    const OTHER = '00000000-0000-0000-0000-0000000000bb'
    tdb.insert(users).values({ id: OTHER, createdAt: 0, lastSeenAt: 0 }).run()
    await createConversation(OTHER) // other user's session
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const session = await getOrCreateUserId()
    const aChatId = await createConversation(session.userId)

    const { GET } = await import('@/app/api/me/export/route')
    const res = await GET(
      new Request('http://localhost:3000/api/me/export', {
        method: 'GET',
        headers: origin(),
      }),
    )
    const body = await res.json()
    expect(body.user.id).toBe(session.userId)
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0].id).toBe(aChatId)
    // Final sanity — OTHER's session must not leak.
    const ids = body.sessions.map((s: { id: string }) => s.id)
    expect(ids).not.toContain(OTHER)
    // Also confirm we didn't somehow include the other user's row.
    expect(body.user.id).not.toBe(OTHER)
    void getDb // pin the import; jsdom strips unused imports otherwise
  })

  it('403s on cross-origin', async () => {
    const { GET } = await import('@/app/api/me/export/route')
    const res = await GET(
      new Request('http://localhost:3000/api/me/export', {
        method: 'GET',
        headers: {
          origin: 'http://evil.example.com',
          host: 'localhost:3000',
        },
      }),
    )
    expect(res.status).toBe(403)
  })

  it('401s when no session cookie is present (does NOT mint a phantom user)', async () => {
    const { GET } = await import('@/app/api/me/export/route')
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    expect(getDb().select({ id: users.id }).from(users).all()).toHaveLength(0)
    const res = await GET(
      new Request('http://localhost:3000/api/me/export', {
        method: 'GET',
        headers: origin(),
      }),
    )
    expect(res.status).toBe(401)
    // CRITICAL: must not have minted a fresh user just to export an empty
    // dump for them.
    expect(getDb().select({ id: users.id }).from(users).all()).toHaveLength(0)
  })

  it('discloses account fields + auth tables, with all credential hashes REDACTED', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const session = await getOrCreateUserId()
    const { getDb } = await import('@/lib/db')
    const { users, oauthAccounts, authTokens } = await import('@/lib/db/schema')
    // Promote to a claimed account + seed account-scoped rows directly.
    getDb()
      .update(users)
      .set({
        email: 'me@example.com',
        emailVerified: 1,
        tier: 'pro',
        displayName: 'Me',
        claimedAt: 1781500000,
        passwordHash: 'SECRET_PW_HASH',
      })
      .where(eq(users.id, session.userId))
      .run()
    // A claimed account exports via a real DB-backed login session (sl_sess) —
    // its sl_uid is refused (PR-2). createAuthSession provides BOTH the sl_sess
    // cookie that authenticates the request AND the one auth_sessions row the
    // export should disclose (metadata only).
    const { createAuthSession } = await import('@/lib/auth/sessionStore')
    await createAuthSession(session.userId, {
      ip: '203.0.113.0',
      userAgent: 'UA/1',
    })
    getDb()
      .insert(oauthAccounts)
      .values({
        id: 'oa1',
        userId: session.userId,
        provider: 'google',
        providerAccountId: 'g-123',
        createdAt: 1,
      })
      .run()
    getDb()
      .insert(authTokens)
      .values({
        id: 't1',
        userId: session.userId,
        purpose: 'email_verify',
        tokenHash: 'SECRET_TOKEN_HASH',
        expiresAt: 99,
        createdAt: 1,
      })
      .run()

    const { GET } = await import('@/app/api/me/export/route')
    const res = await GET(
      new Request('http://localhost:3000/api/me/export', {
        method: 'GET',
        headers: origin(),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // New user fields are disclosed (Art. 15).
    expect(body.user.email).toBe('me@example.com')
    expect(body.user.emailVerified).toBe(1)
    expect(body.user.tier).toBe('pro')
    expect(body.user.displayName).toBe('Me')
    expect(body.user.claimedAt).toBe(1781500000)
    // Account-scoped tables are disclosed.
    expect(body.authSessions).toHaveLength(1)
    expect(body.authSessions[0].ip).toBe('203.0.113.0')
    expect('tokenHash' in body.authSessions[0]).toBe(false)
    expect(body.oauthAccounts).toHaveLength(1)
    expect(body.oauthAccounts[0].provider).toBe('google')
    expect(body.authTokens).toHaveLength(1)
    expect(body.authTokens[0].purpose).toBe('email_verify')
    expect('tokenHash' in body.authTokens[0]).toBe(false)
    // CRITICAL: credential material (password_hash + every token_hash) must
    // NEVER appear in the user-downloadable export.
    const dump = JSON.stringify(body)
    expect(dump).not.toContain('SECRET_PW_HASH')
    expect(dump).not.toContain('SECRET_TOKEN_HASH')
    expect('passwordHash' in body.user).toBe(false)
  })

  it('includes the billing tables, with Stripe internals + our raw cost REDACTED (PR-14)', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const session = await getOrCreateUserId()
    const uid = session.userId
    const { getDb } = await import('@/lib/db')
    const { creditWallets, usageLedger, creditPurchases, creditHolds, refundCounters, stripeEvents } =
      await import('@/lib/db/schema')
    getDb().insert(creditWallets).values({ userId: uid, balance: 1000, held: 50, version: 3, updatedAt: 10 }).run()
    getDb().insert(creditHolds).values({ id: 'h1', userId: uid, requestId: 'r1', idempotencyKey: 'gen:r1', credits: 50, status: 'active', expiresAt: 99, createdAt: 5 }).run()
    getDb().insert(usageLedger).values({ id: 'l1', userId: uid, requestId: 'r0', idempotencyKey: 'gen:r0', kind: 'chat_generate', generationTier: 'pro', outputTokens: 1200, costMicroUsd: 90123, creditsCharged: 23, balanceAfter: 977, createdAt: 4 }).run()
    getDb().insert(creditPurchases).values({ id: 'p1', userId: uid, source: 'stripe', externalRef: 'cs:SECRET_SESSION_ID', creditsDelta: 1000, amountMinorUsd: 1000, currency: 'usd', status: 'settled', createdAt: 3 }).run()
    getDb().insert(refundCounters).values({ userId: uid, day: 20000, refundCount: 1, refundCredits: 23, updatedAt: 6 }).run()
    getDb().insert(stripeEvents).values({ eventId: 'evt_SECRET_EVENT', type: 'checkout.session.completed', status: 'processed', payload: '{"raw":"SECRET stripe payload — customer email"}', userId: uid, creditsGranted: 1000, receivedAt: 2, processedAt: 3 }).run()
    // Another user's stripe_event must NOT leak — stripe_events has no FK, so the
    // user_id-column scoping is the only isolation for it.
    getDb().insert(stripeEvents).values({ eventId: 'evt_OTHER', type: 'checkout.session.completed', status: 'processed', payload: '{}', userId: '00000000-0000-0000-0000-0000000000dd', creditsGranted: 500, receivedAt: 1, processedAt: 1 }).run()

    const { GET } = await import('@/app/api/me/export/route')
    const res = await GET(new Request('http://localhost:3000/api/me/export', { method: 'GET', headers: origin() }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.schemaVersion).toBe(2)
    // Wallet, with derived available.
    expect(body.creditWallet).toEqual({ balance: 1000, held: 50, available: 950, version: 3, updatedAt: 10 })
    // Ledger: the customer charge + token usage are disclosed; our raw cost basis
    // (cost_micro_usd) and the internal idempotency_key are NOT.
    expect(body.usageLedger).toHaveLength(1)
    expect(body.usageLedger[0].creditsCharged).toBe(23)
    expect('costMicroUsd' in body.usageLedger[0]).toBe(false)
    expect('idempotencyKey' in body.usageLedger[0]).toBe(false)
    // Purchase disclosed; the Stripe external_ref is REDACTED.
    expect(body.creditPurchases).toHaveLength(1)
    expect(body.creditPurchases[0].amountMinorUsd).toBe(1000)
    expect('externalRef' in body.creditPurchases[0]).toBe(false)
    expect(body.creditHolds).toHaveLength(1)
    expect(body.refundCounters).toHaveLength(1)
    // Stripe event: outcome disclosed; the Stripe event id + raw payload REDACTED,
    // and only THIS user's event is present.
    expect(body.stripeEvents).toHaveLength(1)
    expect(body.stripeEvents[0].type).toBe('checkout.session.completed')
    expect('eventId' in body.stripeEvents[0]).toBe(false)
    expect('payload' in body.stripeEvents[0]).toBe(false)
    expect(body.user.freeFullPieceUsedAt).toBeNull()
    // CRITICAL: no redacted internal appears anywhere in the dump.
    const dump = JSON.stringify(body)
    expect(dump).not.toContain('SECRET_SESSION_ID')
    expect(dump).not.toContain('SECRET_EVENT')
    expect(dump).not.toContain('SECRET stripe payload')
    expect(dump).not.toContain('90123') // our raw cost_micro_usd
  })

  it('GDPR completeness guard: every users-FK table is covered by the export', async () => {
    // Introspect the live schema: any table with a direct users FK must be in the
    // export allowlist, so a future financial/PII table can't silently escape
    // Art. 15. (stripe_events has NO users FK and is handled via its user_id column.)
    const tdb = makeTestDb()
    const client = tdb.$client
    const EXPORTED = new Set([
      'sessions',
      'auth_sessions',
      'oauth_accounts',
      'auth_tokens',
      'request_quota',
      'credit_wallets',
      'credit_purchases',
      'usage_ledger',
      'credit_holds',
      'refund_counters',
    ])
    const tableNames = (
      client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    for (const t of tableNames) {
      const fks = client.pragma(`foreign_key_list(${t})`) as Array<{ table: string }>
      if (fks.some((f) => f.table === 'users')) {
        expect(
          EXPORTED.has(t),
          `table "${t}" FK-references users but is not in the GDPR export allowlist — add it to buildUserExport (Art. 15) or document the exclusion`,
        ).toBe(true)
      }
    }
  })
})

describe('DELETE /api/me/delete', () => {
  it('hard-deletes the user + cascades through sessions/messages/scoreVersions', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const { createConversation, appendMessages } = await import(
      '@/lib/llm/conversations'
    )
    const session = await getOrCreateUserId()
    const chatId = await createConversation(session.userId)
    await appendMessages(session.userId, chatId, [
      { role: 'user', content: [{ type: 'text', text: 'doomed' }] },
    ])

    const { DELETE } = await import('@/app/api/me/delete/route')
    const res = await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({ confirm: 'DELETE' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.deletedSessions).toBe(1)
    expect(body.deletedMessages).toBe(1)
    expect(body.deletedAt).toBeGreaterThan(0)
    expect(body.clearLocalStorage).toContain('sheet-llm:recovery')

    // FK cascade — no rows for this user anywhere.
    const { getDb } = await import('@/lib/db')
    const { users, sessions, messages } = await import('@/lib/db/schema')
    expect(
      getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, session.userId))
        .get(),
    ).toBeUndefined()
    expect(
      getDb()
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, session.userId))
        .all().length,
    ).toBe(0)
    expect(
      getDb()
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.sessionId, chatId))
        .all().length,
    ).toBe(0)
  })

  it('receipt counts auth sessions / oauth accounts / tokens, and cascade-deletes them', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const session = await getOrCreateUserId()
    const { getDb } = await import('@/lib/db')
    const { authSessions, oauthAccounts, authTokens } = await import(
      '@/lib/db/schema'
    )
    getDb()
      .insert(authSessions)
      .values([
        { id: 'as1', userId: session.userId, tokenHash: 'h1', createdAt: 1, expiresAt: 2, idleExpiresAt: 2, lastUsedAt: 1 },
        { id: 'as2', userId: session.userId, tokenHash: 'h2', createdAt: 1, expiresAt: 2, idleExpiresAt: 2, lastUsedAt: 1 },
      ])
      .run()
    getDb()
      .insert(oauthAccounts)
      .values({ id: 'oa1', userId: session.userId, provider: 'github', providerAccountId: 'x', createdAt: 1 })
      .run()
    getDb()
      .insert(authTokens)
      .values({ id: 't1', userId: session.userId, purpose: 'password_reset', tokenHash: 'th', expiresAt: 9, createdAt: 1 })
      .run()

    const { DELETE } = await import('@/app/api/me/delete/route')
    const res = await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({ confirm: 'DELETE' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deletedAuthSessions).toBe(2)
    expect(body.deletedOauthAccounts).toBe(1)
    expect(body.deletedAuthTokens).toBe(1)
    // FK cascade actually swept the account-scoped rows.
    expect(
      getDb()
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.userId, session.userId))
        .all(),
    ).toHaveLength(0)
  })

  it('clears the session cookie in the response', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const session = await getOrCreateUserId()
    expect(cookieJar.get('sl_uid')).toBeDefined()
    void session
    const { DELETE } = await import('@/app/api/me/delete/route')
    await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({ confirm: 'DELETE' }),
      }),
    )
    expect(cookieJar.get('sl_uid')).toBeUndefined()
  })

  it('returns Clear-Site-Data header', async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    await getOrCreateUserId()
    const { DELETE } = await import('@/app/api/me/delete/route')
    const res = await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({ confirm: 'DELETE' }),
      }),
    )
    expect(res.headers.get('clear-site-data')).toBe('"storage"')
  })

  it("400s without the confirm: 'DELETE' literal", async () => {
    const { getOrCreateUserId } = await import('@/lib/auth/session')
    await getOrCreateUserId()
    const { DELETE } = await import('@/app/api/me/delete/route')
    const noBody = await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({}),
      }),
    )
    expect(noBody.status).toBe(400)
    const wrongValue = await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({ confirm: 'delete' }),
      }),
    )
    expect(wrongValue.status).toBe(400)
  })

  it("does NOT delete another user's data", async () => {
    const { setDbForTesting } = await import('@/lib/db')
    const { users, sessions } = await import('@/lib/db/schema')
    const { createConversation } = await import('@/lib/llm/conversations')
    const tdb = makeTestDb()
    setDbForTesting(tdb)
    const OTHER = '00000000-0000-0000-0000-0000000000cc'
    tdb.insert(users).values({ id: OTHER, createdAt: 0, lastSeenAt: 0 }).run()
    const otherChatId = await createConversation(OTHER)

    const { getOrCreateUserId } = await import('@/lib/auth/session')
    const session = await getOrCreateUserId()

    const { DELETE } = await import('@/app/api/me/delete/route')
    await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({ confirm: 'DELETE' }),
      }),
    )

    // Caller (session.userId) is gone; OTHER's row + session remain.
    expect(
      tdb
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, session.userId))
        .get(),
    ).toBeUndefined()
    expect(
      tdb
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, OTHER))
        .get(),
    ).toEqual({ id: OTHER })
    expect(
      tdb
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, otherChatId))
        .get(),
    ).toEqual({ id: otherChatId })
  })

  it('403s on cross-origin', async () => {
    const { DELETE } = await import('@/app/api/me/delete/route')
    const res = await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          origin: 'http://evil.example.com',
          host: 'localhost:3000',
        },
        body: JSON.stringify({ confirm: 'DELETE' }),
      }),
    )
    expect(res.status).toBe(403)
  })

  it('401s when no session cookie is present (does NOT mint + delete a phantom)', async () => {
    // Pre-seed a real account; the cookie-less request must NOT be allowed
    // to delete it OR to mint+delete a phantom that masks the real account.
    const { setDbForTesting, getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const tdb = makeTestDb()
    setDbForTesting(tdb)
    const REAL = '00000000-0000-0000-0000-0000000000aa'
    tdb.insert(users).values({ id: REAL, createdAt: 0, lastSeenAt: 0 }).run()

    const { DELETE } = await import('@/app/api/me/delete/route')
    const res = await DELETE(
      new Request('http://localhost:3000/api/me/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...origin() },
        body: JSON.stringify({ confirm: 'DELETE' }),
      }),
    )
    expect(res.status).toBe(401)
    // Real account untouched.
    expect(
      getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, REAL))
        .get(),
    ).toEqual({ id: REAL })
  })
})
