import crypto from 'node:crypto'
import fs from 'node:fs'
import { cidrContains } from '@/lib/security/ipMath'

/**
 * IP-reputation verdict for the hosted abuse-gating layer (sibling of
 * turnstile.ts). PURE + header-only + FAIL-OPEN: it reads request headers and an
 * operator-supplied ASN denylist and returns a {risky, reason} verdict — it does
 * NO gating itself (the daily-quota guard consumes the verdict) and never throws
 * out (any ambiguity resolves to "not risky").
 *
 * HOSTED-ONLY: every signal is gated behind `isCfRequest()` — we only trust
 * cf-* / the injected ASN header when the request PROVABLY transited our
 * Cloudflare zone. Off-CF (self-host / direct) the verdict is always "clear", so
 * self-hosters who never set SL_IP_RISK_ENABLED are wholly unaffected.
 *
 * Free-tier signals:
 *  - TOR: Cloudflare sets `cf-ipcountry: T1` for Tor traffic (no config needed).
 *  - VPN/datacenter: a Cloudflare Transform Rule SETs `x-sl-client-asn` to
 *    `ip.geoip.asnum`; we match it against a version-controlled denylist.
 */

export type RiskReason =
  | 'disabled' // SL_IP_RISK_ENABLED off
  | 'off_cf' // request did not provably transit our CF zone → cannot assess
  | 'allow_cidr'
  | 'allow_asn'
  | 'deny_cidr'
  | 'tor'
  | 'datacenter_asn'
  | 'clear'

export interface RiskVerdict {
  risky: boolean
  reason: RiskReason
  asn?: number
  country?: string
}

function envBool(name: string): boolean {
  const v = process.env[name]
  return v === '1' || v?.toLowerCase() === 'true'
}

