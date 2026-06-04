import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isJsonRequest, isSameOriginStrict } from '@/lib/auth/httpGuards'
import { extractClientIp } from '@/lib/auth/clientIp'
import { checkEmailSend } from '@/lib/auth/emailRateLimit'
import { getEmailProvider } from '@/lib/auth/email'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/pro-interest — capture a Pro-waitlist email for the hosted demo.
 * Hosted-only convenience: emails the operator (SL_PRO_WAITLIST_NOTIFY) via the
 * existing Resend seam. When that env is unset (self-host / not configured) it
 * returns {code:'not_configured'} so the page falls back to a mailto: link — no
 * email, no rate-limit state touched. Same-origin + JSON + per-IP/email send
 * budget guard it; no account/CSRF needed (it's a public interest form).
 */
const BodySchema = z.object({ email: z.string().email().max(254) })

export async function POST(request: Request) {
  if (!isSameOriginStrict(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin requests are not allowed.' }, { status: 403 })
  }
  if (!isJsonRequest(request)) {
    return NextResponse.json({ ok: false, error: 'Expected application/json.' }, { status: 415 })
  }

  const target = process.env.SL_PRO_WAITLIST_NOTIFY?.trim()
  if (!target) {
    // Not wired up here — client uses its mailto: fallback.
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
  // Reuse the transactional-email budget (per-destination / per-IP / global) to
  // throttle abuse of this endpoint.
  if (!checkEmailSend({ email, ip }).ok) {
    return NextResponse.json(
      { ok: false, error: 'Too many requests right now — please try again later.' },
      { status: 429 },
    )
  }

  try {
    await getEmailProvider().send({
      to: target,
      subject: 'sheet-llm — Pro waitlist signup',
      text: `New Pro-waitlist interest.\n\nemail: ${email}\nip: ${ip}\n`,
    })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Could not record your interest right now. Please try again.' },
      { status: 502 },
    )
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
}
