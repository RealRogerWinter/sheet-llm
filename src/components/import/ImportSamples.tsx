'use client'

import styles from './ImportSamples.module.css'

interface Sample {
  label: string
  path: string
}

const SAMPLES: Sample[] = [
  { label: 'Twinkle Twinkle', path: '/samples/twinkle.abc' },
  { label: 'Greensleeves', path: '/samples/greensleeves.abc' },
  { label: 'Bach Minuet', path: '/samples/bach-minuet.abc' },
]

interface ImportSamplesProps {
  onPick: (sample: { text: string; filename: string }) => void
  disabled?: boolean
}

export default function ImportSamples({ onPick, disabled }: ImportSamplesProps) {
  async function load(s: Sample) {
    if (disabled) return
    try {
      const res = await fetch(s.path)
      if (!res.ok) return
      const text = await res.text()
      const filename = s.path.split('/').pop() ?? 'sample.abc'
      onPick({ text, filename })
    } catch {
      // Silent — user can always try another sample or paste manually.
    }
  }
  return (
    <div className={styles.row}>
      <span className={styles.label}>Try a sample:</span>
      <div className={styles.chips}>
        {SAMPLES.map((s) => (
          <button
            key={s.path}
            type="button"
            className={styles.chip}
            onClick={() => load(s)}
            disabled={disabled}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
