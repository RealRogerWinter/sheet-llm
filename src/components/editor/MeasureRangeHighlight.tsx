'use client'

import { useLayoutEffect, useState, type RefObject } from 'react'
import { useChatStore } from '@/lib/chat/state'
import { resolveClickPosition } from '@/lib/music/scoreToAbcWithMap'

/**
 * Per-measure bounding box in viewport coordinates (clientLeft, etc.
 * as returned by getBoundingClientRect). One per measure in the
 * selected range, possibly spanning multiple staves vertically when
 * the score has a secondStaff.
 */
interface MeasureRect {
  measureIdx: number
  left: number
  top: number
  width: number
  height: number
}

/**
 * Translucent SVG-overlay-style highlight for the M19-PR-6
 * measureRangeSelection (M19-PR-7). Renders one fixed-position
 * rectangle per measure in the selected range so users get visible
 * feedback about which bars Shift+Backspace / Cmd+D will act on.
 *
 * Geometry walk: iterates `[data-startchar]` elements in the score
 * SVG, resolves each one's measureIdx via the SourceMap, groups by
 * measureIdx, and produces a bounding box per measure that spans:
 *   - HORIZONTAL: min(rect.left) to max(rect.right) of all events in
 *     the measure across all staves + voices (so the highlight
 *     covers the bar's full music range).
 *   - VERTICAL: min(rect.top) to max(rect.bottom) of the same set
 *     (extends to cover all staves the measure spans on grand-staff
 *     scores).
 *
 * Re-computes when `measureRangeSelection`, `abc`, or `editMap`
 * changes — AND on container scroll + window resize (M19-PR-7
 * review). Without the scroll/resize listeners the fixed-position
 * rects would desync from the moved/resized SVG underneath.
 *
 * useLayoutEffect (vs useEffect) so the bounds compute synchronously
 * before paint, eliminating the empty-first-frame flash that a
 * post-paint effect would produce.
 *
 * Mounted as a sibling of the score container in ScorePanel.
 *
 * Returns null when no range is set OR the score isn't yet rendered
 * (SourceMap missing OR the SVG hasn't been populated yet).
 */
