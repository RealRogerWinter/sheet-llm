import { afterEach, beforeEach } from 'vitest'
import { setDbForTesting } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { makeTestDb } from './db'

/**
 * Fixed UUID used by every route-level integration test. Mock
 * `@/lib/auth/session` in your test file (see `mockAuthSession` below)
 * so route handlers resolve every cookie-less request to this id.
 */
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'

/**
 * Use inside a `describe` (or at top-level of a test file) to give each
 * test a fresh in-memory DB pre-seeded with the test user. Routes that
 * call `getDb()` will resolve to this DB for the duration of the test.
 */
export function installTestDb(): { getDb: () => ReturnType<typeof makeTestDb> } {
  let activeDb: ReturnType<typeof makeTestDb> | undefined
  beforeEach(() => {
    activeDb = makeTestDb()
    activeDb
      .insert(users)
      .values({
        id: TEST_USER_ID,
        createdAt: 0,
        lastSeenAt: 0,
      })
      .run()
    setDbForTesting(activeDb)
  })
  afterEach(() => {
    setDbForTesting(undefined)
    activeDb = undefined
  })
  return {
    getDb: () => {
      if (!activeDb) {
        throw new Error('installTestDb(): no active DB — call inside a test')
      }
      return activeDb
    },
  }
}

/**
 * Factory used in `vi.mock('@/lib/auth/session', () => mockAuthSession())`.
 * Returns the auth module shape resolving every request to `TEST_USER_ID`.
 * Routes invoking it never set a real cookie, so the mock ignores the cookie
 * store entirely.
 *
 * Routes resolve identity through `getRequestUser` / `getExistingRequestUser`
 * (PR-2) — `RequestUser` = `{ userId, authenticated, recoveryToken? }`. The
 * legacy `getOrCreateUserId`/`getExistingUserId` are retained for any test that
 * still references them directly. `authenticated: false` mirrors a cookie-less
 * anonymous request; leaving `userId` unset drops it to undefined inside route
 * handlers and tanks every test that inserts into `sessions`.
 */
export function mockAuthSession() {
  return {
    getRequestUser: async () => ({ userId: TEST_USER_ID, authenticated: false }),
    getExistingRequestUser: async () => ({
      userId: TEST_USER_ID,
      authenticated: false,
    }),
    getOrCreateUserId: async () => ({ userId: TEST_USER_ID }),
    getExistingUserId: async () => ({ userId: TEST_USER_ID }),
    __TEST_COOKIE_NAME: 'sl_uid',
  }
}
