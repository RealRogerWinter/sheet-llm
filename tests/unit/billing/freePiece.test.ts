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

describe('free piece pre-dispatch reservation (PR-7b-2c TOCTOU fix + PR-13 owner token)', () => {
  let db: Db
  beforeEach(() => {
    db = makeTestDb()
  })

  it('reserve atomically claims a VERIFIED, never-used grant (one winner) and returns its token', () => {
    makeUser(db, 'v', 1)
    const token = reserveFreePiece('v', db) // claims it, returns the owner token
    expect(token).not.toBeNull()
    // A concurrent burst: the SAME guard-in-the-write means everyone else loses.
    expect(reserveFreePiece('v', db)).toBeNull()
    expect(isFreePieceEligible('v', db)).toBe(false) // now taken
    const row = db
      .select({ u: users.freeFullPieceUsedAt, t: users.freeFullPieceClaimToken })
      .from(users)
      .where(eq(users.id, 'v'))
      .get()
    expect(row?.u).not.toBeNull()
    expect(row?.t).toBe(token) // the owner token is persisted on the row
  })

  it('reserve refuses an UNVERIFIED account (no identity farming) and does NOT mark it', () => {
    makeUser(db, 'a', 0)
    expect(reserveFreePiece('a', db)).toBeNull()
    const row = db.select({ u: users.freeFullPieceUsedAt }).from(users).where(eq(users.id, 'a')).get()
    expect(row?.u).toBeNull() // untouched — still claimable if they verify later
  })

  it('reserve refuses an already-used grant and a missing user', () => {
    makeUser(db, 'u', 1, 123)
    expect(reserveFreePiece('u', db)).toBeNull()
    expect(reserveFreePiece('ghost', db)).toBeNull()
  })

  it('release (with the owning token) un-claims → eligible again (retry after a non-delivery)', () => {
    makeUser(db, 'v', 1)
    const token = reserveFreePiece('v', db)
    expect(token).not.toBeNull()
    expect(releaseFreePiece('v', token!, db)).toBe(true) // gave it back
    expect(isFreePieceEligible('v', db)).toBe(true) // re-eligible
    expect(reserveFreePiece('v', db)).not.toBeNull() // a retry can claim it again
  })

  it('release with a NON-owning token is a no-op — cannot clobber a concurrent re-claim (PR-13)', () => {
    makeUser(db, 'v', 1)
    const t1 = reserveFreePiece('v', db) // request 1 claims (token t1)
    expect(t1).not.toBeNull()
    expect(releaseFreePiece('v', t1!, db)).toBe(true) // request 1 releases its own claim
    const t2 = reserveFreePiece('v', db) // request 2 re-claims (token t2)
    expect(t2).not.toBeNull()
    expect(t2).not.toBe(t1)
    // A LATE / duplicate release carrying request 1's stale token must NOT clear
    // request 2's fresh claim — the residual LOW the owner token closes.
    expect(releaseFreePiece('v', t1!, db)).toBe(false)
    expect(isFreePieceEligible('v', db)).toBe(false) // t2's claim survives intact
    const row = db.select({ t: users.freeFullPieceClaimToken }).from(users).where(eq(users.id, 'v')).get()
    expect(row?.t).toBe(t2)
  })

  it('release is a no-op (returns false) when nothing is claimed / token unknown', () => {
    makeUser(db, 'v', 1) // used_at IS NULL, token NULL
    expect(releaseFreePiece('v', 'no-such-token', db)).toBe(false) // no row holds this token
    expect(releaseFreePiece('ghost', 'no-such-token', db)).toBe(false)
  })

  it('reserve → DELIVERED (kept) is terminal: no release means the grant stays spent', () => {
    makeUser(db, 'v', 1)
    expect(reserveFreePiece('v', db)).not.toBeNull()
    // (delivery keeps it consumed — the route simply does NOT release.)
    expect(isFreePieceEligible('v', db)).toBe(false)
  })
})
