import Link from 'next/link'
import type { ReactNode } from 'react'
import styles from './EditionShell.module.css'

/**
 * The closing colophon — a fermata-over-final-barline flourish, the engraver's
 * rule, and a back link. Mirrors the /pricing colophon so content/auth pages
 * close the same way.
 */
export default function Colophon({ back = true }: { back?: boolean }): ReactNode {
  return (
    <footer className={styles.colophon}>
      <Coda className={styles.coda} />
      <p className={styles.colophonText}>
        <span className={styles.colophonBrand}>sheet-llm</span>
        <span className={styles.colophonDot} aria-hidden="true">
          ·
        </span>
        Engraved with Claude
      </p>
      {back && (
        <Link href="/" className={styles.back}>
          <span aria-hidden="true">←</span> Back to the editor
        </Link>
      )}
    </footer>
  )
}

/** A fermata over a final (thin + thick) barline — the score's closing mark. */
function Coda({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 64 40" fill="none" className={className} aria-hidden="true" focusable={false}>
      <path d="M16 20a16 16 0 0 1 32 0" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="32" cy="17" r="2.2" fill="currentColor" />
      <line x1="40" y1="26" x2="40" y2="40" stroke="currentColor" strokeWidth="1.2" />
      <rect x="44" y="26" width="3.2" height="14" fill="currentColor" />
    </svg>
  )
}