export function isIpRiskEnabled(): boolean {
  return envBool('SL_IP_RISK_ENABLED')
}
function isTorSignalEnabled(): boolean {
  return envBool('SL_IP_RISK_TOR')
}
function isAsnSignalEnabled(): boolean {
  return envBool('SL_IP_RISK_ASN')
}
function asnHeaderName(): string {
  return (process.env.SL_IP_RISK_TRUSTED_ASN_HEADER || 'x-sl-client-asn').toLowerCase()
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/**
 * True iff the request PROVABLY transited our Cloudflare zone, so cf-* and the
 * injected ASN header can be trusted. Requires cf-connecting-ip + cf-ray; when
 * SL_EDGE_AUTH_SECRET is set (hosted), ALSO requires the edge-auth header that
 * the CF Transform Rule SETs — an independent control beyond the CF-IP firewall
 * (closes the "direct-to-origin / CF forwards to a second origin forges
 * cf-connecting-ip" gaps). Used by BOTH this module and the daily-quota IP key.
 *
 * WITHOUT SL_EDGE_AUTH_SECRET this falls back to cf-connecting-ip + cf-ray
 * presence — both client-settable off-CF — so it is trustworthy ONLY behind the
 * hosted origin lock (origin firewalled to Cloudflare IP ranges + Authenticated
 * Origin Pulls/mTLS). Self-hosters without that lock must leave SL_IP_RISK_ENABLED
 * off (the default); set SL_EDGE_AUTH_SECRET to make the check independent of the
 * firewall.
 */
export function isCfRequest(request: Request): boolean {
  const h = request.headers
  if (!h.get('cf-connecting-ip') || !h.get('cf-ray')) return false
  const secret = process.env.SL_EDGE_AUTH_SECRET
  if (secret) {
    const got = h.get('x-sl-edge-auth')
    if (!got || !safeEqual(got, secret)) return false
  }
  return true
}

/**
 * Parse the CF-injected ASN header to a positive integer, or null. Defends the
 * Transform-Rule ADD-vs-SET footgun: an appended/duplicated header arrives
 * comma- or space-joined; ANY non-pure-integer input → null (treated as
 * "unknown", which is NOT risky), never silently `parts[0]`.
 */
export function parseAsnHeader(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const s = raw.trim()
  if (!/^\d{1,10}$/.test(s)) return null
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n <= 4_294_967_295 ? n : null // 32-bit ASN max
}

function csvParts(name: string): string[] {
  const v = process.env[name]
  if (!v) return []
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}
function csvNumSet(name: string): Set<number> {
  const out = new Set<number>()
  for (const part of csvParts(name)) {
    const n = Number(part)
    if (Number.isInteger(n) && n > 0) out.add(n) // ignore malformed entries individually
  }
  return out
}

// --- ASN denylist file (mtime-cached; last-good retained on a parse/IO error) ---
let cached: { path: string; mtimeMs: number; deny: Set<number> } | null = null

function loadDenylistFile(): Set<number> {
  const p = process.env.SL_IP_RISK_ASN_LIST_PATH || 'config/ip-risk-asns.json'
  try {
    const stat = fs.statSync(p)
    if (cached && cached.path === p && cached.mtimeMs === stat.mtimeMs) return cached.deny
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { denyAsns?: unknown }
    const deny = new Set<number>()
    if (Array.isArray(parsed.denyAsns)) {
      for (const a of parsed.denyAsns) {
        const n = Number(a)
        if (Number.isInteger(n) && n > 0) deny.add(n)
      }
    }
    cached = { path: p, mtimeMs: stat.mtimeMs, deny }
    return deny
  } catch (e) {
    // Force-the-fail-open oracle defense: keep the last good list rather than
    // dropping to empty on a transient read/parse error; only empty on cold start.
    if (cached && cached.path === p) return cached.deny
    logIpRisk('denylist_load_failed', { path: p, message: e instanceof Error ? e.message : String(e) }, true)
    return new Set()
  }
}

function denyAsns(): Set<number> {
  const deny = new Set(loadDenylistFile())
  for (const n of csvNumSet('SL_IP_RISK_EXTRA_DENY_ASNS')) deny.add(n)
  return deny
}

function matchAnyCidr(ip: string, name: string): boolean {
  for (const c of csvParts(name)) {
    try {
      if (cidrContains(c, ip)) return true
    } catch {
      /* malformed CIDR entry — ignore */
    }
  }
  return false
}

/**
 * Classify a request. Precedence: master-off → off-CF → allow-CIDR → deny-CIDR
 * → TOR → (allow-ASN → deny-ASN) → clear. Allow always beats deny. Header trust
 * is gated behind isCfRequest(); off-CF returns "clear" (never downgrades risk).
 */
export function assessClientRisk(request: Request): RiskVerdict {
  if (!isIpRiskEnabled()) return { risky: false, reason: 'disabled' }
  if (!isCfRequest(request)) return { risky: false, reason: 'off_cf' }

  const ip = (request.headers.get('cf-connecting-ip') || '').trim()
  const country = request.headers.get('cf-ipcountry') || undefined

  if (ip && matchAnyCidr(ip, 'SL_IP_RISK_ALLOW_CIDRS')) return { risky: false, reason: 'allow_cidr', country }
  if (ip && matchAnyCidr(ip, 'SL_IP_RISK_DENY_CIDRS')) return { risky: true, reason: 'deny_cidr', country }

  if (isTorSignalEnabled() && country === 'T1') return { risky: true, reason: 'tor', country }

  if (isAsnSignalEnabled()) {
    const asn = parseAsnHeader(request.headers.get(asnHeaderName()))
    if (asn != null) {
      if (csvNumSet('SL_IP_RISK_ALLOW_ASNS').has(asn)) return { risky: false, reason: 'allow_asn', asn, country }
      if (denyAsns().has(asn)) return { risky: true, reason: 'datacenter_asn', asn, country }
      return { risky: false, reason: 'clear', asn, country }
    }
  }
  return { risky: false, reason: 'clear', country }
}

// --- logging (PII-safe) ---
let lastWarnMs = 0

/**
 * Per-request risk logging is gated behind SL_IP_RISK_DEBUG so a TOR/datacenter
 * spray can't flood the logs (mirrors SL_TURNSTILE_DEBUG). `always`-mode
 * warnings (e.g. the denylist failing to load) are rate-limited to 1/30s. Never
 * logs a full IP.
 */
export function logIpRisk(event: string, detail: Record<string, unknown>, always = false): void {
  if (always) {
    const now = Date.now()
    if (now - lastWarnMs < 30_000) return
    lastWarnMs = now
    console.warn(`[ip-risk] ${event}`, JSON.stringify(detail))
    return
  }
  if (process.env.SL_IP_RISK_DEBUG === '1') console.warn(`[ip-risk] ${event}`, JSON.stringify(detail))
}

/** Test-only: drop the denylist-file cache so a fresh file is re-read. */
export function __resetIpRiskCacheForTesting(): void {
  cached = null
  lastWarnMs = 0
}
