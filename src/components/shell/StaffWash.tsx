import type { ReactNode } from 'react'
import styles from './EditionShell.module.css'

/**
 * Full-bleed, faint staff-line wash — the "manuscript paper" backdrop for
 * content pages. Fixed and masked at top/bottom; purely decorative. Render it
 * as the first child of a page whose root sets `isolation: isolate`, with the
 * real content raised to `z-index: 1`.
 */
export default function StaffWash(): ReactNode {
  return <div className={styles.staffWash} aria-hidden="true" />
}
