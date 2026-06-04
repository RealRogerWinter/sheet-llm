'use client'

import { useEffect } from 'react'
import { useTransportContext } from './TransportContext'
import styles from './TransportBar.module.css'

const VOLUME_KEY = 'sheet-llm.transportVolume'
const MUTED_KEY = 'sheet-llm.transportMuted'

export default function VolumeControl() {
  const t = useTransportContext()

  // Hydrate persisted preferences once.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const v = window.localStorage.getItem(VOLUME_KEY)
      if (v !== null) {
        const n = parseFloat(v)
        if (Number.isFinite(n)) t.setVolume(n)
      }
      const m = window.localStorage.getItem(MUTED_KEY)
      if (m === '1') t.setMuted(true)
    } catch {
      /* localStorage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    t.setVolume(v)
    if (t.muted && v > 0) t.setMuted(false)
    try {
      window.localStorage.setItem(VOLUME_KEY, String(v))
    } catch {
      /* ignore */
    }
  }

  const onToggleMute = () => {
    const next = !t.muted
    t.setMuted(next)
    try {
      window.localStorage.setItem(MUTED_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  const effective = t.muted ? 0 : t.volume
  const icon = t.muted || t.volume === 0 ? '🔇' : t.volume < 0.4 ? '🔈' : '🔊'

  return (
    <div className={styles.volume}>
      <button
        type="button"
        className={styles.iconButton}
        onClick={onToggleMute}
        aria-label={t.muted ? 'Unmute' : 'Mute'}
        aria-pressed={t.muted}
        title={t.muted ? 'Unmute' : 'Mute'}
      >
        <span aria-hidden="true">{icon}</span>
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={effective}
        onChange={onSlider}
        aria-label="Volume"
        className={styles.volumeSlider}
      />
    </div>
  )
}
