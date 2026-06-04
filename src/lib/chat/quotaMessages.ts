import { isAccountsEnabled } from '@/lib/auth/account'
import type { QuotaResult } from '@/lib/orchestrator/dailyQuota'
import type { ChatCta, ChatErrorCode } from '@/lib/shared/types'

/**
 * Single source of truth for the daily-quota limit-reached COPY + CTA. The server
 * builds both a plain `message` (shown by any client, incl. old bundles) and a
 * structured `cta` (rendered as a card/button by the chat UI in a later PR). All
 * CTAs degrade gracefully when accounts are disabled (no signup/login target).
 *
 * Routes (decisions): anon cap → "create a free account"; logged-in-free cap →
 * "join the Pro waitlist" (Pro has no checkout yet); risky-IP anon → "sign in to
 * continue"; instance-ceiling → generic "busy". Pro never reaches here (bypass).
 */

const SIGNUP_HREF = '/signup'
const PRO_HREF = '/pro'

export interface QuotaErrorBody {
  code: Extract<ChatErrorCode, 'quota_exceeded' | 'login_required'>
  httpStatus: number
  message: string
  cta?: ChatCta
}

type QuotaDenial = Extract<QuotaResult, { ok: false }>

export function quotaErrorBody(result: QuotaDenial): QuotaErrorBody {
  const accounts = isAccountsEnabled()
  const hrs = result.resetsInHours
  const resetLine = hrs ? ` Your free requests reset in about ${hrs}h.` : ''

  // C — risky-IP anonymous → must sign in (decision #2). No reset line (it's a
  // gate, not a spent quota). When accounts are off there's nowhere to sign in,
  // so this path can't be reached (classifyQuota falls back to the anon limit).
  if (result.code === 'login_required') {
    const cta: ChatCta = {
      kind: 'login',
      title: 'Please sign in to continue',
      body: "We couldn't verify this connection for anonymous use (it looks like a VPN, proxy, or shared host). Sign in or create a free account to keep going — it only takes a moment.",
      primaryLabel: 'Log in',
      primaryAction: 'openLogin',
      secondaryLabel: 'Create a free account',
      secondaryHref: SIGNUP_HREF,
    }
    return {
      code: 'login_required',
      httpStatus: 403,
      message: 'Please sign in to continue — this connection looks like a VPN, proxy, or shared host.',
      cta: accounts ? cta : undefined,
    }
  }

  // E — instance-wide ceiling: a generic "busy" message (don't reveal the cap).
  if (result.quotaClass === 'global') {
    return {
      code: 'quota_exceeded',
      httpStatus: 429,
      message: 'The demo is unusually busy right now. Please try again in a little while, or sign in for your own request allowance.',
      cta: accounts
        ? {
            kind: 'busy',
            title: 'The demo is busy right now',
            body: "We've hit the overall request limit for anonymous users at the moment. Please try again shortly, or sign in for your own allowance.",
            primaryLabel: 'Log in',
            primaryAction: 'openLogin',
          }
        : undefined,
    }
  }

  // B — logged-in free cap → Pro waitlist.
  if (result.quotaClass === 'free') {
    return {
      code: 'quota_exceeded',
      httpStatus: 429,
      message: `You've reached today's request limit. Pro removes the limit — it's coming soon: ${PRO_HREF}.${resetLine}`,
      cta: {
        kind: 'waitlist',
        title: "You've reached today's request limit",
        body: "Free accounts get a limited number of requests every 24 hours. Pro removes the limit — it's coming soon. Join the waitlist and we'll let you know the moment it's ready.",
        primaryLabel: 'Join the Pro waitlist',
        primaryHref: PRO_HREF,
        resetsInHours: hrs,
      },
    }
  }

  // A — anonymous cap → create a free account. D (accounts off) → message only.
  if (accounts) {
    return {
      code: 'quota_exceeded',
      httpStatus: 429,
      message: `You've used your free requests for today. Create a free account to get more: ${SIGNUP_HREF}.${resetLine}`,
      cta: {
        kind: 'signup',
        title: "You've used your free requests for today",
        body: 'Anonymous demos get a few requests every 24 hours. Create a free account to get more — your current work in this browser carries over.',
        primaryLabel: 'Create a free account',
        primaryHref: SIGNUP_HREF,
        secondaryLabel: 'Log in',
        secondaryAction: 'openLogin',
        resetsInHours: hrs,
      },
    }
  }
  return {
    code: 'quota_exceeded',
    httpStatus: 429,
    message: `You've used your free requests for now.${resetLine}`,
  }
}
