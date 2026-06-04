'use client'

import { useCallback, useRef, useState } from 'react'
import { useTransportContext } from './TransportContext'
import styles from './TransportBar.module.css'

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function Scrubber() {
  const t = useTransportContext()
  const trackRef = useRef<HTMLDivElement | null>(null)
  const isDraggingRef = useRef(false)
  const [hoverPct, setHoverPct] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)

  const setFillRef = useCallback(
    (el: HTMLDivElement | null) => {
      t.registerProgressFill(el)
    },
    [t],
  )
  const setRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      trackRef.current = el
      t.registerScrubberRoot(el)
    },
    [t],
  )

  const pctFromEvent = useCallback((clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const commit = useCallback(
    (clientX: number, autoPlay: boolean) => {
      const pct = pctFromEvent(clientX)
      t.seekPercent(pct, autoPlay)
    },
    [pctFromEvent, t],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!t.isReady) return
      e.currentTarget.setPointerCapture(e.pointerId)
      isDraggingRef.current = true
      commit(e.clientX, false)
    },
    [commit, t.isReady],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pct = pctFromEvent(e.clientX)
      setHoverPct(pct)
      if (isDraggingRef.current) commit(e.clientX, false)
    },
    [commit, pctFromEvent],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current) return
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      isDraggingRef.current = false
      // Commit one final time with autoPlay if user was playing before.
      // seekPercent already restores playback if it was running.
      commit(e.clientX, false)
    },
    [commit],
  )

  const onPointerLeave = useCallback(() => {
    if (!isDraggingRef.current) setHoverPct(null)
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!t.isReady || t.totalMeasures <= 0) return
      const step = e.shiftKey ? 1 / Math.max(1, t.totalMeasures * 4) : 1 / t.totalMeasures
      let handled = true
      let pct: number | null = null
      // Compute current pct from CSS var.
      const fill = trackRef.current?.querySelector(`.${styles.fill}`) as HTMLElement | null
      const cur = parseFloat(fill?.style.getPropertyValue('--p') || '0')
      switch (e.key) {
        case 'ArrowRight':
          pct = Math.min(1, cur + step)
          break
        case 'ArrowLeft':
          pct = Math.max(0, cur - step)
          break
        case 'Home':
          pct = 0
          break
        case 'End':
          pct = 1
          break
        default:
          handled = false
      }
      if (handled) {
        e.preventDefault()
        if (pct !== null) t.seekPercent(pct, false)
      }
    },
    [t],
  )

  // Approximate ms readout for hover tooltip — uses the same totalMs.
  const tooltipText =
    hoverPct !== null && t.totalMs > 0 ? formatMs(hoverPct * t.totalMs) : null

  // Hidden live region for screen readers — read on focus/seek.
  // (The visible aria-valuetext below is rebuilt on each render
  // off the current measure derived from progress.)
  return (
    <div
      ref={setRootRef}
      className={`${styles.scrubber} ${focused ? styles.scrubberFocused : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Score position"
      aria-valuemin={0}
      aria-valuemax={Math.max(1, t.totalMeasures)}
      aria-valuenow={0}
      aria-valuetext={`Out of ${t.totalMeasures} measures`}
      aria-disabled={!t.isReady}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className={styles.track}>
        <div ref={setFillRef} className={styles.fill} style={{ ['--p' as unknown as string]: 0 }} />
      </div>
      {tooltipText !== null && (
        <div
          className={styles.tooltip}
          style={{ left: `${(hoverPct ?? 0) * 100}%` }}
          aria-hidden="true"
        >
          {tooltipText}
        </div>
      )}
    </div>
  )
}
