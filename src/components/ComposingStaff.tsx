'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/chat/state'
import styles from './ComposingStaff.module.css'

interface ComposingStaffProps {
  className?: string
  /**
   * 'hero' renders the full breathing staff + shimmer + under-glow on a
   * 720×160 viewBox (mirrors BlankStaff). 'overlay' renders only the
   * shimmer band + under-glow as an absolutely-positioned layer to sit
   * on top of an existing dimmed score on the editing surface.
   */
  variant?: 'hero' | 'overlay'
}

/**
 * Composing-phase visual. See ComposingStaff.module.css for the three
 * compositor-only loops that drive it (staff-breathe, shimmer-drift,
 * under-glow). Structure mirrors BlankStaff so the spatial substrate
 * stays consistent between empty / waiting / arrived states. Renders
 * a rotating flavor caption below/under the staff so the wait reads as
 * "working" rather than "stalled" — interval is phase-locked to the
 * 2400ms staff-breathe loop so the caption swap doesn't fight the
 * visual rhythm.
 */
const FLAVOR_PHRASES = [
  'Working on your score…',
  'Composing your melody…',
  'Inking the staff…',
  'Tuning the harmony…',
  'Finding the right notes…',
]
const PHRASE_INTERVAL_MS = 2400

export default function ComposingStaff({ className, variant = 'hero' }: ComposingStaffProps) {
  const reduceMotion = useChatStore((s) => s.reduceMotion)
  const streamProgress = useChatStore((s) => s.streamProgress)
  const [phraseIdx, setPhraseIdx] = useState(0)

  useEffect(() => {
    if (reduceMotion) return
    const interval = window.setInterval(() => {
      setPhraseIdx((i) => (i + 1) % FLAVOR_PHRASES.length)
    }, PHRASE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [reduceMotion])

  // During a sectional stream show concrete progress ("section 4 of 9")
  // so a slow multi-minute generation reads as advancing, not stalled.
  // totalSections can lag the live index (adaptive splits), so floor it.
  const caption = streamProgress
    ? `Composing section ${streamProgress.sectionIndex + 1} of ${Math.max(
        streamProgress.totalSections,
        streamProgress.sectionIndex + 1,
      )}${streamProgress.label ? ` · ${streamProgress.label}` : ''}…`
    : FLAVOR_PHRASES[phraseIdx]

  const rootClass = [styles.root, variant === 'overlay' ? styles.overlay : '', className]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      <svg
        className={`${styles.svg} ${variant === 'overlay' ? styles.svgOverlay : ''}`}
        viewBox="0 0 720 160"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Composing your score"
        preserveAspectRatio={variant === 'overlay' ? 'none' : 'xMidYMid meet'}
      >
        {/* Drifting shimmer band: a wide soft-edged column that translates
         * across the staff. Coprime period vs breathe so they don't lock. */}
        <rect
          className={styles.shimmer}
          x="0"
          y="40"
          width="140"
          height="90"
          rx="6"
        />

        {variant === 'hero' && (
          <>
            {[55, 70, 85, 100, 115].map((y, i) => (
              <line
                key={y}
                className={styles.line}
                x1="40"
                y1={y}
                x2="700"
                y2={y}
                style={{ animationDelay: `${i * 40}ms` }}
              />
            ))}
            <text className={styles.clef} x="50" y="118" fontSize="80">
              𝄞
            </text>
            <text className={styles.timesig} x="120" y="89" fontSize="26" fontWeight="700">
              4
            </text>
            <text className={styles.timesig} x="120" y="115" fontSize="26" fontWeight="700">
              4
            </text>
            <line className={styles.barline} x1="700" y1="55" x2="700" y2="115" />
          </>
        )}

        {/* Hairline blue under-glow beneath the bottom staff line. Phase-
         * locked to the breathe loop (same 2400ms period, same easing). */}
        <rect
          className={styles.glow}
          x="40"
          y="117"
          width="660"
          height="2"
          rx="1"
        />
      </svg>
      <div className={styles.flavor} role="status" aria-live="polite">
        {caption}
      </div>
    </div>
  )
}
