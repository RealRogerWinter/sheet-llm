'use client'

import { useLayoutEffect, useState, type RefObject } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { resolveClickPosition } from '@/lib/music/scoreToAbcWithMap'

interface RunRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Translucent overlay for the D2 intra-measure `runSelection` (Shift+click
 * a note to extend from the prior selection). Draws ONE bounding box over
 * the run's events so the user sees which contiguous span Copy/Cut will
 * act on — distinct green hue vs the blue `MeasureRangeHighlight` so the
 * two selection models read apart when both happen to be set.
 *
 * Geometry: iterate `[data-startchar]` elements, resolve each via the
 * SourceMap, keep those in the run's staff/voice/measure whose eventIdx is
 * within `[start, end]`, and union their viewport rects. A bar never wraps
 * a system break in abcjs, so a single box is always contiguous.
 *
 * Mirrors MeasureRangeHighlight's recompute triggers (deps + scroll/resize
 * + ResizeObserver, rAF-throttled) since the fixed-position rect is in
 * viewport coords and desyncs on any scroll/resize. useLayoutEffect so the
 * box is measured before paint (no empty-first-frame flash).
 *
 * Mounted as a sibling of the score container in ScorePanel. Returns null
 * when no run is set or the score isn't rendered yet.
 */
export function RunSelectionHighlight({
  scoreRef,
}: {
  scoreRef: RefObject<HTMLDivElement | null>
}) {
  const run = useChatStore((s) => s.runSelection)
  const abc = useChatStore((s) => s.abc)
  const editMap = useChatStore((s) => s.editMap)
  const [rect, setRect] = useState<RunRect | null>(null)

  useLayoutEffect(() => {
    function compute() {
      const container = scoreRef.current
      if (!container || !run || !editMap) {
        setRect(null)
        return
      }
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) {
        setRect(null)
        return
      }
      const nodes = svg.querySelectorAll<SVGGraphicsElement>('[data-startchar]')
      const lo = Math.min(run.startEventIdx, run.endEventIdx)
      const hi = Math.max(run.startEventIdx, run.endEventIdx)
      let left = Infinity
      let top = Infinity
      let right = -Infinity
      let bottom = -Infinity
      let found = false
      for (const node of nodes) {
        const r = node.getBoundingClientRect()
        // Mirror clickInsertSlot / MeasureRangeHighlight: skip abcjs's
        // zero-width decoration ghosts.
        if (r.width === 0) continue
        const raw = node.getAttribute('data-startchar')
        if (raw === null) continue
        const sc = Number(raw)
        if (!Number.isFinite(sc)) continue
        const resolved = resolveClickPosition(editMap, sc)
        if (!resolved) continue
        if ((resolved.staffIdx ?? 0) !== (run.staffIdx ?? 0)) continue
        if ((resolved.voiceIdx ?? 0) !== (run.voiceIdx ?? 0)) continue
        if (resolved.measureIdx !== run.measureIdx) continue
        if (resolved.eventIdx < lo || resolved.eventIdx > hi) continue
        found = true
        if (r.left < left) left = r.left
        if (r.top < top) top = r.top
        if (r.right > right) right = r.right
        if (r.bottom > bottom) bottom = r.bottom
      }
      if (!found) {
        setRect(null)
        return
      }
      const HPAD = 5
      const VPAD = 7
      setRect({
        left: left - HPAD,
        top: top - VPAD,
        width: right - left + HPAD * 2,
        height: bottom - top + VPAD * 2,
      })
    }

    compute()

    if (!run || !editMap) return
    let rafToken: number | null = null
    function scheduleRecompute() {
      if (rafToken !== null) return
      rafToken = requestAnimationFrame(() => {
        rafToken = null
        compute()
      })
    }
    window.addEventListener('scroll', scheduleRecompute, { capture: true, passive: true })
    window.addEventListener('resize', scheduleRecompute, { passive: true })
    let ro: ResizeObserver | undefined
    const container = scoreRef.current
    if (container && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(scheduleRecompute)
      ro.observe(container)
    }
    return () => {
      window.removeEventListener('scroll', scheduleRecompute, { capture: true })
      window.removeEventListener('resize', scheduleRecompute)
      if (rafToken !== null) cancelAnimationFrame(rafToken)
      if (ro) ro.disconnect()
    }
  }, [scoreRef, run, abc, editMap])

  if (!rect) return null
  return (
    <div
      aria-hidden
      data-testid="run-selection-highlight"
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        background: 'rgba(72, 187, 120, 0.16)',
        border: '1.5px solid rgba(56, 161, 105, 0.75)',
        borderRadius: 3,
        pointerEvents: 'none',
        zIndex: 49,
      }}
    />
  )
}
