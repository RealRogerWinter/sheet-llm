/**
 * Product / paywall tier for score generation — distinct from and ORTHOGONAL
 * to the provider model-size `Tier` (small | medium | large) in
 * `src/lib/providers/*`. This gates SCOPE and per-request ceilings, not model
 * quality: both tiers DEFAULT to the medium (Sonnet 4.6) model. (PR-8 Advanced
 * Composer is the one exception — a Pro PAID turn with the Advanced toggle on
 * routes its heavy compositional call to Opus via `resolveModelClass`; see
 * `isAdvancedComposerEnabled` below and `providers/modelClass.ts`. The free tier
 * is always Sonnet.)
 *
 * - `free` (default): a fresh from-scratch generation is served by ONE bounded
 *   `render_score` call (`runGenerateBounded`) — at most 4 bars of grand staff,
 *   a tight `max_tokens` ceiling as the kill-switch, no multi-section planner
 *   loop.
 * - `pro` (gated off behind the paywall, for now): the existing sectional /
 *   whole-score pipeline, unchanged.
 *
 * The seam for the eventual paywall is `resolveGenerationTier()`: today it
 * reads an env flag (+ an operator force-free override); later you swap ONLY
 * its body to read a per-user entitlement, and no call site changes.
 */

import type { TierPolicy } from './types'
import { isFlagEnabled } from '@/lib/env/flag'

export type GenerationTier = 'free' | 'pro'

export interface GenerationPolicy {
  tier: GenerationTier
  /** Hard per-request output ceiling (max_tokens) for a bounded emit. */
  maxOutputTokens: number
  /** Max bars (measures) a single bounded call may emit. On a grand staff
   *  both staves share these bars (bar-aligned), so this is the total bar
   *  count, not per-staff. */
  maxBars: number
  /** May this tier use the multi-section sectional planner loop? */
  allowSectional: boolean
  /** May this tier emit a whole / long-form score (generateComplex / compose
   *  regen)? */
  allowWholeScore: boolean
}

/**
 * The free-tier per-request output ceiling — the primary kill-switch for the
 * bounded handler.
 *
 * Deliberately named so it does NOT match the drift guard regex in
 * `tests/unit/orchestrator/tokenBudget.test.ts` (`/const (SECTION_)?MAX_TOKENS/`,
 * which pins the whole-score emitters at >= 8000). The bounded handler emits at
 * most 4 bars, so it sits FAR below that floor on purpose; a genuinely dense
 * 4-bar pretty-printed emit that overflows 2600 throws the already-handled
 * `OutputTruncatedError` (clean 422), which is the intended cut-off — never a
 * runaway. Do NOT add the bounded handler to `RENDER_SCORE_EMITTERS`.
 */
export const BOUNDED_EMIT_CEILING = 2_600
/** At most 4 bars (measures) per bounded generation. */
export const BOUNDED_MAX_BARS = 4

const POLICY: Record<GenerationTier, GenerationPolicy> = {
  free: {
    tier: 'free',
    maxOutputTokens: BOUNDED_EMIT_CEILING,
    maxBars: BOUNDED_MAX_BARS,
    allowSectional: false,
    allowWholeScore: false,
  },
  pro: {
    tier: 'pro',
    maxOutputTokens: 8_000,
    maxBars: 64,
    allowSectional: true,
    allowWholeScore: true,
  },
}

export function policyFor(tier: GenerationTier): GenerationPolicy {
  return POLICY[tier]
}

/**
 * SHE-8 — map the resolved product tier to the kernel's injected `TierPolicy`.
 * This is the SaaS adapter: the orchestrator no longer imports `policyFor`;
 * `route.ts` calls this and injects the result. Fail-closed by construction —
 * an unresolved request resolves to `free` (see `resolveGenerationTier`), which
 * yields the capped, bounded policy. `free` routes fresh generation through the
 * bounded handler (`useBoundedFallback`); `pro` runs the full pipeline.
 */
export function toTierPolicy(tier: GenerationTier): TierPolicy {
  const p = POLICY[tier]
  return {
    allowSectional: p.allowSectional,
    allowWholeScore: p.allowWholeScore,
    maxBars: p.maxBars,
    emitCeiling: p.maxOutputTokens,
    useBoundedFallback: p.tier === 'free',
  }
}

/**
 * Instance-wide tier default, read fresh every call (mirrors `flags.ts`) so a
 * flip takes effect on the next request without redeploy. Default `free` —
 * the paywall is CLOSED by default; `SL_GENERATION_TIER=pro` opens whole-score
 * generation for everyone.
 */
