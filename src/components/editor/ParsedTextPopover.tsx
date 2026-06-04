'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './ParsedTextPopover.module.css'

export interface ParsedTextPopoverProps<T> {
  open: boolean
  anchorX: number
  anchorY: number
  /** Accessible label exposed on role="dialog". */
  ariaLabel: string
  /** Header title shown above the hint. */
  title: string
  /**
   * Hint shown beneath the title — typically inline-formatted
   * example syntax (e.g. "Try: <code>p</code>, <code>mf</code>, …").
   */
  hint: ReactNode
  /**
   * Optional seed text shown when the popover opens. Typically the
   * formatted form of the current value so the user can refine
   * rather than retype.
   */
  initialText?: string
  /** Placeholder shown in the input when text is empty. */
  placeholder?: string
  /** Accessible label for the input element. */
  inputAriaLabel: string
  /**
   * Parses the input string into a value. Returning `undefined`
   * (or `null`) flags the input as unparseable — Apply is disabled
   * and the preview shows an error.
   */
  parser: (text: string) => T | undefined | null
  /**
   * Renders the canonical form of a parsed value for the preview.
   * Should be the inverse of `parser` for the round-trip cases.
   */
  formatter: (value: T) => string
  /** Submit button label. Defaults to "Apply". */
  submitLabel?: string
  /**
   * Optional clear-action handler. When set, the footer renders an
   * extra "Clear" button to the left of Apply that fires this callback
   * and closes the popover. The caller decides what "clear" means
   * (typically: dispatch a remove op against the current selection).
   * Use when the underlying value can be unset — e.g. a fingering
   * already attached to the selected pitch — and there's no other UI
   * affordance for clearing.
   */
  onClear?: () => void
  /** Clear button label. Defaults to "Clear". */
  clearLabel?: string
  estimatedHeight?: number
  estimatedWidth?: number
  onClose: () => void
  onSubmit: (parsed: T) => void
}

/**
 * Free-text-input popover with live parse + canonical preview —
 * the Dorico shorthand pattern. DynamicsPopover sits on this today;
 * future Shift+M (meter), Shift+K (key), Shift+T (tempo) popovers
 * are one-line wrappers around it.
 *
 * Owns the input element, autofocus-on-open, Enter-to-submit,
 * Cancel/Apply footer, and the preview line that flips between
 * a `→ canonical` confirmation and a `Couldn't parse "{text}"`
 * error indicator. The shared <Popover> shell underneath handles
 * positioning, Escape-to-close, mouseDown containment, and the
 * visual frame.
 */
export default function ParsedTextPopover<T>({
  open,
  anchorX,
  anchorY,
  ariaLabel,
  title,
  hint,
  initialText = '',
  placeholder,
  inputAriaLabel,
  parser,
  formatter,
  submitLabel = 'Apply',
  onClear,
  clearLabel = 'Clear',
  estimatedHeight = 200,
  estimatedWidth = 320,
  onClose,
  onSubmit,
}: ParsedTextPopoverProps<T>) {
  const [text, setText] = useState(initialText)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Track the prior `open` value so the seed effect only fires on the
  // false → true transition. Without this, a parent re-render that
  // changes `initialText` while the popover is open (e.g., the user
  // clicked a different pitch chip mid-popover) re-seeds the input
  // mid-edit and discards the user's in-progress typing.
  const wasOpen = useRef(open)

  useEffect(() => {
    if (open && !wasOpen.current) {
      setText(initialText)
      queueMicrotask(() => inputRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, initialText])

  const parsed = useMemo(() => {
    const result = parser(text)
    return result == null ? undefined : result
  }, [parser, text])

  const isPreviewError = parsed === undefined && text.trim() !== ''
  const previewText =
    parsed !== undefined
      ? formatter(parsed)
      : text.trim() === ''
        ? ''
        : 'unrecognized'

  const submit = () => {
    if (parsed !== undefined) {
      onSubmit(parsed)
      onClose()
    }
  }

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={estimatedHeight}
      estimatedWidth={estimatedWidth}
      ariaLabel={ariaLabel}
      onClose={onClose}
      style={{ width: estimatedWidth }}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <span className={styles.hint}>{hint}</span>
      </div>

      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        aria-label={inputAriaLabel}
      />

      <div
        className={`${styles.preview} ${isPreviewError ? styles.previewError : ''}`}
        aria-live="polite"
      >
        {previewText && (isPreviewError ? `Couldn't parse "${text.trim()}"` : `→ ${previewText}`)}
      </div>

      <div className={`${popoverStyles.footer} ${onClear ? popoverStyles.footerSplit : ''}`}>
        {onClear ? (
          <button
            type="button"
            className={popoverStyles.secondary}
            onClick={() => {
              onClear()
              onClose()
            }}
          >
            {clearLabel}
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className={popoverStyles.secondary} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={popoverStyles.primary}
            disabled={parsed === undefined}
            onClick={submit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </Popover>
  )
}
