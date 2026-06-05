import crypto from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { requestQuota, users } from '@/lib/db/schema'
import { extractClientIp } from '@/lib/auth/clientIp'
import { isAccountsEnabled } from '@/lib/auth/account'
import { assessClientRisk, isCfRequest, logIpRisk, type RiskVerdict } from '@/lib/security/ipRisk'
import { networkPrefix } from '@/lib/security/ipMath'
import type { GenerationTier } from '@/lib/orchestrator/generationTier'

/**
 * Durable DAILY request-quota guard for the hosted sheetllm.com demo — the
 * authoritative per-request bound on Anthropic token spend. HOSTED-ONLY and OFF
 * BY DEFAULT: when SL_DAILY_QUOTA_ENABLED is unset the very first line returns
 * {ok:true} before any DB/IP work, so self-hosted/local installs are inert.
 *
 * Tiers (see resolveGenerationTier / users.tier+emailVerified):
 *   - Pro                       → bypass (no row written)
 *   - verified logged-in free   → counts against BOTH the per-DEVICE bucket
 *       'a:<hmac(ip)>' (the SAME bucket anon usage lands in) AND the per-ACCOUNT
 *       bucket 'u:<userId>', each at SL_DAILY_QUOTA_FREE (10); admitted only if
 *       BOTH allow. Because the device bucket is shared with the anon path, a
 *       device's anon + logged-in usage is ONE running total: 5 anon then login
 *       grants 5 more (10/device), NOT a fresh 10. The account bucket then caps
 *       the same user to 10/day even as they roam to new IPs.
 *   - anonymous OR unverified   → key 'a:<hmac(ip)>', limit SL_DAILY_QUOTA_ANON (5)
 *   - risky-IP + TRULY anon     → login_required (sign-in CTA), no row
 *
 * Counting is COUNT-ON-ADMISSION with NO refunds: the increment happens here,
 * before the LLM dispatch, and is never returned on a downstream failure
 * (refunds are an abuse oracle and race the open stream). The whole check is one
 * synchronous better-sqlite3 transaction: within the single Node process it runs
 * to completion without interleaving, and a guard-in-the-write UPDATE (WHERE
 * count < limit) prevents overshoot even across connections. FAILS OPEN on any
 * DB error.
 */

// ---------------------------------------------------------------------------
// Config — read FRESH on every call so an operator can retune without redeploy.
// ---------------------------------------------------------------------------
function envBool(name: string): boolean {
  const v = process.env[name]
  return v === '1' || v?.toLowerCase() === 'true'
}
function intEnv(name: string, def: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : def
}
function clampIntEnv(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n >= min && n <= max ? n : def
}

