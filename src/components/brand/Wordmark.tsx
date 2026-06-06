import Link from 'next/link'
import type { ReactNode } from 'react'
import ClefMark from './ClefMark'
import styles from './Wordmark.module.css'

type Size = 'sm' | 'md' | 'lg'

/**
 * The sheet-llm brand wordmark: a rubric treble-clef set against the name in the
 * Fraunces display serif. The single source of brand identity, shared by the
 * editor header and every content/auth page so the mark never drifts.
 *
 * Renders as a `next/link` when `href` is given (content pages link home);
 * otherwise a plain span (the editor header wraps it in its own <h1>). The clef
 * scales with the type via `em` units, so one component covers every placement.
 */
export default function Wordmark({
  href,
  size = 'md',
  className,
}: {
  href?: string
  size?: Size
  className?: string
}): ReactNode {
  const inner = (
    <>
      <ClefMark className={styles.clef} />
      <span className={styles.name}>sheet-llm</span>
    </>
  )
  const cls = `${styles.brand} ${styles[size]} ${className ?? ''}`

  if (href) {
    return (
      <Link href={href} className={cls} aria-label="sheet-llm — home">
        {inner}
      </Link>
    )
  }
  return <span className={cls}>{inner}</span>
}
