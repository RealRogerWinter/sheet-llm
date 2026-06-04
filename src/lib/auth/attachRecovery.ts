import { NextResponse } from 'next/server'
import { RECOVERY_HEADER } from '@/lib/auth/recovery'
import type { SessionResult } from '@/lib/auth/session'

/**
 * Attach the recovery token from `getRequestUser` to a NextResponse.
 * No-op when the result didn't carry a token (returning user, cookie
 * still valid). The client-side `clientBackup.ts` interceptor reads
 * the header into `localStorage` whenever it's present.
 *
 * Returns the same response for chaining (`return attachRecoveryHeader(NextResponse.json(body), session)`).
 */
export function attachRecoveryHeader<T extends NextResponse | Response>(
  response: T,
  session: Pick<SessionResult, 'recoveryToken'>,
): T {
  if (session.recoveryToken) {
    response.headers.set(RECOVERY_HEADER, session.recoveryToken)
  }
  return response
}
