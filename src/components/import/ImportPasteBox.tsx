'use client'

import { useState } from 'react'
import styles from './ImportPasteBox.module.css'

interface ImportPasteBoxProps {
  onParse: (text: string) => void
  disabled?: boolean
}

export default function ImportPasteBox({ onParse, disabled }: ImportPasteBoxProps) {
  const [text, setText] = useState('')

  function submit() {
    const t = text.trim()
    if (!t) return
    onParse(t)
  }

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor="import-paste">
        Or paste ABC text
      </label>
      <textarea
        id="import-paste"
        className={styles.textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'X:1\nT:My tune\nM:4/4\nL:1/8\nK:C\n…'}
        rows={5}
        disabled={disabled}
        spellCheck={false}
      />
      <div className={styles.row}>
        <button
          type="button"
          className={styles.parse}
          onClick={submit}
          disabled={disabled || text.trim().length === 0}
        >
          Parse paste
        </button>
      </div>
    </div>
  )
}
