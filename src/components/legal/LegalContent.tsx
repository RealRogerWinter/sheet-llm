'use client'

import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './LegalContent.module.css'

/**
 * Shared renderer for the public /terms and /privacy pages. Takes a Markdown
 * string (from src/lib/legal/content.ts) and renders it with the same GFM
 * pipeline + reading typography as the /help guide, so the two legal pages
 * stay visually consistent without duplicating styles.
 */
export default function LegalContent({ crumb, markdown }: { crumb: string; markdown: string }) {
  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}>sheet-llm</Link>
        <span className={styles.crumb}>{crumb}</span>
        <Link href="/" className={styles.back}>← Back to the editor</Link>
      </header>

      <main className={styles.content}>
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </div>
      </main>
    </div>
  )
}
