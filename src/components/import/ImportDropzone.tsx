'use client'

import { useRef, useState, type DragEvent } from 'react'
import styles from './ImportDropzone.module.css'

interface ImportDropzoneProps {
  onFile: (file: File) => void
  disabled?: boolean
}

const ACCEPTED_EXT = '.abc,.mid,.midi,.json,.xml,.musicxml'

export default function ImportDropzone({ onFile, disabled }: ImportDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)

  function pick() {
    if (disabled) return
    inputRef.current?.click()
  }
  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) onFile(f)
    // Allow re-selecting the same file.
    e.target.value = ''
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setHover(false)
    if (disabled) return
    const f = e.dataTransfer.files?.[0]
    if (f) onFile(f)
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!disabled) setHover(true)
  }
  function onDragLeave() {
    setHover(false)
  }

  return (
    <div
      className={`${styles.dropzone} ${hover ? styles.hover : ''} ${disabled ? styles.disabled : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Drop a file or click to browse"
      onClick={pick}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          pick()
        }
      }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <span className={styles.icon} aria-hidden="true">↧</span>
      <span className={styles.line1}>Drop a file or click to browse</span>
      <span className={styles.line2}>.abc · .mid · .json · .musicxml</span>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXT}
        onChange={onChange}
        className={styles.input}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  )
}
