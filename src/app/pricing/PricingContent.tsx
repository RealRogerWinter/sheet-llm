'use client'

import Link from 'next/link'
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
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

// The page's conceptual spine: cost reads as loudness. Each pack (and each turn
// type in the cost ledger) carries a musical dynamic so "bigger" reads as
// "louder". Purely decorative notation, so always aria-hidden.
const PACK_DYNAMICS: Record<string, string> = {
  pack_5: 'p',
  pack_10: 'mf',
  pack_20: 'f',
  pack_50: 'ff',
}

type Status = 'idle' | 'submitting' | 'done' | 'error'

export default function PricingContent({
  packs,
  fontClass,
}: {
  packs: PricingPack[]
  /** CSS-variable class from the server page that exposes --font-fraunces. */
  fontClass?: string
}) {
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
        setMessage("You're on the list. We'll email you the moment paid credits go live.")
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
    <div className={`${styles.page} ${fontClass ?? ''}`}>
      {/* Full-bleed engraved staff lines wash the whole page, set in CSS as a
          fixed, faint backdrop so every section sits on "manuscript paper". */}
      <div className={styles.staffWash} aria-hidden="true" />

      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}>
          <ClefMark className={styles.brandClef} />
          <span>sheet-llm</span>
        </Link>
        <span className={styles.runhead} aria-hidden="true">
          Price List
        </span>
        <Link href="/" className={styles.back}>
          <span aria-hidden="true">←</span> Back to the editor
        </Link>
      </header>

      <main className={styles.main}>
        {/* Launch banner: billing isn't switched on yet, so be upfront. role="note"
            (not "status"): it's static page content, not a live region that should
            be announced on load. */}
        <div className={styles.banner} role="note">
          <span className={styles.bannerMark} aria-hidden="true">
            ✶
          </span>
          <span>
            <strong>Paid credits are launching soon.</strong>{' '}Prices below are final. Join the
            list and we&rsquo;ll email you the moment checkout opens.
          </span>
        </div>

        {/* ── Hero / title page ─────────────────────────────────────────────── */}
        <section className={styles.hero}>
          <p className={styles.eyebrow}>
            <span aria-hidden="true">✦</span> Pay-as-you-go &middot; No subscription{' '}
            <span aria-hidden="true">✦</span>
          </p>

          <HeroStave className={styles.heroStave} />

          <h1 className={styles.h1}>
            Compose more,
            <br />
            pay only for <em>what you use</em>
          </h1>

          <p className={styles.lede}>
            sheet-llm turns plain-language requests into real, editable sheet music with Claude. Try
            it free, then buy <strong>credits</strong>{' '}when you&rsquo;re ready for full-length
            pieces. Simple pay-as-you-go packs, no subscription. Credits never expire.
          </p>

          <div className={styles.heroActions}>
            <a href="#packs" className={styles.btnPrimary}>
              See credit packs
            </a>
            <a href="#how" className={styles.btnGhost}>
              How credits work
            </a>
          </div>
        </section>

        {/* ── Free vs Pro ───────────────────────────────────────────────────── */}
        <section className={styles.plans} aria-label="Plans">
          <SectionRule label="Free & Pro" />

          <div className={styles.planGrid}>
            <article className={styles.planCard}>
              <header className={styles.planHead}>
                <h3 className={styles.planName}>Free</h3>
                <p className={styles.planPrice}>
                  <span className={styles.planAmount}>$0</span>
                </p>
                <p className={styles.planTag}>Try it, no account needed</p>
              </header>
              <ul className={styles.featureList}>
                <li>Compose &amp; edit short pieces</li>
                <li>A limited number of requests every 24 hours</li>
                <li>One free full-length piece on a verified account</li>
                <li>Play back, and export MusicXML &amp; MIDI</li>
              </ul>
              <Link href="/" className={styles.planCta}>
                Open the editor
              </Link>
            </article>

            <article className={`${styles.planCard} ${styles.planFeatured}`}>
              <span className={styles.planBadge}>With credits</span>
              <header className={styles.planHead}>
                <h3 className={styles.planName}>Pro</h3>
                <p className={styles.planPrice}>
                  <span className={styles.planAmountSm}>Pay&nbsp;as&nbsp;you&nbsp;go</span>
                </p>
                <p className={styles.planTag}>Powered by the credits you buy below</p>
              </header>
              <ul className={`${styles.featureList} ${styles.featureListPro}`}>
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
            </article>
          </div>
        </section>

        {/* ── Credit packs (the crescendo) ──────────────────────────────────── */}
        <section id="packs" className={styles.packsSection}>
          <SectionRule label="Credit packs" />
          <p className={styles.sectionLede}>
            One-time purchase, no subscription. <strong>1 credit = 1¢ of value</strong>, so every
            dollar is 100 credits. Bigger packs add a bonus on top. Credits never expire.
          </p>

          <div className={styles.packs}>
            {packs.map((p, i) => {
              const pct = bonusPct(p)
              const isBest = p.id === bestValueId
              const isPopular = p.id === popularId
              return (
                <article
                  key={p.id}
                  className={`${styles.pack} ${isPopular ? styles.packPopular : ''}`}
                  style={{ '--i': i } as CSSProperties}
                >
                  <span className={styles.packDynamic} aria-hidden="true">
                    {PACK_DYNAMICS[p.id] ?? ''}
                  </span>

                  {isPopular && (
                    <span className={styles.seal}>
                      <span className={styles.sealInner}>Most popular</span>
                    </span>
                  )}
                  {isBest && !isPopular && <span className={styles.ribbon}>Best value</span>}

                  <h3 className={styles.packName}>{p.label}</h3>
                  <p className={styles.packPrice}>{usd(p.priceUsdCents)}</p>

                  <p className={styles.packCredits}>
                    {fmt(p.totalCredits)} <span className={styles.packCreditsUnit}>credits</span>
                  </p>
                  {p.bonusCredits > 0 ? (
                    <p className={styles.packBonus}>
                      {fmt(p.baseCredits)} + {fmt(p.bonusCredits)} bonus
                      <span className={styles.packBonusPct}>{pct}% extra</span>
                    </p>
                  ) : (
                    <p className={styles.packBonusMuted}>{fmt(p.baseCredits)} base credits</p>
                  )}

                  <Link href={PRO_HREF} className={styles.packCta}>
                    Notify me <span aria-hidden="true">→</span>
                  </Link>
                </article>
              )
            })}
          </div>

          {/* The crescendo hairpin spanning the four packs: the page's signature. */}
          <Hairpin className={styles.hairpin} />

          <p className={styles.fineprint}>
            Secure checkout via Stripe at launch. Prices in USD, tax added where applicable. Credits
            are a service entitlement. They never expire and have no cash value.
          </p>
        </section>

        {/* ── How credits are used ──────────────────────────────────────────── */}
        <section id="how" className={styles.how}>
          <SectionRule label="How credits are used" />
          <p className={styles.sectionLede}>
            Every request you send is one <strong>turn</strong>: sheet-llm reads your score and
            prompt, calls Claude, and writes the music back. You&rsquo;re charged in credits for the
            turns that change your score; reading, playback, and export are always free.
          </p>

          <div className={styles.howGrid}>
            <div className={styles.howCard}>
              <span className={styles.howNum} aria-hidden="true">
                i
              </span>
              <h3 className={styles.howTitle}>What a turn costs</h3>
              <p>
                Credits scale with the real work a turn does: how much music is in your score, how
                long your request is, how much Claude writes back, and which model runs it. Small
                edits cost little; composing a long piece from scratch costs more.
              </p>
            </div>
            <div className={styles.howCard}>
              <span className={styles.howNum} aria-hidden="true">
                ii
              </span>
              <h3 className={styles.howTitle}>Fair on edits</h3>
              <p>
                Generating brand-new music carries a higher rate than tweaking what&rsquo;s already
                there, so iterating (&ldquo;make bar 4 louder&rdquo;, &ldquo;swap that chord&rdquo;)
                stays cheap. You always see your balance update after each turn.
              </p>
            </div>
            <div className={styles.howCard}>
              <span className={styles.howNum} aria-hidden="true">
                iii
              </span>
              <h3 className={styles.howTitle}>Metered by the token</h3>
              <p>
                We meter the exact tokens each turn sends to and receives from Claude, then convert
                that to credits. No hidden minimums or subscriptions. When you stop composing, you
                stop spending.
              </p>
            </div>
          </div>

          {/* Cost ledger, read as a dynamics legend. The left gutter carries the
              dynamic marking the way it sits under a staff in a real score. */}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.tableCaption}>
                Typical turns as dynamics: softer costs less, louder does more
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={styles.colDyn}>
                    <span className={styles.srOnly}>Dynamic</span>
                  </th>
                  <th scope="col">Typical turn</th>
                  <th scope="col">About</th>
                  <th scope="col">What it does</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={styles.colDyn}>
                    <em aria-hidden="true">pp</em>
                  </td>
                  <td>Small edit</td>
                  <td className={styles.cellCost}>~5 credits</td>
                  <td>Change a note, dynamic, or chord in place</td>
                </tr>
                <tr>
                  <td className={styles.colDyn}>
                    <em aria-hidden="true">mf</em>
                  </td>
                  <td>Standard generation</td>
                  <td className={styles.cellCost}>~25 credits</td>
                  <td>Compose or extend a short passage</td>
                </tr>
                <tr>
                  <td className={styles.colDyn}>
                    <em aria-hidden="true">f</em>
                  </td>
                  <td>Full-length piece</td>
                  <td className={styles.cellCost}>~60 credits</td>
                  <td>A complete multi-section score</td>
                </tr>
                <tr>
                  <td className={styles.colDyn}>
                    <em aria-hidden="true">ff</em>
                  </td>
                  <td>Advanced Composer (Opus)</td>
                  <td className={styles.cellCost}>~150 credits</td>
                  <td>The most capable model, for ambitious pieces</td>
                </tr>
              </tbody>
            </table>
            <p className={styles.tableNote}>
              These are estimates, not fixed prices. You&rsquo;re billed for the actual tokens each
              turn uses. A $5 Starter pack covers 20+ standard generations or a handful of full
              pieces.
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

        {/* ── Waitlist ──────────────────────────────────────────────────────── */}
        <section className={styles.waitlist}>
          <div className={styles.waitlistInner}>
            <h2 className={styles.waitlistTitle}>Get notified at launch</h2>
            <p className={styles.waitlistLede}>
              Checkout isn&rsquo;t open yet. Leave your email and we&rsquo;ll let you know the moment
              you can buy credits. No spam, just the one heads-up.
            </p>
            {status === 'done' ? (
              <p className={styles.status} role="status">
                <span className={styles.statusMark} aria-hidden="true">
                  ✓
                </span>{' '}
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
          </div>
        </section>

        {/* ── FAQ ───────────────────────────────────────────────────────────── */}
        <section className={styles.faq}>
          <SectionRule label="Questions" />
          <div className={styles.faqList}>
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
                One credit is one cent of value, so a $5 pack is 500 credits. What a turn costs in
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
                Yes. The free tier stays available with a daily request limit and shorter
                generations. Credits buy no-limit, full-length composing whenever you want it.
              </p>
            </div>
          </div>
        </section>

        {/* ── Colophon: the closing barline ─────────────────────────────────── */}
        <footer className={styles.colophon}>
          <Coda className={styles.coda} />
          <p className={styles.colophonText}>
            <span className={styles.colophonBrand}>sheet-llm</span>
            <span className={styles.colophonDot} aria-hidden="true">
              ·
            </span>
            Engraved with Claude
          </p>
          <Link href="/" className={styles.back}>
            <span aria-hidden="true">←</span> Back to the editor
          </Link>
        </footer>
      </main>
    </div>
  )
}

