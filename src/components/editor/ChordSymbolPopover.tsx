'use client'

import { formatChordSymbol, parseChordSymbol } from '@/lib/music/chordSymbols'
import type { ChordSymbol } from '@/lib/music/types'
import ParsedTextPopover from './ParsedTextPopover'

/**
 * Strict-mode wrapper around parseChordSymbol. The bare parser is
 * lenient by design (M10-PR-1's documented contract): it accepts
 * any input with a valid root letter and stores the original raw
 * input in `display` even when trailing characters can't be
 * consumed. That's the right behavior for LLM-emitted text where
 * we'd rather preserve unfamiliar input than reject.
 *
 * For the UI popover, the user typing "Cxyz" probably means "I
 * made a typo" — not "save my typo." Gate Apply by requiring the
 * parse to round-trip exactly via formatChordSymbol: if the
 * canonical formatted form doesn't equal the trimmed input (modulo
 * trivial whitespace normalization), reject.
 */
function strictParseChordSymbol(text: string): ChordSymbol | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const parsed = parseChordSymbol(trimmed)
  if (parsed === null) return undefined
  // Round-trip check. format produces a canonical (possibly
  // capitalization-normalized) string; require equality modulo
  // collapsing internal whitespace runs.
  const formatted = formatChordSymbol(parsed)
  if (collapseWs(formatted) !== collapseWs(trimmed)) return undefined
  return parsed
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ')
}

export interface ChordSymbolPopoverProps {
  open: boolean
  /** Viewport coords for the anchor (typically the selected event). */
  anchorX: number
  anchorY: number
  /**
   * Optional seed text. When the selected event already carries a
   * chord symbol, the popover opens pre-filled with its canonical
   * formatted form so the user can refine rather than retype.
   */
  initialText?: string
  /**
   * Optional clear handler. When set, the popover renders a "Clear"
   * button in the footer that dispatches a removeChordSymbol op.
   * Pass only when the selected event has an existing chord symbol —
   * leaving it undefined hides the button.
   */
  onClear?: () => void
  onClose: () => void
  /**
   * Called with the parsed ChordSymbol when the user submits. The
   * caller dispatches setChordSymbol against the current selection.
   */
  onSubmit: (chord: ChordSymbol) => void
}

/**
 * Dorico-style chord symbols popover. Free-text input parsed via
 * `parseChordSymbol` (M1-PR-6 / M10-PR-1 hardening). Recognized
 * shorthand (~60 patterns covered):
 *   - `C` / `Cm` / `C7` / `Cmaj7` / `Cm7` / `F#m7b5` / `Cdim7`
 *   - `Cadd9` (distinct from `C9`!), `C6`, `Cm6`
 *   - `Cmaj7#11`, `C7(b9,#11)`, `C7alt`
 *   - `C/E` (slash chord), `C|G` (polychord)
 *   - `C Mixolydian` (modal symbol)
 *   - Alt spellings: `Cø7` (half-dim), `C△7` (maj7), `Cmin`, `C-`
 *
 * Thin wrapper around ParsedTextPopover — supplies the parser,
 * formatter, and labels. parseChordSymbol returns `null` on
 * unparseable input (rather than `undefined`) so we adapt to the
 * popover's `T | undefined` parser contract.
 */
export default function ChordSymbolPopover({
  open,
  anchorX,
  anchorY,
  initialText = '',
  onClear,
  onClose,
  onSubmit,
}: ChordSymbolPopoverProps) {
  return (
    <ParsedTextPopover<ChordSymbol>
      open={open}
      anchorX={anchorX}
      anchorY={anchorY}
      ariaLabel="Chord symbol"
      title="Chord symbol"
      hint={
        <>
          Try: <code>C</code>, <code>Cmaj7</code>, <code>F#m7b5</code>, <code>C/E</code>,{' '}
          <code>Cadd9</code> (vs <code>C9</code>), <code>C Mixolydian</code>.
        </>
      }
      initialText={initialText}
      placeholder="e.g. Cmaj7, F#m7b5, C/E"
      inputAriaLabel="Chord symbol text"
      parser={strictParseChordSymbol}
      formatter={formatChordSymbol}
      {...(onClear ? { onClear } : {})}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  )
}
