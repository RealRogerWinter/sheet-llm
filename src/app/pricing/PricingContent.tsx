'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import styles from './Pricing.module.css'

/** Plain, serializable projection of a CreditPack (see src/lib/billing/packs.ts),
 *  passed down from the server page so prices/credits stay a single source of truth. */
export interface PricingPack {
  id: string
  label: string
  priceUsdCents: number
  baseCredits: number
  bonusCredits: number
  totalCredits: number
}

// Waitlist email capture reuses the live /api/pro-interest endpoint (same as
// /pro). When the instance hasn't configured SL_PRO_WAITLIST_NOTIFY the API
// returns code:'not_configured' and we fall back to a mailto, exactly like the
// existing Pro waitlist page.
const FALLBACK_MAILTO =
  'mailto:hello@sheetllm.com?subject=sheet-llm%20credits%20waitlist&body=Please%20let%20me%20know%20when%20paid%20credits%20launch.'

const PRO_HREF = '/pro'

function usd(cents: number): string {
  // Whole-dollar packs render as "$5", not "$5.00"; anything with cents keeps them.
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

function fmt(n: number): string {
  return n.toLocaleString()
}

function bonusPct(pack: PricingPack): number {
  return pack.baseCredits > 0 ? Math.round((pack.bonusCredits / pack.baseCredits) * 100) : 0
}

type Status = 'idle' | 'submitting' | 'done' | 'error'

export default function PricingContent({ packs }: { packs: PricingPack[] }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

  // The pack with the most bonus is the headline "best value"; the $20 tier is the
  // conventional "most popular" anchor. Derive both rather than hard-coding IDs.
  const bestValueId = packs.reduce(
    (best, p) => (bonusPct(p) > bonusPct(best) ? p : best),
    packs[0],
  )?.id
  const popularId = 'pack_20'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (status === 'submitting') return
    setStatus('submitting')
    setMessage('')
    try {
      const res = await fetch('/api/pro-interest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        code?: string
        error?: string
      }
      if (data.ok) {
        setStatus('done')
        setMessage("You're on the list — we'll email you the moment paid credits go live.")
        return
      }
      if (data.code === 'not_configured') {
        window.location.href = FALLBACK_MAILTO
        setStatus('idle')
        return
      }
      setStatus('error')
      setMessage(data.error ?? 'Something went wrong. Please try again.')
    } catch {
      setStatus('error')
      setMessage('Network error. Please try again.')
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}>
          sheet-llm
        </Link>
        <span className={styles.crumb}>Pricing</span>
        <Link href="/" className={styles.back}>
          ← Back to the editor
        </Link>
      </header>

      <main className={styles.main}>
        {/* Launch banner — billing isn't switched on yet, so be upfront. role="note"
            (not "status"): it's static page content, not a live region that should
            be announced on load. */}
        <div className={styles.banner} role="note">
          <span className={styles.bannerDot} aria-hidden="true" />
          <span>
            <strong>Paid credits are launching soon.</strong> Prices below are final — join the list
            and we&rsquo;ll email you the moment checkout opens.
          </span>
        </div>

        {/* Hero */}
        <section className={styles.hero}>
          <h1 className={styles.h1}>Compose more, pay only for what you use</h1>
          <p className={styles.lede}>
            sheet-llm turns plain-language requests into real, editable sheet music with Claude. Try
            it free, then buy <strong>credits</strong> when you&rsquo;re ready for full-length pieces —
            simple pay-as-you-go packs, no subscription, and credits never expire.
          </p>
          <div className={styles.heroActions}>
            <a href="#packs" className={styles.primaryBtn}>
              See credit packs
            </a>
            <a href="#how" className={styles.ghostBtn}>
              How credits work
            </a>
          </div>
        </section>

        {/* Free vs Pro */}
        <section className={styles.plans} aria-label="Plans">
          <div className={styles.planCard}>
            <h2 className={styles.planName}>Free</h2>
            <p className={styles.planPrice}>
              <span className={styles.planAmount}>$0</span>
            </p>
            <p className={styles.planTag}>Try it, no account needed</p>
            <ul className={styles.featureList}>
              <li>Compose &amp; edit short pieces</li>
              <li>A limited number of requests every 24 hours</li>
              <li>One free full-length piece on a verified account</li>
              <li>Play back, and export MusicXML &amp; MIDI</li>
            </ul>
            <Link href="/" className={styles.planCta}>
              Open the editor
            </Link>
          </div>

          <div className={`${styles.planCard} ${styles.planFeatured}`}>
            <span className={styles.planBadge}>With credits</span>
            <h2 className={styles.planName}>Pro</h2>
            <p className={styles.planPrice}>
              <span className={styles.planAmount}>Pay&nbsp;as&nbsp;you&nbsp;go</span>
            </p>
            <p className={styles.planTag}>Powered by the credits you buy below</p>
            <ul className={styles.featureList}>
              <li>
                <strong>No daily request limit</strong>
              </li>
              <li>Full-length, multi-section generations</li>
              <li>Advanced Composer with the most capable Claude (Opus) models</li>
              <li>You&rsquo;re only charged for the work you actually run</li>
            </ul>
            <a href="#packs" className={`${styles.planCta} ${styles.planCtaPrimary}`}>
              Choose a credit pack
            </a>
          </div>
        </section>

        {/* Credit packs */}
        <section id="packs" className={styles.packsSection}>
          <h2 className={styles.sectionTitle}>Credit packs</h2>
          <p className={styles.sectionLede}>
            One-time purchase, no subscription. <strong>1 credit = 1¢ of value</strong>, so every
            dollar is 100 credits — bigger packs add a bonus on top. Credits never expire.
          </p>

          <div className={styles.packs}>
            {packs.map((p) => {
              const pct = bonusPct(p)
              const isBest = p.id === bestValueId
              const isPopular = p.id === popularId
              return (
                <div
                  key={p.id}
                  className={`${styles.pack} ${isPopular ? styles.packPopular : ''}`}
                >
                  {isPopular && <span className={styles.packFlag}>Most popular</span>}
                  {isBest && !isPopular && (
                    <span className={`${styles.packFlag} ${styles.packFlagBest}`}>Best value</span>
                  )}
                  <h3 className={styles.packName}>{p.label}</h3>
                  <p className={styles.packPrice}>{usd(p.priceUsdCents)}</p>
                  <p className={styles.packCredits}>
                    {fmt(p.totalCredits)} <span className={styles.packCreditsUnit}>credits</span>
                  </p>
                  {p.bonusCredits > 0 ? (
                    <p className={styles.packBonus}>
                      {fmt(p.baseCredits)} + {fmt(p.bonusCredits)} bonus ({pct}% extra)
                    </p>
                  ) : (
                    <p className={styles.packBonusMuted}>{fmt(p.baseCredits)} base credits</p>
                  )}
                  <Link href={PRO_HREF} className={styles.packCta}>
                    Notify me →
                  </Link>
                </div>
              )
            })}
          </div>
          <p className={styles.fineprint}>
            Secure checkout via Stripe at launch. Prices in USD, tax added where applicable. Credits
            are a service entitlement — they never expire and have no cash value.
          </p>
        </section>

        {/* How credits are used */}
        <section id="how" className={styles.how}>
          <h2 className={styles.sectionTitle}>How credits are used</h2>
          <p className={styles.sectionLede}>
            Every request you send is one <strong>turn</strong> — sheet-llm reads your score and
            prompt, calls Claude, and writes the music back. You&rsquo;re charged in credits for the
            turns that change your score; reading, playback, and export are always free.
          </p>

          <div className={styles.howGrid}>
            <div className={styles.howCard}>
              <h3 className={styles.howTitle}>What a turn costs</h3>
              <p>
                Credits scale with the real work a turn does — how much music is in your score, how
                long your request is, how much Claude writes back, and which model runs it. Small
                edits cost little; composing a long piece from scratch costs more.
              </p>
            </div>
            <div className={styles.howCard}>
              <h3 className={styles.howTitle}>Fair on edits</h3>
              <p>
                Generating brand-new music carries a higher rate than tweaking what&rsquo;s already
                there, so iterating — &ldquo;make bar 4 louder&rdquo;, &ldquo;swap that chord&rdquo;
                — stays cheap. You always see your balance update after each turn.
              </p>
            </div>
            <div className={styles.howCard}>
              <h3 className={styles.howTitle}>Transparent metering</h3>
              <p>
                We meter the exact tokens each turn sends to and receives from Claude, then convert
                that to credits. No hidden minimums or subscriptions — when you stop composing, you
                stop spending.
              </p>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Typical turn</th>
                  <th>About</th>
                  <th>What it does</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Small edit</td>
                  <td>~5 credits</td>
                  <td>Change a note, dynamic, or chord in place</td>
                </tr>
                <tr>
                  <td>Standard generation</td>
                  <td>~25 credits</td>
                  <td>Compose or extend a short passage</td>
                </tr>
                <tr>
                  <td>Full-length piece</td>
                  <td>~60 credits</td>
                  <td>A complete multi-section score</td>
                </tr>
                <tr>
                  <td>Advanced Composer (Opus)</td>
                  <td>~150 credits</td>
                  <td>The most capable model, for ambitious pieces</td>
                </tr>
              </tbody>
            </table>
            <p className={styles.tableNote}>
              Estimates, not fixed prices — you&rsquo;re billed for the actual tokens each turn uses.
              A $5 Starter pack covers roughly 20+ standard generations or a handful of full pieces.
            </p>
          </div>

          <p className={styles.balanceNote}>
            Signed in? Your live credit balance and recent activity always show in{' '}
            <Link href="/settings" className={styles.inlineLink}>
              Settings → Credits
            </Link>
            , and your remaining balance appears right in the app while you compose.
          </p>
        </section>

        {/* Waitlist */}
        <section className={styles.waitlist}>
          <h2 className={styles.sectionTitle}>Get notified at launch</h2>
          <p className={styles.sectionLede}>
            Checkout isn&rsquo;t open yet. Leave your email and we&rsquo;ll let you know the moment
            you can buy credits — no spam, just the one heads-up.
          </p>
          {status === 'done' ? (
            <p className={styles.status} role="status">
              {message}
            </p>
          ) : (
            <form className={styles.form} onSubmit={onSubmit}>
              {/* Visible-to-AT label (visually hidden), matching /pro's labelled
                  field. A placeholder is not an accessible label. */}
              <label className={styles.srOnly} htmlFor="pricing-waitlist-email">
                Email address
              </label>
              <input
                id="pricing-waitlist-email"
                className={styles.input}
                type="email"
                name="email"
                placeholder="you@example.com"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className={styles.formBtn} type="submit" disabled={status === 'submitting'}>
                {status === 'submitting' ? 'Joining…' : 'Notify me'}
              </button>
            </form>
          )}
          {status === 'error' && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
        </section>

        {/* FAQ */}
        <section className={styles.faq}>
          <h2 className={styles.sectionTitle}>Questions</h2>
          <div className={styles.faqItem}>
            <h3 className={styles.faqQ}>Is this a subscription?</h3>
            <p className={styles.faqA}>
              No. You buy credits once and spend them as you compose. There&rsquo;s no recurring
              charge and nothing to cancel.
            </p>
          </div>
          <div className={styles.faqItem}>
            <h3 className={styles.faqQ}>Do credits expire?</h3>
            <p className={styles.faqA}>
              No. Credits stay in your balance until you use them. They&rsquo;re a service
              entitlement and have no cash value.
            </p>
          </div>
          <div className={styles.faqItem}>
            <h3 className={styles.faqQ}>What&rsquo;s one credit?</h3>
            <p className={styles.faqA}>
              One credit is one cent of value — so a $5 pack is 500 credits. What a turn costs in
              credits depends on the work it does (see{' '}
              <a href="#how" className={styles.inlineLink}>
                how credits are used
              </a>
              ).
            </p>
          </div>
          <div className={styles.faqItem}>
            <h3 className={styles.faqQ}>Can I keep using sheet-llm for free?</h3>
            <p className={styles.faqA}>
              Yes. The free tier stays available with a daily request limit and shorter generations.
              Credits unlock no-limit, full-length composing when you want it.
            </p>
          </div>
        </section>

        <footer className={styles.footer}>
          <Link href="/" className={styles.back}>
            ← Back to the editor
          </Link>
        </footer>
      </main>
    </div>
  )
}