export function isDailyQuotaEnabled(): boolean {
  return envBool('SL_DAILY_QUOTA_ENABLED')
}
const anonLimit = (): number => intEnv('SL_DAILY_QUOTA_ANON', 5)
const freeLimit = (): number => intEnv('SL_DAILY_QUOTA_FREE', 10)
const windowSec = (): number => intEnv('SL_DAILY_QUOTA_WINDOW_SEC', 86400)
const v6Prefix = (): number => clampIntEnv('SL_DAILY_QUOTA_V6_PREFIX', 56, 1, 128)
const maxRows = (): number => intEnv('SL_DAILY_QUOTA_MAX_ROWS', 200_000)
const V4_PREFIX = 24 // matches auth_sessions.ip /24 truncation precedent
function anonGlobalLimit(): number | null {
  const raw = process.env.SL_DAILY_QUOTA_ANON_GLOBAL
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ---------------------------------------------------------------------------
// IP → pseudonymous quota key
// ---------------------------------------------------------------------------
/**
 * The raw client IP to key an anonymous bucket on, or null when the request's
 * IP can't be trusted (→ caller bypasses; never a shared 'a:local' bucket).
 * Hosted: trust cf-connecting-ip ONLY when isCfRequest(). Self-host: trust the
 * hop-aware extractClientIp ONLY when an explicit TRUSTED_PROXY_HOPS is set.
 */
function resolveQuotaIp(request: Request): string | null {
  if (isCfRequest(request)) {
    const cf = request.headers.get('cf-connecting-ip')
    if (cf) return cf.trim()
  }
  if (Number(process.env.TRUSTED_PROXY_HOPS) > 0) {
    const ip = extractClientIp(request)
    if (ip && ip !== 'local') return ip
  }
  return null
}

/** Network-prefix string ("1.2.3.0/24" / "2001:db8::/56") for a raw IP, or null. */
export function normalizeQuotaIp(rawIp: string): string | null {
  if (!rawIp || rawIp === 'local') return null
  return networkPrefix(rawIp, V4_PREFIX, v6Prefix())
}

/**
 * Pseudonymize the normalized network so no raw IP is stored at rest (SQLite is
 * replicated to R2). HMAC with SESSION_SECRET when present so a /24 isn't
 * trivially brute-forceable from a DB leak; falls back to a plain digest if the
 * secret is somehow unset (still hashed, just unkeyed).
 */
function hashIp(normalized: string): string {
  const secret = process.env.SESSION_SECRET
  // A functioning deployment always has SESSION_SECRET (session.ts hard-throws at
  // boot without a >=32-byte secret). If it is somehow absent, refuse to store an
  // unkeyed, brute-forceable IP hash — throw, so checkDailyQuota fails OPEN rather
  // than persisting weak PII.
  if (!secret) throw new Error('SESSION_SECRET required to key the quota IP hash')
  return crypto.createHmac('sha256', secret).update('quota-ip:' + normalized).digest('base64url').slice(0, 24)
}

function anonKeyForRequest(request: Request): string | null {
  const raw = resolveQuotaIp(request)
  const norm = raw ? normalizeQuotaIp(raw) : null
  return norm ? 'a:' + hashIp(norm) : null
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
export interface QuotaInput {
  user: { userId: string; authenticated: boolean }
  tier: GenerationTier
  request: Request
  risk: RiskVerdict
}

/** One durable counter the request must pass: a quota key, its per-window
 *  limit, and the userId stamped on the row (null = shared/anon-owned, e.g. the
 *  per-device 'a:' bucket and the '*' instance ceiling — kept null so a GDPR
 *  delete of one account never resets a bucket shared across users). */
export interface QuotaBucket {
  key: string
  limit: number
  userId: string | null
}

export type QuotaClass =
  | { kind: 'bypass'; reason: string }
  | { kind: 'needsSignIn' }
  // ALL buckets must allow for the request to be admitted; all increment together.
  | { kind: 'counted'; buckets: QuotaBucket[]; isAnon: boolean }

function isEmailVerified(db: ReturnType<typeof getDb>, userId: string): boolean {
  try {
    const row = db.select({ v: users.emailVerified }).from(users).where(eq(users.id, userId)).get()
    return !!row && row.v === 1
  } catch {
    return false // can't confirm verification → treat as unverified (anon tier)
  }
}

export function classifyQuota(input: QuotaInput, db = getDb()): QuotaClass {
  const { user, tier, request, risk } = input
  if (tier === 'pro') return { kind: 'bypass', reason: 'pro' }

  // login_required applies ONLY to the truly-unauthenticated (an already-logged-in
  // unverified user must not be told to "sign in"; they just share the anon bucket).
  if (!user.authenticated && risk.risky && isAccountsEnabled()) return { kind: 'needsSignIn' }

  // The per-DEVICE bucket (IP /24-or-/56, pseudonymized). Shared by the anon path
  // AND the verified-logged-in path so login can't reset a device's running total.
  const deviceKey = anonKeyForRequest(request)

  // Verified logged-in → enforce BOTH the per-device cap (so a device's anon +
  // logged-in usage stays one 10-total) AND a per-account cap (so the same user is
  // bounded to 10/day even across devices/IPs). Each at the free limit; admitted
  // only if both allow. If the device IP is untrusted (no key), the account bucket
  // still applies — a logged-in user is never wholly un-capped.
  if (user.authenticated && isEmailVerified(db, user.userId)) {
    const buckets: QuotaBucket[] = []
    if (deviceKey) buckets.push({ key: deviceKey, limit: freeLimit(), userId: null })
    buckets.push({ key: 'u:' + user.userId, limit: freeLimit(), userId: user.userId })
    return { kind: 'counted', buckets, isAnon: false }
  }

  // Everyone else is the ANON CLASS (anonymous, or logged-in-but-unverified — so a
  // farmed unverified account is worth no more than the anon path): one per-device
  // bucket at the lower anon limit. Same key as the verified device bucket above,
  // so the count carries across the login boundary.
  if (!deviceKey) return { kind: 'bypass', reason: 'untrusted_ip' } // fail-open to availability
  return { kind: 'counted', buckets: [{ key: deviceKey, limit: anonLimit(), userId: null }], isAnon: true }
}

// ---------------------------------------------------------------------------
// Atomic counter (fixed window anchored at first hit, guard-in-the-write)
// ---------------------------------------------------------------------------
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]
type Decision = { allow: boolean; windowStart: number; mode: 'insert' | 'reset' | 'incr' | 'deny' }

// Throttled approximate row count for the fail-OPEN admission cap (avoids a
// count(*) per request). Bounds disk/Litestream bloat from distinct-key spray.
let cachedRowCount = 0
let lastRowCountAt = 0
function refreshRowCountIfStale(db: ReturnType<typeof getDb>): void {
  const now = Date.now()
  if (lastRowCountAt !== 0 && now - lastRowCountAt < 60_000) return
  lastRowCountAt = now
  try {
    const r = db.select({ c: sql<number>`count(*)` }).from(requestQuota).get()
    cachedRowCount = r ? Number(r.c) : 0
  } catch {
    /* keep last-known */
  }
}

function evaluate(tx: Tx, key: string, limit: number, now: number, win: number): Decision {
  const row = tx.select().from(requestQuota).where(eq(requestQuota.quotaKey, key)).get()
  if (!row) return { allow: true, windowStart: now, mode: 'insert' }
  if (now >= row.windowStart + win) return { allow: true, windowStart: now, mode: 'reset' }
  if (row.count < limit) return { allow: true, windowStart: row.windowStart, mode: 'incr' }
  return { allow: false, windowStart: row.windowStart, mode: 'deny' }
}

function apply(tx: Tx, key: string, userId: string | null, d: Decision, limit: number, now: number): void {
  if (d.mode === 'insert') {
    if (cachedRowCount >= maxRows()) {
      // Admission cap: bound table bloat from distinct-key spray by admitting
      // WITHOUT inserting (fail-OPEN — availability over enforcement). Logged
      // (rate-limited) so an operator can react; SL_DAILY_QUOTA_ANON_GLOBAL is the
      // true aggregate backstop when this trips.
      logIpRisk('quota_admission_cap_failopen', { rows: cachedRowCount, cap: maxRows() }, true)
      return
    }
    tx.insert(requestQuota).values({ quotaKey: key, userId, windowStart: now, count: 1, updatedAt: now }).run()
    cachedRowCount++
  } else if (d.mode === 'reset') {
    tx.update(requestQuota)
      .set({ windowStart: now, count: 1, userId, updatedAt: now })
      .where(eq(requestQuota.quotaKey, key))
      .run()
  } else if (d.mode === 'incr') {
    // Guard-in-the-write: count can never exceed limit even across connections.
    tx.update(requestQuota)
      .set({ count: sql`${requestQuota.count} + 1`, updatedAt: now })
      .where(and(eq(requestQuota.quotaKey, key), lt(requestQuota.count, limit)))
      .run()
  }
}

// ---------------------------------------------------------------------------
// Result + public entry point
// ---------------------------------------------------------------------------
export type QuotaResult =
  | { ok: true }
  | {
      ok: false
      code: 'quota_exceeded' | 'login_required'
      httpStatus: number
      quotaClass: 'anon' | 'free' | 'global' | 'risk'
      reason: RiskVerdict['reason'] | 'limit'
      needsSignIn?: boolean
      retryAfterSec?: number
      resetsAt?: number
      resetsInHours?: number
    }

function resetInfo(windowStart: number, now: number): { retryAfterSec: number; resetsAt: number; resetsInHours: number } {
  // Coarsen to the minute so the response never hands an attacker a
  // to-the-second boundary for timing the window reset.
  const resetsAt = Math.ceil((windowStart + windowSec()) / 60) * 60
  const retryAfterSec = Math.max(60, resetsAt - now)
  // round (not ceil) so a fresh full window reads "about 24h", not 25h.
  return { retryAfterSec, resetsAt, resetsInHours: Math.max(1, Math.round(retryAfterSec / 3600)) }
}

/**
 * The gate. Call AFTER identity + tier are known and BEFORE any LLM dispatch.
 * Increments on admission; never refunds. Fails OPEN on any error.
 */
export function checkDailyQuota(input: QuotaInput): QuotaResult {
  if (!isDailyQuotaEnabled()) return { ok: true }
  try {
    const db = getDb()
    const cls = classifyQuota(input, db)
    if (cls.kind === 'bypass') return { ok: true }
    if (cls.kind === 'needsSignIn') {
      return { ok: false, code: 'login_required', httpStatus: 403, quotaClass: 'risk', reason: input.risk.reason, needsSignIn: true }
    }

    refreshRowCountIfStale(db)
    const now = Math.floor(Date.now() / 1000)
    const win = windowSec()

    // The full set of counters this request must pass, in order: the optional
    // instance-wide anon ceiling ('*', anon only) first, then the per-key buckets
    // from classifyQuota (per-device and/or per-account). Tagged isGlobal so a
    // ceiling reject is reported distinctly from a per-user cap.
    const buckets: Array<QuotaBucket & { isGlobal?: boolean }> = []
    const globalLimit = cls.isAnon ? anonGlobalLimit() : null
    if (globalLimit != null) buckets.push({ key: '*', limit: globalLimit, userId: null, isGlobal: true })
    buckets.push(...cls.buckets)

    // Evaluate ALL buckets first, then commit them ALL — only if every one allows
    // — so a reject on any bucket never burns a slot on another. The callback is
    // synchronous (no await): within this Node process it runs to completion before
    // any other request's, and the guard-in-the-write UPDATE prevents overshoot
    // even across connections.
    const outcome = db.transaction((tx): { ok: true } | { ok: false; which: 'global' | 'key'; windowStart: number } => {
      const pending: Array<{ b: (typeof buckets)[number]; d: Decision }> = []
      for (const b of buckets) {
        const d = evaluate(tx, b.key, b.limit, now, win)
        if (!d.allow) return { ok: false, which: b.isGlobal ? 'global' : 'key', windowStart: d.windowStart }
        pending.push({ b, d })
      }
      for (const { b, d } of pending) apply(tx, b.key, b.userId, d, b.limit, now)
      return { ok: true }
    })

    if (outcome.ok) return { ok: true }
    const info = resetInfo(outcome.windowStart, now)
    return {
      ok: false,
      code: 'quota_exceeded',
      httpStatus: 429,
      quotaClass: outcome.which === 'global' ? 'global' : cls.isAnon ? 'anon' : 'free',
      reason: 'limit',
      ...info,
    }
  } catch (e) {
    // FAIL OPEN — a quota bug must never take down chat. Rate-limited log.
    logIpRisk('quota_check_failed', { message: e instanceof Error ? e.message : String(e) }, true)
    return { ok: true }
  }
}

/** Convenience for the route: assess risk + check quota in one call. */
export function evaluateRequestQuota(user: QuotaInput['user'], tier: GenerationTier, request: Request): QuotaResult {
  if (!isDailyQuotaEnabled()) return { ok: true }
  return checkDailyQuota({ user, tier, request, risk: assessClientRisk(request) })
}

/** Test-only: reset the approximate-row-count cache. */
export function __resetQuotaStateForTesting(): void {
  cachedRowCount = 0
  lastRowCountAt = 0
}
