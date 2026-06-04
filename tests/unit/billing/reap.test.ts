// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { setDbForTesting } from '@/lib/db'
import { creditHolds, users } from '@/lib/db/schema'
import { makeTestDb } from '../../factories/db'
import { creditWallet, getWallet, placeHold } from '@/lib/billing/wallet'
import { __resetHoldReapForTesting, maybeReapExpiredHolds } from '@/lib/billing/reap'

type Db = ReturnType<typeof makeTestDb>

// Proves the credit-hold reaper is actually WIRED (the security review flagged
// reapExpiredHolds as having no call site → a crash between placeHold and settle
// would strand credits forever). maybeReapExpiredHolds is invoked from the chat
// route (gated on SL_PAID_GENERATION); here we drive it directly.
describe('maybeReapExpiredHolds (stranded-hold crash recovery)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
    db.insert(users).values({ id: 'u1', createdAt: 0, lastSeenAt: 0 }).run()
    setDbForTesting(db)
    __resetHoldReapForTesting()
  })
  afterEach(() => setDbForTesting(undefined))

  it('releases an EXPIRED active hold (microtask-deferred) so credits are not stranded', async () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'test' }, db)
    // ttlSec:-1 → already expired, simulating a crash between place and settle.
    const h = placeHold({ userId: 'u1', requestId: 'r1', idempotencyKey: 'k1', credits: 30, ttlSec: -1 }, db)
    expect(h.ok).toBe(true)
    expect(getWallet('u1', db).held).toBe(30)

    maybeReapExpiredHolds()
    await new Promise((r) => setTimeout(r, 0)) // flush the queued microtask

    expect(getWallet('u1', db)).toEqual({ balance: 100, held: 0, available: 100 })
    if (h.ok) {
      const row = db
        .select({ status: creditHolds.status })
        .from(creditHolds)
        .where(eq(creditHolds.id, h.holdId))
        .get()
      expect(row?.status).toBe('released')
    }
  })

  it('leaves a FRESH (non-expired) hold reserved', async () => {
    creditWallet({ userId: 'u1', creditsDelta: 100, source: 'test' }, db)
    placeHold({ userId: 'u1', requestId: 'r2', idempotencyKey: 'k2', credits: 40, ttlSec: 900 }, db)

    maybeReapExpiredHolds()
    await new Promise((r) => setTimeout(r, 0))

    expect(getWallet('u1', db).held).toBe(40) // still reserved — not yet expired
  })
})