export function getGenerationTier(): GenerationTier {
  return process.env.SL_GENERATION_TIER?.toLowerCase() === 'pro' ? 'pro' : 'free'
}

/**
 * Operator kill switch: when set, forces `free` for the whole instance
 * regardless of `SL_GENERATION_TIER` or any per-user entitlement — instantly
 * stops all pro (sectional / whole-score, multi-call) generation. Read fresh;
 * no redeploy.
 */
export function isForceFreeTier(): boolean {
  return isFlagEnabled('SL_FORCE_FREE_TIER')
}

/**
 * Is per-user paywall entitlement resolution active? When `SL_ENTITLEMENTS_DB`
 * is set, `resolveGenerationTier` reads `users.tier` so a `pro` entitlement with
 * a VERIFIED email upgrades to pro; unset → the instance-wide `SL_GENERATION_TIER`
 * default applies to everyone (current behavior). Read fresh; no redeploy.
 */
export function isEntitlementsDbEnabled(): boolean {
  return isFlagEnabled('SL_ENTITLEMENTS_DB')
}

/**
 * Is "Advanced Composer Mode" (Opus routing) enabled for this instance?
 * (PR-8) When `SL_ADVANCED_COMPOSER` is set, an authenticated Pro user's
 * per-request Advanced toggle is honored — the heavy single-pass
 * compositional calls (generateComplex / compose / regenerate_all / standalone
 * extend) route to the Opus (`large`) tier and are debited cost-plus on the
 * (higher) Opus metered cost. DARK by default: the toggle is a client field
 * that only ever RAISES the user's own spend (no free-unlock), but it is
 * forced OFF for the free tier + the free piece and gated behind this flag so
 * the feature stays dark until launch. Read fresh; no redeploy. Off → the
 * toggle is ignored and every turn stays on Sonnet.
 */
export function isAdvancedComposerEnabled(): boolean {
  return isFlagEnabled('SL_ADVANCED_COMPOSER')
}

/**
 * Is the per-request debug tier override (`debug.generationTier`) allowed to
 * take effect? It is a CLIENT-SUPPLIED field (parsed from the chat POST body),
 * so honoring it in production would be a paywall bypass: any caller could send
 * `debug.generationTier='pro'` and unlock whole-score generation for free.
 *
 * Default-DENY: honored only in an explicitly trusted dev/test context, or when
 * an operator opts in via `SL_ALLOW_TIER_OVERRIDE`. We deliberately do NOT use
 * `NODE_ENV !== 'production'` — that fails OPEN: an entrypoint that leaves
 * NODE_ENV unset (bare `node`, a stripped-env process manager) or an unusual
 * `NODE_ENV=staging` would silently re-open the bypass. (`next dev` sets
 * 'development', vitest sets 'test', `next build`/`next start` set 'production'.)
 * Mirrors the debug panel's own enable gate, which trusts only 'development'
 * (see env-flags.md). Read fresh; no redeploy. This is the paywall's client-trust
 * boundary — do NOT loosen it to a not-equal-production check.
 */
export function isTierOverrideAllowed(): boolean {
  const env = process.env.NODE_ENV
  if (env === 'development' || env === 'test') return true
  // Any other context (production, staging, unset) requires an explicit opt-in.
  // Kept strict (1/true only) — a security-sensitive override should not widen
  // to the looser isFlagEnabled truthy set.
  const v = process.env.SL_ALLOW_TIER_OVERRIDE
  return v === '1' || v?.toLowerCase() === 'true'
}

// Warn at most once per process if a production deployment is honoring the
// client override (i.e. SL_ALLOW_TIER_OVERRIDE is set under NODE_ENV=production).
// Turns an invisible misconfiguration into a visible one in prod telemetry.
let warnedTierOverrideInProd = false
function warnTierOverrideHonoredInProd(): void {
  if (warnedTierOverrideInProd) return
  warnedTierOverrideInProd = true
  console.warn(
    '[generationTier] SL_ALLOW_TIER_OVERRIDE is honoring a CLIENT-supplied ' +
      "generationTier override in production — callers can self-select the 'pro' " +
      'tier. Unset SL_ALLOW_TIER_OVERRIDE on any internet-reachable deployment.',
  )
}

