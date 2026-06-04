import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  isTurnstileEnabled,
  verifyTurnstileToken,
  issueClearance,
} from '@/lib/security/turnstile'
import { checkRequestIp, extractClientIp } from '@/lib/orchestrator/requestRateLimit'

/**
 * POST /api/turnstile — verify a Cloudflare Turnstile token and, on success,
 * set the short-lived IP-bound clearance cookie that the LLM-cost routes require.
 * No-op (200) when Turnstile is not configured.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ token: z.string().min(1).max(4096) })

export async function POST(request: Request) {
  if (!isTurnstileEnabled()) {
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 })
  }
  const ip = extractClientIp(request)
  if (!checkRequestIp(ip).ok) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 })
  }
  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await request.json())
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  }
  if (!(await verifyTurnstileToken(body.token, ip))) {
    return NextResponse.json({ ok: false, error: 'challenge_failed' }, { status: 403 })
  }
  await issueClearance(request)
  return NextResponse.json({ ok: true }, { status: 200 })
}