/* ───────────────────────────────────────────────────────────────────────────
 * Decorative notation. All inline SVG so it inherits currentColor (themeable),
 * scales crisply, and needs no music font. Every piece is aria-hidden: it
 * carries no information the surrounding prose doesn't already state.
 * ──────────────────────────────────────────────────────────────────────── */

function svgProps(className?: string) {
  return { className, 'aria-hidden': true as const, focusable: false as const }
}

/** A small treble-clef flourish for the wordmark. */
function ClefMark({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 40" fill="none" {...svgProps(className)}>
      <path
        d="M12.5 2c-2 1.3-3.2 3.3-3.2 5.8 0 2 .9 3.6 2.3 5.4l.6.8c-3.4 1-5.7 3.3-5.7 6.7 0 3.2 2.5 5.6 5.8 5.6.6 0 1.2-.1 1.7-.2l.5 4.1c.2 1.9-.6 3-2.1 3-1 0-1.8-.5-2-1.3.9-.1 1.6-.8 1.6-1.8 0-1-.8-1.8-1.9-1.8-1.2 0-2.1 1-2.1 2.4 0 1.9 1.7 3.3 4 3.3 2.6 0 4.2-1.7 3.9-4.3l-.5-4.2c2-.7 3.3-2.4 3.3-4.6 0-2.3-1.6-4-3.9-4-.3 0-.6 0-.9.1l-.4-2.9c1.9-1.9 3.2-3.7 3.2-6.2C18.3 4.6 16 2 12.5 2Zm.3 2.1c1.4 0 2.3 1.2 2.3 3 0 1.7-1 3.2-2.4 4.6l-.3-2.3c-.3-2.2.1-4 .8-5.3Zm-.2 12.3.6 4.6c-1.9-.3-3-1.5-3-3.1 0-1.3.9-2.4 2.4-3.1Zm1.7 1c1.4.2 2.3 1.2 2.3 2.7 0 1.3-.8 2.4-2 2.9l-.6-4.8c.1-.5.2-.6.3-.8Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Hero "melody": a 5-line stave, a clef, and a rising phrase of note-heads. */
function HeroStave({ className }: { className?: string }): ReactNode {
  // Stave lines at y = 14,22,30,38,46. A gentle rising line of note-heads.
  const staveY = [14, 22, 30, 38, 46]
  const notes = [
    { x: 92, y: 42 },
    { x: 132, y: 38 },
    { x: 172, y: 34 },
    { x: 212, y: 30 },
    { x: 252, y: 26 },
    { x: 292, y: 22 },
    { x: 332, y: 18 },
  ]
  return (
    <svg viewBox="0 0 420 60" fill="none" {...svgProps(className)} preserveAspectRatio="xMidYMid meet">
      {staveY.map((y) => (
        <line
          key={y}
          x1="8"
          x2="412"
          y1={y}
          y2={y}
          stroke="currentColor"
          strokeWidth="1"
          className={styles.staveLine}
        />
      ))}
      {/* clef sitting on the stave */}
      <g className={styles.heroClef} transform="translate(14 8) scale(1.1)">
        <path
          d="M12.5 2c-2 1.3-3.2 3.3-3.2 5.8 0 2 .9 3.6 2.3 5.4l.6.8c-3.4 1-5.7 3.3-5.7 6.7 0 3.2 2.5 5.6 5.8 5.6.6 0 1.2-.1 1.7-.2l.5 4.1c.2 1.9-.6 3-2.1 3-1 0-1.8-.5-2-1.3.9-.1 1.6-.8 1.6-1.8 0-1-.8-1.8-1.9-1.8-1.2 0-2.1 1-2.1 2.4 0 1.9 1.7 3.3 4 3.3 2.6 0 4.2-1.7 3.9-4.3l-.5-4.2c2-.7 3.3-2.4 3.3-4.6 0-2.3-1.6-4-3.9-4-.3 0-.6 0-.9.1l-.4-2.9c1.9-1.9 3.2-3.7 3.2-6.2C18.3 4.6 16 2 12.5 2Zm.3 2.1c1.4 0 2.3 1.2 2.3 3 0 1.7-1 3.2-2.4 4.6l-.3-2.3c-.3-2.2.1-4 .8-5.3Zm-.2 12.3.6 4.6c-1.9-.3-3-1.5-3-3.1 0-1.3.9-2.4 2.4-3.1Zm1.7 1c1.4.2 2.3 1.2 2.3 2.7 0 1.3-.8 2.4-2 2.9l-.6-4.8c.1-.5.2-.6.3-.8Z"
          fill="currentColor"
        />
      </g>
      {notes.map((n, idx) => (
        <g key={n.x} className={styles.heroNote} style={{ '--n': idx } as CSSProperties}>
          {/* stem */}
          <line x1={n.x + 5.2} x2={n.x + 5.2} y1={n.y - 1} y2={n.y - 18} stroke="currentColor" strokeWidth="1.4" />
          {/* note-head (slightly rotated ellipse, engraver style) */}
          <ellipse cx={n.x} cy={n.y} rx="6" ry="4.3" fill="currentColor" transform={`rotate(-22 ${n.x} ${n.y})`} />
        </g>
      ))}
    </svg>
  )
}

/** Crescendo hairpin (<), opening to the right beneath the pack crescendo. */
function Hairpin({ className }: { className?: string }): ReactNode {
  return (
    <div className={className} aria-hidden="true">
      <svg viewBox="0 0 600 24" fill="none" preserveAspectRatio="none" className={styles.hairpinSvg}>
        <line x1="2" y1="12" x2="598" y2="2" stroke="currentColor" strokeWidth="1.4" />
        <line x1="2" y1="12" x2="598" y2="22" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <span className={styles.hairpinLabel}>cresc.</span>
    </div>
  )
}

/** A ruled section heading: a centered label cut into a single engraver's rule,
 *  flanked by tiny note-head ornaments. */
function SectionRule({ label }: { label: string }): ReactNode {
  return (
    <div className={styles.sectionRule}>
      <span className={styles.sectionRuleLine} aria-hidden="true" />
      <h2 className={styles.sectionTitle}>
        <span className={styles.sectionDot} aria-hidden="true" />
        {label}
        <span className={styles.sectionDot} aria-hidden="true" />
      </h2>
      <span className={styles.sectionRuleLine} aria-hidden="true" />
    </div>
  )
}

/** The closing flourish: a fermata over a final (thin + thick) barline. */
function Coda({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 64 40" fill="none" {...svgProps(className)}>
      {/* fermata: arc + dot */}
      <path d="M16 20a16 16 0 0 1 32 0" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="32" cy="17" r="2.2" fill="currentColor" />
      {/* final barline */}
      <line x1="40" y1="26" x2="40" y2="40" stroke="currentColor" strokeWidth="1.2" />
      <rect x="44" y="26" width="3.2" height="14" fill="currentColor" />
    </svg>
  )
}
