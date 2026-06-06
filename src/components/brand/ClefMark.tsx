import type { ReactNode } from 'react'

/**
 * Treble-clef flourish for the sheet-llm wordmark. Pure inline SVG so it inherits
 * `currentColor` (the brand paints it in the rubric red), scales crisply, and
 * needs no music font. Always decorative — the wordmark's text carries the name.
 *
 * The path is the same engraver's clef used across the app's musical motifs
 * (originally authored for the /pricing edition page).
 */
export default function ClefMark({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 40" fill="none" className={className} aria-hidden="true" focusable={false}>
      <path
        d="M12.5 2c-2 1.3-3.2 3.3-3.2 5.8 0 2 .9 3.6 2.3 5.4l.6.8c-3.4 1-5.7 3.3-5.7 6.7 0 3.2 2.5 5.6 5.8 5.6.6 0 1.2-.1 1.7-.2l.5 4.1c.2 1.9-.6 3-2.1 3-1 0-1.8-.5-2-1.3.9-.1 1.6-.8 1.6-1.8 0-1-.8-1.8-1.9-1.8-1.2 0-2.1 1-2.1 2.4 0 1.9 1.7 3.3 4 3.3 2.6 0 4.2-1.7 3.9-4.3l-.5-4.2c2-.7 3.3-2.4 3.3-4.6 0-2.3-1.6-4-3.9-4-.3 0-.6 0-.9.1l-.4-2.9c1.9-1.9 3.2-3.7 3.2-6.2C18.3 4.6 16 2 12.5 2Zm.3 2.1c1.4 0 2.3 1.2 2.3 3 0 1.7-1 3.2-2.4 4.6l-.3-2.3c-.3-2.2.1-4 .8-5.3Zm-.2 12.3.6 4.6c-1.9-.3-3-1.5-3-3.1 0-1.3.9-2.4 2.4-3.1Zm1.7 1c1.4.2 2.3 1.2 2.3 2.7 0 1.3-.8 2.4-2 2.9l-.6-4.8c.1-.5.2-.6.3-.8Z"
        fill="currentColor"
      />
    </svg>
  )
}
