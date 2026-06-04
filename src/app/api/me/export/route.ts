import { NextResponse } from 'next/server'
import { getExistingRequestUser } from '@/lib/auth/session'
import { getDb } from '@/lib/db'
import { buildUserExport } from '@/lib/gdpr/exportUser'
import { checkSameOrigin, errorResponse } from '@/app/api/chat/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/me/export — GDPR Art. 15 / 20 right-of-access endpoint.
 * Same-origin gated. No rate-limit: same-origin + cookie-scoped means
 * low abuse surface, and the cost of a single export is bounded by
 * the user's own data volume.
 *
 * Response: full JSON dump of the current user's data with a
 * `Content-Disposition: attachment; filename="sheet-llm-export-
 * YYYYMMDD.json"` header (date — not userId — to keep PII out of the
 * browser's downloads list). `Cache-Control: no-store` so a malicious
 * proxy or future CDN doesn't cache the dump.
 */
export async function GET(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res

  // Use the get-only variant: never mint a phantom account on this
  // endpoint. A cookie-less caller would otherwise download an empty
  // export of a just-minted user and conclude they have no data, when
  // their real account may be intact but unreachable from this browser.
  const session = await getExistingRequestUser()
  if (!session) {
    return errorResponse('invalid_request', 401, 'No active session')
  }
  const db = getDb()
  const payload = await buildUserExport(db, session.userId)

  if (!payload) {
    // The row vanished between the cookie check and the export build
    // (e.g., concurrent /me/delete). Treat as a clean 404 so the client
    // doesn't see a phantom empty dump.
    return errorResponse('chat_not_found', 404, 'Account not found')
  }

  const today = new Date()
  const datePart =
    today.getUTCFullYear().toString() +
    String(today.getUTCMonth() + 1).padStart(2, '0') +
    String(today.getUTCDate()).padStart(2, '0')
  const filename = `sheet-llm-export-${datePart}.json`

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}
