'use client'

import styles from './SuggestionChips.module.css'

interface SuggestionChipsProps {
  onPick: (prompt: string) => void
  /** 'compose' (default) is the empty-state set used when there's no
   *  score yet. 'imported' targets transformations of a just-imported
   *  score (transpose, harmonize, slow, etc.). 'blank' targets the
   *  blank-canvas first-prompt: short, opinionated nudges. */
  variant?: 'compose' | 'imported' | 'blank'
}

const COMPOSE_SUGGESTIONS = [
  'a C major scale',
  'triplets in B-flat for 6 bars',
  'I-IV-V-I in G major as block chords',
  '4 bars of 6/8 with a dotted-quarter then three eighths',
  'G minor arpeggio across two octaves',
]

const IMPORTED_SUGGESTIONS = [
  'transpose to G major',
  'add a simple harmony below',
  'slow this to 80 bpm',
  'add a coda after the last bar',
  'change the time signature to 5/4',
]

const BLANK_SUGGESTIONS = [
  'change the key to G major',
  'add 7 more measures',
  'add a bass staff',
  'give me a 4-bar melody to start',
]

export default function SuggestionChips({ onPick, variant = 'compose' }: SuggestionChipsProps) {
  const list =
    variant === 'imported'
      ? IMPORTED_SUGGESTIONS
      : variant === 'blank'
        ? BLANK_SUGGESTIONS
        : COMPOSE_SUGGESTIONS
  return (
    <div className={styles.chips}>
      {list.map((s) => (
        <button
          key={s}
          type="button"
          className={styles.chip}
          onClick={() => onPick(s)}
        >
          {s}
        </button>
      ))}
    </div>
  )
}
