/**
 * Client-side billing fetch helpers for the wallet UI (PR-12). Thin wrappers
 * over the same-origin billing API routes. Reads return `null` when the surface
 * is off (route 404) or the user isn't signed in (401) so the component can hide
 * itself. The checkout POST relies on the route's strict same-origin + JSON-only
 * guard (no CSRF token needed — a cross-site form can do neither).
 */

export interface WalletBalance {
  balance: number
  held: number
  available: number
}

export interface CreditPackView {
  id: string
  label: string
  priceUsdCents: number
  credits: number
  bonusCredits: number
}

export interface WalletTransactionView {
  id: string
  creditsDelta: number
  type: 'purchase' | 'generation' | 'edit' | 'refund' | 'adjustment'
  description: string
  amountMinorUsd: number | null
  createdAt: number
}

async function getJson<T>(path: string): Promise<T | null> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Current credit balance, or null when billing is off / not signed in. */
export function fetchWallet(): Promise<WalletBalance | null> {
  return getJson<WalletBalance>('/api/billing/wallet')
}

/** The purchasable pack catalog, or null when Stripe isn't configured. */
export async function fetchPacks(): Promise<CreditPackView[] | null> {
  const data = await getJson<{ packs: CreditPackView[] }>('/api/billing/packs')
  return data?.packs ?? null
}

/** Recent wallet activity (newest first); empty array when off / none. */
export async function fetchTransactions(): Promise<WalletTransactionView[]> {
  const data = await getJson<{ transactions: WalletTransactionView[] }>('/api/billing/transactions')
  return data?.transactions ?? []
}

export interface CheckoutResult {
  ok: boolean
  message?: string
}

/**
 * Start a Stripe Checkout session for `packId` and redirect the browser to the
 * hosted checkout URL on success. Returns `{ ok: false, message }` (without
 * navigating) on any error so the caller can surface it inline.
 */
export async function startCheckout(packId: string): Promise<CheckoutResult> {
  let res: Response
  try {
    res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ packId }),
    })
  } catch {
    return { ok: false, message: 'Network error — please try again.' }
  }
  if (!res.ok) {
    return { ok: false, message: await checkoutErrorMessage(res) }
  }
  let data: { url?: string }
  try {
    data = (await res.json()) as { url?: string }
  } catch {
    return { ok: false, message: 'Could not start checkout. Please try again.' }
  }
  if (!data.url) {
    return { ok: false, message: 'Could not start checkout. Please try again.' }
  }
  window.location.assign(data.url)
  return { ok: true }
}

async function checkoutErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body?.error === 'string' && body.error.length > 0) return body.error
  } catch {
    // fall through to a status-based default
  }
  if (res.status === 401) return 'Please sign in to buy credits.'
  if (res.status === 429) return 'Too many checkout attempts — please wait a moment and try again.'
  if (res.status === 404) return 'Purchasing is not available on this server.'
  return 'Could not start checkout. Please try again.'
}
