'use client'

import { formatGraceNotes, parseGraceNotes } from '@/lib/music/graceNotes'
import type { GraceNote } from '@/lib/music/types'
import ParsedTextPopover from './ParsedTextPopover'

export interface GraceNotePopoverProps {
  open: boolean
  /** Viewport coords for the anchor (typically the selected event). */
  anchorX: number
  anchorY: number
  /**
   * Optional seed text. When the selected event already carries
   * structured graceNotes, the popover opens pre-filled with their
   * canonical shorthand so the user can refine rather than retype.
   */
  initialText?: string
  /**
   * Optional clear handler. When set, the popover renders a "Clear"
   * button in the footer that dispatches `setGraceNotes([])`. Pass
   * only when the selected event has existing structured graceNotes
   * — leaving it undefined hides the button.
   */
  onClear?: () => void
  onClose: () => void
  /**
   * Called with the parsed GraceNote[] when the user submits. The
   * caller dispatches setGraceNotes against the current selection.
   */
  onSubmit: (graceNotes: GraceNote[]) => void
}

/**
 * Dorico-style grace-notes popover. Free-text input parsed via
 * `parseGraceNotes`. Recognized shorthand:
 *   - `c`        single eighth grace, default octave 5
 *   - `c5`       explicit octave
 *   - `^c`/`_c`  accidental (sharp / flat / natural with `=c`)
 *   - `c/`       sixteenth
 *   - `c/4`      32nd
 *   - `/c`       slashed acciaccatura (applies to the LEADING grace)
 *   - `c d e`    space-separated beamed run
 *   - `[ace]`    grace chord (one moment, multiple noteheads)
 *
 * Thin wrapper around ParsedTextPopover — this component supplies the
 * parser, formatter, and labels.
 */
export default function GraceNotePopover({
  open,
  anchorX,
  anchorY,
  initialText = '',
  onClear,
  onClose,
  onSubmit,
}: GraceNotePopoverProps) {
  return (
    <ParsedTextPopover<GraceNote[]>
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      ariaLabel="Grace notes"
      title="Grace notes"
      hint={
        <>
          Try: <code>c</code>, <code>/c</code> (acciaccatura), <code>c d e</code> (run),{' '}
          <code>[ace]</code> (chord), <code>^c5/</code> (sharp sixteenth, octave 5).
        </>
      }
      initialText={initialText}
      placeholder="e.g. c, /d, c d e, [ace]"
      inputAriaLabel="Grace notes text"
      parser={parseGraceNotes}
      formatter={formatGraceNotes}
      {...(onClear ? { onClear } : {})}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  )
}
