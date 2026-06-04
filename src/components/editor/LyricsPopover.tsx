'use client'

import { useEffect, useRef, useState } from 'react'
import type { LyricSyllable } from '@/lib/music/types'
import Popover from './Popover'
import popoverStyles from './Popover.module.css'
import styles from './LyricsPopover.module.css'

/**
 * Patch shape emitted from LyricsPopover. The popover never mutates
 * the score directly — the caller re-reads useChatStore.getState() at
 * submit time and dispatches the actual edit op. Mirrors the
 * closure-staleness defense pattern from M3-PR-4 / M5-PR-3 /
 * M13-PR-3.
 *
 * Three intent shapes:
 *   - 'set' — attach or replace a verse's syllable on the target
 *     event. Caller dispatches setLyric { target, verse, syllable,
 *     hyphen?, extender? }.
 *   - 'remove' — drop one verse's syllable. Caller dispatches
 *     removeLyric { target, verse }. Idempotent if absent.
 *   - 'clear' — drop the entire lyrics field. Caller dispatches
 *     clearLyrics { target }.
 */
export type LyricsPopoverPatch =
  | {
      kind: 'set'
      verse: number
      syllable: string
      hyphen: boolean
      extender: boolean
    }
  | { kind: 'remove'; verse: number }
  | { kind: 'clear' }

export interface LyricsPopoverProps {
  open: boolean
  anchorX: number
  anchorY: number
  /**
   * The current event's existing lyrics. Rendered as per-verse rows
   * with edit controls. Caller passes the live value; popover only
   * mutates via onPatch.
   */
  existingLyrics: ReadonlyArray<LyricSyllable>
  /**
   * Whether the selected event is a rest. When true, all controls
   * are disabled — abcjs's w: parser skips rest events so a
   * syllable attached to a rest will not render (M15-PR-2). The
   * canonical workaround is to extend the previous note's duration
   * to swallow the rest. Allowing the data round-trip but
   * suppressing UI entry sidesteps the silent-data-loss surface.
   */
  isRest: boolean
  onClose: () => void
  onPatch: (patch: LyricsPopoverPatch) => void
}

