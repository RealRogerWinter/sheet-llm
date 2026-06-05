import { NextResponse } from 'next/server'
import { getExistingRequestUser } from '@/lib/auth/session'
import { isBillingSurfaceEnabled } from '@/lib/billing/surface'
import { getWallet } from '@/lib/billing/wallet'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/billing/wallet — the authenticated user's credit balance for the
 * wallet UI (PR-12). 404s when the billing surface is off so a self-hosted /
 * BYOK install shows nothing. Read-only: never mints a user (read-only identity)
 * and never creates a wallet row — a user with no wallet reads as 0/0/0. The
 * `held` figure is non-zero only while an in-flight generation has an active
 * hold; `available = balance - held` is the spendable figure.
 */
export async function GET() {
  if (!isBillingSurfaceEnabled()) {
    return NextResponse.json({ code: 'not_found', error: 'Billing is not enabled' }, { status: 404 })
  }
  const user = await getExistingRequestUser()
  if (!user || !user.authenticated) {
    return NextResponse.json({ code: 'unauthorized', error: 'Sign in to view your credits' }, { status: 401 })
  }
  const wallet = getWallet(user.userId)
  return NextResponse.json({
    balance: wallet.balance,
    held: wallet.held,
    available: wallet.available,
  })
}
