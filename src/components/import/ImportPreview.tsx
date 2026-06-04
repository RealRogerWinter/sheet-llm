'use client'

import { useEffect, useRef } from 'react'
import { renderScore } from '@/lib/abc/synth'
import type { Score } from '@/lib/music/types'
import { getMeasureCount, getStaffCount, getVoiceCount } from '@/lib/music/scoreAccessors'
import type { ImportFormat } from '@/lib/shared/types'
import styles from './ImportPreview.module.css'

export type LayoutOverride = 'single' | 'grand-staff' | 'satb'

interface ImportPreviewProps {
  abc: string
  score: Score
  format: ImportFormat
  filename?: string
  /** Called when the user picks a different layout from the selector.
   *  Parent re-runs the import with the override. Omit to hide the
   *  selector (e.g. when the source format never benefits from
   *  layout overrides). */
  onLayoutOverride?: (layout: LayoutOverride) => void
}

const FORMAT_LABEL: Record<ImportFormat, string> = {
  abc: 'ABC',
  midi: 'MIDI',
  json: 'Score JSON',
  musicxml: 'MusicXML',
  // Blank scores never render this preview UI (the flow skips the
  // modal entirely), but the Record type requires the key.
  blank: 'Blank',
}

/**
 * Detect the score's current layout (one of single/grand-staff/satb)
 * so the selector reflects what the importer decided.
 */
function currentLayout(score: Score): LayoutOverride {
  const staves = getStaffCount(score)
  if (staves >= 2) {
    const voicesPrimary = getVoiceCount(score, 0)
    const voicesSecond = getVoiceCount(score, 1)
    if (voicesPrimary >= 2 && voicesSecond >= 2) return 'satb'
    return 'grand-staff'
  }
  return 'single'
}

/**
 * Renders the parsed score read-only at modal scale. Uses the same
 * abcjs renderer the Hero uses so the preview is visually identical
 * to what commits — no surprises after the user clicks Import.
 *
 * When `onLayoutOverride` is provided, surfaces a Layout selector so
 * the user can override the importer's auto-detected layout (e.g.
 * force grand staff on a single-track MIDI to scaffold a placeholder
 * bass staff). The parent re-runs the import with the new layout.
 */
export default function ImportPreview({
  abc,
  score,
  format,
  filename,
  onLayoutOverride,
}: ImportPreviewProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    let cancelled = false
    // Constrain width so the preview fits the modal column. abcjs's
    // 'resize' mode would otherwise expand to the container's natural
    // width.
    renderScore(ref.current, abc, { responsive: 'resize', staffwidth: 560 }).then(() => {
      // No-op; we don't tag noteheads or publish visualObj for previews.
      if (cancelled) return
    })
    return () => {
      cancelled = true
    }
  }, [abc])

  const layout = currentLayout(score)
  // Layout override only makes sense for ABC + MIDI imports; JSON
  // imports already carry the layout exactly as the user authored it.
  const showLayoutSelector = onLayoutOverride !== undefined && format !== 'json'

  return (
    <div className={styles.wrap}>
      <div ref={ref} className={styles.staff} aria-label="Score preview" />
      <div className={styles.meta}>
        Detected: {FORMAT_LABEL[format]} · {getMeasureCount(score)}{' '}
        {getMeasureCount(score) === 1 ? 'bar' : 'bars'} · {score.meter} · {score.key}
        {score.tempo_bpm !== undefined ? ` · ${score.tempo_bpm} bpm` : ''}
        {filename ? ` · ${filename}` : ''}
      </div>
      {showLayoutSelector && (
        <div className={styles.meta}>
          <label>
            Layout:{' '}
            <select
              value={layout}
              onChange={(e) => onLayoutOverride?.(e.target.value as LayoutOverride)}
              aria-label="Score layout"
            >
              <option value="single">Single staff</option>
              <option value="grand-staff">Grand staff (R/L hand)</option>
              <option value="satb">SATB (4 voices)</option>
            </select>
          </label>
        </div>
      )}
    </div>
  )
}
