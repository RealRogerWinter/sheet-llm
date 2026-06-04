import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { authTokens } from '@/lib/db/schema'

type Db = ReturnType<typeof getDb>
export type TokenPurpose = 'email_verify' | 'password_reset'

/**
 * Single-use, SHA-256-hashed, short-TTL tokens for the email flows. The RAW
 * token only ever leaves the server inside the email link; the DB stores only
 * its hash, so a DB read can't be replayed as a valid link. Consumption is an
 * atomic compare-and-swap (mirrors `api/auth/restore`'s nonce CAS): the UPDATE
 * predicate enforces unconsumed + unexpired + matching purpose, so two parallel
 * consumes of one token succeed for at most one.
 */
const TTL_SECONDS: Record<TokenPurpose, number> = {
  email_verify: 24 * 60 * 60, // 24h
  password_reset: 60 * 60, // 60min
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Mint a token for (userId, purpose) and return the RAW token (for the email
 * link). Only its SHA-256 hash is persisted.
 */
export async function createAuthToken(
  userId: string,
  purpose: TokenPurpose,
  database?: Db,
): Promise<string> {
  const db = database ?? getDb()
  const token = generateToken()
  const now = nowSeconds()
  await db.insert(authTokens).values({
    id: randomUUID(),
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: now + TTL_SECONDS[purpose],
    createdAt: now,
  })
  return token
}

/**
 * Atomically consume a token: sets `consumed_at` ONLY if it matches the purpose,
 * is unconsumed, and is unexpired — returning the owning userId. Returns null
 * otherwise (unknown / wrong-purpose / already-used / expired).
 */
export async function consumeAuthToken(
  rawToken: string,
  purpose: TokenPurpose,
  database?: Db,
): Promise<{ userId: string } | null> {
  const db = database ?? getDb()
  const now = nowSeconds()
  const res = await db
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(rawToken)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ userId: authTokens.userId })
  return res.length > 0 ? { userId: res[0].userId } : null
}

/**
 * Invalidate (consume) all of a user's outstanding tokens of a purpose — called
 * before issuing a fresh one so only the NEWEST link in an inbox works: an old
 * forwarded/leaked reset link is dead the moment a new one is requested.
 */
export async function invalidateUserTokens(
  userId: string,
  purpose: TokenPurpose,
  database?: Db,
): Promise<void> {
  const db = database ?? getDb()
  await db
    .update(authTokens)
    .set({ consumedAt: nowSeconds() })
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
      ),
    )
}
