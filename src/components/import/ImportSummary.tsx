'use client'

import type { ImportWarningWire } from '@/lib/shared/types'
import styles from './ImportSummary.module.css'

interface ImportSummaryProps {
  warnings: ImportWarningWire[]
  /** Called when the user accepts the truncate-to-cap choice. */
  onAcceptTruncation?: () => void
}

/**
 * Three-tier warning surface:
 *
 *   block  — red rule, role="alert". Disables the commit button.
 *            For the 'too_long' code we also render a radio choice
 *            that the caller wires to onAcceptTruncation.
 *   choice — ink rule, role="alert". Currently only used implicitly
 *            via block 'too_long' resolving to info post-acceptance.
 *   info   — graphite rule, role="status". Pure FYI.
 */
export default function ImportSummary({ warnings, onAcceptTruncation }: ImportSummaryProps) {
  if (warnings.length === 0) return null
  return (
    <div className={styles.wrap}>
      <div className={styles.heading}>Summary</div>
      <ul className={styles.list}>
        {warnings.map((w, i) => (
          <li
            key={i}
            className={`${styles.row} ${
              w.severity === 'block' ? styles.block : w.severity === 'choice' ? styles.choice : styles.info
            }`}
            role={w.severity === 'block' || w.severity === 'choice' ? 'alert' : 'status'}
          >
            <div className={styles.message}>{w.message}</div>
            {w.code === 'too_long' && w.severity === 'block' && onAcceptTruncation && (
              <div className={styles.actions}>
                <button type="button" className={styles.action} onClick={onAcceptTruncation}>
                  {typeof w.meta?.cap === 'number'
                    ? `Import the first ${w.meta.cap} bars`
                    : 'Import the truncated score'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
