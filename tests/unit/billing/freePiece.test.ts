// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { users } from '@/lib/db/schema'
import { consumeFreePiece, isFreePieceEligible } from '@/lib/billing/freePiece'

type Db = ReturnType<typeof makeTestDb>

function makeUser(db: Db, id: string, emailVerified: number, usedAt: number | null = null): void {
  db.insert(users)
    .values({ id, createdAt: 0, lastSeenAt: 0, emailVerified, freeFullPieceUsedAt: usedAt })
    .run()
}

describe('free full piece (one-time, per-verified-account)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
  })

  it('a VERIFIED, never-used account is eligible', () => {
    makeUser(db, 'v', 1)
    expect(isFreePieceEligible('v', db)).toBe(true)
  })

  it('an UNVERIFIED account is NOT eligible (blocks anon/identity farming)', () => {
    makeUser(db, 'a', 0)
    expect(isFreePieceEligible('a', db)).toBe(false)
  })

  it('an already-consumed account is NOT eligible', () => {
    makeUser(db, 'u', 1, 123)
    expect(isFreePieceEligible('u', db)).toBe(false)
  })

  it('a missing user is NOT eligible', () => {
    expect(isFreePieceEligible('nope', db)).toBe(false)
  })

  it('consume is one-time + idempotent (guard-in-the-write)', () => {
    makeUser(db, 'v', 1)
    expect(consumeFreePiece('v', db)).toBe(true) // first call consumes
    expect(consumeFreePiece('v', db)).toBe(false) // a retry / concurrent call is a no-op
    expect(isFreePieceEligible('v', db)).toBe(false)
    const row = db
      .select({ usedAt: users.freeFullPieceUsedAt })
      .from(users)
      .where(eq(users.id, 'v'))
      .get()
    expect(row?.usedAt).not.toBeNull()
  })

  it('consume on a missing user changes nothing', () => {
    expect(consumeFreePiece('ghost', db)).toBe(false)
  })
})
