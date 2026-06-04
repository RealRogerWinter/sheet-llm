/**
 * Canonical client-IP extraction for rate limiting — ONE source of truth shared
 * by authRateLimit, restoreRateLimit, and the expensive-route limiter (so the
 * trust model can't drift between them).
 *
 * Priority:
 *  1. `CF-Connecting-IP` — Cloudflare sets this to the real visitor IP, and a
 *     client cannot forge it PAST Cloudflare. Because this origin only accepts
 *     traffic from Cloudflare (firewall locked to CF ranges + Authenticated
 *     Origin Pulls), trusting it is safe AND hop-count-independent — the robust
 *     path in production. (If you ever run this app NOT behind Cloudflare, drop
 *     this branch; an attacker hitting the origin directly could spoof it.)
 *  2. `X-Forwarded-For`, pinned via `TRUSTED_PROXY_HOPS=N` — the Nth entry from
 *     the RIGHT (everything to its left is client-spoofable). Unset → leftmost
 *     (legacy/dev; spoofable). If N exceeds the XFF depth we do NOT trust the
 *     spoofable leftmost — we fall through (fail-closed) to (3) rather than
 *     handing an attacker a fresh per-IP bucket per forged value.
 *  3. `X-Real-IP`, else the `'local'` sentinel (dev / direct).
 *
 * IPv6 collapses to the /64 so an attacker can't rotate /128s to dodge per-IP
 * limits.
 */
export function extractClientIp(request: Request): string {
  // 1. Cloudflare's authoritative, unspoofable-past-CF single value.
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return normalizeIp(cf.trim())

  // 2. Hop-aware X-Forwarded-For.
  const hops = trustedProxyHops()
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length > 0) {
      if (hops <= 0) return normalizeIp(parts[0]) // unset → leftmost (spoofable)
      if (parts.length >= hops) return normalizeIp(parts[parts.length - hops])
      // hops > actual XFF depth: the leftmost is attacker-spoofable, so do NOT
      // trust it — fall through to a single shared bucket (fail-closed).
    }
  }

  // 3. x-real-ip, else a shared 'local' bucket.
  return normalizeIp(request.headers.get('x-real-ip') || 'local')
}

function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Collapse an IPv6 address to its /64 prefix; leave IPv4 untouched. */
export function normalizeIp(ip: string): string {
  if (ip.includes(':') && !ip.includes('.')) {
    const groups = ip.split(':')
    if (groups.length > 4) return groups.slice(0, 4).join(':') + '::/64'
  }
  return ip
}
