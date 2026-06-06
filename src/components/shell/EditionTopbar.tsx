import Link from 'next/link'
import type { ReactNode } from 'react'
import Wordmark from '../brand/Wordmark'
import styles from './EditionShell.module.css'

/**
 * The shared running-head topbar for content/auth pages: the brand wordmark
 * (links home), an optional centered runhead label, and a "back to the editor"
 * link. Mirrors the /pricing masthead so every page wears the same head.
 */
export default function EditionTopbar({
  runhead,
  back = true,
}: {
  runhead?: string
  back?: boolean
}): ReactNode {
  return (
    <header className={styles.topbar}>
      <Wordmark href="/" size="md" className={styles.brand} />
      {runhead && (
        <span className={styles.runhead} aria-hidden="true">
          {runhead}
        </span>
      )}
      {back && (
        <Link href="/" className={styles.back}>
          <span aria-hidden="true">←</span> Back to the editor
        </Link>
      )}
    </header>
  )
}