export default function LyricsPopover({
  open,
  anchorX,
  anchorY,
  existingLyrics,
  isRest,
  onClose,
  onPatch,
}: LyricsPopoverProps) {
  // New-verse entry state. The popover always has a "+add verse"
  // row at the bottom so multi-verse hymns can be entered in one
  // sitting. Defaults to verse N+1 where N is the highest existing
  // verse — keeps the user moving forward without typing the same
  // number twice.
  const nextVerseDefault = existingLyrics.length === 0
    ? 1
    : Math.min(50, Math.max(...existingLyrics.map((s) => s.verse)) + 1)
  const [newVerse, setNewVerse] = useState<string>(String(nextVerseDefault))
  const [newSyllable, setNewSyllable] = useState<string>('')
  const [newHyphen, setNewHyphen] = useState<boolean>(false)
  const [newExtender, setNewExtender] = useState<boolean>(false)
  const firstControlRef = useRef<HTMLInputElement | null>(null)

  // Re-seed on closed→open transition (wasOpen pattern). Resets the
  // new-verse form to the next-available verse + clears syllable
  // text. Existing-verse rows are always re-read from props.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setNewVerse(String(nextVerseDefault))
      setNewSyllable('')
      setNewHyphen(false)
      setNewExtender(false)
      queueMicrotask(() => firstControlRef.current?.focus())
    }
    wasOpen.current = open
  }, [open, nextVerseDefault])

  const parsedNewVerse = Number(newVerse.trim())
  const newVerseValid =
    Number.isInteger(parsedNewVerse) && parsedNewVerse >= 1 && parsedNewVerse <= 50
  const trimmedNewSyl = newSyllable.trim()
  const newSyllableValid = trimmedNewSyl.length >= 1 && trimmedNewSyl.length <= 40
  // hyphen + extender are mutually exclusive per the M15-PR-1 op
  // layer guard. Surfacing the rejection in the popover (aria-
  // invalid + disabled Apply) is friendlier than letting the
  // editOperations dispatch throw EditError mid-render.
  const exclusivityValid = !(newHyphen && newExtender)
  const canSubmitNew =
    !isRest && newVerseValid && newSyllableValid && exclusivityValid

  function submitNew() {
    if (!canSubmitNew) return
    onPatch({
      kind: 'set',
      verse: parsedNewVerse,
      syllable: trimmedNewSyl,
      hyphen: newHyphen,
      extender: newExtender,
    })
    // Sticky verse: bump to next; clear syllable so the user can
    // type the next word's syllable immediately without resetting.
    const next = Math.min(50, parsedNewVerse + 1)
    setNewVerse(String(next))
    setNewSyllable('')
    setNewHyphen(false)
    setNewExtender(false)
  }

  const sortedExisting = [...existingLyrics].sort((a, b) => a.verse - b.verse)

  return (
    <Popover
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      estimatedHeight={existingLyrics.length > 0 ? 360 + 36 * existingLyrics.length : 320}
      estimatedWidth={440}
      ariaLabel="Lyrics"
      onClose={onClose}
      className={styles.popover}
    >
      <div className={popoverStyles.header}>
        Lyrics{isRest && ' — rest event (lyrics will not render)'}
      </div>

      {isRest && (
        <div className={popoverStyles.section}>
          <div className={styles.restWarning}>
            abcjs&apos;s lyric parser skips rest events; the syllable would round-trip
            through save/load but not render. To attach lyrics to a held position,
            extend the previous note&apos;s duration to swallow the rest.
          </div>
        </div>
      )}

      {sortedExisting.length > 0 && (
        <div className={popoverStyles.section}>
          <div className={popoverStyles.sectionLabel}>Existing verses on this event</div>
          <ul className={styles.existingList} role="list" aria-label="Existing lyric verses">
            {sortedExisting.map((s) => (
              <li key={s.verse} className={styles.existingRow}>
                <span className={styles.versePrefix}>v{s.verse}</span>
                <span className={styles.existingSyllable} title={s.syllable}>
                  {s.syllable}
                  {s.hyphen && <span className={styles.flagTag}> -</span>}
                  {s.extender && <span className={styles.flagTag}> _</span>}
                </span>
                <button
                  type="button"
                  className={styles.removeButton}
                  title={`Remove verse ${s.verse} on this event`}
                  aria-label={`Remove verse ${s.verse}`}
                  onClick={() => onPatch({ kind: 'remove', verse: s.verse })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={styles.clearAllButton}
            title="Drop all syllables on this event"
            aria-label="Clear all lyrics on this event"
            onClick={() => onPatch({ kind: 'clear' })}
          >
            Clear all
          </button>
        </div>
      )}

      <div className={popoverStyles.section}>
        <div className={popoverStyles.sectionLabel}>Add or replace a verse</div>
        <div className={styles.fields}>
          <label className={styles.fieldVerse}>
            <span className={styles.fieldLabel}>Verse</span>
            <input
              type="text"
              inputMode="numeric"
              className={styles.input}
              value={newVerse}
              aria-label="Verse number"
              aria-invalid={!newVerseValid}
              disabled={isRest}
              onChange={(e) => setNewVerse(e.target.value)}
            />
          </label>
          <label className={styles.fieldSyllable}>
            <span className={styles.fieldLabel}>Syllable</span>
            <input
              ref={firstControlRef}
              type="text"
              className={styles.input}
              value={newSyllable}
              aria-label="Syllable text"
              aria-invalid={newSyllable.length > 0 && !newSyllableValid}
              maxLength={40}
              placeholder='e.g. "A", "ma", "zing"'
              disabled={isRest}
              onChange={(e) => setNewSyllable(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmitNew) {
                  e.preventDefault()
                  submitNew()
                }
              }}
            />
          </label>
        </div>
        <div className={styles.flagRow}>
          <label className={styles.flagCell}>
            <input
              type="checkbox"
              checked={newHyphen}
              aria-label="Hyphen — continues to next syllable of the same word"
              disabled={isRest}
              onChange={(e) => {
                setNewHyphen(e.target.checked)
                // Mutual exclusion at the form layer — toggling
                // hyphen on auto-clears extender (and vice versa).
                if (e.target.checked) setNewExtender(false)
              }}
            />
            <span>hyphen (Glo-)</span>
          </label>
          <label className={styles.flagCell}>
            <input
              type="checkbox"
              checked={newExtender}
              aria-label="Extender — melisma across following notes"
              disabled={isRest}
              onChange={(e) => {
                setNewExtender(e.target.checked)
                if (e.target.checked) setNewHyphen(false)
              }}
            />
            <span>extender (A_)</span>
          </label>
        </div>
      </div>

      <div className={`${popoverStyles.footer} ${popoverStyles.footerSplit}`}>
        <button type="button" className={popoverStyles.secondary} onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className={popoverStyles.primary}
          disabled={!canSubmitNew}
          onClick={submitNew}
        >
          Apply
        </button>
      </div>
    </Popover>
  )
}
