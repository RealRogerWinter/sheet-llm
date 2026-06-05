import { NextResponse } from 'next/server'
import { getExistingRequestUser } from '@/lib/auth/session'
import { isBillingSurfaceEnabled } from '@/lib/billing/surface'
import { DEFAULT_TRANSACTIONS_LIMIT, listRecentTransactions } from '@/lib/billing/transactions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/billing/transactions — recent wallet activity (purchases + credits
 * spent on generations/edits + refunds) for the authenticated user, newest
 * first (PR-12). Same gating + read-only identity as the wallet route. This is a
 * recent-activity feed, not a full export — the complete financial record is the
 * GDPR export (PR-14).
 */
export async function GET() {
  if (!isBillingSurfaceEnabled()) {
    return NextResponse.json({ code: 'not_found', error: 'Billing is not enabled' }, { status: 404 })
  }
  const user = await getExistingRequestUser()
  if (!user || !user.authenticated) {
    return NextResponse.json({ code: 'unauthorized', error: 'Sign in to view your activity' }, { status: 401 })
  }
  const transactions = listRecentTransactions(user.userId, DEFAULT_TRANSACTIONS_LIMIT)
  return NextResponse.json({ transactions })
}