/**
 * SHE-8 — is a client-supplied BYOK API key (`debug.apiKey`) allowed to be
 * honored for this request? The chat route plumbs `debug.apiKey` into the
 * provider as `apiKeyOverride`. Honoring it UNCONDITIONALLY on the shared hosted
 * demo is a key-laundering / billing-evasion primitive (a caller routes traffic
 * through our infra on someone else's key, or sidesteps our metering), so it is
 * default-DENY, fail-closed — exactly like `isTierOverrideAllowed`.
 *
 * Honored only in dev/test, or when an operator running their OWN single-tenant
 * instance (OSS / desktop / self-host) opts in via `SL_BYOK_ALLOWED`. We
 * deliberately do NOT use `NODE_ENV !== 'production'` (it fails OPEN on an unset
 * or `staging` NODE_ENV). There is no edition primitive in the codebase yet, so
 * this explicit opt-in IS the OSS/desktop signal; the hosted demo leaves it
 * unset and BYOK stays off. Read fresh; no redeploy. Also gates the sibling
 * `debug.modelOverride` (same client-trust boundary).
 */
export function isByokKeyAccepted(): boolean {
  const env = process.env.NODE_ENV
  if (env === 'development' || env === 'test') return true
  // Any other context (production, staging, unset) requires an explicit opt-in.
  // Kept strict (1/true only) — a security-sensitive override should not widen
  // to the looser isFlagEnabled truthy set.
  const v = process.env.SL_BYOK_ALLOWED
  return v === '1' || v?.toLowerCase() === 'true'
}

// Warn at most once per process if a production deployment is honoring a
// CLIENT-supplied BYOK key (SL_BYOK_ALLOWED set under NODE_ENV=production) — fine
// for a single-tenant self-host/desktop box, dangerous on the shared demo.
let warnedByokHonoredInProd = false
export function warnByokHonoredInProd(): void {
  if (warnedByokHonoredInProd) return
  warnedByokHonoredInProd = true
  console.warn(
    '[generationTier] SL_BYOK_ALLOWED is honoring a CLIENT-supplied BYOK API key ' +
      'in production — only enable this on a single-tenant self-hosted/desktop ' +
      'instance, never on the shared hosted demo.',
  )
}

/**
 * Resolve the product tier for a request. Precedence (highest first):
 *   1. operator force-free kill switch (`SL_FORCE_FREE_TIER`) → always free
 *   2. per-request debug override (the debug panel's paywall toggle) — ONLY
 *      honored when `isTierOverrideAllowed()` (non-production, or the explicit
 *      `SL_ALLOW_TIER_OVERRIDE` opt-in); IGNORED in production otherwise
 *   3. instance-wide default (`SL_GENERATION_TIER`): a `pro` default opens
 *      whole-score generation for EVERYONE and wins before any DB read
 *   4. per-user ENTITLEMENT (behind `SL_ENTITLEMENTS_DB`): an UPGRADE-only read —
 *      a user with `users.tier='pro'` AND `email_verified=1` is upgraded to pro;
 *      everyone else stays on the base. **Pro requires a verified email.**
 *   5. else the base default (free)
 *
 * The entitlement read is upgrade-only by design — it never downgrades below the
 * instance default — so turning on `SL_ENTITLEMENTS_DB` makes pro a per-user
 * grant without disturbing an existing `SL_GENERATION_TIER=pro` deployment. A
 * missing row / DB error falls back to the base (fail-safe to availability; the
 * bounded free handler is always correct).
 *
 * SECURITY: `override` arrives from the CLIENT (`DebugOverridesSchema` in the
 * chat route parses it off the request body). Honoring it unconditionally would
 * let any caller POST `debug.generationTier='pro'` and bypass the paywall — so
 * it is gated behind `isTierOverrideAllowed()` and sits below the operator
 * force-free kill switch. Call sites pass the RESOLVED value into
 * `OrchestratorInput`, never the userId, so the orchestrator stays DB-agnostic.
 */
export async function resolveGenerationTier(
  userId?: string,
  override?: GenerationTier,
): Promise<GenerationTier> {
  if (isForceFreeTier()) return 'free'
  if (override && isTierOverrideAllowed()) {
    if (process.env.NODE_ENV === 'production') warnTierOverrideHonoredInProd()
    return override
  }
  const base = getGenerationTier()
  // A 'pro' base opens generation for everyone; the entitlement only UPGRADES,
  // so skip the DB read when the base is already pro, there's no user, or the
  // entitlement DB is off.
  if (base === 'pro' || !userId || !isEntitlementsDbEnabled()) return base
  try {
    const { getDb } = await import('@/lib/db')
    const { users } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const row = await getDb()
      .select({ tier: users.tier, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .get()
    // Pro is granted only to a 'pro' entitlement WITH a verified email.
    if (row && row.tier === 'pro' && row.emailVerified === 1) return 'pro'
    return base
  } catch {
    return base
  }
}
