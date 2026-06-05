// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '../../factories/db'
import { users } from '@/lib/db/schema'
import { isFreePieceEligible, releaseFreePiece, reserveFreePiece } from '@/lib/billing/freePiece'

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
})

describe('free piece pre-dispatch reservation (PR-7b-2c TOCTOU fix)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
  })

  it('reserve atomically claims a VERIFIED, never-used grant (one winner)', () => {
    makeUser(db, 'v', 1)
    expect(reserveFreePiece('v', db)).toBe(true) // claims it
    // A concurrent burst: the SAME guard-in-the-write means everyone else loses.
    expect(reserveFreePiece('v', db)).toBe(false)
    expect(isFreePieceEligible('v', db)).toBe(false) // now taken
    const row = db.select({ u: users.freeFullPieceUsedAt }).from(users).where(eq(users.id, 'v')).get()
    expect(row?.u).not.toBeNull()
  })

  it('reserve refuses an UNVERIFIED account (no identity farming) and does NOT mark it', () => {
    makeUser(db, 'a', 0)
    expect(reserveFreePiece('a', db)).toBe(false)
    const row = db.select({ u: users.freeFullPieceUsedAt }).from(users).where(eq(users.id, 'a')).get()
    expect(row?.u).toBeNull() // untouched — still claimable if they verify later
  })

  it('reserve refuses an already-used grant and a missing user', () => {
    makeUser(db, 'u', 1, 123)
    expect(reserveFreePiece('u', db)).toBe(false)
    expect(reserveFreePiece('ghost', db)).toBe(false)
  })

  it('release un-claims a reservation → eligible again (retry after a non-delivery)', () => {
    makeUser(db, 'v', 1)
    expect(reserveFreePiece('v', db)).toBe(true)
    expect(releaseFreePiece('v', db)).toBe(true) // gave it back
    expect(isFreePieceEligible('v', db)).toBe(true) // re-eligible
    expect(reserveFreePiece('v', db)).toBe(true) // a retry can claim it again
  })

  it('release is a no-op (returns false) when nothing is claimed', () => {
    makeUser(db, 'v', 1) // used_at IS NULL
    expect(releaseFreePiece('v', db)).toBe(false) // guarded by IS NOT NULL
    expect(releaseFreePiece('ghost', db)).toBe(false)
  })

  it('reserve → DELIVERED (kept) is terminal: no release means the grant stays spent', () => {
    makeUser(db, 'v', 1)
    expect(reserveFreePiece('v', db)).toBe(true)
    // (delivery keeps it consumed — the route simply does NOT release.)
    expect(isFreePieceEligible('v', db)).toBe(false)
  })
})
