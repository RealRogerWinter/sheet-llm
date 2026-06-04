'use client'

import { formatFingering, parseFingering } from '@/lib/music/fingerings'
import type { Fingering } from '@/lib/music/types'
import ParsedTextPopover from './ParsedTextPopover'

export interface FingeringPopoverProps {
  open: boolean
  /** Viewport coords for the anchor (typically the selected pitch chip). */
  anchorX: number
  anchorY: number
  /**
   * Optional seed text. When the selected pitch already carries a
   * fingering, the popover opens pre-filled with its canonical
   * shorthand so the user can refine rather than retype.
   */
  initialText?: string
  /**
   * Optional clear handler. When set, the popover renders a "Clear"
   * button in the footer that dispatches a remove op. Pass only when
   * the selected pitch has an existing fingering — leaving it
   * undefined hides the button.
   */
  onClear?: () => void
  onClose: () => void
  /**
   * Called with the parsed fingering when the user submits. The caller
   * dispatches setFingering against the current selection — the
   * popover stays decoupled from the chat-store selection.
   */
  onSubmit: (fingering: Fingering) => void
}

/**
 * Dorico-style fingerings popover. Free-text input parsed via
 * `parseFingering`. Recognized shorthand:
 *   - `0..5`                  piano (default for ambiguous digits)
 *   - `N-M` / `N>M`           piano with substitution ("3-2", "1>2")
 *   - `p` `i` `m` `a` `c`     guitar-rh Spanish letters
 *   - `N.RR`                  string finger N + Roman string (I..IV)
 *   - `Nh` / `Nt`             organ + heel / toe
 *   - `N(` / `N)`             organ + thumb-direction glyph
 *   - `system:rest`           explicit prefix (`lh:1(6)/V`, `string:3`, etc.)
 *
 * Thin wrapper around ParsedTextPopover — this component supplies the
 * parser, formatter, and labels.
 */
export default function FingeringPopover({
  open,
  anchorX,
  anchorY,
  initialText = '',
  onClear,
  onClose,
  onSubmit,
}: FingeringPopoverProps) {
  return (
    <ParsedTextPopover<Fingering>
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      ariaLabel="Fingering"
      title="Fingering"
      hint={
        <>
          Try: <code>1</code>, <code>1-2</code> (piano), <code>1.IV</code> (string), <code>p</code> (guitar rh),{' '}
          <code>1h</code> (organ heel), <code>lh:1(6)/V</code> (guitar lh).
        </>
      }
      initialText={initialText}
      placeholder="e.g. 3, 1.IV, p, lh:1/V"
      inputAriaLabel="Fingering text"
      parser={parseFingering}
      formatter={formatFingering}
      {...(onClear ? { onClear } : {})}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  )
}
