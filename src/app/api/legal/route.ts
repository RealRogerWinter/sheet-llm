import { NextResponse } from 'next/server'
import { isLegalEnabled } from '@/lib/legal/config'

/**
 * GET /api/legal — runtime config for the header menu's legal links.
 * Returns `{ enabled }` reflecting whether the SL_LEGAL_* operator details are
 * set (i.e. whether /terms and /privacy are live). Read at runtime because the
 * header is rendered in a statically-prerenderable tree — same pattern as
 * /api/turnstile (reading process.env at build would freeze the empty value).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    { enabled: isLegalEnabled() },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  )
}
