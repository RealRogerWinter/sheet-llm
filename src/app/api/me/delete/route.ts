import { NextResponse } from 'next/server'
import { z } from 'zod'
import { clearSessionCookie, getExistingRequestUser } from '@/lib/auth/session'
import { clearAuthSessionCookies } from '@/lib/auth/sessionStore'
import { getDb } from '@/lib/db'
import { hardDeleteUser } from '@/lib/gdpr/exportUser'
import { checkSameOrigin, errorResponse } from '@/app/api/chat/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 1024

/**
 * Body schema: must contain `{ confirm: 'DELETE' }` literal. Matches
 * GitHub's "delete repo" pattern — accidental curl/XHR misfires can't
 * trigger destruction; the UI's typed-confirmation modal is the
 * primary defense but server-side check is the load-bearing one.
 */
const BodySchema = z.object({
  confirm: z.literal('DELETE'),
})

/**
 * DELETE /api/me/delete — GDPR Art. 17 right-to-erasure.
 *
 * Hard-deletes the current user and everything that FK-cascades from
 * them (sessions, messages, score_versions). No soft-delete grace
 * window — simpler and unambiguously compliant. Returns receipt
 * counts so the user has proof of deletion.
 *
 * Clears the session cookie AND signals the client to clear the
 * localStorage recovery backup (via `clearLocalStorage` in the
 * response body). Without this the next page load would attempt
 * restore against a now-deleted user → 410 → confusing UX where
 * "delete" looks like it didn't take.
 */
export async function DELETE(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return errorResponse('invalid_request', 413, 'Request body too large')
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return errorResponse('invalid_request', 400, 'Could not read request body')
  }
  try {
    BodySchema.parse(JSON.parse(raw))
  } catch {
    return errorResponse(
      'invalid_request',
      400,
      'Body must be { "confirm": "DELETE" }',
    )
  }

  // Use the get-only variant: never mint a fresh anonymous identity on
  // this endpoint. Without this guard, a cookie-less caller would have
  // a phantom user minted-then-deleted while their real account (if
  // any) sat untouched — silent GDPR Art. 17 failure.
  const session = await getExistingRequestUser()
  if (!session) {
    return errorResponse('invalid_request', 401, 'No active session')
  }
  const db = getDb()
  const result = await hardDeleteUser(db, session.userId)
  if (!result.ok) {
    return errorResponse('chat_not_found', 404, 'Account not found')
  }

  // Clear the anon session cookie so the next request mints fresh anon, AND the
  // DB-backed auth-session cookies (a claimed account deleting itself: the
  // auth_sessions rows are already gone via FK cascade, but the cookie isn't).
  await clearSessionCookie()
  await clearAuthSessionCookies()

  // `Clear-Site-Data` header — Chromium + Firefox honor it (Safari
  // ignores). Defense in depth alongside the response body's
  // `clearLocalStorage` directive that the client wrapper acts on.
  return NextResponse.json(
    {
      ok: true,
      deletedAt: Math.floor(Date.now() / 1000),
      deletedSessions: result.deletedSessions,
      deletedMessages: result.deletedMessages,
      deletedVersions: result.deletedVersions,
      deletedAuthSessions: result.deletedAuthSessions,
      deletedOauthAccounts: result.deletedOauthAccounts,
      deletedAuthTokens: result.deletedAuthTokens,
      deletedRequestQuota: result.deletedRequestQuota,
      clearLocalStorage: ['sheet-llm:recovery'],
    },
    {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'clear-site-data': '"storage"',
      },
    },
  )
}
