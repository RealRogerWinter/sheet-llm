import { NextResponse } from 'next/server'
import { getExistingRequestUser } from '@/lib/auth/session'
import { resolveGenerationTier } from '@/lib/orchestrator/generationTier'
import { peekDailyQuota } from '@/lib/orchestrator/dailyQuota'
import { isBillingSurfaceEnabled } from '@/lib/billing/surface'
import { getWallet } from '@/lib/billing/wallet'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/usage — the current request's remaining-allowance snapshot for the
 * header usage counter + the in-chat "uses left" note.
 *
 * READ-ONLY by design: never mints an identity (a brand-new visitor with no
 * cookie reads as a fresh anonymous allowance, keyed on IP exactly as /api/chat
 * keys it) and never writes a quota row.
 *
 * Response:
 *   - `daily`: present only when the hosted daily-quota layer is ON and this
 *     request is a COUNTED (non-Pro, non-bypass) class — {remaining, limit, used,
 *     resetsInHours}. null otherwise (self-host / Pro / untrusted-IP bypass).
 *   - `credits`: the authenticated user's spendable credit balance when the
 *     billing surface is enabled; null otherwise.
 * Self-hosted/local installs (quota off, billing off) get all-null, so the
 * counter renders nothing and the default app is visually unchanged.
 */
export async function GET(request: Request) {
  const user = (await getExistingRequestUser()) ?? { userId: '', authenticated: false }
  const tier = await resolveGenerationTier(user.userId || undefined)
  const peek = peekDailyQuota({ userId: user.userId, authenticated: user.authenticated }, tier, request)
  const credits =
    isBillingSurfaceEnabled() && user.authenticated ? getWallet(user.userId).available : null

  const daily =
    peek.enabled && 'remaining' in peek
      ? { remaining: peek.remaining, limit: peek.limit, used: peek.used, resetsInHours: peek.resetsInHours }
      : null

  // Only what the UI renders — the caller's OWN allowance. Instance-level
  // feature flags are intentionally NOT echoed back to an anonymous caller.
  return NextResponse.json(
    { authenticated: user.authenticated, tier, daily, credits },
    { headers: { 'cache-control': 'no-store' } },
  )
}
