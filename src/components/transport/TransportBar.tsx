'use client'

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useTransportContext } from './TransportContext'
import Scrubber from './Scrubber'
import Readouts from './Readouts'
import VolumeControl from './VolumeControl'
import OverflowMenu from './OverflowMenu'
import styles from './TransportBar.module.css'

export default function TransportBar() {
  const t = useTransportContext()
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Write our measured height to :root --transport-height so the score
  // area can reserve space and UndoToast can offset.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el || typeof window === 'undefined') return
    const root = document.documentElement
    const apply = () => {
      const h = el.offsetHeight
      root.style.setProperty('--transport-height', `${h}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty('--transport-height', '0px')
    }
  }, [])

  // Global Space → play/pause when focus isn't in an editable element.
  useEffect(() => {
    function isEditable(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (target.isContentEditable) return true
      return false
    }
    function onKey(e: KeyboardEvent) {
      if (e.code !== 'Space') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(e.target) || isEditable(document.activeElement)) return
      if (!t.isReady) return
      e.preventDefault()
      if (t.isPlaying) t.pause()
      else void t.play()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [t])

  const onPlayPause = useCallback(() => {
    if (!t.isReady) return
    if (t.isPlaying) t.pause()
    else void t.play()
  }, [t])

  const onRestart = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      t.restart(e.shiftKey)
    },
    [t],
  )

  if (!t.isSupported) {
    return (
      <div ref={rootRef} className={`${styles.bar} ${styles.disabled}`} role="region" aria-label="Score playback">
        <div className={styles.row}>
          <span className={styles.unsupported}>Audio not supported in this browser.</span>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`${styles.bar} ${t.isRebinding ? styles.rebinding : ''}`}
      role="region"
      aria-label="Score playback"
    >
      <Scrubber />
      <div className={styles.row} role="toolbar" aria-label="Transport controls">
        <button
          type="button"
          className={styles.iconButton}
          onClick={onRestart}
          aria-label="Restart from beginning"
          aria-keyshortcuts="Home"
          title="Restart (Shift+click to play)"
          disabled={!t.isReady}
        >
          <span aria-hidden="true">⤺</span>
        </button>
        <button
          type="button"
          className={styles.playButton}
          onClick={onPlayPause}
          aria-label={t.isPlaying ? 'Pause' : 'Play'}
          aria-keyshortcuts="Space"
          aria-pressed={t.isPlaying}
          disabled={!t.isReady}
          data-state={t.ended ? 'ended' : t.isPlaying ? 'playing' : 'idle'}
        >
          <span aria-hidden="true">
            {t.ended ? '↻' : t.isPlaying ? '❚❚' : '▶'}
          </span>
        </button>
        <button
          type="button"
          className={styles.repeatButton}
          onClick={t.toggleRepeat}
          aria-label="Repeat"
          aria-pressed={t.repeat}
          title={t.repeat ? 'Repeat on — playback loops' : 'Repeat off'}
        >
          {/* Monochrome icon (currentColor) so it recolors with the
              pressed pill and honors forced-colors, unlike a 🔁 emoji. */}
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
        </button>
        <div className={styles.sep} aria-hidden="true" />
        <Readouts />
        <div className={styles.sep} aria-hidden="true" />
        <span className={styles.tempo} aria-label={`Tempo ${t.qpm} beats per minute`}>
          ♩={t.qpm}
        </span>
        <div className={styles.spacer} />
        <VolumeControl />
        <div className={styles.sep} aria-hidden="true" />
        <OverflowMenu />
      </div>
    </div>
  )
}
