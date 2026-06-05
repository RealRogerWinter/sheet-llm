'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '@/lib/auth/authStore'
import {
  fetchPacks,
  fetchTransactions,
  fetchWallet,
  startCheckout,
  type CreditPackView,
  type WalletBalance,
  type WalletTransactionView,
} from '@/lib/billing/billingClient'
import styles from './WalletSettings.module.css'

type LoadState = 'loading' | 'hidden' | 'ready'

/** Credits → "$X.XX" (1 credit = 1¢). The HYBRID display: credits headline, USD hint. */
function usd(credits: number): string {
  return `$${(credits / 100).toFixed(2)}`
}

function fmt(credits: number): string {
  return credits.toLocaleString()
}

/**
 * Wallet / Credits settings section (PR-12). HYBRID display: a credit balance
 * with an "≈ $X" hint, the credit-pack purchase flow (Stripe Checkout), and a
 * recent-activity feed. Self-gates: renders nothing unless the user is signed in
 * AND the billing surface is on (the wallet fetch 404s otherwise). Auto-refill is
 * a later PR (locked decision 10: opt-in, no subscription).
 */
export default function WalletSettings() {
  const status = useAuthStore((s) => s.status)
  const emailVerified = useAuthStore((s) => s.emailVerified)

  const [state, setState] = useState<LoadState>('loading')
  const [wallet, setWallet] = useState<WalletBalance | null>(null)
  const [packs, setPacks] = useState<CreditPackView[] | null>(null)
  const [transactions, setTransactions] = useState<WalletTransactionView[]>([])
  const [buyBusy, setBuyBusy] = useState<string | null>(null)
  const [buyError, setBuyError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const refreshWallet = useCallback(() => {
    void fetchWallet().then((w) => {
      if (w) setWallet(w)
    })
  }, [])

  // Load the wallet once the session is authed. Uses the codebase's effect-fetch
  // convention (`void fetch().then(setState)`, as in AccountSettings) so the
  // state updates land in async callbacks rather than synchronously in the
  // effect body. Only an authed session can have a wallet; the render gate
  // returns null for every other status.
  useEffect(() => {
    if (status !== 'authed') return
    void fetchWallet().then((w) => {
      if (!w) {
        // 404 (billing surface off) or 401 — nothing to show.
        setState('hidden')
        return
      }
      setWallet(w)
      setState('ready')
      void fetchPacks().then(setPacks)
      void fetchTransactions().then(setTransactions)
      // Surface a Stripe Checkout return (the route redirects to
      // /settings?checkout=success|cancel), then strip the param so a refresh
      // doesn't replay it — client-only, post-fetch. Granted credits arrive via
      // the webhook, so the balance may update a moment later; Refresh re-pulls.
      if (typeof window === 'undefined') return
      const params = new URLSearchParams(window.location.search)
      const c = params.get('checkout')
      if (c === 'success') {
        setNotice({ ok: true, text: 'Payment received — your credits will appear here shortly.' })
      } else if (c === 'cancel') {
        setNotice({ ok: false, text: 'Checkout canceled — no charge was made.' })
      }
      if (c) {
        params.delete('checkout')
        const qs = params.toString()
        window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
      }
    })
  }, [status])

  if (status !== 'authed' || state === 'hidden') return null
  if (state === 'loading' || !wallet) {
    return (
      <section className={styles.section} aria-busy="true">
        <h2 className={styles.heading}>Credits</h2>
        <p className={styles.muted}>Loading…</p>
      </section>
    )
  }

  const onBuy = async (packId: string) => {
    if (buyBusy) return
    setBuyBusy(packId)
    setBuyError(null)
    const res = await startCheckout(packId)
    // On success the browser navigates to Stripe; if we're still here it failed.
    if (!res.ok) {
      setBuyError(res.message ?? 'Could not start checkout. Please try again.')
      setBuyBusy(null)
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>Credits</h2>

      {notice && (
        <p className={notice.ok ? styles.noticeOk : styles.noticeWarn} role="status">
          {notice.text}
        </p>
      )}

      {/* Balance — HYBRID: credits headline + USD hint. */}
      <div className={styles.balanceCard}>
        <div className={styles.balanceMain}>
          <span className={styles.balanceCredits}>{fmt(wallet.balance)} credits</span>
          <span className={styles.balanceUsd}>≈ {usd(wallet.balance)}</span>
        </div>
        {wallet.held > 0 && (
          <p className={styles.muted}>
            {fmt(wallet.available)} available now · {fmt(wallet.held)} reserved for an in-flight generation
          </p>
        )}
        <button type="button" className={styles.linkButton} onClick={() => void refreshWallet()}>
          Refresh
        </button>
      </div>

      {/* Buy — hidden when Stripe isn't configured (packs === null). */}
      {packs && packs.length > 0 && (
        <div className={styles.buyBlock}>
          <h3 className={styles.subheading}>Add credits</h3>
          {!emailVerified && (
            <p className={styles.muted}>Verify your email to purchase credits.</p>
          )}
          {buyError && (
            <p className={styles.error} role="alert">
              {buyError}
            </p>
          )}
          <div className={styles.packs}>
            {packs.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.pack}
                disabled={!emailVerified || buyBusy !== null}
                onClick={() => void onBuy(p.id)}
              >
                <span className={styles.packLabel}>{p.label}</span>
                <span className={styles.packPrice}>{usd(p.priceUsdCents)}</span>
                <span className={styles.packCredits}>
                  {fmt(p.credits)} credits
                  {p.bonusCredits > 0 && <span className={styles.packBonus}> +{fmt(p.bonusCredits)} bonus</span>}
                </span>
                {buyBusy === p.id && <span className={styles.packBusy}>Starting…</span>}
              </button>
            ))}
          </div>
          <p className={styles.fineprint}>
            Secure checkout via Stripe. Credits never expire and have no cash value.
          </p>
        </div>
      )}

      {/* Recent activity. */}
      <div className={styles.historyBlock}>
        <h3 className={styles.subheading}>Recent activity</h3>
        {transactions.length === 0 ? (
          <p className={styles.muted}>No activity yet.</p>
        ) : (
          <ul className={styles.history}>
            {transactions.map((t) => (
              <li key={t.id} className={styles.historyRow}>
                <div className={styles.historyLeft}>
                  <span className={styles.historyDesc}>{t.description}</span>
                  <span className={styles.historyDate}>
                    {new Date(t.createdAt * 1000).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                    {t.amountMinorUsd != null && <> · {usd(t.amountMinorUsd)}</>}
                  </span>
                </div>
                <span className={t.creditsDelta >= 0 ? styles.deltaPos : styles.deltaNeg}>
                  {t.creditsDelta >= 0 ? '+' : '−'}
                  {fmt(Math.abs(t.creditsDelta))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
