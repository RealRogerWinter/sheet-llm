'use client'

import { formatDynamic, parseDynamic } from '@/lib/music/dynamics'
import type { DynamicMarking } from '@/lib/music/types'
import ParsedTextPopover from './ParsedTextPopover'

export interface DynamicsPopoverProps {
  open: boolean
  /** Viewport coords for the anchor (typically the selected event). */
  anchorX: number
  anchorY: number
  /**
   * Optional seed text. When the selected event already carries a
   * dynamic, the popover opens pre-filled so the user can refine
   * rather than retype.
   */
  initialText?: string
  onClose: () => void
  /**
   * Called with the parsed marking when the user submits. Caller
   * dispatches setDynamic (simple) vs. setDynamicStructured
   * (compound) based on whether prefix/suffix are set — the
   * routing belongs at the call site since it knows the current
   * selection target.
   */
  onSubmit: (marking: DynamicMarking) => void
}

/**
 * Dorico-style dynamics popover. Free-text input parsed via
 * parseDynamic — single glyphs (`p`, `mf`, `sfz`, `n` for niente)
 * map to a base-only marking; compounds (`sub. p espressivo`,
 * `poco f marcato`) parse into base + prefix + suffix.
 *
 * Thin wrapper around <ParsedTextPopover>: this component just
 * supplies the parser, formatter, and labels.
 */
export default function DynamicsPopover({
  open,
  anchorX,
  anchorY,
  initialText = '',
  onClose,
  onSubmit,
}: DynamicsPopoverProps) {
  return (
    <ParsedTextPopover<DynamicMarking>
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      ariaLabel="Dynamics"
      title="Dynamics"
      hint={
        <>
          Try: <code>p</code>, <code>mf</code>, <code>sub. p</code>, <code>poco f marcato</code>, <code>sfz</code>, <code>n</code> (niente).
        </>
      }
      initialText={initialText}
      placeholder="e.g. sub. p espressivo"
      inputAriaLabel="Dynamic text"
      parser={parseDynamic}
      formatter={formatDynamic}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  )
}
