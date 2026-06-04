'use client'

import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HELP_SECTIONS } from '@/lib/help/content'
import styles from './HelpContent.module.css'

export default function HelpContent() {
  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}>sheet-llm</Link>
        <span className={styles.crumb}>User guide</span>
        <Link href="/" className={styles.back}>← Back to the editor</Link>
      </header>

      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="User guide sections">
          <ul>
            {HELP_SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ul>
        </nav>

        <main className={styles.content}>
          <h1 className={styles.h1}>User guide</h1>
          <p className={styles.lede}>
            A guide to composing, editing, and exporting music in sheet-llm.
          </p>

          {HELP_SECTIONS.map((section) => (
            <section key={section.id} id={section.id} className={styles.section}>
              <div className={styles.markdown}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body}</ReactMarkdown>
              </div>
            </section>
          ))}
        </main>
      </div>
    </div>
  )
}
