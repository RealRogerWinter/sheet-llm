'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { useDebugStore } from '@/lib/debug/debugStore'

/**
 * Maximum total wall-clock for the staggered reveal. If a long score
 * would push past this with the base stagger, we shrink the per-element
 * delay so the whole reveal still finishes in ≤ 3.2s.
 */
const TOTAL_REVEAL_BUDGET_MS = 3200
const BASE_STAGGER_MS = 60
const NOTE_DURATION_MS = 300
const BAR_DURATION_MS = 200
const ARRIVAL_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const REDUCED_MOTION_DURATION_MS = 220

const TARGET_SELECTOR = '.abcjs-note, .abcjs-rest, .abcjs-bar'

interface Options {
  /**
   * Bumped by ScorePanel each time a fresh render completes (and the
   * targets have been hidden synchronously inside the renderScore().then
   * callback). Distinct from a re-mount because the same container can
   * receive successive scores within a single ScorePanel lifetime.
   */
  trigger: number
}

/**
 * Drives the per-note "ink condensing" reveal after abcjs paints. Caller
 * is responsible for setting `style.opacity = '0'` on the targets
 * synchronously inside the renderScore().then callback BEFORE bumping
 * `trigger` — this hook then assumes targets are already hidden and
 * just runs the animation. Honors `reduceMotion` (collapses to a single
 * 220ms crossfade) and the debug-store kill switch (skips animation
 * entirely, clears any leftover opacity).
 */
export function useScoreReveal(containerRef: RefObject<HTMLElement | null>, { trigger }: Options) {
  const reduceMotion = useChatStore((s) => s.reduceMotion)
  const markRevealStarted = useChatStore((s) => s.markRevealStarted)
  const markRevealComplete = useChatStore((s) => s.markRevealComplete)
  const revealAnimationEnabled = useDebugStore((s) => s.revealAnimationEnabled)

  // Refs so the cleanup closure always sees the latest set of
  // animations + targets even if the effect re-fires.
  const animationsRef = useRef<Animation[]>([])
  const targetsRef = useRef<HTMLElement[]>([])

  useLayoutEffect(() => {
    if (trigger === 0) return
    const container = containerRef.current
    if (!container) return

    const cancelAll = () => {
      for (const a of animationsRef.current) {
        try { a.cancel() } catch { /* ignore — animation already settled */ }
      }
      animationsRef.current = []
      for (const el of targetsRef.current) {
        el.style.opacity = ''
      }
      targetsRef.current = []
    }

    // Cancel anything left over from a prior reveal first — a second
    // prompt mid-reveal must not leave hidden orphans behind.
    cancelAll()

    const targets = Array.from(container.querySelectorAll<HTMLElement>(TARGET_SELECTOR))
    targetsRef.current = targets

    // Kill switch: clear the inline opacity:0 ScorePanel applied and
    // bail. ScoreStage's existing 220ms wrapper fadeIn (re-enabled by
    // omitting the data-revealing attr) handles the visual entry.
    if (!revealAnimationEnabled) {
      for (const el of targets) el.style.opacity = ''
      targetsRef.current = []
      return
    }

    if (targets.length === 0) return

    markRevealStarted()

    if (reduceMotion) {
      // Reduced motion: single crossfade on the whole batch instead of
      // a stagger. Clear any inline opacity:0 at the end.
      const anims: Animation[] = []
      for (const el of targets) {
        try {
          const anim = el.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: REDUCED_MOTION_DURATION_MS, easing: 'ease-out', fill: 'both' },
          )
          anims.push(anim)
        } catch {
          // Element.animate unavailable (jsdom or very old browsers) —
          // restore visibility immediately.
          el.style.opacity = ''
        }
      }
      animationsRef.current = anims
      const finishedSignals = anims.map((a) => a.finished.catch(() => undefined))
      Promise.all(finishedSignals).then(() => {
        if (animationsRef.current !== anims) return
        for (const el of targets) el.style.opacity = ''
        animationsRef.current = []
        targetsRef.current = []
        markRevealComplete()
      })
      return cancelAll
    }

    // Compute stagger that keeps total reveal ≤ TOTAL_REVEAL_BUDGET_MS.
    // The last element starts at (n-1) * stagger and runs for the per-
    // element duration; we use the longer (note) duration as the cap.
    const lastWindow = Math.max(0, TOTAL_REVEAL_BUDGET_MS - NOTE_DURATION_MS)
    const stagger = targets.length > 1
      ? Math.min(BASE_STAGGER_MS, lastWindow / (targets.length - 1))
      : 0

    const anims: Animation[] = []
    for (let i = 0; i < targets.length; i++) {
      const el = targets[i]
      const isBar = el.classList.contains('abcjs-bar')
      // Bars precede the first note in the same measure by 30ms so the
      // barline reads as already-printed when the note lands on it.
      const baseDelay = i * stagger
      const delay = isBar ? Math.max(0, baseDelay - 30) : baseDelay
      const duration = isBar ? BAR_DURATION_MS : NOTE_DURATION_MS

      try {
        const anim = el.animate(
          [
            { opacity: 0, transform: 'translateY(4px)', color: 'var(--ink-ghost)' },
            { opacity: 1, transform: 'translateY(0)', color: 'var(--score-ink)' },
          ],
          { duration, delay, easing: ARRIVAL_EASING, fill: 'both' },
        )
        anims.push(anim)
      } catch {
        // Element.animate unavailable — drop the inline hide so the
        // element is at least visible in the static state.
        el.style.opacity = ''
      }
    }
    animationsRef.current = anims

    if (anims.length === 0) {
      markRevealComplete()
      return cancelAll
    }

    const finishedSignals = anims.map((a) => a.finished.catch(() => undefined))
    Promise.all(finishedSignals).then(() => {
      // Guard against a stale completion firing after a newer reveal
      // already replaced animationsRef. Only the run that owns the
      // current set should finalize.
      if (animationsRef.current !== anims) return
      for (const el of targets) el.style.opacity = ''
      animationsRef.current = []
      targetsRef.current = []
      markRevealComplete()
    })

    return cancelAll
  }, [trigger, containerRef, reduceMotion, revealAnimationEnabled, markRevealStarted, markRevealComplete])
}
