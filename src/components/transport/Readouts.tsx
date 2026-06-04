'use client'

import { useChatStore } from '@/lib/chat/state'
import { useTransportContext } from './TransportContext'
import styles from './TransportBar.module.css'

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function Readouts() {
  const t = useTransportContext()
  // Derive current measure from playbackPosition (store-updated by
  // cursorControl) — clean source, no per-frame churn.
  const pos = useChatStore((s) => s.playbackPosition)
  const currentMeasure = pos ? pos.measureIdx + 1 : 0
  // Time: only re-renders when integer seconds change (we update from
  // playbackPosition cadence, which is "per note", not per beat).
  // For a richer clock we'd subscribe to rAF; intentionally we don't.
  const totalText = formatMs(t.totalMs)
  return (
    <div className={styles.readouts} aria-label="Playback position">
      <span className={styles.measure}>
        m. {currentMeasure} / {t.totalMeasures || '—'}
      </span>
      <span className={styles.sep}>·</span>
      <span className={styles.time}>
        {pos ? formatMs(estimateMs(pos.measureIdx, t.totalMeasures, t.totalMs)) : '0:00'}
        {' / '}
        {totalText}
      </span>
    </div>
  )
}

function estimateMs(measureIdx: number, totalMeasures: number, totalMs: number): number {
  if (totalMeasures <= 0 || totalMs <= 0) return 0
  return (measureIdx / totalMeasures) * totalMs
}
