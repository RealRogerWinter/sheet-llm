import { NextResponse } from 'next/server'
import { isAccountsEnabled } from '@/lib/auth/account'
import {
  isJsonRequest,
  isSameOriginStrict,
  verifyCsrf,
} from '@/lib/auth/httpGuards'

export function authError(code: string, status: number, error: string): NextResponse {
  return NextResponse.json({ code, error }, { status })
}

/** 429 with a Retry-After header. */
export function rateLimited(retryAfterSec?: number): NextResponse {
  return NextResponse.json(
    { code: 'rate_limited', error: 'Too many attempts. Please wait and try again.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec ?? 300) } },
  )
}

/** A length-capped User-Agent for the auth_sessions audit row (or null). */
export function clientUserAgent(request: Request): string | null {
  const ua = request.headers.get('user-agent')
  return ua ? ua.slice(0, 256) : null
}

/**
 * The common FRONT GATE for every mutating auth route. In order:
 *   - 404 when accounts are disabled (don't reveal the surface area).
 *   - 403 cross-origin (fail-closed strict same-origin — stricter than the
 *     legacy `checkSameOrigin`).
 *   - 415 non-JSON body (blocks the simple cross-site `<form>` CSRF vector).
 *   - 403 missing/invalid CSRF double-submit token.
 * Returns the rejection response, or null when all checks pass.
 *
 * A guard test (`tests/unit/auth/authRouteGuard.test.ts`) asserts every mutating
 * handler under `src/app/api/auth/**` calls this, so a new route can't ship
 * without the gate.
 */
export async function guardAuthMutation(
  request: Request,
): Promise<NextResponse | null> {
  if (!isAccountsEnabled()) return authError('not_found', 404, 'Not found')
  if (!isSameOriginStrict(request)) {
    return authError('invalid_request', 403, 'Cross-origin requests are not allowed')
  }
  if (!isJsonRequest(request)) {
    return authError('invalid_request', 415, 'Expected application/json')
  }
  if (!(await verifyCsrf(request))) {
    return authError('invalid_request', 403, 'Invalid or missing CSRF token')
  }
  return null
}

const MAX_BODY_BYTES = 4 * 1024

/** Read + JSON-parse a small request body, or return a 400/413 response. */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, res: authError('invalid_request', 413, 'Request body too large') }
  }
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return { ok: false, res: authError('invalid_request', 400, 'Could not read request body') }
  }
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, res: authError('invalid_request', 413, 'Request body too large') }
  }
  try {
    return { ok: true, body: JSON.parse(raw) }
  } catch {
    return { ok: false, res: authError('invalid_request', 400, 'Invalid JSON body') }
  }
}
