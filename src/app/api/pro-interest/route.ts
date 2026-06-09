import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isJsonRequest, isSameOriginStrict } from '@/lib/auth/httpGuards'
import { extractClientIp } from '@/lib/http/clientIp'
import { getEmailProvider } from '@/lib/auth/email'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/pro-interest — capture a Pro-waitlist email for the hosted demo.
 * Hosted-only convenience: emails the operator (SL_PRO_WAITLIST_NOTIFY) via the
 * existing Resend seam. When that env is unset (self-host / not configured) it
 * returns {code:'not_configured'} so the page falls back to a mailto: link — no
 * email, no rate-limit state touched. Same-origin + JSON guard it; no
 * account/CSRF needed (a public interest form), and same-origin-strict fails
 * closed against forged cross-site POSTs.
 */
const BodySchema = z.object({ email: z.string().email().max(254) })

// DEDICATED in-memory rate limit — deliberately NOT the shared transactional-email
// budget (emailRateLimit). A flood of this PUBLIC, unauthenticated endpoint must
// not starve password-reset / verification mail instance-wide. Per-IP sliding 1h
// + a global daily cap, both fail-closed; the global cap bounds total operator
// email per day regardless of IP/email rotation. In-memory is fine (an anti-spam
// brake, not a ledger); a redeploy reset just re-opens a small window.
const PER_IP_WINDOW_MS = 60 * 60 * 1000
const PER_IP_MAX = 5
const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000
const GLOBAL_MAX = 200
const MAX_IPS = 20_000

interface RateState {
  ip: Map<string, number[]>
  windowStart: number
  count: number
}
function rateState(): RateState {
  const g = globalThis as unknown as { __sl_pro_interest_rate?: RateState }
  if (!g.__sl_pro_interest_rate) {
    g.__sl_pro_interest_rate = { ip: new Map(), windowStart: Date.now(), count: 0 }
  }
  return g.__sl_pro_interest_rate
}
function rateOk(ip: string): boolean {
  const s = rateState()
  const now = Date.now()
  if (now - s.windowStart >= GLOBAL_WINDOW_MS) {
    s.windowStart = now
    s.count = 0
  }
  if (s.count >= GLOBAL_MAX) return false
  if (s.ip.size > MAX_IPS) return false // fail-closed against distinct-IP spray
  const hits = (s.ip.get(ip) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS)
  if (hits.length >= PER_IP_MAX) {
    s.ip.set(ip, hits)
    return false
  }
  hits.push(now)
  s.ip.set(ip, hits)
  s.count++
  return true
}

export async function POST(request: Request) {
  if (!isSameOriginStrict(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin requests are not allowed.' }, { status: 403 })
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ ok: false, error: 'Expected application/json.' }, { status: 415 })
  }

  const target = process.env.SL_PRO_WAITLIST_NOTIFY?.trim()
  if (!target) {
    // Not wired up here — the client uses its mailto: fallback. Return BEFORE
    // parsing/rate-limiting so the unconfigured path touches no state.
    return NextResponse.json(
      { ok: false, code: 'not_configured' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    )
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    raw = undefined
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 })
  }
  const email = parsed.data.email.trim().toLowerCase()
  const ip = extractClientIp(request)
  if (!rateOk(ip)) {
    return NextResponse.json(
      { ok: false, error: 'Too many requests right now — please try again later.' },
      { status: 429 },
    )
  }

  // zod bounds the email and the IP comes from CF/proxy, but strip control chars
  // defensively so nothing odd lands in the operator's plaintext email.
  const safe = (v: string) => v.replace(/[\r\n\t]+/g, ' ').slice(0, 320)
  try {
    await getEmailProvider().send({
      to: target,
      subject: 'sheet-llm — Pro waitlist signup',
      text: `New Pro-waitlist interest.\n\nemail: ${safe(email)}\nip: ${safe(ip)}\n`,
    })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Could not record your interest right now. Please try again.' },
      { status: 502 },
    )
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
