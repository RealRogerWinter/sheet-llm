'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import EditionTopbar from '../shell/EditionTopbar'
import Colophon from '../shell/Colophon'
import StaffWash from '../shell/StaffWash'
import styles from './LegalContent.module.css'

/**
 * Shared renderer for the public /terms and /privacy pages. Takes a Markdown
 * string (from src/lib/legal/content.ts) and renders it with the same GFM
 * pipeline + reading typography as the /help guide, wrapped in the shared
 * engraved-edition masthead + colophon so the legal pages match the rest of
 * the site.
 */
export default function LegalContent({ crumb, markdown }: { crumb: string; markdown: string }) {
  return (
    <div className={styles.page}>
      <StaffWash />
      <EditionTopbar runhead={crumb} />

      <main className={styles.content}>
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </div>
        <Colophon />
      </main>
    </div>
  )
}