export function MeasureRangeHighlight({
  scoreRef,
}: {
  scoreRef: RefObject<HTMLDivElement | null>
}) {
  const range = useChatStore((s) => s.measureRangeSelection)
  const abc = useChatStore((s) => s.abc)
  const editMap = useChatStore((s) => s.editMap)
  const drag = useChatStore((s) => s.measureDragState)
  const [rects, setRects] = useState<MeasureRect[]>([])

  useLayoutEffect(() => {
    function compute() {
      const container = scoreRef.current
      if (!container || !range || !editMap) {
        setRects([])
        return
      }
      const svg = container.querySelector('svg') as SVGSVGElement | null
      if (!svg) {
        setRects([])
        return
      }
      const nodes = svg.querySelectorAll<SVGGraphicsElement>('[data-startchar]')
      if (nodes.length === 0) {
        setRects([])
        return
      }
      // Group event bounding boxes by measureIdx.
      const byMeasure = new Map<number, { left: number; right: number; top: number; bottom: number }>()
      for (const node of nodes) {
        const rect = node.getBoundingClientRect()
        // Mirror clickInsertSlot's filter exactly — abcjs sometimes
        // emits zero-WIDTH decoration ghosts (e.g. tied-into-rest
        // pseudo-events). Height alone is unreliable as a filter
        // because some legitimate elements collapse vertically when
        // overlapped by stems.
        if (rect.width === 0) continue
        const raw = node.getAttribute('data-startchar')
        if (raw === null) continue
        const sc = Number(raw)
        if (!Number.isFinite(sc)) continue
        const resolved = resolveClickPosition(editMap, sc)
        if (!resolved) continue
        const mi = resolved.measureIdx
        if (mi < range.fromStart || mi > range.fromEnd) continue
        const existing = byMeasure.get(mi)
        if (existing) {
          if (rect.left < existing.left) existing.left = rect.left
          if (rect.right > existing.right) existing.right = rect.right
          if (rect.top < existing.top) existing.top = rect.top
          if (rect.bottom > existing.bottom) existing.bottom = rect.bottom
        } else {
          byMeasure.set(mi, {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          })
        }
      }
      const out: MeasureRect[] = []
      for (const [mi, bounds] of byMeasure) {
        // Pad horizontally so the highlight extends slightly beyond
        // the first/last notehead — feels like "this entire bar is
        // selected" rather than just "these noteheads". Vertical
        // padding extends above/below the staff lines so the rect
        // doesn't crop the ascenders/descenders of stems and
        // dynamics text.
        const HPAD = 6
        const VPAD = 8
        out.push({
          measureIdx: mi,
          left: bounds.left - HPAD,
          top: bounds.top - VPAD,
          width: bounds.right - bounds.left + HPAD * 2,
          height: bounds.bottom - bounds.top + VPAD * 2,
        })
      }
      out.sort((a, b) => a.measureIdx - b.measureIdx)
      setRects(out)
    }

    // Initial + dependency-triggered compute.
    compute()

    // Scroll + resize listeners — the rects are fixed-positioned to
    // viewport coords from getBoundingClientRect, so ANY scroll of
    // the score container (or its ancestors) and ANY window resize
    // desyncs them from the underlying SVG. rAF-throttle so a long
    // scroll doesn't fire compute 60+ times per second.
    if (!range || !editMap) return
    let rafToken: number | null = null
    function scheduleRecompute() {
      if (rafToken !== null) return
      rafToken = requestAnimationFrame(() => {
        rafToken = null
        compute()
      })
    }
    // Capture-phase on scroll so container-internal scrolls bubble
    // up — `scroll` doesn't bubble through `document` by default
    // unless capture is true.
    window.addEventListener('scroll', scheduleRecompute, {
      capture: true,
      passive: true,
    })
    window.addEventListener('resize', scheduleRecompute, { passive: true })
    let ro: ResizeObserver | undefined
    const container = scoreRef.current
    if (container && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(scheduleRecompute)
      ro.observe(container)
    }
    return () => {
      window.removeEventListener('scroll', scheduleRecompute, {
        capture: true,
      })
      window.removeEventListener('resize', scheduleRecompute)
      if (rafToken !== null) cancelAnimationFrame(rafToken)
      if (ro) ro.disconnect()
    }
  }, [scoreRef, range, abc, editMap])

  if (rects.length === 0 && !drag) return null
  return (
    <>
      {rects.map((r) => (
        <div
          key={r.measureIdx}
          aria-hidden
          data-testid="measure-range-highlight"
          data-measure-idx={r.measureIdx}
          style={{
            position: 'fixed',
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            // Dim the source highlight during a drag so the ghost
            // line is the visual focus. Same hue, lower opacity.
            background: drag
              ? 'rgba(99, 179, 237, 0.10)'
              : 'rgba(99, 179, 237, 0.18)',
            border: drag
              ? '1px dashed rgba(99, 179, 237, 0.5)'
              : '1.5px solid rgba(99, 179, 237, 0.7)',
            borderRadius: 3,
            pointerEvents: 'none',
            zIndex: 50,
          }}
        />
      ))}
      {drag && drag.toAfter !== null && (
        <div
          aria-hidden
          data-testid="measure-drop-indicator"
          data-to-after={drag.toAfter}
          style={{
            position: 'fixed',
            left: drag.clientX - 1.5,
            top: 0,
            width: 3,
            height: '100vh',
            background: 'rgba(34, 139, 34, 0.85)',
            pointerEvents: 'none',
            zIndex: 60,
          }}
        />
      )}
      {drag && drag.toAfter === null && (
        // Cursor is over the source range → no-op drop. Show a
        // muted line so the user gets visual confirmation that
        // they're currently NOT going to land anywhere.
        <div
          aria-hidden
          data-testid="measure-drop-indicator-noop"
          style={{
            position: 'fixed',
            left: drag.clientX - 1.5,
            top: 0,
            width: 3,
            height: '100vh',
            background: 'rgba(150, 150, 150, 0.45)',
            pointerEvents: 'none',
            zIndex: 60,
          }}
        />
      )}
    </>
  )
}
