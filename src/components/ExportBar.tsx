'use client'

import { useState } from 'react'
import { downloadMidi } from '@/lib/abc/midi'
import { downloadPdf } from '@/lib/abc/pdf'
import { downloadMusicXml } from '@/lib/music/export/musicxml'
import type { Score } from '@/lib/music/types'
import styles from './ExportBar.module.css'

interface ExportBarProps {
  abc: string
  title?: string
  /** Current Score state. When undefined, the MusicXML button is
   *  hidden (the export needs the parsed Score, not just the ABC). */
  score?: Score
}

function safeFilename(title?: string): string {
  return (
    (title ?? 'score').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'score'
  )
}

type BusyKind = 'midi' | 'pdf' | 'musicxml'

export default function ExportBar({ abc, title, score }: ExportBarProps) {
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<BusyKind | undefined>(undefined)

  async function handleMidi() {
    setError(undefined)
    setBusy('midi')
    try {
      await downloadMidi(abc, `${safeFilename(title)}.mid`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'MIDI download failed')
    } finally {
      setBusy(undefined)
    }
  }

  async function handlePdf() {
    setError(undefined)
    setBusy('pdf')
    try {
      await downloadPdf(abc, `${safeFilename(title)}.pdf`, { title })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PDF download failed')
    } finally {
      setBusy(undefined)
    }
  }

  function handleMusicXml() {
    if (!score) return
    setError(undefined)
    setBusy('musicxml')
    try {
      // downloadMusicXml is synchronous (no abcjs render needed) — keep
      // the busy state symmetric with the async buttons for the briefest
      // visible feedback, then clear.
      downloadMusicXml(score, `${safeFilename(title)}.musicxml`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'MusicXML download failed')
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className={styles.bar}>
      <button type="button" className={styles.button} onClick={handleMidi} disabled={!!busy}>
        {busy === 'midi' ? 'Generating…' : 'Download MIDI'}
      </button>
      <button type="button" className={styles.button} onClick={handlePdf} disabled={!!busy}>
        {busy === 'pdf' ? 'Generating…' : 'Download PDF'}
      </button>
      {score && (
        <button
          type="button"
          className={styles.button}
          onClick={handleMusicXml}
          disabled={!!busy}
          title="Export as MusicXML (.musicxml) — opens in MuseScore, Sibelius, Finale"
        >
          {busy === 'musicxml' ? 'Generating…' : 'Download MusicXML'}
        </button>
      )}
      {error && (
        <span role="alert" className={styles.error}>{error}</span>
      )}
    </div>
  )
}
